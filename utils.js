var fs = require("fs");

const hive = require('@hiveio/hive-js');

const blurt = require('@blurtfoundation/blurtjs');

getConfig();

const fbadmin = require('firebase-admin');

let serviceAccount = require(config.GOOGLE_APPLICATION_CREDENTIALS);

fbadmin.initializeApp({
  credential: fbadmin.credential.cert(serviceAccount),
  databaseURL: config.databaseURL
});

var _ = require('lodash');
const axios = require('axios');
const dhive = require('@hiveio/dhive');

const dblurt = require('dblurt');

const moment = require('moment')



// const client = new dsteem.Client(config.active_node);
const hiveClient = new dhive.Client(config.alt_hive_nodes);
const blurtClient = new dblurt.Client(config.blurt_node);

		
var config;

// client.api.setOptions({ url: config.active_node });

//useless now with newer version of hive-js
//hive.config.set('rebranded_api', true)
//hive.broadcast.updateOperations()

hive.config.set('alternative_api_endpoints', config.alt_hive_nodes);
//hive.config.set('chain_id', '4200000000000000000000000000000000000000000000000000000000000000');

hive.api.setOptions({ url: config.active_hive_node});
try{
	// Blurt had NO failover at all. Two separate gaps closed it off:
	//
	// 1. config.alt_blurt_nodes was never read anywhere in this codebase - only
	//    blurt_node was - so Blurt ran on a single URL while Hive had the fallback
	//    list set just above.
	// 2. blurtjs gates its own rotation on `failover_threshold`, but its constructor
	//    only sets `error_threshold` (a different name), so notifyError() returns
	//    immediately and the rotation never runs. Its built-in default list is
	//    unusable anyway: ["https://rpc.blurt.world", "https://rpc.blurt.world"] -
	//    the same host twice, and that domain is now NXDOMAIN.
	//
	// So one dead node took Blurt down completely. That happened 2026-10-12: both
	// configured nodes went down together and validateAccountLogin started answering
	// "403 Invalid user", which the browser then showed as a CORS error.
	//
	// 3. and even with 1 and 2 fixed it would still not help, because notifyError()
	//    is only called from call() and signedCall(). Every generated method -
	//    getAccountsAsync included - goes through send() -> transport, which never
	//    notifies. The rotation that actually matters therefore lives in
	//    fetchOneAccount(), not here.
	//
	// Which makes the two options below worth setting but WORTH NOTHING TODAY: there
	// is currently no Blurt call()/signedCall() site in this repo, so the library path
	// they enable is unreachable. Keep them so that if one is ever added it inherits a
	// real endpoint list rather than the NXDOMAIN default - do not mistake them for
	// the working failover.
	//
	// Pass the list only when it is actually a non-empty array. setOptions assigns
	// alternative_api_endpoints BEFORE reading .length on it (lib/api/index.js:249
	// then :262), so an undefined throws. The try/catch here would swallow that, so
	// the process would survive - but it would survive with failover silently off,
	// which is the state this whole change exists to end.
	//
	// Keep config.blurt_node as alt_blurt_nodes[0]: setOptions looks options.url up
	// in that list to initialise api_index and defaults to 0 when it is absent, so a
	// primary missing from the list fails over to itself once before making progress.
	let blurtOpts = { url: config.blurt_node };
	if (Array.isArray(config.alt_blurt_nodes) && config.alt_blurt_nodes.length){
		blurtOpts.alternative_api_endpoints = config.alt_blurt_nodes;
		blurtOpts.failover_threshold = 3;
	}else{
		console.log('blurt: no alt_blurt_nodes configured - running with no failover');
	}
	blurt.api.setOptions(blurtOpts)
}catch(err){
	console.log(err)

}
var STEEMIT_100_PERCENT = 10000;
var STEEMIT_VOTE_REGENERATION_SECONDS = (5 * 60 * 60 * 24);
var HOURS = 60 * 60;

 var steemPrice;
 var rewardBalance;
 var recentClaims;
 var currentUserAccount;
 var votePowerReserveRate;
 var totalVestingFund;
 var totalVestingShares;
 var steem_per_mvests;
 var sbd_print_percentage;
 var botNames;
 let properties
 let totalVests
 let totalSteem
 let hiveProps
 let totalHive
 let totalHiveVests
 
 function setProperNode(bchain){
	if (bchain == "BLURT"){
		return blurt
	}else{
		return hive
	}
 }
 
 function setProperDNode(bchain){
	if (bchain == "BLURT"){
		return blurtClient
	}else{
		return hiveClient
	}
 }
 
 async function getChainInfo(bchain){
	let data = {};
	try{
	if (!bchain || bchain == ''){
		let chain_info = await hive.api.getDynamicGlobalPropertiesAsync();
		data['HIVE']=chain_info;
		chain_info = await blurt.api.getDynamicGlobalPropertiesAsync();
		data['BLURT']=chain_info;
	}else{
		let chainLnk = await setProperNode(bchain);
		let chain_info = await chainLnk.api.getDynamicGlobalPropertiesAsync();
		data[bchain]=chain_info;
	}
	}catch(err){
		console.log(err);
	}
	return data;
 }
  
// hive-js/blurt-js have NO request timeout. When a node stalls, the call never settles:
// the Express request hangs forever (that is what left /loginAuth spinning for 60s with
// zero bytes), and hive-js never fails over, because failover fires on an *error* and a
// hang produces none. Race every node read against a timeout so it fails fast instead.
const NODE_CALL_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label){
	let t;
	const timer = new Promise(function(_, reject){
		t = setTimeout(function(){
			reject(new Error('node call timed out after ' + ms + 'ms: ' + (label || 'hive call')));
		}, ms);
	});
	return Promise.race([promise, timer]).finally(function(){ clearTimeout(t); });
}

// Walking every endpoint multiplies the worst case by the length of the list, and
// each attempt can burn NODE_CALL_TIMEOUT_MS. app.js sets srvr.setTimeout(120000),
// and /getAccountData with no bchain does a Hive lookup AND a Blurt one in sequence,
// so an unbounded list read from config could outlive the socket. Cap the attempts
// so growing alt_blurt_nodes can never do that: 4 x 10s + 10s Hive = 50s, against a
// 120s socket timeout.
const MAX_BLURT_ENDPOINT_ATTEMPTS = 4;

// blurtjs exports a configured singleton (blurt.api) but not the class behind it.
// We need per-call instances - see fetchOneAccount - so take the constructor off the
// singleton. Verified it builds a working http client: new BlurtApi({url}) answers
// getAccountsAsync correctly and leaves blurt.api untouched.
const BlurtApi = blurt.api.constructor;

// Every Blurt endpoint we know of, primary first, de-duplicated.
//
// Normalise BEFORE filtering, not after: config carries both forms
// ("https://rpc.blurt.world/" as an alt against a slashless blurt_node), and an entry
// that is only slashes normalises to '' - which would otherwise survive as a blank
// endpoint and silently burn one of the attempts.
function blurtNodes(){
	let list = [config.blurt_node];
	if (Array.isArray(config.alt_blurt_nodes)) list = list.concat(config.alt_blurt_nodes);
	return list
		.map((n) => (n === null || n === undefined) ? '' : String(n).trim().replace(/\/+$/, ''))
		.filter((n) => /^https?:\/\/.+/i.test(n))
		.filter((n, i, a) => a.indexOf(n) === i)
		.slice(0, MAX_BLURT_ENDPOINT_ATTEMPTS);
}

// Run a dblurt read/broadcast against each configured Blurt endpoint until one
// succeeds. #120 added endpoint rotation for blurtjs (via fetchOneAccount) but the
// dblurt `blurtClient` used by createAccount was never covered, so a single dead
// Blurt node (HTTP 503 on 2026-10-12) threw straight out of createAccount and
// aborted an otherwise-healthy signup, Hive leg included. Like #120's final form we
// build a fresh client per attempt instead of re-pointing the shared singleton
// (which also serves payment verification and broadcasts elsewhere).
async function blurtCallWithFailover(run, label){
	let lastErr = null;
	for (const url of blurtNodes()){
		try{
			return await withTimeout(
				Promise.resolve(run(new dblurt.Client(url))),
				NODE_CALL_TIMEOUT_MS,
				'blurt ' + label + ' @' + url
			);
		}catch(err){
			lastErr = err;
			console.log('blurt failover: ' + label + ' failed @' + url + ' - ' + (err && err.message ? err.message : err));
		}
	}
	throw lastErr || new Error('blurt failover: no endpoints available for ' + label);
}

