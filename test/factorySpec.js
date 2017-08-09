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

mock('ws', wsHelper.WebSocket)
const PluginBellsFactory = require('..').Factory

describe('PluginBellsFactory', function () {
  describe('without global subscription', function () {
    beforeEach(function * () {
      this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')
      this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      nock('http://red.example')
        .get('/accounts/admin')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'admin'
        })

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      nock('http://red.example')
        .get('/')
        .reply(200, infoRedLedger)

      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      nock('http://red.example')
        .get('/transfers/1')
        .reply(403)

      this.transfer = {
        current: {
          id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          direction: 'incoming',
          to: 'example.red.alice',
          amount: '1234', // ledger units, so that's 12.34 USD
          expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
        }
      }
      this.transfer.legacy = Object.assign({}, this.transfer.current)
      delete this.transfer.legacy.to
      this.transfer.legacy.account = this.transfer.current.to

      this.fiveBellsTransferAlice = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/mike',
          amount: '12.34',
          authorized: true
        }],
        credits: [{
          account: 'http://red.example/accounts/alice',
          amount: '12.34'
        }],
        expires_at: this.transfer.current.expiresAt
      }

      this.fiveBellsTransferMike = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/alice',
          amount: '12.34'
        }],
        credits: [{
          account: 'http://red.example/accounts/mike',
          amount: '12.34'
        }],
        state: 'executed'
      }

      this.fiveBellsMessage = cloneDeep(require('./data/message.json'))
      this.message = {
        ledger: 'example.red.',
        to: 'example.red.alice',
        ilp: Buffer.from('hello').toString('base64'),
        custom: {foo: 'bar'}
      }

      this.factory = new PluginBellsFactory({
        adminUsername: 'admin',
        adminPassword: 'admin',
        adminAccount: 'http://red.example/accounts/admin',
        prefix: 'example.red.'
      })
    })

    afterEach(function * () {
      this.wsRedLedger.stop()
      assert(nock.isDone(), 'all nocks should be called')
    })

    describe('connect', function () {
      it('will not connect twice', function * () {
        yield this.factory.connect()
        yield this.factory.connect()
        assert.isTrue(this.factory.isConnected())
      })
    })

    describe('disconnect', function () {
      it('disconnects', function * () {
        yield this.factory.connect()
        yield this.factory.disconnect()
        assert.isFalse(this.factory.isConnected())
      })
    })

    describe('getAccountAs', function () {
      beforeEach(function * () {
        yield this.factory.connect()
      })

      it('should return the correct account for the given username', function () {
        assert.equal(this.factory.getAccountAs('bob'), 'example.red.bob')
      })
    })

    describe('create', function () {
      beforeEach(function * () {
        yield this.factory.connect()
      })

      it('will not create a nonexistant account', function * () {
        const nockBob = nock('http://red.example')
          .get('/accounts/bob')
          .matchHeader('authorization', 'Bearer abc')
          .reply(404, {})

        try {
          yield this.factory.create({ username: 'bob' })
          assert(false, 'factory create should have failed')
        } catch (e) {
          nockBob.done()
          assert.isTrue(true)
        }
      })

      it('will create a plugin', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        const plugin = yield this.factory.create({ username: 'mike' })
        assert.isObject(plugin)
        assert.isTrue(plugin.isConnected())
      })

      it('will not create more than one plugin per account', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        const plugin1 = yield this.factory.create({ username: 'mike' })
        const plugin2 = yield this.factory.create({ username: 'mike' })
        assert.equal(plugin1, plugin2, 'only one plugin should be made per account')
      })

      it('will create a plugin with account', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        const plugin = yield this.factory.create({ account: 'http://red.example/accounts/mike' })
        assert.isObject(plugin)
        assert.isTrue(plugin.isConnected())
        assert.equal(plugin.username, 'mike', 'account should resolve to same username')
      })

      it('will allow a username with underscores and dashes', function * () {
        const username = 'mike_12-34'
        nock('http://red.example')
          .get('/accounts/' + username)
          .matchHeader('authorization', 'Bearer abc')
          .reply(200)

        const plugin = yield this.factory.create({ account: 'http://red.example/accounts/' + username })
        assert.isObject(plugin)
        assert.isTrue(plugin.isConnected())
        assert.equal(plugin.username, username, 'account should resolve to same username')
      })

      it('throws an error when account and username are both supplied', function (done) {
        this.factory.create({
          username: 'mike',
          account: 'http://red.example/accounts/mike'
        }).catch((err) => {
          assert.equal(err.message, 'account and username can\'t both be suppplied')
          done()
        }).catch(done)
      })

      it('passes the admin plugin prefix to the plugin', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        const plugin = yield this.factory.create({ account: 'http://red.example/accounts/mike' })
        assert.equal(plugin.getInfo().prefix, 'example.red.', 'should set prefix')
      })

      it('subscribes to the new account', function * () {
        nock('http://red.example')
          .get('/accounts/mary')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })
        const subscribeMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'subscribe_account',
          params: {
            eventType: '*',
            accounts: ['http://red.example/accounts/mary']
          }
        })
        const subscribeSpy = sinon.spy()
        subscribeSpy.withArgs(subscribeMessage)
        this.wsRedLedger.on('message', subscribeSpy)

        yield this.factory.create({ username: 'mary' })
        assert(subscribeSpy.withArgs(subscribeMessage).calledOnce, 'must subscribe')
      })

      it('resolves when it has gotten the subscription response', function * () {
        nock('http://red.example')
          .get('/accounts/mary')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mary'
          })
        const subscribeMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'subscribe_account',
          params: {
            eventType: '*',
            accounts: ['http://red.example/accounts/mary']
          }
        })

        const subscribePromise = new Promise((resolve, reject) => {
          this.wsRedLedger.on('message', (rpcMessageString) => {
            if (rpcMessageString === subscribeMessage) {
              resolve('subscribe')
            }
          })
        })
        const createPromise = this.factory.create({ username: 'mary' }).then(() => 'create')
        const firstExecuted = yield Promise.race([subscribePromise, createPromise])
        assert.equal(firstExecuted, 'subscribe', 'must subscribe first')
      })

      it('will throw if given an invalid opts.username', function (done) {
        this.factory.create({ username: 'foo!' }).catch((err) => {
          assert.equal(err.message, 'Invalid username: foo!')
          done()
        })
      })

      it('works for ledgers that contain a port in the URL', function * () {
        this.wsRedLedger = wsHelper.makeServer('ws://red.example:3000/websocket?token=abc')
        this.infoRedLedger = JSON.parse(JSON.stringify(this.infoRedLedger).replace(/red\.example/g, 'red.example:3000'))

        nock('http://red.example:3000')
          .get('/accounts/admin')
          .reply(200, {
            ledger: 'http://red.example:3000',
            name: 'admin'
          })
          .get('/transfers/1')
          .reply(403)
          .get('/')
          .reply(200, this.infoRedLedger)
          .get('/auth_token')
          .reply(200, {token: 'abc'})
          .get('/accounts/bob')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example:3000',
            name: 'bob'
          })

        this.factory = new PluginBellsFactory({
          adminUsername: 'admin',
          adminPassword: 'admin',
          adminAccount: 'http://red.example:3000/accounts/admin',
          prefix: 'example.red.'
        })

        yield this.factory.connect()
        const plugin = yield this.factory.create({ account: 'http://red.example:3000/accounts/bob' })
        assert.equal(plugin.username, 'bob')
      })
    })

    describe('notification passing', function () {
      beforeEach(function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        yield this.factory.connect()
        this.plugin = yield this.factory.create({ username: 'mike' })
      })

      it('will pass a notification to the correct plugin', function * () {
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_transfer', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'transfer.update',
            resource: this.fiveBellsTransferMike,
            related_resources: {}
          }
        }))

        yield handled
      })

      it('will pass a notification to the correct plugin when transfer.debit.account=credit.account', function * () {
        let messages = 0
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_transfer', () => {
            messages++
            resolve()
          })
        })

        this.fiveBellsTransferMike.debits[0].account = 'http://red.example/accounts/mike'
        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'transfer.update',
            resource: this.fiveBellsTransferMike,
            related_resources: {}
          }
        }))

        yield handled
        assert.equal(messages, 1)
      })

      it('will pass a message to the correct plugin', function * () {
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_message', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'message.send',
            resource: {
              id: '6a13abf0-2333-4d1e-9afc-5bf32c6dc0dd',
              ledger: 'http://red.example',
              to: 'http://red.example/accounts/mike',
              from: 'http://red.example/accounts/alice',
              custom: {}
            },
            related_resources: {}
          }
        }))

        yield handled
      })

      it('will pass a message to the correct plugin when message.from=to', function * () {
        let messages = 0
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_message', () => {
            messages++
            resolve()
          })
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'message.send',
            resource: {
              id: '6a13abf0-2333-4d1e-9afc-5bf32c6dc0dd',
              ledger: 'http://red.example',
              to: 'http://red.example/accounts/mike',
              from: 'http://red.example/accounts/mike',
              custom: {}
            },
            related_resources: {}
          }
        }))

        yield handled
        assert.equal(messages, 1)
      })

      it('send a message as the correct username', function * () {
        nock('http://red.example')
          .post('/messages', {
            from: 'http://red.example/accounts/mike',
            to: 'http://red.example/accounts/alice',
            ledger: 'http://red.example',
            data: { custom: { foo: 'bar' } }
          })
          .matchHeader('authorization', 'Bearer abc')
          .reply(200)

        setTimeout(() => {
          this.plugin.emit('incoming_message', {}, '123')
        }, 10)

        yield this.plugin.sendRequest({
          id: '123',
          ledger: 'example.red.',
          to: 'example.red.alice',
          custom: { foo: 'bar' }
        })
      })

      const formats = ['legacy', 'current']
      formats.map(format => {
        it(`sends a ${format}-format transfer with the correct fields`, function * () {
          nock('http://red.example')
            .put('/transfers/' + this.transfer[format].id, this.fiveBellsTransferAlice)
            .matchHeader('authorization', 'Bearer abc')
            .reply(200)

          yield this.plugin.sendTransfer(this.transfer[format])
        })
      })
    })

    describe('websocket reconnection', function () {
      it('should reconnect if the websocket connection drops', function * () {
        yield this.factory.connect()

        const connectionSpy = sinon.spy()
        this.wsRedLedger.on('connection', connectionSpy)
        this.wsRedLedger.emit('close')
        yield new Promise((resolve) => setImmediate(resolve))
        assert.isFalse(this.factory.isConnected())
        yield new Promise((resolve) => setTimeout(resolve, 20))
        assert(connectionSpy.callCount === 1, 'plugin should reconnect')
        yield new Promise((resolve) => setImmediate(resolve))
        assert.isTrue(this.factory.isConnected(), 'plugin should say it is connected')
      })

      it('should resubscribe to the accounts of each plugin if the websocket connection drops', function * () {
        yield this.factory.connect()

        const subscribeMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'subscribe_account',
          params: {
            eventType: '*',
            accounts: [
              'http://red.example/accounts/mary',
              'http://red.example/accounts/bob'
            ]
          }
        })

        nock('http://red.example')
          .get('/accounts/mary')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'mary'
          })
          .get('/accounts/bob')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'bob'
          })

        const connectionSpy = sinon.spy()
        connectionSpy.withArgs(subscribeMessage)

        this.wsRedLedger.on('message', connectionSpy)
        yield this.factory.create({ username: 'mary' })
        yield this.factory.create({ username: 'bob' })

        this.wsRedLedger.emit('close')
        yield new Promise((resolve) => setImmediate(resolve))
        assert(connectionSpy.withArgs(subscribeMessage).calledOnce, 'factory should resubscribe to all accounts')
      })
    })

    describe('remove', function () {
      beforeEach(function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        yield this.factory.connect()
        this.plugin = yield this.factory.create({ username: 'mike' })
      })

      it('removes a plugin', function * () {
        yield this.factory.remove('mike')
        assert.isNotOk(this.factory.plugins.get('mike'))
      })

      it('resubscribes without the removed account', function * () {
        const subscribePromise = new Promise((resolve, reject) => {
          this.wsRedLedger.on('message', (rpcString) => {
            const rpcMessage = JSON.parse(rpcString)
            if (rpcMessage.method === 'subscribe_account' && rpcMessage.params.accounts.length === 0) {
              resolve()
            }
          })
        })
        yield this.factory.remove('mike')
        yield subscribePromise
      })
    })
  })

  describe('with global subscription', function () {
    beforeEach(function * () {
      this.wsRedLedger = wsHelper.makeServer('ws://red.example/websocket?token=abc')
      this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      nock('http://red.example')
        .get('/accounts/admin')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'admin'
        })

      nock('http://red.example')
        .get('/transfers/1')
        .reply(403)

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      nock('http://red.example')
        .get('/')
        .reply(200, infoRedLedger)

      nock('http://red.example')
        .get('/auth_token')
        .reply(200, {token: 'abc'})

      this.transfer = {
        current: {
          id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          direction: 'incoming',
          to: 'example.red.alice',
          amount: '12.34',
          expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
        }
      }
      this.transfer.legacy = Object.assign({}, this.transfer.current)
      delete this.transfer.legacy.to
      this.transfer.legacy.account = this.transfer.current.to

      this.fiveBellsTransferAlice = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/mike',
          amount: '10',
          authorized: true
        }],
        credits: [{
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }],
        expires_at: this.transfer.current.expiresAt
      }

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
        state: 'executed'
      }

      this.fiveBellsMessage = cloneDeep(require('./data/message.json'))
      this.message = {
        ledger: 'example.red.',
        to: 'example.red.alice',
        ilp: Buffer.from('hello').toString('base64'),
        custom: {foo: 'bar'}
      }

      this.factory = new PluginBellsFactory({
        adminUsername: 'admin',
        adminPassword: 'admin',
        adminAccount: 'http://red.example/accounts/admin',
        prefix: 'example.red.',
        globalSubscription: true
      })
    })

    afterEach(function * () {
      this.wsRedLedger.stop()
      assert(nock.isDone(), 'all nocks should be called')
    })

    describe('connect', function () {
      it('should subscribe to all accounts', function * () {
        const subscribedPromise = new Promise((resolve, reject) => {
          this.wsRedLedger.on('message', (message) => {
            const parsed = JSON.parse(message)
            if (parsed.method === 'subscribe_all_accounts' && parsed.params.eventType === '*') {
              resolve()
            }
          })
        })

        yield this.factory.connect()
        yield subscribedPromise
      })

      it('should resolve only after subscribing to the accounts', function * () {
        const connectPromise = this.factory.connect().then(() => 'connect')
        const subscribedPromise = new Promise((resolve, reject) => {
          this.wsRedLedger.on('message', (message) => {
            const parsed = JSON.parse(message)
            if (parsed.method === 'subscribe_all_accounts' && parsed.params.eventType === '*') {
              resolve()
            }
          })
        }).then(() => 'subscribe')
        const firstExecuted = yield Promise.race([connectPromise, subscribedPromise])
        assert.equal(firstExecuted, 'subscribe', 'must subscribe first')
      })

      it.skip('should time out if the subscription response takes too long')
    })

    describe('notification passing', function () {
      beforeEach(function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .matchHeader('authorization', 'Bearer abc')
          .reply(200, {
            ledger: 'http://red.example',
            name: 'admin'
          })

        yield this.factory.connect()
        this.plugin = yield this.factory.create({ username: 'mike' })
        assert.isOk(this.factory.plugins.get('mike'))
      })

      it('will pass a notification to the correct plugin', function * () {
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_transfer', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'transfer.update',
            resource: this.fiveBellsTransferMike,
            related_resources: {}
          }
        }))

        yield this.factory.connect()
        yield handled
      })

      it('will emit global notifications for a transfer', function * () {
        yield this.factory.connect()
        const handledIncoming = new Promise((resolve, reject) => {
          this.factory.on('incoming_transfer', resolve)
        })
        const handledOutgoing = new Promise((resolve, reject) => {
          this.factory.on('outgoing_transfer', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'transfer.update',
            resource: this.fiveBellsTransferMike,
            related_resources: {}
          }
        }))

        yield handledIncoming
        yield handledOutgoing
      })

      it('will pass a message to the correct plugin', function * () {
        yield this.factory.connect()
        const handled = new Promise((resolve, reject) => {
          this.plugin.on('incoming_message', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'message.send',
            resource: {
              id: '6a13abf0-2333-4d1e-9afc-5bf32c6dc0dd',
              ledger: 'http://red.example',
              to: 'http://red.example/accounts/mike',
              from: 'http://red.example/accounts/alice',
              custom: {}
            },
            related_resources: {}
          }
        }))

        yield handled
      })

      it('will emit global notifications for a message', function * () {
        const handled = new Promise((resolve, reject) => {
          this.factory.on('incoming_message', resolve)
        })

        this.wsRedLedger.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'notify',
          params: {
            event: 'message.send',
            resource: {
              id: '6a13abf0-2333-4d1e-9afc-5bf32c6dc0dd',
              ledger: 'http://red.example',
              to: 'http://red.example/accounts/mike',
              from: 'http://red.example/accounts/alice',
              custom: {}
            },
            related_resources: {}
          }
        }))

        yield handled
      })
    })

    describe('websocket reconnection', function () {
      it('will resubscribe to all accounts if the websocket connection drops', function * () {
        yield this.factory.connect()
        this.wsRedLedger.emit('close')
        yield new Promise(setImmediate)

        const subscribedPromise = new Promise((resolve, reject) => {
          this.wsRedLedger.on('message', (message) => {
            const parsed = JSON.parse(message)
            if (parsed.method === 'subscribe_all_accounts' && parsed.params.eventType === '*') {
              resolve()
            }
          })
        })

        yield subscribedPromise
      })
    })
  })
})
