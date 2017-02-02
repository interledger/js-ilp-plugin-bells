'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const errors = require('../src/errors')
const cloneDeep = require('lodash/cloneDeep')
const _ = require('lodash')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Transfer methods', function () {
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

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    this.nockAccount = nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
    this.ledgerTransfer = cloneDeep(require('./data/transfer.json'))
    this.transfer = {
      id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
      account: 'example.red.alice',
      amount: '123',
      noteToSelf: {source: 'something'},
      data: {foo: 'bar'}
    }

    this.nockInfo = nock('http://red.example')
      .get('/')
      .reply(200, this.infoRedLedger)

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')

    yield this.plugin.connect()
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'nocks should all have been called')
  })

  describe('sendTransfer', function () {
    it('submits a transfer', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', this.ledgerTransfer)
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200)
      yield assert.isFulfilled(this.plugin.sendTransfer(this.transfer), null)
    })

    it('should use the transfer url from the ledger metadata', function * () {
      nock.removeInterceptor(this.nockInfo)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, _.merge(this.infoRedLedger, {
          urls: {
            transfer: 'http://red.example/other/place/to/submit/transfers/:id'
          }
        }))
      const transferNock = nock('http://red.example')
        .put('/other/place/to/submit/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        .reply(200)
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })
      yield plugin.connect()

      yield plugin.sendTransfer(this.transfer)

      nockInfo.done()
      transferNock.done()
    })

    it('should not send any null or undefined values', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', (transfer) => {
          return !transfer.hasOwnProperty('execution_condition') && !transfer.hasOwnProperty('cancellation_condition')
        })
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200)
      yield assert.isFulfilled(this.plugin.sendTransfer(_.assign(this.transfer, {
        executionCondition: null,
        cancellationCondition: undefined
      })), null)
    })

    it('throws InvalidFieldsError for missing account', function (done) {
      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        amount: '1'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid account').notify(done)
    })

    it('throws InvalidFieldsError for missing amount', function (done) {
      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
    })

    it('throws InvalidFieldsError for negative amount', function (done) {
      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '-1'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
    })

    it('rejects a transfer when the destination does not begin with the correct prefix', function * () {
      yield assert.isRejected(this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'red.alice',
        amount: '123',
        noteToSelf: {source: 'something'},
        data: {foo: 'bar'}
      }), errors.InvalidFieldsError, /^Destination address "red.alice" must start with ledger prefix "example.red."$/)
    })

    it('throws an InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'InvalidBodyError', message: 'fail'})

      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
    })

    it('throws a DuplicateIdError on InvalidModificationError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'InvalidModificationError', message: 'fail'})

      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.DuplicateIdError, 'fail').notify(done)
    })

    it('throws an NotAcceptedError on 400', function (done) {
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
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'SomeError', message: 'fail'})

      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
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
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200)

      yield this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
      })
    })

    it('handles unexpected status on cases notification', function (done) {
      nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
        .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
        .reply(400)

      this.plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
      }).should.be.rejectedWith('Unexpected status code: 400').notify(done)
    })

    it('throws an Error when not connected', function (done) {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      plugin.sendTransfer({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
      }).should.be.rejectedWith(/Must be connected before sendTransfer can be called/).notify(done)
    })
  })

  describe('fulfillCondition', function () {
    it('throws InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'InvalidBodyError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.InvalidFieldsError, 'fail')
        .notify(done)
    })

    it('throws NotAcceptedError on UnmetConditionError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'UnmetConditionError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.NotAcceptedError, 'fail')
        .notify(done)
    })

    it('throws TransferNotConditionalError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'TransferNotConditionalError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.TransferNotConditionalError, 'fail')
        .notify(done)
    })

    it('throws TransferNotFoundError on NotFoundError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {id: 'NotFoundError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.TransferNotFoundError, 'fail')
        .notify(done)
    })

    it('throws AlreadyRolledBackError when fulfilling a rejected transfer', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'InvalidModificationError',
          message: 'Transfers in state rejected may not be executed'
        })
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.AlreadyRolledBackError, 'Transfers in state rejected may not be executed')
        .notify(done)
    })

    it('puts the fulfillment', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(201)
      yield assert.isFulfilled(this.plugin.fulfillCondition(
        '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        'cf:0:ZXhlY3V0ZQ'), null)
    })

    it('sets the content type to text/plain', function * () {
      nock('http://red.example', {
        reqheaders: {
          'content-type': 'text/plain'
        }
      })
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
        .reply(201)
      yield assert.isFulfilled(this.plugin.fulfillCondition(
        '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        'cf:0:ZXhlY3V0ZQ'), null)
    })

    it('should use the transfer_fulfillment url from the ledger metadata', function * () {
      nock.removeInterceptor(this.nockInfo)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, _.merge(this.infoRedLedger, {
          urls: {
            transfer_fulfillment: 'http://red.example/other/place/to/submit/transfers/:id/fulfillment'
          }
        }))
      const fulfillmentNock = nock('http://red.example')
        .put('/other/place/to/submit/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .reply(200)
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })
      yield plugin.connect()

      yield assert.isFulfilled(plugin.fulfillCondition(
        '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        'cf:0:ZXhlY3V0ZQ'), null)

      nockInfo.done()
      fulfillmentNock.done()
    })

    it('throws an ExternalError on 500', function () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(500)
      return assert.isRejected(this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ'), errors.ExternalError, /Failed to submit fulfillment for transfer: 6851929f-5a91-4d02-b9f4-4ae6b7f1768c Error: undefined/)
    })

    it('throws an Error when not connected', function () {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      return assert.isRejected(plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ'),
        /Must be connected before fulfillCondition can be called/)
    })
  })

  describe('getFulfillment', function () {
    it('returns the fulfillment', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200, 'cf:0:ZXhlY3V0ZQ')
      yield assert.isFulfilled(
        this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'),
        'cf:0:ZXhlY3V0ZQ')
    })

    it('throws TransferNotFoundError', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'TransferNotFoundError',
          message: 'This transfer does not exist'
        })
      return assert.isRejected(this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'), errors.TransferNotFoundError)
    })

    it('throws MissingFulfillmentError', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'MissingFulfillmentError',
          message: 'This transfer has no fulfillment'
        })
      return assert.isRejected(this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'), errors.MissingFulfillmentError)
    })

    it('throws an ExternalError on 500', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(500)
      return assert.isRejected(this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'), errors.ExternalError, /Remote error: status=500/)
    })

    it('throws an ExternalError on error', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .replyWithError('broken')
      return assert.isRejected(this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'), errors.ExternalError, /Remote error: message=broken/)
    })

    it('throws an Error when not connected', function () {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      return assert.isRejected(plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), /Must be connected before getFulfillment can be called/)
    })
  })

  describe('rejectIncomingTransfer', function () {
    it('returns null on success', function * () {
      nock('http://red.example', {
        reqheaders: {
          'Content-Type': 'text/plain'
        }
      })
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(200, {whatever: true})
      yield assert.isFulfilled(
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'),
        null,
        'should resolve to null')
    })

    it('throws NotAcceptedError on UnauthorizedError', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(422, {id: 'UnauthorizedError', message: 'error'})
      return assert.isRejected(this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), errors.NotAcceptedError, /error/)
    })

    it('throws TransferNotFoundError on NotFoundError', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(404, {id: 'NotFoundError', message: 'error'})
      return assert.isRejected(this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), errors.TransferNotFoundError, /error/)
    })

    it('throws AlreadyFulfilledError on InvalidModificationError', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(404, {id: 'InvalidModificationError', message: 'error'})
      return assert.isRejected(this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), errors.AlreadyFulfilledError, /error/)
    })

    it('throws ExternalError on 500', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(500)
      return assert.isRejected(this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), errors.ExternalError, /Remote error: status=500/)
    })

    it('throws an Error when not connected', function () {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      return assert.isRejected(plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'), /Must be connected before rejectIncomingTransfer can be called/)
    })
  })
})