// Fetch one account, tolerating a node that stalls, errors, or (like a desynced node)
// answers 200 OK with result: null. Returns the account object, or null.
async function fetchOneAccount(chainLnk, account_name, label){
	// Hive keeps its original single-shot behaviour: hive-js already has working
	// alternative_api_endpoints wired up at module load, so a second layer here would
	// only multiply retries.
	if (chainLnk !== blurt){
		try{
			let account_res = await withTimeout(
				chainLnk.api.getAccountsAsync([account_name]),
				NODE_CALL_TIMEOUT_MS,
				label + ' getAccounts(' + account_name + ')'
			);
			if (Array.isArray(account_res) && account_res.length && account_res[0]) return account_res[0];
			// a broken/desynced node can answer 200 OK with result: null
			console.log(label + ': node returned no account data for ' + account_name);
			return null;
		}catch(err){
			console.log(label + ': account lookup failed for ' + account_name + ' - ' + (err && err.message ? err.message : err));
			return null;
		}
	}

	// Blurt walks the configured endpoints instead of giving up on the first one,
	// because a dead node used to be indistinguishable from a bad password:
	// fetchOneAccount returned null, validateAccountLogin turned that into
	// {result:false}, and /fetchUserData reported "403 Invalid user". On 2026-10-12
	// both configured nodes went down together and Blurt login broke outright.
	//
	// The rotation cannot use blurtjs's own failover: notifyError() - which does the
	// rotating - is only reached from call()/signedCall(), while every generated
	// method including getAccountsAsync goes through send() -> transport, which never
	// notifies. Driving getAccountsAsync at a dead primary with failover_threshold set
	// leaves error_count at 0 and never changes endpoint.
	//
	// EACH ATTEMPT GETS ITS OWN CLIENT, and blurt.api is never re-pointed. An earlier
	// revision rotated the shared singleton and restored it afterwards; three separate
	// problems came out of that, all of which this avoids by construction:
	//   - two overlapping walks interleaved, and the loser's "restore" wrote a dead
	//     endpoint over the winner's healthy one. Reproduced with two concurrent
	//     requests - and GET /getAccountData needs no auth and has no rate limit.
	//   - for the length of a walk, every OTHER Blurt caller on the singleton
	//     (getChainInfo, getTransactionAsync payment verification, every broadcast via
	//     processSteemTrx) was pointed at whatever node the walk had reached.
	//   - a broadcast straddling a rotation could take its TaPoS reference block from
	//     one node and broadcast to another.
	// Those callers now keep config.blurt_node exactly as they did before this change.
	// They still have no failover of their own - that is unchanged, not regressed, and
	// is worth a follow-up rather than widening this.
	const endpoints = blurtNodes();
	if (!endpoints.length){
		// Loud on purpose. Silence here would be the same undiagnosable failure this
		// change exists to end - config-example.json ships without these keys.
		console.log(label + ': no usable Blurt endpoint configured (check blurt_node / alt_blurt_nodes) - cannot look up ' + account_name);
		return null;
	}

	for (const endpoint of endpoints){
		const via = ' @' + endpoint;
		let api;
		try{
			api = new BlurtApi({ url: endpoint });
		}catch(err){
			console.log(label + ': could not build client' + via + ' - ' + (err && err.message ? err.message : err));
			continue;
		}
		try{
			let account_res = await withTimeout(
				api.getAccountsAsync([account_name]),
				NODE_CALL_TIMEOUT_MS,
				label + ' getAccounts(' + account_name + ')' + via
			);
			if (Array.isArray(account_res) && account_res.length && account_res[0]) return account_res[0];
			console.log(label + ': node returned no account data for ' + account_name + via);
		}catch(err){
			console.log(label + ': account lookup failed for ' + account_name + via + ' - ' + (err && err.message ? err.message : err));
		}
	}
	return null;
}

 async function getAccountData(account_name, bchain){
	let account = {};
	if (!bchain || bchain == ''){
		account['HIVE'] = await fetchOneAccount(hive, account_name, 'getAccountData HIVE');
		account['BLURT'] = await fetchOneAccount(blurt, account_name, 'getAccountData BLURT');
	}else{
		let chainLnk = await setProperNode(bchain);
		account[bchain] = await fetchOneAccount(chainLnk, account_name, 'getAccountData ' + bchain);
	}
	return account;
 }
 
 async function validateAccountLogin(username, priv_pkey, bchain){
	let chainLnk = await setProperNode(bchain);
	console.log('validateAccountLogin');
	// This lookup used to be unbounded and unguarded: a stalled node hung the login
	// request forever, and a node answering 200 OK with result: null threw
	// "Cannot read properties of null (reading '0')" and killed the API process.
	let acct = await fetchOneAccount(chainLnk, username, 'validateAccountLogin');
	if (!acct || !acct.posting || !acct.posting.key_auths || !acct.posting.key_auths.length){
		// node problem, not a bad password - fail fast rather than hanging the request
		console.log('validateAccountLogin: no usable account data for ' + username + ' (node issue?)');
		return {result: false, node_error: true};
	}
	let pub_pkey = acct.posting.key_auths[0][0];
	try{
		let res = await chainLnk.auth.wifIsValid(priv_pkey, pub_pkey);
		console.log(res);
		return {result: res, account: acct};
	}catch(err){
		console.log(err);
		return {result:false};
	}
 }
 
  async function encodeMemo(memo, userPubKey, bchain){
	let chainLnk = await setProperNode(bchain);
	console.log('utils decodememo')
	memo = '#'+memo;
	let encoded_msg = await chainLnk.memo.encode(config.full_pay_ac_key, userPubKey, memo); 
	console.log(encoded_msg);
	return encoded_msg;
 }
 
 async function decodeMemo(memo, userKey, bchain){
	let chainLnk = await setProperNode(bchain);
	console.log('utils decodememo')
	let decrypted = await chainLnk.memo.decode(userKey, memo); 
	console.log(decrypted);
	return decrypted;
 }
 
 async function processSteemTrx(ops, userKey, bchain, db, active){
	console.log('utils processSteemTrx');
	//console.log(operation);
	//const ops = [ operation ];
	console.log('>>>>>>>>>>>> selected bchain <<<<<<<<<<');
	console.log(ops);
	
	let chainLnk = await setProperNode(bchain);
	let tx;
	//console.log('using active:'+active);
	//console.log(userKey);
	if (active){
		console.log('active key')
		tx = await chainLnk.broadcast.sendAsync( 
		   { operations: ops, extensions: [] },
		   { active: active }
		).catch(err => {
			console.log(err.message);
			return {error: err.message};
		});
	}else{
		console.log('posting')
		tx = await chainLnk.broadcast.sendAsync( 
		   { operations: ops, extensions: [] },
		   { posting: userKey }
		).catch(err => {
			console.log(err.message);
			return {error: err.message};
		});
	}
	//store the trx also to actifit as verified
	
	//console.log(tx);
	
	if (tx && tx.ref_block_num){
		let tx_entry = {
			tx_id: tx.id,
			ref_block_num: tx.ref_block_num,
			tx: tx,
			date: new Date(),
		};
		try{
			let transaction = await db.collection('verified_tx').insertOne(tx_entry);
			console.log('success inserting transaction details');
		}catch(err){
			console.log(err);
		}
	}
	
	console.log(tx);
	return {tx: tx};
 }
 
 async function purchaseRealProd(req){
	console.log('performing purchase on blockchain');
	
	//broadcast trx to blockchain
	let cstm_params = {
		required_auths: [],
		required_posting_auths: [req.query.user],
		id: 'actifit',
		json: "{ \"buy_product\": \""+req.body.product_id+"\", \"afit_paid\": "+req.body.afit_amount+", \"hive_paid\": "+req.body.hive_amount+"}"
	};
	
	let keys = { posting: req.query.userKey };
	
	let ops = [
				[ 'custom_json', cstm_params ],
				
			  ];
	let payAmount = parseFloat(req.body.hive_amount).toFixed(3);//
	if (payAmount > 0){
		let memo = 'actifit buy_real_product '+req.body.product_id;
		let trans_params = {
						from: req.query.user,
						to: config.escrow_account,
						amount: payAmount+' HIVE',//"{ \"amount\": \""+ payAmount + " HIVE\", \"precision\": \"3\", \"nai\": \"@@000000021\"}",
						memo: memo
					  }
		//no need for posting key, just auth key, otherwise it would fail
		cstm_params.required_auths = [req.query.user];
		cstm_params.required_posting_auths = [];
		ops = [
				[ 'custom_json', cstm_params ],
				[ 'transfer', trans_params]
			  ];
		keys = { active: req.body.active_key };
	}
	let chainLnk = await setProperNode(req.query.bchain);
	//console.log(keys);
	let tx = await chainLnk.broadcast.sendAsync( 
		   { operations: ops, extensions: [] },
		   keys
		).catch(err => {
			console.log(err.message);
			return {error: err.message};
		});
	console.log('result');
	console.log(tx);
		
	/*let transfer_trx = 
				  */
	return {tx: tx};
	 
 }
 
 function updateSteemVariables(bchain) {
	 let chainLnk = setProperNode(bchain);
     chainLnk.api.getRewardFund("post", function (e, t) {
         console.log(e,t);
         rewardBalance = parseFloat(t.reward_balance.replace(" STEEM", "").replace(" HIVE", ""));
         recentClaims = t.recent_claims;
     });
     chainLnk.api.getCurrentMedianHistoryPrice(function (e, t) {
         steemPrice = parseFloat(t.base.replace(" SBD", "")) / parseFloat(t.quote.replace(" STEEM", "").replace(" HIVE", ""));
     });
     chainLnk.api.getDynamicGlobalProperties(function (e, t) {
         votePowerReserveRate = t.vote_power_reserve_rate;
         totalVestingFund = parseFloat(t.total_vesting_fund_steem.replace(" STEEM", "").replace(" HIVE", ""));
         totalVestingShares = parseFloat(t.total_vesting_shares.replace(" VESTS", ""));
		 steem_per_mvests = ((totalVestingFund / totalVestingShares) * 1000000);
		 sbd_print_percentage = t.sbd_print_rate / 10000
		 console.log(steem_per_mvests);
		 console.log(sbd_print_percentage);
     });

     setTimeout(updateSteemVariables, 180 * 1000, bchain)
 }
 // updateSteemVariables();
 
	//fixed implementation of proper voting power calculation
	function getVotingPower(account) {
		// Account data is missing whenever the node call above failed. Dereferencing it
		// blind threw "Cannot read properties of undefined (reading 'vesting_shares')" as
		// an UNHANDLED rejection, killing the API process. Return 0 instead.
		if (!account || !account.vesting_shares || !account.voting_manabar) {
			console.log('getVotingPower: no account data (node call likely failed) - returning 0');
			return 0;
		}
		const totalShares = parseFloat(account.vesting_shares) + parseFloat(account.received_vesting_shares) - parseFloat(account.delegated_vesting_shares) - parseFloat(account.vesting_withdraw_rate);

            const elapsed = Math.floor(Date.now() / 1000) - account.voting_manabar.last_update_time;
            const maxMana = totalShares * 1000000;
            // 432000 sec = 5 days
            let currentMana = parseFloat(account.voting_manabar.current_mana) + elapsed * maxMana / 432000;

            if (currentMana > maxMana) {
                currentMana = maxMana;
            }

            const currentManaPerc = currentMana * 100 / maxMana;
			console.log(currentManaPerc);
			console.log(account.name);
		return currentManaPerc;
	}
	
	async function getNewRC(account_name, chain){
		let chainLnk = await setProperDNode(chain);
		console.log(chainLnk);
		let rcComponent = await chainLnk.rc.getRCMana(account_name);
		let currentRC = rcComponent.percentage/100;
		let currentRCPercent = currentRC + '%';
		return {account: account_name, currentRC: currentRC, currentRCPercent: currentRCPercent}
	}
	
	//implement a get current Resource Credits function for normal operations consumption
	async function getRC(account_name){
		
		var data={"jsonrpc":"2.0","id":1,"method":"condenser_api.get_account_count","params":{}};
		//return new Promise(function(fulfill,reject){
			//var request = require("request");
			let location = config.active_node;
			var response = await axios.post(location, {"jsonrpc":"2.0","id":1,"method":"rc_api.find_rc_accounts","params":{"accounts":[account_name]}});
			
			console.log(response.data.result.rc_accounts);
			
			
			
			const STEEM_RC_MANA_REGENERATION_SECONDS =432000;
			const estimated_max = parseFloat(response.data.result.rc_accounts["0"].max_rc);
			const current_mana = parseFloat(response.data.result.rc_accounts["0"].rc_manabar.current_mana);
			const last_update_time = parseFloat(response.data.result.rc_accounts["0"].rc_manabar.last_update_time);
			const diff_in_seconds = Math.round(Date.now()/1000-last_update_time);
			let estimated_mana = (current_mana + diff_in_seconds * estimated_max / STEEM_RC_MANA_REGENERATION_SECONDS);
			if (estimated_mana > estimated_max)
				estimated_mana = estimated_max;
			const estimated_pct = estimated_mana / estimated_max * 100;
			const res= {"current_mana": current_mana, "last_update_time": last_update_time,
				  "estimated_mana": estimated_mana, "estimated_max": estimated_max, "estimated_pct": estimated_pct.toFixed(2),"fullin":timeTilFullPower(estimated_pct*100)};
			return res;
			
		//});
	}
	
	//function handles confirming if AFIT from SE were received
	async function confirmAFITXTransition (targetUser, txid, amount, bchain, standardAfit) {
		getConfig();
		//track attempts for timeout
		let attempts = 1;
		let max_attempts = 15;
		return new Promise((resolve, reject) => {
			let th_id = setInterval(async function(){
				if (attempts < max_attempts){
					attempts += 1;
					console.log('Check Move');
					//let's call the service by S-E
					let url = new URL(config.hive_engine_afitx_trx);
					if (standardAfit == 1){
						url = new URL(config.hive_engine_afit_trx);
					}

					//connect with our service to confirm AFIT received to proper wallet
					try{
						let se_connector = await fetch(url, { signal: AbortSignal.timeout(15000) });
						let trx_entries = await se_connector.json();
						console.log(trx_entries);
						let match_trx;
						
						//check if we have a proper entry matching user transfer
						if (match_trx = trx_entries.find(trx => (trx.from == targetUser && parseFloat(trx.quantity) == parseFloat(amount) && trx.transactionId == txid))) {
							//found match, let's make sure transaction is recent enough
							console.log('found match');
							let paymentFound = true;
							if (paymentFound){
								//need to look again
								console.log('found');
								clearInterval(th_id);
								resolve(match_trx);
							}
						}
					}catch(err){
						console.log(err);
					}
				}else{
					//return error
					resolve(null);
				}
			}, 5000);
		});
	}
	
	async function proceedAfitxMove (targetAcct, amount, chain, standardAfit){

		let transId = 'ssc-mainnet-hive';
		//let targetBchain = 'STEEM';
		//other option is moving tokens from H-E to S-E

		let tokenSymbol = 'AFITX';
		if (standardAfit == 1){
			tokenSymbol = 'AFIT';
		}
		
		let json_data = {
			contractName: 'tokens',
			contractAction: 'transfer',
			contractPayload: {
				symbol: tokenSymbol,
				to: targetAcct,
				quantity: amount.toFixed(6),//needs to be string and a max of 6 digits supported
				memo: ''
			}
		}
		
		//send out transaction to blockchain
		let chainLnk = await setProperNode(chain);
		let tx = await chainLnk.broadcast.customJsonAsync(
				config.active_key, 
				[ config.account ] , 
				[], 
				transId, 
				JSON.stringify(json_data)
			).catch(err => {
				console.log(err.message);
		});
	}
	
	
	//function handles fetching tip transactions
	async function verifyTipTransactions(db){
		let url = new URL(config.hive_engine_tip_trans_his);
		//connect with our service to confirm AFIT received to proper wallet
		try{
			let he_connector = await fetch(url, { signal: AbortSignal.timeout(15000) });
			let trx_entries = await he_connector.json();
			
			for (const entry of trx_entries){
			//trx_entries.forEach(async function (entry){
				let quant = parseFloat(entry.quantity);
				let user = entry.from
				//if this is a send transaction, need to decrease balance
				if (entry.from == config.tip_account){
					quant = -1 * quant;
					//validate this is a proper tipping transaction
					if (entry.memo != null){
						user = entry.memo;
					}
				}
				if (entry.symbol != 'AFIT' ){
					//skip as currently we only support AFIT tipping
					continue;
				}
				//query to see if entry already stored
				let tokenTransQuery = {
					user: user,
					timestamp: entry.timestamp,
					operation: "tokens_transfer",
					symbol: entry.symbol,
					quantity: quant
				}
				//store the transaction to the user's profile
				let newTokenTrans = {
					user: user,
					timestamp: entry.timestamp,
					operation: "tokens_transfer",
					symbol: entry.symbol,
					quantity: quant
				}
				try{
					//console.log(newTokenTrans);
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('tip_transfers').update(tokenTransQuery, newTokenTrans, { upsert: true });
					let trans_res = transaction.result;
					//console.log(trans_res);
					
					//transaction inserted
					//if (trans_res.upserted){
					//	console.log('success');
					//}
					
				}catch(erra){
					console.log(erra);
				}
			};
			return "{success: true}";
					
			//let match_trx;
		}catch(err){
			console.log(err);
			return "{success: false, err:"+err+"}";
		}
	}
	
	async function updateTipBalances (db){
	
		try{
			//group all token transactions per user, and sum them to generate new total count
			let query = await db.collection('tip_transfers').aggregate([
				{ $group: { _id: "$user", tip_balance: { $sum: "$quantity" } } },
				{ $sort: { tokens: -1 } },
				{ $project: { 
					 _id: "$_id",
					 user: "$_id",
					 tip_balance: "$tip_balance",
					 }
				 }
				])
		
			let user_tokens = await query.toArray();
			//remove old token count per user
			await db.collection('tip_balance').deleteMany({});
			//insert new count per user
			await db.collection('tip_balance').insertOne(user_tokens);
			console.log('---- Updating User Tip Balances Complete ----');
			return "{success: true}";
		}catch(err){
			console.log('>>save data error:'+err.message);
			return "{success:false, err: "+err+"}";
		}
		
	}
	
	//function handles confirming if AFIT from SE were received
	async function confirmSEAFITReceived (targetUser, bchain) {
		getConfig();
		//track attempts for timeout
		let attempts = 1;
		let max_attempts = 15;
		return new Promise((resolve, reject) => {
			let th_id = setInterval(async function(){
				if (attempts < max_attempts){
					attempts += 1;
					console.log('Check AFIT Power Up');
					//let's call the service by S-E
					let url = new URL(config.hive_engine_trans_acct_his);

					//connect with our service to confirm AFIT received to proper wallet
					try{
						let se_connector = await fetch(url, { signal: AbortSignal.timeout(15000) });
						let trx_entries = await se_connector.json();
						
						let match_trx;
						
						//check if we have a proper entry matching user transfer
						if (match_trx = trx_entries.find(trx => trx.from == targetUser)) {
							//found match, let's make sure transaction is recent enough
							console.log('found match');
							let paymentFound = true;
							if (paymentFound){
								//need to look again
								console.log('found');
								clearInterval(th_id);
								resolve(match_trx);
							}
						}
					}catch(err){
						console.log(err);
					}
				}else{
					//return error
					resolve(null);
				}
			}, 5000);
		});
	}
	
	function customArraysEqual(op1, op2){
		try{
			return _.isEqual(op1, op2);
		}catch(err){
			console.log(err);
			console.log('error matching')
			return false;
		}
	}
	
	function arraysEqual(array1, array2) {
	  if (array1.length !== array2.length) return false;
	  for (let i = 0; i < array1.length; i++) {
		if (Array.isArray(array1[i]) && Array.isArray(array2[i])) {
		  if (!arraysEqual(array1[i], array2[i])) return false;
		} else if (typeof array1[i] === 'object') {
		  if (JSON.stringify(array1[i]) !== JSON.stringify(array2[i])) return false;
		} else {
		  if (array1[i] !== array2[i]) return false;
		}
	  }
	  return true;
	}
	

	async function storeVerifiedTrx(tx, db){
		console.log('store transaction')
		console.log(tx);
		if (tx && tx.ref_block_num){
			let tx_entry = {
				tx_id: tx.transaction_id,
				ref_block_num: tx.ref_block_num,
				tx: tx,
				date: new Date(),
			};
			try{
				let transaction = await db.collection('verified_tx').insertOne(tx_entry);
				console.log('success inserting transaction details');
			}catch(err){
				console.log(err);
			}
		}
	}
	
	async function findVerifyTrx (req, db, nostore){
		getConfig();
		console.log('findverify')
		let bchain = req.query.bchain?req.query.bchain:'HIVE'
		
		//first check trx to see if it has been processed
		let trx = await db.collection('verified_tx').findOne({tx_id: req.params.trxID});
		//this shouldnt be there, so if it is skip
		if (trx){
			
			return ({error: 'trx already exists'});
		}
		//track attempts for timeout
		let attempts = 1;
		let max_attempts = 30;
		let fv_th_id;
		let matchFound = false;
		let matchTrx;
				
		return new Promise((resolve, reject) => {
			fv_th_id = setInterval(async function(){
				if (attempts < max_attempts){
					attempts += 1;
					let chainLnk = await setProperNode(bchain);
					console.log('check trx');
					//transactions = await hiveClient.database.call('get_transaction', req.query.txid);
					matchTrx = await chainLnk.api.getTransactionAsync(req.params.trxID);
					console.log(matchTrx);
					
					//chainLnk.api.getAccountHistory(config.signup_account, -1, 1000, (err, transactions) => {
					
					if (matchTrx && matchTrx.transaction_id && Array.isArray(matchTrx.operations)){
						console.log('potential match')
						//need to stringify first part as the second is already stringified
						if (customArraysEqual(matchTrx.operations, JSON.parse(req.query.operation))){
						//if (customArraysEqual(JSON.stringify(matchTrx.operations), req.query.operation)){
						//if (arraysEqual(JSON.stringify(matchTrx.operations), req.query.operation)){
							let now = moment(new Date()); //todays date
							let end = moment(matchTrx.expiration); // last update date
							let duration = moment.duration(now.diff(end));
							let hrs = duration.asHours();
							//transaction needs to have been concluded within 7 hours.
							console.log(hrs);
							if (hrs < 7){
								matchFound = true;
								//break;
								
								if (nostore){
									
								}else{
									//store transaction
									await storeVerifiedTrx(matchTrx, db);
								}
							}
						}
						
					}
				}else{
					console.log('not found after '+attempts+' attempts');
					clearInterval(fv_th_id);
					resolve(false);
				}
				if (matchFound){
					//need to look again
					console.log('found');
					clearInterval(fv_th_id);
					resolve(matchTrx);
				}
				//});
			}, 5000);
		});
	}
	
	
	//function handles confirming if payment was received
	// --- signup payment amount: SERVER-SIDE gate --------------------------------------------------
	// The required crypto amount is computed from OUR signup cost + a live USD price, never from the
	// client-supplied steem_invest (a tampered APK could send any figure and create an account for
	// ~nothing). Prices cached ~5 min so the per-signup 5s poll doesn't hammer the price API.
	let _sgPriceCache = { ts: 0, hive: null, hbd: null, failTs: 0 };
	async function signupUsdPrices () {
		const now = Date.now();
		// serve a fresh success from cache (5 min)
		if (_sgPriceCache.hive && (now - _sgPriceCache.ts) < 5 * 60 * 1000) {
			return _sgPriceCache;
		}
		// negative cache: after a failure, don't re-hit CoinGecko (or stall 8s) again for 45s.
		// This stops a burst of concurrent signups stampeding the API during an outage.
		if (!_sgPriceCache.hive && _sgPriceCache.failTs && (now - _sgPriceCache.failTs) < 45 * 1000) {
			return _sgPriceCache;
		}
		try {
			let q = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive,hive_dollar&vs_currencies=usd',
				{ signal: AbortSignal.timeout(8000) });
			let d = await q.json();
			let hive = (d && d.hive) ? d.hive.usd : null;
			let hbd = (d && d.hive_dollar) ? d.hive_dollar.usd : null;
			if (hive) { _sgPriceCache = { ts: Date.now(), hive: hive, hbd: hbd || 1.0, failTs: 0 }; }
			else { _sgPriceCache = Object.assign({}, _sgPriceCache, { failTs: Date.now() }); }
		} catch (e) {
			_sgPriceCache = Object.assign({}, _sgPriceCache, { failTs: Date.now() });
			console.log('signup price fetch failed: ' + (e && e.message));
		}
		return _sgPriceCache;
	}

	// Test-only: clear the module-level price cache so unit tests can exercise the
	// CoinGecko-up / CoinGecko-down branches independently. No production caller.
	function _resetSignupPriceCache () {
		_sgPriceCache = { ts: 0, hive: null, hbd: null, failTs: 0 };
	}

	// Returns the minimum acceptable on-chain amount for the signup currency. The figure is
	// derived ENTIRELY server-side (our USD cost + a server-sourced price); the client's
	// steem_invest is never trusted. botHivePrice is app.js's regularly-refreshed hivePrice
	// global ({hive:{usd}}), used as a fallback so we rarely need the blind floor.
	async function signupRequiredCrypto (sentCur, botHivePrice) {
		// Validate the configured cost: a non-numeric value would make requiredCrypto NaN and
		// silently reject EVERY signup (stuck-verifying); 0/negative would open the gate to dust.
		const cfgCost = parseFloat(config && config.signupCostUsd);
		const costUsd = (isFinite(cfgCost) && cfgCost > 0) ? cfgCost : 2.0;
		const TOLERANCE = 0.10; // absorb price drift (send -> confirm) + the client's 3-dp rounding
		const isHbd = (sentCur === 'HBD' || sentCur === 'SBD');
		const prices = await signupUsdPrices();
		let unit = isHbd ? prices.hbd : prices.hive;
		// Fallback 1 (HIVE): the bot's own recently-refreshed price (server-side, never the client).
		if ((!unit || unit <= 0) && !isHbd && botHivePrice && botHivePrice.hive
			&& isFinite(parseFloat(botHivePrice.hive.usd))) {
			unit = parseFloat(botHivePrice.hive.usd);
		}
		// Fallback 2 (HBD): HBD is dollar-pegged; assume ~$1 when no live quote is available.
		if ((!unit || unit <= 0) && isHbd) {
			unit = 1.0;
		}
		// Last resort (HIVE): no price anywhere (CoinGecko AND the bot's cached price both down).
		// Assume a deliberately LOW HIVE price so the requirement stays close to the USD cost
		// instead of collapsing to a sub-dollar floor. Config-overridable; revisit if HIVE moves
		// a lot (HIVE ~= $0.044 today -> $0.05 assumption ~= 36 HIVE for a $2 signup).
		if (!unit || unit <= 0) {
			const fbHive = parseFloat(config && config.signupFallbackHiveUsd);
			unit = (isFinite(fbHive) && fbHive > 0) ? fbHive : 0.05;
		}
		return (costUsd / unit) * (1 - TOLERANCE);
	}

	async function confirmPaymentReceived (req, bchain, botHivePrice) {
		getConfig();
		//stop polling after a bounded window. without this a memo that is never
		//paid leaves an interval hammering the chain forever, and the caller's
		//await never returns (so its keep-alive interval never clears either).
		const pollDeadline = Date.now() + ((config.signupPaymentTimeoutMins || 15) * 60 * 1000);
		// SERVER decides sufficiency — compute the required amount ONCE (not per 5s poll tick),
		// from our cost + a server-sourced price, never from the client's steem_invest.
		const requiredCrypto = await signupRequiredCrypto(req.query.sent_cur, botHivePrice);
		console.log('signup required (server, ' + req.query.sent_cur + '): ' + requiredCrypto
			+ ' | client steem_invest=' + req.query.steem_invest);
		return new Promise((resolve, reject) => {
			//th_id MUST be local: a shared/global interval handle means one call's
			//clearInterval() clears a *different* concurrent call's interval, leaving
			//the original as an immortal zombie that re-logs its timeout every 5s and
			//kills every newer signup poll (no 'check funds', no match, no account).
			let th_id = setInterval(async function(){
				if (Date.now() > pollDeadline){
					console.log('signup payment poll timed out for memo '+req.query.memo);
					clearInterval(th_id);
					resolve('');
					return;
				}
				//let chainLnk = await setProperNode(bchain);
				console.log('check funds');
				
				let transactions;
				//transactions.reverse()
				  
				
				transactions = await hiveClient.database.call('get_account_history', [config.signup_account, -1, 20]);
				
				//chainLnk.api.getAccountHistory(config.signup_account, -1, 1000, (err, transactions) => {
				let tx_id = '';
				let paymentFound = false;
				for (let txs of transactions) {
					let op = txs[1].op
					
					//check if we received a transfer to our target account
					//if we found a transfer operation sent to our target account, with the correct memo and the proper amount, proceed
					if (op[0] === 'transfer'){
						let sentAmount = op[1].amount.split(' ')[0];
						let sentCur = op[1].amount.split(' ')[1];
						
						if (op[1].to === config.signup_account 
							&& op[1].memo === req.query.memo 
							&& parseFloat(sentAmount) >= requiredCrypto
							&& sentCur === req.query.sent_cur){  
							console.log(op[1]);
							
							let now = moment(new Date()); //todays date
							let end = moment(txs[1].timestamp); // last update date
							let duration = moment.duration(now.diff(end));
							let hrs = duration.asHours();
							//transaction needs to have been concluded within 5 hours.
							if (hrs < 5){
								tx_id = txs[1].trx_id;
								//record what was ACTUALLY received on chain. callers must
								//anchor any reward calculation to this, never to a
								//client-supplied amount.
								req.verified_payment = {
									amount: parseFloat(sentAmount),
									currency: sentCur
								};
								paymentFound = true;
								break;
							}
						}
					}
				}
				if (paymentFound){
					//need to look again
					console.log('found');
					clearInterval(th_id);
					resolve(tx_id);
				}
				//});
			}, 5000);
		});
	}
	
	//function handles confirming if payment was received
	async function confirmPaymentReceivedPassword (req, bchain) {
		getConfig();
		console.log('confirmPaymentReceivedPassword');
		return new Promise((resolve, reject) => {
			let th_id = setInterval(async function(){
				console.log('check funds');
				console.log(bchain);
				//let chainLnk = await setProperNode(bchain);
				
				let transactions;
				//transactions.reverse()
				  
				
				transactions = await hiveClient.database.call('get_account_history', [config.exchange_account, -1, 300]);
				console.log("newestTxId:"+transactions[0][0]);

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
							if (op[1].to === config.exchange_account && op[1].from === req.query.from && sentAmount >= 1){  
								console.log(op[1]);
								
								tx_id = txs[1].trx_id;
								paymentFound = true;
								break;
							}
						}
					}
					if (paymentFound){
						//need to look again
						console.log('found');
						clearInterval(th_id);
						resolve(tx_id);
					}
			}, 5000);
		});
	}
	
	//function handles confirming if payment was received
	async function confirmPaymentReceivedBuy (req, bchain) {
		getConfig();
		console.log('confirmPaymentReceivedBuy');
		return new Promise((resolve, reject) => {
			let th_id = setInterval(async function(){
				console.log('check buy funds');
				//let chainLnk = await setProperNode(bchain);
				
				let transactions;
				transactions = await hiveClient.database.call('get_account_history', [config.buy_account, -1, 800]);
				console.log("newestTxId:"+transactions[0][0]);

					let tx_id = '';
					let paymentFound = false;
					for (let txs of transactions) {
						let op = txs[1].op
						//check if we received a transfer to our target account
						//if we found a transfer operation sent to our target account, with the correct sender and the proper amount, proceed
						if (op[0] === 'transfer'){
							let sentAmount = op[1].amount.split(' ')[0];
							if (op[1].to === config.buy_account && op[1].from === req.query.from && sentAmount === req.query.steem_amount){  
								console.log(op[1]);
								
								let now = moment(new Date()); //todays date
								let end = moment(txs[1].timestamp); // last update date
								let duration = moment.duration(now.diff(end));
								let hrs = duration.asHours();
								//transaction needs to have been concluded within 5 hours.
								if (hrs < 5){
									tx_id = txs[1].trx_id;
									paymentFound = true;
									break;
								}
							}
						}
					}
					if (paymentFound){
						//need to look again
						console.log('found');
						clearInterval(th_id);
						resolve(tx_id);
					}
			}, 5000);
		});
	}
	
	
	
	//function handles claiming spots for accounts
	async function claimDiscountedAccount(chain){
		console.log('claimDiscountedAccount');
		if (typeof config == 'undefined' || config == null){
			getConfig();
		}
		const claim_op = [
			'claim_account',
			{
				creator: config.account,
				fee: '0.000 STEEM',
				extensions: [],
			}
		];
		const ops = [claim_op];
		
		let result = '';
		let outcHive = false;
		if (!chain || chain.includes('HIVE')){
			try{
				const privateKey = dhive.PrivateKey.fromString(
							config.active_key
						);
				result = await hiveClient.broadcast.sendOperations(ops, privateKey);
				console.log('success');
				outcHive = true;
			}catch(err){
				console.log(err);
				outcHive = false;
			}
		}
		return outcHive;
	}
	
	//function handles creating accounts via discounted claimed spots or normal paid method
	async function createAccount (username, password, chain){
		if (typeof config == 'undefined' || config == null){
			getConfig();
		}

		// A node outage on ONE chain must never abort the whole signup. Each chain's
		// existence check is wrapped so that if its node(s) are unreachable we skip
		// creating on that chain and still create on the healthy one(s). Incident
		// 2026-10-12: a Blurt HTTP 503 in the un-guarded dblurt existence check threw
		// out of here and killed an otherwise-healthy Hive signup.
		// WHICH chains the caller asked for. An absent/empty cur_bchain means "both" -
		// app.js passes req.query.cur_bchain straight through with no validation, so
		// that is reachable from any client that omits it.
		const wantHive = !chain || chain.includes('HIVE');
		const wantBlurt = !chain || chain.includes('BLURT');

		let skipHive = false;
		let skipBlurt = false;
		let hiveExists = false;
		let blurtExists = false;
		let blurtExistingOwnerKey = null;

		if (wantHive){
			//check if account exists
			try{
				const _account = await hiveClient.database.call('get_accounts', [[username]]);
				//account not available to register
				if (_account.length>0) {
					console.log('account already exists on HIVE');
					hiveExists = true;
				}
			}catch(err){
				console.log('hive existence check failed, skipping Hive creation - ' + (err && err.message ? err.message : err));
				skipHive = true;
			}
		}

		if (wantBlurt){
			//check if account exists (rotates Blurt endpoints; a dead node skips Blurt, not the signup)
			try{
				const _account = await blurtCallWithFailover(
					(c) => c.database.call('get_accounts', [[username]]),
					'get_accounts ' + username
				);
				//account not available to register
				if (_account.length>0) {
					console.log('account already exists on BLURT');
					blurtExists = true;
					blurtExistingOwnerKey = (_account[0] && _account[0].owner && Array.isArray(_account[0].owner.key_auths)
						&& _account[0].owner.key_auths[0]) ? _account[0].owner.key_auths[0][0] : null;
				}
			}catch(err){
				console.log('blurt existence check failed, skipping Blurt creation - ' + (err && err.message ? err.message : err));
				skipBlurt = true;
			}
		}

		// "Already exists" is only a refusal for the chain the caller is actually paying
		// for. It used to abort the WHOLE call from either check, which made a retry
		// after a partial creation impossible: the first attempt could create the Blurt
		// account and fail on Hive, and every retry then tripped the Blurt check and
		// returned false before reaching Hive. The user could never obtain the Hive
		// account they paid for.
		if (wantHive && hiveExists){
			console.log('createAccount: ' + username + ' already exists on HIVE - cannot create');
			return false;
		}
		if (!wantHive && wantBlurt && blurtExists){
			console.log('createAccount: ' + username + ' already exists on BLURT - cannot create');
			return false;
		}
		// An existing Blurt account is either OURS - created by an earlier attempt that
		// then failed on Hive, which is exactly the case this function has to let the
		// user finish - or it belongs to a stranger who happens to hold that name on
		// Blurt. Those need opposite answers, and `blurtExists` alone cannot tell them
		// apart, so derive the owner key from the credentials in hand: a retry uses the
		// same username and password, so the derived key matches what is on chain.
		// A stranger's will not.
		let blurtIsOurs = false;
		if (blurtExists){
			try{
				const expectedOwner = dblurt.PrivateKey.fromLogin(username, password, 'owner').createPublic().toString();
				// Compare the key material, not the prefix, so a BLT/STM mismatch between
				// library versions cannot read as "a stranger owns this".
				blurtIsOurs = !!blurtExistingOwnerKey
					&& String(blurtExistingOwnerKey).slice(3) === String(expectedOwner).slice(3);
			}catch(err){
				console.log('createAccount: could not derive the Blurt owner key for ' + username + ' - ' + (err && err.message ? err.message : err));
				blurtIsOurs = false;
			}
		}

		// Someone else holds the name on Blurt. Refuse before creating anything, which is
		// what the pre-per-chain code did for ANY existing account. Without this, a user
		// who ticked Blurt - and is charged double for it by the web client - would get
		// the Hive account, be told "success", and silently never receive the Blurt one.
		if (wantBlurt && blurtExists && !blurtIsOurs){
			console.log('createAccount: ' + username + ' already exists on BLURT under different keys - refusing rather than delivering a partial signup');
			return false;
		}
		if (blurtExists){
			// Ours, from an earlier half-completed attempt. Nothing to create - but it
			// must not block the Hive leg, which is the whole point.
			console.log('createAccount: ' + username + ' already exists on BLURT from an earlier attempt - skipping the Blurt leg');
		}

		console.log('account available');


		//container for required ops
		let hiveOps = [];
		let blurtOps = [];

		//if we have discounted accounts still available, let's do that, otherwise let's pay for account
		let creator = config.account;

		let hiveAccountSuccess = false;
		let blurtAccountSuccess = false;

		if (wantHive && !skipHive && !hiveExists){
			//whole leg wrapped so a creator-lookup/broadcast failure fails only Hive, not Blurt
			try{
				const _creator_account = await hiveClient.database.call('get_accounts', [
					[creator],
				]);
				console.log('current pending claimed accounts: ' + _creator_account[0].pending_claimed_accounts);

				//create keys for new account
				const ownerKey = dhive.PrivateKey.fromLogin(username, password, 'owner');
				const activeKey = dhive.PrivateKey.fromLogin(username, password, 'active');
				const postingKey = dhive.PrivateKey.fromLogin(username, password, 'posting');
				let memoKey = dhive.PrivateKey.fromLogin(username, password, 'memo').createPublic();

				//create auth values for passing to account creation
				const ownerAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[ownerKey.createPublic(), 1]],
				};
				const activeAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[activeKey.createPublic(), 1]],
				};
				const postingAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[postingKey.createPublic(), 1]],
				};

				if (_creator_account[0].pending_claimed_accounts > 0) {

					//the create discounted account operation
					const create_op = [
						'create_claimed_account',
						{
							creator: creator,
							new_account_name: username,
							owner: ownerAuth,
							active: activeAuth,
							posting: postingAuth,
							memo_key: memoKey,
							json_metadata: '',
							extensions: [],
						}
					];
					hiveOps.push(create_op);
				}else{

					const create_op = [
						'account_create',
						{
							fee: '3.000 HIVE',
							creator: creator,
							new_account_name: username,
							owner: ownerAuth,
							active: activeAuth,
							posting: postingAuth,
							memo_key: memoKey,
							json_metadata: '',
							extensions: [],
						}
					];
					hiveOps.push(create_op);
				}

				const privateKey = dhive.PrivateKey.fromString(config.active_key);
				//proceed executing the selected operation(s)
				await hiveClient.broadcast.sendOperations(hiveOps, privateKey);
				console.log('success');
				hiveAccountSuccess = true;
			}catch(err){
				console.log(err);
				hiveAccountSuccess = false;
			}
		}

		// Gated on the Hive outcome: if Hive was requested and did not land, this call is
		// about to return false, the caller will store nothing, and the user will retry.
		// Broadcasting the Blurt account anyway spends 100.000 BLURT on an account no
		// record will ever reference and nothing reconciles.
		const blurtWouldBeOrphaned = wantHive && !hiveAccountSuccess;
		if (blurtWouldBeOrphaned && wantBlurt && !skipBlurt && !blurtExists){
			console.log('createAccount: skipping the Blurt leg for ' + username + ' - the Hive leg did not land, so the signup fails and a Blurt account would be orphaned');
		}
		if (wantBlurt && !skipBlurt && !blurtExists && !blurtWouldBeOrphaned){
			//whole leg wrapped so a creator-lookup/broadcast failure fails only Blurt, not Hive
			try{
				const _creator_account = await blurtCallWithFailover(
					(c) => c.database.call('get_accounts', [[creator]]),
					'get_accounts ' + creator
				);
				console.log('current pending claimed accounts: ' + _creator_account[0].pending_claimed_accounts);

				//create keys for new account
				const ownerKey = dblurt.PrivateKey.fromLogin(username, password, 'owner');
				const activeKey = dblurt.PrivateKey.fromLogin(username, password, 'active');
				const postingKey = dblurt.PrivateKey.fromLogin(username, password, 'posting');
				let memoKey = dblurt.PrivateKey.fromLogin(username, password, 'memo').createPublic();

				//create auth values for passing to account creation
				const ownerAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[ownerKey.createPublic(), 1]],
				};
				const activeAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[activeKey.createPublic(), 1]],
				};
				const postingAuth = {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[postingKey.createPublic(), 1]],
				};


				//BLURT only supports fee-based account creation
				const create_op = [
					'account_create',
					{
						fee: '100.000 BLURT',
						creator: creator,
						new_account_name: username,
						owner: ownerAuth,
						active: activeAuth,
						posting: postingAuth,
						memo_key: memoKey,
						json_metadata: '',
						extensions: [],
					}
				];
				blurtOps.push(create_op);

				const privateKey = dblurt.PrivateKey.fromString(config.active_key);
				//proceed executing the selected operation(s), rotating Blurt endpoints
				try{
					await blurtCallWithFailover(
						(c) => c.broadcast.sendOperations(blurtOps, privateKey),
						'account_create ' + username
					);
					console.log('success');
					blurtAccountSuccess = true;
				}catch(bcErr){
					//The broadcast is state-changing, so a thrown error is NOT proof the
					//account was not created: a node can accept the create and then be
					//slow/drop (withTimeout stops waiting, it cannot abort a submitted tx),
					//and a retried op on another node is rejected "already exists". Treat
					//the chain as source of truth -- if the account now exists, it landed.
					console.log(bcErr);
					try{
						const check = await blurtCallWithFailover(
							(c) => c.database.call('get_accounts', [[username]]),
							'verify after create ' + username
						);
						if (Array.isArray(check) && check.length > 0){
							console.log('blurt account present after broadcast error - treating as created');
							blurtAccountSuccess = true;
						}
					}catch(verifyErr){
						console.log(verifyErr);
					}
				}
			}catch(err){
				console.log(err);
				blurtAccountSuccess = false;
			}
		}
		// One structured line carrying the request AND the per-chain outcome. Support
		// otherwise has nothing: the HTTP response is a bare boolean and
		// signup_transactions stores no chain field at all, so "I signed up but have no
		// Blurt account" is indistinguishable from a full two-chain success. Persisting
		// this on the signup document is the real fix and is filed separately; this at
		// least makes it answerable from the logs.
		const chainOutcome = (want, created, exists, skipped) => !want ? 'not_requested'
			: (created ? 'created' : (exists ? 'already_exists' : (skipped ? 'skipped_node_down' : 'failed')));
		console.log('createAccount outcome for ' + username + ': cur_bchain=' + JSON.stringify(chain)
			+ ' HIVE=' + chainOutcome(wantHive, hiveAccountSuccess, hiveExists, skipHive)
			+ ' BLURT=' + chainOutcome(wantBlurt, blurtAccountSuccess, blurtExists, skipBlurt));

		if (wantHive && !hiveAccountSuccess){
			console.log('createAccount: HIVE was requested for ' + username + ' but not created'
				+ (skipHive ? ' (existence check failed, leg skipped)' : '') + ' - reporting failure so the signup stays retryable');
		}
		if (wantBlurt && !blurtAccountSuccess && !blurtExists){
			console.log('createAccount: BLURT was requested for ' + username + ' but not created'
				+ (skipBlurt ? ' (existence check failed, leg skipped)' : ''));
		}

		// `hiveAccountSuccess || blurtAccountSuccess` was wrong once a leg could be
		// SKIPPED rather than merely attempted. With both chains requested and the Hive
		// existence check throwing, skipHive skipped the Hive leg, Blurt succeeded, and
		// the OR returned true: the caller stored the signup with the memo, paid the
		// referral and answered accountCreated:true for a user who paid for a Hive
		// account, got a Blurt-only one, and could no longer retry - the memo answers
		// memo_already_used and a promo code promo_code_exhausted. Before the skip flags
		// existed that same node error threw, the caller's catch left accountCreated
		// false, and the signup stayed retryable.
		//
		// The asymmetry below is deliberate, not an oversight: the signup is PAID FOR on
		// Hive (claimed account tokens, creator config.account), so Hive is the chain
		// that has to succeed. Blurt is best-effort alongside it - which is exactly what
		// the Blurt failover work set out to protect, and this keeps that: Hive created
		// plus Blurt skipped is still a success.
		if (wantHive){
			return hiveAccountSuccess;
		}
		return blurtAccountSuccess;
	}

	//function handles delegating to a specific account
	async function delegateToAccount (delegatee, steemPowerAmount, chain, hiveHP){
		if (typeof config == 'undefined' || config == null){
			getConfig();
		}
		const privateKey = dhive.PrivateKey.fromString(
			config.full_pay_ac_key
		);
		
		let result = '';
		let hiveDg = false;
		if (!chain || chain.includes('HIVE')){
			
			if (hiveHP == 1){
				try{
					//grab matching amount of Vests to delegate
					let matchingHiveVests = await hivePowerToVests(steemPowerAmount);
					const op = [
						'delegate_vesting_shares',
						{
							delegator: config.full_pay_benef_account,
							delegatee: delegatee,
							vesting_shares: matchingHiveVests+' VESTS',
						},
					];
					
					result = await hiveClient.broadcast.sendOperations([op], privateKey);
					console.log('Included in block:'+ result.block_num);
					hiveDg = true;
				}catch(err){
					console.log(err);
					hiveDg = false;
				}
			}else{
				//delegate RC instead of HP now:
				try{
					result = await delegateRC(config.pay_account, config.pay_account_posting_key, [delegatee], config.rc_delegation_new_signup);
					console.log(result);
					hiveDg = true;
				}catch(err){
					console.log(err);
					hiveDg = false;
				}
			}
			
		}
		return hiveDg;
	}

 function getVoteRShares(voteWeight, account, power) {
     if (!account) {
         return;
     }

     if (rewardBalance && recentClaims && steemPrice && votePowerReserveRate) {

         var effective_vesting_shares = Math.round(getVestingShares(account) * 1000000);
         var voting_power = account.voting_power;
         var weight = voteWeight * 100;
         var last_vote_time = new Date((account.last_vote_time) + 'Z');


         var elapsed_seconds = (new Date() - last_vote_time) / 1000;
         var regenerated_power = Math.round((STEEMIT_100_PERCENT * elapsed_seconds) / STEEMIT_VOTE_REGENERATION_SECONDS);
         var current_power = power || Math.min(voting_power + regenerated_power, STEEMIT_100_PERCENT);
         var max_vote_denom = votePowerReserveRate * STEEMIT_VOTE_REGENERATION_SECONDS / (60 * 60 * 24);
         var used_power = Math.round((current_power * weight) / STEEMIT_100_PERCENT);
         used_power = Math.round((used_power + max_vote_denom - 1) / max_vote_denom);

         var rshares = Math.round((effective_vesting_shares * used_power) / (STEEMIT_100_PERCENT))

         return rshares;

     }
 }

 function getVoteValue(voteWeight, account, power, steem_price) {
     if (!account) {
         return;
     }
     if (rewardBalance && recentClaims && steemPrice && votePowerReserveRate) {
         var voteValue = getVoteRShares(voteWeight, account, power)
           * rewardBalance / recentClaims
           * steemPrice;

         return voteValue;

     }
 }

 function getVoteValueUSD(vote_value, sbd_price) {
  const steempower_value = vote_value * 0.5
  const sbd_print_percentage_half = (0.5 * sbd_print_percentage)
  const sbd_value = vote_value * sbd_print_percentage_half
  const steem_value = vote_value * (0.5 - sbd_print_percentage_half)
  return (sbd_value * sbd_price) + steem_value + steempower_value
 }

