'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const BigNumber = require('bignumber.js')
const uuid = require('uuid/v4')
const IlpPacket = require('ilp-packet')
const debug = require('debug')('ilp-plugin-bells:plugin')
const errors = require('../errors')
const ExternalError = require('../errors/external-error')
const UnreachableError = require('../errors/unreachable-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isNil = require('lodash/fp/isNil')
const omitNil = require('lodash/fp/omitBy')(isNil)
const translate = require('./translate')
const LedgerContext = require('./ledger-context')
const util = require('util')

const accountBackoffMin = 1000
const accountBackoffMax = 30000
const defaultConnectTimeout = 60000
const wsReconnectDelayMin = 10
const wsReconnectDelayMax = 500
const defaultMessageTimeout = 5000
const defaultAuthTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // one week

class FiveBellsLedger extends EventEmitter2 {
  constructor (options) {
    super()

    if (typeof options !== 'object') {
      throw new TypeError('Expected an options object, received: ' + typeof options)
    }

    if (options.prefix) {
      if (typeof options.prefix !== 'string') {
        throw new TypeError('Expected options.prefix to be a string, received: ' + typeof options.prefix)
      }
      if (options.prefix.slice(-1) !== '.') {
        throw new Error('Expected options.prefix to end with "."')
      }
    }

    this.configPrefix = options.prefix

    this.account = options.account
    this.username = options.username

    // optional: use account@ledger.example in order to authenticate
    // instead of using account URI + username
    this.identifier = options.identifier

    if (options.identifier && options.credentials) {
      throw new Error('Identifier will overwrite custom credentials')
    }

    this.credentials = options.credentials || {
      account: options.account,
      username: options.username,
      password: options.password,
      cert: options.cert,
      key: options.key,
      ca: options.ca
    }
    this.supportedAuth = options.supportedAuth || null
    this.authToken = null
    this.authTokenDate = null
    this.authTokenMaxAge = defaultAuthTokenMaxAge
    this.connector = options.connector || null

    this.debugReplyNotifications = options.debugReplyNotifications || false
    this.rpcId = 1

    this.connection = null
    this.connecting = false
    // `ready` is set when the metadata is retieved on the first connect() call.
    this.ready = false
    // `connected` is set while a websocket connection is active.
    this.connected = false
    this.ws = null
    this.pendingRequests = {} // { messageId ⇒ TODO
    this.requestHandler = null
    this.on('incoming_message', (message, messageId) =>
      co.wrap(this._handleIncomingMessage).call(this, message, messageId))
    this.on('_rpc:notification', (notif) =>
      co.wrap(this._handleNotification).call(this, notif))
  }

  connect (options) {
    const timeout = (options && options.timeout) || defaultConnectTimeout
    if (typeof timeout !== 'number') {
      throw new TypeError('Expected options.timeout to be a number, received: ' + typeof timeout)
    }
    return co(this._connect.bind(this), {timeout})
      .then(() => {
        this.connecting = false
        this.emit('_connect:done')
      })
      .catch((err) => {
        this.connecting = false
        this.emit('_connect:done', err)
        throw err
      })
  }

  // Connect to the websocket and then subscribe to account notifications
  * _connect (options) {
    if (this.ready) {
      debug('already connected, ignoring connection request')
      return Promise.resolve(null)
    }
    if (this.connecting) {
      const expiresAt = Date.now() + options.timeout
      return new Promise((resolve, reject) => {
        this.once('_connect:done', (err) => {
          if (!err) return resolve()
          // The second connect() call has already expired.
          if (expiresAt < Date.now()) return reject(err)
          this.connect({timeout: expiresAt - Date.now()}).then(resolve).catch(reject)
        })
      })
    }
    this.connecting = true

    if (this.identifier) {
      const newOptions = yield resolveWebfingerOptions(this.identifier)

      this.credentials = Object.assign(
        {},
        newOptions.credentials,
        { password: this.credentials.password }
      )
      this.account = newOptions.account
    }

    const accountUri = this.account
    const accountProtocol = parseURL(accountUri).protocol
    if (accountProtocol !== 'http:' && accountProtocol !== 'https:') {
      throw new Error('Invalid account URI')
    }

    // Resolve account information
    const res = yield this._requestRetry({
      method: 'GET',
      uri: accountUri,
      json: true
    }, {
      errorMessage: 'Unable to connect to account',
      timeout: options.timeout,
      backoffMin: accountBackoffMin,
      backoffMax: accountBackoffMax,
      // keep trying even if the account doesn't exist initially
      // this is mainly for the cases in which a connector starts
      // after the ledger (such that it will initially get a 404
      // error trying to connect to its account)
      // P.S. by setting the timeout to Infinity you're already
      // asking it to do something kind of crazy.
      forceRetry: options.timeout === Infinity
    })

    if (!res.body || !res.body.ledger) {
      throw new Error('Failed to fetch account details from "' +
        accountUri +
        '". Got: "' +
        JSON.stringify(res.body) +
        '"')
    }
    const host = res.body.ledger
    // Set the username but don't overwrite the username in case it was provided
    if (!this.credentials.username || !this.username) {
      this.username = this.credentials.username = res.body.name
    }

    // Resolve ledger metadata
    const ledgerMetadata = yield this._fetchLedgerMetadata(host)
    this.ledgerContext = new LedgerContext(host, ledgerMetadata)

    // Set ILP prefix
    const ledgerPrefix = this.ledgerContext.prefix
    if (this.configPrefix) {
      this.ledgerContext.prefix = this.configPrefix
    }
    if (ledgerPrefix && this.configPrefix && ledgerPrefix !== this.configPrefix) {
      console.warn('ilp-plugin-bells: ledger prefix (' + ledgerPrefix +
        ') does not match locally configured prefix (' + this.configPrefix + ')')
    }
    if (!this.ledgerContext.prefix) {
      throw new Error('Unable to set prefix from ledger or from local config')
    }

    // figure out which auth mechanism the ledger supports
    if (!this.supportedAuth) {
      this.supportedAuth = yield this._getAuthMechanisms()
    }

    this.ready = true

    const notificationsUrl = this.ledgerContext.urls.websocket + '?token=' +
                                encodeURIComponent(yield this._getAuthToken())
    yield this._connectToWebsocket({
      timeout: options.timeout,
      uri: notificationsUrl
    })
  }

  _connectToWebsocket (options) {
    const wsUri = options.uri
    const timeout = options.timeout
    const reconnectOptions = {
      immediate: true,
      // reconnect ASAP and don't stop trying...ever
      initialDelay: wsReconnectDelayMin,
      maxDelay: wsReconnectDelayMax,
      failAfter: Infinity
    }

    const reconnect = reconnectCore(() => {
      return new WebSocket(wsUri)
    })

    // reject if the timeout occurs before the websocket is successfully established
    return Promise.race([
      wait(timeout).then(() => {
        throw new Error('websocket connection to ' +
          wsUri +
            ' timed out before "connect" RPC message was received (' +
            timeout +
            ' ms)')
      }),
      // open a websocket connection to the websockets notification URL,
      // and wait for a "connect" RPC message on it.
      new Promise((resolve, reject) => {
        this.connection = reconnect(reconnectOptions, (ws) => {
          ws.on('open', () => {
            debug('ws opened: ' + wsUri)
          })
          ws.on('message', (rpcMessageString) => {
            let rpcMessage
            try {
              rpcMessage = JSON.parse(rpcMessageString)
            } catch (err) {
              debug('invalid notification', rpcMessageString)
              return
            }

            if (rpcMessage.method === 'connect') {
              if (this.connected) {
                return resolve(null)
              } else {
                return this._subscribeAccounts([this.account])
                  .catch((err) => {
                    debug('error (re)subscribing to account ' + this.account, err)
                    return reject(err)
                  })
                  .then(() => {
                    debug('plugin connected to: ' + wsUri)
                    this.emit('connect')
                    this.connected = true
                    return resolve(null)
                  })
              }
            }
            co.wrap(this._handleIncomingRpcMessage)
              .call(this, rpcMessage)
              .then(() => {
                if (this.debugReplyNotifications) {
                  ws.send(JSON.stringify({ result: 'processed' }))
                }
              })
              .catch((err) => {
                debug('failure while processing notification: ' +
                  (err && err.stack) ? err.stack : err)
                if (this.debugReplyNotifications) {
                  ws.send(JSON.stringify({
                    result: 'ignored',
                    ignoreReason: {
                      id: err.name,
                      message: err.message
                    }
                  }))
                }
              })
          })
          ws.on('error', (err) => {
            debug('ws connection error on ' + wsUri, err)
            reject(new UnreachableError('websocket connection error'))
          })
          ws.on('close', (code, reason) => {
            this.connected = false
            debug('ws disconnected from ' + wsUri + ' code: ' + code + ' reason: ' + reason)
            if (this.ready) {
              reject(new UnreachableError('websocket connection error'))
            }
          })

          // reconnect-core expects the disconnect method to be called: `end`
          ws.end = ws.close
        })
        this.connection
          .on('connect', (ws) => {
            this.ws = ws
          })
          .on('disconnect', () => {
            debug('plugin disconnected from: ' + wsUri)
            this.connected = false
            // remove listeners so we don't have duplicate event handlers when the ws reconnects
            this.ws.removeAllListeners()
            this.ws = null
            this.emit('disconnect')
          })
          .on('reconnect', (n, delay) => {
            if (n > 0) {
              debug('ws reconnect to ' + wsUri + ' in ' + delay + 'ms (attempt ' + n + ')')
            }
          })
          .on('error', (err) => {
            debug('ws error on ' + wsUri + ':', err)
            reject(err)
          })
          .connect()
      })
    ])
  }

  disconnect () {
    if (!this.connection) return Promise.resolve(null)
    const disconnected = new Promise((resolve) => {
      this.once('disconnect', resolve)
    })

    this.connection.disconnect()
    this.connection = null
    return disconnected
  }

  isConnected () {
    return this.connected
  }

  getInfo () {
    if (!this.ready) {
      throw new Error('Must be connected before getInfo can be called')
    }
    return this.ledgerContext.getInfo()
  }

  * _fetchLedgerMetadata (host) {
    debug('request ledger metadata %s', host)
    function throwErr () {
      throw new ExternalError('Unable to determine ledger metadata')
    }

    let res
    try {
      res = yield request(host, {json: true})
    } catch (e) {
      if (!res || res.statusCode !== 200) {
        debug('_fetchLedgerMetadata error %s', e)
        throwErr()
      }
    }

    if (!res || res.statusCode !== 200) { throwErr() }

    // note that the fivebells ledger API uses 'scale' instead of 'currency_scale'.
    // fields like 'ilp_prefix' and 'currency_code' are not mandatory
    if (!res.body.connectors || !res.body.scale) { throwErr() }

    return res.body
  }

  getAccount () {
    if (!this.ready) {
      throw new Error('Must be connected before getAccount can be called')
    }
    return this.ledgerContext.prefix + this.ledgerContext.accountUriToName(this.account)
  }

  getBalance () {
    return co.wrap(this._getBalance).call(this)
  }

  * _getBalance () {
    if (!this.ready) {
      throw new Error('Must be connected before getBalance can be called')
    }
    const creds = this.credentials
    let res
    try {
      res = yield this._requestWithCredentials({
        method: 'get',
        uri: creds.account,
        json: true
      })
    } catch (e) {
      debug(`Error getting the balance for account ${creds.account}: `, e)
    }
    if (!res || res.statusCode !== 200) {
      throw new ExternalError('Unable to determine current balance')
    }
    const ledgerBalance = new BigNumber(res.body.balance)
    const integerBalance = ledgerBalance.shift(this.ledgerContext.getInfo().currencyScale)
    return integerBalance.toString()
  }

  /**
   * @param {Function} requestHandler
   */
  registerRequestHandler (requestHandler) {
    if (this.requestHandler) {
      throw new errors.RequestHandlerAlreadyRegisteredError('Cannot overwrite requestHandler')
    }
    this.requestHandler = requestHandler
  }

  deregisterRequestHandler () {
    this.requestHandler = null
  }

  * _handleIncomingMessage (message, messageId) {
    const pendingRequest = this.pendingRequests[messageId]
    // `message` is a ResponseMessage
    if (pendingRequest) {
      delete this.pendingRequests[messageId]
      yield this.emitAsync('incoming_response', message)
      pendingRequest.resolve(message)
      return
    }
    // `message` is a RequestMessage
    yield this.emitAsync('incoming_request', message)
    if (!this.requestHandler) return
    const responseMessage = yield this.requestHandler(message).then((responseMessage) => {
      if (!responseMessage) {
        throw new Error('No matching handler for request')
      }
      return responseMessage
    }).catch((err) => {
      return {
        ledger: message.ledger,
        from: message.to,
        to: message.from,
        ilp: IlpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: this.getAccount(),
          forwardedBy: [],
          triggeredAt: new Date(),
          data: JSON.stringify({message: err.message})
        }).toString('base64')
      }
    })
    yield this.emitAsync('outgoing_response', responseMessage)
    return yield this._sendMessage(Object.assign({id: messageId}, responseMessage))
  }

  /**
   * @param {RequestMessage} message
   * @param {IlpAddress} message.to
   * @param {IlpAddress} message.ledger
   * @param {String} [message.ilp]
   * @param {Object} [message.custom]
   * @param {Integer} [message.timeout] milliseconds
   * @param {Uuid} [message.id]
   * @returns {Promise.<ResponseMessage>}
   */
  sendRequest (message) {
    return co.wrap(this._sendRequest).call(this, message)
  }

  * _sendRequest (message) {
    const requestId = message.id || uuid()
    const responded = new Promise((resolve, reject) => {
      this.pendingRequests[requestId] = {resolve, reject}
      this._sendMessage(Object.assign({id: requestId}, message)).catch((err) => {
        delete this.pendingRequests[requestId]
        reject(err)
      })
    })

    yield this.emitAsync('outgoing_request', message)
    return yield Promise.race([
      responded,
      wait(message.timeout || defaultMessageTimeout)
        .then(() => {
          delete this.pendingRequests[requestId]
          throw new Error('sendRequest timed out')
        })
    ])
  }

  _sendMessage (paramMessage) {
    // clone the incoming object in case we want to correct its fields
    const message = Object.assign({}, paramMessage)
    debug('sending message: ' + JSON.stringify(message))
    if (!this.ready) {
      throw new Error('Must be connected before sendRequest can be called')
    }
    if (message.ledger !== this.ledgerContext.prefix) {
      throw new errors.InvalidFieldsError('invalid ledger')
    }
    if (typeof message.to !== 'string') {
      throw new errors.InvalidFieldsError('invalid to field')
    }
    if (typeof message.id !== 'string') {
      throw new errors.InvalidFieldsError('invalid id field')
    }
    if (message.ilp !== undefined && typeof message.ilp !== 'string') {
      throw new errors.InvalidFieldsError('invalid ilp field')
    }
    if (message.custom !== undefined && typeof message.custom !== 'object') {
      throw new errors.InvalidFieldsError('invalid custom field')
    }

    const destinationAddress = this.ledgerContext.parseAddress(message.to)
    const fiveBellsMessage = {
      id: message.id,
      ledger: this.ledgerContext.host,
      from: this.ledgerContext.urls.account.replace(':name', encodeURIComponent(this.username)),
      to: this.ledgerContext.urls.account.replace(':name', encodeURIComponent(destinationAddress.username)),
      ilp: message.ilp,
      custom: message.custom
    }
    debug('converted to ledger message: ' + JSON.stringify(fiveBellsMessage))

    return co(function * () {
      const sendRes = yield this._requestWithCredentials({
        method: 'post',
        uri: this.ledgerContext.urls.message,
        body: fiveBellsMessage,
        json: true
      })
      const body = sendRes.body
      if (sendRes.statusCode < 400) return
      debug('error submitting message:', sendRes.statusCode, JSON.stringify(sendRes.body))
      if (body.id === 'InvalidBodyError') {
        throw new errors.InvalidFieldsError(body.message)
      } else if (body.id === 'NoSubscriptionsError') {
        throw new errors.NoSubscriptionsError(body.message)
      } else {
        throw new errors.NotAcceptedError(body.message)
      }
    }.bind(this))
  }

  sendTransfer (transfer) {
    return co.wrap(this._sendTransfer).call(this, transfer)
  }

  * _sendTransfer (paramTransfer) {
    // clone the incoming object in case we want to correct its fields
    const transfer = Object.assign({}, paramTransfer)
    if (!this.ready) {
      throw new Error('Must be connected before sendTransfer can be called')
    }
    if (typeof transfer.to !== 'string') {
      // check for deprecated Transfer format, from before https://github.com/interledger/rfcs/commit/61958f54c268e5a52e1b85f090df02646b0dda38
      if (typeof transfer.account === 'string') {
        util.deprecate(() => {}, 'switch from using "account" to "to"')()
        transfer.to = transfer.account
        delete transfer.account
      } else {
        throw new errors.InvalidFieldsError('invalid to field')
      }
    }
    if (typeof transfer.amount !== 'string' ||
     +transfer.amount <= 0 ||
     transfer.amount.indexOf('.') !== -1) { // integers only
      throw new errors.InvalidFieldsError('invalid amount')
    }

    const fiveBellsTransfer = translate.translatePluginApiToBells(
      transfer,
      this.account,
      this.ledgerContext
    )

    // If Atomic mode, add destination transfer to notification targets
    if (transfer.cases) {
      for (let caseUri of transfer.cases) {
        debug('add case notification for ' + caseUri)
        const res = yield request({
          method: 'POST',
          uri: caseUri + '/targets',
          body: [ this.ledgerContext.urls.transfer_fulfillment.replace(':id', transfer.id) ],
          json: true
        })

        if (res.statusCode !== 200) {
          throw new Error('Unexpected status code: ' + res.statusCode)
        }
      }
    }

    debug('submitting transfer: ', JSON.stringify(fiveBellsTransfer))

    const sendRes = yield this._requestWithCredentials({
      method: 'put',
      uri: fiveBellsTransfer.id,
      body: fiveBellsTransfer,
      json: true
    })
    const body = sendRes.body
    if (sendRes.statusCode >= 400) {
      debug('error submitting transfer:', sendRes.statusCode, JSON.stringify(body))
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      if (body.id === 'InvalidModificationError') throw new errors.DuplicateIdError(body.message)
      throw new errors.NotAcceptedError(body.message)
    }

    // TODO: If already executed, fetch fulfillment and forward to source

    return null
  }

  fulfillCondition (transferId, conditionFulfillment) {
    return co.wrap(this._fulfillCondition).call(this, transferId, conditionFulfillment)
  }

  * _fulfillCondition (transferId, conditionFulfillment) {
    if (!this.ready) {
      throw new Error('Must be connected before fulfillCondition can be called')
    }
    const fulfillmentRes = yield this._requestWithCredentials({
      method: 'put',
      uri: this.ledgerContext.urls.transfer_fulfillment.replace(':id', transferId),
      body: translate.translateToCryptoFulfillment(conditionFulfillment),
      headers: {
        'content-type': 'text/plain'
      }
    })
    const body = getResponseJSON(fulfillmentRes)

    if (fulfillmentRes.statusCode >= 400 && body) {
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      if (body.id === 'UnmetConditionError') throw new errors.NotAcceptedError(body.message)
      if (body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(body.message)
      if (body.id === 'NotFoundError') throw new errors.TransferNotFoundError(body.message)
      if (body.id === 'InvalidModificationError' &&
       body.message === 'Transfers in state rejected may not be executed') {
        throw new errors.AlreadyRolledBackError(body.message)
      }
    }

    // TODO check the timestamp the ledger sends back
    // See https://github.com/interledgerjs/five-bells-ledger/issues/149
    if (fulfillmentRes.statusCode === 200 || fulfillmentRes.statusCode === 201) {
      return null
    } else {
      throw new ExternalError('Failed to submit fulfillment for transfer: ' +
        transferId + ' Error: ' +
        (fulfillmentRes.body ? JSON.stringify(fulfillmentRes.body) : fulfillmentRes.error))
    }
  }

  /**
   * @param {String} transferId
   * @returns {Promise<String>}
   */
  getFulfillment (transferId) {
    return co.wrap(this._getFulfillment).call(this, transferId)
  }

  * _getFulfillment (transferId) {
    if (!this.ready) {
      throw new Error('Must be connected before getFulfillment can be called')
    }
    const fulfillmentUri = this.ledgerContext.urls.transfer_fulfillment.replace(':id', transferId)
    debug('get fulfillment: ' + fulfillmentUri)
    let res
    try {
      res = yield this._requestWithCredentials({
        method: 'get',
        uri: fulfillmentUri,
        json: true,
        headers: {
          'Accept': '*/*'
        }
      })
    } catch (err) {
      throw new ExternalError('Remote error: message=' + err.message)
    }

    if (res.statusCode === 200) return translate.translateFromCryptoFulfillment(res.body)
    debug('error getting fulfillment: ' + res.statusCode + ' ' + JSON.stringify(res.body))
    if (res.statusCode >= 400 && res.body) {
      if (res.body.id === 'MissingFulfillmentError') throw new errors.MissingFulfillmentError(res.body.message)
      if (res.body.id === 'NotFoundError') throw new errors.MissingFulfillmentError(res.body.message)
      if (res.body.id === 'TransferNotFoundError') throw new errors.TransferNotFoundError(res.body.message)
      if (res.body.id === 'AlreadyRolledBackError') throw new errors.AlreadyRolledBackError(res.body.message)
      if (res.body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(res.body.message)
    }
    throw new ExternalError('Remote error: status=' + (res && res.statusCode))
  }

  /**
   * @param {String} transferId
   * @param {RejectionMessage} rejectionMessage
   * @returns {Promise<null>}
   */
  rejectIncomingTransfer (transferId, rejectionMessage) {
    return co.wrap(this._rejectIncomingTransfer).call(this, transferId, rejectionMessage)
  }

  * _rejectIncomingTransfer (transferId, rejectionMessage) {
    if (!this.ready) {
      throw new Error('Must be connected before rejectIncomingTransfer can be called')
    }
    const rejectionRes = yield this._requestWithCredentials({
      method: 'put',
      uri: this.ledgerContext.urls.transfer_rejection.replace(':id', transferId),
      body: rejectionMessage,
      json: true
    })
    const body = rejectionRes.body

    if (rejectionRes.statusCode >= 400) {
      if (body && body.id === 'UnauthorizedError') throw new errors.NotAcceptedError(body.message)
      if (body && body.id === 'NotFoundError') throw new errors.TransferNotFoundError(body.message)
      if (body && body.id === 'InvalidModificationError') throw new errors.AlreadyFulfilledError(body.message)
      if (body && body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(body.message)
      throw new ExternalError('Remote error: status=' + rejectionRes.statusCode)
    }
    return null
  }

  _sendRpcRequest (method, params) {
    const requestId = this.rpcId++
    return new Promise((resolve, reject) => {
      const listener = (rpcResponse) => {
        if (rpcResponse.id !== requestId) return
        // Wait till nextTick to remove the listener so that it doesn't happen while the
        // event is part way through being emitted, which causes issues iterating the listeners.
        process.nextTick(() => this.removeListener('_rpc:response', listener))
        if (rpcResponse.error) {
          return reject(new ExternalError(rpcResponse.error.message))
        }
        debug('got RPC response', rpcMessage)
        resolve(rpcResponse)
      }
      this.on('_rpc:response', listener)
      const rpcMessage = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })
      debug('sending RPC message', rpcMessage)
      this.ws.send(rpcMessage, (err) => {
        if (err) {
          debug('error sending RPC message', err)
          reject(err)
        }
      })
    })
  }

  _subscribeAccounts (accounts) {
    return this._sendRpcRequest('subscribe_account', {
      eventType: '*',
      accounts: accounts
    })
  }

  _subscribeAllAccounts () {
    return this._sendRpcRequest('subscribe_all_accounts', {
      eventType: '*'
    })
  }

  * _handleIncomingRpcMessage (rpcMessage) {
    // RpcResponse
    if (!rpcMessage.method) {
      return yield this.emitAsync('_rpc:response', rpcMessage)
    }
    const params = rpcMessage.params
    // RpcRequest
    if (rpcMessage.method === 'notify') {
      yield this.emitAsync('_rpc:notification', params)
    } else {
      debug('unexpected rpc method: ' + rpcMessage.method)
    }
  }

  * _handleNotification (notification) {
    const eventParams = translate.translateBellsToPluginApi(
      notification,
      this.account,
      this.ledgerContext
    )
    yield this.emitAsync.apply(this, eventParams)
  }

  * _getAuthToken () {
    // Check for a valid auth token before requesting one.
    const authTokenAge = Date.now() - this.authTokenDate
    if (this.authToken && authTokenAge < this.authTokenMaxAge) {
      return this.authToken
    }
    const authTokenRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'get',
        uri: this.ledgerContext.urls.auth_token
      }))
    const body = getResponseJSON(authTokenRes)
    this.authToken = body && body.token
    if (!this.authToken) throw new Error('Unable to get auth token from ledger')
    this.authTokenDate = Date.now()
    this.authTokenMaxAge = (body && body.token_max_age) || this.authTokenMaxAge
    return this.authToken
  }

  _requestRetry (requestOptions, retryOptions) {
    return requestRetry(Object.assign({
      credentials: this.credentials
    }, requestOptions), retryOptions)
  }

  * _requestWithCredentials (options) {
    let requestCreds = null
    if (this.supportedAuth === 'token') {
      requestCreds = requestCredentials(this.credentials, yield this._getAuthToken())
    } else if ((this.supportedAuth === 'basic')) {
      requestCreds = requestCredentials(this.credentials)
    }

    return yield request(Object.assign(requestCreds, options))
  }

  * _getAuthMechanisms () {
    let tryAuth = function * (options) {
      let resp = yield request.get(this.ledgerContext.urls.transfer.replace(':id', 1), options)
      return +resp.statusCode
    }.bind(this)

    if ((yield tryAuth({auth: {bearer: 'invalidToken'}})) === 403) {
      debug('Using Token Authentication')
      return 'token'
    } else {
      return 'basic'
    }
  }
}

