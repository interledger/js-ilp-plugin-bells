'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const sinon = require('sinon')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Notification handling', function () {
  beforeEach(function * () {
    this.plugin = new PluginBells({
      prefix: 'example.red.',
      account: 'http://red.example/accounts/mike',
      password: 'mike',
      debugReplyNotifications: true,
      debugAutofund: {
        connector: 'http://mark.example',
        admin: {username: 'adminuser', password: 'adminpass'}
      }
    })

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')
    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    const nockAccount = nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })

    const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    const nockInfo = nock('http://red.example')
      .get('/')
      .reply(200, infoRedLedger)

    const nockAuthToken = nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    yield this.plugin.connect()

    nockAccount.done()
    nockInfo.done()
    nockAuthToken.done()

    this.stubReceive = sinon.stub()
    this.stubFulfillExecutionCondition = sinon.stub()
    this.stubIncomingCancel = sinon.stub()
    this.stubOutgoingCancel = sinon.stub()
    this.stubIncomingMessage = sinon.stub()

    this.plugin.on('incoming_cancel', this.stubIncomingCancel)
    this.plugin.on('outgoing_cancel', this.stubOutgoingCancel)
    this.plugin.on('incoming_prepare', this.stubReceive)
    this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)
    this.plugin.on('incoming_message', this.stubIncomingMessage)

    this.fiveBellsTransferMike = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      credits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10'
      }],
      state: 'rejected'
    }
    this.fiveBellsTransferAlice = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10'
      }],
      credits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      state: 'rejected'
    }

    this.transfer = {
      id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      direction: 'incoming',
      account: 'example.red.alice',
      from: 'example.red.alice',
      to: 'example.red.mike',
      amount: '10',
      expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
    }

    this.fiveBellsMessage = cloneDeep(require('./data/message.json'))
    this.message = {
      ledger: 'example.red.',
      account: 'example.red.alice',
      from: 'example.red.mike',
      to: 'example.red.alice',
      data: {foo: 'bar'}
    }
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'all nocks should be called')
  })

  describe('unrelated notifications', function () {
    it('emits an UnrelatedNotificationError for an unrelated transfer', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'UnrelatedNotificationError',
            message: 'Notification does not seem related to connector'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: {
            id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/alice',
              amount: '10'
            }],
            credits: [{
              account: 'http://red.example/accounts/bob',
              amount: '10'
            }],
            state: 'executed'
          }
        }
      }))
    })

    it('emits an UnrelatedNotificationError for an unrelated message', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'UnrelatedNotificationError',
            message: 'Notification does not seem related to connector'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'message.send',
          resource: {
            ledger: 'http://blue.example',
            account: 'http://red.example/accounts/alice',
            data: {}
          }
        }
      }))
    })
  })

  describe('notifications with an invalid format', function () {
    it('ignores a notification without a "type"', function () {
      this.wsRedLedger.send('{}')
    })

    it('ignores a notification with invalid JSON', function () {
      this.wsRedLedger.send('{')
    })

    it('emits an InvalidFieldsError when the transfer doesn\'t match the schema', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'InvalidFieldsError',
            message: 'invalid transfer'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: Object.assign(this.fiveBellsTransferAlice, {ledger: 'foo'})
        }
      }))
    })

    it('emits an InvalidFieldsError when the message doesn\'t match the schema', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'InvalidFieldsError',
            message: 'invalid message'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'message.send',
          resource: {
            ledger: 'http://red.example',
            account: 'alice'
          }
        }
      }))
    })
  })

  describe('notification of timeout', function () {
    it('should handle a rejected transfer to mike', function * () {
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: Object.assign(this.fiveBellsTransferAlice, {
            execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
          }),
          related_resources: {
            execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
          }
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.calledOnce(this.stubOutgoingCancel)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
    })

    it('should handle a rejected transfer to alice', function * () {
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: Object.assign(this.fiveBellsTransferMike, {
            execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
          }),
          related_resources: {
            execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
          }
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.calledOnce(this.stubIncomingCancel)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
    })
  })

  describe('notifications of incoming transfers', function () {
    beforeEach(function () {
      this.stubPrepare = sinon.stub()
      this.stubExecute = sinon.stub()
      this.stubReject = sinon.stub()
      this.stubFulfillExecutionCondition = sinon.stub()
      this.stubFulfillCancellationCondition = sinon.stub()
      this.plugin.on('incoming_prepare', this.stubPrepare)
      this.plugin.on('incoming_transfer', this.stubExecute)
      this.plugin.on('incoming_reject', this.stubReject)
      this.plugin.on('incoming_fulfill', this.stubFulfillExecutionCondition)
      this.plugin.on('incoming_cancel', this.stubFulfillCancellationCondition)

      this.fiveBellsTransferExecuted = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }],
        credits: [{
          account: 'http://red.example/accounts/mike',
          amount: '10'
        }],
        state: 'executed'
      }
      this.transfer = {
        id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        direction: 'incoming',
        account: 'example.red.alice',
        from: 'example.red.alice',
        to: 'example.red.mike',
        ledger: 'example.red.',
        amount: '10'
      }
    })

    it('should emit "incoming_fulfill" on incoming executed transfers',
      itEmitsFulfillExecutionCondition)
    it('should emit "incoming_cancel" on incoming rejected transfers',
      itEmitsFulfillCancellationCondition)

    it('should emit "incoming_reject" with the rejection_message', function * () {
      const rejectionMessage = {
        code: 'T00',
        name: 'Internal Error',
        message: 'fail!',
        triggered_by: 'example.red.',
        triggered_at: (new Date()).toISOString(),
        additional_info: {}
      }

      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: Object.assign(this.fiveBellsTransferExecuted, {
            state: 'rejected',
            credits: [
              Object.assign(this.fiveBellsTransferExecuted.credits[0], {
                rejected: true,
                rejection_message: rejectionMessage
              })
            ]
          })
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      sinon.assert.notCalled(this.stubFulfillCancellationCondition)
      sinon.assert.calledOnce(this.stubReject)
      sinon.assert.calledWith(this.stubReject, this.transfer, rejectionMessage)
    })

    it('should pass on incoming prepared transfers', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.fiveBellsTransferExecuted.state = 'prepared'
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferExecuted
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubPrepare)
      sinon.assert.calledWith(this.stubPrepare, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('should pass on incoming executed transfers', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferExecuted
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubExecute)
      sinon.assert.calledWith(this.stubExecute, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('should ignore unrelated credits', function * () {
      this.fiveBellsTransferExecuted.credits.push({
        account: 'http://red.example/accounts/george',
        amount: '10'
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferExecuted
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubExecute)
      sinon.assert.calledWith(this.stubExecute, this.transfer)
    })
  })

  describe('notifications of outgoing transfers', function () {
    beforeEach(function () {
      this.stubFulfillExecutionCondition = sinon.stub()
      this.stubFulfillCancellationCondition = sinon.stub()
      this.stubOutgoingPrepare = sinon.stub()
      this.stubOutgoingExecute = sinon.stub()
      this.stubOutgoingReject = sinon.stub()
      this.plugin.on('outgoing_prepare', this.stubOutgoingPrepare)
      this.plugin.on('outgoing_transfer', this.stubOutgoingExecute)
      this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)
      this.plugin.on('outgoing_cancel', this.stubFulfillCancellationCondition)
      this.plugin.on('outgoing_reject', this.stubOutgoingReject)

      this.fiveBellsTransferExecuted = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/mike',
          amount: '10'
        }],
        credits: [{
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }],
        state: 'executed'
      }
      this.transfer = {
        id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        direction: 'outgoing',
        account: 'example.red.alice',
        from: 'example.red.mike',
        to: 'example.red.alice',
        ledger: 'example.red.',
        amount: '10'
      }
    })

    it('should emit "outgoing_fulfill" on outgoing executed transfers',
      itEmitsFulfillExecutionCondition)
    it('should emit "outgoing_cancel" on outgoing rejected transfers',
      itEmitsFulfillCancellationCondition)

    it('should emit outgoing_cancel with the rejection_message', function * () {
      const rejectionMessage = {
        code: 'T00',
        name: 'Internal Error',
        message: 'fail!',
        triggered_by: 'example.red.',
        triggered_at: (new Date()).toISOString(),
        additional_info: {}
      }

      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: Object.assign(this.fiveBellsTransferExecuted, {
            state: 'rejected',
            credits: [
              Object.assign(this.fiveBellsTransferExecuted.credits[0], {
                rejected: true,
                rejection_message: rejectionMessage
              })
            ]
          })
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      sinon.assert.notCalled(this.stubFulfillCancellationCondition)
      sinon.assert.calledOnce(this.stubOutgoingReject)
      sinon.assert.calledWith(this.stubOutgoingReject, this.transfer, rejectionMessage)
    })

    it('be notified of an outgoing prepare', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.fiveBellsTransferExecuted.state = 'prepared'
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferExecuted
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubOutgoingPrepare)
      sinon.assert.calledWith(this.stubOutgoingPrepare, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('be notified of an outgoing execute', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'transfer.update',
          resource: this.fiveBellsTransferExecuted
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubOutgoingExecute)
      sinon.assert.calledWith(this.stubOutgoingExecute, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })
  })

  describe('notifications of incoming messages', function () {
    it('emits "incoming_message"', function * () {
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: {
          event: 'message.send',
          resource: this.fiveBellsMessage
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubIncomingMessage)

      // the account on an incoming transfer should indicate the sender
      sinon.assert.calledWith(this.stubIncomingMessage, Object.assign({},
        this.message,
        { account: this.message.from }))
    })
  })

  describe('notification of "connect"', function () {
    it('accepts the notification', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), { result: 'processed' })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({ type: 'connect' }))
    })
  })

  describe('notification with an unknown "type"', function () {
    it('ignores the notification', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'UnrelatedNotificationError',
            message: 'Invalid notification event: random'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'notify',
        params: { event: 'random' }
      }))
    })
  })
})

