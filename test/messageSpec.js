'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const sinon = require('sinon')
const nock = require('nock')
const IlpPacket = require('ilp-packet')
const wsHelper = require('./helpers/ws')
const errors = require('../src/errors')
const cloneDeep = require('lodash/cloneDeep')
const _ = require('lodash')
const InvalidFieldsError = require('../src/errors').InvalidFieldsError
const START_DATE = 1434412800000 // June 16, 2015 00:00:00 GMT

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Messaging', function () {
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
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })
      .get('/transfers/1')
      .reply(403)

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
    this.ledgerMessage = cloneDeep(require('./data/message-with-all.json'))
    this.message = {
      id: '6a13abf0-2333-4d1e-9afc-5bf32c6dc0dd',
      ledger: 'example.red.',
      to: 'example.red.alice',
      ilp: Buffer.from('hello').toString('base64'),
      custom: {foo: 'bar'}
    }

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    this.nockInfo = nock('http://red.example')
      .get('/')
      .reply(200, this.infoRedLedger)

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')

    yield this.plugin.connect()
    this.clock = sinon.useFakeTimers(START_DATE, 'Date')
  })

  afterEach(function * () {
    this.clock.restore()
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'nocks should all have been called. Pending mocks are: ' +
      nock.pendingMocks())
  })

  describe('sendRequest', function () {
    it('submits a message and returns the response', function * () {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      setTimeout(() => {
        this.plugin.emit('incoming_message', {custom: {response: true}}, this.message.id)
      }, 10)
      yield assert.eventually.deepEqual(this.plugin.sendRequest(this.message), {
        custom: {response: true}
      })
    })

    it('ignores a message with the wrong id', function * () {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      setTimeout(() => {
        this.plugin.emit('incoming_message', {custom: {response: 1}}, 'random')
        this.plugin.emit('incoming_message', {custom: {response: 2}}, this.message.id)
      }, 10)
      yield assert.eventually.deepEqual(this.plugin.sendRequest(this.message), {
        custom: {response: 2}
      })
    })

    it('should use the message url from the ledger metadata', function * () {
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
        .get('/transfers/1')
        .reply(403)

      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, _.merge(this.infoRedLedger, {
          urls: {
            message: 'http://red.example/other/place/to/submit/messages'
          }
        }))
      const messageNock = nock('http://red.example')
        .post('/other/place/to/submit/messages')
        .matchHeader('authorization', 'Bearer abc')
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

      setTimeout(() => {
        plugin.emit('incoming_message', {}, this.message.id)
      }, 10)
      yield plugin.sendRequest(this.message)

      nockInfo.done()
      messageNock.done()
    })

    it('throws InvalidFieldsError for missing to field', function (done) {
      this.plugin.sendRequest({
        ledger: 'example.red.',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid to field').notify(done)
    })

    it('throws InvalidFieldsError for missing ledger', function (done) {
      this.plugin.sendRequest({
        to: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError for incorrect ledger', function (done) {
      this.plugin.sendRequest({
        ledger: 'example.blue.',
        to: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError if "ilp" isnt a string', function (done) {
      this.plugin.sendRequest({
        ledger: 'example.red.',
        to: 'example.red.alice',
        ilp: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ilp field').notify(done)
    })

    it('throws InvalidFieldsError if "custom" isnt an object', function (done) {
      this.plugin.sendRequest({
        ledger: 'example.red.',
        to: 'example.red.alice',
        custom: 'foo'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid custom field').notify(done)
    })

    it('rejects a message when the destination does not begin with the correct prefix', function * () {
      yield assert.isRejected(this.plugin.sendRequest({
        ledger: 'example.red.',
        to: 'red.alice',
        data: {foo: 'bar'}
      }), InvalidFieldsError, /^Destination address "red.alice" must start with ledger prefix "example.red."$/)
    })

    it('throws an InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .post('/messages')
        .matchHeader('authorization', 'Bearer abc')
        .reply(400, {id: 'InvalidBodyError', message: 'fail'})

      this.plugin.sendRequest(this.message)
        .should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
    })

    it('throws a NoSubscriptionsError', function (done) {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(422, {id: 'NoSubscriptionsError', message: 'fail'})

      this.plugin.sendRequest(this.message)
        .should.be.rejectedWith(errors.NoSubscriptionsError, 'fail').notify(done)
    })

    it('throws an NotAcceptedError on 400', function (done) {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(400, {id: 'SomeError', message: 'fail'})

      this.plugin.sendRequest(this.message)
        .should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
    })

    it('throws an Error when not connected', function (done) {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      plugin.sendRequest(this.message)
        .should.be.rejectedWith(Error, 'Must be connected before sendRequest can be called').notify(done)
    })

    it('times out if no response is returned', function (done) {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)
      this.plugin.sendRequest(Object.assign({timeout: 10}, this.message))
        .should.be.rejectedWith(Error, 'sendRequest timed out').notify(done)
    })
  })

  describe('registerRequestHandler', function () {
    beforeEach(function () {
      this.requestMessage = {
        ledger: this.message.ledger,
        from: 'example.red.alice',
        to: 'example.red.mike',
        custom: {request: true}
      }
    })

    it('doesn\'t allow overwriting the handler', function () {
      const requestHandler = () => {}
      this.plugin.registerRequestHandler(requestHandler)
      assert.equal(this.plugin.requestHandler, requestHandler)
      assert.throws(() => {
        this.plugin.registerRequestHandler(() => {})
      }, errors.RequestHandlerAlreadyRegisteredError, 'Cannot overwrite requestHandler')
    })

    it('relays response messages to the ledger', function * () {
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      this.plugin.registerRequestHandler((requestMessage) => {
        assert.equal(requestMessage, this.requestMessage)
        return Promise.resolve(this.message)
      })
      yield this.plugin.emitAsync('incoming_message', this.requestMessage, this.message.id)
    })

    it('relays error messages to the ledger', function * () {
      nock('http://red.example')
        .post('/messages', (message) => {
          assert.equal(message.ledger, this.ledgerMessage.ledger)
          assert.equal(message.from, this.ledgerMessage.from)
          assert.equal(message.to, this.ledgerMessage.to)
          assert.equal(message.id, this.ledgerMessage.id)
          assert.deepEqual(IlpPacket.deserializeIlpError(Buffer.from(message.ilp, 'base64')), {
            code: 'F00',
            name: 'Bad Request',
            triggeredBy: 'example.red.mike',
            forwardedBy: [],
            triggeredAt: new Date(),
            data: JSON.stringify({message: 'fail'})
          })
          return true
        })
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      this.plugin.registerRequestHandler((requestMessage) => {
        assert.equal(requestMessage, this.requestMessage)
        return Promise.reject(new Error('fail'))
      })
      yield this.plugin.emitAsync('incoming_message', this.requestMessage, this.message.id)
    })

    it('relays an error message to the ledger if no response is returned', function * () {
      nock('http://red.example')
        .post('/messages', (message) => {
          assert.deepEqual(IlpPacket.deserializeIlpError(Buffer.from(message.ilp, 'base64')), {
            code: 'F00',
            name: 'Bad Request',
            triggeredBy: 'example.red.mike',
            forwardedBy: [],
            triggeredAt: new Date(),
            data: JSON.stringify({message: 'No matching handler for request'})
          })
          return true
        })
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      this.plugin.registerRequestHandler((requestMessage) => {
        assert.equal(requestMessage, this.requestMessage)
        return Promise.resolve()
      })
      yield this.plugin.emitAsync('incoming_message', this.requestMessage, this.message.id)
    })
  })

  describe('deregisterRequestHandler', function () {
    it('allows the request handler to be reset', function () {
      this.plugin.registerRequestHandler(() => {})
      this.plugin.deregisterRequestHandler()
      assert.equal(this.plugin.requestHandler, null)
      this.plugin.registerRequestHandler(() => {})
    })
  })

  describe('notifications of outgoing messages', function () {
    it('emits "outgoing_request"', function * () {
      this.stubOutgoingRequest = sinon.stub()
      this.plugin.on('outgoing_request', this.stubOutgoingRequest)
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      setTimeout(() => {
        this.plugin.emit('incoming_message', {custom: {response: true}}, this.message.id)
      }, 10)
      yield assert.eventually.deepEqual(this.plugin.sendRequest(this.message), {custom: {response: true}})
      sinon.assert.calledOnce(this.stubOutgoingRequest)
      sinon.assert.calledWith(this.stubOutgoingRequest, this.message)
    })

    it('emits "outgoing_response"', function * () {
      this.stubOutgoingResponse = sinon.stub()
      this.plugin.on('outgoing_response', this.stubOutgoingResponse)
      nock('http://red.example')
        .post('/messages', this.ledgerMessage)
        .matchHeader('authorization', 'Bearer abc')
        .reply(200)

      this.plugin.registerRequestHandler((requestMessage) => {
        return Promise.resolve(this.message)
      })
      yield this.plugin.emitAsync('incoming_message', {custom: {request: true}}, this.message.id)
      sinon.assert.calledOnce(this.stubOutgoingResponse)
      sinon.assert.calledWith(this.stubOutgoingResponse, this.message)
    })
  })
})