function timeTilFullPower(cur_power){
     return (STEEMIT_100_PERCENT - cur_power) * STEEMIT_VOTE_REGENERATION_SECONDS / STEEMIT_100_PERCENT;
 }
 
 function timeTilKickOffVoting(cur_power){
     return (parseInt(config.vp_kickstart) - cur_power) * STEEMIT_VOTE_REGENERATION_SECONDS / parseInt(config.vp_kickstart);
 }

 function getVestingShares(account) {
     var effective_vesting_shares = parseFloat(account.vesting_shares.replace(" VESTS", ""))
       + parseFloat(account.received_vesting_shares.replace(" VESTS", ""))
       - parseFloat(account.delegated_vesting_shares.replace(" VESTS", ""));
     return effective_vesting_shares;
 }

 function getCurrency(amount) {
   return amount.substr(amount.indexOf(' ') + 1);
 }
 
 async function loadUserList(location, callback) {
  if(!location) {
    if(callback)
      callback(null);

    return;
  }

  if (location.startsWith('http://') || location.startsWith('https://')) {
    try {
      const response = await axios.get(location);
      if (callback) {
        callback(response.data.replace(/[\r]/g, '').split('\n'));
      }
    } catch (err) {
      console.log('Error loading blacklist from: ' + location + ', Error: ' + err);
      if (callback) {
        callback(null);
      }
    }
  } else if (fs.existsSync(location)) {
    if(callback)
      callback(fs.readFileSync(location, "utf8").replace(/[\r]/g, '').split('\n'));
  } else if(callback)
    callback([]);
}

