const dhive = require('@hiveio/dhive')
const _ = require('lodash')
const moment = require('moment')
const utils = require('./utils')
const afitBalance = require('./afit_balance')
const afitTransfers = require('./afit_transfers')
const mail = require('./mail')

const config = utils.getConfig()

const hiveClient = new dhive.Client(config.active_hive_node)

hiveClient.updateOperations(true);

const MongoClient = require('mongodb').MongoClient

const testRun = false;

const hive = require('@hiveio/hive-js');
const axios = require('axios');

const hive_history_limit = 1000;

//prepare BSC work
const { Web3 } = require('web3');

let fs = require('fs');
let jsonFile = "./AFIT_abi.json";

let parsed= JSON.parse(fs.readFileSync(jsonFile));
let tokenAbi = parsed;

const web3 = new Web3(config.bscProvider);

// The bridge wallet key is loaded only when the bridge actually sends, so the
// process can run (for delegator rewards) without that key in memory, or in config.
let bridgeWalletLoaded = false;
function loadBridgeWallet() {
	if (bridgeWalletLoaded) return;
	web3.eth.accounts.wallet.add({
		privateKey: config.bridgeWallet,
		address: config.bridgeWalletAdd
	});
	bridgeWalletLoaded = true;
}

// Get BEP20 Token contract instance
let contract = new web3.eth.Contract(tokenAbi, config.afitAddress);

hive.config.set('alternative_api_endpoints', config.alt_hive_nodes);

hive.api.setOptions({ url: config.active_hive_node });

let db
// One Mongo connection for the reward runs, reused from day to day. Declared up here:
// a non-MAIN run calls runRewards() while this file is still loading.
let rewardsClient = null;
let collection
let bulk_hive_delegation_entries

// Database Name
const dbName = config.db_name
const hiveDelegationTrxCol = 'hive_delegation_transactions'

const hiveActDelgCol = 'hive_active_delegations'

let properties
let totalVests
let totalSteem

let steemPrice = 1;
let sbdPrice = 1;
let newestTxId = -1;

console.log('--- Delegations script initialized ---');
console.log('envt variables:');
console.log(process.env.BOT_THREAD);

let schedule = require('node-schedule')

// Each scheduled job has its own switch. true = paused. Change one and redeploy.
// The BSC bridge and gadget prize transfers move value off Actifit and stay paused until
// each one has its own fixes. The AFIT move to Hive-Engine is back on (re-enabled after
// security review; see processAfitMoves).
// A job name that is not listed here counts as paused.
// Skipped under the test runner so tests still exercise the functions.
const JOB_PAUSED = {
	delegatorRewards: false,
	afitMove: false,
	gadgetPrize: true,
	bscBridge: true,
};
function payoutsPaused(job) {
	if (process.env.NODE_ENV === 'test') return false;
	if (JOB_PAUSED[job] !== false) {
		console.log('--- ' + job + ' skipped: paused ---');
		return true;
	}
	return false;
}

/*
if (process.env.BOT_THREAD == 'MAIN'){

	console.log('--- Main Bot Thread Detected ---');

	
	//console.log('pre-schedule');
	var j = schedule.scheduleJob({hour: 08, minute: 00}, function(){
	  console.log('--- Start delegators reward ---');
	  runRewards(false);//param steemOnlyReward
	});

	//utils.lookupAccountPay();

	//param steemOnlyReward
	//runRewards(true);
	//runRewards(false);
	
	
}else */
// Auto-run the scheduler / reward pipeline everywhere EXCEPT under test, where we
// only want to require() the module and exercise its exported functions.
//
// Do NOT use `require.main === module` here: pm2's fork mode does not run the script
// directly, it require()s it from its own wrapper (ProcessContainerFork), so
// require.main is pm2's wrapper and the check is always false. That silently skipped
// the entire bootstrap - no schedulers, no timers - so the event loop emptied, the
// process exited, and pm2 crash-looped it (taking the box down with it).
// Jest sets NODE_ENV=test automatically; production/pm2 does not.
// DELEGATIONS_NO_BOOT=1 lets a one-off script (scripts/backfill_delegation_rewards.js)
// require this module without starting the schedulers or a reward run.
if (process.env.DELEGATIONS_NO_BOOT === '1') console.log('--- DELEGATIONS_NO_BOOT=1: schedulers not started ---');
if (process.env.NODE_ENV !== 'test' && process.env.DELEGATIONS_NO_BOOT !== '1') {
if (process.env.BOT_THREAD == 'MAIN'){

	console.log('>>>>>>>>>MAIN DELEGATION THREAD<<<<<<<<<<<')
	
	var j = schedule.scheduleJob({hour: 8, minute: 0}, function(){
	  console.log('--- Start delegators reward ---');
	  runRewards(false, true);//param steemOnlyReward, updateDelegations
	});
	
	//let's schedule the AFIT to S-E token move event at 10:00 
	// UTC, like the per-day claim in processAfitMoves
	let moveJob = schedule.scheduleJob({hour: 10, minute: 0, tz: 'Etc/UTC'}, function(){
	  console.log('--- Start AFIT to S-E Move ---');
	  moveAFITToSE(false);//param test
	});
	
	// finish any AFIT move left in flight by a previous process
	if (!payoutsPaused('afitMove')){
		connectRewardsDb().then(() => recoverAfitMoveAttempts()).catch((err) => console.log('AFIT move recovery at start failed: ' + (err && err.message)));
	}

	//schedule the prize event at 00:00 every X days
	let prizeJob = schedule.scheduleJob({hour: 0, minute: 1}, function(){
	  console.log('--- Reward Gadget Buy Contest ---');
	  processGadgetBuyPrize();//param test
	});
	
	
	//run the airdrop once
	/*const date = new Date(2021, 9, 26, 9, 00, 00);
	//const date = new Date(2021, 9, 25, 16, 12, 00);
	let airdropJob = schedule.scheduleJob(date, function(){
	  console.log('--- Airdrop AFIT to community ---');
	  processAfitAirdropHive();//param test
	});
	*/
	
	//schedule recurring checks for BSC bridge transfer execution
	const rule = new schedule.RecurrenceRule();
	//rule.minute = 
	let runMinTimes = [];
	for (let i=1; i< 20; i++){
		runMinTimes.push(i*3);
	}
	rule.minute = runMinTimes;
	//rule.second = runMinTimes;
	let bscTransferJob = schedule.scheduleJob(rule, function(){
	  console.log('--- BSC transfer ---');
	  processBSCTransfers();
	  //processGadgetBuyPrize();//param test
	});
	
}else{
	//processGadgetBuyPrize();
	//updateUserTokens();
	//return;
	runRewards(false, false);
	//runRewards(false, false);
	//moveAFITToSE(true);
	/*let val = utils.rewardCap('HIVE');
	console.log(val);
	val = utils.rewardCap('STEEM');
	console.log(val);*/
	//testFetchHistory();
	//processBSCTransfers();


}
} // end require.main bootstrap guard
/*
async function testFetchHistory(){
	let from = -1
	let limit = 100;
	let histTrans = await steem.api.getAccountHistoryAsync(config.account, from, limit);
	//[account, txStart, limit]
	console.log(histTrans);
}*/