function * itEmitsFulfillExecutionCondition () {
  this.wsRedLedger.send(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    method: 'notify',
    params: {
      event: 'transfer.update',
      resource: Object.assign(this.fiveBellsTransferExecuted, {
        execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
      }),
      related_resources: {
        execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
      }
    }
  }))

  yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

  if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
  sinon.assert.calledOnce(this.stubFulfillExecutionCondition)
  sinon.assert.calledWith(this.stubFulfillExecutionCondition,
    Object.assign(this.transfer, {
      executionCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }), 'cf:0:ZXhlY3V0ZQ')
}

function * itEmitsFulfillCancellationCondition () {
  this.wsRedLedger.send(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    method: 'notify',
    params: {
      event: 'transfer.update',
      resource: Object.assign(this.fiveBellsTransferExecuted, {
        state: 'rejected',
        cancellation_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
      }),
      related_resources: {
        cancellation_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
      }
    }
  }))

  yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

  if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
  sinon.assert.notCalled(this.stubFulfillExecutionCondition)
  sinon.assert.calledOnce(this.stubFulfillCancellationCondition)
  sinon.assert.calledWith(this.stubFulfillCancellationCondition,
    Object.assign(this.transfer, {
      cancellationCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }), 'cf:0:ZXhlY3V0ZQ')
}
