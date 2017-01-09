'use strict'

const co = require('co')
const Plugin = require('./plugin')
const debug = require('debug')('ilp-plugin-bells:factory')
const UnreachableError = require('../errors/unreachable-error')
const request = require('co-request')
const pathToRegexp = require('path-to-regexp')

class PluginFactory {

  /**
   * @param {object} opts Options for PluginFactory
   * @param {string} opts.adminUsername admin account username
   * @param {string} opts.adminPassword admin account password
   * @param {string} opts.adminAccount admin account endpoint
   * @param {string} opts.prefix optional set ledger prefix
   */
  constructor (opts) {
    this.adminUsername = opts.adminUsername
    this.adminPassword = opts.adminPassword
    this.adminAccount = opts.adminAccount
    this.accountRegex = null
    this.metadata = {}
    this.metadata.prefix = opts.prefix
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
    if (this.adminPlugin) return yield this.adminPlugin.connect(options)

    // create the central admin instance
    this.adminPlugin = new Plugin({
      username: this.adminUsername,
      password: this.adminPassword,
      account: this.adminAccount,
      prefix: this.metadata.prefix
    })
    this.adminPlugin.removeAllListeners('_rpc:notification')
    this.adminPlugin.on('_rpc:notification', (notif) =>
      co.wrap(this._routeNotification).call(this, notif))

    debug('connecting admin plugin')
    yield this.adminPlugin.connect(options)

    // get the shared metadata
    debug('retrieving ledger metadata')
    this.metadata.prefix = yield this.adminPlugin.getPrefix()
    this.metadata.info = yield this.adminPlugin.getInfo()
    this.metadata.urls = this.adminPlugin.urls
    this.metadata.host = this.adminPlugin.host

    // generate account endpoints
    this.accountRegex = pathToRegexp(this.metadata.urls.account, [{
      name: 'name',
      prefix: '/'
    }])
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

      // add the sender
      accounts.push(notification.resource.from)
    }

    // for every account in the notification, call that plugin's notification
    // handler
    for (let account of accounts) {
      const plugin = this.plugins.get(this.accountRegex.exec(account)[1])
      if (!plugin) continue
      debug('sending notification to ' + account)
      co.wrap(plugin._handleNotification).call(plugin, notification)
    }
  }

  disconnect () {
    debug('disconnecting admin plugin')
    return this.adminPlugin.disconnect()
  }

  /*
  * @param {object} opts plugin options
  * @param {string} opts.username username to create a plugin for
  */
  create (opts) {
    return co.wrap(this._create).call(this, opts)
  }
  * _create (opts) {
    if (!this.ready) {
      throw new Error('Factory needs to be connected before \'create\'')
    }

    if (typeof opts.username !== 'string' || !/^[A-Za-z0-9._-~]+$/.test(opts.username)) {
      throw new Error('Invalid opts.username')
    }

    // try to retrieve existing plugin
    const existing = this.plugins.get(opts.username)
    if (existing) return existing

    // parse endpoint to get URL
    const account = this.metadata
      .urls
      .account
      .replace('/:name', '/' + opts.username)

    // make sure that the account exists
    const exists = yield request(account, {
      headers: {
        Authorization: this.adminUsername + ':' + this.adminPassword
      }
    })

    if (exists.statusCode !== 200) {
      const msg = 'account ' + account + ' cannot be reached: ' + exists.statusCode
      debug(msg)
      throw new UnreachableError(msg)
    }

    // otherwise, create a new plugin
    const plugin = new Plugin({
      username: opts.username,
      password: null,
      account: account,
      credentials: {
        // make sure that the plugin uses admin credentials
        username: this.adminUsername,
        password: this.adminPassword,
        account: this.adminAccount
      }
    })

    // 'connects' the plugin without really connecting it
    plugin.ready = true

    // stop plugin from double-connecting
    plugin.disconnect = function () { return Promise.resolve(null) }
    plugin.connect = function () { return Promise.resolve(null) }
    plugin.isConnected = () => this.isConnected()

    plugin.ws = this.adminPlugin.ws // ensure sendMessage works
    plugin.urls = this.metadata.urls
    plugin.info = this.metadata.info
    plugin.prefix = this.metadata.prefix
    plugin.host = this.metadata.host

    this.plugins.set(opts.username, plugin)
    yield this.adminPlugin._subscribeAccounts(this._pluginAccounts())

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
    return Promise.resolve(null)
  }

  _pluginAccounts () {
    const accounts = []
    const plugins = this.plugins.values()
    for (const plugin of plugins) {
      accounts.push(plugin.account)
    }
    return accounts
  }
}

module.exports = PluginFactory
