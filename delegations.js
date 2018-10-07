const dsteem = require('dsteem')
const client = new dsteem.Client('https://api.steemit.com')
const _ = require('lodash')
const moment = require('moment')
const utils = require('./utils')
const mail = require('./mail')

const config = utils.getConfig()

const MongoClient = require('mongodb').MongoClient

const testRun = false;

let db
let collection
// Database Name
const dbName = config.db_name
const collectionName = 'delegation_transactions'

let properties
let totalVests
let totalSteem

console.log('--- Reward script initialized ---');

var schedule = require('node-schedule')
//console.log('pre-schedule');
var j = schedule.scheduleJob({hour: 08, minute: 00}, function(){
  console.log('--- Start delegators reward ---');
  runRewards(false);//param steemOnlyReward
});



//param steemOnlyReward
runRewards(true);

function runRewards(steemOnlyReward){
	// Use connect method to connect to the server
	MongoClient.connect(config.mongo_uri, async function (err, dbClient) {
	  if (!err) {
		console.log('Connected successfully to server: ' + config.mongo_uri)

		db = dbClient.db(dbName)
		// Get the documents collection
		collection = db.collection(collectionName)
		
		//run for one day
		var days = 1;
		startProcess(days, steemOnlyReward);
		

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
}


async function startProcess (days, steemOnlyReward) {
	let end = 0
	// Find last saved delegation transaction
	let lastTx = await collection.find().sort({'tx_number': -1}).limit(1).next()
	console.log(lastTx)
	if (lastTx) end = lastTx.tx_number
	await updateProperties()
	if (!steemOnlyReward){
	await processDelegations(config.account, -1, end)
	}
	let start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	let txEnd = moment().utc().startOf('date').toDate()
	if (!steemOnlyReward){
		console.log('processTokenRewards');
		await processTokenRewards(start, txEnd, days)
	}
	var d = new Date();
	var dayId = d.getDay();
	// Check if today is Monday, to calculate steem rewards
	if (dayId == 1){
		//console.log('processSteemRewards');
		processSteemRewards(txEnd)
	}
}

async function processTokenRewards (start, end, days) {
	if (!start) start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	if (!end) end = moment().utc().startOf('date').toDate()
	let note = 'Delegation Reward For ' + moment(end).subtract(1, 'days').format('MMMM Do YYYY')

	let acumulatedSteemPower = await getAcumulatedSteemPower(start, end, true);
	
	//handles maintaining max CAP for payments
	let multiplier = 1

	let currentSteemPower = await getCurrentTotalSP(end);
	console.log("currentSteemPower:"+currentSteemPower);
		
	//check if max CAP is reached, and apply multplier accordingly
	if (currentSteemPower > config.weekly_rewards_limit) {
		multiplier = config.weekly_rewards_limit / currentSteemPower;
		console.log(">>>>went beyond rewards limit. Apply multiplier");
	}
	console.log(">>>>multiplier:"+multiplier);
	//go through all delegators, and send out AFIT rewards
	for (let user of acumulatedSteemPower.users) {
		//skip opt out users from reward
		var user_opted_out = false;
		for (var n = 0; n < config.exclude_rewards.length; n++) {
            if (user.user == config.exclude_rewards[n]){
				console.log('User '+user.user+' opted out from rewards');
				user_opted_out = true;
				break;
			}
          } 
		if (user_opted_out){
			continue;
		}
		let reward = {
			user: user.user,
			token_count: parseFloat((user.totalSteem * multiplier).toFixed(3)),
			reward_activity: 'Delegation',
			note: note,
			date: end
		}
		console.log(reward)
		//only send out funds if not a test run
		if (!testRun){
		upsertRewardTransaction(reward)
	}
}
}

async function processSteemRewards (start) {
  if (!start) start = moment().utc().startOf('date').toDate()
  // Get active delegations for the week
  console.log(config.pay_account)
  const to = moment(start).subtract(7, 'days').toDate()
  const from = moment(to).subtract(7, 'days').toDate()
  Promise.all([getAcumulatedSteemPower(from, to, true), getBenefactorRewards(to, start, -1)]).then(values => {
    const activeDelegations = values[0].users
    const steemRewards = values[1]
    const totalDelegatedSteem = values[0].totalSteem
    const rewardPerSteem = steemRewards / totalDelegatedSteem
    const rewards = _.map(activeDelegations, function (o) {
	 //skip opt out users from reward
		var user_opted_out = false;
		for (var n = 0; n < config.exclude_rewards.length; n++) {
            if (o.user == config.exclude_rewards[n]){
				console.log('User '+o.user+' opted out from Steem rewards');
				user_opted_out = true;
				break;
			}
          }
		
		let reward = {};
		if (!user_opted_out){
			reward = {
        user: o.user,
        steem: +(o.totalSteem * rewardPerSteem).toFixed(3)
      }
		}
	
	
     
      /*let url = 'https://v2.steemconnect.com/sign/transfer?from=[PAY_ACCOUNT]&to=[TO_ACCOUNT]&amount=[AMOUNT]%20STEEM&memo=Delegation%20Rewards'
      url = url.replace('[PAY_ACCOUNT]', config.pay_account)
      url = url.replace('[TO_ACCOUNT]', reward.user)
      url = url.replace('[AMOUNT]', reward.steem)
      reward.url = url*/
      return reward
    })
    console.log(rewards)
    console.log("steem total beneficiary reward:"+steemRewards)
    const data = {
      rewards: rewards,
      total: steemRewards,
      totalUsers: rewards.length
    }
	
	var fs = require('fs');
	
	var fileName = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	fileName = "steemrewards"+fileName+".json";
	console.log("fileName:"+fileName);
	fs.writeFile(fileName, JSON.stringify(rewards), function(err) {
		if(err) {
			return console.log(err);
		}

		console.log("The file was saved!");
	}); 
	/*
    const attachment = {
      filename: 'rewards.json',
      content: JSON.stringify(rewards)
    }
    mail.sendWithTemplate('Rewards mail', data, config.report_emails, 'rewards', attachment)*/
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
      await updateActiveDelegations()
    } else {
      console.log('--- No new delegations ---')
		return;
    }
    // If more pending delegations call process againg with new index
    if (start !== limit && !ended){ 
		return processDelegations(account, lastTrans, end)
	}
    // console.log(transactions)
	return;
  } catch (err) {
    console.log(err)
    // Consider exponential backoff if extreme cases start happening
    if (err.type === 'request-timeout' || err.type === 'body-timeout'){ 
		return processDelegations(account, start, end);
	}
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
		//console.log(op[1]);
        let newSp = vestsToSteemPower(op[1].vesting_payout)
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

async function getActiveDelegations (start, excludeOn) {
  start = new Date(start)
  if (excludeOn){
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
  }else{
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
		  { $match: { 'steem_power': { '$gt': 0 } } },
		  { $sort: { tx_date: 1 } }
		]
	  ).toArray()
  }
}

/* 
 * function handles grabbing the total current SP value before a specific date 
 * params: toDate - date before which all current SP is calculated
 * returns: total value of current SP count up to passed date
 */
async function getCurrentTotalSP(toDate){
	toDate = moment(toDate).toDate()
	
	var actDelgCol = 'active_delegations';
	//perform an aggregation based on max date, exluded delegators, and return back sum of SP and delegator count (we only need for now totalSP)
	var results = await db.collection(actDelgCol).aggregate([
		{
			$match: 
			{
				'tx_date': {$lt: toDate},
				'delegator': {$nin: config.exclude_rewards}
			}
		},
		{
		   $group:
			{
			   _id: null,
			   totalSP: { $sum: "$steem_power" },
			   totalDelegators: { $sum: 1 }
			}
		}
		]).toArray();
	//function(err, results) {
			//var output = 'tokens distributed:'+results[0].totalSP;
	console.log(results);
	return results[0].totalSP;
		//});	
}

async function getAcumulatedSteemPower (from, to, excludeOn) {
  let result = {
    users: []
  }
  let totalSteem = 0
  from = moment(from).toDate()
  to = moment(to).toDate()
  // Get active delegations for the week
  let activeDelegations = await getActiveDelegations(from, excludeOn)
  // Get transactions of the processed week
  let weekTxs 
  if (excludeOn){
	console.log('excluding users');
	weekTxs = await db.collection('delegation_transactions').find(
    {'tx_date': {$gt: from, $lt: to},
      'delegator': {$nin: config.exclude_rewards}})
    .sort({tx_date: 1}).toArray()
  }else{
    console.log('no exclude');
	weekTxs = await db.collection('delegation_transactions').find(
		{'tx_date': {$gt: from, $lt: to}})
		.sort({tx_date: 1}).toArray()
  }
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
  await db.collection('active_delegations').insert(activeDelegations)
  console.log('done updating delegations');
  return ;
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
