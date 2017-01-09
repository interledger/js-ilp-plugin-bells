'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const debug = require('debug')('ilp-plugin-bells:plugin')
const errors = require('../errors')
const ExternalError = require('../errors/external-error')
const UnrelatedNotificationError = require('../errors/unrelated-notification-error')
const UnreachableError = require('../errors/unreachable-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isNil = require('lodash/fp/isNil')
const omitNil = require('lodash/fp/omitBy')(isNil)
const startsWith = require('lodash/fp/startsWith')
const find = require('lodash/find')

const backoffMin = 1000
const backoffMax = 30000
const defaultConnectTimeout = 60000

const REQUIRED_LEDGER_URLS = [ 'transfer', 'transfer_fulfillment', 'transfer_rejection', 'account', 'auth_token', 'websocket' ]

function wait (ms) {
  return function (done) {
    setTimeout(done, ms)
  }
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
    this.host = options.host || null

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

    this.info = null
    this.connection = null
    this.connecting = false
    // `ready` is set when the metadata is retieved on the first connect() call.
    this.ready = false
    // `connected` is set while a websocket connection is active.
    this.connected = false
    this.ws = null
    this.urls = null
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
      throw new Error('Failed to resolve ledger URI from account URI')
    }
    this.host = res.body.ledger
    // Set the username but don't overwrite the username in case it was provided
    if (!this.credentials.username || !this.username) {
      this.username = this.credentials.username = res.body.name
    }

    // Resolve ledger metadata
    const ledgerMetadata = yield this._fetchLedgerMetadata()
    this.urls = parseAndValidateLedgerUrls(ledgerMetadata.urls)
    debug('using service urls:', this.urls)

    // Set ILP prefix
    const ledgerPrefix = ledgerMetadata.ilp_prefix
    this.prefix = this.configPrefix || ledgerMetadata.ilp_prefix

    if (ledgerPrefix && this.configPrefix && ledgerPrefix !== this.configPrefix) {
      console.warn('ilp-plugin-bells: ledger prefix (' + ledgerPrefix +
        ') does not match locally configured prefix (' + this.configPrefix + ')')
    }
    if (!this.prefix) {
      throw new Error('Unable to set prefix from ledger or from local config')
    }
    this.ready = true

    const authToken = yield this._getAuthToken()
    if (!authToken) throw new Error('Unable to get auth token from ledger')
    const notificationsUrl = this.urls.websocket + '?token=' + encodeURIComponent(authToken)
    const reconnect = reconnectCore(() => {
      return new WebSocket(notificationsUrl)
    })

    return new Promise((resolve, reject) => {
      this.connection = reconnect({immediate: true}, (ws) => {
        ws.on('open', () => {
          if (!this.connected) {
            this.emit('connect')
            this.connected = true
          }
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

          if (rpcMessage.method === 'connect') return resolve(null)
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
    }).then(() => this._subscribeAccounts([this.account]))
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
    return co.wrap(this._getInfo).call(this)
  }

  * _getInfo () {
    if (this.info) return this.info
    const ledgerMetadata = yield this._fetchLedgerMetadata()

    this.info = {
      connectors: ledgerMetadata.connectors,
      precision: ledgerMetadata.precision,
      scale: ledgerMetadata.scale,
      currencyCode: ledgerMetadata.currency_code,
      currencySymbol: ledgerMetadata.currency_symbol
    }
    return this.info
  }

  * _fetchLedgerMetadata () {
    debug('request ledger metadata %s', this.host)
    function throwErr () {
      throw new ExternalError('Unable to determine ledger precision')
    }

    let res
    try {
      res = yield request(this.host, {json: true})
    } catch (e) {
      if (!res || res.statusCode !== 200) {
        debug('getInfo error %s', e)
        throwErr()
      }
    }

    if (!res || res.statusCode !== 200) throwErr()
    if (!res.body.precision || !res.body.scale) throwErr()

    return res.body
  }

  getPrefix () {
    if (this.prefix) {
      return Promise.resolve(this.prefix)
    }
    if (!this.ready) {
      return Promise.reject(new Error('Must be connected before getPrefix can be called'))
    }
    return Promise.reject(new Error('Prefix has not been set'))
  }

  getAccount () {
    if (!this.ready) {
      return Promise.reject(new Error('Must be connected before getAccount can be called'))
    }
    return Promise.resolve(this.prefix + this.accountUriToName(this.account))
  }

  _validateTransfer (transfer) {
    // validator.validate('TransferTemplate', transfer)
  }

  _validateMessage (message) {
    if (message.ledger !== this.host) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
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
    if (!this.ready) {
      throw new Error('Must be connected before sendMessage can be called')
    }
    if (message.ledger !== this.prefix) {
      throw new errors.InvalidFieldsError('invalid ledger')
    }
    if (typeof message.account !== 'string') {
      throw new errors.InvalidFieldsError('invalid account')
    }
    if (typeof message.data !== 'object') {
      throw new errors.InvalidFieldsError('invalid data')
    }

    const destinationAddress = yield this.parseAddress(message.account)
    const fiveBellsMessage = {
      ledger: this.host,
      from: this.urls.account.replace(':name', encodeURIComponent(this.username)),
      to: this.urls.account.replace(':name', encodeURIComponent(destinationAddress.username)),
      data: message.data
    }
    yield this._sendRpcRequest('send_message', fiveBellsMessage)
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

    const sourceAddress = yield this.parseAddress(transfer.account)
    const fiveBellsTransfer = omitNil({
      id: this.urls.transfer.replace(':id', transfer.id),
      ledger: this.host,
      debits: [omitNil({
        account: this.account,
        amount: transfer.amount,
        authorized: true,
        memo: transfer.noteToSelf
      })],
      credits: [omitNil({
        account: this.urls.account.replace(':name', encodeURIComponent(sourceAddress.username)),
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
          body: [ this.urls.transfer_fulfillment.replace(':id', transfer.id) ],
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
        uri: this.urls.transfer_fulfillment.replace(':id', transferId),
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
        uri: this.urls.transfer_fulfillment.replace(':id', transferId),
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
        uri: this.urls.transfer_rejection.replace(':id', transferId),
        body: rejectionMessage
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
          const code = rpcResponse.error.code
          const message = rpcResponse.error.message
          return reject(
            code === 42200 ? new errors.NoSubscriptionsError(message)
            : (code >= 40000 && code < 50000) ? new errors.InvalidFieldsError(message)
            : new errors.NotAcceptedError(message))
        }
        resolve(rpcResponse)
      }
      this.on('_rpc:response', listener)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
    })
  }

  _subscribeAccounts (accounts) {
    return this._sendRpcRequest('subscribe_account', {
      eventType: '*',
      accounts: accounts
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
    const event = notification.event
    const data = notification.resource
    if (event === 'transfer.create' || event === 'transfer.update') {
      debug('notify transfer', data.state, data.id)
      return yield this._handleTransferNotification(data, notification.related_resources)
    } else if (event === 'message.send') {
      debug('notify message', data.account)
      return yield this._handleMessageNotification(data)
    } else {
      throw new UnrelatedNotificationError('Invalid notification event: ' + event)
    }
  }

  * _handleTransferNotification (fiveBellsTransfer, relatedResources) {
    this._validateTransfer(fiveBellsTransfer)

    let handled = false
    for (let credit of fiveBellsTransfer.credits) {
      if (credit.account === this.account) {
        handled = true

        const transfer = omitNil({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'incoming',
          // TODO: What if there are multiple debits?
          account: this.prefix + this.accountUriToName(fiveBellsTransfer.debits[0].account),
          ledger: this.prefix,
          amount: credit.amount,
          data: credit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('incoming_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('incoming_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
            relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('incoming_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
            relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('incoming_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
          if (rejectedCredit) {
            yield this.emitAsync('incoming_reject', transfer,
              new Buffer(rejectedCredit.rejection_message, 'base64').toString())
          } else {
            yield this.emitAsync('incoming_cancel', transfer, 'transfer timed out.')
          }
        }
      }
    }

    for (let debit of fiveBellsTransfer.debits) {
      if (debit.account === this.account) {
        handled = true

        // This connector only launches transfers with one credit, so there
        // should never be more than one credit.
        const credit = fiveBellsTransfer.credits[0]

        const transfer = omitNil({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'outgoing',
          account: this.prefix + this.accountUriToName(credit.account),
          ledger: this.prefix,
          amount: debit.amount,
          data: credit.memo,
          noteToSelf: debit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('outgoing_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('outgoing_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
            relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('outgoing_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
            relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('outgoing_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
          if (rejectedCredit) {
            yield this.emitAsync('outgoing_reject', transfer,
              new Buffer(rejectedCredit.rejection_message, 'base64').toString())
          } else {
            yield this.emitAsync('outgoing_cancel', transfer, 'transfer timed out.')
          }
        }
      }
    }
    if (!handled) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
  }

  _handleMessageNotification (message) {
    this._validateMessage(message)
    return this.emitAsync('incoming_message', {
      ledger: this.prefix,
      account: this.prefix + this.accountUriToName(message.account || message.to),
      data: message.data
    })
  }

  /**
   * Get the account name from "http://red.example/accounts/alice" (where
   * accountUriTemplate is "http://red.example/accounts/:name").
   */
  accountUriToName (accountURI) {
    const templatePath = parseURL(this.urls.account).path.split('/')
    const accountPath = parseURL(accountURI).path.split('/')
    for (let i = 0; i < templatePath.length; i++) {
      if (templatePath[i] === ':name') return accountPath[i]
    }
  }

  * parseAddress (address) {
    const prefix = yield this.getPrefix()

    if (!startsWith(prefix, address)) {
      debug('destination address has invalid prefix', { prefix, address })
      throw new errors.InvalidFieldsError('Destination address "' + address + '" must start ' +
        'with ledger prefix "' + prefix + '"')
    }

    const addressParts = address.substr(this.prefix.length).split('.')
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
        uri: this.urls.auth_token
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

function parseAndValidateLedgerUrls (metadataUrls) {
  if (!metadataUrls) {
    throw new ExternalError('ledger metadata does not include a urls map')
  }

  const urls = {}
  REQUIRED_LEDGER_URLS.forEach((service) => {
    if (!metadataUrls[service]) {
      throw new ExternalError('ledger metadata does not include ' + service + ' url')
    }

    if (service === 'websocket') {
      if (metadataUrls[service].indexOf('ws') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full ws(s) url')
      }
    } else {
      if (metadataUrls[service].indexOf('http') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full http(s) url')
      }
    }
    urls[service] = metadataUrls[service]
  })

  return urls
}

module.exports = FiveBellsLedger