function format(n, c, d, t) {
  var c = isNaN(c = Math.abs(c)) ? 2 : c,
      d = d == undefined ? "." : d,
      t = t == undefined ? "," : t,
      s = n < 0 ? "-" : "",
      i = String(parseInt(n = Math.abs(Number(n) || 0).toFixed(c))),
      j = (j = i.length) > 3 ? j % 3 : 0;
   return s + (j ? i.substr(0, j) + t : "") + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + t) + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : "");
 }

 function toTimer(ts) {
   var h = Math.floor(ts / HOURS);
   var m = Math.floor((ts % HOURS) / 60);
   var s = Math.floor((ts % 60));
   return padLeft(h, 2) + ':' + padLeft(m, 2) + ':' + padLeft(s, 2);
 }
 
 function toHrMn(ts) {
   var h = Math.floor(ts / HOURS);
   var m = Math.floor((ts % HOURS) / 60);
   return padLeft(h, 2) + 'hr(s):' + padLeft(m, 2) + 'min(s)';
 }

 function padLeft(v, d) {
   var l = (v + '').length;
   if (l >= d) return v + '';
   for(var i = l; i < d; i++)
     v = '0' + v;
   return v;
 }

 // the weight param is actually 100*1,000 at max to consume 20% VP
 // with 100 being the max 100% per single vote, and 1,000 being the max potentially used votes
 // so if we were to only consume 10 % of our VP, the weight would be set at 50,000 instead of default value of 100,000
 function calculateVotes(posts, weight) {
	console.log('calculateVotes');
  if(typeof weight == 'undefined') {
    weight = 100000;
  }
  var data = {};
  var x = 0;
  // Rate multiplier post count  
  var rmc = _.countBy(posts, 'rate_multiplier');
  console.log(rmc);
  _.forEach(rmc, function(value, key) {
    x += key * value;
  });
  console.log(x);
  data.power_per_vote = Math.floor(weight / x);
  return data
 }

 function filterPosts(posts, banned_users) {
  var results = Array();
  let config = getConfig();
  //takes care of making sure if we reached too far back in history
   var dateSurpassed = 0;

  
  for(var i = 0; i < posts.length; i++) {
    var post = posts[i];

    // Check if post category is main tag
    if (post.category != config.main_tag) {
      console.log('Post does not match category tag. ' + post.url);
      continue;
    }
    //check if account was voted
    let voted = _.findIndex(post.active_votes, ['voter', config.account]);
    if (voted == -1) {
      console.log('Post was not voted. ' + post.url);
      continue;
    }
    // Check if account is beneficiary 
    var benefit = checkBeneficiary(post);
    
    if(!benefit)
      continue;

	
	//check if user is banned
	var user_banned = false;
	for (var n = 0; n < banned_users.length; n++) {
		if (post.author == banned_users[n].user){
			console.log('User '+post.author+' is banned, skipping his post:' + post.url);
			user_banned = true;
			break;
		}
	  }   
	if (user_banned) continue;
	
	//go back only to predefined days in history
	if((new Date() - new Date(post.created + 'Z')) >= (config.max_days * 24 * 60 * 60 * 1000)) {
			dateSurpassed += 1;
			continue;
		}
	 
    results.push(post);
  }
  //if we got to old posts and received at least 10 posts, inform calling function that no need to move forward further
  if (results.length == 0 && dateSurpassed>10){
	return -1;
  }
  return results;
    
 }

 function checkBeneficiary(post) {
  let config = getConfig();
   // Check if account is beneficiary 
   var benefit = 0;
   for (var x = 0; x < post.beneficiaries.length; x++) {
     for (var n = 0; n < config.beneficiaries.length; n++) {
       if (post.beneficiaries[x].account === config.beneficiaries[n])
         benefit ++;
     }          
     if (benefit === config.beneficiaries.length) {
       benefit = true;
       break;
     }
   }
    if(benefit !== true)
      return false;

    return true;

 }
 
  /**
  * function handles mapping and calculating relevant score
  * params: 
  * * 2D array providing couplets of rules
  * * factor multipier for data
  * * current value to compare
  */
 function calcScore(rules_array, factor, value){
	var result;
	//console.log("rules_array.length:"+rules_array.length);
	for (var i=0; i<rules_array.length; i++){
		var rule = rules_array[i];
		//console.log(value<=rule[0]);
		if (value<=rule[0]){
			result = factor * rule[1];
			break;
		}else{
			//default until we find a larger range that fits better
			result = factor * rule[1];
		}
	}
	//console.log('result:'+result);
	return result;
 }
 
 function calcScoreExtended(rules_array, factor, value, max_val){
	var result;
	//console.log("rules_array.length:"+rules_array.length);
	for (var i=0; i<rules_array.length; i++){
		var rule = rules_array[i];
		//console.log(value<=rule[0]);
		// console.log(value);
		if (value<=rule[0]){
			result = factor * (rule[2]+rule[4]*(value-rule[3])) / max_val;//rule[1];
			break;
		}else{
			//default until we find a larger range that fits better
			result = factor * (rule[2]+rule[4]*(value-rule[3])) / max_val;//rule[1];
		}
	}
	// console.log('extended result:'+result);
	return result;
 }

 function log(msg, name) { 
  if (!name)
    var name = 'log';
  console.log(new Date().toString() + ' - ' + msg); 
  fs.appendFileSync( name + '.log', new Date().toString() + ' - ' + msg + "\n");
 }

 /**
  * Read and cache config.json.
  *
  * WHAT THIS DOES AND DOES NOT FIX - corrected after review, because the first
  * version of this comment got the post-mortem wrong and a wrong post-mortem is
  * worse than none.
  *
  * It does NOT change behaviour for a malformed file. `getConfig()` is called at
  * MODULE SCOPE (top of this file), so a JSON syntax error already threw out of
  * `require('./utils')` and the process already died at boot - loudly, in a pm2
  * restart loop. The earlier claim here, that `config` stayed undefined and
  * callers silently disabled themselves, cannot happen: the lazy getConfig()
  * call sites are only reachable once the module-scope call has already
  * succeeded, at which point `config` is truthy and they early-return.
  *
  * What it DOES add is a message that names the file, its RESOLVED path and the
  * parse position, instead of a bare `Unexpected token` with no filename. The
  * resolved path is the useful part: this reads a RELATIVE path against
  * process.cwd(), so the same code reads a different file depending on where the
  * process was started from.
  *
  * The Arena launch-night incident (2026-09-23) remains UNEXPLAINED by this fix.
  * The symptoms - app up and serving, tailer never starting, nothing in the
  * logs, and grep finding every expected key - do not fit a parse error, since
  * that would have prevented boot entirely. They fit either a valid-but-wrong
  * file (duplicate key, which JSON.parse silently resolves last-wins, or altered
  * nesting) or a wrong-cwd read of a DIFFERENT, parseable config.json. Hence the
  * success-path log below: knowing WHICH file was loaded is what would have
  * closed that hour.
  */
 function getConfig() {
  if (config)
    return config;
  else {
    console.log('I get config');
    let raw;
    try {
      raw = fs.readFileSync("config.json", "utf8");
    } catch (e) {
      console.error('FATAL: cannot read config.json from ' + require('path').resolve('config.json') + ' - ' + e.message);
      throw e;
    }
    const resolved = require('path').resolve('config.json');
    try {
      config = JSON.parse(raw);
      // Which file did we actually load? A relative read against process.cwd()
      // means this is not answerable from the code alone, and a stale-but-valid
      // config in an unexpected cwd is indistinguishable from a correct one.
      console.log('config.json loaded from ' + resolved);
    } catch (e) {
      console.error('FATAL: config.json is not valid JSON (' + resolved + '): ' + e.message);
      console.error('       Nothing that reads config will work until this is fixed.');
      console.error('       Tip: a JSON linter, or any editor that highlights JSON, will point at it.');
      throw e;
    }
    return config;
  }
 }

 async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

