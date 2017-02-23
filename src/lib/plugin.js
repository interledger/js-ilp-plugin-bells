'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const debug = require('debug')('ilp-plugin-bells:plugin')
const errors = require('../errors')
const ExternalError = require('../errors/external-error')
const UnreachableError = require('../errors/unreachable-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isNil = require('lodash/fp/isNil')
const omitNil = require('lodash/fp/omitBy')(isNil)
const startsWith = require('lodash/fp/startsWith')
const translateBellsToPluginApi = require('./translate').translateBellsToPluginApi
const LedgerContext = require('./ledger-context')

const backoffMin = 1000
const backoffMax = 30000
const defaultConnectTimeout = 60000

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
  let delay = backoffMin
  const start = Date.now()
  const timeout = retryOptions.timeout
  while (true) {
    debug('connecting to account ' + requestOptions.uri)
    try {
      const res = yield request(requestOptions)
      if (res.statusCode >= 400 && res.statusCode < 500) {
        break
      } else if (res.statusCode >= 500) {
        throw new Error(requestOptions.uri +
          ' failed with status code ' +
          res.statusCode)
      }
      return res
    } catch (err) {
      delay = Math.min(Math.floor(1.5 * delay), backoffMax)
      if (Date.now() + delay - start > timeout) {
        throw new Error(retryOptions.errorMessage + ': timeout')
      }
      debug('http request failed: ' + err.message + '; retrying')
      yield wait(delay)
    }
  }
  debug('http request failed. aborting.')
  throw new Error(retryOptions.errorMessage)
}

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
      return new Promise((resolve, reject) => {
        this.once('_connect:done', (err) => err ? reject(err) : resolve())
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
      timeout: options.timeout
    })

    if (!res.body.ledger) {
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
    this.ready = true

    const authToken = yield this._getAuthToken()
    if (!authToken) throw new Error('Unable to get auth token from ledger')
    const notificationsUrl = this.ledgerContext.urls.websocket + '?token=' + encodeURIComponent(authToken)
    const reconnect = reconnectCore(() => {
      return new WebSocket(notificationsUrl)
    })

    const timeout = options.timeout
    const connectTimeoutRace = Promise.race([
      // if the timeout occurs before the websocket is successfully established,
      // the connect function will throw an error.
      wait(timeout).then(() => {
        throw new Error('websocket connection to ' +
          notificationsUrl +
          ' timed out before "connect" RPC message was received (' +
          timeout +
          ' ms)')
      }),
      // open a websocket connection to the websockets notification URL,
      // and wait for a "connect" RPC message on it.
      new Promise((resolve, reject) => {
        this.connection = reconnect({immediate: true}, (ws) => {
          ws.on('open', () => {
            debug('ws connected to ' + notificationsUrl)
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
              if (!this.connected) {
                this.emit('connect')
                this.connected = true
              }
              return resolve(null)
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
          ws.on('error', () => {
            debug('ws connection error on ' + notificationsUrl)
            reject(new UnreachableError('websocket connection error'))
          })
          ws.on('close', () => {
            this.connected = false
            debug('ws disconnected from ' + notificationsUrl)
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
            this.connected = false
            this.emit('disconnect')
            this.ws = null
          })
          .on('error', (err) => {
            debug('ws error on ' + notificationsUrl + ':', err)
            reject(err)
          })
          .connect()
      })
    ])

    return connectTimeoutRace
      .then(() => this._subscribeAccounts([this.account]))
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
      throw new ExternalError('Unable to determine ledger precision')
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

    if (!res || res.statusCode !== 200) throwErr()
    if (!res.body.precision || !res.body.scale) throwErr()

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
      res = yield request(Object.assign({
        method: 'get',
        uri: creds.account,
        json: true
      }, requestCredentials(creds)))
    } catch (e) { }
    if (!res || res.statusCode !== 200) {
      throw new ExternalError('Unable to determine current balance')
    }
    return res.body.balance
  }

  /**
   * @param {Object} message
   * @param {IlpAddress} message.account
   * @param {IlpAddress} message.ledger
   * @param {Object} message.data
   * @param {Object} message.custom (optional)
   * @returns {Promise.<null>}
   */
  sendMessage (message) {
    return co.wrap(this._sendMessage).call(this, message)
  }

  * _sendMessage (message) {
    debug('sending message: ' + JSON.stringify(message))
    if (!this.ready) {
      throw new Error('Must be connected before sendMessage can be called')
    }
    if (message.ledger !== this.ledgerContext.prefix) {
      throw new errors.InvalidFieldsError('invalid ledger')
    }
    if (typeof message.account !== 'string') {
      throw new errors.InvalidFieldsError('invalid account')
    }
    if (typeof message.data !== 'object') {
      throw new errors.InvalidFieldsError('invalid data')
    }

    const destinationAddress = this.parseAddress(message.account)
    const fiveBellsMessage = {
      ledger: this.ledgerContext.host,
      from: this.ledgerContext.urls.account.replace(':name', encodeURIComponent(this.username)),
      to: this.ledgerContext.urls.account.replace(':name', encodeURIComponent(destinationAddress.username)),
      data: message.data
    }
    debug('converted to ledger message: ' + JSON.stringify(fiveBellsMessage))

    const sendRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'post',
        uri: this.ledgerContext.urls.message,
        body: fiveBellsMessage,
        json: true
      }))
    const body = sendRes.body
    if (sendRes.statusCode >= 400) {
      debug('error submitting message:', sendRes.statusCode, JSON.stringify(sendRes.body))
      if (body.id === 'InvalidBodyError') throw new errors.InvalidFieldsError(body.message)
      if (body.id === 'NoSubscriptionsError') throw new errors.NoSubscriptionsError(body.message)
      throw new errors.NotAcceptedError(body.message)
    }
    return null
  }

  sendTransfer (transfer) {
    return co.wrap(this._sendTransfer).call(this, transfer)
  }

  * _sendTransfer (transfer) {
    if (!this.ready) {
      throw new Error('Must be connected before sendTransfer can be called')
    }
    if (typeof transfer.account !== 'string') {
      throw new errors.InvalidFieldsError('invalid account')
    }
    if (typeof transfer.amount !== 'string' || +transfer.amount <= 0) {
      throw new errors.InvalidFieldsError('invalid amount')
    }

    const sourceAddress = this.parseAddress(transfer.account)
    const fiveBellsTransfer = omitNil({
      id: this.ledgerContext.urls.transfer.replace(':id', transfer.id),
      ledger: this.ledgerContext.host,
      debits: [omitNil({
        account: this.account,
        amount: transfer.amount,
        authorized: true,
        memo: transfer.noteToSelf
      })],
      credits: [omitNil({
        account: this.ledgerContext.urls.account.replace(':name', encodeURIComponent(sourceAddress.username)),
        amount: transfer.amount,
        memo: transfer.data
      })],
      execution_condition: transfer.executionCondition,
      cancellation_condition: transfer.cancellationCondition,
      expires_at: transfer.expiresAt,
      additional_info: transfer.cases ? { cases: transfer.cases } : undefined
    })

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

    const sendRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: fiveBellsTransfer.id,
        body: fiveBellsTransfer,
        json: true
      }))
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
    const fulfillmentRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: this.ledgerContext.urls.transfer_fulfillment.replace(':id', transferId),
        body: conditionFulfillment,
        headers: {
          'content-type': 'text/plain'
        }
      }))
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
      throw new ExternalError('Failed to submit fulfillment for transfer: ' + transferId + ' Error: ' + (fulfillmentRes.body ? JSON.stringify(fulfillmentRes.body) : fulfillmentRes.error))
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
    let res
    try {
      res = yield request(Object.assign({
        method: 'get',
        uri: this.ledgerContext.urls.transfer_fulfillment.replace(':id', transferId),
        json: true
      }, requestCredentials(this.credentials)))
    } catch (err) {
      throw new ExternalError('Remote error: message=' + err.message)
    }

    if (res.statusCode === 200) return res.body
    if (res.statusCode >= 400 && res.body) {
      if (res.body.id === 'MissingFulfillmentError') throw new errors.MissingFulfillmentError(res.body.message)
      if (res.body.id === 'TransferNotFoundError') throw new errors.TransferNotFoundError(res.body.message)
      if (res.body.id === 'AlreadyRolledBackError') throw new errors.AlreadyRolledBackError(res.body.message)
      if (res.body.id === 'TransferNotConditionalError') throw new errors.TransferNotConditionalError(res.body.message)
    }
    throw new ExternalError('Remote error: status=' + (res && res.statusCode))
  }

  /**
   * @param {String} transferId
   * @param {String} rejectionMessage
   * @returns {Promise<null>}
   */
  rejectIncomingTransfer (transferId, rejectionMessage) {
    return co.wrap(this._rejectIncomingTransfer).call(this, transferId, rejectionMessage)
  }

  * _rejectIncomingTransfer (transferId, rejectionMessage) {
    if (!this.ready) {
      throw new Error('Must be connected before rejectIncomingTransfer can be called')
    }
    const rejectionRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'put',
        uri: this.ledgerContext.urls.transfer_rejection.replace(':id', transferId),
        body: rejectionMessage,
        headers: {
          'Content-Type': 'text/plain'
        }
      }))
    const body = getResponseJSON(rejectionRes)

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
      this.ws.send(rpcMessage)
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
    const eventParams = translateBellsToPluginApi(
      notification,
      this.account,
      this.ledgerContext
    )
    yield this.emitAsync.apply(this, eventParams)
  }

  parseAddress (address) {
    const prefix = this.getInfo().prefix

    if (!startsWith(prefix, address)) {
      debug('destination address has invalid prefix', { prefix, address })
      throw new errors.InvalidFieldsError('Destination address "' + address + '" must start ' +
        'with ledger prefix "' + prefix + '"')
    }

    const addressParts = address.substr(prefix.length).split('.')
    return {
      ledger: prefix,
      username: addressParts.slice(0, 1).join('.'),
      additionalParts: addressParts.slice(1).join('.')
    }
  }

  * _getAuthToken () {
    const authTokenRes = yield request(Object.assign(
      requestCredentials(this.credentials), {
        method: 'get',
        uri: this.ledgerContext.urls.auth_token
      }))
    const body = getResponseJSON(authTokenRes)
    return body && body.token
  }

  _requestRetry (requestOptions, retryOptions) {
    return requestRetry(Object.assign({
      credentials: this.credentials
    }, requestOptions), retryOptions)
  }
}

function requestCredentials (credentials) {
  return omitNil({
    auth: credentials.username && credentials.password && {
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

module.exports = FiveBellsLedger
