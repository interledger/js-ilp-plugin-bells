'use strict'

const co = require('co')
const uniq = require('lodash/uniq')
const Plugin = require('./plugin')
const debug = require('debug')('ilp-plugin-bells:factory')
const UnreachableError = require('../errors/unreachable-error')
const request = require('co-request')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const translateBellsToPluginApi = require('./translate').translateBellsToPluginApi

class PluginFactory extends EventEmitter2 {

  /**
   * @param {object} opts Options for PluginFactory
   * @param {string} opts.adminUsername admin account username
   * @param {string} opts.adminPassword admin account password
   * @param {string} opts.adminAccount admin account endpoint
   * @param {string} opts.prefix optional set ledger prefix
   */
  constructor (opts) {
    super()
    this.adminUsername = opts.adminUsername
    this.adminPassword = opts.adminPassword
    this.adminAccount = opts.adminAccount
    this.configPrefix = opts.prefix
    this.globalSubscription = !!opts.globalSubscription
    this.ledgerContext = null
    this.adminPlugin = null
    this.plugins = new Map()
    this.ready = false
  }

  isConnected () {
    return this.adminPlugin && this.adminPlugin.isConnected()
  }

  connect (options) {
    return co.wrap(this._connect).call(this, options)
  }
  * _connect (options) {
    let subscribedPromise
    if (!this.adminPlugin) {
      // create the central admin instance
      this.adminPlugin = new Plugin({
        username: this.adminUsername,
        password: this.adminPassword,
        account: this.adminAccount,
        prefix: this.configPrefix
      })
      this.adminPlugin.removeAllListeners('_rpc:notification')
      this.adminPlugin.on('_rpc:notification', (notif) =>
        co.wrap(this._routeNotification).call(this, notif))

      this.adminPlugin.on('connect', () => {
        debug('admin plugin connected')
        this._subscribeAccounts()
      })

      // on the first connection, don't resolve until
      // we have subscribed to notifications
      subscribedPromise = new Promise((resolve, reject) => {
        this.once('_subscribed', resolve)
      })
    }

    debug('connecting admin plugin')
    yield this.adminPlugin.connect(options)

    if (subscribedPromise) {
      debug('waiting for notification subscription')
      yield subscribedPromise
    }

    // store the shared context
    this.ledgerContext = this.adminPlugin.ledgerContext

    this.ready = true
  }

  * _routeNotification (notification) {
    let accounts = []

    if (notification.event === 'transfer.create' || notification.event === 'transfer.update') {
      // add credits
      accounts = accounts.concat(notification.resource.credits
        .map((c) => (c.account)))

      // add debits
      accounts = accounts.concat(notification.resource.debits
        .map((c) => (c.account)))
    } else if (notification.event === 'message.send') {
      // add receiver
      accounts.push(notification.resource.to)
    }

    // for every account in the notification, call that plugin's notification
    // handler
    for (let account of uniq(accounts)) {
      // emit event for global listeners
      if (this.globalSubscription) {
        co.wrap(this._handleGlobalNotification).call(this, account, notification)
          .catch(err => {
            debug('error in global event handler for %s: %s', account,
              (err && err.stack) ? err.stack : err)
          })
      }

      const username = this.ledgerContext.accountUriToName(account)
      const plugin = this.plugins.get(username)
      if (!plugin) continue
      debug('sending notification to ' + account)
      co.wrap(plugin._handleNotification).call(plugin, notification)
        .catch(err => {
          debug('error in event handlers for %s: %s', account,
            (err && err.stack) ? err.stack : err)
        })
    }
  }

  disconnect () {
    debug('disconnecting admin plugin')
    return this.adminPlugin.disconnect()
  }

  /*
  * @param {object} opts plugin options
  * @param {string} opts.username username to create a plugin for
  * @param {string} opts.account account URI, can be used in place of username
  */
  create (opts) {
    return co.wrap(this._create).call(this, opts)
  }
  * _create (opts) {
    if (!this.ready) {
      throw new Error('Factory needs to be connected before \'create\'')
    }

    if (opts.account && opts.username) {
      throw new Error('account and username can\'t both be suppplied')
    }

    const username = opts.username || this.ledgerContext.accountUriToName(opts.account)

    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,86}$/.test(username)) {
      throw new Error('Invalid username: ' + username)
    }

    // try to retrieve existing plugin
    const existing = this.plugins.get(username)
    if (existing) {
      debug('tried to create plugin that already exists, returning existing plugin for user: ' + username)
      return existing
    }

    // parse endpoint to get URL
    const account = opts.account || this.ledgerContext
      .urls
      .account
      .replace('/:name', '/' + username)

    // make sure that the account exists
    const exists = yield request(account, {
      auth: {
        bearer: this.adminPlugin.authToken
      }
    })

    if (exists.statusCode !== 200) {
      const msg = 'account ' + account + ' cannot be reached: ' + exists.statusCode + ' ' + JSON.stringify(exists.body)
      debug(msg)
      throw new UnreachableError(msg)
    }

    // otherwise, create a new plugin
    const plugin = new Plugin({
      username: username,
      password: null,
      account: account,
      credentials: {
        // make sure that the plugin uses admin credentials
        username: this.adminUsername,
        password: this.adminPassword,
        account: this.adminAccount
      },
      authToken: this.adminPlugin.authToken
    })

    // 'connects' the plugin without really connecting it
    plugin.ready = true

    // stop plugin from double-connecting
    plugin.disconnect = function () { return Promise.resolve(null) }
    plugin.connect = function () { return Promise.resolve(null) }
    plugin.isConnected = () => this.isConnected()

    plugin.ledgerContext = this.ledgerContext

    this.plugins.set(username, plugin)

    if (!this.glogbalSubscription) {
      yield this._subscribeAccounts()
    }

    debug('created plugin for account: ' + account)
    return plugin
  }

  /*
  * @param {string} username of the plugin being removed
  */
  remove (username) {
    if (!this.plugins.get(username)) return Promise.resolve(null)
    // delete all listeners to stop memory leaks
    this.plugins.get(username).removeAllListeners()
    this.plugins.delete(username)
    if (this.globalSubscription) {
      return Promise.resolve(null)
    } else {
      return this._subscribeAccounts()
    }
  }

  _pluginAccounts () {
    const accounts = []
    const plugins = this.plugins.values()
    for (const plugin of plugins) {
      accounts.push(plugin.account)
    }
    return accounts
  }

  _subscribeAccounts () {
    return Promise.resolve()
      .then(() => {
        if (this.globalSubscription) {
          debug('subscribing to all accounts')
          return this.adminPlugin._subscribeAllAccounts()
        } else {
          const accounts = this._pluginAccounts()
          debug('subscribing to accounts: ' + accounts.join(', '))
          return this.adminPlugin._subscribeAccounts(accounts)
        }
      })
      .then(() => {
        this.emit('_subscribed')
      })
  }

  * _handleGlobalNotification (account, notification) {
    const eventParams = translateBellsToPluginApi(
      notification,
      account,
      this.ledgerContext
    )

    // Inject the account as the first parameter
    const eventType = eventParams[0]
    const eventAdditionalParams = eventParams.slice(1)
    const accountName = this.ledgerContext.accountUriToName(account)
    const eventGlobalParams = [eventType, accountName].concat(eventAdditionalParams)
    yield this.emitAsync.apply(this, eventGlobalParams)
  }
}

module.exports = PluginFactory