/* generate & return a random int value between min and max */
function generateRandomNumber(min , max) {
    
   let random_number = Math.random() * (max - min) + min;
   return Math.floor(random_number);
}

let newestTxId = -1;
let totalSBD = 0
let totalSp = 0
let total_STEEM = 0

let curTotalSBD = 0
let curTotalSp = 0
let curTotalSTEEM = 0

let producerSPRewards = 0

let authorRewardedSBD = 0
let authorRewardedSp = 0
let authorRewardedSTEEM = 0

let accountSTEEMTransfer = 0;
let accountSBDTransfer = 0;

let accountSTEEMTransferIn = 0
let accountSBDTransferIn = 0

let limit = 1000;
let txStart = -1;
let opsArr = [];

function resetVals(){
	totalSBD = 0
	totalSp = 0
	total_STEEM = 0

	curTotalSBD = 0
	curTotalSp = 0
	curTotalSTEEM = 0

	producerSPRewards = 0
	
	authorRewardedSBD = 0
	authorRewardedSp = 0
	authorRewardedSTEEM = 0
	
	accountSTEEMTransfer = 0
	accountSBDTransfer = 0
	
	accountSBDTransferIn = 0
	accountSTEEMTransferIn = 0
}

//lookupAccountPay('BLURT');

async function lookupAccountPay (chain){
	
	const ONE_DAY = 1;
	const ONE_WEEK = 7;
	const ONE_MONTH = 30;
	const ONE_YEAR = 365;
	
	//when is our start day: 1 is yesterday, 10 is 10 days ago
	let start_days = 96;
	let lookup_days = ONE_MONTH;
	
	let today = moment().utc().startOf('date').toDate()
	let start = moment(today).subtract(start_days, 'days').toDate()
	let to = moment(start).subtract(lookup_days, 'days').toDate()

	//bring the action
	console.log('start date:'+start)
	console.log('************actifit rewards***************')
	txStart = -1;
	await getAccountPayTransactions('actifit', start, to, lookup_days, chain);
	//console.log('append actifit.pay rewards:'+start)
	//await getAccountPayTransactions('actifit.pay', start, to);
	
	txStart = -1;
	console.log('***********append actifit.funds rewards**********')
	await getAccountPayTransactions('actifit.funds', start, to, lookup_days, chain);
	
	txStart = -1;
	console.log('***********append actifit.pay rewards**********')
	await getAccountPayTransactions('actifit.pay', start, to, lookup_days, chain);
	
	txStart = -1;
	console.log('***********append actifit.exchange rewards**********')
	await getAccountPayTransactions('actifit.exchange', start, to, lookup_days, chain);
	
	txStart = -1;
	console.log('***********append actifit.signup rewards**********')
	await getAccountPayTransactions('actifit.signup', start, to, lookup_days, chain);

}