async function processBSCTransfers(){
	if (payoutsPaused('bscBridge')) return;
	
	
	
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	
	const client = new MongoClient(mongo_conn);
	
	// Use connect method to connect to the server
	client.connect()
	.then(async client => {
	  
		console.log('Connected successfully to server: ')

		db = client.db(dbName)
		
		//fetch data of pending bridge items
		let pendingBridgeEntries = await db.collection('bsc_bridge_queue').find({status: 'pending'}).sort({'date': 1}).toArray();
		console.log('found entries');
		console.log(pendingBridgeEntries.length);
		
		//grab transactions
		let url = new URL(config.hive_engine_bsc_bridge_afit_acct_his);
		let se_connector = await fetch(url);
		let bridge_afit_trx_entries = await se_connector.json();
		
		
		//grab HBD transactions
		let transactions = await hiveClient.database.call('get_account_history', [config.bsc_bridge_account, -1, 300]);
		//let hbdUrl = 
		
		//loop through entries, and send over AFIT
		pendingBridgeEntries.forEach(async function(entry){
			//verify if the entry is valid by count of AFIT and HBD stored
			//ID of the AFIT transfer
			let afitTrx = entry.afitTrx;
			//ID of HBD transfer
			let hbdTrx = entry.hbdTrx;
			let targetWallet = entry.wallet;
			let matchingTrx = bridge_afit_trx_entries.find(item => {
				return (item.transactionId == afitTrx && item.from == entry.user && item.symbol == 'AFIT')
			});
			console.log(matchingTrx);
			//found AFIT payment
			if (matchingTrx){
				let afitAmnt = parseFloat(matchingTrx.quantity);
				console.log('afitAmnt:'+afitAmnt);
				if (afitAmnt < config.minAFITTransfer){
					console.log('less than min amount');
				}else if (afitAmnt > config.maxAFITTransfer){
					console.log('greater than max amount');
				}else{
					//find matching HBD transaction
					//console.log(transactions);
					
					let soughtHBDAmount = config.hbdAFITTransferRate * afitAmnt;
					soughtHBDAmount = parseFloat(soughtHBDAmount.toFixed(2));
					if (soughtHBDAmount < 0.1) soughtHBDAmount = 0.1
					console.log(soughtHBDAmount);
					let tx_id = '';
					let paymentFound = false;
					for (let txs of transactions) {
						let op = txs[1].op
						//check if we received a transfer to our target account
						//if we found a transfer operation sent to our target account, with the correct memo and the proper amount, proceed
						if (op[0] === 'transfer'){
							//console.log('transfer op ');
							//console.log(op[1]);
							let sentAmount = op[1].amount.split(' ')[0];
							//the correct amount to find
							console.log(sentAmount);
							if (op[1].to === config.bsc_bridge_account && op[1].from === entry.user && txs[1].trx_id == hbdTrx && sentAmount >= soughtHBDAmount){  
								console.log('found match');
								console.log(op[1]);
								//console.log(txs);
								/*let now = moment(new Date()); //todays date
								let end = moment(txs[1].timestamp); // last update date
								let duration = moment.duration(now.diff(end));
								let hrs = duration.asHours();
								//transaction needs to have been concluded within 5 hours.
								if (hrs < 24){*/
									/*tx_id = txs[1].trx_id;*/
									paymentFound = true;
									break;
								
								//}
							}
						}
					}	
					if (paymentFound){
						let txHash = await sendAfitBSC(afitAmnt,targetWallet);
						await updateTrxDetails(entry, txHash, afitAmnt, soughtHBDAmount);
					}
				}
			}
			//{transactionId: afitTrx});
			//console.log(match);
			//the ID of HBD transfer
			//let hbdTrx = entry.hbdTrx;
			
		});
	});
}
//send corresponding amount on BSC, while updating user balances on actifit and taking off 1 HBD as trx fee (0r 1%, whichever is bigger)
async function sendAfitBSC(amnt, tgtAddress){	
	console.log('sendAfitBSC');
	loadBridgeWallet();
	let outc = await contract.methods.transfer(tgtAddress, web3.utils.toWei( amnt.toString() )).send({ 
		from: config.bridgeWalletAdd,
		gasPrice: 10000000000, // 10 gwei //0.000000005
		gas: 100000,
	});
	console.log(outc.transactionHash);
	return outc.transactionHash;
	/*web3.eth.sendTransaction({
		from: config.bridgeWalletAdd,//web3.eth.accounts[0],
		to: tgtAddress,
		data: contract.methods.transfer(tgtAddress, web3.utils.toWei( amnt.toString() ) ).encodeABI(),
		//value: _addr[1]* 10 ** 18,//20000000000000000, 
		gasPrice: 10000000000, // 10 gwei //0.000000005
		gas: 100000, 
		//gas: maxGas,
		
	}, 
	(err, txHash) => {
		console.log(!err ? txHash : err);
	})*/
}

async function updateTrxDetails(entry, trxHash, afitAmnt, hbdAmnt){
	entry.txHash = trxHash;
	entry.status = "complete";
	entry.afitLockedAmount = afitAmnt;
	entry.origHbdAmount = hbdAmnt;
	let hbdFees = (hbdAmnt > 100? hbdAmnt / 100 : 1);
	console.log(hbdFees);
	entry.hbdFees = hbdFees;
	let pendingHbd = hbdAmnt - hbdFees;
	entry.hbdLockedAmount = pendingHbd;
	entry.trfDate = new Date();
	try{
		//driver 5.x: .save() removed - replace the existing doc by _id
		let trans = await db.collection('bsc_bridge_queue').replaceOne({_id: entry._id}, entry);
		console.log('success updating BSC transfer trx');
	}catch(err){
		console.log(err);
	}
}

//run the airdrop once
	/*const date = new Date(2021, 9, 25, 19, 06, 30);
	console.log(date);
	schedule.scheduleJob(date, function(){
	  console.log('--- Airdrop AFIT to community ---');
	  processAfitAirdropHive();//param test
	});*/
	

//processAfitAirdropHive();

/*
async function processAfitAirdropHive(){
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	MongoClient.connect(mongo_conn, async function (err, dbClient) {
		if (!err) {
			console.log('Connected successfully to server: ');
			db = dbClient.db(dbName);
			
			let participants = await db.collection('user_wallet_address').find({chain: 'BSC'}).toArray();
			console.log(participants.length);
			let delay = 0;
			for (let entry of participants) {
				setTimeout(async function(){
					//grab tokens of the user on actifit wallet
					//let afit_wallet = await grabUserTokensFunc(entry.user);
					
					let user = await db.collection('user_tokens').findOne({_id: entry.user});
					//console.log(afit_wallet);
					//fixing token amount display for 3 digits
					if (typeof user!= "undefined" && user!=null){
						if (typeof user.tokens!= "undefined"){
							// not a real number (NaN, a string) reads as 0, so the checks below fail closed
							const tokens = utils.finiteAmount(user.tokens);
							user.tokens = (tokens === null ? 0 : tokens).toFixed(3)
						}
					}else{
						user = new Object();
						// was `username`, which is not defined here: it threw for any user without a balance doc
						user._id=entry.user;
						user.name=entry.user;
						user.tokens=0;
					}
					
					console.log('afit_wallet:'+user.tokens);
					let afit_he_bal_val = 0;
					try { 
						let afit_he_bal = await hsc.findOne('tokens', 'balances', { account: entry.user, symbol: 'AFIT' });
						afit_he_bal_val = afit_he_bal.balance;
					}catch(err){
						
					}
					console.log('afit_he_bal:'+afit_he_bal_val);
					let afit_se_bal_val = 0;
					try { 
						let afit_se_bal = await ssc.findOne('tokens', 'balances', { account: entry.user, symbol: 'AFIT' });
						afit_se_bal_val = afit_se_bal.balance;
					}catch(err){
						
					}
					console.log('afit_se_bal:'+afit_se_bal_val);
					let tot_tokens = parseFloat(user.tokens) + parseFloat(afit_he_bal_val) + parseFloat(afit_se_bal_val);
					console.log(tot_tokens);
					let reward = 0;
					if (tot_tokens>=2000 && tot_tokens <5000){
						reward = tot_tokens*0.004;
					}else if (tot_tokens>=5000 && tot_tokens <10000){
						reward = tot_tokens*0.005;
					}else if (tot_tokens>=10000 && tot_tokens <50000){
						reward = tot_tokens*0.006;
					}else if (tot_tokens>=50000 && tot_tokens <100000){
						reward = tot_tokens*0.007;
					}else if (tot_tokens>=100000){
						reward = 800;
					}
					console.log(reward);
					//only insert if user is eligible
					if (reward>0){
						let airdrop_entry = {
							user: entry.user,
							chain: 'BSC',
							tokens_count: parseFloat(tot_tokens),
							actifit_wallet_afit_bal: parseFloat(user.tokens),
							afit_he_bal: parseFloat(afit_he_bal_val),
							afit_se_bal: parseFloat(afit_se_bal_val),
							afit_bsc_reward: parseFloat(reward.toFixed(3)), 
							date: new Date()
						}
						//insert into airdrop snapshot
						let transaction = await db.collection('afit_bsc_hive_airdrop').insert(airdrop_entry);
						//res.write(JSON.stringify(transaction));
					}
				}, delay+=1500);
			}
	  }
	});
}

*/

const SSC = require('sscjs');
const ssc = new SSC(config.steem_engine_rpc);

const hsc = new SSC(config.hive_engine_rpc);

//airdropAFITX();

// moveAFITToSE(false);
//runRewards(true);

//testMove();