function requestCredentials (credentials, token) {
  return omitNil({
    // Prefer bearer token for auth. If no token is provided, use user/pass.
    auth: token ? {
      bearer: token
    } : credentials.username && credentials.password && {
      user: credentials.username,
      pass: credentials.password
    },
    cert: credentials.cert,
    key: credentials.key,
    ca: credentials.ca
  })
}

function getResponseJSON (res) {
  const contentType = res.headers['content-type']
  if (!contentType) return
  if (contentType.indexOf('application/json') !== 0) return
  return JSON.parse(res.body)
}

function wait (ms) {
  if (ms === Infinity) {
    return new Promise((resolve) => {})
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function * resolveWebfingerOptions (identifier) {
  const host = identifier.split('@')[1]
  const resource = 'acct:' + identifier

  const res = yield request({
    uri: 'https://' + host + '/.well-known/webfinger?resource=' + resource,
    json: true
  })

  if (res.body.subject !== resource) {
    throw new Error('subject (' + res.body.subject + ') doesn\'t match resource (' + resource + ')')
  } else if (!res.body.links || typeof res.body.links !== 'object') {
    throw new Error('result body doesn\'t contain links (' + resource + ')')
  }

  const newOptions = { credentials: {} }

  for (let link of res.body.links) {
    if (link.rel === 'https://interledger.org/rel/ledgerAccount') {
      newOptions.credentials.account = newOptions.account = link.href
    } else if (link.rel === 'https://interledger.org/rel/ilpAddress') {
      newOptions.credentials.username = link.href.split('.').pop()
    }
  }

  if (!newOptions.account || !newOptions.credentials.username) {
    throw new Error('failed to get essential fields from ' + JSON.stringify(res.body))
  }

  return newOptions
}

function * requestRetry (requestOptions, retryOptions) {
  let delay = retryOptions.backoffMin
  const start = Date.now()
  const timeout = retryOptions.timeout
  while (true) {
    debug('connecting to account ' + requestOptions.uri)
    try {
      const res = yield request(requestOptions)
      if (retryOptions.forceRetry && res.statusCode >= 400) {
        throw new Error(requestOptions.uri + ' failed with status code ' + res.statusCode)
      } else if (res.statusCode >= 400 && res.statusCode < 500) {
        // normally, don't retry 4xx level errors
        break
      } else if (res.statusCode >= 500) {
        throw new Error(requestOptions.uri + ' failed with status code ' + res.statusCode)
      }
      return res
    } catch (err) {
      delay = Math.min(Math.floor(1.5 * delay), retryOptions.backoffMax)
      if (Date.now() + delay - start > timeout) {
        throw new Error(retryOptions.errorMessage + ': timeout')
      }
      debug('http request to failed: ' + err.message + '; retrying in ' + delay + 'ms')
      yield wait(delay)
    }
  }
  debug('http request failed. aborting. (uri: ' + requestOptions.uri + ')')
  throw new Error(retryOptions.errorMessage)
}

module.exports = FiveBellsLedger