async function getAccountPayTransactions (account, start, end, period, chain) {
  
  start = moment(start).format()
  end = moment(end).format()
  
  let chainLnk = setProperDNode(chain);
    
  // Query account history for delegations
  properties = await chainLnk.database.getDynamicGlobalProperties()
  if (chain == 'HIVE'){
	  totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0])
  }else if (chain == 'BLURT'){
	  totalSteem = Number(properties.total_vesting_fund_blurt.split(' ')[0])
  }
  totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  
  //console.log(properties);
  if (txStart != -1 && txStart < limit){
	limit = txStart;
  }
  const transactions = await chainLnk.database.call('get_account_history', [account, txStart, limit])
  transactions.reverse()
  
  console.log("newestTxId:"+transactions[0][0]);
  
  for (let txs of transactions) {
    let date = moment(txs[1].timestamp).format()
	//console.log(date >= end)
	//console.log(date <= start)
	
    if (date >= end && date <= start) {
	  //console.log(txs[0]);
      let op = txs[1].op
	  
	  //console.log(op[0]);
      // Look for beneficiary payments
	  if (!opsArr.includes(op[0])){
		opsArr.push(op[0]);
	  }
      if (op[0] === 'comment_benefactor_reward') {
		//console.log('---------------------------------------');
		//console.log(op);
		//console.log(op[1]);
        let rewardedSP = parseFloat(vestsToSteemPower(op[1].vesting_payout).toFixed(3)) 
		totalSp += rewardedSP;
		//console.log("rewardedSP:"+rewardedSP);
		//calculate dollar value
		//let steemInUSD = rewardedSP * steemPrice;
		//console.log("steemInUSD:"+steemInUSD);
				
		let rewardedSTEEM = 0;
		if (chain == 'HIVE'){
			rewardedSTEEM = parseFloat(op[1].hive_payout.split(' ')[0])
		}else if (chain == 'BLURT'){
			rewardedSTEEM = parseFloat(op[1].blurt_payout.split(' ')[0])
		}
		total_STEEM += rewardedSTEEM ;
		//console.log("rewardedSTEEM:"+rewardedSTEEM);
		
		//let steemPureInUSD = rewardedSTEEM * steemPrice;

		
		let rewardedSBD = 0;
		if (chain == 'HIVE'){
			rewardedSBD = parseFloat(op[1].hbd_payout.split(' ')[0])
		}
		
		//console.log("rewardedSBD:"+rewardedSBD);
		
		totalSBD += rewardedSBD;
		
		//calculate dollar value
		//let sbdInUSD = rewardedSBD * sbdPrice;

      }else if (op[0] === 'producer_reward') {
		//console.log('date:'+txs[1].timestamp+'op:'+op[1]);
		let rewardedSP = parseFloat(vestsToSteemPower(op[1].vesting_shares.split(' ')[0]).toFixed(3))
		producerSPRewards += rewardedSP;
	  }else if (op[0] === 'curation_reward') {
		//console.log(op[1]);
		let rewardedSP = parseFloat(vestsToSteemPower(op[1].reward.split(' ')[0]).toFixed(3)) 
		curTotalSp += rewardedSP;
		
		//let rewardedSTEEM = parseFloat(op[1].steem_payout.split(' ')[0])
		//curTotalSTEEM += rewardedSTEEM ;
		
		
		//let rewardedSBD = parseFloat(op[1].sbd_payout.split(' ')[0])
		
		//console.log("rewardedSBD:"+rewardedSBD);
		
		//curTotalSBD += rewardedSBD;
	  }else if (op[0] === 'author_reward') {
	    //console.log('caught one author_reward');
		//console.log(op);
		
		if (chain == 'HIVE'){
			authorRewardedSBD += parseFloat(op[1].hbd_payout.split(' ')[0])
			authorRewardedSp += parseFloat(vestsToSteemPower(op[1].vesting_payout.split(' ')[0]).toFixed(3))
			authorRewardedSTEEM += parseFloat((op[1].hive_payout.split(' ')[0]))			
		}else if (chain == 'BLURT'){
			//authorRewardedSBD += parseFloat(op[1].sbd_payout.split(' ')[0])
			authorRewardedSp += parseFloat(vestsToSteemPower(op[1].vesting_payout.split(' ')[0]).toFixed(3))
			authorRewardedSTEEM += parseFloat((op[1].blurt_payout.split(' ')[0]))
			
		}
	  }else if (op[0] === 'comment_reward') {
	    console.log('comment_reward FOUND');
		console.log(op);
		authorRewardedSBD += parseFloat(op[1].payout.split(' ')[0])
	  }else if (op[0] === 'transfer' && op[1].from === account && 
		(op[1].to !== 'bittrex' && !op[1].to.includes('actifit'))){//skip bittrex and actifit account transfers
		let amountWithCur = op[1].amount;
		let amount = amountWithCur.split(' ')[0]
		let cur = amountWithCur.split(' ')[1]
		if (cur == 'SBD'){
			accountSBDTransfer += parseFloat(amount)
		}else{
			accountSTEEMTransfer += parseFloat(amount)
		}
	  }else if (op[0] === 'transfer' && op[1].to === account && 
		(!op[1].from.includes('actifit'))){//skip intra account transfer
		let amountWithCur = op[1].amount;
		let amount = amountWithCur.split(' ')[0]
		let cur = amountWithCur.split(' ')[1]
		if (cur == 'SBD'){
			accountSBDTransferIn += parseFloat(amount)
		}else{
			accountSTEEMTransferIn += parseFloat(amount)
		}
	  }
    } else if (date < end){ 
		break
	}
  }
  
  let lastTx = transactions[transactions.length - 1]
  //console.log(lastTx[0]);
  let lastDate = moment(lastTx[1].timestamp).format()
  // console.log(lastDate)
  if (lastDate >= end && (txStart == -1 || txStart > limit)){ 
	console.log('load more');
	txStart = lastTx[0];
	return getAccountPayTransactions(account, start, end, period, chain)
  }
  console.log ('querying complete');
  console.log ('>>period: '+period + ' days')
  console.log ('---benefic---');
  console.log ('totalSP:'+totalSp);
  if (period>0 && totalSp>0){
	console.log ('AVG Daily:'+totalSp/period);
  }
  console.log ('total_STEEM:'+total_STEEM);
  if (period>0 && total_STEEM>0){
	console.log ('AVG Daily:'+total_STEEM/period);
  }
  console.log ('totalSBD:'+totalSBD);
  if (period>0 && totalSBD>0){
    console.log ('AVG Daily:'+totalSBD/period);
  }
  console.log ('---curation---');
  console.log ('totalSP:'+curTotalSp);
  if (period>0 && curTotalSp>0){
    console.log ('AVG Daily:'+curTotalSp/period);
  }
  
  console.log ('---author---');
  console.log ('totalSP:'+authorRewardedSp);
  console.log ('total_STEEM:'+authorRewardedSTEEM);
  console.log ('totalSBD:'+authorRewardedSBD);
  if (period>0 && curTotalSp>0){
    console.log ('AVG Daily:'+curTotalSp/period);
  }
  
  //console.log ('totalSTEEM:'+curTotalSTEEM);
 // console.log ('totalSBD:'+curTotalSBD);
  console.log ('---witness---');
  console.log ('producerSPRewards:'+producerSPRewards);
  if (period>0 && producerSPRewards>0){
    console.log ('AVG Daily:'+producerSPRewards/period);
  }
  console.log ('---totals---');
  let comSP = parseFloat(totalSp.toFixed(3))+parseFloat(curTotalSp.toFixed(3))+parseFloat(producerSPRewards.toFixed(3))+parseFloat(total_STEEM.toFixed(3))
				+ parseFloat(authorRewardedSp.toFixed(3))+parseFloat(authorRewardedSTEEM.toFixed(3)) + parseFloat(accountSTEEMTransferIn.toFixed(3));
  console.log ('totalSTEEM:'+comSP.toFixed(3));
  if (period>0 && comSP>0){
    console.log ('AVG Daily:'+comSP/period);
  }
  //console.log ('totalSTEEM:'+totalSTEEM.toFixed(3));
  let comSBD = parseFloat(totalSBD.toFixed(3))+parseFloat(authorRewardedSBD.toFixed(3))+ parseFloat(accountSBDTransferIn.toFixed(3));;
  console.log ('totalSBD:'+comSBD);
  if (period>0 && comSBD>0){
    console.log ('AVG Daily:'+comSBD/period);
  }
  console.log ('---delegator pay---');
  console.log ('delegatorPaySTEEM:'+accountSTEEMTransfer);
  console.log ('delegatorPaySBD:'+accountSBDTransfer);
  console.log ('------------');
  //console.log (opsArr);
}

async function vestsToHivePower (vests) {
  if (isNaN(totalHive) || isNaN(totalHiveVests) ){
	hiveProps = await hiveClient.database.getDynamicGlobalProperties()
	totalHive = Number(hiveProps.total_vesting_fund_hive.split(' ')[0])
	totalHiveVests = Number(hiveProps.total_vesting_shares.split(' ')[0])
  }
  vests = Number(vests.split(' ')[0])
  const hivePower = (totalHive * (vests / totalHiveVests))
  return hivePower
}


function vestsToSteemPower (vests) {
  vests = Number(vests.split(' ')[0])
  const steemPower = (totalSteem * (vests / totalVests))
  return steemPower
}

//function handles conversting SP to Vests
async function steemPowerToVests (steemPower) {

  if (isNaN(totalSteem) || isNaN(totalVests) ){
	properties = await hiveClient.database.getDynamicGlobalProperties()
	totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0])
	totalVests = Number(properties.total_vesting_shares.split(' ')[0])
  }
  return parseFloat(steemPower * totalVests / totalSteem).toFixed(6);
}

//function handles conversting SP to Vests
async function hivePowerToVests (hivePower) {

  if (isNaN(totalHive) || isNaN(totalHiveVests) ){
	hiveProps = await hiveClient.database.getDynamicGlobalProperties()
	totalHive = Number(hiveProps.total_vesting_fund_hive.split(' ')[0])
	totalHiveVests = Number(hiveProps.total_vesting_shares.split(' ')[0])
  }
  return parseFloat(hivePower * totalHiveVests / totalHive).toFixed(6);
}

function sortArrLodash (arrToSort) {
	return _.orderBy(arrToSort, function (o) { return new Number(o.balance)},['desc']);
}

function removeArrMatchLodash (arrToClean, arrToMatch, field) {
	let removedEntries = _.remove(arrToClean, obj => arrToMatch.includes(obj[field]));
	//console.log("removedEntries");
	//console.log(removedEntries);
	return arrToClean;
}

async function rewardPost(post_url, vp, bchain){
	//extract author and permalink from full url
	//check if string ends with /, remove it
	if (post_url.slice(-1) == '/'){
		post_url = post_url.slice(0, -1);
	}
	//last portion is URL
	let permalink = post_url.split('/').reverse()[0];
	//before last portion is author, and remove the starting @
	let author = post_url.split('/').reverse()[1].replace('@','');
	let chainLnk = await setProperNode(bchain);
	//cast vote
	let result = await chainLnk.broadcast.voteAsync(
							config.rewards_account_pkey, //postingWIF
							config.rewards_account, // Voter
							author, // Author
							permalink, // Permlink
							parseFloat(vp)*100, // Weight (10000 = 100%)
						);
	return  result;
}

async function verifyAFITBuyTransaction(userA, amount, afit_amount, matching_afit, tx_type, block_num, tx_id, bchain){
	let trx;
	console.log('verifyAFITBuyTransaction');
	console.log('afit_amount:'+afit_amount);
	console.log('matching_afit:'+matching_afit);
	//item_price_alt = 0.001;
	try{
		trx = await hiveClient.database.getTransaction({id: tx_id, block_num: block_num});
		console.log(trx);
		if (trx && trx.operations
			&& trx.operations.length > 0){
				console.log(trx.operations[0][1]);
				let trx_details = trx.operations[0][1];
				let amnt = parseFloat(trx_details.amount.split(' ')[0]);
				//let json_data = JSON.parse(trx_details.json);
				console.log(trx_details);
				if (trx_details.to == config.afit_buy_account && trx_details.memo == tx_type + ':' + afit_amount
					&& amnt >= parseFloat(amount)){
					return {'success': true, 'amount_hive': amnt};
				}
		}
	}catch(err){
		console.log(err);
	}
	return false;
}

async function verifyGadgetPayTransaction(userA, gadget_id, item_price, item_price_alt, tx_type, tx_id, bchain, db){
	let trx, th_id;
	console.log('verifyGadgetPayTransaction');
	console.log('item_price:'+item_price);
	console.log('item_price_alt:'+item_price_alt);
	// item_price_alt = 0.001;
	try{
		
		//query db to find transaction
		let trx = await db.collection('verified_tx').findOne({tx_id: tx_id});
		if (trx && trx.tx && trx.tx.operations && trx.tx.operations.length > 0){
			
			let trx_details = trx.tx.operations[0][1];
			//let json_data = JSON.parse(trx_details);
			
			console.log(trx_details);
			let amnt = parseFloat(trx_details.amount.split(' ')[0]);
			//let json_data = JSON.parse(trx_details.json);
			console.log(trx_details);
			if (trx_details.to == config.gadget_buy_account && trx_details.memo == tx_type + ':' + gadget_id
				&& (amnt >= parseFloat(item_price) || amnt >= parseFloat(item_price_alt))){
				console.log('match found');
				return {'success': true, 'amount_hive': amnt};
			}
			console.log('count not find trx A');
			return false;
		}
		console.log('count not find trx B');
		//reached here, bail.
		return false;
		
		
	}catch(err){
		console.log(err);
		return false;
	}
}

async function verifyWorkoutTransaction(user, tx_type, tx_id, bchain, db){
	//let trx, th_id;
	console.log('verifyWorkoutTransaction');
	console.log(tx_id);
	try{
		//query db to find transaction
		let trx = await db.collection('verified_tx').findOne({tx_id: tx_id});
		if (trx && trx.tx && trx.tx.operations && trx.tx.operations.length > 0){
			
			let trx_details = trx.tx.operations[0][1];
			let json_data = JSON.parse(trx_details.json);
			
			console.log(trx_details);
			if (trx_details.required_posting_auths.length > 0 && trx_details.required_posting_auths[0] == user
				&& json_data.transaction == tx_type){
				console.log('match found');
				return true
			}
			console.log('count not find trx');
			return false;
		}
		console.log('count not find trx');
		//reached here, bail.
		return false;
		
	}catch(err){
		console.log(err);
		return false;
	}
	
}