async function processGadgetBuyPrize() {
	if (payoutsPaused('gadgetPrize')) return;
	console.log('processGadgetBuyPrize');
	
	let mongo_conn = config.mongo_uri
	if (config.testing){
		mongo_conn = config.mongo_local
	}
	// Use connect method to connect to the server
	const client = new MongoClient(mongo_conn);
	
	// Use connect method to connect to the server
	client.connect()
	.then(async client => {
		console.log('Connected successfully to server: ')

		db = client.db(dbName)
		
		//fetch data of last reward cycle
		let lastDraw = await db.collection('gadget_buy_prize_draw').find().sort({'drawDate': -1}).toArray();
		let lastDrawDate = new Date(config.gadgetPrizeInitDate);
		if (Array.isArray(lastDraw) && lastDraw.length > 0){
			lastDrawDate = lastDraw[0].drawDate;
		}
		let today = moment().utc().startOf('date').toDate()
		let start = moment(lastDrawDate).utc().startOf('date').toDate()
		let nextDrawDate = moment(start).add(config.contestBuyLen, 'days').toDate()
		//let nextDrawDate = lastDrawDate+
		console.log(today);
		console.log(nextDrawDate);
		console.log((today.getTime() >= nextDrawDate.getTime()));
		//check if this is the proper date to kick off reward
		if (today.getTime() >= nextDrawDate.getTime()){
			console.log('kick off draw reward');
			//fetch list of ticket holders
			let entries = await utils.getGadgetBuyTickets(db);
			console.log(entries);
			
			//randomly pick winner and send rewards
			if (Array.isArray(entries) && entries.length > 0){
				
				//fetch reward pool
				hive.api.getAccounts([config.gadget_buy_account], async function(err, response){
					//console.log(err, response);
					if (!err){
						let prizePool = response[0].balance;
						let prizePoolValue = parseFloat(prizePool.split(' ')[0]) * config.userRewardPrizePercent / 100;
						
						console.log('prize pool value: '+prizePoolValue);
						
						//pick winner
						let lucky_winner_id = utils.generateRandomNumber(1, entries.length);
						let winner_name = entries[lucky_winner_id].user;
						console.log('Winner is ......'+winner_name);
						let currency = 'HIVE';
						let memo= 'Congrats on winning Actifit random gadget purchase prize!';
						
						//reward winner
						
						let res = await hive.broadcast.transferAsync(config.gadget_buy_account_ak, config.gadget_buy_account, winner_name, parseFloat(prizePoolValue).toFixed(3) + ' ' + currency, memo);/*.then(
						res => {
							//store last draw results
							let drawInfo = {
								drawDate: new Date();
								winner: [{name: winner_name, position: 1, reward: prizePoolValue, currency: currency}],
								rewardPool: prizePoolValue,
								participatingTickets: entries
							}
							db.collection('gadget_buy_prize_draw').insert(drawInfo);
						}).catch(err=>console.log(err));*/
						
						let buyBackAmount = parseFloat(prizePool.split(' ')[0]) * config.buyBackPrizePercent / 100;
						
						let projectSupportAmount = parseFloat(prizePool.split(' ')[0]) * config.actifitFundPrizePercent / 100;
						console.log(res);
						if (res){
							//store last draw results
							let drawInfo = {
								drawDate: new Date(),
								winner: [{name: winner_name, position: 1, reward: prizePoolValue, currency: currency, buyback: buyBackAmount, projectSupportAmount: projectSupportAmount}],
								rewardPool: prizePoolValue,
								participatingTickets: entries
							}
							db.collection('gadget_buy_prize_draw').insertOne(drawInfo);
						}
						
						//send 25% of funds to buy back tokens
						setTimeout(async function(){
							memo= 'Funds to buy back from Actifit random gadget purchase prize!';
							res = await hive.broadcast.transferAsync(config.gadget_buy_account_ak, config.gadget_buy_account, config.buy_account, parseFloat(buyBackAmount).toFixed(3) + ' ' + currency, memo);
							
							console.log(res);
						}, 3000);
						
						//keep 25% of funds to actifit project
						setTimeout(async function(){
							memo = 'Funds to keep as 25% based on prize results.';
							res = await hive.broadcast.transferAsync(config.gadget_buy_account_ak, config.gadget_buy_account, config.full_pay_benef_account, parseFloat(projectSupportAmount).toFixed(3) + ' ' + currency, memo);
						
							console.log(res);
						}, 6000);
						
						//send notification to the user about winning
						utils.sendNotification(db, winner_name, 'actifit', 'prize_pool_draw_winner', 'Congratulations! You have won the prize pool of the gadget buy contest! ' + prizePoolValue + ' HIVE have been sent to your wallet', 'https://actifit.io/'+winner_name);
						
					}
				});
				
				
				
			}else{
				console.log('no ticket entries to reward');
			}
			
		}
		
	});
}

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
		let transaction = await db.collection('token_transactions').insertOne(moveTrans);
	
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
	
	//sign key properly to function with dhive requirement
	let privateKey = dhive.PrivateKey.fromString(
		//config.token_dist_pkey
		config.active_key
	);
	let entry = new Object();
	
	entry.user='mcfarhat';
						hiveClient.broadcast.json({
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
		//driver 5.x: .remove() removed - delete the doc inserted for this move
		let transaction = await db.collection('token_transactions').deleteOne({_id: moveTrans._id});
	}catch(err){
		console.log(err);
	}
}

