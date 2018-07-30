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
    startProcess()
    // processTokenRewards()
    // processSteemRewards('2018-07-23')
    // let rewards = await getAcumulatedRewards('2018-07-09', '2018-07-16')
    // console.log(rewards)
    // getBenefactorRewards('actifit.pay')
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

async function startProcess () {
  let end = 0
  // Find last saved delegation transaction
  let lastTx = await collection.find().sort({'tx_date': -1}).limit(1).next()
  console.log(lastTx)
  if (lastTx) end = lastTx.tx_number
  await updateProperties()
  processDelegations(config.account, -1, end)
  let start = moment().utc().startOf('date').subtract(7, 'days').toDate()
  let txEnd = moment().utc().startOf('date').toDate()
  processTokenRewards(start, txEnd)
  processSteemRewards(txEnd)
}

async function processTokenRewards (start, end) {
  if (!start) start = moment().utc().startOf('date').subtract(1, 'days').toDate()
  if (!end) end = moment().utc().startOf('date').toDate()
  let note = 'Delegation Reward Until EOD ' + moment(end).subtract(1, 'days').format('MMMM Do YYYY')
  let acumulatedSteemPower = await getAcumulatedSteemPower(start, end)
  console.log(acumulatedSteemPower)
  for (let user of acumulatedSteemPower.users) {
    let reward = {
      user: user.user,
      token_count: user.totalSteem,
      reward_activity: 'Delegation',
      note: note,
      date: end
    }
    console.log(reward)
    upsertRewardTransaction(reward)
  }
}

async function processSteemRewards (start) {
  if (!start) start = moment().utc().startOf('date').toDate()
  // Get active delegations for the week
  console.log(config.pay_account)
  const to = moment(start).subtract(7, 'days').toDate()
  const from = moment(to).subtract(7, 'days').toDate()
  Promise.all([getAcumulatedSteemPower(from, to), getBenefactorRewards(to, start, -1)]).then(values => {
    const activeDelegations = values[0].users
    const steemRewards = values[1]
    const totalDelegatedSteem = values[0].totalSteem
    const rewardPerSteem = steemRewards / totalDelegatedSteem
    const rewards = _.map(activeDelegations, function (o) {
      let reward = {
        user: o.user,
        steem: +(o.totalSteem * rewardPerSteem).toFixed(3)
      }
      let url = 'https://v2.steemconnect.com/sign/transfer?from=[PAY_ACCOUNT]&to=[TO_ACCOUNT]&amount=[AMOUNT]%20STEEM&memo=Delegation%20Rewards'
      url = url.replace('[PAY_ACCOUNT]', config.pay_account)
      url = url.replace('[TO_ACCOUNT]', reward.user)
      url = url.replace('[AMOUNT]', reward.steem)
      reward.url = url
      return reward
    })
    console.log(rewards)
    console.log(steemRewards)
    const data = {
      rewards: rewards,
      total: steemRewards,
      totalUsers: rewards.length
    }
    const attachment = {
      filename: 'rewards.json',
      content: JSON.stringify(rewards)
    }
    mail.sendWithTemplate('Rewards mail', data, config.report_emails, 'rewards', attachment)
  })
}

async function processDelegations (account, start, end) {
  let delegationTransactions = []
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
        const steemPower = vestsToSteemPower(op[1].vesting_shares)
        let data = op[1]
        data.steem_power = +steemPower.toFixed(3)
        data.tx_number = txs[0]
        data.tx_date = new Date(txs[1].timestamp)
        delegationTransactions.push(data)
      }
    }
    // Insert new transactions and update active ones
    // console.log(delegationTransactions)
    if (delegationTransactions.length > 0) {
      await collection.insert(delegationTransactions)
      updateActiveDelegations()
    } else console.log('--- No new delegations ---')
    // If more pending delegations call process againg with new index
    if (start !== limit && !ended) processDelegations(account, lastTrans, end)
    // console.log(transactions)
  } catch (err) {
    console.log(err)
    // Consider exponential backoff if extreme cases start happening
    if (err.type === 'request-timeout' || err.type === 'body-timeout') processDelegations(account, start, end)
  }
}

