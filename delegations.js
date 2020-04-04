const dsteem = require('dsteem')
//const client = new dsteem.Client('https://steemd.privex.io')
const _ = require('lodash')
const moment = require('moment')
const utils = require('./utils')
const mail = require('./mail')

const config = utils.getConfig()

const client = new dsteem.Client(config.active_node)

const hiveClient = new dsteem.Client(config.active_hive_node)

const MongoClient = require('mongodb').MongoClient

const testRun = false;

let db
let collection
let bulk_delegation_entries
let bulk_hive_delegation_entries

// Database Name
const dbName = config.db_name
const delegationTrxCol = 'delegation_transactions'
const hiveDelegationTrxCol = 'hive_delegation_transactions'

const actDelgCol = 'active_delegations'
const hiveActDelgCol = 'hive_active_delegations'

let properties
let totalVests
let totalSteem

let steemPrice = 1;
let sbdPrice = 1;
let newestTxId = -1;

console.log('--- Reward script initialized ---');

let schedule = require('node-schedule')

if (process.env.BOT_THREAD == 'MAIN'){

	console.log('--- Main Bot Thread Detected ---');

	
	//console.log('pre-schedule');
	var j = schedule.scheduleJob({hour: 08, minute: 00}, function(){
	  console.log('--- Start delegators reward ---');
	  runRewards(false);//param steemOnlyReward
	});

	//utils.lookupAccountPay();

	//param steemOnlyReward
	runRewards(true);
	//runRewards(false);
	
	
}else if (process.env.BOT_THREAD == 'SECOND_API'){
	
	//let's schedule the AFIT to S-E token move event at 10:00 
	let moveJob = schedule.scheduleJob({hour: 10, minute: 00}, function(){
	  console.log('--- Start AFIT to S-E Move ---');
	  moveAFITToSE(false);//param test
	});
}else{
	
	runRewards(true);
}

const SSC = require('sscjs');
const ssc = new SSC(config.steem_engine_rpc);

//airdropAFITX();

//moveAFITToSE(true);

//testMove();

async function testMove(){
	
	
	//perform transaction, decrease sender amount
	let moveTrans = {
		user: 'mcfarhat',
		reward_activity: 'test transaction',
		token_count: -100,
		note: 'User Automated transfer of 100 AFIT to S-E',
		date: new Date(),
	}
	
	console.log(moveTrans);
	//update our DB
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	MongoClient.connect(mongo_conn, async function (err, dbClient) {
	  if (!err) {
		console.log('Connected successfully to server: ')

		db = dbClient.db(dbName)
		let transaction = await db.collection('token_transactions').insert(moveTrans);
	
	console.log('success inserting move AFIT data');
	
	
	let json_data = {
		contractName: 'tokens',
		contractAction: 'transfer',
		contractPayload: {
			symbol: 'AFIT',
			to: 'mcfarhat',
			quantity: '100',//needs to be string
			memo: ''
		}
	}
	
	//broadcast to BC
	console.log('broadcast to BC');
	
	//sign key properly to function with dsteem requirement
	let privateKey = dsteem.PrivateKey.fromString(
		//config.token_dist_pkey
		config.active_key
	);
	let entry = new Object();
	
	entry.user='mcfarhat';
	client.broadcast.json({
		required_auths: [config.account],
		required_posting_auths: [],
		id: 'ssc-mainnet1',
		json: JSON.stringify(json_data),
	}, privateKey).then(
		result => { 
				console.log('success');
				console.log(result); 
				updateUserCount(entry);
			},
		error => { 
			console.log('error') 
			console.error(error) 
			//roll back transaction
				rollBackTrans(moveTrans);
			}
	)
	
	  }
	})

}

async function rollBackTrans(moveTrans){
	console.log('roll back')
	try{
		let transaction = await db.collection('token_transactions').remove(moveTrans);
	}catch(err){
		console.log(err);
	}
}

