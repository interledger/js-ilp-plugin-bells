# ilp-plugin-bells

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

ILP addresses have two parts the ledger and the account. ilp-plugin-bells will ignore everything after the first `.` of the account, so it can be used to represent subledgering.
