'use strict'

const debug = require('debug')('ilp-plugin-bells:ledger-context')
const parseURL = require('url').parse
const errors = require('../errors')
const ExternalError = require('../errors/external-error')
const startsWith = require('lodash/fp/startsWith')

const REQUIRED_LEDGER_URLS = [ 'transfer', 'transfer_fulfillment', 'transfer_rejection', 'account', 'auth_token', 'websocket', 'message' ]
const OPTIONAL_LEDGER_URLS = [ 'transfer_fulfillment2' ]

function parseAndValidateLedgerUrls (metadataUrls) {
  if (!metadataUrls) {
    throw new ExternalError('ledger metadata does not include a urls map')
  }

  const urls = {}
  REQUIRED_LEDGER_URLS.forEach((service) => {
    if (!metadataUrls[service]) {
      throw new ExternalError('ledger metadata does not include ' + service + ' url')
    }

    if (service === 'websocket') {
      if (metadataUrls[service].indexOf('ws') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full ws(s) url')
      }
    } else {
      if (metadataUrls[service].indexOf('http') !== 0) {
        throw new ExternalError('ledger metadata ' + service + ' url must be a full http(s) url')
      }
    }
    urls[service] = metadataUrls[service]
  })
  OPTIONAL_LEDGER_URLS.forEach((service) => {
    if (metadataUrls[service]) {
      urls[service] = metadataUrls[service]
    }
  })

  return urls
}

class LedgerContext {
  constructor (host, ledgerMetadata, overrides) {
    const metadata = Object.assign({}, ledgerMetadata, overrides || {})
    if (overrides) {
      debug('overriding fields from five bells ledger metadata with:', overrides)
    }

    this.host = host
    this.ledgerMetadata = metadata
    this.urls = parseAndValidateLedgerUrls(this.ledgerMetadata.urls)
    debug('using service urls:', this.urls)
    this.prefix = this.ledgerMetadata.ilp_prefix
  }

  getInfo () {
    const ledgerMetadata = this.ledgerMetadata
    return {
      prefix: this.prefix,
      connectors: ledgerMetadata.connectors.map((c) => this.prefix + c.name),
      currencyCode: ledgerMetadata.currency_code,
      minBalance: '0',
      currencyScale: ledgerMetadata.scale // this is the name for it in the fivebells API, for legacy reasons
    }
  }

  /**
   * Get the account name from "http://red.example/accounts/alice" (where
   * accountUriTemplate is "http://red.example/accounts/:name").
   */
  accountUriToName (accountURI) {
    const templatePath = parseURL(this.urls.account).path.split('/')
    const accountPath = parseURL(accountURI).path.split('/')
    for (let i = 0; i < templatePath.length; i++) {
      if (templatePath[i] === ':name') return accountPath[i]
    }
  }

  parseAddress (address) {
    const prefix = this.prefix

    if (!startsWith(prefix, address)) {
      debug('destination address has invalid prefix', { prefix, address })
      throw new errors.InvalidFieldsError('Destination address "' + address + '" must start ' +
        'with ledger prefix "' + prefix + '"')
    }

    const addressParts = address.substr(prefix.length).split('.')
    return {
      ledger: prefix,
      username: addressParts.slice(0, 1).join('.'),
      additionalParts: addressParts.slice(1).join('.')
    }
  }
}

module.exports = LedgerContext