async function updateUserCount(entry){
	//update user total token count
	console.log('>>> update user token count');
	let user_info = await db.collection('user_tokens').findOne({_id: entry.user});
	let cur_sender_token_count = parseFloat(user_info.tokens);
	let new_token_count = cur_sender_token_count - parseFloat(entry.daily_afit_transfer);
	user_info.tokens = new_token_count;
	console.log('user:' + entry.user + 'new_token_count:'+new_token_count);
	try{
		let trans = await db.collection('user_tokens').save(user_info);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
}

async function moveAFITToSE(testMode){
	console.log('*** process moving AFIT to SE ***');
	
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	MongoClient.connect(mongo_conn, async function (err, dbClient) {
	  if (!err) {
		console.log('Connected successfully to server: ')

		db = dbClient.db(dbName)
		// Get the documents collection
		let poweringDown = await db.collection('powering_down').find().toArray();
		console.log (poweringDown)
		
		//sign key properly to function with dsteem requirement
		let privateKey = dsteem.PrivateKey.fromString(
			//config.token_dist_pkey
			config.active_key
		);
		
		let delay = 0;
		
		//let's fetch banned accounts, to ensure they dont receive an airdrop
		let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
		
		//loop through entries, and send over AFIT
		poweringDown.forEach(async function(entry){
			
			//let's make sure user is not banned
			let user_banned = false;
			for (let n = 0; n < banned_users.length; n++) {
				if (entry.user == banned_users[n].user){
					//console.log('User '+entry.user+' is banned, skipping' );
					user_banned = true;
					break;
				}
			}
			if (!user_banned){
				
				//let's make sure user still has proper AFITX amount
				let userHasProperFunds = true;
				let afitx_se_balance = 0;
				let bal = await ssc.findOne('tokens', 'balances', { account: entry.user, symbol: 'AFITX' });
				if (bal){
					afitx_se_balance = bal.balance;
				}else{
					console.log('error - Unable to fetch AFITX Funds. Try again later.');
					return;
				}
				//make sure user has at least 0.1 AFITX to move tokens
				if (afitx_se_balance < 0.1){
					userHasProperFunds = false;
				}
				  //console.log(amount_to_powerdown);
				  //console.log(this.afitx_se_balance);
				  //calculate amount that can be transferred daily
				if (parseFloat(entry.daily_afit_transfer) / 100 > afitx_se_balance){
					userHasProperFunds = false;
				}
				
				//make sure user has enough funds to send to SE
				
				let user = await db.collection('user_tokens').findOne({_id: entry.user});
				console.log(user);
				//fixing token amount display for 3 digits
				if (typeof user!= "undefined" && user!=null){
					if (typeof user.tokens!= "undefined"){
						user.tokens = user.tokens.toFixed(3)
					}else{
						userHasProperFunds = false;
					}
				}else{
					userHasProperFunds = false;
				}
				let cur_user_token_count = 0;
				try{
					cur_user_token_count = parseFloat(user.tokens);
					if (cur_user_token_count < entry.daily_afit_transfer){
						userHasProperFunds = false;
					}
				}catch(err){
					userHasProperFunds = false;
				}
				
				console.log('entry.user:'+entry.user+ ' afit bal:' + cur_user_token_count + ' bal:'+afitx_se_balance+' userHasProperFunds:'+userHasProperFunds);
				if (userHasProperFunds){
					setTimeout(async function(){
										
						try{
							
							/*setTimeout(async function(){
								
								
							}, 1);*/
						
							console.log(entry);
											
							let amount = parseFloat(entry.daily_afit_transfer);
							
							//perform transaction, decrease sender amount
							let moveTrans = {
								user: entry.user,
								reward_activity: 'Move AFIT to S-E',
								token_count: -amount,
								note: 'User Automated transfer of ' + entry.daily_afit_transfer + ' AFIT to S-E',
								date: new Date(),
							}
							
							console.log(moveTrans);
							//update our DB
							if (!testMode){
								let transaction = await db.collection('token_transactions').insert(moveTrans);
							}
							console.log('success inserting move AFIT data');
							
							let json_data = {
								contractName: 'tokens',
								contractAction: 'transfer',
								contractPayload: {
									symbol: 'AFIT',
									to: entry.user,
									quantity: ''+entry.daily_afit_transfer,//needs to be string
									memo: ''
								}
							}
							
							//broadcast to BC
							console.log('broadcast to BC');
							if (!testMode){
								client.broadcast.json({
									required_auths: [config.account],
									required_posting_auths: [],
									id: 'ssc-mainnet1',
									json: JSON.stringify(json_data),
								}, privateKey).then(
									result => { 
										console.log(result) 
										//update user total count
										updateUserCount(entry);
										},
									error => { 
										console.error(error) 
										//roll back db transaction as there was issue sending to blockchain
										rollBackTrans(moveTrans);
										}
								)
							}
						
						}catch(err){
							console.log(err);
							console.log('error - Error inserting move AFIT data. DB storing issue');
							return;
						}
					
					}, delay+=4500);
				}else{
					console.log('error - user does not have enough funds');
					return;
				}
			}else{
				console.log('user ' + entry.user + ' is banned. Skip');
			}
		});
	  } else {
		utils.log(err, 'delegations')
		process.exit()
	  }
	})
}

/*
//OUR AFITX AIRDROP FUNCTION
async function airdropAFITX(){
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	MongoClient.connect(mongo_conn, async function (err, dbClient) {
		if (!err) {
			
			console.log('Connected successfully to server: ')
			db = dbClient.db(dbName)
			
			//let's fetch all users with proper AFIT count
			let tokenHolders = await db.collection('user_tokens').find( { tokens: { $gte: 100 } }).toArray();//sort({tokens: -1}).
			
			//let's also fetch banned accounts, to ensure they dont receive an airdrop
			let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
			
			let delay = 0;
			
			let totalAFITXSpent = 0;
			let totalUsersRewarded = 0;
			
			//sign key properly to function with dsteem requirement
			let privateKey = dsteem.PrivateKey.fromString(
				//config.token_dist_pkey
				config.active_key
			);
			
			tokenHolders.forEach(function(entry){
				//check if user is banned
				//check if user is banned
				let user_banned = false;
				for (let n = 0; n < banned_users.length; n++) {
					if (entry.user == banned_users[n].user){
						//console.log('User '+entry.user+' is banned, skipping' );
						user_banned = true;
						break;
					}
				}
				if (!user_banned){
				
					setTimeout(function(){
						console.log(entry);
						let rewardAFITX = 0;
						let userAFIT = parseFloat(entry.tokens);
						if (userAFIT >= 10000){
							rewardAFITX = 10;
						}else if (userAFIT >= 100){
							rewardAFITX = (userAFIT/1000).toFixed(3);
						}
						let json_data = {
							contractName: 'tokens',
							contractAction: 'transfer',
							contractPayload: {
								symbol: 'AFITX',
								to: entry.user,
								quantity: '' + rewardAFITX,//needs to be string
								memo: ''
							}
						}
						console.log(json_data);
						totalAFITXSpent += parseFloat(rewardAFITX);
						totalUsersRewarded += 1;
						client.broadcast.json({
							//required_auths: [config.token_dist_account],
							required_auths: [config.account],
							required_posting_auths: [],
							id: 'ssc-mainnet1',
							json: JSON.stringify(json_data),
						}, privateKey).then(
							result => { console.log(result) },
							error => { console.error(error) }
						)
						//console.log('total airdrop:'+totalAFITXSpent);
						//console.log('total recipients:'+totalUsersRewarded);
					
					}, delay+=3300);
				}
			});
			
			
		}else {
		  utils.log(err, 'delegations')
		  process.exit()
	    }
	});
}

*/

function runRewards(steemOnlyReward){
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	MongoClient.connect(mongo_conn, async function (err, dbClient) {
	  if (!err) {
		console.log('Connected successfully to server: ')

		db = dbClient.db(dbName)
		// Get the documents collection
		collection = db.collection(delegationTrxCol)
		
		/**** copy a collection to another *****/
		/*let documentsToMove = db.collection(delegationTrxCol).find({});
		documentsToMove.forEach(function(doc) {
			console.log('inserting');
			db.collection(hiveDelegationTrxCol).insert(doc);
		});
		console.log('done');
		
		return;*/
		
		bulk_delegation_entries = db.collection(delegationTrxCol).initializeUnorderedBulkOp();
		bulk_hive_delegation_entries = db.collection(hiveDelegationTrxCol).initializeUnorderedBulkOp();
		
		//updateUserTokens();
		//return;
		
		//run for one day
		var delegation_days = 1;
		startProcess(delegation_days, steemOnlyReward);

		//grab steem prices and proceed checking for beneficiary payouts to AFIT token reward account (full_pay_benef_account)
		setInterval(loadSteemPrices,5 * 60 * 1000);
		
		//claim rewards once per hour
		setInterval(claimRewards,60 * 60 * 1000);
	  
	    //loadSteemPrices();
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

//function to grab latest payouts for beneficiaries and reward with AFIT tokens
async function getBenefactorPosts (account, start) {

  //connect to the token_transactions table to start transactions to users
  var bulk_transactions = db.collection('token_transactions').initializeUnorderedBulkOp();

  let totalSBD = 0
  let totalSp = 0
  let limit = 2000;
  let txStart = -1;
  
  start = moment(start).format()

  console.log('start date:'+start)
  
  //grab current AFIT price in USD
  let curAFITPrice = await db.collection('afit_price').find().sort({'date': -1}).limit(1).next()
  console.log('curAfitPrice:'+curAFITPrice.unit_price_usd);
  
  // Query account history for delegations
  properties = await client.database.getDynamicGlobalProperties()
  totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  //console.log(properties);
  const transactions = await client.database.call('get_account_history', [account, txStart, limit])
  transactions.reverse()
  let foundTx = false;
  console.log("newestTxId:"+newestTxId);
  let counter = 0;
  for (let txs of transactions) {
	if (counter == 0){
		counter += 1;
		//if this is not our first run, start from where we left
		if (newestTxId==txs[0]){
			//no new transactions, bail
			console.log('we already went through last transaction');
			break;
		}else{
			newestTxId = txs[0];
			console.log('set newestTxId:'+newestTxId);
		}
	}
    let date = moment(txs[1].timestamp).format()
	
    if (date >= start) {
	  //console.log(txs[0]);
      let op = txs[1].op
      // Look for beneficiary payments
      if (op[0] === 'comment_benefactor_reward') {
		foundTx = true;
		console.log('---------------------------------------');
		//console.log(op);
		let matchingAFIT = 0;
		//console.log(op[1]);
        let rewardedSP = parseFloat(vestsToSteemPower(op[1].vesting_payout).toFixed(3)) 
		console.log("rewardedSP:"+rewardedSP);
		//calculate dollar value
		let steemInUSD = rewardedSP * steemPrice;
		console.log("steemInUSD:"+steemInUSD);
		
		//convert to AFIT and add to total
		matchingAFIT = steemInUSD / curAFITPrice.unit_price_usd;
		console.log("matchingAFIT:"+matchingAFIT);
		
		let rewardedSTEEM = parseFloat(op[1].steem_payout.split(' ')[0])
		
		console.log("rewardedSTEEM:"+rewardedSTEEM);
		let steemPureInUSD = rewardedSTEEM * steemPrice;
		
		let steemPureToAFIT = steemPureInUSD / curAFITPrice.unit_price_usd;
		matchingAFIT += steemPureToAFIT;
		
		let rewardedSBD = parseFloat(op[1].sbd_payout.split(' ')[0])
		
		console.log("rewardedSBD:"+rewardedSBD);
		
		//calculate dollar value
		let sbdInUSD = rewardedSBD * sbdPrice;
		console.log("sbdInUSD:"+sbdInUSD);
		
		//convert to AFIT and add to total
		let sbdToAFIT = sbdInUSD / curAFITPrice.unit_price_usd;
		matchingAFIT += sbdToAFIT;
		
		//format to 3 decimals
		matchingAFIT = parseFloat(matchingAFIT.toFixed(3));
		
		console.log("sbdToAFIT:"+sbdToAFIT);
		
		console.log("Total AFIT:"+matchingAFIT);
		
		let beneficSwapTansaction = {
			user: op[1].author,
			reward_activity: 'Full AFIT Payout',
			url: op[1].permlink,
			token_count: matchingAFIT,
			orig_sbd_amount: rewardedSBD,
			orig_sp_amount: rewardedSP,
			orig_steem_amount: rewardedSTEEM,
			date: new Date(date)
		}
		
		//store this as a transaction
		bulk_transactions.find(
		{ 
			user: beneficSwapTansaction.user,
			reward_activity: beneficSwapTansaction.reward_activity,
			url: beneficSwapTansaction.url
		}).upsert().replaceOne(beneficSwapTansaction);

      }
    } else if (date < start){ 
		break
	}
  }
  //award transaction tokens
  if (foundTx){
	bulk_transactions.execute();
	console.log('-- Processed Full AFIT Payouts --')
	//once done, update user total token count
	updateUserTokens();
  }else{
	console.log('-- No Posts to process --');
  }
  
}

//function to load relevant STEEM and SBD prices, and proceed with AFIT token swap/reward process
function loadSteemPrices() {

  console.log('-- start AFIT token swap process --')

  // Require the "request" library for making HTTP requests
  var request = require("request");

  // Load the price feed data
  request.get('https://api.coinmarketcap.com/v1/ticker/steem/', function (e, r, data) {
    try {
      steemPrice = parseFloat(JSON.parse(data)[0].price_usd);

      console.log("Loaded STEEM price: " + steemPrice);
	  
	  // Load the price feed data
	  request.get('https://api.coinmarketcap.com/v1/ticker/steem-dollars/', function (e, r, data) {
		try {
			sbdPrice = parseFloat(JSON.parse(data)[0].price_usd);

			console.log("Loaded SBD price: " + sbdPrice);
		  	
			let afit_swap_days = 1;
			let start = moment().utc().startOf('date').toDate()
			let to = moment(start).subtract(afit_swap_days, 'days').toDate()
		  
			//bring the action
			getBenefactorPosts(config.full_pay_benef_account, to);
			
		} catch (err) {
		  console.log('Error loading SBD price: ' + err);
		}
	  });
  
    } catch (err) {
      console.log('Error loading STEEM price: ' + err);
    }
  });
}


async function startProcess (days, steemOnlyReward) {
	let end = 0
	// Find last saved delegation transaction
	//let lastTx = await collection.find().sort({'tx_number': -1}).limit(1).next()
	console.log('last recorded delegation transaction');
	//console.log(lastTx)
	//if (lastTx) end = lastTx.tx_number
	await updateProperties()
	if (!testRun){
		//update Steem delegations
		console.log('>>>>>>>>>>STEEM<<<<<<<<<<<<');
		await processDelegations(client, bulk_delegation_entries, delegationTrxCol, actDelgCol, config.account, -1, end)
		
		//update hive delegations
		console.log('>>>>>>>>>>HIVE<<<<<<<<<<<<');
		await processDelegations(hiveClient, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, config.account, -1, end)
	}
	//TEMP BREAK
	//return;
	
	
	let start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	let txEnd = moment().utc().startOf('date').toDate()
	if (!steemOnlyReward){
		console.log('processTokenRewards');
		//steem based rewards
		await processTokenRewards('STEEM', client, bulk_delegation_entries, delegationTrxCol, actDelgCol, start, txEnd, days)
		
		//hive based rewards
		await processTokenRewards('HIVE', hiveClient, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, start, txEnd, days)
		//update our user token count post reward
		if (!testRun){
			updateUserTokens();
		}
	}
	var d = new Date();
	var dayId = d.getDay();
	// Check if today is Monday, to calculate steem rewards
	if (dayId == 1){
		//console.log('processSteemRewards');
		//processTokenRewards (chain, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, days) {
		let resSt = await processSteemRewards('STEEM', client, bulk_delegation_entries, delegationTrxCol, actDelgCol, txEnd)
		//console.log('>>>>>STEEM REWARDS COMPLETE');
		let resHv = await processSteemRewards('HIVE', hiveClient, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, txEnd)
		//console.log('>>>>>HIVE REWARDS COMPLETE');
	}
}

async function processTokenRewards (chain, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, days) {
	if (!start) start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	if (!end) end = moment().utc().startOf('date').toDate()
	let note = 'Delegation Reward On ' + chain + ' For ' + moment(end).subtract(1, 'days').format('MMMM Do YYYY')

	let acumulatedSteemPower = await getAcumulatedSteemPower(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, config.exclude_enabled);
	
	//console.log(acumulatedSteemPower.users);
	
	//handles maintaining max CAP for payments
	let multiplier = 1

	let currentSteemPower = await getCurrentTotalSP(activeDelColLink, end);
	console.log("currentSteemPower:"+currentSteemPower);
		
	//check if max CAP is reached, and apply multplier accordingly
	if (currentSteemPower > config.weekly_rewards_limit) {
		multiplier = config.weekly_rewards_limit / currentSteemPower;
		console.log(">>>>went beyond rewards limit. Apply multiplier");
	}
	console.log(">>>>multiplier:"+multiplier);
	
	//load list of alt accounts to reward them instead of actual delegators
	let altAccounts = await db.collection('delegation_alt_beneficiaries').find().toArray();
	//console.log(altAccounts);
	
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
		
		let reward_user = user.user;
		let reward_activity = 'Delegation';
		
		//check if this user has an alt account with delegated rewards enabled
		let delegator_entry = _.find(altAccounts, {'delegator': user.user, 'reward_benefit': '1'});
		
		//if so reward the alt account instead
		if (delegator_entry != null) {
			reward_user = delegator_entry.alt_account;
			reward_activity += ' On Behalf'; 
		}
	
		let reward = {
			user: reward_user,
			chain: chain,
			token_count: parseFloat((user.totalSteem * multiplier).toFixed(3)),
			reward_activity: reward_activity,
			orig_account: user.user,
			note: note,
			date: end
		}
		//console.log(reward)
		//only send out funds if not a test run
		if (!testRun){
			upsertRewardTransaction(reward)
		}
	}
}

async function processSteemRewards (chain, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start) {
  if (!start) start = moment().utc().startOf('date').toDate()
  // Get active delegations for the week
  console.log(config.pay_account)
  const to = moment(start).subtract(7, 'days').toDate()
  const from = moment(to).subtract(7, 'days').toDate()
  
  //load list of alt accounts to reward them instead of actual delegators
  let altAccounts = await db.collection('delegation_alt_beneficiaries').find().toArray();
  console.log('loading alt accounts');
  //console.log(altAccounts);
  
  Promise.all(
		[
			getAcumulatedSteemPower(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, from, to, config.exclude_enabled), //(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, config.exclude_enabled);
			getBenefactorRewards(to, start, -1)
		]
	).then(values => {
    const activeDelegations = values[0].users
	//console.log('***');
	//console.log(values[1]);
    const steemRewards = values[1].split(' ')[0]
	const sbdRewards = values[1].split(' ')[1]
    const totalDelegatedSteem = values[0].totalSteem
    const rewardPerSteem = steemRewards / totalDelegatedSteem
	const rewardPerSBD = sbdRewards / totalDelegatedSteem
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
		
		
		let reward_user = o.user;
		
		//check if this user has an alt account with delegated rewards enabled
		let delegator_entry = _.find(altAccounts, {'delegator': o.user, 'steem_reward_benefit': '1'});
		
		//if so reward the alt account instead
		if (delegator_entry != null) {
			reward_user = delegator_entry.alt_account;
		}
		
		let reward = {};
		if (!user_opted_out){
			reward = {
				user: reward_user,
				steem: +(o.totalSteem * rewardPerSteem).toFixed(3),
				sbd: +(o.totalSteem * rewardPerSBD).toFixed(3)
			  }
		}
	
	
     
      /*let url = 'https://v2.steemconnect.com/sign/transfer?from=[PAY_ACCOUNT]&to=[TO_ACCOUNT]&amount=[AMOUNT]%20STEEM&memo=Delegation%20Rewards'
      url = url.replace('[PAY_ACCOUNT]', config.pay_account)
      url = url.replace('[TO_ACCOUNT]', reward.user)
      url = url.replace('[AMOUNT]', reward.steem)
      reward.url = url*/
      return reward
    })
    //console.log(rewards)
    console.log("steem total beneficiary reward:"+steemRewards)
	console.log("SBD total beneficiary reward:"+sbdRewards)
    const data = {
      rewards: rewards,
      totalSteem: steemRewards,
	  totalSBD: sbdRewards,
      totalUsers: rewards.length
    }
	
	var fs = require('fs');
	
	var fileName = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	fileName = chain+"rewards"+fileName+".json";
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




function vestsToSteemPower (vests) {
  vests = Number(vests.split(' ')[0])
  const steemPower = (totalSteem * (vests / totalVests))
  return steemPower
}


async function processDelegations (nodeLink, dbDelegLink, delTrxCol, activeDelColLink, account, start, end) {
  let delegationTransactions = []
  let lastTrans = start
  let ended = false
  let limit = (start < 0) ? 3000 : Math.min(start, 3000)
  console.log('Account: ' + account + ' - Start: ' + start + ' - Limit: ' + limit + ' - Last Txs: ' + end)
  try {
    // Query account history for delegations
    const transactions = await nodeLink.database.call('get_account_history', [account, start, limit])
    transactions.reverse()
    for (let txs of transactions) {
	  //let's only fetch a max of 5 days ago delegation transactions
	  let tx_date = moment(txs[1].timestamp).format()
	  
	  //today
	  let start = moment().utc().startOf('date').toDate()
	  
	  let to = moment(start).subtract(6, 'days').toDate()
	  let end = moment(to).format()
	  
      if (txs[0] === end || tx_date < end) {
        console.log('--- Found last transaction ---')
        ended = true
        break
      }
      let op = txs[1].op
      lastTrans = txs[0]
      // Look for delegation operations
      if (op[0] === 'delegate_vesting_shares' && op[1].delegatee === account) {
		//console.log(txs);
        // Calculate in steem power
        const steemPower = vestsToSteemPower(op[1].vesting_shares)
        let data = op[1]
        data.steem_power = +steemPower.toFixed(3)
        data.tx_number = txs[0]
        data.tx_date = new Date(txs[1].timestamp)
        delegationTransactions.push(data)
		
		dbDelegLink.find(
		{ 
			delegator: data.delegator,
			vesting_shares: data.vesting_shares,
		}).upsert().replaceOne(data);
      }
    }
    // Insert new transactions and update active ones
    if (delegationTransactions.length > 0) {
      try{
		await dbDelegLink.execute();
	  }catch(bulkerr){
		utils.log(bulkerr);
	  }
	  //update relevant delegations collection
      await updateActiveDelegations(delTrxCol, activeDelColLink)
	  
    } else {
      console.log('--- No new delegations ---')
		return;
    }
    // If more pending delegations call process againg with new index
    if (start !== limit && !ended){ 
		return processDelegations(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, account, lastTrans, end)
	}
    // console.log(transactions)
	return;
  } catch (err) {
    console.log(err)
    // Consider exponential backoff if extreme cases start happening
    if (err.type === 'request-timeout' || err.type === 'body-timeout'){ 
		return processDelegations(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, account, start, end);
	}
  }
}

async function getBenefactorRewards (start, end, txStart, totalSp, totalSBD) {
  if (!totalSBD) totalSBD = 0
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
		//SP is the sum of conversting vesting payout to SP, and appending any STEEM payouts
        let newSp = vestsToSteemPower(op[1].vesting_payout) + parseFloat(op[1].steem_payout.split(' ')[0])
        totalSp = totalSp + newSp
		let newSBD = op[1].sbd_payout.split(' ')[0]
		totalSBD += parseFloat(newSBD)
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
  return +totalSp.toFixed(3)+' ' +totalSBD.toFixed(3)
}

async function getActiveDelegations (delTrxCol, start, excludeOn) {
  start = new Date(start)
  if (excludeOn){
	  return db.collection(delTrxCol).aggregate(
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
	  return db.collection(delTrxCol).aggregate(
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
async function getCurrentTotalSP(actDelgCol, toDate){
	toDate = moment(toDate).toDate()
	
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
	//console.log(results);
	return results[0].totalSP;
		//});	
}

async function getAcumulatedSteemPower (nodeLink, dbDelegLink, delTrxCol, activeDelColLink, from, to, excludeOn) {
  let result = {
    users: []
  }
  let totalSteem = 0
  from = moment(from).toDate()
  to = moment(to).toDate()
  //console.log('get Acc Power');
  //console.log(activeDelColLink);
  // Get active delegations for the week
  let activeDelegations = await getActiveDelegations(delTrxCol, from, excludeOn)
  //console.log(activeDelegations);
  // Get transactions of the processed week
  let weekTxs 
  if (excludeOn){
	console.log('excluding users');
	weekTxs = await db.collection(delTrxCol).find(
		{'tx_date': {$gt: from, $lt: to},
		  'delegator': {$nin: config.exclude_rewards}})
		.sort({tx_date: 1}).toArray()
  }else{
    console.log('no exclude');
	weekTxs = await db.collection(delTrxCol).find(
		{'tx_date': {$gt: from, $lt: to}})
		.sort({tx_date: 1}).toArray()
  }
  //console.log(weekTxs);
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

async function updateActiveDelegations (delgTrxCol, targetCol) {
  console.log('--- Updating active delegations ---')
  let query = db.collection(delgTrxCol).aggregate(
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
  await db.collection(targetCol).drop()
  await db.collection(targetCol).insert(activeDelegations)
  console.log('done updating delegations '+targetCol);
  return ;
}

function upsertRewardTransaction (reward) {
  return db.collection('token_transactions').update(
    { user: reward.user, chain: reward.chain, date: reward.date, reward_activity: reward.reward_activity, orig_account: reward.orig_account },
    reward,
    { upsert: true }
  )
}


async function updateProperties () {
  // Set STEEM global properties
  properties = await client.database.getDynamicGlobalProperties()
  totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
}

//function handles updating current user token count
async function updateUserTokens() {
	console.log('---- Updating User Tokens ----');

	try{
		//group all token transactions per user, and sum them to generate new total count
		let query = await db.collection('token_transactions').aggregate([
			{ $group: { _id: "$user", tokens: { $sum: "$token_count" } } },
			{ $sort: { tokens: -1 } },
			{ $project: { 
				 _id: "$_id",
				 user: "$_id",
				 tokens: "$tokens",
				 }
			 }
			])
	
		let user_tokens = await query.toArray();
		//remove old token count per user
		await db.collection('user_tokens').remove({});
		//insert new count per user
		await db.collection('user_tokens').insert(user_tokens);
		console.log('---- Updating User Tokens Complete ----');
	}catch(err){
		console.log('>>save data error:'+err.message);
	}
}
//function handles fetching account details for later use when claiming rewards
async function grabAccountDetails(){
	console.log('grabbing fund account details');
	let account = await client.database.call('get_accounts', [[config.full_pay_benef_account]]);
	console.log(account);
	return account[0];
}
//function handles claiming pending account rewards
async function claimRewards(){
	//sign key properly to function with dsteem requirement
	let privateKey = dsteem.PrivateKey.fromString(
        config.full_pay_posting_key
    );
	//fetch account details first to use correct values for claim
	let funds_account = await grabAccountDetails();
	console.log(funds_account.reward_steem_balance);
	console.log(funds_account.reward_sbd_balance);
	console.log(funds_account.reward_vesting_balance);
	//if we have any value to claim, proceed
	if (parseFloat(funds_account.reward_steem_balance) > 0 || parseFloat(funds_account.reward_sbd_balance) > 0 || parseFloat(funds_account.reward_vesting_balance) > 0) {
		const op = [
			'claim_reward_balance',
			{
				account: config.full_pay_benef_account,
				reward_steem: funds_account.reward_steem_balance.split(' ')[0] + ' STEEM',
				reward_sbd: funds_account.reward_sbd_balance.split(' ')[0] + ' SBD',
				reward_vests: funds_account.reward_vesting_balance.split(' ')[0] + ' VESTS',
			},
		];
		client.broadcast.sendOperations([op], privateKey).then(
			function(result) {
				console.log(result);
			},
			function(error) {
				console.log(error);
			}
		)
	}else{
		console.log('no rewards to claim for now');
	}
}