// Run fn under the user's shared AFIT lock (afit_balance; the API's balance writers and its
// balance rebuild take the same one). This job is not interactive, so it waits up to 30s and
// then reports the debit as busy ({ok:false, reason:'busy'}) rather than run without it.
async function withAfitLock(user, fn){
	const lock = await afitBalance.acquireAfitLock(db, user, { waitMs: 30000 });
	if (!lock) return { ok: false, reason: 'busy' };
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

// Lower a user's cached AFIT balance by an amount that has ALREADY left (the transfer is
// on chain), so it is unconditional - but atomic ($inc), never a read-modify-replaceOne that
// overwrites a concurrent change, and it never throws (it used to crash on a user with no
// user_tokens document). Returns true when the balance was updated.
async function updateUserCount(entry){
	//update user total token count
	console.log('>>> update user token count');
	const amount = afitBalance.positiveAmount(entry && entry.daily_afit_transfer);
	if (!entry || typeof entry.user !== 'string' || amount === null){
		console.log('updateUserCount: invalid entry, balance not updated');
		return false;
	}
	try{
		let trans = await db.collection('user_tokens').updateOne({_id: entry.user}, {$inc: {tokens: -amount}});
		if (!trans || trans.matchedCount !== 1){
			// no cached balance to lower; the ledger row stands and the daily rebuild applies it
			console.log('updateUserCount: no user_tokens row for ' + entry.user + ', left to the daily rebuild');
			return false;
		}
		console.log('success updating user token count');
		return true;
	}catch(err){
		console.log(err);
		return false;
	}
}

// Daily AFIT move to Hive-Engine (scheduled at 10:00 UTC on the MAIN thread).
async function moveAFITToSE(testMode){
	if (payoutsPaused('afitMove')) return;
	console.log('*** process moving AFIT to SE ***');
	try{
		await connectRewardsDb();
	}catch(err){
		console.log('error - AFIT move: could not connect to the database, nothing sent: ' + (err && err.message));
		return;
	}
	return processAfitMoves(testMode);
}

let afitMoveRunning = false;

// One run of the AFIT move over every standing order in powering_down_he, against the
// module db. Chain clients and timings can be replaced (tests).
//
// Money safety:
//   - the run is refused when a limit from config, the signing key or the sending
//     account's own Hive-Engine AFIT balance cannot be read (fail closed);
//   - each order is claimed for the day (last_move_day) before anything is debited, so
//     the same order is never sent twice on one day, even by overlapping runs;
//   - the user's AFIT is debited atomically BEFORE the transfer is broadcast; the
//     transaction is signed first so its id is known, and after the broadcast its outcome
//     is looked up on Hive / Hive-Engine. The debit is undone ONLY when the transfer is
//     confirmed not to have happened; when that cannot be determined the debit stays and
//     the case is written to afit_move_unresolved for manual review.
async function processAfitMoves(testMode, deps = {}){
	const cfg = deps.config || config;
	const he = deps.hsc || hsc;
	const se = deps.ssc === undefined ? ssc : deps.ssc;
	const chain = deps.hiveClient || hiveClient;
	const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
	const gapMs = Number.isFinite(deps.gapMs) ? deps.gapMs : 4500;
	const resolveOpts = deps.resolveOpts || {};

	if (afitMoveRunning){
		console.log('error - AFIT move: a previous run is still in progress, skipping');
		return { skipped: 'running' };
	}
	afitMoveRunning = true;
	const pending = [];
	const summary = { sent: 0, refunded: 0, unresolved: 0, skipped: 0, cancelled: 0 };
	try{
		if (!testMode) await recoverAfitMoveAttempts({ hsc: he, hiveClient: chain, sleep, resolveOpts });
		const limits = afitTransfers.moveLimits(cfg);
		if (!limits){
			console.log('error - AFIT move: max_afit_to_se_day / free_movable_afit_day / afitx_afit_move_ratio missing or invalid in config, nothing sent');
			return { skipped: 'config' };
		}
		let privateKey = null;
		if (!testMode){
			try{
				privateKey = dhive.PrivateKey.fromString(cfg.active_key);
			}catch(err){
				console.log('error - AFIT move: signing key missing or invalid, nothing sent');
				return { skipped: 'key' };
			}
		}

		// the sending account's own Hive-Engine AFIT: without a readable balance, send nothing
		let available = null;
		try{
			const bal = await afitTransfers.withTimeout(he.findOne('tokens', 'balances', { account: cfg.account, symbol: 'AFIT' }), 15000, 'H-E AFIT balance');
			available = bal ? afitBalance.finiteAmount(bal.balance) : null;
		}catch(err){
			console.log(err);
		}
		if (available === null){
			console.log('error - AFIT move: could not read the H-E AFIT balance of ' + cfg.account + ', nothing sent');
			return { skipped: 'balance' };
		}
		console.log('AFIT balance on ' + cfg.account + ': ' + available);

		const poweringDown = await db.collection('powering_down_he').find().toArray();
		const banned = new Set((await db.collection('banned_accounts').find({ban_status:"active"}).toArray()).map((b) => b.user));
		const today = moment().utc().format('YYYY-MM-DD');
		const winStart = moment().utc().startOf('date').toDate();
		const expiryCutoff = moment(winStart).subtract(cfg.afit_powerdown_days || 7, 'days').toDate();

		// one order per user per day, even if older data holds several for one user
		const movedToday = new Set(poweringDown.filter((e) => e && e.last_move_day === today).map((e) => e.user));
		const seenUsers = new Set();

		let first = true;
		for (const entry of poweringDown){
			if (!entry || typeof entry.user !== 'string') continue;

			//expire stale requests (older than the powerdown window) WITHOUT moving funds
			if (!(new Date(entry.date) >= expiryCutoff)){
				console.log('expiring stale AFIT power down request for ' + entry.user + ' (dated ' + entry.date + ')');
				await cancelDailyAFITPowerDown(entry, testMode, null);
				summary.cancelled++;
				continue;
			}
			if (banned.has(entry.user)){
				console.log('user ' + entry.user + ' is banned. Skip');
				summary.skipped++;
				continue;
			}
			if (movedToday.has(entry.user) || seenUsers.has(entry.user)){
				console.log('AFIT move for ' + entry.user + ' already processed today. Skip');
				summary.skipped++;
				continue;
			}
			seenUsers.add(entry.user);

			const amount = afitTransfers.afitAmount(entry.daily_afit_transfer);
			if (amount === null || amount > limits.maxPerDay){
				await cancelDailyAFITPowerDown(entry, testMode, 'Your daily move of AFIT to Hive-Engine was cancelled: the amount is not valid (the maximum is ' + limits.maxPerDay + ' AFIT/day). Please set up the move again.');
				summary.cancelled++;
				continue;
			}

			//the user must still hold enough AFITX for amounts above the free allowance
			if (amount > limits.freePerDay){
				const afitx = await afitTransfers.fetchAfitxBalance(entry.user, { hsc: he, ssc: se });
				if (!afitx.heOk){
					// a lookup failure is not the user's fault: retry tomorrow, keep the order
					console.log('error - AFIT move for ' + entry.user + ' skipped today: AFITX balance unavailable');
					summary.skipped++;
					continue;
				}
				if (afitTransfers.afitxShortfall(amount, afitx.total, limits)){
					const needed = afitTransfers.afitxRequired(amount, limits);
					await cancelDailyAFITPowerDown(entry, testMode, 'Your daily move of ' + amount + ' AFIT to Hive-Engine was cancelled: moving that ' +
						'amount requires at least ' + Math.max(0.1, needed).toFixed(3) + ' AFITX, but you only hold ' +
						afitx.total + ' AFITX. Top up your AFITX and set up the move again.');
					summary.cancelled++;
					continue;
				}
			}

			//make sure the user has enough Actifit AFIT (the debit below re-checks atomically)
			const cur = await afitBalance.readBalance(db, entry.user).catch(() => null);
			if (cur === null){
				console.log('error - AFIT move for ' + entry.user + ' skipped today: balance unavailable');
				summary.skipped++;
				continue;
			}
			if (cur < amount){
				await cancelDailyAFITPowerDown(entry, testMode, 'Your daily move of ' + amount + ' AFIT to Hive-Engine was cancelled: your Actifit ' +
					'AFIT balance (' + cur + ') is below the requested ' + amount +
					' AFIT/day. Earn or top up more AFIT and set up the move again.');
				summary.cancelled++;
				continue;
			}

			//the sending account must still cover it
			if (available < amount){
				console.log('error - AFIT move for ' + entry.user + ' skipped: ' + cfg.account + ' H-E balance ' + available + ' below ' + amount);
				summary.skipped++;
				continue;
			}

			if (testMode){
				console.log('[test] would move ' + amount + ' AFIT to H-E for ' + entry.user);
				continue;
			}

			//claim the order for today; only the run that claims it may send it
			const claim = await db.collection('powering_down_he').updateOne(
				{ _id: entry._id, last_move_day: { $ne: today } },
				{ $set: { last_move_day: today } }
			);
			if (!claim || claim.matchedCount !== 1){
				console.log('AFIT move for ' + entry.user + ' already claimed today. Skip');
				summary.skipped++;
				continue;
			}
			// any failure before the broadcast gives the day back, so the order is retried
			const releaseClaim = () => db.collection('powering_down_he').updateOne(
				{ _id: entry._id, last_move_day: today }, { $unset: { last_move_day: '' } }
			).catch((e) => console.log('could not release AFIT move claim for ' + entry.user + ': ' + (e && e.message)));

			if (!first) await sleep(gapMs);
			first = false;

			// sign first, so the transaction id is known and recorded before any AFIT is taken
			let signed;
			try{
				signed = await afitTransfers.signTransfer(chain, { account: cfg.account, key: privateKey, to: entry.user, quantity: amount });
			}catch(err){
				console.log('error - AFIT move for ' + entry.user + ': could not prepare the transaction - ' + (err && err.message));
				await releaseClaim();
				summary.skipped++;
				continue;
			}
			// the attempt row is what lets a later run finish this move if the process stops
			// before the outcome is known (see recoverAfitMoveAttempts)
			const attempt = {
				_id: signed.trxId, trx_id: signed.trxId, expiration: signed.expiration,
				user: entry.user, amount, order_id: entry._id || null,
				status: 'in_flight', debited: false, date: new Date(),
			};
			try{
				await db.collection(AFIT_MOVE_ATTEMPTS).insertOne(attempt);
			}catch(err){
				console.log('error - AFIT move for ' + entry.user + ': could not record the attempt, nothing sent - ' + (err && err.message));
				await releaseClaim();
				summary.skipped++;
				continue;
			}

			const moveTrans = {
				reward_activity: 'Move AFIT to H-E',
				note: 'User Automated transfer of ' + amount + ' AFIT to H-E',
				afit_move_trx: signed.trxId,
				date: new Date(),
			};
			const debit = await withAfitLock(entry.user, () => afitBalance.debitAfit(db, entry.user, amount, { ledgerRow: moveTrans, context: 'afit-move-he' }));
			if (!debit.ok){
				console.log('error - AFIT move for ' + entry.user + ' not started: ' + debit.reason);
				await setAttempt(signed.trxId, { status: 'not_debited', reason: debit.reason });
				if (debit.reason === 'insufficient_funds'){
					await cancelDailyAFITPowerDown(entry, testMode, 'Your daily move of ' + amount + ' AFIT to Hive-Engine was cancelled: your Actifit AFIT balance is below the requested amount. Earn or top up more AFIT and set up the move again.');
					summary.cancelled++;
				}else{
					await releaseClaim();
					summary.skipped++;
				}
				continue;
			}
			available -= amount;
			await setAttempt(signed.trxId, { debited: true, ledger_id: debit.ledgerId || null });

			// waiting for the lock can use up the transaction's lifetime; then do not send it
			if (Date.now() > new Date(signed.expiration + 'Z').getTime() - 15000){
				console.log('error - AFIT move for ' + entry.user + ': transaction too close to expiry, not sent');
				const status = await refundAfitMove(entry, debit, amount, signed, 'not_sent', summary);
				await setAttempt(signed.trxId, { status });
				if (status === 'refunded') await releaseClaim();
				available += amount;
				continue;
			}

			console.log('broadcast AFIT move ' + signed.trxId + ' for ' + entry.user + ' (' + amount + ' AFIT)');
			let accepted = false;
			try{
				await chain.broadcast.send(signed.signed);
				accepted = true;
				summary.sent++;
			}catch(err){
				console.log('error - AFIT move broadcast error for ' + entry.user + ' trx ' + signed.trxId + ': ' + (err && err.message) + ' - checking whether it landed before any refund');
			}

			//confirm the outcome in the background; refund only on a confirmed failure
			pending.push(resolveAndSettle(entry, debit, amount, signed, accepted, { hsc: he, hiveClient: chain, sleep, resolveOpts }, summary)
				.then(async (outcome) => {
					if (outcome === 'landed') await deactivateDailyAFITPowerDown(entry, testMode).catch((e) => console.log(e));
				}));
		}
		await Promise.all(pending);
		console.log('*** AFIT move done: ' + JSON.stringify(summary) + ' ***');
		return summary;
	}catch(err){
		console.log('error - AFIT move run failed: ' + (err && err.message));
		await Promise.all(pending).catch(() => {});
		return Object.assign({ error: err && err.message }, summary);
	}finally{
		afitMoveRunning = false;
	}
}

const AFIT_MOVE_ATTEMPTS = 'afit_move_attempts';
// an in-flight attempt older than this belongs to a run that stopped before finishing it
// (a run settles each of its own attempts within about 6 minutes)
const AFIT_MOVE_RECOVER_AFTER_MS = 10 * 60 * 1000;

async function setAttempt(trxId, fields){
	try{
		await db.collection(AFIT_MOVE_ATTEMPTS).updateOne({ _id: trxId }, { $set: Object.assign({ updated: new Date() }, fields) });
	}catch(err){
		console.log('!!! could not update AFIT move attempt ' + trxId + ': ' + (err && err.message));
	}
}

// Look up what happened to a broadcast transfer and act on it: refund only when it is
// confirmed not to have happened, otherwise keep the debit (and record it when unknown).
// Returns the attempt's final status: 'landed' | 'refunded' | 'unresolved'.
async function resolveAndSettle(entry, debit, amount, signed, accepted, chainDeps, summary){
	const r = await afitTransfers.resolveTransfer(Object.assign({
		trxId: signed.trxId, expiration: signed.expiration, to: entry.user,
		hsc: chainDeps.hsc, hiveClient: chainDeps.hiveClient, sleep: chainDeps.sleep,
	}, chainDeps.resolveOpts || {})).catch((err) => ({ outcome: 'unknown', detail: err && err.message }));
	console.log('AFIT move ' + signed.trxId + ' for ' + entry.user + ': ' + r.outcome + (r.hiveStatus ? ' (hive: ' + r.hiveStatus + ')' : ''));
	let status;
	if (r.outcome === 'landed'){
		status = 'landed';
	}else if (r.outcome === 'not_landed' || r.outcome === 'failed_on_engine'){
		status = await refundAfitMove(entry, debit, amount, signed, r.outcome, summary);
	}else{
		await recordUnresolvedMove(entry, debit, amount, signed, accepted ? 'unverified_after_accept' : 'broadcast_error_unverified', r, summary);
		status = 'unresolved';
	}
	await setAttempt(signed.trxId, { status, outcome: r.outcome, hive_status: r.hiveStatus || null });
	return status;
}

// Finish attempts left in flight by a run that stopped (crash, restart) before their
// outcome was known. Same rules as a live run: refund only on a confirmed failure. An
// attempt whose debit never happened needs nothing (the transfer is only sent after it).
async function recoverAfitMoveAttempts(deps = {}){
	const chainDeps = {
		hsc: deps.hsc || hsc,
		hiveClient: deps.hiveClient || hiveClient,
		sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
		resolveOpts: Object.assign({ attempts: 2 }, deps.resolveOpts || {}),
	};
	const summary = { recovered: 0, refunded: 0, unresolved: 0, landed: 0, not_debited: 0 };
	const cutoff = new Date(Date.now() - AFIT_MOVE_RECOVER_AFTER_MS);
	let rows = [];
	try{
		rows = await db.collection(AFIT_MOVE_ATTEMPTS).find({ status: 'in_flight', date: { $lt: cutoff } }).toArray();
	}catch(err){
		console.log('error - AFIT move recovery: could not read attempts - ' + (err && err.message));
		return summary;
	}
	for (const row of rows){
		// claim the attempt so two recoveries (process start and a run) never settle it twice
		const claimed = await db.collection(AFIT_MOVE_ATTEMPTS).updateOne(
			{ _id: row._id, status: 'in_flight' }, { $set: { status: 'recovering', recovering_at: new Date() } }
		).catch(() => null);
		if (!claimed || claimed.matchedCount !== 1) continue;
		summary.recovered++;
		console.log('AFIT move recovery: settling attempt ' + row.trx_id + ' for ' + row.user);
		const amount = afitBalance.positiveAmount(row.amount);
		let ledgerId = row.ledger_id || null;
		if (!row.debited || !ledgerId){
			const ledgerRow = await db.collection(afitBalance.LEDGER).findOne({ user: row.user, afit_move_trx: row.trx_id }).catch(() => undefined);
			if (ledgerRow === undefined){
				console.log('error - AFIT move recovery: ledger unreadable for ' + row.trx_id + ', left for the next run');
				await setAttempt(row._id, { status: 'in_flight' });
				continue;
			}
			if (!ledgerRow){
				await setAttempt(row._id, { status: 'not_debited', reason: 'recovered_without_debit' });
				summary.not_debited++;
				continue;
			}
			ledgerId = ledgerRow._id || null;
		}
		const entry = { user: row.user, _id: row.order_id || null };
		const debit = { ok: true, amount, ledgerId };
		const status = await resolveAndSettle(entry, debit, amount, { trxId: row.trx_id, expiration: row.expiration }, false, chainDeps, summary);
		if (status === 'landed') summary.landed++;
	}
	if (rows.length) console.log('*** AFIT move recovery done: ' + JSON.stringify(summary) + ' ***');
	return summary;
}

// Give back a move's AFIT once the transfer is confirmed not to have happened.
// Returns 'refunded', or 'unresolved' (recorded for manual review with what was undone).
async function refundAfitMove(entry, debit, amount, signed, reason, summary){
	const res = await withAfitLock(entry.user, () => afitBalance.undoDebitDetailed(db, entry.user, debit, 'afit-move-he')).catch((err) => ({ error: err && err.message }));
	if (res && res.ok === true){
		console.log('AFIT move refunded for ' + entry.user + ' (' + amount + ' AFIT): ' + reason);
		if (summary) summary.refunded++;
		return 'refunded';
	}
	// say exactly which step is left: re-crediting a balance that WAS restored would pay twice
	const refund = res && typeof res.restored === 'boolean'
		? { ledgerRemoved: res.ledgerRemoved, restored: res.restored }
		: { ledgerRemoved: false, restored: false, error: (res && (res.reason || res.error)) || 'unknown' };
	await recordUnresolvedMove(entry, debit, amount, signed, 'refund_incomplete_after_' + reason, { refund }, summary);
	return 'unresolved';
}

// Leave the debit in place and write the case down for manual review.
async function recordUnresolvedMove(entry, debit, amount, signed, reason, resolution, summary){
	if (summary) summary.unresolved++;
	const row = {
		user: entry.user,
		amount,
		reason,
		trx_id: signed ? signed.trxId : null,
		expiration: signed ? signed.expiration : null,
		hive_status: resolution ? resolution.hiveStatus || null : null,
		detail: resolution && resolution.detail !== undefined ? JSON.stringify(resolution.detail) : null,
		refund: resolution && resolution.refund ? resolution.refund : null,
		ledger_id: debit ? debit.ledgerId || null : null,
		order_id: entry._id || null,
		status: 'open',
		date: new Date(),
	};
	console.log('!!! AFIT MOVE UNRESOLVED (manual review needed): ' + JSON.stringify(row));
	try{
		await db.collection('afit_move_unresolved').insertOne(row);
	}catch(err){
		console.log('!!! could not record unresolved AFIT move: ' + (err && err.message));
	}
	try{
		if (config.report_emails) mail.sendPlainMail('AFIT move needs manual review', JSON.stringify(row), config.report_emails).catch(() => {});
	}catch(_){ /* alerting must not throw */ }
}


async function deactivateDailyAFITPowerDown(entry, testMode){
	//today
	let start = moment().utc().startOf('date').toDate()
	
	//7 days running timeframe
	let to = moment(start).subtract(config.afit_powerdown_days || 7, 'days').toDate()

	let maxDate = moment(to).format()
	
	let transDate = moment(new Date(entry.date)).format();
	/*console.log('request date:')
	console.log(entry.date);
	console.log('7 days max date:');
	console.log(maxDate);
	console.log('due???');
	console.log((transDate < maxDate));*/
    if (transDate < maxDate) {// || entry.user=='mcfarhat'
		console.log('need to cancel out transaction')
		if (!testMode){// || entry.user=='mcfarhat'
			//driver 5.x: .remove() no longer exists, use deleteOne by _id
			let stts = await db.collection('powering_down_he').deleteOne({_id: entry._id});
		}
	}

}

//immediately cancel a pending daily AFIT move (e.g. insufficient funds / stale) and
//optionally notify the user why. Unlike deactivateDailyAFITPowerDown this does not wait
//for the 7-day window - the request is removed right away so it stops retrying daily.
async function cancelDailyAFITPowerDown(entry, testMode, message){
	console.log('cancelling daily AFIT power down for ' + entry.user + (message ? ' : ' + message : ''));
	if (testMode) return;
	try{
		//remove the pending request first so it stops retrying every day
		await db.collection('powering_down_he').deleteOne({_id: entry._id});
		//notify the user why it was cancelled (skip for silent expiry cleanups)
		if (message){
			await utils.sendNotification(
				db, entry.user, 'actifit',
				'afit_move_cancelled', 'afit_move_cancelled',
				message, 'https://actifit.io/@' + entry.user
			);
		}
	}catch(err){
		console.log('error cancelling daily AFIT power down: ' + err);
	}
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
			
			//sign key properly to function with dhive requirement
			let privateKey = dhive.PrivateKey.fromString(
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
	hiveClient.broadcast.json({
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

async function connectRewardsDb() {
	if (!rewardsClient) {
		const mongo_conn = config.testing ? config.mongo_local : config.mongo_uri;
		rewardsClient = await new MongoClient(mongo_conn).connect();
		console.log('Connected successfully to server: ');
	}
	db = rewardsClient.db(dbName);
	return db;
}

// Daily delegator AFIT rewards.
// The loadSteemPrices ("Full AFIT Payout") and claimRewards timers are not started here:
// both are broken and can crash the process. Fix them before starting them again.
async function runRewards(steemOnlyReward, updateDelegations){
	if (payoutsPaused('delegatorRewards')) return;
	try {
		await connectRewardsDb();
		//run for one day
		var delegation_days = 2;
		await startProcess(delegation_days, steemOnlyReward, updateDelegations);
	} catch (err) {
		console.error('>> Delegator rewards run failed, nothing more written this run: ' + (err && err.message));
		utils.log(err, 'delegations');
		mail.sendPlainMail('Delegator rewards run failed', String(err && err.message), config.report_emails).catch(() => {});
	}
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
  properties = await nodeLink.database.getDynamicGlobalProperties()
  if (properties.total_vesting_fund_steem){
	totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  }else{
	totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0])
  }
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  //console.log(properties);
  const transactions = await hiveClient.database.call('get_account_history', [account, txStart, limit])
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
		
		let tgtVal = '';
		if (op[1].sbd_payout){
			tgtVal = op[1].sbd_payout;
		}else{
			tgtVal = op[1].hbd_payout;
		}
		let rewardedSBD = parseFloat(tgtVal.split(' ')[0])
		
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
	// awaited: un-awaited, the balance rebuild below ran before the payout rows were written,
	// and a failed bulk write was an unhandled rejection
	try {
		await bulk_transactions.execute();
	} catch (err) {
		console.log('>> Full AFIT payout bulk write failed: ' + (err && err.message));
	}
	console.log('-- Processed Full AFIT Payouts --')
	//once done, update user total token count
	await updateUserTokens();
  }else{
	console.log('-- No Posts to process --');
  }
  
}

//function to load relevant STEEM and SBD prices, and proceed with AFIT token swap/reward process
async function loadSteemPrices() {

  console.log('-- start AFIT token swap process --')

  try {
    const steemResponse = await axios.get('https://api.coinmarketcap.com/v1/ticker/steem/');
    steemPrice = parseFloat(steemResponse.data[0].price_usd);
    console.log("Loaded STEEM price: " + steemPrice);

    const sbdResponse = await axios.get('https://api.coinmarketcap.com/v1/ticker/steem-dollars/');
    sbdPrice = parseFloat(sbdResponse.data[0].price_usd);
    console.log("Loaded SBD price: " + sbdPrice);

    let afit_swap_days = 1;
    let start = moment().utc().startOf('date').toDate()
    let to = moment(start).subtract(afit_swap_days, 'days').toDate()

    getBenefactorPosts(config.full_pay_benef_account, to);

  } catch (err) {
    console.log('Error loading prices: ' + err);
  }
}


async function startProcess (days, steemOnlyReward, updateDelegations) {
	let end = 0
	// Find last saved delegation transaction
	//let lastTx = await collection.find().sort({'tx_number': -1}).limit(1).next()
	console.log('last recorded delegation transaction');
	//console.log(lastTx)
	//if (lastTx) end = lastTx.tx_number
	await updateProperties()
	if (!testRun && updateDelegations){
		//update Steem delegations
		//console.log('>>>>>>>>>>STEEM<<<<<<<<<<<<');
		//await processDelegations(client, steem_history_limit, bulk_delegation_entries, delegationTrxCol, actDelgCol, config.account, -1, end)
		
		//update hive delegations
		console.log('>>>>>>>>>>HIVE<<<<<<<<<<<<');
		// a fresh list per run: a shared one was never cleared and replayed old writes
		await processDelegations(hiveClient, hive_history_limit, [], hiveDelegationTrxCol, hiveActDelgCol, config.account, -1, end)
		//await processDelegationsHive(hive, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, config.account, -1, end)
	}
	//TEMP BREAK
	//return;
	
	
	let start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	let txEnd = moment().utc().startOf('date').toDate()
	//let start = moment().utc().startOf('date').subtract(2, 'days').toDate()
	//let txEnd = moment().utc().startOf('date').subtract(1, 'days').toDate()
	//let txEnd = moment().utc().startOf('date').toDate()
	console.log('start:'+start);
	console.log('txEnd:'+txEnd);
	
	// A failed AFIT day must not stop the Monday HIVE/HBD file below; it is re-thrown after.
	let tokenRewardsError = null;
	if (!steemOnlyReward) try {
		console.log('processTokenRewards');
		//steem based rewards
		//await processTokenRewards('STEEM', client, bulk_delegation_entries, delegationTrxCol, actDelgCol, start, txEnd, days)
		
		//hive based rewards
		await processTokenRewards('HIVE', hiveClient, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, start, txEnd, days)
		//update our user token count post reward
		if (!testRun){
			await updateUserTokens();
		}
	} catch (err) {
		tokenRewardsError = err;
	}
	var d = new Date();
	var dayId = d.getDay();
	// Check if today is Monday, to calculate steem rewards
	if (dayId == 1){
		//console.log('processSteemRewards');
		//processTokenRewards (chain, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, days) {
		//let resSt = await processSteemRewards('STEEM', steem_history_limit, client, bulk_delegation_entries, delegationTrxCol, actDelgCol, txEnd)
		//console.log('>>>>>STEEM REWARDS COMPLETE');
		let resHv = await processSteemRewards('HIVE', hive_history_limit, hiveClient, bulk_hive_delegation_entries, hiveDelegationTrxCol, hiveActDelgCol, txEnd)
		//console.log('>>>>>HIVE REWARDS COMPLETE');
	}
	if (tokenRewardsError) throw tokenRewardsError;
}

// Alt beneficiaries: a delegator's rewards go to another account. This list is the
// delegation_alt_beneficiaries collection as audited on 2026-10-24 (18 rows, all
// created 2018-2019). The collection is no longer read: a row's id time can be chosen
// by whoever writes it, and an old row can be edited. To add or change a redirect,
// edit this list in a reviewed PR. Flags: reward_benefit = AFIT rewards,
// steem_reward_benefit = the weekly HIVE/HBD file. First match wins, as before.
const ALT_BENEFICIARIES = [
	['rabihfarhat', 'arabpromovault', '0', '0'],
	['alfamano', 'actifit.pay', '0', null],
	['justtryme90', 'jtm.support', '0', '1'],
	['gadrian-sp', 'ga10', '1', '1'],
	['taskmaster4450', 'elfman2018', '1', '0'],
	['gillianpearce', 'artysteps', '1', '1'],
	['resiliencia', 'ticket4fun', '1', '1'],
	['masterthematrix', 'cryptoheads', '1', '1'],
	['trumpman', 'trumpman2', '0', '0'],
	['erikah', 'erikahfit', '1', '1'],
	['akomoajong', 'steemcameroon', '1', '1'],
	['evildido', 'evildido-blog', '1', '1'],
	['jongolson', 'jonolsonproject', '1', '1'],
	['akomoajong', 'steemcameroon', '1', '0'],
	['barton26', 'bartonfitness', '1', '1'],
	['cryptoburner', 'onealfa', '1', '1'],
	['parejan', 'pjansen', '1', '1'],
	['binance2', 'onealfa', '1', '1'],
].map(([delegator, alt_account, reward_benefit, steem_reward_benefit]) => ({ delegator, alt_account, reward_benefit, steem_reward_benefit }));

// Hive account names: 3-16 chars, lowercase letters, digits, dots and dashes.
const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

// What `delegator` delegates to `delegatee` on chain now, in vests (0 if nothing).
// Retried a few times; a lookup that keeps failing throws, so the day pays nothing.
async function chainDelegatedVests(nodeLink, delegator, delegatee) {
	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await nodeLink.database.call('get_vesting_delegations', [delegator, delegatee, 1]);
			const r = res && res[0];
			if (r && r.delegator === delegator && r.delegatee === delegatee) return Number(String(r.vesting_shares).split(' ')[0]);
			return 0;
		} catch (err) {
			lastErr = err;
			if (process.env.NODE_ENV !== 'test') await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
		}
	}
	throw lastErr;
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/*
 * Checks accrued shares ({user, totalSteem}) against the chain. Stored delegation rows
 * decide each share, but only up to what the chain backs:
 * - a name that is not a valid Hive account, or with no delegation to us on chain now,
 *   gets nothing;
 * - a share is capped at days x (HP delegated on chain now).
 * Someone who lowered or removed their delegation since the window is cut to the
 * chain amount. That is the price of not trusting stored rows.
 */
// `chainCache` (optional Map) keeps lookups for the length of one run, so a multi-day
// backfill asks the chain once per delegator instead of once per day.
async function chainBackedShares(nodeLink, users, days, chainCache) {
	const excluded = new Set(config.exclude_rewards || []);
	const skipped = [];
	const candidates = users.filter((u) => {
		if (excluded.has(u.user)) { console.log('User '+u.user+' opted out from rewards'); return false; }
		if (!HIVE_NAME.test(String(u.user))) { skipped.push([String(u.user).slice(0, 40), 'not a valid account name']); return false; }
		return true;
	});
	let done = 0;
	let reused = 0;
	const vests = await mapLimit(candidates, 8, async (u) => {
		let v = chainCache && chainCache.get(u.user);
		if (v !== undefined) reused++;
		else {
			v = await chainDelegatedVests(nodeLink, u.user, config.account);
			if (chainCache) chainCache.set(u.user, v);
		}
		if (++done % 100 === 0 || done === candidates.length) console.log('checked on chain: ' + done + '/' + candidates.length + (reused ? ' (' + reused + ' from earlier days)' : ''));
		return v;
	});
	const backed = [];
	const capped = [];
	candidates.forEach((u, k) => {
		const chainSP = vestsToSteemPower(vests[k] + ' VESTS');
		let share = Number(u.totalSteem);
		if (!Number.isFinite(share) || share <= 0) { skipped.push([u.user, 'bad amount']); return; }
		if (!(chainSP > 0)) { skipped.push([u.user, 'no delegation on chain']); return; }
		const bound = days * chainSP;
		if (share > bound * 1.001) { capped.push([u.user, +share.toFixed(3), +bound.toFixed(3)]); share = bound; }
		backed.push({ user: u.user, totalSteem: share, chainSP });
	});
	return { backed, skipped, capped };
}

// Total a day may pay, as a multiple of days x cap.
const DAILY_TOTAL_TOLERANCE = 1.05;
// A day whose payee count falls below this share of the previous day's stops instead.
const MIN_PAYEE_RATIO = 0.7;

/*
 * Works out the delegator rewards for the window [start, end), without writing anything.
 * The multiplier keeps the day within the cap, and is worked out from the HP the chain
 * backs, so stored rows cannot move it. Throws (nothing paid) if a chain lookup keeps
 * failing, if nobody would be paid, if the payee count drops sharply from the previous
 * day, or if the total is above DAILY_TOTAL_TOLERANCE x days x cap.
 */
async function computeDelegationRewards (chain, nodeLink, delTrxCol, activeDelColLink, start, end, days, chainCache) {
	if (!start) start = moment().utc().startOf('date').subtract(days, 'days').toDate()
	if (!end) end = moment().utc().startOf('date').toDate()
	let note = 'Delegation Reward On ' + chain + ' For ' + moment(end).subtract(1, 'days').format('MMMM Do YYYY')

	if (!totalVests || !totalSteem) await updateProperties();

	const acumulated = await getAcumulatedSteemPower(nodeLink, null, delTrxCol, activeDelColLink, start, end, config.exclude_enabled);
	const { backed, skipped, capped } = await chainBackedShares(nodeLink, acumulated.users, days, chainCache);

	const weekly_rewd_cap = await utils.rewardCap(chain);
	// The multiplier uses chain HP, which stored rows cannot change. Shares are accrued in
	// the same units (see rowHP), so a capped day pays days x cap.
	const chainTotalSP = backed.reduce((a, u) => a + u.chainSP, 0);
	const multiplier = chainTotalSP > weekly_rewd_cap ? weekly_rewd_cap / chainTotalSP : 1;
	console.log('chain-backed HP: ' + chainTotalSP.toFixed(3) + ', cap: ' + weekly_rewd_cap + ', multiplier: ' + multiplier);

	const rows = backed.map((u) => {
		let reward_user = u.user;
		let reward_activity = 'Delegation';
		const alt = _.find(ALT_BENEFICIARIES, { delegator: u.user, reward_benefit: '1' });
		if (alt) {
			reward_user = alt.alt_account;
			reward_activity += ' On Behalf';
		}
		return {
			user: reward_user,
			chain: chain,
			token_count: parseFloat((u.totalSteem * multiplier).toFixed(3)),
			reward_activity: reward_activity,
			orig_account: u.user,
			note: note,
			date: end
		};
	}).filter((r) => r.token_count > 0);

	const total = rows.reduce((a, r) => a + r.token_count, 0);
	const maxTotal = DAILY_TOTAL_TOLERANCE * days * weekly_rewd_cap;
	console.log('delegator rewards: ' + rows.length + ' payees, total ' + total.toFixed(3) + ' AFIT (limit ' + maxTotal.toFixed(3) + '), skipped ' + skipped.length + ', capped ' + capped.length);
	if (skipped.length) console.log('skipped: ' + JSON.stringify(skipped));
	if (capped.length) console.log('capped to the chain amount [user, computed, paid]: ' + JSON.stringify(capped));

	if (!rows.length) throw new Error('no delegator would be paid; nothing paid');
	const prevDay = moment.utc(end).subtract(1, 'days').toDate();
	const prevCount = await db.collection('token_transactions').countDocuments({ reward_activity: /^Delegation/, date: prevDay });
	if (prevCount >= 50 && rows.length < MIN_PAYEE_RATIO * prevCount) {
		throw new Error('payees dropped from ' + prevCount + ' to ' + rows.length + '; nothing paid');
	}
	if (!(total <= maxTotal)) {
		throw new Error('delegator rewards total ' + total.toFixed(3) + ' is above the limit ' + maxTotal.toFixed(3) + '; nothing paid');
	}
	return { rows, total, maxTotal, multiplier, skipped, capped, end };
}

async function processTokenRewards (chain, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, days) {
	const result = await computeDelegationRewards(chain, nodeLink, delTrxCol, activeDelColLink, start, end, days);
	//only send out funds if not a test run
	if (!testRun){
		// wait for every write, so the balance rebuild that follows sees them all
		await Promise.all(result.rows.map(upsertRewardTransaction));
	}
	return result;
}

async function processSteemRewards (chain, history_limit, nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start) {
  if (!start) start = moment().utc().startOf('date').toDate()
  // Get active delegations for the week
  console.log(config.pay_account)
  const to = moment(start).subtract(7, 'days').toDate()
  const from = moment(to).subtract(7, 'days').toDate()
  
  if (!totalVests || !totalSteem) await updateProperties();
  const weekDays = 7;

  return Promise.all(
		[
			getAcumulatedSteemPower(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, from, to, config.exclude_enabled), //(nodeLink, dbDelegLink, delTrxCol, activeDelColLink, start, end, config.exclude_enabled);
			getBenefactorRewards(nodeLink, history_limit, to, start, -1)
		]
	).then(async values => {
    // Only shares the chain backs get a part of the pool (see chainBackedShares).
    const checked = await chainBackedShares(nodeLink, values[0].users, weekDays)
    if (checked.skipped.length) console.log('weekly file skipped: ' + JSON.stringify(checked.skipped))
    if (checked.capped.length) console.log('weekly file capped to the chain amount: ' + JSON.stringify(checked.capped))
    const activeDelegations = checked.backed
	//console.log('***');
	//console.log(values[1]);
	//console.log(activeDelegations);
    const steemRewards = values[1].split(' ')[0]
	const sbdRewards = values[1].split(' ')[1]
    const totalDelegatedSteem = activeDelegations.reduce((a, u) => a + u.totalSteem, 0)
    if (!(totalDelegatedSteem > 0)) throw new Error('weekly file: no chain-backed delegator; file not written')
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
		let delegator_entry = _.find(ALT_BENEFICIARIES, {'delegator': o.user, 'steem_reward_benefit': '1'});
		
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
/*
alignGadgetTicketEntries();

async function alignGadgetTicketEntries () {
  console.log('>>>>>>>>alignGadgetTicketEntries<<<<<<<<<<<')
  let start = -1;
  let ended = false;
  let account = config.gadget_buy_account;
  let limit = 2;//(start < 0) ? 3000 : Math.min(start, 3000)
  console.log('Account: ' + account + ' - Start: ' + start + ' - Limit: ' + limit)
  try {
    // Query account history for delegations
    const transactions = await hiveClient.database.call('get_account_history', [account, start, limit])
    transactions.reverse()
	
	//let's only fetch a max of 5 days ago delegation transactions
	
	//today
	start = moment().utc().startOf('date').toDate()
	  
	let to = moment(start).subtract(5, 'days').toDate()
	let end = moment(to).format()
	
    for (let txs of transactions) {
	  
	  let tx_date = moment(txs[1].timestamp).format()
	  
      if (txs[0] === end || tx_date < end) {
        console.log('--- Found last transaction ---')
        ended = true
        break
      }
      let op = txs[1].op
      lastTrans = txs[0]
      // Look for delegation operations
      if (op[0] === 'transfer' && op[1].to === account) {
		console.log(txs);
        //ensure transaction is properly processed
		let req = new Object();
		req.params = new Object();
		req.params.user = op[1].from;
		req.params.gadgets = op[1].memo;
		
		utils.buyMultiGadgetHiveUtls();
		
      }
    }
    
  }catch (err) {
    console.log(err);
  }
}*/



async function processDelegations (nodeLink, history_limit, bulkOps, delTrxCol, activeDelColLink, account, start, end) {
  let delegationTransactions = []
  let lastTrans = start
  let ended = false
  let limit = (start < 0) ? history_limit : Math.min(start, history_limit);
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
	  
	  // 10 days (was 6): the first run after the 2026-10-22 pause must still reach ops from then
	  let to = moment(start).subtract(10, 'days').toDate()
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
		
		bulkOps.push({
			replaceOne: {
			  filter: { 
				delegator: data.delegator, 
				vesting_shares: data.vesting_shares 
			  },
			  replacement: data,
			  upsert: true
			}
		  });
		
		/*dbDelegLink.find(
		{ 
			delegator: data.delegator,
			vesting_shares: data.vesting_shares,
		}).upsert().replaceOne(data);*/
      }
    }
    // Insert new transactions and update active ones
    if (delegationTransactions.length > 0) {
      try{
		const collection = db.collection(delTrxCol);
		await collection.bulkWrite(bulkOps, { ordered: false });
		console.log(`Successfully processed ${bulkOps.length} operations.`);
		
		//await dbDelegLink.execute();
	  }catch(bulkerr){
		utils.log(bulkerr);
		throw bulkerr;
	  }
	  //update relevant delegations collection
      await updateActiveDelegations(delTrxCol, activeDelColLink)
	  
    } else {
      console.log('--- No new delegations within current range---')
		//return;
    }
    // If more pending delegations call process againg with new index
    if (start !== limit && !ended){ 
		return processDelegations(nodeLink, history_limit, bulkOps, delTrxCol, activeDelColLink, account, lastTrans, end)
	}
    // console.log(transactions)
	return;
  } catch (err) {
    console.log(err)
    // Consider exponential backoff if extreme cases start happening
    if (err.type === 'request-timeout' || err.type === 'body-timeout'){ 
		return processDelegations(nodeLink, history_limit, bulkOps, delTrxCol, activeDelColLink, account, start, end);
	}
	// Any other failure means the stored delegations may be stale. Stop the run
	// instead of paying from them.
	throw err;
  }
}

async function getBenefactorRewards (nodeLink, history_limit, start, end, txStart, totalSp, totalSBD) {
  if (!totalSBD) totalSBD = 0
  if (!totalSp) totalSp = 0
  let limit = (txStart < 0) ? history_limit : Math.min(txStart, history_limit);
  start = moment(start).format()
  end = moment(end).format()
  console.log(start)
  console.log(end)
  // Query account history for delegations
  properties = await nodeLink.database.getDynamicGlobalProperties()
  if (properties.total_vesting_fund_steem){
	totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  }else{
	totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0])
  }
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  const transactions = await nodeLink.database.call('get_account_history', [config.pay_account, txStart, limit])
  transactions.reverse()
  for (let txs of transactions) {
    let date = moment(txs[1].timestamp).format()
    if (date >= start && date <= end) {
      let op = txs[1].op
      // Look for delegation operations
      if (op[0] === 'comment_benefactor_reward') {
		//console.log(op[1]);
		//SP is the sum of conversting vesting payout to SP, and appending any STEEM payouts
        let newSp = vestsToSteemPower(op[1].vesting_payout);
		//console.log(op[1]);
		if (op[1].steem_payout){
			newSp += parseFloat(op[1].steem_payout.split(' ')[0])
		}else{
			newSp += parseFloat(op[1].hive_payout.split(' ')[0])
		}
        totalSp = totalSp + newSp
		if (op[1].sbd_payout){
			let newSBD = op[1].sbd_payout.split(' ')[0]
			totalSBD += parseFloat(newSBD)
		}else{
			let newSBD = op[1].hbd_payout.split(' ')[0]
			totalSBD += parseFloat(newSBD)
		}
      }
    } else if (date < start) break
  }
  // Check last tx date to see if pagination is needed
  let lastTx = transactions[transactions.length - 1]
  let lastDate = moment(lastTx[1].timestamp).format()
  // console.log(lastDate)
  if (lastDate >= start) return getBenefactorRewards(nodeLink, history_limit, start, end, lastTx[0], totalSp, totalSBD)

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
			  vests: 1,
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
			  vests: 1,
			  tx_date: start
			}
		  },
		  { $match: { 'steem_power': { '$gt': 0 } } },
		  { $sort: { tx_date: 1 } }
		]
	  ).toArray()
  }
}