async function verifyGadgetTransaction(userA, gadget_id, tx_type, tx_id, bchain, db){
	//let trx, th_id;
	console.log('verifyGadgetTransaction');
	console.log(tx_id);
	try{
		//query db to find transaction
		let trx = await db.collection('verified_tx').findOne({tx_id: tx_id});
		if (trx && trx.tx && trx.tx.operations && trx.tx.operations.length > 0){
			
			let trx_details = trx.tx.operations[0][1];
			let json_data = JSON.parse(trx_details.json);
			
			console.log(trx_details);
			if (trx_details.required_posting_auths.length > 0 && trx_details.required_posting_auths[0] == userA
				&& json_data.transaction == tx_type && json_data.gadget == gadget_id){
				console.log('match found');
				return true
			}
			console.log('count not find trx A');
			return false;
		}
		console.log('count not find trx B');
		//reached here, bail.
		return false;
		
		
		
	}catch(err){
		console.log(err);
		return false;
	}
	
}

async function verifyFriendTransaction(userA, userB, tx_type, block_num, tx_id, bchain, db){
	//let trx
	try{
		
		//query db to find transaction
		let trx = await db.collection('verified_tx').findOne({tx_id: tx_id});
		if (trx && trx.tx && trx.tx.operations && trx.tx.operations.length > 0){
			
			let trx_details = trx.tx.operations[0][1];
			let json_data = JSON.parse(trx_details.json);
			
			console.log(trx_details);
			if (trx_details.required_posting_auths.length > 0 && trx_details.required_posting_auths[0] == userA
								&& json_data.transaction == tx_type && json_data.target == userB){
				console.log('match found');
				return true
			}
			console.log('could not find trx A');
			return false;
		}
		console.log('could not find trx B');
		//reached here, bail.
		return false;
		
		
						
	}catch(err){
		console.log(err);
	}
	//return false;
}

async function findUserMatchingDevice(db, user){
	
	let result = await db.collection('user_app_notif_token').find({user: user}).toArray();
	return result;
}

async function sendFirebaseWebNotification(db, user, details, url){
	
	
}

async function sendFirebaseNotification(db, user, details, url){
	
	/****** Reference https://firebase.google.com/docs/cloud-messaging/send-message ***********/
	console.log('sendFirebaseNotification - START');
	console.log('User:', user);
	console.log('Details:', details);
	console.log('URL:', url);
	//fetch user's device/token
	let device = await findUserMatchingDevice(db, user);
	const iconUrl = 'https://actifit.io/img/hive_alert.png';
	//console.log(device);
	//only send message if device is found
	if (Array.isArray(device) && device.length>0){
		let registrationTokens = [];
		if (device.length > 1){
			for (let xx=0;xx<device.length;xx++){
				registrationTokens.push(device[xx].token);
			}
		}else{
			registrationTokens.push(device[0].token);
		}
		console.log('Device tokens found:', device?.length || 0);
		
		var message = {
		  notification: {
			title: 'Actifit Notification',
			body: details,
		  },
		  data: {
			url: url
		  },
		  
		  webpush: {
			notification:{
				title: 'Hive Notification',
				body: details,
				click_action: url,
				//link: 'https://actifit.io',
				icon: iconUrl,
				//image: 'https://raw.githubusercontent.com/actifit/actifit-landingpage/master/static/img/hive_alert.png'
			},
			fcmOptions: {
				link: url 
			},
			data: {
				link: url
			}
		  },
		  //send specific recipient via fetched token
		  //token: registrationToken
		  //variation for multi recipients
		  tokens: registrationTokens //[]
		  //variation for topic based msgs
		  //topic: topicName,
		};

	// Send a message to the device corresponding to the provided
	// registration token.
		console.log('Sending FCM message with', registrationTokens.length, 'tokens');
		console.log('Message payload:', JSON.stringify(message, null, 2));
		
		// Use sendAll instead of sendMulticast to handle individual token failures
		const sendMessages = registrationTokens.map(token => ({
			notification: message.notification,
			data: message.data,
			webpush: message.webpush,
			token: token
		}));
		
		fbadmin.messaging().sendEach(sendMessages).then((response) => {
			// Response is a message ID string.
			console.log('FCM send success - successCount:', response.successCount, 'failureCount:', response.failureCount);
			if (response.responses && response.responses.length>0){
				for (let j=0;j<response.responses.length;j++){
					if (response.responses[j].error) {
						console.log('Token error:', registrationTokens[j], '-', response.responses[j].error.message || response.responses[j].error);
					} else {
						console.log('Token success:', registrationTokens[j]);
					}
				}
			}
		  })
		  .catch((error) => {
			console.log('===== FCM ERROR DEBUG =====');
			console.log('Error code:', error.code || error.errorInfo?.code);
			console.log('Error message:', error.message || error.errorInfo?.message);
			console.log('Error details:', error.details);
			
			if (error.errorInfo) {
				console.log('Error info code:', error.errorInfo.code);
				console.log('Error info message:', error.errorInfo.message);
			}
			
			const errorCode = error.code || error.errorInfo?.code;
			if (errorCode === 'messaging/unregistered' || errorCode === 'messaging/registration-token-not-registered') {
				console.log('Token unregistered - stale token, needs app update');
			} else if (errorCode === 'messaging/server-unavailable') {
				console.log('FCM server unavailable - will retry');
			} else if (errorCode === 'messaging/invalid-payload') {
				console.log('Message payload format invalid');
			} else if (errorCode === 'messaging/invalid-recipient') {
				console.log('Invalid message recipient');
			} else if (errorCode === 'messaging/invalid-plugins') {
				console.log('FCM plugins configuration error');
			}
		  });
	  
	}/*else{
		console.log('no msg sent');
		
	}*/
}

async function sendNotification(db, user, action_taker, type, category, details, url){
	//check if user has notifications enabled
	let setgs = await db.collection('user_settings').findOne({user: user});
	let proceed = true;
	if (setgs && setgs.settings){
		//console.log(setgs.settings[config.mainNotificationsControl]);
		if (setgs.settings[config.mainNotificationsControl] == false){
			//console.log('set false 1');
			proceed = false;
		}else if (setgs.settings[category] == false){
			//console.log('set false 2');
			proceed = false;
		}
	}
	//console.log('proceed with notification :'+proceed);
	if (proceed){
		let notification_entry = {
			user: user,
			action_taker: action_taker,
			type: type,
			details: details,
			url: url,
			date: new Date(),
			status: 'unread',
		};
		try{
			let transaction = await db.collection('notifications').insertOne(notification_entry);
			console.log('success inserting notification to database');
			
			//also send out a firebase message with error handling
			try {
				await sendFirebaseNotification(db, user, details, url);
				console.log('notification and firebase message sent successfully');
			} catch (firebaseErr) {
				console.log('Firebase notification failed but DB notification saved:', firebaseErr);
				// Continue - DB notification was saved even if Firebase failed
			}
			return true;
		}catch(err){
			console.log('notification database error:', err);
			return false;
		}
	}
	return false;
}


async function grabLastDrawData(db){
	let lastDraw = await db.collection('gadget_buy_prize_draw').find().sort({'drawDate': -1}).toArray();
	let drawData = {};
	if (Array.isArray(lastDraw) && lastDraw.length > 0){
		let start = moment(lastDraw[0].drawDate).utc().startOf('date').toDate();
		let nextDrawDate = moment(start).add(config.contestBuyLen, 'days').toDate();
		lastDraw[0].nextDrawDate = nextDrawDate;
		drawData = lastDraw[0];
	}else{
		let start = moment(config.gadgetPrizeInitDate).utc().startOf('date').toDate();
		let nextDrawDate = moment(start).add(config.contestBuyLen, 'days').toDate();
		drawData = {'drawDate': start, 'nextDrawDate': nextDrawDate};
	}
	return drawData;
}

async function recurseChainRewards(user, bchain, start_author, start_permlink, accumulatedRewards = 0, accumulatedPostCount = 0, currency = '') {
    let posts = await hive.api.callAsync('bridge.get_account_posts', {
        account: user,
        sort: 'posts',
        limit: 20,
        start_author: start_author,
        start_permlink: start_permlink
    });

    let stopProgression = false;
    
    for (let i = 0; i < posts.length; i++) {
        if (posts[i].author === user) {
            if (posts[i].is_paidout) {
                stopProgression = true;
                break;
            }

            let pstRew = parseFloat(posts[i].pending_payout_value.split(' ')[0]);
            accumulatedRewards += pstRew;
            currency = posts[i].pending_payout_value.split(' ')[1]; // Update currency
            
            if (pstRew > 0) accumulatedPostCount++;

            // Update start_author and start_permlink for recursion
            start_author = posts[i].author;
            start_permlink = posts[i].permlink;
        }
    }

    if (stopProgression || posts.length === 0) {
        return { amount: accumulatedRewards, currency: currency, postCount: accumulatedPostCount };
    } else {
        return await recurseChainRewards(user, bchain, start_author, start_permlink, accumulatedRewards, accumulatedPostCount, currency);
    }
}

async function fetchChainRewards(user, bchain) {
    return await recurseChainRewards(user, bchain, '', '');
}


async function fetchPendingRewards(user, bchain){
	let rewards = {};
	if (!bchain || bchain == ''){
		//fetch rewards from all
		rewards.HIVE = await fetchChainRewards(user, hive).catch(err => {console.log (err);});
		
		//console.log('big rew:'+rewards);
		rewards.BLURT = await fetchChainRewards(user, blurt).catch(err => {console.log (err);});
		//console.log('big rew:'+rewards);
	}else{
		let chainLnk = await setProperNode(bchain)
		rewards.bchain = await fetchChainRewards(user, chainLnk).catch(err => {console.log (err);});
		//console.log('big rew:'+rewards);
	}
	return rewards;
	
}

//claimRewards('actifit', config.posting_key, 'HIVE');

async function claimRewards(target_account, p_key, target_chain) {
	console.log('>>>>> claiming rewards');
	
	let targetAccount = null;
	
	let claim_currency
	let claim_currency_stable
	let chainLnk
	if (target_chain == 'HIVE'){
		chainLnk = hive;
		targetAccount = await chainLnk.api.getAccountsAsync([target_account]).catch(err => {return err;});; 
		if (!targetAccount){
			return {error: 'account not found'};
		}
		targetAccount = targetAccount[0];
		//console.log(targetAccount);
		claim_currency = targetAccount.reward_hive_balance;//targetAccount.reward_steem_balance.replace("HIVE", "STEEM");
		claim_currency_stable = targetAccount.reward_hbd_balance;//targetAccount.reward_sbd_balance.replace("HBD", "SBD");
		console.log('pending HBD'+claim_currency_stable);
	}else if (target_chain == 'BLURT'){
		chainLnk = blurt;
		targetAccount = await chainLnk.api.getAccountsAsync([target_account]).catch(err => {return err;});; 
		if (!targetAccount){
			return {error: 'account not found'};
		}
		targetAccount = targetAccount[0];
		//console.log(targetAccount);
		claim_currency = targetAccount.reward_blurt_balance;//targetAccount.reward_steem_balance.replace("HIVE", "STEEM");
		claim_currency_stable = targetAccount.reward_vesting_blurt;//targetAccount.reward_sbd_balance.replace("HBD", "SBD");
		if (parseFloat(claim_currency) > 0 || parseFloat(claim_currency_stable) > 0 || parseFloat(targetAccount.reward_vesting_balance) > 0) {
			let outc = await chainLnk.broadcast.claimRewardBalanceAsync(p_key, target_account, claim_currency, targetAccount.reward_vesting_balance).catch(err => {return err;});
			//return outc;
			//console.log(outc);
			if (outc.ref_block_num){
				console.log('success');
				return {success: true};
			}else{
				console.log('error')
				return {error: 'n/a'}
			}
		}else{
			console.log('nothing to claim')
			return {error: 'nothing to claim'};
		}
	}
	
	// Make api call only if you have actual reward
	if (parseFloat(claim_currency) > 0 || parseFloat(claim_currency_stable) > 0 || parseFloat(targetAccount.reward_vesting_balance) > 0) {
		
		console.log('>>CLAIMING<<')
		
		let outc = await chainLnk.broadcast.claimRewardBalanceAsync(p_key, target_account, claim_currency, claim_currency_stable, targetAccount.reward_vesting_balance).catch(err => {return err;});
		//console.log(outc);
		if (outc.ref_block_num){
			console.log('success');
			return {success: true};
		}else{
			console.log('error')
			return {error: 'n/a'}
		}
			
	}else{
		console.log('nothing to claim.');
		return {error: 'nothing to claim'};
	}
}


async function proceedSendToken (tipper, srcAcct, srcAcctActKey, targetAcct, amount, chain, tokenSymbol){

	let transId = 'ssc-mainnet-hive';
	
	
	let json_data = {
		contractName: 'tokens',
		contractAction: 'transfer',
		contractPayload: {
			symbol: tokenSymbol,
			to: targetAcct,
			quantity: amount.toFixed(6),//needs to be string and a max of 6 digits supported
			memo: tipper//'tipped '+amount+ ' ' + tokenSymbol + ' by @'+tipper
		}
	}
	
	//send out transaction to blockchain
	//let chainLnk = await setProperNode(chain);
	let tx = await hive.broadcast.customJsonAsync(
	//let tx = await chainLnk.broadcast.customJsonAsync(
			srcAcctActKey, 
			[ srcAcct ] , 
			[], 
			transId, 
			JSON.stringify(json_data)
		).catch(err => {
			console.log(err.message);
	});
	return tx;
}

