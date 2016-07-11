'use strict'

const assert = require('chai').assert
const expect = require('chai').expect
const mock = require('mock-require')
const nock = require('nock')
const sinon = require('sinon')
const wsHelper = require('./helpers/ws')
const ExternalError = require('../src/errors/external-error')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('PluginBells', function () {
  afterEach(function () { assert(nock.isDone()) })

  it('should be a class', function () {
    assert.isFunction(PluginBells)
  })

  describe('constructor', function () {
    it('should succeed with valid configuration', function () {
      const plugin = new PluginBells({
        auth: {
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        }
      })

      assert.instanceOf(plugin, PluginBells)
    })

    it('should throw when options are missing', function () {
      assert.throws(() => {
        return new PluginBells()
      }, 'Expected an options object, received: undefined')
    })

    it('should throw when auth information is missing', function () {
      assert.throws(() => {
        return new PluginBells({
          // no auth
        })
      }, 'Expected options.auth to be an object, received: undefined')
    })
  })

  describe('instance', function () {
    beforeEach(function * () {
      this.plugin = new PluginBells({
        auth: {
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        },
        id: 'http://red.example'
      })
    })

    describe('connect', function () {
      it('connects', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })

        yield this.plugin.connect()

        assert.isTrue(this.plugin.isConnected())
      })

      it('ignores if called twice', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })

        yield this.plugin.connect()
        yield this.plugin.connect()

        assert.isTrue(this.plugin.isConnected())
      })

      it('fails if the response is invalid', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, { name: 'mike' })

        try {
          yield this.plugin.connect()
          assert(false)
        } catch (err) {
          assert.isFalse(this.plugin.isConnected())
          assert.equal(err.message, 'Failed to resolve ledger URI from account URI')
        }
      })

      describe('a connector', function () {
        beforeEach(function () {
          this.plugin = new PluginBells({
            connector: 'http://mark.example',
            auth: {
              account: 'http://red.example/accounts/mike',
              password: 'mike'
            }
          })
        })

        it('creates an account', function * () {
          nock('http://red.example')
            .get('/accounts/mike')
            .reply(200, { ledger: 'http://red.example', name: 'mike' })
            .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
            .reply(200)
          yield this.plugin.connect()
        })

        it('throws an ExternalError if unable the create an account', function * () {
          nock('http://red.example')
            .get('/accounts/mike')
            .reply(200, { ledger: 'http://red.example', name: 'mike' })
            .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
            .reply(500)
          try {
            yield this.plugin.connect()
            assert(false)
          } catch (err) {
            assert(err instanceof ExternalError)
            assert.equal(err.message, 'Remote error: status=500 body=undefined')
          }
        })
      })
    })

    it('should retry when getting connectors', function * () {
      const nockConnectorsError = nock('http://red.example')
        .get('/connectors')
        .replyWithError('Error')

      const nockConnectorsSuccess = nock('http://red.example')
        .get('/connectors')
        .reply(200, [{
          id: 'http://red.example/accounts/bob',
          name: 'bob',
          connector: 'http://connector.example'
        }])

      const connectors = yield this.plugin.getConnectors()
      expect(connectors).to.deep.equal(['http://connector.example'])

      nockConnectorsError.done()
      nockConnectorsSuccess.done()
    })
  })

  describe('connected instance', function () {
    beforeEach(function * () {
      this.plugin = new PluginBells({
        id: 'http://red.example',
        auth: {
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        },
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })

      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      this.wsRedLedger = new wsHelper.Server('ws://red.example/accounts/mike/transfers')

      yield this.plugin.connect()
    })

    afterEach(function * () {
      this.wsRedLedger.stop()
    })

    function * itEmitsFulfillExecutionCondition () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.calledOnce(this.stubFulfillExecutionCondition)
      sinon.assert.calledWith(this.stubFulfillExecutionCondition,
        Object.assign(this.transfer, {
          executionCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }), 'cf:0:ZXhlY3V0ZQ')
    }

    function * itEmitsFulfillCancellationCondition () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          state: 'rejected',
          cancellation_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          cancellation_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
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

    describe('notifications of unrelated transfers', function () {
      it('emits an UnrelatedNotificationError for an unrelated notification', function (done) {
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
        }))
      })
    })

    describe('notifications of incoming transfers', function () {
      beforeEach(function () {
        this.stubReceive = sinon.stub()
        this.stubFulfillExecutionCondition = sinon.stub()
        this.stubFulfillCancellationCondition = sinon.stub()
        this.plugin.on('receive', this.stubReceive)
        this.plugin.on('fulfill_execution_condition', this.stubFulfillExecutionCondition)
        this.plugin.on('fulfill_cancellation_condition', this.stubFulfillCancellationCondition)

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
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }
      })

      it('should emit "fulfill_execution_condition" on incoming executed transfers',
        itEmitsFulfillExecutionCondition)
      it('should emit "fulfill_cancellation_condition" on incoming rejected transfers',
        itEmitsFulfillCancellationCondition)

      it('should pass on incoming prepared transfers', function * () {
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.fiveBellsTransferExecuted.state = 'prepared'
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubReceive)
        sinon.assert.calledWith(this.stubReceive, Object.assign(this.transfer, {
          expiresAt: this.fiveBellsTransferExecuted.expires_at
        }))
      })

      it('should pass on incoming executed transfers', function * () {
        // The transfer is executed, so this.transfer doesn't have an expiredAt.
        this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubReceive)
        sinon.assert.calledWith(this.stubReceive, this.transfer)
      })

      it('should ignore unrelated credits', function * () {
        this.fiveBellsTransferExecuted.credits.push({
          account: 'http://red.example/accounts/george',
          amount: '10'
        })
        this.wsRedLedger.send(JSON.stringify({
          resource: this.fiveBellsTransferExecuted
        }))

        yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
        sinon.assert.calledOnce(this.stubReceive)
        sinon.assert.calledWith(this.stubReceive, this.transfer)
      })
    })

    describe('notifications of outgoing transfers', function () {
      beforeEach(function () {
        this.stubFulfillExecutionCondition = sinon.stub()
        this.stubFulfillCancellationCondition = sinon.stub()
        this.plugin.on('fulfill_execution_condition', this.stubFulfillExecutionCondition)
        this.plugin.on('fulfill_cancellation_condition', this.stubFulfillCancellationCondition)

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
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }
      })

      it('should emit "fulfill_execution_condition" on outgoing executed transfers',
        itEmitsFulfillExecutionCondition)
      it('should emit "fulfill_cancellation_condition" on outgoing rejected transfers',
        itEmitsFulfillCancellationCondition)
    })

    describe('disconnect', function () {
      it('closes the connection', function () {
        assert.isTrue(this.plugin.isConnected())
        this.plugin.disconnect()
        assert.isFalse(this.plugin.isConnected())
        // A second time does nothing.
        this.plugin.disconnect()
      })
    })

    describe('getInfo', function () {
      it('gets the precision and scale', function * () {
        nock('http://red.example')
          .get('/')
          .reply(200, {precision: 10, scale: 4, foo: 'bar'})

        const info = yield this.plugin.getInfo()
        assert.deepEqual(info, {precision: 10, scale: 4})
      })

      it('throws an ExternalError on 500', function * () {
        nock('http://red.example')
          .get('/')
          .reply(500)
        try {
          yield this.plugin.getInfo()
          assert(false)
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Unable to determine ledger precision')
        }
      })

      it('throws an ExternalError when the precision is missing', function * () {
        nock('http://red.example')
          .get('/')
          .reply(200, {scale: 4})
        try {
          yield this.plugin.getInfo()
          assert(false)
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Unable to determine ledger precision')
        }
      })
    })

    describe('getAccount', function () {
      it('returns the plugin\'s account', function () {
        assert.equal(this.plugin.getAccount(), 'http://red.example/accounts/mike')
      })
    })

    describe('getBalance', function () {
      it('returns the current balance', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {balance: '100'})
        const balance = yield this.plugin.getBalance()
        assert.equal(balance, '100')
      })

      it('throws an ExternalError on 500', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(500)
        try {
          yield this.plugin.getBalance()
          assert(false)
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Unable to determine current balance')
        }
      })
    })

    describe('getConnectors', function () {
      it('returns a list of connectors', function * () {
        nock('http://red.example')
          .get('/connectors')
          .reply(200, [{connector: 'one'}, {connector: 'two'}])
        const connectors = yield this.plugin.getConnectors()
        assert.deepEqual(connectors, ['one', 'two'])
      })

      it('throws an ExternalError on 500', function * () {
        nock('http://red.example')
          .get('/connectors')
          .reply(500)
        try {
          yield this.plugin.getConnectors()
          assert(false)
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Unexpected status code: 500')
        }
      })
    })

    describe('send', function () {
      it('submits a transfer', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true,
              memo: {source: 'something'}
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123',
              memo: {foo: 'bar'}
            }]
          })
          .reply(200)
        yield this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'http://red.example/accounts/alice',
          amount: '123',
          noteToSelf: {source: 'something'},
          data: {foo: 'bar'}
        })
      })

      it('throws an ExternalError on 400', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123'
            }]
          })
          .reply(400, {id: 'SomeError'})
        try {
          yield this.plugin.send({
            id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            account: 'http://red.example/accounts/alice',
            amount: '123'
          })
          assert(false)
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Remote error: status=400 body=[object Object]')
        }
      })

      it('sets up case notifications when "cases" is provided', function * () {
        nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
          .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
          .reply(200)
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
            id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
            ledger: 'http://red.example',
            debits: [{
              account: 'http://red.example/accounts/mike',
              amount: '123',
              authorized: true
            }],
            credits: [{
              account: 'http://red.example/accounts/alice',
              amount: '123'
            }],
            additional_info: {cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']}
          })
          .reply(200)

        yield this.plugin.send({
          id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          account: 'http://red.example/accounts/alice',
          amount: '123',
          cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
        })
      })
    })

    describe('fulfillCondition', function () {
      it('puts the fulfillment', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
          .reply(201)
        const state = yield this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ')
        assert.equal(state, 'executed')
      })

      it('throws an ExternalError on 500', function * () {
        nock('http://red.example')
          .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
          .reply(500)
        try {
          yield this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ')
        } catch (err) {
          assert(err instanceof ExternalError)
          assert.equal(err.message, 'Remote error: status=500 body=')
        }
      })
    })
  })
})
