'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const sinon = require('sinon')
const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')
const _ = require('lodash')
const ExternalError = require('../src/errors/external-error')
const mockSocket = require('mock-socket')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')
const START_DATE = 1434412800000 // June 16, 2015 00:00:00 GMT

describe('Connection methods', function () {
  beforeEach(function * () {
    this.plugin = new PluginBells({
      prefix: 'example.red.',
      account: 'http://red.example/accounts/mike',
      password: 'mike'
    })

    this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')
    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
  })

  afterEach(function * () {
    yield this.plugin.disconnect()
    this.wsRedLedger.stop()
    assert(nock.isDone(), 'nock should be called')
  })

  describe('connect', function () {
    it('connects', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      yield assert.isFulfilled(this.plugin.connect(), null, 'should be fulfilled with null')
      assert.isTrue(this.plugin.isConnected())
    })

    it('retries if account gives 500', function * () {
      const clock = sinon.useFakeTimers('setTimeout')
      // run the clock extra fast
      const clockInterval = setInterval(() => clock.tick(1000), 1)
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(500)
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      yield assert.isFulfilled(this.plugin.connect(), null, 'should be fulfilled with null')
      assert.isTrue(this.plugin.isConnected())
      clearInterval(clockInterval)
      clock.restore()
    })

    it('retries querying the account forever if the timeout is Infinity, even if gets a 4xx error', function * () {
      const clock = sinon.useFakeTimers('setTimeout')
      // run the clock extra fast
      const clockInterval = setInterval(() => clock.tick(30000), 1)
      nock('http://red.example')
        .get('/accounts/mike')
        // we could run it more times, but you get the idea
        .times(25)
        .reply(404)
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      yield assert.isFulfilled(this.plugin.connect({ timeout: Infinity }), null, 'should be fulfilled with null')
      assert.isTrue(this.plugin.isConnected())
      clearInterval(clockInterval)
      clock.restore()
    })

    it('should reject if sending the subscription request fails', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      this.wsRedLedger.on('connection', () => {
        sinon.stub(this.plugin.ws, 'send')
          .callsArgWith(1, new Error('blah'))
      })

      yield this.plugin.connect().should.be.rejectedWith(Error, /blah/)
    })

    it('times out connection when it does not get the connect message', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      this.wsRedLedger.stop()
      // Unclear why but if this test overwrites this.wsRedLedger
      // it causes other tests to fail
      const wsRedLedger = new mockSocket.Server('ws://red.example/websocket?token=abc')
      yield this.plugin.connect({ timeout: 10 }).should.be.rejectedWith(Error, /timed out before "connect"/)
      wsRedLedger.stop()
    })

    it('times out connection when the notification subscription is never answered', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      this.wsRedLedger.stop()
      // Unclear why but if this test overwrites this.wsRedLedger
      // it causes other tests to fail
      const wsRedLedger = new mockSocket.Server('ws://red.example/websocket?token=abc')
      wsRedLedger.on('connection', () => {
        wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'connect'
        }))
      })
      yield this.plugin.connect({ timeout: 10 }).should.be.rejectedWith(Error, /timed out before "connect"/)
      wsRedLedger.stop()
    })

    it('doesn\'t connect when the "account" is invalid', function (done) {
      const plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'foo',
        password: 'mike'
      })
      plugin.connect().should.be.rejectedWith(Error, 'Invalid account URI').notify(done)
    })

    it('doesn\'t connect when ws server is down', function () {
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      this.wsRedLedger.stop()
      return this.plugin.connect().should.be.rejected
    })

    it('rejects with ExternalError when info returns 500', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(500)
      return this.plugin.connect().should.be.rejectedWith(ExternalError, /Unable to determine ledger metadata/)
    })

    it('ignores if called twice in series', function * () {
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
        .reply(200, this.infoRedLedger)

      yield this.plugin.connect()
      yield this.plugin.connect()
      assert.isTrue(this.plugin.isConnected())
      nockInfo.done()
    })

    it('ignores if called twice simultaneously', function (done) {
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
        .reply(200, this.infoRedLedger)

      Promise.all([
        this.plugin.connect(),
        this.plugin.connect()
      ]).then(() => {
        assert.isTrue(this.plugin.isConnected())
        nockInfo.done()
        done()
      }).catch(done)
    })

    it('handles overlapping connect() calls', function * () {
      const clock = sinon.useFakeTimers(START_DATE)
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .times(2)
        .replyWithError('fail')
      const connect1 = this.plugin.connect({timeout: 1000})
      const connect2 = this.plugin.connect({timeout: 6000})
      clock.tick(1001)
      yield connect1.should.be.rejectedWith(Error, /Unable to connect to account: timeout/)
      // Account has been fetched only once.
      assert(!accountNock.isDone())
      clock.tick(5001)
      yield connect2.should.be.rejectedWith(Error, /Unable to connect to account: timeout/)
      assert(accountNock.isDone())
      clock.restore()
    })

    it('fails if the response is invalid', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, { name: 'mike' })

      return assert.isRejected(this.plugin.connect(), /Failed to fetch account details from/)
    })

    it('should set the username based on the account name returned', function * () {
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      yield this.plugin.connect()
      assert.equal(this.plugin.credentials.username, 'mike')
      accountNock.done()
      infoNock.done()
    })

    describe('Webfinger login', function () {
      beforeEach(function () {
        this.plugin = new PluginBells({
          identifier: 'mike@red.example',
          password: 'mike'
        })

        this.webfinger = {
          subject: 'acct:mike@red.example',
          links: [
            {
              rel: 'https://interledger.org/rel/ledgerAccount',
              href: 'http://red.example/accounts/mike'
            }, {
              rel: 'https://interledger.org/rel/ilpAddress',
              href: 'example.red.mike'
            }
          ]
        }
      })

      it('creates a plugin using a webfinger ID', function * () {
        nock('http://red.example')
          .get('/auth_token')
          .reply(200, {token: 'abc'})
        const accountNock = nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })

        const infoNock = nock('http://red.example')
          .get('/')
          .reply(200, Object.assign(this.infoRedLedger, {ilp_prefix: 'example.red.'}))

        const webfingerNock = nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        yield this.plugin.connect()
        assert.equal(this.plugin.credentials.username, 'mike')

        accountNock.done()
        infoNock.done()
        webfingerNock.done()
      })

      it('won\'t construct a plugin with both identifier and other credentials', function () {
        try {
          const plugin = new PluginBells({
            identifier: 'mike@red.example',
            credentials: {}
          })
          assert(!plugin)
        } catch (e) {
          assert(true)
        }
      })

      it('fails to connect a plugin with invalid webfinger subject', function () {
        this.webfinger.subject = 'trash'

        nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        return assert.isRejected(this.plugin.connect(), /subject \(/)
      })

      it('fails to connect a plugin without webfinger links', function () {
        this.webfinger.links = null

        nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        return assert.isRejected(this.plugin.connect(), /result body doesn't contain links \(/)
      })

      it('fails to connect a plugin without necessary fields', function () {
        this.webfinger.links = []

        nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        return assert.isRejected(this.plugin.connect(), /failed to get essential fields/)
      })
    })

    describe('info', function () {
      it('loads the info from the ledger metadata', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        nock('http://red.example')
          .get('/auth_token')
          .reply(200, {token: 'abc'})
        nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
        yield this.plugin.connect()
        assert.deepEqual(this.plugin.getInfo(), {
          prefix: 'example.red.',
          connectors: ['example.red.mark'],
          currencyCode: 'USD',
          currencyScale: 2,
          minBalance: '0'
        })
      })

      it('throws an ExternalError when info returns 500', function () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        nock('http://red.example')
          .get('/')
          .reply(500)
        return assert.isRejected(this.plugin.connect(), ExternalError, /Unable to determine ledger metadata/)
      })
    })

    it('should set urls from object in ledger metadata and strip unnecessary values', function * () {
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const urls = {
        'health': 'http://random.example/health',
        'transfer': 'http://another.example/endpoint/:id',
        'transfer_fulfillment': 'http://garbage.example/anything/:id/something',
        'transfer_rejection': 'http://abc.example/athing/:id/another',
        'transfer_state': 'http://more.example/:id/state',
        'connectors': 'http://other.example/',
        'accounts': 'http://thing.example/a',
        'account': 'http://red.example/accounts/:name',
        'auth_token': 'http://red.example/auth_token',
        'websocket': 'ws://red.example/websocket',
        'message': 'http://red.example/messages'
      }
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, Object.assign({}, this.infoRedLedger, {urls: urls}))

      yield this.plugin.connect()
      assert.deepEqual(this.plugin.ledgerContext.urls, _.pick(urls, [
        'transfer',
        'transfer_fulfillment',
        'transfer_rejection',
        'account',
        'auth_token',
        'websocket',
        'message'
      ]), 'urls should be set from metadata')
      accountNock.done()
      infoNock.done()
    })

    it('should reject if the ledger metadata does not include a urls map', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, Object.assign({}, this.infoRedLedger, {urls: null}))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include a urls map')
    })

    it('should reject if the ledger metadata does not include transfer url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer: null
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include transfer url')
    })

    it('should reject if the ledger metadata transfer url is not a full http url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer: '/transfers/:id'
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata transfer url must be a full http(s) url')
    })

    it('should reject if the ledger metadata does not include transfer_fulfillment url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer_fulfillment: null
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include transfer_fulfillment url')
    })

    it('should reject if the ledger metadata transfer_fulfillment url is not a full http url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer_fulfillment: '/transfer_fulfillment/:id'
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata transfer_fulfillment url must be a full http(s) url')
    })

    it('should reject if the ledger metadata does not include transfer_rejection url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer_rejection: null
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include transfer_rejection url')
    })

    it('should reject if the ledger metadata transfer_rejection url is not a full http url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            transfer_rejection: '/transfer_fulfillment/:id'
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata transfer_rejection url must be a full http(s) url')
    })

    it('should reject if the ledger metadata does not include account url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            account: null
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include account url')
    })

    it('should reject if the ledger metadata account url is not a full http url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            account: '/accounts/:name'
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata account url must be a full http(s) url')
    })

    it('should reject if the ledger metadata does not include websocket url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: {
            websocket: null
          }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata does not include websocket url')
    })

    it('should reject if the ledger metadata websocket url is not a full ws url', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, _.merge({}, this.infoRedLedger, {
          urls: { websocket: '/websocket' }
        }))

      return assert.isRejected(this.plugin.connect(), ExternalError, 'ledger metadata websocket url must be a full ws(s) url')
    })

    it('should reject if no auth token is retrieved', function * () {
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {})
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      return assert.isRejected(this.plugin.connect(), Error, 'Unable to get auth token from ledger')
    })

    describe('should request a new auth token when one expires', function () {
      beforeEach(function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer def')
          .reply(200, {balance: '100.01'})
        nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
      })

      it('with the default max-age', function * () {
        nock('http://red.example')
          .get('/auth_token')
          .reply(200, {token: 'abc'})
          .get('/auth_token')
          .reply(200, {token: 'def'})
        yield assert.isFulfilled(this.plugin.connect(), null)
        const clock = sinon.useFakeTimers(Date.now())
        clock.tick(7 * 24 * 60 * 60 * 1000)
        yield assert.isFulfilled(this.plugin.getBalance())
        clock.restore()
      })

      it('with a custom max-age', function * () {
        nock('http://red.example')
          .get('/auth_token')
          .reply(200, {token: 'abc', token_max_age: 10})
          .get('/auth_token')
          .reply(200, {token: 'def'})
        yield assert.isFulfilled(this.plugin.connect(), null)
        const clock = sinon.useFakeTimers(Date.now())
        clock.tick(10)
        yield assert.isFulfilled(this.plugin.getBalance())
        clock.restore()
      })
    })

    it('should subscribe to notifications using the websocket websocket url', function * () {
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      let usedCorrectWsUrl = false
      const wsRedLedger = wsHelper.makeServer('ws://somewhererandom.example/notifications/mike?token=abc')
      wsRedLedger.on('connection', () => {
        usedCorrectWsUrl = true
      })

      nock('http://red.example')
        .get('/')
        .reply(200, _.merge(this.infoRedLedger, {
          urls: {
            websocket: 'ws://somewhererandom.example/notifications/mike'
          }
        }))

      yield this.plugin.connect()

      assert.equal(usedCorrectWsUrl, true, 'did not use the ws url from the metadata')

      wsRedLedger.stop()
    })
    it('should not overwrite the username if one is specified in the options', function * () {
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      const plugin = new PluginBells({
        prefix: 'foo.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        username: 'xavier'
      })
      yield plugin.connect()
      assert.equal(plugin.credentials.username, 'xavier')
      accountNock.done()
      infoNock.done()
    })

    it('doesn\'t retry if account is nonexistant', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(404)

      return assert.isRejected(this.plugin.connect(),
        /Unable to connect to account/)
    })

    it('fails if the retries exceed the timeout', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .replyWithError('fail')
      return assert.isRejected(this.plugin.connect({timeout: 110}),
        /Unable to connect to account: timeout/)
    })

    it('fails when options.timeout is invalid', function () {
      assert.throws(() => {
        this.plugin.connect({timeout: 'test'})
      }, 'Expected options.timeout to be a number, received: string')
    })

    describe('websocket reconnection', function () {
      beforeEach(function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mike'
          })
        nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)
        nock('http://red.example')
          .get('/auth_token')
          .reply(200, {token: 'abc'})
      })

      it('reconnects if the socket is closed', function * () {
        assert.equal(this.plugin.isConnected(), false)
        yield this.plugin.connect()
        assert.equal(this.plugin.isConnected(), true)
        this.wsRedLedger.emit('close')
        assert.equal(this.plugin.isConnected(), false)
        yield new Promise((resolve, reject) => {
          // Wait for the plugin to reconnect.
          setTimeout(() => {
            assert.equal(this.plugin.isConnected(), true)
            resolve()
          }, 30)
        })
      })

      it('should reconnect if the websocket connection gets an error', function * () {
        yield this.plugin.connect()
        const spyConnection = sinon.spy()
        this.wsRedLedger.on('connection', spyConnection)
        this.wsRedLedger.emit('error', 'blah')
        yield new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(spyConnection.callCount, 1)
      })

      it('should reconnect if the websocket connection keeps closing', function * () {
        yield this.plugin.connect()
        const realImmediate = setImmediate
        const clock = sinon.useFakeTimers()
        const spyConnection = sinon.spy()
        const spyDisconnect = sinon.spy()
        const spyConnect = sinon.spy()
        this.wsRedLedger.on('connection', spyConnection)
        this.plugin.on('disconnect', spyDisconnect)
        this.plugin.on('connect', spyConnect)
        for (let i = 1; i < 10; i++) {
          this.wsRedLedger.emit('close')
          // it actually uses a fibonacci backoff
          // but it won't be more than 500ms
          clock.tick(500)
          yield new Promise((resolve) => realImmediate(resolve))
          assert.equal(spyConnection.callCount, i, 'server did not get the right number of connections')
          assert.equal(spyDisconnect.callCount, i, 'plugin did not emit disconnect when it was supposed to')
          assert.equal(spyConnect.callCount, i, 'plugin did not emit connect when it was supposed to')
        }
        clock.restore()
      })
    })
  })

  describe('getAccount (not connected)', function () {
    it('throws if not connected', function * () {
      assert.throws(() => {
        this.plugin.getAccount()
      }, /Must be connected before getAccount can be called/)
    })
  })

  describe('disconnect', function () {
    beforeEach(function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      yield this.plugin.connect()
    })

    it('closes the connection', function * () {
      yield assert.isFulfilled(this.plugin.disconnect(), null, 'should be fulfilled with null')
      assert.isFalse(this.plugin.isConnected())
      // A second time does nothing.
      yield assert.isFulfilled(this.plugin.disconnect(), null, 'should be fulfilled with null')
    })
  })
})
