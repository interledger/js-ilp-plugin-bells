'use strict'

const UnrelatedNotificationError = require('../errors/unrelated-notification-error')

const isNil = require('lodash/fp/isNil')
const omitNil = require('lodash/fp/omitBy')(isNil)
const find = require('lodash/find')
const debug = require('debug')('ilp-plugin-bells:translate')
const { validateTransfer, validateMessage } = require('./validate')

/**
 * Take a five-bells-ledger notification event object and translate it into a
 * ledger plugin API event object.
 *
 * @param {Object} notification Five Bells Ledger Notification object
 * @param {String} account Account from whose perspective we're operating
 * @param {LedgerContext} ledgerContext Additional context related to the ledger
 *   that emitted the event
 *
 * @return {Array} Parameters for the `emit` method
 */
const translateBellsToPluginApi = (notification, account, ledgerContext) => {
  const event = notification.event
  const data = notification.resource
  if (event === 'transfer.create' || event === 'transfer.update') {
    debug('notify transfer', data.state, data.id)
    return translateTransferNotification(
      data,
      notification.related_resources,
      account,
      ledgerContext
    )
  } else if (event === 'message.send') {
    debug('notify message', data.account)
    return translateMessageNotification(data, account, ledgerContext)
  } else {
    throw new UnrelatedNotificationError('Invalid notification event: ' + event)
  }
}

const translateTransferNotification = (
  fiveBellsTransfer,
  relatedResources,
  account,
  ledgerContext
) => {
  validateTransfer(fiveBellsTransfer)

  let handled = false
  for (let credit of fiveBellsTransfer.credits) {
    if (credit.account === account) {
      handled = true

      // TODO: What if there are multiple debits?
      const debit = fiveBellsTransfer.debits[0]

      const transfer = omitNil({
        id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
        direction: 'incoming',
        account: ledgerContext.prefix + ledgerContext.accountUriToName(debit.account),
        from: ledgerContext.prefix + ledgerContext.accountUriToName(debit.account),
        to: ledgerContext.prefix + ledgerContext.accountUriToName(credit.account),
        ledger: ledgerContext.prefix,
        amount: credit.amount,
        data: credit.memo,
        executionCondition: fiveBellsTransfer.execution_condition,
        cancellationCondition: fiveBellsTransfer.cancellation_condition,
        expiresAt: fiveBellsTransfer.expires_at,
        cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
          ? fiveBellsTransfer.additional_info.cases
          : undefined
      })

      if (fiveBellsTransfer.state === 'prepared') {
        return ['incoming_prepare', transfer]
      }
      if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
        return ['incoming_transfer', transfer]
      }

      if (fiveBellsTransfer.state === 'executed' && relatedResources &&
          relatedResources.execution_condition_fulfillment) {
        return ['incoming_fulfill', transfer,
          relatedResources.execution_condition_fulfillment]
      }

      if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
          relatedResources.cancellation_condition_fulfillment) {
        return ['incoming_cancel', transfer,
          relatedResources.cancellation_condition_fulfillment]
      } else if (fiveBellsTransfer.state === 'rejected') {
        const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
        if (rejectedCredit) {
          return ['incoming_reject', transfer, rejectedCredit.rejection_message]
        } else {
          return ['incoming_cancel', transfer, {
            code: 'R01',
            name: 'Transfer Timed Out',
            message: 'transfer timed out.',
            triggered_by: ledgerContext.prefix + ledgerContext.accountUriToName(account),
            triggered_at: (new Date()).toISOString(),
            additional_info: {}
          }]
        }
      }
    }
  }

  for (let debit of fiveBellsTransfer.debits) {
    if (debit.account === account) {
      handled = true

      // ILP transfers contain one credit and one debit
      // TODO: Perhaps this method should filter out transfers with multiple
      //       credits/debits?
      const credit = fiveBellsTransfer.credits[0]

      const transfer = omitNil({
        id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
        direction: 'outgoing',
        account: ledgerContext.prefix + ledgerContext.accountUriToName(credit.account),
        from: ledgerContext.prefix + ledgerContext.accountUriToName(debit.account),
        to: ledgerContext.prefix + ledgerContext.accountUriToName(credit.account),
        ledger: ledgerContext.prefix,
        amount: debit.amount,
        data: credit.memo,
        noteToSelf: debit.memo,
        executionCondition: fiveBellsTransfer.execution_condition,
        cancellationCondition: fiveBellsTransfer.cancellation_condition,
        expiresAt: fiveBellsTransfer.expires_at,
        cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
          ? fiveBellsTransfer.additional_info.cases
          : undefined
      })

      if (fiveBellsTransfer.state === 'prepared') {
        return ['outgoing_prepare', transfer]
      }
      if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
        return ['outgoing_transfer', transfer]
      }

      if (fiveBellsTransfer.state === 'executed' && relatedResources &&
          relatedResources.execution_condition_fulfillment) {
        return ['outgoing_fulfill', transfer,
          relatedResources.execution_condition_fulfillment]
      }

      if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
          relatedResources.cancellation_condition_fulfillment) {
        return ['outgoing_cancel', transfer,
          relatedResources.cancellation_condition_fulfillment]
      } else if (fiveBellsTransfer.state === 'rejected') {
        const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
        if (rejectedCredit) {
          return ['outgoing_reject', transfer, rejectedCredit.rejection_message]
        } else {
          return ['outgoing_cancel', transfer, {
            code: 'R01',
            name: 'Transfer Timed Out',
            message: 'transfer timed out.',
            triggered_by: ledgerContext.prefix + ledgerContext.accountUriToName(account),
            triggered_at: (new Date()).toISOString(),
            additional_info: {}
          }]
        }
      }
    }
  }
  if (!handled) {
    throw new UnrelatedNotificationError('Notification does not seem related to connector')
  }
}

const translateMessageNotification = (message, account, ledgerContext) => {
  validateMessage(message, ledgerContext)
  return [
    'incoming_message',
    {
      ledger: ledgerContext.prefix,
      account: ledgerContext.prefix + ledgerContext.accountUriToName(message.from),
      from: ledgerContext.prefix + ledgerContext.accountUriToName(message.from),
      to: ledgerContext.prefix + ledgerContext.accountUriToName(message.to),
      data: message.data
    }
  ]
}

Object.assign(module.exports, {
  translateBellsToPluginApi
})
