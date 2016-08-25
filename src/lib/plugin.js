'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const debug = require('debug')('ilp-plugin-bells:plugin')
const ExternalError = require('../errors/external-error')
const UnrelatedNotificationError = require('../errors/unrelated-notification-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isUndefined = require('lodash/fp/isUndefined')
const omitUndefined = require('lodash/fp/omitBy')(isUndefined)
const map = require('lodash/map')
const defaults = require('lodash/defaults')

const backoffMin = 1000
const backoffMax = 30000

function wait (ms) {
  return function (done) {
    setTimeout(done, ms)
  }
}

function * requestRetry (opts, errorMessage, credentials) {
  let delay = backoffMin
  while (true) {
    debug('connecting to account ' + opts.uri)
    try {
      let res = yield request(defaults(opts, omitUndefined({
        auth: credentials.password && credentials.username && {
          user: credentials.username,
          pass: credentials.password
        },
        cert: credentials.cert,
        key: credentials.key,
        ca: credentials.ca,
        json: true
      })))
      if (res.statusCode >= 400 && res.statusCode < 500) {
        debug('request status ' + res.statusCode + ' retrying connection')
        throw new Error(errorMessage)
      }
      return res
    } catch (err) {
      debug('http request failed: ' + errorMessage)
      delay = Math.min(Math.floor(1.5 * delay), backoffMax)
      yield wait(delay)
    }
  }
}

class FiveBellsLedger extends EventEmitter2 {
  constructor (options) {
    super()

    if (typeof options !== 'object') {
      throw new TypeError('Expected an options object, received: ' + typeof options)
    }

    if (options.prefix && typeof options.prefix !== 'string') {
      throw new TypeError('Expected options.prefix to be a string, received: ' +
        typeof options.prefix)
    }

    if (typeof options.prefix === 'string' && options.prefix.slice(-1) !== '.') {
      throw new Error('Expected options.prefix to end with "."')
    }

    this.configPrefix = options.prefix
    this.host = options.host || null
    this.credentials = {
      account: options.account,
      password: options.password,
      cert: options.cert,
      key: options.key,
      ca: options.ca
    }
    this.connector = options.connector || null

    this.debugReplyNotifications = options.debugReplyNotifications || false

    this.connection = null
    this.connected = false
  }

  connect () {
    return co(this._connect.bind(this))
  }

  * _connect () {
    const accountUri = this.credentials.account

    if (this.connection) {
      debug('already connected, ignoring connection request')
      return Promise.resolve(null)
    }

    // Resolve account information
    const res = yield requestRetry({
      method: 'GET',
      uri: accountUri,
      json: true
    }, 'Failed to resolve ledger URI from account URI', this.credentials)

    if (!res.body.ledger) {
      throw new Error('Failed to resolve ledger URI from account URI')
    }
    this.host = res.body.ledger
    this.credentials.username = res.body.name

    if (!res.body.connector && this.connector) {
      const res2 = yield this._request({
        uri: accountUri,
        method: 'put',
        body: {
          name: res.body.name,
          connector: this.connector
        }
      })

      if (!res2 || res2.statusCode !== 200) {
        throw new Error('Unable to set connector URI')
      }
    }

    // Resolve ledger metadata
    const ledgerMetadata = yield this._fetchLedgerMetadata()
    this.accountUriTemplate = ledgerMetadata.urls.account

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

    const streamUri = accountUri.replace('http', 'ws') + '/transfers'
    debug('subscribing to ' + streamUri)
    const auth = this.credentials.password && this.credentials.username &&
                   this.credentials.username + ':' + this.credentials.password
    const options = {
      headers: auth && {
        Authorization: 'Basic ' + new Buffer(auth, 'utf8').toString('base64')
      },
      cert: this.credentials.cert,
      key: this.credentials.key,
      ca: this.credentials.ca
    }

    const reconnect = reconnectCore(function () {
      return new WebSocket(streamUri, omitUndefined(options))
    })

    return new Promise((resolve, reject) => {
      this.connection = reconnect({immediate: true}, (ws) => {
        ws.on('open', () => {
          debug('ws connected to ' + streamUri)
        })
        ws.on('message', (msg) => {
          const notification = JSON.parse(msg)
          debug('notify transfer', notification.resource.state, notification.resource.id)

          co.wrap(this._handleNotification)
            .call(this, notification.resource, notification.related_resources)
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
        ws.on('close', () => {
          debug('ws disconnected from ' + streamUri)
        })

        // reconnect-core expects the disconnect method to be called: `end`
        ws.end = ws.close
      })
      .once('connect', () => resolve(null))
      .on('connect', () => {
        this.connected = true
        this.emit('connect')
      })
      .on('disconnect', () => {
        this.connected = false
        this.emit('disconnect')
      })
      .on('error', (err) => {
        debug('ws error on ' + streamUri + ': ' + err)
        reject(err)
      })
      .connect()
    })
  }

  disconnect () {
    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }
    return Promise.resolve(null)
  }

  isConnected () {
    return this.connected
  }

  getInfo () {
    return co.wrap(this._getInfo).call(this)
  }

  * _getInfo () {
    const ledgerMetadata = yield this._fetchLedgerMetadata()

    return {
      precision: ledgerMetadata.precision,
      scale: ledgerMetadata.scale,
      currencyCode: ledgerMetadata.currency_code,
      currencySymbol: ledgerMetadata.currency_symbol
    }
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
    if (!this.prefix) {
      return Promise.reject(new Error('Prefix has not been set'))
    }
    return Promise.resolve(this.prefix)
  }

  getAccount () {
    if (!this.connected) {
      return Promise.reject(new Error('Must be connected before getAccount can be called'))
    }
    return Promise.resolve(this.prefix + this.credentials.username)
  }

  _validateTransfer (transfer) {
    // validator.validate('TransferTemplate', transfer)
  }

  getBalance () {
    return co.wrap(this._getBalance).call(this)
  }

  * _getBalance () {
    const creds = this.credentials
    let res
    try {
      res = yield request({
        method: 'get',
        uri: creds.account,
        auth: creds.password && {
          user: creds.username,
          pass: creds.password
        },
        ca: creds.ca,
        cert: creds.cert,
        key: creds.key,
        json: true
      })
    } catch (e) { }
    if (!res || res.statusCode !== 200) {
      throw new ExternalError('Unable to determine current balance')
    }
    return res.body.balance
  }

  getConnectors () {
    return co.wrap(this._getConnectors).call(this)
  }

  * _getConnectors () {
    if (!this.host) {
      throw new Error('Must be connected before getConnectors can be called')
    }

    const res = yield requestRetry({
      method: 'GET',
      uri: this.host + '/connectors',
      json: true
    }, 'Unable to get connectors for ledger ' + this.host, {})
    if (res.statusCode !== 200) {
      throw new ExternalError('Unexpected status code: ' + res.statusCode)
    }
    return map(res.body, 'connector')
  }

  send (transfer) {
    return co.wrap(this._send).call(this, transfer)
  }

  * _send (transfer) {
    // ILP addresses have two parts the ledger and the account. ilp-plugin-bells
    // will ignore everything after the first `.` of the account, so it can be used
    // to represent subledgering.
    const sourceUsername = transfer.account.slice(this.prefix.length).split('.')[0]
    const fiveBellsTransfer = omitUndefined({
      id: this.host + '/transfers/' + transfer.id,
      ledger: this.host,
      debits: [omitUndefined({
        account: this.credentials.account,
        amount: transfer.amount,
        authorized: true,
        memo: transfer.noteToSelf
      })],
      credits: [omitUndefined({
        account: this.host + '/accounts/' + encodeURIComponent(sourceUsername),
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
          body: [ fiveBellsTransfer.id + '/fulfillment' ],
          json: true
        })

        if (res.statusCode !== 200) {
          throw new Error('Unexpected status code: ' + res.statusCode)
        }
      }
    }

    debug('submitting transfer %s', fiveBellsTransfer.id)
    yield this._request({
      method: 'put',
      uri: fiveBellsTransfer.id,
      body: fiveBellsTransfer
    })

    // TODO: If already executed, fetch fulfillment and forward to source

    return null
  }

  fulfillCondition (transferID, conditionFulfillment) {
    return co.wrap(this._fulfillCondition).call(this, transferID, conditionFulfillment)
  }

  * _fulfillCondition (transferID, conditionFulfillment) {
    const fulfillmentRes = yield this._request({
      method: 'put',
      uri: this.host + '/transfers/' + transferID + '/fulfillment',
      body: conditionFulfillment,
      json: false
    })
    // TODO check the timestamp the ledger sends back
    // See https://github.com/interledger/five-bells-ledger/issues/149
    if (fulfillmentRes.statusCode === 200 || fulfillmentRes.statusCode === 201) {
      return null
    } else {
      throw new Error('Failed to submit fulfillment for transfer: ' + transferID + ' Error: ' + (fulfillmentRes.body ? JSON.stringify(fulfillmentRes.body) : fulfillmentRes.error))
    }
  }

  * _getTransferFulfillment (transfer) {
    const fulfillmentRes = yield this._request({
      method: 'get',
      uri: transfer.id + '/fulfillment'
    })
    return fulfillmentRes.body
  }

  * _handleNotification (fiveBellsTransfer, relatedResources) {
    this._validateTransfer(fiveBellsTransfer)

    let handled = false
    for (let credit of fiveBellsTransfer.credits) {
      if (credit.account === this.credentials.account) {
        handled = true

        const transfer = omitUndefined({
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
          yield this.emitAsync('incoming_cancel', transfer, 'transfer timed out.')
        }
      }
    }

    for (let debit of fiveBellsTransfer.debits) {
      if (debit.account === this.credentials.account) {
        handled = true

        // This connector only launches transfers with one credit, so there
        // should never be more than one credit.
        const credit = fiveBellsTransfer.credits[0]

        const transfer = omitUndefined({
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
          yield this.emitAsync('outgoing_cancel', transfer, 'transfer timed out.')
        }
      }
    }
    if (!handled) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
  }

  * _request (opts) {
    // TODO: check before this point that we actually have
    // credentials for the ledgers we're asked to settle between
    const credentials = this.credentials
    const transferRes = yield request(defaults(opts, omitUndefined({
      auth: credentials.username && credentials.password && {
        user: credentials.username,
        pass: credentials.password
      },
      cert: credentials.cert,
      key: credentials.key,
      ca: credentials.ca,
      json: true
    })))
    // TODO for source transfers: handle this so we actually get our money back
    if (transferRes.statusCode >= 400) {
      const error = new ExternalError('Remote error: status=' + transferRes.statusCode)
      error.status = transferRes.statusCode
      error.response = transferRes
      throw error
    }
    return transferRes
  }

  accountNameToUri (name) {
    return this.accountUriTemplate.replace(':name', name)
  }

  /**
   * Get the account name from "http://red.example/accounts/alice" (where
   * accountUriTemplate is "http://red.example/accounts/:name").
   */
  accountUriToName (accountURI) {
    const templatePath = parseURL(this.accountUriTemplate).path.split('/')
    const accountPath = parseURL(accountURI).path.split('/')
    for (let i = 0; i < templatePath.length; i++) {
      if (templatePath[i] === ':name') return accountPath[i]
    }
  }
}

module.exports = FiveBellsLedger
