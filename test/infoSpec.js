'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Info methods', function () {
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

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    nock('http://red.example')
      .get('/accounts/mike')
      .reply(200, {
        ledger: 'http://red.example',
        name: 'mike'
      })

    nock('http://red.example')
      .get('/transfers/1')
      .reply(403)

    nock('http://red.example')
      .get('/auth_token')
      .reply(200, {token: 'abc'})

    const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

    nock('http://red.example')
      .get('/')
      .reply(200, infoRedLedger)

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')

    yield this.plugin.connect()
  })

  afterEach(function * () {
    assert(nock.isDone(), 'nocks should all have been called. Pending mocks are: ' +
      nock.pendingMocks())
    this.wsRedLedger.stop()
  })

  describe('getInfo', function () {
    it('gets the currencyCode and currencyScale', function () {
      const info = {
        prefix: 'example.red.',
        connectors: ['example.red.mark'],
        currencyCode: 'USD',
        currencyScale: 2,
        minBalance: '0'
      }
      assert.deepEqual(this.plugin.getInfo(), info)
    })

    it('throws if not connected', function * () {
      const plugin = new PluginBells({
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      assert.throws(() => {
        plugin.getInfo()
      }, 'Must be connected before getInfo can be called')
    })

    it('includes the plugin\'s prefix', function * () {
      assert.equal(this.plugin.getInfo().prefix, 'example.red.')
    })

    it('cannot connect without any prefix', function * () {
      const plugin = new PluginBells({
        account: 'http://blue.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
      nock('http://blue.example')
        .get('/')
        .reply(200, infoRedLedger)

      nock('http://blue.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://blue.example',
          name: 'mike'
        })

      yield assert.isRejected(plugin.connect(), /Unable to set prefix from ledger or from local config/)
    })

    it('should use local if ledger and local prefix don\'t match', function * () {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://blue.example/accounts/mike',
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
        .get('/transfers/1')
        .reply(403)

      const infoRedLedger = Object.assign(
        cloneDeep(require('./data/infoRedLedger.json')),
        { ilp_prefix: 'example.blue.' }
      )
      nock('http://blue.example')
        .get('/')
        .reply(200, infoRedLedger)

      nock('http://blue.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://blue.example',
          name: 'mike'
        })

      yield plugin.connect()
      assert.equal(plugin.ledgerContext.prefix, 'example.red.')
    })

    it('gets the ledger\'s prefix when available', function * () {
      const plugin = new PluginBells({
        // no prefix
        account: 'http://blue.example/accounts/mike',
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
        .get('/transfers/1')
        .reply(403)

      const infoRedLedger = Object.assign(
        cloneDeep(require('./data/infoRedLedger.json')),
        { ilp_prefix: 'example.blue.' }
      )
      nock('http://blue.example')
        .get('/')
        .reply(200, infoRedLedger)

      nock('http://blue.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://blue.example',
          name: 'mike'
        })

      this.wsRedLedger = wsHelper.makeServer('ws://blue.example/websocket')

      yield plugin.connect()
      assert.equal(plugin.getInfo().prefix, 'example.blue.')
      yield plugin.disconnect()
    })
  })

  describe('getAccount', function () {
    it('returns the plugin\'s account', function * () {
      assert.equal(this.plugin.getAccount(), 'example.red.mike')
    })

    it('fails without any prefix', function () {
      const plugin = new PluginBells({
        // no prefix
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      assert.throws(() => {
        plugin.getAccount()
      }, /Must be connected before getAccount can be called/)
    })
  })

  describe('getBalance', function () {
    it('returns the current balance', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .matchHeader('authorization', 'Bearer abc')
        .reply(200, {balance: '100.01'})
      yield assert.isFulfilled(this.plugin.getBalance(), '10001')
    })

    it('throws an ExternalError on 500', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .matchHeader('authorization', 'Bearer abc')
        .reply(500)
      return assert.isRejected(this.plugin.getBalance(), /Unable to determine current balance/)
    })

    it('fails when not connected', function () {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike'
      })
      return assert.isRejected(plugin.getBalance(), /Must be connected before getBalance can be called/)
    })

    it('it falls back to basic auth if bearer token is not supported', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
        .get('/transfers/1')
        .matchHeader('authorization', 'Bearer invalidToken')
        .reply(401)
        .get('/accounts/mike')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200, {balance: '100.01'})

      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
      nock('http://red.example')
        .get('/')
        .reply(200, infoRedLedger)

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
      yield assert.isFulfilled(plugin.getBalance(), '10001')
    })
  })
})
