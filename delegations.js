const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.steemit.com')
const utils = require('./utils')

var config = utils.getConfig()

let delegationTransactions = []
getDelegations(config.account, -1)

async function getDelegations (account, start) {
  let lastTrans = start
  let limit = (start < 0) ? 3000 : Math.min(start, 3000)
  console.log('Account: ' + account + ' - Start: ' + start + ' - Limit: ' + limit)
  try {
    const transactions = await client.database.call('get_account_history', [account, start, limit])
    transactions.reverse()
    for (let txs of transactions) {
      let op = txs[1].op
      lastTrans = txs[0]
      // console.log(txs)
      if (op[0] === 'delegate_vesting_shares' && op[1].delegatee === account) {
        console.log(op)
        delegationTransactions.push({ id: txs[0], data: op[1], timestamp: txs[1].timestamp })
      }
    }
    if (start !== 0) getDelegations(account, lastTrans)
    else console.log(delegationTransactions)
    // console.log(transactions)
  } catch (err) {
    console.log(err)
    if (err.type === 'request-timeout') getDelegations(account, start)
  }
}