// A delegation row's HP in today's units: its vests at the current HP per vest. The
// stored steem_power is the HP at delegation time, which is lower for the same vests,
// and would not match the chain HP used for the cap and the multiplier.
function rowHP (row) {
  const v = parseFloat(String(row.vests || row.vesting_shares || ''));
  return Number.isFinite(v) ? vestsToSteemPower(v + ' VESTS') : Number(row.steem_power);
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
  console.log('getAcumulatedSteemPower');
  //console.log(delTrxCol);
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
      let newReward = activeHours * (rowHP(txs) / 24)
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
  console.log('collections');
  console.log(delgTrxCol);
  console.log(targetCol);
  let activeDelegations = await query.toArray()
  console.log('activeDelegations fetched');
  try{
	await db.collection(targetCol).drop()
  }catch(err){
	console.log(err);
  }
  console.log('activeDelegations dropped');
  if (activeDelegations.length) await db.collection(targetCol).insertMany(activeDelegations)
  console.log('done updating delegations '+targetCol);
  return ;
}

function upsertRewardTransaction (reward) {
	console.log('inserting for'+reward.user);
	return db.collection('token_transactions').replaceOne(
  { 
    user: reward.user, 
    chain: reward.chain, 
    date: reward.date, 
    reward_activity: reward.reward_activity, 
    orig_account: reward.orig_account 
  },
  reward,
  { upsert: true }
);
/*
  return db.collection('token_transactions').update(
    { user: reward.user, chain: reward.chain, date: reward.date, reward_activity: reward.reward_activity, orig_account: reward.orig_account },
    reward,
    { upsert: true }
  )*/
}


