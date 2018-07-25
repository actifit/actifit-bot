const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.steemit.com')
const _ = require('lodash')
const moment = require('moment')
const utils = require('./utils')
const mail = require('./mail')

const config = utils.getConfig()

const MongoClient = require('mongodb').MongoClient

let db
let collection
// Database Name
const dbName = config.db_name
const collectionName = 'delegation_transactions'

let properties
let totalVests
let totalSteem

// Use connect method to connect to the server
MongoClient.connect(config.mongo_uri, async function (err, dbClient) {
  if (!err) {
    console.log('Connected successfully to server: ' + config.mongo_uri)

    db = dbClient.db(dbName)
    // Get the documents collection
    collection = db.collection(collectionName)
    // startProcess()
    processRewards()
  } else {
    utils.log(err, 'delegations')
    mail.sendPlainMail('Database Error', err, config.report_emails)
      .then(function (res, err) {
        if (!err) {
          console.log(res)
        } else {
          utils.log(err, 'import')
        }
      })
    process.exit()
  }
})

let delegationTransactions = []

async function startProcess () {
  let end = 0
  // Find last saved delegation transaction
  let lastTx = await collection.find().sort({'tx_date': -1}).limit(1).next()
  console.log(lastTx)
  if (lastTx) end = lastTx.tx_number
  // Set STEEM global properties
  properties = await client.database.getDynamicGlobalProperties()
  totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  getDelegations(config.account, -1, end)
}

async function getDelegations (account, start, end) {
  let lastTrans = start
  let ended = false
  let limit = (start < 0) ? 3000 : Math.min(start, 3000)
  console.log('Account: ' + account + ' - Start: ' + start + ' - Limit: ' + limit + ' - Last Txs: ' + end)
  try {
    // Query account history for delegations
    const transactions = await client.database.call('get_account_history', [account, start, limit])
    transactions.reverse()
    for (let txs of transactions) {
      if (txs[0] === end) {
        console.log('--- Found last transaction ---')
        ended = true
        break
      }
      let op = txs[1].op
      lastTrans = txs[0]
      // Look for delegation operations
      if (op[0] === 'delegate_vesting_shares' && op[1].delegatee === account) {
        // Calculate in steem power
        const delegatedVests = Number(op[1].vesting_shares.split(' ')[0])
        const steemPower = totalSteem * (delegatedVests / totalVests)
        let data = op[1]
        data.steem_power = +steemPower.toFixed(3)
        data.tx_number = txs[0]
        data.tx_date = new Date(txs[1].timestamp)
        delegationTransactions.push(data)
      }
    }
    if (start !== limit && !ended) getDelegations(account, lastTrans, end)
    else if (delegationTransactions.length > 0) {
      // Insert new transactions and update active ones
      console.log(delegationTransactions)
      await collection.insert(delegationTransactions)
      updateActiveDelegations()
    } else console.log('--- No new delegations ---')
    // console.log(transactions)
  } catch (err) {
    console.log(err)
    // Consider exponential backoff if extreme cases start happening
    if (err.type === 'request-timeout' || err.type === 'body-timeout') getDelegations(account, start, end)
  }
}

async function updateActiveDelegations () {
  console.log('--- Updating active delegations ---')
  let query = collection.aggregate(
    [
      { $sort: { delegator: 1, tx_date: 1 } },
      {
        $group:
          {
            _id: '$delegator',
            steem_power: { $last: '$steem_power' },
            vests: { $last: '$vesting_shares' },
            tx_date: { $last: '$tx_date' }
          }
      },
      { $match: { 'steem_power': { '$gt': 0 } } }
    ]
  )
  let activeDelegations = await query.toArray()
  await db.collection('active_delegations').drop()
  return db.collection('active_delegations').insert(activeDelegations)
}

async function processRewards () {
  let rewards = []
  let date = new Date()
  let note = 'Delegation Reward Until EOD ' + date
  // Get delegators who did not change their amount on the week
  let fullWeekers = await db.collection('active_delegations').find(
    {'tx_date': {$lte: new Date('2018-07-09')}}).toArray()
  rewards = _.map(fullWeekers, function (o) {
    return {
      user: o._id,
      token_count: +(o.steem_power * 7).toFixed(3),
      reward_activity: 'Delegation',
      note: note
    }
  })

  // console.log(fullWeekers)
  // Get transactions of the processed week
  let weekTxs = await db.collection('delegation_transactions').find(
    {'tx_date': {$gt: new Date('2018-07-09'), $lte: new Date('2018-07-16')}}).sort({tx_date: 1}).toArray()
  
  // console.log(weekTxs)
  let groupedTxs = _.groupBy(weekTxs, 'delegator')
  // console.log(groupedTxs)
  for (let index in groupedTxs) {
    if (groupedTxs[index].length > 1) {
      let totalPower = 0
      let user = index
      console.log('Multi week txs')
      for (let i = 0; i < groupedTxs[index].length; i++) {
        let txs = groupedTxs[index][i]
        console.log(txs)

        let start = moment(txs.tx_date)
        let end
        if (i !== groupedTxs[index].length - 1) end = moment(groupedTxs[index][i + 1].tx_date)
        else end = moment('2018-07-16')
        let activeHours = end.diff(start, 'hours')
        console.log(activeHours)

        let newPower = activeHours * (txs.steem_power / 24)
        totalPower = totalPower + newPower
        console.log(totalPower)
      }
      totalPower = +totalPower.toFixed(3)
      rewards.push({user: user, token_count: totalPower, reward_activity: 'Delegation', date: date, note: note})
    } else {
      let txs = groupedTxs[index][0]
      console.log('Just one weekly txs')
      console.log(txs)
      let start = moment(txs.tx_date)
      let end = moment('2018-07-16')
      let activeHours = end.diff(start, 'hours')
      console.log(activeHours)
      let totalPower = activeHours * (txs.steem_power / 24)
      totalPower = +totalPower.toFixed(3)
      console.log(totalPower)
      rewards.push({user: txs.delegator, token_count: totalPower, reward_activity: 'Delegation', date: date, note: note})
    }
  }
  console.log('--- REWARDS ---')
  rewards = _.orderBy(rewards, ['user', 'token_count'], ['asc', 'desc'])
  console.log(rewards)
}
