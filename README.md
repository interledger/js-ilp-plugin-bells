# ilp-plugin-bells [![npm][npm-image]][npm-url] [![circle][circle-image]][circle-url] [![codecov][codecov-image]][codecov-url]

[npm-image]: https://img.shields.io/npm/v/ilp-plugin-bells.svg?style=flat
[npm-url]: https://npmjs.org/package/ilp-plugin-bells
[circle-image]: https://circleci.com/gh/interledger/js-ilp-plugin-bells.svg?style=shield
[circle-url]: https://circleci.com/gh/interledger/js-ilp-plugin-bells
[codecov-image]: https://codecov.io/gh/interledger/js-ilp-plugin-bells/branch/master/graph/badge.svg
[codecov-url]: https://codecov.io/gh/interledger/js-ilp-plugin-bells

> ILP ledger plugin for [five-bells-ledger](https://github.com/interledger/five-bells-ledger)

## Installation

``` sh
npm install --save ilp ilp-plugin-bells
```

## Usage

``` js
const Client = require('ilp').Client

const client = new Client({
  type: 'bells',
  auth: {
    prefix: 'ilpdemo.red.',
    // Account URI
    account: 'https://red.ilpdemo.org/ledger/accounts/alice',
    password: 'alice'
  }
})
```