async function updateProperties () {
  // Set STEEM global properties
  properties = await hiveClient.database.getDynamicGlobalProperties()
  if (properties.total_vesting_fund_steem){
	totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0])
  }else{
	totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0])
  }
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
}

//function handles updating current user token count
// Rebuilds every cached balance (user_tokens) from the ledger. This used to be one
// aggregation with $out over user_tokens, which replaced the whole collection with sums
// read minutes earlier and so undid any spend or credit the API made during the run. It now
// only rewrites the users whose cache differs, each under their per-user AFIT lock and from
// a fresh read of their ledger - see afit_balance.rebuildCachedBalances.
async function updateUserTokens() {
  console.log('---- Updating User Tokens ----');

  try {
    const r = await afitBalance.rebuildCachedBalances(db, { log: (m) => console.log(m) });
    console.log('---- Updating User Tokens Complete ---- ' + r.users + ' ledger user(s), ' + r.candidates + ' differed, ' + r.updated + ' rebuilt, ' + r.busy.length + ' busy, ' + r.failed + ' failed');
  } catch (err) {
    console.error('>> Update User Tokens Error: ' + err.message);
  }
}
/*
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
		await db.collection('user_tokens').deleteMany({});
		//insert new count per user
		await db.collection('user_tokens').insertMany(user_tokens);
		console.log('---- Updating User Tokens Complete ----');
	}catch(err){
		console.log('>>save data error:'+err.message);
	}
}*/