async function fetchChainTrx(trxId, blkNo, chain){
	let chainLnk = await setProperNode(chain);
		
	//track attempts for timeout
	let attempts = 1;
	let max_attempts = 30; //30 attempts x 8 seconds = 160 seconds (more than enough time for blockchain to confirm)
	
	return new Promise((resolve, reject) => {
		let fetch_th_id = setInterval(async function(){
			
			try{
				if (attempts < max_attempts){
					console.log('finding trx ' + attempts);
					attempts += 1;
					let trx;
					trx = await chainLnk.api.getTransactionAsync(trxId);
					if (trx && trx.operations){
						let ops = trx.operations;
						for (const i in ops) {
							const op = ops[i];
							
							if (op[0] === "comment") {
								
								let action = op[1];
								let targetUser = action.parent_author;
								let author = action.author;
								let permlnk = action.parent_permlink;
								let authPermlnk = action.permlink;
								
								//only comments & matching !AFIT keyword with or without amount
								let matchingArr = action.body.match(/\!AFIT( *(\d+))?/i);
								
								if (targetUser != "" && matchingArr.length > 0) { //has a parent post and targets sending AFIT
									let amnt = config.default_tip_amnt;
									try{
										if (matchingArr.length>2){
											let tempAmnt = parseInt(matchingArr[2]);
											if (tempAmnt < config.max_tip_amnt){
												//set as new amount
												amnt = tempAmnt;
											}
										}
									}catch(parseErr){
										console.log(parseErr);
									}
									
									let result = {
										reqUser: author,
										reqPermlnk: authPermlnk,
										tgtUser: targetUser,
										cmtPermlnk: permlnk,
										amnt: amnt,
										chain: chain,
										symbol: 'AFIT'
									}
									console.log('stop spinning. Get back');
									//return result;
									clearInterval(fetch_th_id);
									resolve(result);
								}
								
							}
						}
					}
				}else{
					//return error
					resolve(null);
				}
			}catch(err){
				console.log(err);
				resolve(null);
			}
		}, 8000);
	});
	//return {};
}

async function commentToChain(reslt){
	console.log('commenting to chain ' + reslt.chain);
	let chainLnk = await setProperNode(reslt.chain);
	let permalink = 're-' + reslt.tgtUser.replace(/\./g, '') + '-' + reslt.cmtPermlnk + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();
	let jsonMetadata = {};
	let tgtUser = reslt.tgtUser;
	let tgtPermlnk = reslt.cmtPermlnk;
	if (!reslt.eligible){
		tgtUser = reslt.reqUser;
		tgtPermlnk = reslt.reqPermlnk;
	}
	const operations = [ 
		   ['comment', 
			 { 
			   "parent_author": tgtUser, 
			   "parent_permlink": tgtPermlnk, 
			   "author": config.tip_account,
			   "permlink": permalink, 
			   "title": reslt.symbol + ' tip ', 
			   "body": reslt.content, 
			   "json_metadata" : JSON.stringify(jsonMetadata)
			 } 
		   ]
	];
	
	console.log(operations);
	
	let res = await chainLnk.broadcast.sendAsync( 
		   { 
			   operations: operations, 
			   extensions: [] 
			}, 
		   { posting: config.tip_account_posting_key }
	   ).catch(e => console.log(e))
	console.log(res);
	if (res && res.ref_block_num) {
		console.log('Posted comment: ' + permalink);
		//resolve(res);
	}	
}


async function getGadgetBuyTickets(db){
	let drawData = await grabLastDrawData(db);
	
	let startDate = moment(drawData.drawDate).format('YYYY-MM-DD');
	
	//let endDate = moment(moment(startDate).utc().subtract(config.contestBuyLen, 'days').toDate()).format('YYYY-MM-DD');
	
	console.log("startDate:"+startDate);//+" endDate:"+endDate);
	
	let query = {
		date: {
			$gte: new Date(startDate),	
		}
	}
	
	let result = await db.collection('gadget_buy_tickets').find(query).toArray();
	return result;
}

function rewardCap(chain){
	let idx = 0;
	if (chain=='STEEM'){
		idx = 1;
	}
	let startDecreaseDate = new Date(config.first_decrease_date);
	
	let decDateInitiation = moment(startDecreaseDate).utc().startOf('date');//.toDate()
	
	let today = moment().utc().startOf('date');//.toDate()
	
	//difference in days
	let interDates = today.diff(decDateInitiation,'days');
	//console.log(interDates);
	let maxDuration = config.decrease_duration;
	if (interDates > maxDuration){
		interDates = maxDuration;//max decrease on delegation rewards
	}
	console.log(interDates);
	let decreasePct = config.delg_decr_pct[idx];
	let weekly_rewd_cap = config.weekly_rewards_limit[idx];
	let decAmount = 0;
	let priorCap = weekly_rewd_cap;
	for (let i=0;i<interDates;i++){
		decAmount += parseFloat(priorCap * decreasePct * 0.01);
		priorCap -= (priorCap * decreasePct * 0.01);
		//console.log('decAmount:'+decAmount);
		//console.log('priorCap:'+priorCap);
	}
	console.log(decAmount);
	weekly_rewd_cap -= decAmount;
	
	console.log(weekly_rewd_cap);
	
	return weekly_rewd_cap;
}


//redeemDelegations();

async function redeemDelegations(){
	await delegationRedeemer('HIVE');
	await delegationRedeemer('STEEM');
}

async function delegationRedeemer(bchain, threshold){
	//go through delegations by funds account, and cancel outdated ones (3 months and beyond)
	const max_limit = 1000;
	let i = 0;
	let today = new Date();
	try{
		let chainLnk = await setProperNode(bchain);
		let delg = await chainLnk.api.getVestingDelegationsAsync(config.full_pay_benef_account, '', max_limit);
		for (i=0;i<delg.length;i++){
			//skip this user
			if (config.perpetDelgList.includes(delg[i].delegatee)){
				console.log('skipping '+delg[i].delegatee);
				continue;
			}
			console.log('checking '+delg[i].delegatee)
			let del_date = new Date(delg[i].min_delegation_time);
			let dates_diff = today.getTime() - del_date.getTime();
			let diff_in_days = Math.ceil(dates_diff / (1000 * 3600 * 24));

			console.log(delg[i].min_delegation_time); 
			console.log(diff_in_days);
			let minDays = 3*30;
			if (threshold){
				minDays = threshold;
			}
			if (diff_in_days > minDays){
				console.log('cancel out delegation to'+delg[i].delegatee);
				//cancel out delegation
				if (bchain == 'HIVE'){
					//cancel HP delegation
					await delegateToAccount(delg[i].delegatee, 0, bchain, 1);
				}else{
					await delegateToAccount(delg[i].delegatee, 0, bchain);
				}
			}
		}
		//console.log(delg);
	}catch(err){
		console.log(err);
	}
	
}

//launch();

/****** PART COVERING HF26 RC delegations ****/
//reference: https://peakd.com/rc/@howo/direct-rc-delegation-documentation
function fetchRCDelegations(from, to, limit){
	if (!limit){
		limit = 1000;
	}
	return new Promise(resolve => {
        hive.api.call('rc_api.list_rc_direct_delegations', {start:[from, to], limit: limit}, function (err, result) {
            return resolve(result)
        })
    });
}

function listRCAccounts(start, limit) {
    return new Promise(resolve => {
        hive.api.call('rc_api.list_rc_accounts', {start:start, limit: limit}, function (err, result) {
            return resolve(result)
        })
    });
}


async function getRCHF26(accounts){
	let res = await hive.api.callAsync('rc_api.find_rc_accounts', {accounts: accounts});
	return res;
}

async function delegateRC(delegator, posting_key, delegatees, max_rc) {
	/**** below works *****/
	console.log('delegateRC')
	const op_name = 'custom_json';
	//['delegate_rc', {
	const json_data = JSON.stringify(['delegate_rc', { 
            from: delegator,
            delegatees: delegatees,
            max_rc: max_rc
		}]);
        //}]);
	const transId = 'rc';
	const cstm_params = {
		required_auths: [],
		required_posting_auths: [delegator],
		id: transId,
		json: json_data
	}
	
	let operation = [ 
	   [op_name, cstm_params]
	];
	console.log('broadcasting');
	console.log(operation);
	
	/***** end of works *********/
	
	/***** alt implementation ****/
	
	let tx
    tx = await hive.broadcast.customJsonAsync(
			posting_key,
			[], 
			[delegator], 
			transId, 
			json_data
		).catch(err => {
			console.log(err.message);
			return err;
	});
	
	//console.log(tx);
	//5000000000000000
	/*if (!tx){
		tx = {};
	}*/
	return tx;
	
}

async function hiveAccountExists(username) {
	try {
		const accounts = await hiveClient.database.call('get_accounts', [[username]]);
		return Array.isArray(accounts) && accounts.length > 0;
	} catch (err) {
		console.error('hiveAccountExists error:', err);
		return false;
	}
}

async function countActifitVotesToday(username) {
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);
	try {
		const history = await hiveClient.database.call('get_account_history', [username, -1, 1000]);
		let count = 0;
		for (const [, tx] of history) {
			const [op_type, op] = tx.op;
			if (op_type === 'custom_json' && op.id === 'actifit_vote') {
				const ts = new Date(tx.timestamp + 'Z');
				if (ts >= todayStart) count++;
			}
		}
		return count;
	} catch (err) {
		console.error('countActifitVotesToday error:', err);
		return 0;
	}
}

async function verifyPostSuppEdit(author, permlink) {
	try {
		const post = await hiveClient.database.call('get_content', [author, permlink]);
		if (!post || !post.author) return false;
		let meta = {};
		try { meta = JSON.parse(post.json_metadata); } catch {}
		return meta.suppEdit === 'actifit.io';
	} catch (err) {
		console.error('verifyPostSuppEdit error:', err);
		return false;
	}
}

async function countUserCommentsToday(username) {
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);
	try {
		const history = await hiveClient.database.call('get_account_history', [username, -1, 1000]);
		let count = 0;
		for (const [, tx] of history) {
			const [op_type, op] = tx.op;
			if (op_type === 'comment' && op.parent_author && op.author === username) {
				const ts = new Date(tx.timestamp + 'Z');
				if (ts >= todayStart) count++;
			}
		}
		return count;
	} catch (err) {
		console.error('countUserCommentsToday error:', err);
		return 0;
	}
}

 module.exports = {
   updateSteemVariables: updateSteemVariables,
   getVotingPower: getVotingPower,
   getRC: getRC,
   getNewRC: getNewRC,
   claimDiscountedAccount: claimDiscountedAccount,
   getVoteValueUSD: getVoteValueUSD,
   getVoteValue: getVoteValue,
   timeTilFullPower: timeTilFullPower,
   timeTilKickOffVoting: timeTilKickOffVoting,
   getVestingShares: getVestingShares,
   loadUserList: loadUserList,
   getCurrency: getCurrency,
   format: format,
   toTimer: toTimer,
   toHrMn: toHrMn,
   log: log,
   calcScore: calcScore,
   calculateVotes: calculateVotes,
   filterPosts: filterPosts,
   getConfig: getConfig,
   checkBeneficiary: checkBeneficiary,
   asyncForEach: asyncForEach,
   generateRandomNumber: generateRandomNumber,
   lookupAccountPay: lookupAccountPay,
   vestsToSteemPower: vestsToSteemPower,
   vestsToHivePower: vestsToHivePower,
   createAccount: createAccount,
   delegateToAccount: delegateToAccount,
   confirmPaymentReceived: confirmPaymentReceived,
   signupRequiredCrypto: signupRequiredCrypto,
   signupUsdPrices: signupUsdPrices,
   _resetSignupPriceCache: _resetSignupPriceCache,
   confirmPaymentReceivedPassword: confirmPaymentReceivedPassword,
   confirmSEAFITReceived: confirmSEAFITReceived,
   confirmPaymentReceivedBuy: confirmPaymentReceivedBuy,
   sortArrLodash: sortArrLodash,
   getAccountData: getAccountData,
   // exported for tests/blurt-failover.test.js - the rotation is the thing that
   // keeps a single dead Blurt node from reading as "invalid user"
   blurtNodes: blurtNodes,
   fetchOneAccount: fetchOneAccount,
   // exported for tests/createaccount-blurt-failover.test.js - rotation for the
   // dblurt client createAccount uses (not covered by #120's blurtjs rotation)
   blurtCallWithFailover: blurtCallWithFailover,
   getChainInfo: getChainInfo,
   rewardPost: rewardPost,
   verifyFriendTransaction: verifyFriendTransaction,
   verifyGadgetTransaction: verifyGadgetTransaction,
   removeArrMatchLodash: removeArrMatchLodash,
   validateAccountLogin: validateAccountLogin,
   processSteemTrx: processSteemTrx,
   decodeMemo: decodeMemo,
   encodeMemo: encodeMemo,
   sendNotification: sendNotification,
   confirmAFITXTransition: confirmAFITXTransition,
   proceedAfitxMove: proceedAfitxMove,
   verifyGadgetPayTransaction: verifyGadgetPayTransaction,
   verifyAFITBuyTransaction: verifyAFITBuyTransaction,
   verifyWorkoutTransaction: verifyWorkoutTransaction,
   getGadgetBuyTickets: getGadgetBuyTickets,
   grabLastDrawData: grabLastDrawData,
   sendFirebaseNotification: sendFirebaseNotification,
   purchaseRealProd: purchaseRealProd,
   calcScoreExtended: calcScoreExtended,
   verifyTipTransactions: verifyTipTransactions,
   updateTipBalances: updateTipBalances,
   fetchChainTrx: fetchChainTrx,
   commentToChain: commentToChain,
   proceedSendToken: proceedSendToken,
   fetchPendingRewards: fetchPendingRewards,
   claimRewards: claimRewards,
   findVerifyTrx: findVerifyTrx,
   rewardCap: rewardCap,
   delegateRC: delegateRC,
   fetchRCDelegations: fetchRCDelegations,
   getRCHF26: getRCHF26,
   listRCAccounts: listRCAccounts,
   hive: hive,
   hiveAccountExists: hiveAccountExists,
   countActifitVotesToday: countActifitVotesToday,
   verifyPostSuppEdit: verifyPostSuppEdit,
   countUserCommentsToday: countUserCommentsToday
 }
