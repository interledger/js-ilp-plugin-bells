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

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Messaging', function () {
  beforeEach(function * () {
    this.plugin = new PluginBells({
      prefix: 'example.red.',
      account: 'http://red.example/accounts/mike',
      password: 'mike',
      debugAutofund: {
        connector: 'http://mark.example',
        admin: {username: 'adminuser', password: 'adminpass'}
      }
    })

    this.nockAccount = nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
    this.ledgerMessage = cloneDeep(require('./data/message.json'))
    this.message = {
      ledger: 'example.red.',
      account: 'example.red.alice',
      data: {foo: 'bar'}
    }

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

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

  describe('sendMessage', function () {
    it('submits a message', function (done) {
      const sendMessage = this.plugin.sendMessage(this.message)
      this.wsRedLedger.on('message', (rpcMessageString) => {
        const rpcMessage = JSON.parse(rpcMessageString)
        assert.deepEqual(rpcMessage, {
          jsonrpc: '2.0',
          id: 2,
          method: 'send_message',
          params: this.ledgerMessage
        })
        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcMessage.id
        }))
        assert.isFulfilled(sendMessage, null).then(done)
      })
    })

    it('throws InvalidFieldsError for missing account', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.red.',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid account').notify(done)
    })

    it('throws InvalidFieldsError for missing ledger', function (done) {
      this.plugin.sendMessage({
        account: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError for incorrect ledger', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.blue.',
        account: 'example.red.alice',
        data: {}
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid ledger').notify(done)
    })

    it('throws InvalidFieldsError for missing data', function (done) {
      this.plugin.sendMessage({
        ledger: 'example.red.',
        account: 'example.red.alice'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid data').notify(done)
    })

    it('rejects a message when the destination does not begin with the correct prefix', function * () {
      yield assert.isRejected(this.plugin.sendMessage({
        ledger: 'example.red.',
        account: 'red.alice',
        data: {foo: 'bar'}
      }), /^InvalidFieldsError: Destination address "red.alice" must start with ledger prefix "example.red."$/)
    })

    it('throws an InvalidFieldsError on 40003', function (done) {
      this.wsRedLedger.on('message', (rpcMessageString) => {
        const rpcMessage = JSON.parse(rpcMessageString)
        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcMessage.id,
          error: { code: 40003, message: 'fail' }
        }))
      })

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
    })

    it('throws a NoSubscriptionsError on 42200', function (done) {
      this.wsRedLedger.on('message', (rpcMessageString) => {
        const rpcMessage = JSON.parse(rpcMessageString)
        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcMessage.id,
          error: { code: 42200, message: 'fail' }
        }))
      })

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.NoSubscriptionsError, 'fail').notify(done)
    })

    it('throws an NotAcceptedError on 50000', function (done) {
      this.wsRedLedger.on('message', (rpcMessageString) => {
        const rpcMessage = JSON.parse(rpcMessageString)
        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcMessage.id,
          error: { code: 50000, message: 'fail' }
        }))
      })

      this.plugin.sendMessage(this.message)
        .should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
    })

    it('throws an Error when not connected', function (done) {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      plugin.sendMessage(this.message)
        .should.be.rejectedWith(Error, 'Must be connected before sendMessage can be called').notify(done)
    })
  })
})