async function getBenefactorRewards (start, end, txStart, totalSp) {
  if (!totalSp) totalSp = 0
  let limit = (txStart < 0) ? 10000 : Math.min(txStart, 10000)
  start = moment(start).format()
  end = moment(end).format()
  console.log(start)
  console.log(end)
  // Query account history for delegations
  properties = await client.database.getDynamicGlobalProperties()
  totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  const transactions = await client.database.call('get_account_history', [config.pay_account, txStart, limit])
  transactions.reverse()
  for (let txs of transactions) {
    let date = moment(txs[1].timestamp).format()
    if (date >= start && date <= end) {
      let op = txs[1].op
      // Look for delegation operations
      if (op[0] === 'comment_benefactor_reward') {
        let newSp = vestsToSteemPower(op[1].reward)
        totalSp = totalSp + newSp
      }
    } else if (date < start) break
  }
  // Check last tx date to see if pagination is needed
  let lastTx = transactions[transactions.length - 1]
  let lastDate = moment(lastTx[1].timestamp).format()
  // console.log(lastDate)
  if (lastDate >= start) return getBenefactorRewards(start, totalSp, lastTx[0])

  console.log('-- Processed rewards ---')
  // console.log(totalSp.toFixed(3))
  return +totalSp.toFixed(3)
}

async function getActiveDelegations (start) {
  start = new Date(start)
  return collection.aggregate(
    [
      { $match: { 'tx_date': { '$lte': start } } },
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
      { $project:
        {
          _id: '$_id',
          delegator: '$_id',
          steem_power: 1,
          tx_date: start
        }
      },
      { $match: { 'steem_power': { '$gt': 0 }, 'delegator': {$nin: config.exclude_rewards} } },
      { $sort: { tx_date: 1 } }
    ]
  ).toArray()
}

async function getAcumulatedSteemPower (from, to) {
  let result = {
    users: []
  }
  let totalSteem = 0
  from = moment(from).toDate()
  to = moment(to).toDate()
  // Get active delegations for the week
  let activeDelegations = await getActiveDelegations(from)
  // Get transactions of the processed week
  let weekTxs = await db.collection('delegation_transactions').find(
    {'tx_date': {$gt: from, $lt: to},
      'delegator': {$nin: config.exclude_rewards}})
    .sort({tx_date: 1}).toArray()
  let allTxs = activeDelegations.concat(weekTxs)
  let groupedTxs = _.groupBy(allTxs, 'delegator')
  for (let index in groupedTxs) {
    let totalReward = 0
    for (let i = 0; i < groupedTxs[index].length; i++) {
      let txs = groupedTxs[index][i]
      let endTxs
      // If not last transaction calculate up to next one
      if (i !== groupedTxs[index].length - 1) endTxs = new Date(groupedTxs[index][i + 1].tx_date)
      else endTxs = to
      var activeHours = Math.abs(txs.tx_date - endTxs) / 36e5
      let newReward = activeHours * (txs.steem_power / 24)
      totalReward = totalReward + newReward
    }
    totalSteem = totalSteem + totalReward
    let user = {
      user: index,
      totalSteem: totalReward
    }
    result.users.push(user)
  }
  result.totalSteem = totalSteem
  return result
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

function upsertRewardTransaction (reward) {
  return db.collection('token_transactions').update(
    { user: reward.user, date: reward.date, reward_activity: reward.reward_activity },
    reward,
    { upsert: true }
  )
}

function vestsToSteemPower (vests) {
  vests = Number(vests.split(' ')[0])
  const steemPower = (totalSteem * (vests / totalVests))
  return steemPower
}

async function updateProperties () {
  // Set STEEM global properties
  properties = await client.database.getDynamicGlobalProperties()
  totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
}