//function handles fetching account details for later use when claiming rewards
async function grabAccountDetails(){
	console.log('grabbing fund account details');
	let account = await hiveClient.database.call('get_accounts', [[config.full_pay_benef_account]]);
	console.log(account);
	return account[0];
}
//function handles claiming pending account rewards
async function claimRewards(){
	//sign key properly to function with dhive requirement
	let privateKey = dhive.PrivateKey.fromString(
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
		hiveClient.broadcast.sendOperations([op], privateKey).then(
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

// Exported for testing. The bootstrap above is guarded by require.main so this
// module can be required in tests without launching the scheduler/pipeline.
module.exports = {
	moveAFITToSE,
	processAfitMoves,
	recoverAfitMoveAttempts,
	hsc,
	ssc,
	deactivateDailyAFITPowerDown,
	cancelDailyAFITPowerDown,
	updateUserCount,
	rollBackTrans,
	// delegator rewards (used by scripts/backfill_delegation_rewards.js and tests)
	connectRewardsDb,
	computeDelegationRewards,
	processTokenRewards,
	processDelegations,
	updateProperties,
	updateUserTokens,
	upsertRewardTransaction,
	chainBackedShares,
	ALT_BENEFICIARIES,
	payoutsPaused,
	JOB_PAUSED,
	hiveClient,
	hive_history_limit,
	hiveDelegationTrxCol,
	hiveActDelgCol,
	// inject a (mock) db into the module-level `db` used by the functions above
	__setTestDb: (mockDb) => { db = mockDb; },
	// set the chain totals used to turn vests into HP (tests only)
	__setChainTotals: (steem, vests) => { totalSteem = steem; totalVests = vests; },
};