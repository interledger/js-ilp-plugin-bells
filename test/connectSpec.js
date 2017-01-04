'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')
const _ = require('lodash')
const ExternalError = require('../src/errors/external-error')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

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

    it('fails if the response is invalid', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, { name: 'mike' })

      return assert.isRejected(this.plugin.connect(), /Error: Failed to resolve ledger URI from account URI/)
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

        return assert.isRejected(this.plugin.connect(), /Error: subject \(/)
      })

      it('fails to connect a plugin without webfinger links', function () {
        this.webfinger.links = null

        nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        return assert.isRejected(this.plugin.connect(), /Error: result body doesn't contain links \(/)
      })

      it('fails to connect a plugin without necessary fields', function () {
        this.webfinger.links = []

        nock('https://red.example')
          .get('/.well-known/webfinger?resource=acct:mike@red.example')
          .reply(200, this.webfinger)

        return assert.isRejected(this.plugin.connect(), /Error: failed to get essential fields/)
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
        'websocket': 'ws://red.example/websocket'
      }
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, Object.assign({}, this.infoRedLedger, {urls: urls}))

      yield this.plugin.connect()
      assert.deepEqual(this.plugin.urls, _.pick(urls, [
        'transfer',
        'transfer_fulfillment',
        'transfer_rejection',
        'account',
        'auth_token',
        'websocket'
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
        /Error: Unable to connect to account/)
    })

    it('fails if the retries exceed the timeout', function () {
      nock('http://red.example')
        .get('/accounts/mike')
        .replyWithError('fail')
      return assert.isRejected(this.plugin.connect({timeout: 1000}),
        /Error: Unable to connect to account: timeout/)
    })

    it('fails when options.timeout is invalid', function () {
      assert.throws(() => {
        this.plugin.connect({timeout: 'test'})
      }, 'Expected options.timeout to be a number, received: string')
    })

    it('reconnects if the socket is closed', function * () {
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

      assert.equal(this.plugin.isConnected(), false)
      yield this.plugin.connect()
      assert.equal(this.plugin.isConnected(), true)
      this.plugin.ws.close()
      assert.equal(this.plugin.isConnected(), false)
      yield new Promise((resolve, reject) => {
        // Wait for the plugin to reconnect.
        setTimeout(() => {
          assert.equal(this.plugin.isConnected(), true)
          resolve()
        }, 150)
      })
    })
  })

  describe('getAccount (not connected)', function () {
    it('throws if not connected', function * () {
      return assert.isRejected(this.plugin.getAccount(), /Error: Must be connected before getAccount can be called/)
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

