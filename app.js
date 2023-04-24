var express = require('express');
var exphbs  = require('express-handlebars');
const MongoClient = require('mongodb').MongoClient;
var utils = require('./utils');
const moment = require('moment')
var crypto = require('crypto');

var appPort = process.env.PORT || 3120;

var app = express();

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

var config = utils.getConfig();

let ObjectId = require('mongodb').ObjectId; 

const request = require("request");

const ethutil = require('ethereumjs-util');


// Connection URL
let url = config.mongo_uri;
if (config.testing){
	url = config.mongo_local;
}

//console.log('verify gadget buy');


var db;
var collection;
// Database Name
const db_name = config.db_name;
const collection_name = 'user_tokens';

var Web3 = require('web3');

const bscrpc = 'https://bsc-dataseed1.binance.org:443';
//const bscrpc = 'https://rpc.ankr.com/bsc/6910e0510261f4593d3d10cf40688da308da788de3e3b8924b88fb0ce2a51602';

const web3 = new Web3(bscrpc);

const minABI = [
  // balanceOf
  {
	constant: true,
	inputs: [{ name: "_owner", type: "address" }],
	name: "balanceOf",
	outputs: [{ name: "balance", type: "uint256" }],
	type: "function",
  }];

//console.log(config.afitTokenAddress);
const afitContract = new web3.eth.Contract(minABI, config.afitTokenBSC);
const afitxContract = new web3.eth.Contract(minABI, config.afitxTokenBSC);
const afitBNBLPContract = new web3.eth.Contract(minABI, config.afitBNBLPTokenBSC);
const afitxBNBLPContract = new web3.eth.Contract(minABI, config.afitxBNBLPTokenBSC);

connectDB();

let rewardBanList = ['gelvirglenn12', 'yasirgujrati'];

//setInterval(connectWithRetry, 5000);

function connectDB () {

// Use connect method to connect to the server
MongoClient.connect(url, 
	{	
		reconnectTries: Number.MAX_VALUE,
		autoReconnect: true
	}
	, function(err, client) {
	if(!err) {
	  console.log("Connected successfully to server");

	  db = client.db(db_name);
	  
	  
	  //print version
	/*  var adminDb = db.admin();
    adminDb.serverStatus(function(err, info) {
        if (err){
			console.log(err);
		}else{
			console.log(info.version);
		}
    })*/

	  // Get the documents collection
	  collection = db.collection(collection_name);
	  
	  //clearCorruptData();
	  
	  //disableUserLogin();
	  /*
	  let user = 'mcfarhat';
	  utils.sendNotification(db, user, 'actifit', 'ticket_collected', 'ticket', 'You collected a ticket for purchasing gadget', 'https://actifit.io/'+user);
	  
	  utils.sendNotification(db, user, 'actifit', 'friendship_request', 'friendship', 'User ' + 'actifit' + ' has sent you a friendship request', 'https://actifit.io/'+'actifit');
	  return;*/
	  //utils.sendFirebaseNotification(db, 'arabpromovault');
	  
	} else {
		utils.log(err, 'api');
	}
  
});

}

async function clearCorruptData(){
	let res = await db.collection('token_transactions').remove({exchange: 'HE'});
	console.log(res);
	console.log('annnd done');
}

let schedule = require('node-schedule')

const SSC = require('sscjs');
const ssc = new SSC(config.steem_engine_rpc);

const hsc = new SSC(config.hive_engine_rpc);

let rule = new schedule.RecurrenceRule();

//tracking AFITX data
let usersAFITXBal = [];
let usersAFITXBalHE = [];
let fullSortedAFITXList = [];



//similarly fetch AFIT data
let usersAFITBal = [];
let usersAFITBalHE = [];
let fullSortedAFITList = [];

//initial fetch

fetchAFITXBal(0);

fetchAFITBal(0);

setTimeout(launchHEFetch, 10000);

async function launchHEFetch(){
	console.log('looking up HE data')
	fetchAFITXBalHE(0);

	fetchAFITBalHE(0);	
}



  
//fetch new AFITX user account balance every 5 mins
let scJob = schedule.scheduleJob('*/5 * * * *', async function(){
  //reset array
  usersAFITBal = [];
  usersAFITXBal = [];
  fetchAFITXBal(0);
  
  fetchAFITBal(0);
  
  setTimeout(launchHEFetch, 10000);
  
  //reset to zero, might need to revisit this when reputting SE to action
  /*usersAFITBal = [];
  usersAFITXBal = [];
  
  fetchAFITXBalHE(0);

  fetchAFITBalHE(0);
  */
  
  //only run cleanup on secondary thread to avoid duplication of effort and collision
  if (process.env.BOT_THREAD == 'SECOND_API'){
	disableUserLogin();
  }
});

////CORS IS NOW HANDLED AT LEVEL OF NGINX
//allows setting acceptable origins to be included across all function calls

if (process.env.BOT_THREAD != 'SECOND_API'){
	app.use(function(req, res, next) {
	  // var allowedOrigins = ['*', 'https://actifit.io', 'http://localhost:3000', 'https://beta.actifit.io'];
	  // var origin = req.headers.origin;
	  //console.log('>>>origin:');
	  //console.log(origin);
	  //console.log(req.headers.host);
	  // if(allowedOrigins.indexOf(origin) > -1){
		  //console.log('goooood');
		  // res.setHeader('Access-Control-Allow-Origin', origin);
		  // res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type, x-acti-token');
	  // }
	  
	  //headers are managed by server there
	  //console.log('hostname');
	  //console.log(req.headers.host);
	  //console.log(req.hostname)
	  //if (!req.headers.host.includes('api2.actifit.io')){  
		  res.setHeader('Access-Control-Allow-Origin', '*');
		  res.setHeader('Access-Control-Allow-Headers', 'Origin,  X-Requested-With, Content-Type, Accept, x-acti-token');
	  //}
	  //  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	  //return next();
	  next();
	});
}


app.get('/', function (req, res) {
	var data = {};
	data.posts = [
		{
			url: 'dsadsa',
			net_votes: 44,
			vote_weight: "0.03"
		}];
	data.total_votes = 323;
	data.total_money = "$0.63";
    // res.render('home', data);
    res.send('Hello there!');
});



/*************************** DIGIFINEX API *************************/

/*
const verifier = require('@exoshtw/admob-ssv').Verifier;

//const verifier = new Verifier();


app.get('/ssvcallback', (req, res, next) => {
    verifier.verify(req.query)
        .then((isValid) => {
            if (!isValid) {
				console.log('not valid');
                res.status(500);
                res.json({
                    error: 'Invalid signature',
                });
            }else{
				console.log('success');
			}

            // ...
        })
        .catch((e) => {
			console.log('crash');
            return next(e);
        });
});
*/

/*
const admobSSV = require('admob-rewarded-ads-ssv');

//Add callback to your rewarded ads in your admob account.
//Make sure you listen to 'get' request.

app.get('/ssv-verify', (req, res, next) => {
    // If you want to debug then send second param as true
    // admobSSV.verify(req.url, true);
    admobSSV.verify(req.url, true)
        .then((response) => {
          //Verification Successful
		  console.log(response);
		  res.send({status:'success'});
        })
        .catch((e) => {
          //Verification Failed
          console.error(e.message);
		  res.send({error:e.message});
        });
});
*/


/*
const AdMobSSV = require('express-admob-ssv');

app.get('/ssv-verify',
  AdMobSSV.middleware(),
  (req, res, next) => {
	  console.log('success');
    // SSV Valid
    // here goes Your logic
  });
  */
  
  const {methods: {verify: verifyAdMobSSV}} = require('express-admob-ssv');

/*

sample query data
1|app  |       ad_network: '5450213213286189855',
1|app  |       ad_unit: '1234567890',
1|app  |       custom_data: 'tier-1',
1|app  |       reward_amount: '1',
1|app  |       reward_item: 'Reward',
1|app  |       timestamp: '1656954784154',
1|app  |       transaction_id: '123456789',
1|app  |       user_id: '123',
1|app  |       signature: 'WEFWRG#$%#$T##$%#TR#%GG%$$%3453543FGDFG',
1|app  |       key_id: '3335741209'

*/
//show transactions for gadgets bought using HIVE
app.get('/gadgetPurchaseTrx', async function (req, res){
	let startDate = moment(moment(new Date()).utc().toDate()).format('YYYY-MM-DD');//subtract(1, 'days').
	console.log('startDate:'+startDate);
	if (req.query.startDate){
		startDate = moment(moment(req.query.startDate).utc().startOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	}
	let query = {
					date: {
						$gte: new Date(startDate)
					}
				}
	let results = await db.collection('gadget_transactions_hive').find(query).sort({date: -1}).toArray();
	res.send(results);
})

app.get('/adjustBannedRewards/:user/?:date', async function(req, res){
	res.send({});
	return;
	let startDate = moment(moment(req.params.date).utc().startOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	console.log(startDate);
	//res.send(startDate);
	//return;
	let query = {
					user: req.params.user,
					reward_activity:'Ad Reward',
					date:{
						$gte: new Date(startDate)
					}
				}
	let results = await db.collection('token_transactions').find(query).toArray();
	//loop through entries, removing rewards
	for (let i=0;i<results.length;i++){
		if (parseFloat(results[i].token_count)>0){
			//console.log(results[i]);
			results[i].old_reward = results[i].token_count;
			results[i].token_count = 0;
			results[i].old_note = results[i].note;
			results[i].note = 'Cancelled reward due to system abuse.';
			results[i].old_date = results[i].date;
			results[i].date = new Date();
			db.collection('token_transactions').save(results[i]);
		}
	}
	
	//console.log(results);
	res.send(results);
});


app.get('/adRewardsReview/', async function (req, res) {
	let queryType = {
		reward_activity: 'Ad Reward',
		token_count: {
			$gt: 0
		}
		/*date: {
			$gte: new Date(startDate),
			//$lte: new Date(startDate)
		},*/
	}
	
	let results = await db.collection('token_transactions').aggregate([
		{
			$match: queryType
		},
		{
			$group:{
				   _id: '$user',
				   /*reward_entries: { $sum: "$count" },*/
				   reward_entries: { $sum: 1 }
				}
		},
		{
		  $sort: {
			"reward_entries": -1,
		  }
		}
	   ]).toArray();
	res.send(results);
	console.log(results);
})

/*http://localhost:3120/ssv-verify?ad_network=54...55&ad_unit=12345678&reward_amount=10&reward_item=coins&timestamp=150777823&custom_data=mcfarhat_1_1_free&transaction_id=12...DEF&user_id=1234567&signature=ME...Z1c&key_id=1268887
*/

app.get('/ssv-verify',
  async (req, res, next) => {
    try {
      const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
      await verifyAdMobSSV(url, true); // true for throwing errors
	  console.log('success');
    }
    catch(error) {
      // Do something
      // or log somethings
	  console.log(error);
      return res.status(400).end(error.message);
    }
    next();
  },
  async (req, res, next) => {
    // SSV Valid
	if (req.query && req.query.custom_data){
		let data = req.query.custom_data.split('_');
		console.log(data);
		console.log('storing successful ad reward');
		if (data.length < 4 || isNaN(data[1])){
			res.send({'error': 'Error performing action'});
			return;
		}
		if (rewardBanList!=null && rewardBanList.includes(data[0])){
			res.send({'error': 'Account banned from rewards'});
			return;
		}
		//send out AFIT reward to our user
		let recordTrans = {
			user: data[0],
			reward_activity: 'Ad Reward',
			token_count: parseFloat(data[1]),
			note: 'Rewarded '+data[1]+ ' AFIT in app gadget prize for tier '+data[2] + ' ' + data[3],
			tier: data[2],
			custom_data: req.query.custom_data,
			ad_network: req.query.ad_network,
			ad_unit: req.query.ad_unit,
			transaction_id: req.query.transaction_id,
			date: new Date(),
		}
		let startDate = moment(moment(req.query.date).utc().startOf('date').toDate()).format('YYYY-MM-DD');
		console.log(startDate);
		let matchQuery = {
							user: data[0], 
							tier: data[2], 
							date: {
								$gte: new Date(startDate)
							}
						}
		console.log(matchQuery);
		//check if user already has more than 1 entry for today for this same tier, if so disregard this new reward
		let existingReward = await db.collection('token_transactions').find(matchQuery).toArray();
		console.log(existingReward);
		if (existingReward!=null && existingReward.length > 1){
			res.send({'error': 'Account already rewarded today for this tier'});
			return;
		}
		try{
			console.log(recordTrans);
			let transaction = await db.collection('token_transactions').insert(recordTrans);
			//let transaction = await db.collection('token_transactions').update(matchQuery, recordTrans, { upsert: true });
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
		}
	}
	//
	//console.log('double success');
	res.send({status:'success'});
  });

app.get('/getDailyDelegationPool/', async function(req, res){
	
//app.get('/afitDailyDelegatorRewards', async function (req, res){
	
	let hive_pool = await utils.rewardCap('HIVE'); 
	let steem_pool = await utils.rewardCap('STEEM'); 
	
	//res.send({'hive': weekly_rewd_cap, 'steem': weekly_rewd_cap});
	res.send({'hive_pool': hive_pool, 'steem_pool': steem_pool});
})

app.get('/dailyTip', async function (req, res){
	let tipEntry = await db.collection('daily_tip').find().toArray();
	res.send(tipEntry);
})

app.get('/proposalNotified', async function (req, res){
	let propNotif = await db.collection('proposal_notified').find().toArray();
	res.send(propNotif);
})

app.get('/updateProposalNotified', async function (req, res){
	if (!req.query || !req.query.author || !req.query.permlink || !req.query.secr){
		res.send({})
		return;
	}
	if (req.query.secr != '94$8u93h_f$83jg9_843909k'){
		res.send({})
		return;
	}
		
	let author = req.query.author;
	let user_info = await db.collection('proposal_notified').findOne({author: author});
	if (typeof user_info!= "undefined" && user_info!=null){
		/*if (typeof user_info.count!= "undefined"){
			user_info.count = 0;
			user_info.permlinks = [];
		}*/
	}else{
		user_info = new Object();
		user_info.author = author;
		user_info.permlinks = [];
		user_info.count = 0;
	}
	user_info.count += 1;
	user_info.permlinks.push(req.query.permlink);
	console.log(user_info);
	
	try{
		let trans = await db.collection('proposal_notified').save(user_info);
		res.send({status: 'success'});
	}catch(err){
		console.log(err)
		res.send({error: JSON.stringify(err)});
	}
	
})

app.get('/loginImg', async function (req, res){
	res.send({'imgUrl':'https://raw.githubusercontent.com/actifit/actifit-landingpage/master/static/img/insta_achive_earn.png'});
})

app.get('/queryPost', async function (req, res){
	if (!req.query || !req.query.permlink){
		res.send({error:''});
		return;
	}
	let outc = await db.collection('posts').find({permlink: req.query.permlink}).toArray();
	res.send(outc);
})

app.get('/news', async function (req, res){
	let outc = await db.collection('news').find({enabled: true}).sort({date: -1}).toArray();
	res.send(outc);
})

//schedule restart intervals due to memory drain down
function restartApiNode() {
	request.post(
		{
			url: 'https://api.heroku.com/apps/' + config.heroku_app_id + '/dynos/' + config.heroku_app_dyno + '/actions/stop',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/vnd.heroku+json; version=3',
				'Authorization': 'Bearer ' + config.heroku_app_token
			}
		},
		function(error, response, body) {
			console.log(response);
			console.log(body);
		}
	);
}

if (process.env.BOT_THREAD == 'MAIN'){
	let j = schedule.scheduleJob({hour: 0, minute: 20}, function(){
		restartApiNode();
	});
	let k = schedule.scheduleJob({hour: 6, minute: 20}, function(){
		restartApiNode();
	});
	let l = schedule.scheduleJob({hour: 12, minute: 20}, function(){
		restartApiNode();
	});
	let m = schedule.scheduleJob({hour: 18, minute: 20}, function(){
		restartApiNode();
	});
}

//initial load
let account = null;
let accountRefresh = false;
let accountQueries = 0;
loadAccountData();

async function disableUserLogin(){
	console.log('check outdated logins');
	let db_col = db.collection('user_login_token');
	let db_hist_col = db.collection('user_login_history');
	let dateTarget = new Date();
	//allow logins to remain valid for 12 hours
	dateTarget.setHours(dateTarget.getHours()-12);
	console.log(dateTarget);
	//find existing login entry in DB to move to history and then remove .. only if user wants to get logged out
	let items_to_move = await db_col.find({lastlogin: {$lt: dateTarget }, keeploggedin: {$ne: true}}).toArray();
	if (Array.isArray(items_to_move) && items_to_move.length > 0){
		console.log('moving and deleting '+ items_to_move.length + ' old logins');
		//cleanup data to prevent keeping keys
		items_to_move.forEach(function(ent){ delete ent.ppkey; delete ent.token });
		
		await db_hist_col.insert(items_to_move);
		let result = await db_col.remove({lastlogin: {$lt: dateTarget }});
	}else{
		console.log('noting to clean');
	}
	
	//console.log(result);
}

let exchangeAfitPrice = {};
let priorExchangeAfitHivePrice = {};

loadExchAfitPrice();

//reload every 5 mins
setInterval(loadExchAfitPrice, 5*60000);

function switchHENode(){
	try{
		console.log('switching hive engine node');
		//pick a random node that is not the current one
		let heNodeOptions = config.hive_engine_rpc_options.filter(item => item !== hsc.axios.defaults.baseURL);
		const randomIndex = Math.floor(Math.random() * heNodeOptions.length);
		const heNodeSelection = heNodeOptions[randomIndex];
		hsc.axios.defaults.baseURL = heNodeSelection;
		console.log('new node')
		console.log(hsc.axios.defaults.baseURL);
	}catch(err){
		console.log(err);
	}
}

async function loadExchAfitPrice(){
	try{
		console.log('loading AFIT exchange prices');
		let afitSEPrice;
		try{
			afitSEPrice	= await ssc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);
		}catch(innErr){
			//fall back to AFIT price on HE
			afitSEPrice = await hsc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);/*.catch((err)=>{
				console.log(err)
				if (err.message.includes('timeout')){
					switchHENode();
				}
			});*/
		}
		//let afitSEPrice = await hsc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);
		//await switchHENode();
		let afitHEPrice = await hsc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);/*.catch((err)=>{
				console.log(err)
				if (err.message.includes('timeout')){
					switchHENode();
				}
			});*/
		console.log('AFIT HE PRICE');
		console.log(afitHEPrice);
		
		//grab STEEM price
		let steemPriceQuery = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem&vs_currencies=usd');
		let steemPrice = await steemPriceQuery.json();
		console.log('steemPrice');
		console.log(steemPrice);
	  
	  //grab HIVE price
		let hivePriceQuery = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd');
		let hivePrice = await hivePriceQuery.json();
		console.log('hivePrice');
		console.log(hivePrice);
		//json.hive.usd
		
		//set prior hive value for reference and reuse if needed
		if (exchangeAfitPrice.afitHiveLastPrice){
			priorExchangeAfitHivePrice = exchangeAfitPrice.afitHiveLastPrice;
		}else{
			exchangeAfitPrice.afitHiveLastPrice = parseFloat(afitHEPrice[0].lastPrice);
		}
		
		
		
		exchangeAfitPrice.afitSEPrice = afitSEPrice;
		exchangeAfitPrice.afitHEPrice = afitHEPrice;
		
		exchangeAfitPrice.afitSteemLastUsdPrice = parseFloat(afitSEPrice[0].lastPrice) * steemPrice.steem.usd;
		exchangeAfitPrice.afitHiveLastUsdPrice = parseFloat(afitHEPrice[0].lastPrice) * hivePrice.hive.usd;
		
		exchangeAfitPrice.afitSteemLastPrice = parseFloat(afitSEPrice[0].lastPrice);
		exchangeAfitPrice.afitHiveLastPrice = parseFloat(afitHEPrice[0].lastPrice);
		
		exchangeAfitPrice.lastMedianPrice = (exchangeAfitPrice.afitSteemLastUsdPrice + exchangeAfitPrice.afitHiveLastUsdPrice)/2;
		exchangeAfitPrice.lastUpdated = new Date();
		
		console.log(exchangeAfitPrice);
	}catch(exc){
		console.log('problem fetching AFIT price');
		console.log(exc);
	}
}


async function loadAccountData(bchain){
	//load main account data
	
	account = await utils.getAccountData(config.account, bchain);
}

async function fetchAFITXBal(offset){
  try{
  console.log('--- Fetch new AFITX token balance ---');
  console.log(offset);
  let tempArr = await ssc.find('tokens', 'balances', { symbol : 'AFITX' }, 1000, offset, '', false) //max amount, offset,
  if (offset == 0 && tempArr.length > 0){
	  console.log('>>Found new results, reset older ones');
	  //reset existing data if we have fresh new data
	  usersAFITXBal = [];
  }
  usersAFITXBal = usersAFITXBal.concat(tempArr);
  
  if (tempArr.length > 999){
	//we possibly have more entries, let's call again
	setTimeout(function(){
		fetchAFITXBal(usersAFITXBal.length);
	}, 1000);
  }else{
	//if we were not able to fetch entries, we need to try API again
	if (offset == 0 && tempArr.length < 1){
		console.log('no AFITX data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBal(0);
		}, 30000);
	}/*else{
		//done with AFITX SE, proceed with AFITX HE
		fetchAFITXBalHE(0);
	}*/
  }
  }catch(err){
	  console.log(err);
	  if (offset == 0){
		console.log('no AFITX data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBal(0);
		}, 30000);
	  }
	  //either way, call HE version
	  //fetchAFITXBalHE(0);
  }
  //console.log(usersAFITXBal);
}

async function fetchAFITXBalHE(offset){
  try{
  console.log('--- Fetch new AFITX token balance ---');
  console.log(offset);
  let tempArr = await hsc.find('tokens', 'balances', { symbol : 'AFITX' }, 1000, offset, '', false);/*.catch((err)=>{
				console.log(err)
				if (err.message.includes('timeout')){
					switchHENode();
				}
			}); //max amount, offset, */
  if (offset == 0 && tempArr.length > 0){
	  console.log('>>Found new results, reset older ones');
	  //reset existing data if we have fresh new data
	  usersAFITXBalHE = [];
  }
  usersAFITXBalHE = usersAFITXBalHE.concat(tempArr);
  
  if (tempArr.length > 999){
	//we possibly have more entries, let's call again
	setTimeout(function(){
		fetchAFITXBalHE(usersAFITXBalHE.length);
	}, 1000);
  }else{
	//if we were not able to fetch entries, we need to try API again
	if (offset == 0 && tempArr.length < 1){
		console.log('no AFITX data HE, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBalHE(0);
		}, 30000);
	}else{
		//done, let's merge both SE & HE lists
		for (let i=0;i<usersAFITXBal.length;i++){
			usersAFITXBal[i].seholder = true;
			let match = usersAFITXBalHE.find(entry => entry.account === usersAFITXBal[i].account);
			if (match){
				usersAFITXBal[i].sebalance = usersAFITXBal[i].balance;
				usersAFITXBal[i].hebalance = match.balance;
				usersAFITXBal[i].balance = parseFloat(usersAFITXBal[i].balance) + parseFloat(match.balance);
				usersAFITXBal[i].heholder = true;
			}
		}
		//append HE holdings
		for (let i=0;i<usersAFITXBalHE.length;i++){
			usersAFITXBalHE[i].heholder = true;
			let match = usersAFITXBal.find(entry => entry.account === usersAFITXBalHE[i].account);
			if (!match){
				usersAFITXBal.push(usersAFITXBalHE[i]);
				//usersAFITXBal[i].hebalance = match.balance;
				//usersAFITXBal[i].balance = parseFloat(usersAFITXBal[i].balance) + parseFloat(match.balance);
			}
		}
		
		/*

		let req = new Object();
		req.query = new Object();
		req.query.new_account= 'jumbo';
		req.query.usd_invest= '1';
		req.query.steem_invest= '1';
		req.query.afit_reward= '1';
		req.query.memo= 'jumdfsfddbo';
		req.query.referrer= 'mcfarhat';
		storeSignupTransaction(req);
		*/
	}
  }
  }catch(err){
	  console.log(err);
	  if (offset == 0){
		console.log('no AFITX data HE, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBalHE(0);
		}, 30000);
	  }
  }
  //console.log(usersAFITXBal);
}

async function getAFITXUserData(user){
	
	//using usersAFITXBal instead of fullSortedAFITXList
	let ind = usersAFITXBal.findIndex(v => v.account == user)
	let entry = usersAFITXBal.find(v => v.account == user)
	return {ind: ind, entry: entry}
}


async function fetchAFITBal(offset){
  try{
  console.log('--- Fetch new AFIT token balance ---');
  console.log(offset);
  let tempArr = await ssc.find('tokens', 'balances', { symbol : 'AFIT' }, 1000, offset, '', false) //max amount, offset,
  if (offset == 0 && tempArr.length > 0){
	  console.log('>>Found new results, reset older ones');
	  //reset existing data if we have fresh new data
	  usersAFITBal = [];
  }
  usersAFITBal = usersAFITBal.concat(tempArr);
  
  if (tempArr.length > 999){
	//we possibly have more entries, let's call again
	setTimeout(function(){
		fetchAFITBal(usersAFITBal.length);
	}, 1000);
  }else{
	//if we were not able to fetch entries, we need to try API again
	if (offset == 0 && tempArr.length < 1){
		console.log('no AFIT data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITBal(0);
		}, 30000);
	}else{
		//done with AFIT SE, proceed with AFIT HE
		//fetchAFITBalHE(0);
	}
  }
  }catch(err){
	  console.log(err);
	  if (offset == 0){
		console.log('no AFIT data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITBal(0);
		}, 30000);
	  }
	   //either way, call HE version
	  //fetchAFITBalHE(0);
  }
  //console.log(usersAFITBal);
}

async function fetchAFITBalHE(offset){
  try{
  console.log('--- Fetch new AFIT token balance ---');
  console.log(offset);
  let tempArr = await hsc.find('tokens', 'balances', { symbol : 'AFIT' }, 1000, offset, '', false); /*.catch((err)=>{
				console.log(err)
				if (err.message.includes('timeout')){
					switchHENode();
				}
			}); //max amount, offset, */
  if (offset == 0 && tempArr.length > 0){
	  console.log('>>Found new results, reset older ones');
	  //reset existing data if we have fresh new data
	  usersAFITBalHE = [];
  }
  usersAFITBalHE = usersAFITBalHE.concat(tempArr);
  
  if (tempArr.length > 999){
	//we possibly have more entries, let's call again
	setTimeout(function(){
		fetchAFITBalHE(usersAFITBalHE.length);
	}, 1000);
  }else{
	//if we were not able to fetch entries, we need to try API again
	if (offset == 0 && tempArr.length < 1){
		console.log('no AFIT data HE, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITBalHE(0);
		}, 30000);
	}else{
		//done, let's merge both SE & HE lists
		for (let i=0;i<usersAFITBal.length;i++){
			usersAFITBal[i].seholder = true;
			let match = usersAFITBalHE.find(entry => entry.account === usersAFITBal[i].account);
			if (match){
				usersAFITBal[i].sebalance = usersAFITBal[i].balance;
				usersAFITBal[i].hebalance = match.balance;
				usersAFITBal[i].balance = parseFloat(usersAFITBal[i].balance) + parseFloat(match.balance);
				usersAFITBal[i].heholder = true;
			}
		}
		//append HE holdings
		for (let i=0;i<usersAFITBalHE.length;i++){
			usersAFITBalHE[i].heholder = true;
			let match = usersAFITBal.find(entry => entry.account === usersAFITBalHE[i].account);
			if (!match){
				usersAFITBal.push(usersAFITBalHE[i]);
				//usersAFITBal[i].hebalance = match.balance;
				//usersAFITBal[i].balance = parseFloat(usersAFITBal[i].balance) + parseFloat(match.balance);
			}
		}
		
	}
  }
  }catch(err){
	  console.log(err);
	  if (offset == 0){
		console.log('no AFIT data HE, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITBalHE(0);
		}, 30000);
	  }
  }
  //console.log(usersAFITBal);
}




/* function handles calculating and returning user token count */
grabUserTokensFunc = async function (username, fullBal){
	let user = await db.collection('user_tokens').findOne({_id: username});
	console.log(user);
	//fixing token amount display for 3 digits
	if (typeof user!= "undefined" && user!=null){
		if (typeof user.tokens!= "undefined"){
			user.tokens = user.tokens.toFixed(3)
		}
	}else{
		user = new Object();
		user._id=username;
		user.name=username;
		user.tokens=0;
	}
	
	if (fullBal){
		//also append tokens on hive-engine & steem-engine
		let heEntry = usersAFITBal.find(entry => entry.account === username);
		//let heEntry = fullSortedAFITList.find(entry => entry.account === username);
		console.log('AFIT entry list');
		console.log(fullSortedAFITList.length);
		if (heEntry && !isNaN(heEntry.balance) && heEntry.balance>0){
			user.tokens = parseFloat(user.tokens) + parseFloat(heEntry.balance);
			console.log('HE');
			console.log(user.tokens);
		}
		
		//also append tokens on BSC
			//check if user has a BSC wallet
		let wallet_entry = await db.collection('user_wallet_address').findOne({user: username});
		try{
			if (wallet_entry && wallet_entry.wallet){
				//console.log(wallet_entry.wallet);
				//fetch wallet balance		
				let result = await afitContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
				//let result = await afitContract.methods.balanceOf('0xBc0d46F3F43E21a391cAb8e1A3059a8df9213a44').call(); // 29803630997051883414242659
				let format = web3.utils.fromWei(result); // 29803630.997051883414242659
				afitBSC = parseFloat(format);
				//console.log(format);
				user.tokens = parseFloat(user.tokens) + afitBSC;
			}
		}catch(exc){
			console.log(exc);
			console.log('error fetching wallet balance / BSC')
		}
		console.log(user.tokens);
		
		
	}
	return user;
}

/* function handles returning product specific data */
grabProductInfo = async function(product_id){
	let o_id = new ObjectId(product_id);
	let product = await db.collection('products').findOne({_id: o_id});
	return product;
}

/* function handles generating a random password/access_token */
generatePassword = function (multip) {
	//generate random 11 characters password
	let passString = '';
	for (let i=0;i<multip;i++){
		passString += Math.random().toString(36).substr(2, 13);
	}
	return passString;
  };
  


var bodyParser = require('body-parser');
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

//const key = crypto.randomBytes(32);
//const iv = crypto.randomBytes(16);

function encrypt(text) {
 let cipher = crypto.createCipheriv(config.ppkey_enc_mode, config.user_ppkey_db, config.user_ppkey_iv);
 let encrypted = cipher.update(text);
 encrypted = Buffer.concat([encrypted, cipher.final()]);
 //return { iv: iv.toString('hex'), encryptedData: encrypted.toString('hex') };
 return encrypted.toString('hex');
}

function decrypt(text) {
 //let iv = Buffer.from(text.iv, 'hex');
 //let encryptedText = Buffer.from(text.encryptedData, 'hex');
 let encryptedText = Buffer.from(text, 'hex');
 let decipher = crypto.createDecipheriv(config.ppkey_enc_mode, config.user_ppkey_db, config.user_ppkey_iv);
 let decrypted = decipher.update(encryptedText);
 decrypted = Buffer.concat([decrypted, decipher.final()]);
 return decrypted.toString();
}

getTotalSupplyAFIT = async function (){
	let url = new URL('https://api.bscscan.com/api?module=stats&action=tokensupply&contractaddress=0x4516bb582f59befcbc945d8c2dac63ef21fba9f6&apikey='+config.bscscan_api);
	
	try{
		let connector = await fetch(url);
		let data = await connector.json();
		//return back the count as a number
		//structure: {"status":"1","message":"OK","result":"51000000000000000000000000"}
		let count= parseFloat(data.result)/Math.pow(10,18);///10**18;
		return ''+count;
	}catch(exc){
		return 'error';
	}
}

getAFITPCSPrice = async function (token, api){
	let tokenAddress = '0x4516bb582f59befcbc945d8c2dac63ef21fba9f6';//AFIT default
	if (token == 'AFITX'){
		tokenAddress = '0x246d22ff6e0b90f80f2278613e8db93ff7a09b95';
	}
	let url = new URL('https://api.pancakeswap.info/api/v2/tokens/'+tokenAddress);
	if (api){
		switch (api){
			case '1':
				url = new URL('https://api.dex.guru/v1/tokens/'+tokenAddress+'-bsc');
				break;
			/*case '2':
				url = new URL('https://api.bscscan.com/api?module=stats&action=tokensupply&contractaddress=0x4516bb582f59befcbc945d8c2dac63ef21fba9f6&apikey=');
				break;*/
		}
	}
	try{
		let connector = await fetch(url);
		let data = await connector.json();
		console.log(data);
		//return back the count as a number
		//structure: {"status":"1","message":"OK","result":"51000000000000000000000000"}
		let price;
		if (typeof api == "undefined" || api == ''){
			price= parseFloat(data.data.price);
		}else{
			switch (api){
				case '1':
					price = parseFloat(data.priceUSD);
					break;
			}
		}
		return price;
	}catch(exc){
		console.log(exc);
		if (typeof api == "undefined" || api == ''){
			//attempt again using different API	
			return getAFITPCSPrice(token,'1');
		}
		return 'error';
	}
}

app.get('/verifyLoginCaptcha', async function (req, res){
	if (!req.query.token){
		res.send({error:'error'})
	}
	let recaptchaToken = req.query.token;
	const response = await fetch(config.captchaVerifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          secret: config.captchaVerifySecret,
          response: recaptchaToken,
          //remoteip: // optional, the user's IP address
        })
      })

	const data = await response.json()
	console.log(data)

	if (data.success) {
        // continue with form submission
		res.send({success: true});
	} else {
        // handle error
		res.send({error:'error'})
	}
})

//for the purposes of this document
app.get('/totalSupplyAFIT', async function (req,res){
	let outcome = await getTotalSupplyAFIT();
	res.send(outcome);
	
})
//for the purposes of real circulating supply
app.get('/circulatingSupplyAFIT', async function (req,res){
	let totSupply = await getTotalSupplyAFIT();
	let cirSupply = 0;
	if (!isNaN(totSupply)){
		totSupply = parseFloat(totSupply);
		cirSupply = totSupply;
		//grab balances of well-known actifit wallets, and deduct balance from total supply
		for (let i=0;i<config.actifitSpWallets.length;i++){
			let result = await afitContract.methods.balanceOf(config.actifitSpWallets[i]).call(); // 29803630997051883414242659
			let format = web3.utils.fromWei(result); // 29803630.997051883414242659
			afitBSC = parseFloat(format);
			cirSupply -= afitBSC;
		}
		res.send(''+Math.round(cirSupply))
	}else{
		res.send('1036231');
	}	
})

app.get('/AFITBSCPrice', async function (req, res){
	let price = await getAFITPCSPrice();
	let jsonData = {token: 'AFIT', price: parseFloat(price.toFixed(4))};
	res.send(jsonData);
})

app.get('/AFITXBSCPrice', async function (req, res){
	let price = await getAFITPCSPrice('AFITX');
	let jsonData = {token: 'AFITX', price: parseFloat(price.toFixed(4))};
	res.send(jsonData);
})

//for dex-trade price action
app.get('/dex-trade/afit-usdt', async function (req,res){
	//grab price from PCS
	//https://api.pancakeswap.info/api/v2/tokens/0x4516bb582f59befcbc945d8c2dac63ef21fba9f6
	let price = await getAFITPCSPrice();
	let jsonData = {
	  "AFIT/USDT": {  // pair name
		"price": parseFloat(price.toFixed(4)),//0.122, // central price
		"up": 0.1, // percent deviation top line 15% = 0.15
		"down": 0.05  // percent deviation bottom line 10% = 0.1
	  }
	}
	res.send(jsonData);
	
})

app.get('/getChainInfo', async function (req, res){
	let outc = await utils.getChainInfo(req.query.bchain);
	res.send(outc);
});

app.get('/getAccountData', async function (req, res){
	if (!req.query || !req.query.user){
		res.send({})
		return;
	}
	let outc = await utils.getAccountData(req.query.user, req.query.bchain);
	res.send(outc);
})

app.get('/pendingRewards', async function (req, res){
	let bchain = (req.query&&req.query.bchain?req.query.bchain:'');
	if (!req.query || !req.query.user){
		res.send({})
		return;
	}
	let outc = await utils.fetchPendingRewards(req.query.user, req.query.bchain);
	res.send({pendingRewards: outc});
})
  
  
app.get('/votingStatus', async function (req, res) {
	let votingStatus = await db.collection('voting_status').findOne({});
	accountQueries += 1;
	if (accountQueries > 10){
		accountQueries = 0;
		accountRefresh = true;
	}
	let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
	//fetch anew account data if account is empty or we need to refresh account data
	if (!account || accountRefresh){
		console.log('refreshing account data');
		account = await utils.getAccountData(config.account, bchain);
		accountRefresh = false;
	}
	//console.log(account);
	let vp_res = await utils.getVotingPower(account[bchain]);
	
	let reward_start = utils.toHrMn(utils.timeTilKickOffVoting(vp_res * 100));

	res.send({'status': votingStatus, 'vp': vp_res, 'reward_start': reward_start});
});


let jwt = require('jsonwebtoken');

//function ensures user is properly logged in
let checkHdrs = (req, res, next) => {
	let token = req.headers['x-acti-token'] || req.headers['authorization']; // Express headers are auto converted to lowercase
	  
	  if (token) {
		if (token.startsWith('Bearer ')) {
			// Remove Bearer from string
			token = token.slice(7, token.length);
		}
		req.query.token = token;
		jwt.verify(token, config.secret, async (err, decoded) => {
		  if (err) {
			return res.json({
			  success: false,
			  message: 'Token is not valid'
			});
		  } else {
			let user;
	
			if (req.query && req.query.user){
				user = req.query.user;
			}else{
				res.send({error: 'user not supplied'});
			}
			
			//console.log(operation[1].required_posting_auths);
			//console.log(req.query.token);
			
			//check if user is validated with stored encrypted posting key
			let db_col = db.collection('user_login_token');
			//find existing login entry in DB
			let user_tkn = await db_col.find({user: user, token: req.query.token}).toArray();
			console.log(user_tkn);
			if (!Array.isArray(user_tkn) || user_tkn.length == 0){
				console.error('Authentication failed. Key not found');
				res.send({error: 'Authentication failed. Key not found'});
				return;
			}
			req.ppkey = user_tkn[0].ppkey;
			req.decoded = decoded;
			next();
		  }
		});
	  } else {
		return res.json({
		  success: false,
		  message: 'Auth token is not provided'
		});
	  }
};	


app.post('/performTrxPost', checkHdrs, async function (req, res) {
	console.log('>>performTrx');
	
	
	const receivedPlaintext = decrypt(req.ppkey);
	
	//set HIVE as default
	let bchain = 'HIVE';
	
	let userKey = receivedPlaintext;
	
	let operation;
	console.log(req.body);
	console.log(req.body.operation);
	if (req.body && req.body.operation){
		operation = JSON.parse(req.body.operation);
		//operation = req.query.operation;
	}else{
		res.send({error: 'operation not supplied'});
	}
	
	if (req.query.bchain){
		bchain = req.query.bchain;
	}
	
	let match_arr = Object.entries(operation);
	//console.log(user);
	console.log(operation);
	console.log((typeof operation));
	console.log(match_arr);
	console.log(match_arr[0][1]);
	
	//res.send({error: true, trx: performTrx});
	//return;
	let active = null;
	if (req.body.active){
		active = req.body.active;
	}
	
	//perform transaction
	//let performTrx = await utils.processSteemTrx(match_arr[0][1], userKey, bchain, db, active);
	let performTrx = await utils.processSteemTrx(operation, userKey, bchain, db, active);
	console.log(performTrx);
	if (!performTrx.tx.ref_block_num){
		res.send({error: true, trx: performTrx});
	}else{
		res.send({success: true, trx: performTrx});
	}
});

app.get('/availableHiveNodes', async function(req, res){
	
	res.send({'hiveNodes':config.alt_hive_nodes})
});

app.get('/delegateRC', checkHdrs, async function (req, res) {
	console.log('>>performTrx');
	if (!req.query || !req.query.user || !req.query.delegatees || !req.query.max_rc){
		res.send({});
	}
	let prm = req.query;
	const receivedPlaintext = decrypt(req.ppkey);
	let userKey = receivedPlaintext;
	let outc = await utils.delegateRC(prm.user, userKey, [prm.delegatees], prm.max_rc);
	console.log(outc);
	res.send(outc)
});

app.post('/memoDecode', checkHdrs, async function (req, res) {
	console.log('memo decode');
	//set HIVE as default
	let bchain = 'HIVE';
	const receivedPlaintext = decrypt(req.ppkey);
	if (req.query && req.query.bchain){
		bchain = req.query.bchain;
	}
	if (req.body && req.body.memo){
		let outc = await utils.decodeMemo(req.body.memo, receivedPlaintext);
		console.log('result');
		console.log(outc);
		res.send({xcstkn: outc});
		return;
	}
	res.send({error:'unable to decode'});
});

app.get('/performTrx', checkHdrs, async function (req, res) {
	console.log('>>performTrx');
	
	
	const receivedPlaintext = decrypt(req.ppkey);
	
	//set HIVE as default
	let bchain = 'HIVE';
	
	let userKey = receivedPlaintext;
	
	let operation;
	console.log(req.query.operation);
	if (req.query && req.query.operation){
		operation = JSON.parse(req.query.operation);
		//operation = req.query.operation;
	}else{
		res.send({error: 'operation not supplied'});
	}
	
	if (req.query.bchain){
		bchain = req.query.bchain;
	}
	
	let match_arr = Object.entries(operation);
	
	//perform transaction
	//let performTrx = await utils.processSteemTrx(match_arr[0][1], userKey, bchain, db, null);
	let performTrx = await utils.processSteemTrx(operation, userKey, bchain, db, null);
	console.log(performTrx);
	if (!performTrx.tx.ref_block_num){
		res.send({error: true, trx: performTrx});
	}else{
		res.send({success: true, trx: performTrx});
	}
});


app.get('/claimRewards', checkHdrs, async function (req, res){
	if (!req.query || !req.query.user){
		res.send({'error':''})
		return
	}
	
	const receivedPlaintext = decrypt(req.ppkey);
	
	let userKey = receivedPlaintext;
	
	/*res.send({'hive': {'success': true}, 'steem': {'success': true}, 'blurt': {'success': true}});*/
	let outcHive = await utils.claimRewards(req.query.user, userKey, 'HIVE');
	let outcSteem = await utils.claimRewards(req.query.user, userKey, 'STEEM');
	let outcBlurt = await utils.claimRewards(req.query.user, userKey, 'BLURT');
	res.send({'hive': outcHive, 'steem': outcSteem, 'blurt': outcBlurt});
});


app.get('/afitMarkets', async function (req, res){
	let markets = [
		{
				'chain': 'BSC',
				'exchange': 'Digifinex',
				'link': 'https://links.actifit.io/digi',
				'icon': '',
				'pairs': [
						{
							'name': 'AFIT/USDT',
							'link': 'https://www.digifinex.com/en-ww/trade/USDT/AFIT'
						}
					]
			},
		{
				'chain': 'BSC',
				'exchange': 'Dex-trade',
				'link': 'https://links.actifit.io/digi',
				'icon': '',
				'pairs': [
						{
							'name': 'AFIT/USDT',
							'link': 'https://dex-trade.com/spot/trading/AFITUSDT'
						},
						{
							'name': 'AFIT/BTC',
							'link': 'https://dex-trade.com/spot/trading/AFITBTC'
						}
					],
					
		},
		{
				'chain': 'BSC',
				'exchange': 'PCS',
				'link': 'https://links.actifit.io/digi',
				'icon': '',
				'pairs': [
						{
							'name': 'AFIT/USDT',
							'link': 'https://pancakeswap.finance/swap?inputCurrency=0x4516bb582f59befcbc945d8c2dac63ef21fba9f6&outputCurrency=BNB'
						}
					]
			},
		{
				'chain': 'Hive',
				'exchange': 'Hive-Engine',
				'link': 'https://hive-engine.com',
				'icon': '',
				'pairs': [
						{
							'name': 'AFIT/HIVE',
							'link': 'https://tribaldex.com/trade/AFIT'
						}
					]
		},
	];
	res.send(markets);
});


app.get('/recalculateUserTokens', async function (req, res){
	if (req.query && req.query.user){
	
	let user = req.query.user;
	let trx = await db.collection('token_transactions').aggregate([
		{
			$match: {user: user}
		},
		{
		   $group:
			{
			   _id: null,
			   token_balance: { $sum: "$token_count" },
			}
		}
	   ]).toArray(async function(err, results) {
		var output = 'user'+user+ 'tokens:'+results[0].token_balance;
		
		
		let user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		//let cur_user_token_count = parseFloat(user_info.tokens);
		
		user_info.tokens = parseFloat(results[0].token_balance);
		if (user_info.tokens < 0){
			user_info.tokens = 0;
		}
		//recalculate and store user token count
		try{
			let trans = await db.collection('user_tokens').save(user_info);
			console.log('success updating user token count');
			res.send('success recalculating & updating user token count: '+user_info.tokens);
			console.log(results);
		}catch(err){
			console.log(err);
		}
		
	   });
	}else{
		res.send({error: 'error'});
	}
});

app.get('/fetchUserData', checkHdrs, async function (req, res) {
	//validate proper data used
	let username;
	if (req.query && req.query.user){
		username = req.query.user;
	}
	let bchain = 'HIVE';
	if (req.query && req.query.bchain){
		bchain = req.query.bchain;
	}
	console.log('>>>>fetchuserdata');
	console.log(bchain);
	//console.log(username);
	//console.log(req.ppkey);
	const receivedPlaintext = decrypt(req.ppkey);
	let isValidUser = await utils.validateAccountLogin(username, receivedPlaintext, bchain);
	
	console.log('isValidUser');
	console.log(isValidUser);
	//if (username === mockedUsername && ppkey === mockedPpkey) {
	if (isValidUser.result){
		res.json({
		  success: true,
		  userdata: isValidUser.account
		});
	} else {
		res.status(403).send({
		  success: false,
		  message: 'Invalid user'
		});
	}
});

app.get('/resetFundsPass', checkHdrs, async function (req, res) {
	let collection = db.collection('account_funds_pass')

	let user = req.query.user.trim().toLowerCase();
	let result = 'no change';
	if (user!=''){
		result = await collection.remove({
			"user": user,
		});
		console.log(user+" password reset ");
		res.send({status:'success'});
		return;
	}
	res.send({error:'no user found'});
	
})

app.get('/resetLogin', checkHdrs, async function (req, res) {
	let db_col = db.collection('user_login_token');
	let result = await db_col.remove({user: req.query.user, token: req.query.token});
	res.send({success: true});
});

app.get('/updateSettingsKeychain/:trxID', async function (req, res){
	if (!req.query || !req.query.operation || !req.query.user){
		res.send({status:'error'})
	}else{
		try{
			//third param to find verify is to avoid storing transaction as its not needed
			let conf_trx = await utils.findVerifyTrx(req, db, true);
			/*console.log('settings trx found:')
			console.log(conf_trx.operations[0][1].required_posting_auths[0]);
			console.log(req.query.user);*/
			if (!conf_trx || conf_trx.error || req.query.user != conf_trx.operations[0][1].required_posting_auths[0]){
				res.send({status: 'error'});
				return;
			}
			//cleanup json
			let json = JSON.parse(conf_trx.operations[0][1].json)
			let setgs = await db.collection('user_settings').replaceOne({user: req.query.user}, {user: req.query.user, settings: json}, {upsert : true });
			//console.log(setgs);
			res.send({success: true});
		}catch(err){
			res.send({error: 'error'});
		}
	}
})


app.get('/updateSettings/', checkHdrs, async function (req, res) {
	let newSettings;
	if (req.query && req.query.user && req.query.settings){
		newSettings = JSON.parse(req.query.settings);
	}else{
		res.send({error:'invalid request'})
		return;
	}
	console.log(newSettings);
	try{
		let setgs = await db.collection('user_settings').replaceOne({user: req.query.user}, {user: req.query.user, settings: newSettings}, {upsert : true });
		//console.log(setgs);
		res.send({success: true});
	}catch(err){
		res.send({error: true});
	}
});


app.get('/userSettings/:user', async function (req, res) {
	let setgs = await db.collection('user_settings').findOne({user: req.params.user}, {fields : { _id:0} });
	console.log(setgs);
	if (!setgs){
		res.send({});
	}else{
		res.send(setgs);
	}
});

app.get('/userSettings/', async function (req, res) {
	let setgs = await db.collection('user_settings').find().toArray();
	console.log(setgs);
	if (!setgs){
		res.send({});
	}else{
		res.send(setgs);
	}
});


app.get('/notificationTypes/', async function (req, res) {
	res.send(config.notificationTypes);
});

app.post('/loginKeychain/', async function (req, res) {
	try{
		console.log('loginkeychain');
		//const username = sanitize(req.body.username);
		const username = req.body.username;
		let bchain = req.body.bchain?req.body.bchain:'HIVE';
		
		if (username && username.length < 20 && username.length > 3) {
			let account = await utils.getAccountData(username, bchain);
			let pubKey = account[bchain].posting.key_auths[0][0];
			console.log(pubKey);
			let memo = encrypt(username+pubKey);
			let encoded_message = await utils.encodeMemo(memo, pubKey, bchain);
			res.send({message : encoded_message});
			return;
		}
		res.send({error: 'error'})
	}catch(err){
		console.log(err);
		res.send({error: 'error'})
	}
});

/*
app.post('/confirmLoginKeychain', async function (req, res) {
	try{
		//const username = sanitize(req.body.username);
		const username = req.body.username;
		let bchain = req.body.bchain?req.body.bchain:'HIVE';
		
		if (username && username.length < 16 && username.length > 3) {
			let account = await utils.getAccountData(username, bchain);
			let pubKey = account[bchain].posting.key_auths[0][0];
			console.log(pubKey);
			let memo = encrypt(username+pubKey);
			let encoded_message = await utils.encodeMemo(memo, pubKey, bchain);
			res.send({message : encoded_message});
		}
	}catch(err){
		console.log(err);
	}
});
*/
app.post('/loginAuth', async function (req, res) {
	console.log('login');
	let username = null;
	if (req.body && req.body.username){
		username = req.body.username;
	}
    let ppkey = null;
	if (req.body && req.body.ppkey){
		ppkey = req.body.ppkey;
	}
    

    if (username && ppkey) {
		let db_col = db.collection('user_login_token');
		//find existing login entry in DB to override
		let user_tkn = await db_col.findOne({user: username});
		//console.log(user_tkn);
		
		//encode ppkey
		const ciphertext = encrypt(ppkey);
		
		let bchain = 'HIVE';
		if (req.body && req.body.bchain){
			bchain = req.body.bchain;
		}
		
		//validate proper data used
		let isValidUser = await utils.validateAccountLogin(username, ppkey, bchain);
		console.log('isValidUser');
		//console.log(isValidUser);
		//if (username === mockedUsername && ppkey === mockedPpkey) {
		if (isValidUser.result){
			let token = jwt.sign({username: username},
			  config.secret,
			  { expiresIn: '24h' // expires in 24 hours
			  }
			);
			//save to DB
			//save encrypted version + token
			if (!user_tkn){
				user_tkn = new Object();
			}
			user_tkn.user = username;
			user_tkn.token = token;
			user_tkn.ppkey = ciphertext;
			user_tkn.lastlogin = new Date();
			//keep record free from deletion on cleanup
			if (req.body && req.body.keeploggedin){
				user_tkn.keeploggedin = req.body.keeploggedin;
			}
			//keep record of login source
			if (req.body && req.body.loginsource){
				user_tkn.loginsrc = req.body.loginsource;
			}
			let db_save = await db_col.save(user_tkn);
			
			// return the JWT token for the future API calls
			res.json({
			  success: true,
			  message: 'Authentication successful!',
			  token: token,
			  userdata: isValidUser.account
			});
		  } else {
			res.status(403).send({
			  success: false,
			  message: 'Incorrect username or ppkey'
			});
		}
    } else {
      res.status(400).send({
        success: false,
        message: 'Authentication failed! Please check the request'
      });
    }
});


/* end point for user total token count display */
app.get('/user/:user', async function (req, res) {
	let user; 
	if (req.query && req.query.fullBalance){
		user = await grabUserTokensFunc(req.params.user, true);
	}else{
		user = await grabUserTokensFunc(req.params.user);
	}
    res.send(user);
});

app.get('/userFullBal/:user', async function (req, res) {
	let user = await grabUserTokensFunc(req.params.user, true);
	res.send(user);
});
app.get('/thread_param/', async function(req, res) {
	res.send(process.env.BOT_THREAD);
})

/* end point for user transactions display (per user or general actifit token transactions, limited by 1000) */
app.get('/transactions/:user?', async function (req, res) {
	let query = {};
	var transactions;
	let pageSize = isNaN(req.query.itemCount)? 1000:parseInt(req.query.itemCount);
	if (pageSize > 1000) pageSize = 1000;
	
	const pageNumber = req.query.page || 1; // default page is 1
	const skip = (pageNumber - 1) * pageSize;
	
	if(req.params.user){
		query = {user: req.params.user}
		transactions = await db.collection('token_transactions')
			.find(query, {fields : { _id:0} })
			.sort({date: -1})
			.skip(skip)
			.limit(pageSize).toArray();
	}else{
		//only limit returned transactions in case this is a general query
		transactions = await db.collection('token_transactions')
			.find(query, {fields : { _id:0} })
			.sort({date: -1})
			.skip(skip)
			.limit(pageSize).toArray();
	}
    res.send(transactions);
});

app.get('/postsbytag/:tag', async function (req, res) {
	let posts = {};
	if(req.params.tag){
		let query = {"json_metadata.tags": {$all: [req.params.tag]}};
		posts = await db.collection('verified_posts').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	}
	res.send(posts);
});

/* end point for transactions display by type (limited by 1000) */
app.get('/transactionsByType/', async function (req, res) {
	let query = {};
	let transactions = {};
	let proceed = false;
	let dateSort = 1;
	let sortQuery = {};
	if (req.query.type){
		proceed = true;
		query = {reward_activity: req.query.type}
		
	}
	if (req.query.chain){
		query['chain'] = req.query.chain;
	}
	if (req.query.datesort){
		dateSort = parseInt(req.query.datesort)
		sortQuery = {date: dateSort};
	}else if (req.query.sortByToken && !isNaN(req.query.sortByToken)){
		sortQuery = {token_count: parseInt(req.query.sortByToken)};
	}
	console.log(sortQuery);
	//default end date as yesterday
	let endDate = moment(moment().utc().subtract(1, 'days').toDate()).format('YYYY-MM-DD');
	//default start date as day before
	let startDate = moment(moment(endDate).utc().subtract(1, 'days').toDate()).format('YYYY-MM-DD');;	
	console.log('startDate:'+startDate);
	console.log('endDate:'+endDate);
	if (req.query.startDate){
		startDate = moment(moment(req.query.startDate).utc().startOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	}
	if (req.query.endDate){
		//let endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
		endDate = moment(moment(req.query.endDate).utc().endOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	}
	if (startDate && endDate){
		query['date'] = {
					"$lt": new Date(endDate),
					"$gte": new Date(startDate)
				};
	}else if (startDate){
		query['date'] = {
					"$gte": new Date(startDate)
				};
	}
	console.log(query);
	if (proceed){
		transactions = await db.collection('token_transactions').find(query).sort(sortQuery).limit(1000).toArray();
	}
    res.send(transactions);
});


/* end point for user signup display (per user or general signups */
app.get('/signups/:user?', async function (req, res) {
	let query = {account_created: true};
	var referrals;
	if(req.params.user){
		query['referrer'] = req.params.user;
		referrals = await db.collection('signup_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	}else{
		//only limit returned referrals in case this is a general query
		referrals = await db.collection('signup_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(1000).toArray();
	}
    res.send(referrals);
});

app.get('/referrals/:user?', async function (req, res) {
	let query = {account_created: true, referrer:{$ne:null}};
	let referrals;
	if(req.params.user){
		query['referrer'] = req.params.user;
		referrals = await db.collection('signup_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	}else{
		//only limit returned referrals in case this is a general query
		referrals = await db.collection('signup_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(1000).toArray();
	}
    res.send(referrals);
});

app.get('/signupInfo/:user', async function (req, res) {
	let query = {account_name: req.params.user, account_created: true};
	let referrals = await db.collection('signup_transactions').findOne(query, {fields : { _id:0} });
    if (!referrals){
		referrals = {};
	}
	res.send(referrals);
});


/* end point for fetching all verified newbie accounts */
app.get('/activeVerifiedNewbies/', async function (req, res) {
	let maxRewardDate = moment(moment().utc().subtract(config.newbie_rewards_days, 'days').toDate()).toDate();
	console.log(maxRewardDate);
	let query = {
					verify_date: {
						$gte: new Date(maxRewardDate),
					}
				};
	
	console.log(query);
	let data = await db.collection('verified_newbie').find(query).sort({date: -1}).toArray();
	if (!data){
		data = {};
	}
	res.send(data);
});


/* end point for fetching all verified newbie accounts */
app.get('/verifiedNewbies/', async function (req, res) {
	let data = await db.collection('verified_newbie').find().sort({date: -1}).toArray();
	if (!data){
		data = {};
	}
	res.send(data);
});

app.get('/activeRefReward/:referred', async function (req, res) {
	//referral rewards are active for up to 30 days
	let maxSignupDate = moment(moment().utc().subtract(config.ref_rew_act_days, 'days').toDate()).toDate();
	console.log(maxSignupDate);
	let query = {account_name: req.params.referred, account_created: true, date: {$gte: maxSignupDate}};
	let refReward = await db.collection('signup_transactions').findOne(query, {fields : { _id:0} });
	console.log(refReward);
	if (refReward){
		refReward.ref_rew_act_days = config.ref_rew_act_days;
		//calculate user reward percentage
		refReward.ref_rew_pct = config.ref_rew_def_pct + (parseFloat(refReward.referrer_cur_rank)>=config.userRankMin?5:0) + (parseFloat(refReward.referrer_cur_afit)>=config.userTokensMin?5:0) + (parseFloat(refReward.referrer_cur_afitx)>=config.afitxMin?5:0);
	}else{
		refReward = {};
	}
    res.send(refReward);
});

/* end point for returning number of awarded users and tokens distributed */
app.get('/user-tokens-info', async function(req, res) {

	await db.collection(collection_name).aggregate([
		{
			$match: {}
		},
		{
		   $group:
			{
			   _id: null,
			   tokens_distributed: { $sum: "$tokens" },
			   user_count: { $sum: 1 }
			}
		}
	   ]).toArray(function(err, results) {
		if (results.length>0){
			try{
				var output = 'rewarded users:'+results[0].user_count+',';
				output += 'tokens distributed:'+results[0].tokens_distributed;
				res.send(results);
				console.log(results);
			}catch(err){
				console.log(err);
				res.send('');
			}
		}else{
			res.send('');
		}
	   });

});

app.get('/tokensBurnt', async function (req, res) {
	let agg = await db.collection('token_transactions').aggregate([
		{
			$match: {
				reward_activity: 'Buy Product',
				seller: 'actifit'
			}
		},
		{
		   $group:
			{
				_id: null,
			   	tokens_burnt: { $sum: "$token_count" },
				burn_trx_count: { $sum: 1 }

			}
		}
	]).toArray(function(err, results) {
		if (results.length>0){
			results[0].tokens_burnt = Math.abs(results[0].tokens_burnt);
			res.send(results);
			console.log(results);
		}
	});
});

/* end point for user total token count display */
app.get('/modAction', async function (req, res) {
	if (!req.query.moderator || !req.query.fundsPass || !req.query.targetAction){
		res.send({'error':'Missing Data'});
	}else{
		let moderator = req.query.moderator;
		let fundsPass = req.query.fundsPass;
		
		//confirm matching funds password
		let query = {user: moderator};
		
		if (!isModerator(moderator)){
			res.send({'error': 'Account does not have proper privileges'});
			return;
		}
		
		let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(fundsPass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
		
		//reached here, we're fine
		console.log('reached here, we\'re fine');
		
		let result = '';
		
		//store every moderator transaction as log
		let modTrans = {
			"moderator": req.query.moderator,
			"action": req.query.targetAction,
			"date": new Date(),
		};
		
		console.log(req.query.targetAction);
		
		switch(req.query.targetAction){
		
			case 'ban': 			
						modTrans.user = req.query.banuser.trim().toLowerCase();
						collection = db.collection('banned_accounts')
						//var dt = new Date().toJSON()
						//dt.substring(0,dt.indexOf("."));
						
						if (modTrans.user == ''){
							res.send({'error': 'Cannot ban empty user'});
							return;
						}
						result = await collection.insert({   
							"user": modTrans.user,
							"ban_date": new Date(),
							"ban_length": req.query.ban_length,
							"ban_status": 'active',
							"ban_reason": req.query.ban_reason
						});
						console.log(req.query.banuser+" banned ");
						result.status='success';
						break;
			case 'unban':
						
						modTrans.user = req.query.unbanuser.trim().toLowerCase();
						collection = db.collection('banned_accounts')
		
						if (modTrans.user == ''){
							res.send({'error': 'Cannot unban empty user'});
							return;
						}
		
						result = await collection.update(
							{   "user": req.query.unbanuser.trim().toLowerCase() }, 
							{
								$set: {
									"ban_status": "inactive",
									}
							},
							{
								multi: true
							}
						);
						console.log(req.query.unbanuser+" ban removed! ");
						result.status='success';
						break;
						
			case 'resetpass':
						modTrans.user = req.query.resetuser.trim().toLowerCase();
						
						collection = db.collection('account_funds_pass')
						
						if (modTrans.user == ''){
							res.send({'error': 'Cannot resetpass empty user'});
							return;
						}
		
						let user = req.query.resetuser.trim().toLowerCase();
						result = 'no change';
						if (user!=''){
							result = await collection.remove({
								"user": user,
							});
							console.log(user+" password reset ");
						}
						console.log(user+" pass reset! ");
						result.status='success';
						break;
						
			case 'reward':
						modTrans.fullurl = req.query.fullurl.trim().toLowerCase();
						modTrans.vp = req.query.power;
						if (modTrans.fullurl == ''){
							res.send({'error': 'Need to send URL to vote'});
							return;
						}
						
						if (isNaN(modTrans.vp)){
							res.send({'error': 'VP needs to be numeric'});
							return;
						}
						let bchain = (req.query&&req.query.bchain?req.query.bchain:'');
						result = await utils.rewardPost(modTrans.fullurl, modTrans.vp, bchain)
						console.log(result);
						result.status='success';
						break;
						
			case 'verifynewbie': 			
						modTrans.user = req.query.account.trim().toLowerCase();
						collection = db.collection('verified_newbie')
						//var dt = new Date().toJSON()
						//dt.substring(0,dt.indexOf("."));
						
						if (modTrans.user == ''){
							res.send({'error': 'Cannot verify empty user'});
							return;
						}
						result = await collection.insert({   
							"user": modTrans.user,
							"verify_date": new Date(),
							"sm_verif_lnk": req.query.verif_link,
							"verif_mod": moderator
						});
						console.log(modTrans.user+" verified ");
						result.status='success';
						break;
						
			case 'freesignup': 			
						collection = db.collection('signup_promo_codes')
						//var dt = new Date().toJSON()
						//dt.substring(0,dt.indexOf("."));
						
						if (modTrans.user == ''){
							res.send({'error': 'Cannot verify empty user'});
							return;
						}
						modTrans.signusername = req.query.signusername;
						modTrans.txlink = req.query.txlink;
						let randomCode = generatePassword(1);
						result = await collection.insert({   
							"code": randomCode,
							"entries": 1,
							"delegation": true,
							"signup_reward": true,
							"referrer_reward": true
						});
						console.log(modTrans.user+" verified ");
						result.status='https://actifit.io/signup?promo='+randomCode;
						break;
		}
		
		collection = db.collection('team_transactions');
		let modTransRes = await collection.insert(modTrans);
		console.log(modTransRes)
		
		res.send(result);
	}
});

async function isUserBridgeEligible (user, customDate){
	let query = {user: user}
	let targetDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	console.log(targetDate);
	if (customDate){
		targetDate = customDate;
	}
	query.date = {
				"$gte": new Date(targetDate)
	}
	console.log(query);
	let entries = await db.collection('bsc_bridge_queue').find(query).toArray();
	console.log(entries);
	if (entries.length > 0){
		return false;
	}
	return true;
}

//confirms whether user can still use bridge today or certain date (if he already scheduled a transaction or one is complete)
app.get('/userBridgeEligible', async function (req, res) {
	if (!req.query || !req.query.user){
		res.send({});
		return;
	}
	let targetDate;
	if (req.query.date){
		targetDate = moment(moment(req.query.date).utc().startOf('date').toDate()).format('YYYY-MM-DD');;
	}
	let userStatus = await isUserBridgeEligible(req.query.user, targetDate);
	
	res.send ({'eligible': userStatus});
	
})

//query user bridge transactions by req.query.user and optional status and starting date
app.get('/userBridgeTransactions', async function (req, res) {
	//fetch queue by oldest
	if (!req.query || !req.query.user){
		res.send({});
		return;
	}
	let query = {user: req.query.user}
	if (req.query.status){
		query.status = req.query.status;
	}
	if (req.query.date){
		let targetDate = moment(moment(req.query.date).utc().startOf('date').toDate()).format('YYYY-MM-DD');;
		query.date = {
					"$gt": new Date(targetDate)
		}
	}
	let entries = await db.collection('bsc_bridge_queue').find(query).sort({date: 1}).toArray();
	res.send(entries);
});


app.get('/completedBridgeTransactions', async function (req, res) {
	//fetch queue by oldest
	let entries = await db.collection('bsc_bridge_queue').find({status: 'complete'}).sort({date: 1}).toArray();
	res.send(entries);
});

app.get('/pendingBridgeTransactions', async function (req, res) {
	//fetch queue by oldest
	let entries = await db.collection('bsc_bridge_queue').find({status: 'pending'}).sort({date: 1}).toArray();
	res.send(entries);
});

app.get('/appendBridgeTransaction', checkHdrs, async function (req, res) {
	//validate proper data used
	if (!req.query || !req.query.user || !req.query.afitTrx || !req.query.hbdTrx){
		res.send({error:'missing data'});
		return;
	}
	//check eligibility for another transaction
	let isUserEligible = isUserBridgeEligible(req.query.user);
	if (!isUserEligible){
		res.send({error:'You have already sent out a transaction today. You can only transact once per day.'});
		return;
	}
	let username = req.query.user;
	let wallet = req.query.wallet;
	let afitTrx = req.query.afitTrx;
	let hbdTrx = req.query.hbdTrx;
	//let	walletChain = req.query.chain?req.query.chain:"BSC";
	//store user/token combination
	let bridgeEntry = {
		user: username,
		wallet: wallet,
		afitTrx: afitTrx,
		hbdTrx: hbdTrx,
		status: 'pending',
		date: new Date()
	};
	try{
		let transaction = await db.collection('bsc_bridge_queue').insert(bridgeEntry);
		res.send({status: 'success'});
	}catch(err){
		res.send({error: 'error'});
		console.log(err);
	}
	
});


app.get('/verifySignBSCAdd', checkHdrs, async function (req, res) {
	let nonce = "\x19Ethereum Signed Message:\n" + req.query.nonce.length + req.query.nonce;//"\x19Ethereum Signed Message:\n" + nonce.length + nonce
	console.log(nonce);
	nonce = ethutil.keccak(Buffer.from(nonce, "utf-8"))
	const { v, r, s } = ethutil.fromRpcSig(req.query.sign)
	const pubKey = ethutil.ecrecover(ethutil.toBuffer(nonce), v, r, s)
	const addrBuf = ethutil.pubToAddress(pubKey)
	const addr = ethutil.bufferToHex(addrBuf)
	console.log('orig:'+req.query.wallet);
	console.log(pubKey);
	console.log('out:'+addr);
	
	if (addr.toLowerCase() == req.query.wallet.toLowerCase()){
		console.log('correct address');
		res.send({success: true});
	}else{
		console.log('incorrect address');
		res.send({error: 'incorrect address'});
	}
})

app.get('/storeUserWalletAddress', checkHdrs, async function (req, res) {
	//validate proper data used
	if (!req.query || !req.query.user || !req.query.wallet){
		res.send({error:'error'});
		return;
	}
	let username = req.query.user;
	let wallet = req.query.wallet;
	let	walletChain = req.query.chain?req.query.chain:"BSC";
	//store user/token combination
	let userWalletEntry = {
		user: username,
		wallet: wallet,
		chain: walletChain,
		date: new Date()
	};
	try{
		let transaction = await db.collection('user_wallet_address').update({user: username, chain: walletChain}, userWalletEntry, { upsert: true });
		res.send({status: 'success'});
	}catch(err){
		res.send({error: 'error'});
		console.log(err);
	}
});



app.get('/deleteUserWalletAddress', checkHdrs, async function (req, res) {
	//validate proper data used
	if (!req.query || !req.query.user){
		res.send({error:'error'});
		return;
	}
	let username = req.query.user;
	//let wallet = req.query.wallet;
	let	walletChain = req.query.chain?req.query.chain:"BSC";
	//delete user/wallet combination
	
	try{
		let transaction = await db.collection('user_wallet_address').remove({user: username, chain: walletChain});
		res.send({status: 'success'});
	}catch(err){
		res.send({error: 'error'});
		console.log(err);
	}
});

app.get('/getUserWalletAddress', async function (req, res){
	if (!req.query.user){
		res.send({error:'error'});
		return;
	}
	let user = req.query.user;
	let	walletChain = req.query.chain?req.query.chain:"BSC";
	let matchAddress = await db.collection('user_wallet_address').find({user: user, chain: walletChain}).sort({tokens: -1}).toArray();
	res.send(matchAddress);
});
/*
app.get('/afitAirdropHive', async function (req, res){
	let participants = await db.collection('user_wallet_address').find({chain: 'BSC'}).toArray();
	console.log(participants.length);
	let delay = 0;
	for (let entry of participants) {
		setTimeout(async function(){
			//grab tokens of the user on actifit wallet
			let afit_wallet = await grabUserTokensFunc(entry.user);
			console.log('afit_wallet:'+afit_wallet.tokens);
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
			let tot_tokens = parseFloat(afit_wallet.tokens) + parseFloat(afit_he_bal_val) + parseFloat(afit_se_bal_val);
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
					tokens_count: tot_tokens,
					actifit_wallet_afit_bal: afit_wallet.tokens,
					afit_he_bal: afit_he_bal_val,
					afit_se_bal: afit_se_bal_val,
					afit_bsc_reward: reward, 
					date: new Date()
				}
				//insert into airdrop snapshot
				let transaction = await db.collection('afit_bsc_hive_airdrop').insert(airdrop_entry);
				res.write(JSON.stringify(transaction));
			}
		}, delay+=1500);
	}
	//res.end();
	//afit_bsc_hive_airdrop
})
*/

/*
app.get('/airdropDataDisplay', async function (req, res){
	console.log('airdrop data');
	let entries = await db.collection('afit_bsc_hive_airdrop_wallets').find().toArray();
	let display = '';
	for (let entry of entries){
		display += entry.wallet+','+entry.reward+'<br/>';
	}
	res.send(display);
})
*/

app.get('/airdropDataDisplay', async function (req, res){
	console.log('airdrop data');
	let entries = await db.collection('afit_bsc_hive_airdrop_wallets').find().toArray();
	let display = '[';
	for (let entry of entries){
		display += '"'+entry.wallet+'",'
	}
	display += ']\n\n\n[';
	for (let entry of entries){
		display += Math.floor(entry.reward)+','
	}
	display += ']';
	res.send(display);
})



app.get('/airdropData', async function (req, res){
	console.log('airdrop data');
	let entries = await db.collection('afit_bsc_hive_airdrop').find().toArray();
	let totalAirdrop = 0;
	let updated_entries = [];
	for (let entry of entries){
		totalAirdrop += entry.afit_bsc_reward;
		//find matching wallet
		let wallet_entry = await db.collection('user_wallet_address').findOne({user: entry.user});
		entry.wallet_address = wallet_entry.wallet;
		updated_entries.push({'wallet': entry.wallet_address, 'reward': entry.afit_bsc_reward});
		//let transaction = await db.collection('afit_bsc_hive_airdrop_wallets').insert({'wallet': entry.wallet_address, 'user':entry.user,'reward': entry.afit_bsc_reward});
	}
	res.send(updated_entries);
})

app.get('/airdropResults', async function (req, res){
	if (!req.query || !req.query.user){
		res.send({error: 'error'});
		return;
	}
	let entry = await db.collection('afit_bsc_hive_airdrop').findOne({user: req.query.user});
	res.send(entry);
})

app.get('/sendAirdropResultsNotif', async function (req, res){
	let entries = await db.collection('afit_bsc_hive_airdrop').find().toArray();
	let delay = 0;
	for (let entry of entries){
		setTimeout(async function(){
		//send notification to user
			console.log(entry);
		//res.write(entry);
			utils.sendNotification(db, entry.user, 'actifit', 'airdrop_results', 'airdrop', 'Congrats! Your snapshot total AFIT amount was '+entry.tokens_count+'. This makes you eligible for '+entry.afit_bsc_reward+' reward! Tokens will be distributed to your BSC wallet address upon actifit DeFi launch. You can check your balance by visiting your wallet on actifit.io', 'https://actifit.io/wallet');
		}, delay+=3000);
		//break;
	}
	
});

/* end point for user total token count display */
app.get('/topAFITHolders', async function (req, res) {
	let tokenHolders = [];
	if (isNaN(req.query.count)){
		tokenHolders = await db.collection('user_tokens').find().sort({tokens: -1}).toArray();
	}else{
		tokenHolders = await db.collection('user_tokens').find().sort({tokens: -1}).limit(parseInt(req.query.count)).toArray();
	}
    res.send(tokenHolders);
});

/* end point for user total token count display */
app.get('/topAFITHEHolders', async function (req, res) {
	let afitSorted = utils.sortArrLodash(usersAFITBal);
	fullSortedAFITList = afitSorted;
	/*let maxAmount = parseInt(req.query.count);
	if (isNaN(maxAmount)){
		//set max as 100
		maxAmount = 100;
	}
	
	//fetch banned accounts
	let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}, {fields : { user: 1, _id: 0 } }).toArray();
	//console.log(banned_users);
	let banned_arr = banned_users.map(entr => entr.user);
	banned_arr.push('afitx.s-e');
	banned_arr.push('afitx.h-e');
	banned_arr.push('');
	
	afitSorted = utils.removeArrMatchLodash(afitSorted, banned_arr, 'account');
	*/
	//always skip top holder as that would be actifit
	//afitxSorted = afitxSorted.slice(1, maxAmount + 1);
	
	let output = afitSorted;
	
	/*
	if (req.query.pretty){
		output = '#|Token Holder | AFITX Tokens Held |<br/>';
		output += '|---|---|---|<br/>';
		for(var i = 0; i < afitxSorted.length; i++) {
			let tokenHolder = afitxSorted[i];
			output += (i+1) + '|';
			output += '@'+tokenHolder.account + '|';
			output += gk_add_commas(parseFloat(tokenHolder.balance).toFixed(3)) + '|';
			output += '<br/>';
		}
	}
	*/
    res.send(output);
});



/* end point for user total token count display */
app.get('/topAFITXHolders', async function (req, res) {
	let afitxSorted = utils.sortArrLodash(usersAFITXBal);
	fullSortedAFITXList = afitxSorted;
	let maxAmount = parseInt(req.query.count);
	if (isNaN(maxAmount)){
		//set max as 100
		maxAmount = 100;
	}
	
	//fetch banned accounts
	let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}, {fields : { user: 1, _id: 0 } }).toArray();
	//console.log(banned_users);
	let banned_arr = banned_users.map(entr => entr.user);
	banned_arr.push('afitx.s-e');
	banned_arr.push('afitx.h-e');
	banned_arr.push('');
	
	afitxSorted = utils.removeArrMatchLodash(afitxSorted, banned_arr, 'account');
	
	//always skip top holder as that would be actifit
	afitxSorted = afitxSorted.slice(1, maxAmount + 1);
	
	let output = afitxSorted;
	
	if (req.query.pretty){
		output = '#|Token Holder | AFITX Tokens Held |<br/>';
		output += '|---|---|---|<br/>';
		for(var i = 0; i < afitxSorted.length; i++) {
			let tokenHolder = afitxSorted[i];
			output += (i+1) + '|';
			output += '@'+tokenHolder.account + '|';
			output += gk_add_commas(parseFloat(tokenHolder.balance).toFixed(3)) + '|';
			output += '<br/>';
		}
	}
	
    res.send(output);
});

/* end point for fetching user AFITX data */
app.get('/afitxData/:user', async function (req, res) {
    let val = await getAFITXUserData(req.params.user);
	res.send(val);
});



/* end point for returning total delegation payments (number of delegators and amount paid) on a specific date */
app.get('/delegationPayments', async function(req, res) {
	var todayDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	var dateRegex = todayDate; // /^2018-08-05/
	if (req.query.targetDate){
		dateRegex = req.query.targetDate;
	}
	
	await db.collection('token_transactions').aggregate([
		{
			$match: 
			{
				"reward_activity": "Delegation",
				"date": {
					'$eq' : new Date(dateRegex)
					}
			}
		},
		{
		   $group:
			{
			   _id: null,
			   tokens_distributed: { $sum: "$token_count" },
			   user_count: { $sum: 1 }
			}
		}
	   ]).toArray(function(err, results) {
		res.send(results);
		console.log(results);
	   });

});


/* end point for returning total payments (categorized by reward type as well as a full total) on a specific date */
app.get('/totalTokensDistributed', async function(req, res) {
	
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	var endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	await db.collection('token_transactions').aggregate([
		{
			$match: 
			{
				"date": {
					"$lte": new Date(endDate),
					"$gt": new Date(startDate)
				}
			}
		},
		{
		   $group:
			{
			   _id: {reward_activity:"$reward_activity"},
			   tokens_distributed: { $sum: "$token_count" },
			}
		}
	   ]).toArray(function(err, results) {
		//also append total token count to the grouped display
		let tot_tokens = 0;
		for (let entry of results) {
			tot_tokens += entry.tokens_distributed;
		}
		console.log(tot_tokens);
		results.push([{"_id":null,"tokens_distributed":tot_tokens}]);
		
		res.send(results);
		console.log(results);
	   });

});

/* end point for returning count of posts/activities rewarded */
app.get('/rewarded-activity-count', async function(req, res) {

	await db.collection("posts").aggregate( [
		{ $count: "reward_count" }
	]).toArray(function(err, results) {
		console.log(results);
		utils.log(results, 'rewarded-activity-count');
		res.send(results);
	});
});

/* end point for returning charity data supported by actifit */
app.get('/charities', async function (req, res) {
	var charities = await db.collection('available_charities').find({status:"enabled"}, {charity_name: 1}).sort({charity_name: 1}).toArray();
    res.send(charities);
});

/* end point for fetching user's current badges */
app.get('/userBadges/:user', async function (req, res) {
	let user = await db.collection('user_badges').find({user: req.params.user}).toArray();
	res.send(user);
});

async function getUserFriends(user){
	let friendsA = await db.collection('friends').find({userA: user}, {fields : {userB:1, _id:0}}).toArray();
	let friendsB = await db.collection('friends').find({userB: user}, {fields : {userA:1, _id:0}}).toArray();
	console.log(friendsA);
	console.log(friendsB);
	friendsA = JSON.parse(JSON.stringify(friendsA).replace(/userB/g,'friend'));
	friendsB = JSON.parse(JSON.stringify(friendsB).replace(/userA/g,'friend'));
	return friendsA.concat(friendsB);
}

/* end point for fetching user's friends */
app.get('/userFriends/:user', async function (req, res) {
	let friendList = await getUserFriends(req.params.user);
	res.send(friendList);
});

/* end point for marking a notification as read */
app.get('/markRead/:notif_id', checkHdrs, async function (req, res) {
	let notif_to_update = {
		_id: new ObjectId(req.params.notif_id),
	};
	try{
		let transaction = await db.collection('notifications').update(notif_to_update, { $set: {status: 'read'} } );
		console.log('success updating notification status');
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}
});

/* end point for marking a notification as Unread */
app.get('/markUnread/:notif_id', checkHdrs, async function (req, res) {
	let notif_to_update = {
		_id: new ObjectId(req.params.notif_id),
	};
	try{
		let transaction = await db.collection('notifications').update(notif_to_update, { $set: {status: 'unread'} } );
		console.log('success updating notification status');
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}
});

/* end point for marking all user's notifications as read */
app.get('/markAllRead/', checkHdrs, async function (req, res) {
	let notif_to_update = {
		user: req.query.user,
	};
	console.log('markAllRead');
	console.log(notif_to_update);
	try{
		let transaction = await db.collection('notifications').update(notif_to_update, { $set: {status: 'read'} }, {multi: true} );
		console.log('success updating notification status');
		console.log(transaction);
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}
});


/* end point for tracking AFIT buy orders */
app.get('/buyAFITHive/:user/:amnt/:afitAmnt/:blockNo/:trxID/:bchain', async function (req, res) {
	
	let user = req.params.user;
	//HIVE amount paid
	let amnt = req.params.amnt;
	let afitAmnt = req.params.afitAmnt;
		
	//check if query has already been verified
	let matchingEntries = await db.collection('afit_buy_transactions_hive').find(
		{
			//blockNo: req.params.blockNo,
			trxID: req.params.trxID,
			bchain: req.params.bchain
		}).toArray();
	
	if (Array.isArray(matchingEntries) && matchingEntries.length > 0){
		res.send({'error': 'Transaction already verified'});
		return;
	}
	
	//grab AFIT live conversion rate
	let matchingAfit = parseFloat(amnt) / exchangeAfitPrice.afitHiveLastPrice;
	
	//round down number
	console.log('Before rounding');
	console.log(matchingAfit);
	matchingAfit = (Math.floor(matchingAfit * 1000) - 1) / 1000;
	
	//ensure proper transaction
	let ver_trx = await utils.verifyAFITBuyTransaction(req.params.user, amnt, afitAmnt, matchingAfit, 'buy-afit', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx || !ver_trx.success){
		res.send({status: 'error'});
		return;
	}
	
	//perform transaction
	let productBuyTrans = {
		user: user,
		buyer: user,
		seller: 'actifit',
		hive_paid: ver_trx.amount_hive,
		afit_requested: afitAmnt,
		afit_received: matchingAfit,
		currency: req.params.bchain,
		blockNo: req.params.blockNo,
		trxID: req.params.trxID,
		bchain: req.params.bchain,
		note: 'Bought '+matchingAfit+ ' For '+ver_trx.amount_hive+' '+req.params.bchain,
		date: new Date(),
	}
	try{
		console.log(productBuyTrans);
		let transaction = await db.collection('afit_buy_transactions_hive').insert(productBuyTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
	}
	
	//store as transaction to update user token count
	
	//perform transaction
	let recordTrans = {
		user: user,
		reward_activity: 'Buy AFIT',
		buyer: user,
		seller: 'actifit',
		hive_paid: ver_trx.amount_hive,
		afit_requested: afitAmnt,
		currency: req.params.bchain,
		token_count: matchingAfit,
		note: 'Bought '+matchingAfit+ ' For '+ver_trx.amount_hive+' '+req.params.bchain,
		date: new Date(),
	}
	try{
		console.log(recordTrans);
		let transaction = await db.collection('token_transactions').insert(recordTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
	}
	
	
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	//add a ticket to the user to enter draw if user meets min requirements
	/*
	if (cur_user_token_count >= config.minUserTokensGadgetTicket){
		//perform transaction
		let ticketEntry = {
			user: user,
			product_id: product_id,
			product_name: product.name,
			product_level: product.level,
			product_price_afit: item_price_afit,
			product_price_hive: item_price,
			hive_paid: ver_trx.amount_hive,
			currency: req.params.bchain,
			count: 1,
			date: new Date(),
		}
		let transaction = await db.collection('gadget_buy_tickets').insert(ticketEntry);
	}*/
	//update current user's token balance & store to db
	let new_token_count = cur_user_token_count + parseFloat(matchingAfit);
	user_info.tokens = new_token_count;
	console.log('new_token_count:'+new_token_count);
	try{
		let trans = await db.collection('user_tokens').save(user_info);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	//send notification to user
	utils.sendNotification(db, user, 'actifit', 'buy_afit', 'market', 'You successfully bought "' + matchingAfit + ' AFIT" for '+'"'+ver_trx.amount_hive+'" '+req.params.bchain, 'https://actifit.io/'+user+'/wallet');
	
	res.send({status: 'success', boughtAmnt: matchingAfit, tokens: new_token_count});
	
});


app.get('/cancelAFITBuy', async function(req, res){
	if (!req.query.specPass || req.query.specPass != config.specPass){
		res.send({error:'error'});
		return;
	}
	let user = req.query.user;
	let afit_amnt_refund = req.query.afit;
	
	//perform transaction
	let recordTrans = {
		user: req.query.user,
		reward_activity: 'AFIT Buy Cancellation',
		buyer: user,
		seller: 'actifit',
		token_count: -afit_amnt_refund,
		note: 'Cancellation of AFIT purchase with HIVE refund ',
		date: new Date(),
	}
	try{
		console.log(recordTrans);
		let transaction = await db.collection('token_transactions').insert(recordTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
	}
	
	//fetch user current token count
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	//update current user's token balance & store to db
	let new_token_count = cur_user_token_count - parseFloat(afit_amnt_refund);
	user_info.tokens = new_token_count;
	console.log('new_token_count:'+new_token_count);
	try{
		let trans = await db.collection('user_tokens').save(user_info);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	res.send({status: 'success'});
	
	//send notification to user
	//utils.sendNotification(db, user, 'actifit', 'buy_afit', 'market', 'You have been refunded amount "' + afit_amnt_refund + ' for cancelled product purchase '+product.name, 'https://actifit.io/'+user+'/wallet');
	
});

app.get('/refundPurchase', async function(req, res){
	if (!req.query.specPass || req.query.specPass != config.specPass){
		res.send({error:'error'});
		return;
	}
	let user = req.query.user;
	let product_id = req.query.product_id;
	let afit_amnt_refund = req.query.afit_paid;
	let product = await grabProductInfo (product_id);
	if (!product){
		res.send({'error': 'Product not found'});
		return;
	}
	
	//perform transaction
	let recordTrans = {
		user: req.query.user,
		reward_activity: 'Refund Product',
		product_id: product_id,
		product_name: product.name,
		buyer: user,
		seller: 'actifit',
		token_count: parseFloat(afit_amnt_refund),
		note: 'Refunding product '+product.name,
		date: new Date(),
	}
	try{
		console.log(recordTrans);
		let transaction = await db.collection('token_transactions').insert(recordTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
	}
	
	//fetch user current token count
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	//update current user's token balance & store to db
	let new_token_count = cur_user_token_count + parseFloat(afit_amnt_refund);
	user_info.tokens = new_token_count;
	console.log('new_token_count:'+new_token_count);
	try{
		let trans = await db.collection('user_tokens').save(user_info);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	res.send({status: 'success'});
	
	//send notification to user
	utils.sendNotification(db, user, 'actifit', 'buy_afit', 'market', 'You have been refunded amount "' + afit_amnt_refund + ' for cancelled product purchase '+product.name, 'https://actifit.io/'+user+'/wallet');
	
});


app.get('/updateProdStatus', async function(req, res){
	if (!req.query.specPass || req.query.specPass != config.specPass || !req.query.user || !req.query.status || !req.query.trx_id){
		res.send({error:'error'});
		return;
	}
	let user = req.query.user;
	let trx_id = new ObjectId(req.query.trx_id);
	let note = req.query.note;
	
	let query = {user: req.query.user, _id: trx_id}
	let prodTrans = await db.collection('products_bought').findOne(query);
	
	if (!prodTrans){
		res.send({'error': 'Transaction not found'});
		return;
	}
	
	let old_status = prodTrans.status;
	let prod_name = prodTrans.gadget_name;
	prodTrans.last_updated = new Date();
	prodTrans.status = req.query.status;
	prodTrans.note = note;
	//perform transaction
	try{
		let trans = await db.collection('products_bought').save(prodTrans);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	//insert transaction to keep track of product progress
	//perform transaction
	let recordTrans = {
		user: req.query.user,
		reward_activity: 'Product Purchase Update',
		product_id: prodTrans.gadget,
		transaction_id: req.query.trx_id,
		product_name: prod_name,
		old_status: old_status,
		new_status: req.query.status,
		note: 'Changing product "'+prod_name+'" status from "'+old_status+'" to "'+req.query.status+'" with note "'+ note+'"' ,
		date: new Date(),
	}
	try{
		console.log(recordTrans);
		let transaction = await db.collection('order_progress').insert(recordTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
	}
	
	//send notification to user
	utils.sendNotification(db, user, 'actifit', 'real_product_update', 'market', 'Your order for product "' + prod_name + '" has been moved to status "'+req.query.status+'" with note "'+note+'"', 'https://actifit.io/market');
	
	res.send({status: 'success'});
			
	//also notify actifit management
	for (let iter=0;iter<config.management.length;iter++){
		utils.sendNotification(db, config.management[iter], 'actifit', 'real_product_update', 'management', 'User '+user+' order for product "' + prod_name +'" changed to status "'+req.query.status+'"', 'https://actifit.io/mods-access/');
		
	}
	
	
});

/* end point to confirm product receipt, can only be validated by the user himself */

app.get('/confirmProdReceipt', checkHdrs, async function(req, res){
	if (!req.query.user || !req.query.trx_id){
		res.send({error:'error'});
		return;
	}
	let user = req.query.user;
	let trx_id = new ObjectId(req.query.trx_id);
	let newStatus = 'delivered';
	
	let note = req.query.note;
	
	let query = {user: req.query.user, _id: trx_id}
	let prodTrans = await db.collection('products_bought').findOne(query);
	
	if (!prodTrans){
		res.send({'error': 'Transaction not found'});
		return;
	}
	
	let old_status = prodTrans.status;
	let prod_name = prodTrans.gadget_name;
	prodTrans.last_updated = new Date();
	prodTrans.status = newStatus;
	prodTrans.note = note;
	//perform transaction
	try{
		let trans = await db.collection('products_bought').save(prodTrans);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	//insert transaction to keep track of product progress
	//perform transaction
	let recordTrans = {
		user: req.query.user,
		reward_activity: 'Product Purchase Update',
		product_id: prodTrans.gadget,
		transaction_id: req.query.trx_id,
		product_name: prod_name,
		old_status: old_status,
		new_status: newStatus,
		note: 'Changing product "'+prod_name+'" status from "'+old_status+'" to "'+newStatus+'" with note "'+ note+'"' ,
		date: new Date(),
	}
	try{
		console.log(recordTrans);
		let transaction = await db.collection('order_progress').insert(recordTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error confirming product receipt. DB storing issue'});
		return;
	}
	
	//send notification to user
	utils.sendNotification(db, user, 'actifit', 'real_product_update', 'market', 'Your order for product "' + prod_name + '" has been moved to status "'+newStatus+'" with note "'+note+'"', 'https://actifit.io/market');
	
	res.send({status: 'success'});
			
	//also notify actifit management
	for (let iter=0;iter<config.management.length;iter++){
		utils.sendNotification(db, config.management[iter], 'actifit', 'real_product_update', 'management', 'User '+user+' order for product "' + prod_name +'" changed to status "'+newStatus+'"', 'https://actifit.io/mods-access/');
		
	}
	
	
});

async function performBuyHiveTrx(req){
	
	let user = req.params.user;
	let product_id = req.params.gadget;
	
	//fetch product info
	let product = await grabProductInfo (product_id);
	if (!product){
		return ({'error': 'Product not found'});
		
	}
	
	//check if query has already been verified
	let matchingEntries = await db.collection('gadget_transactions_hive').find(
		{
			//blockNo: req.params.blockNo,
			trxID: req.params.trxID,
			bchain: req.params.bchain
		}).toArray();
	
	if (Array.isArray(matchingEntries) && matchingEntries.length > 0){
		return ({'error': 'Transaction already verified'});
		
	}
	
	let price_options = product.price;
	let price_options_count = price_options.length;
	let item_price = 0;
	let item_price_afit = 0;
	let item_currency = req.params.bchain;
	let actifit_percent_cut = 10;
	let item_price_alt = 0;
	for (let i=0; i < price_options_count; i++){
		let entry = price_options[i];
		//calculate HIVE price
		item_price_afit = entry.price;
		item_price = entry.price * exchangeAfitPrice.afitHiveLastPrice;
		//alternate price to match if at a time where AFIT price changes
		item_price_alt = entry.price * priorExchangeAfitHivePrice;
		item_currency = entry.currency;
		actifit_percent_cut = entry.actifit_percent_cut;
	}
	
	//round down number
	console.log('Before rounding');
	console.log(item_price);
	item_price = (Math.floor(item_price * 1000) - 1) / 1000;
	console.log('After rounding');
	console.log(item_price);
	
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetPayTransaction(req.params.user, req.params.gadget, item_price, item_price_alt, 'buy-gadget', req.params.trxID, req.params.bchain, db);
	if (!ver_trx || !ver_trx.success){
		return ({status: 'error'});
		
	}
	
	
	product.provider = 'actifit';
	
	//perform transaction
	let productBuyTrans = {
		user: user,
		reward_activity: 'Buy Product',
		buyer: user,
		seller: product.provider,
		product_id: product_id,
		product_type: product.type,
		product_name: product.name,
		product_level: product.level,
		product_price_afit: item_price_afit,
		product_price_hive: item_price,
		hive_paid: ver_trx.amount_hive,
		currency: req.params.bchain,
		//blockNo: req.params.blockNo,
		trxID: req.params.trxID,
		bchain: req.params.bchain,
		note: 'Bought Product '+product.name+ ' Level '+product.level,
		date: new Date(),
	}
	try{
		console.log(productBuyTrans);
		let transaction = await db.collection('gadget_transactions_hive').insert(productBuyTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		return ({'error': 'Error performing buy action. DB storing issue'});
		
	}
	
	//add a ticket to the user to enter draw if user meets min requirements
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	if (cur_user_token_count >= config.minUserTokensGadgetTicket){
		//perform transaction
		let ticketEntry = {
			user: user,
			product_id: product_id,
			product_name: product.name,
			product_level: product.level,
			product_price_afit: item_price_afit,
			product_price_hive: item_price,
			hive_paid: ver_trx.amount_hive,
			currency: req.params.bchain,
			count: 1,
			date: new Date(),
		}
		let transaction = await db.collection('gadget_buy_tickets').insert(ticketEntry);
	}
	
	//store into user_gadgets table as well
	let userGadgetTrans = {
		user: user,
		gadget: new ObjectId(product_id),
		product_type: product.type,
		gadget_name: product.name,
		gadget_level: product.level,
		status: "bought",
		span: parseInt(product.benefits.time_span),
		span_unit: product.benefits.time_unit,
		consumed: 0,
		posts_consumed: [],
		date_bought: new Date(),
		last_updated: new Date(),
		note: 'Bought Product '+product.name+ ' Level '+product.level,
	}
	try{
		console.log(userGadgetTrans);
		let transaction = await db.collection('user_gadgets').insert(userGadgetTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		return ({'error': 'Error performing buy action. DB storing issue'});
		
	}
	
	//decrease product available count
	product.count = parseInt(product.count) - 1;
	//extreme case
	if (product.count < 0) {
		product.count = 0;
	}
	try{
		let trans = await db.collection('products').save(product);
		console.log('success updating product count');
	}catch(err){
		console.log(err);
	}
	
	return ({'status': 'Success'});
}

/* end point for tracking gadget buy orders with HIVE via keychain*/

app.get('/buyGadgetHiveKeychain/:user/:gadget/:trxID/:bchain', async function (req, res) {
	
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}
	
	let outc = await performBuyHiveTrx(req);
	res.send(outc)
});


/* end point for tracking gadget buy orders with HIVE*/
app.get('/buyGadgetHive/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {
	
	let outc = await performBuyHiveTrx(req);
	res.send(outc)
});

app.post('/registerUserNotification', async function(req,res){
	console.log('>>>registerUserNotification');
	if (!req.body || !req.body.token || !req.body.user || !req.body.app){
		res.send({error: 'error'});
		return;
	}
	//store user/token combination
	let userTokenEntry = {
		token: req.body.token,
		user: req.body.user,
		app: req.body.app,
		date: new Date()
	};
	try{
		db.collection('user_app_notif_token').update({user: req.body.user}, userTokenEntry, { upsert: true });
		res.send({status: 'success'});
	}catch(err){
		res.send({error: 'error'});
		console.log(err);
	}
});


app.get('/mintProducts', async function(req,res){
	if (req.query.secret != config.prodMintSecret){
		res.send({error: 'error'});
	}else{
		let minAmount = 0;
		let mintedAmount = 50;
		if (req.query.minAmount){
			minAmount = parseInt(req.query.minAmount);
		}
		console.log('minAmount:'+minAmount);
		if (req.query.mintedAmount){
			mintedAmount = parseInt(req.query.mintedAmount);
		}
		console.log('mintedAmount:'+mintedAmount);
		//find products with min amount
		let trans = await db.collection('products').update(
			{
				type: 'ingame',
				count: {
					$lte: minAmount
				}
			},
			{
				$inc: { count: mintedAmount }
			},
			{
				multi: true
			}
		);
		console.log(trans);
		res.send({status: trans});
	}
});

/* end point for checking all products bought */
/* end point for user transactions display (per user or general actifit token transactions, limited by 1000) */
app.get('/realProductsBought/', checkHdrs, async function (req, res) {
	//if this is user querying different user, bail out
	if (req.query && req.query.user && req.query.buyer){
		if (req.query.user != req.query.buyer){
			res.send({'error': 'Account does not have proper privileges'});
			return;
		}
	}
	
	let hasAccess = await isModerator(req.query.user);
	if (!hasAccess){
		res.send({'error': 'Account does not have proper privileges'});
		return;
	}
	let query = {};
	var transactions;
	if(req.query.buyer){
		query = {user: req.query.buyer}
		transactions = await db.collection('products_bought').find(query).sort({date: -1}).limit(1000).toArray();
	}else{
		//only limit returned transactions in case this is a general query
		transactions = await db.collection('products_bought').find(query).sort({date: -1}).limit(1000).toArray();
	}
	let output = '';
	if (req.query.pretty){
		output = '#|User | Gadget| Gadget Name| quantity| color | Status | afit_paid | hive_paid | buyer_name | buyer_phone | buyer_address | buyer_address2 | buyer_country | buyer_state | buyer_city | buyer_zip | date_bought | last_updated | note|<br/>';
		output += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|<br/>';
		for(var i = 0; i < transactions.length; i++) {
			let trx = transactions[i];
			output += (i+1) + '|';
			output += '@'+trx.user + '|';
			output += trx.gadget + '|';
			output += trx.gadget_name + '|';
			output += trx.quantity + '|';
			output += trx.color + '|';
			output += trx.status + '|';
			output += trx.afit_paid + ' AFIT|';
			output += trx.hive_paid + ' HIVE|';
			output += trx.buyer_name + '|';
			output += trx.buyer_phone + '|';
			output += trx.buyer_address + '|';
			output += trx.buyer_address2 + '|';
			output += trx.buyer_country + '|';
			output += trx.buyer_state + '|';
			output += trx.buyer_city + '|';
			output += trx.buyer_zip + '|';
			output += trx.date_bought + '|';
			output += trx.last_updated + '|';
			output += trx.note + '|';
			output += '<br/>';
		}
	}else{
		output = transactions;
	}
    res.send(output);
});

/* end point for purchasing real products */
app.post('/purchaseRealProduct/', checkHdrs, async function (req, res) {
	console.log(req.body);
	if (!req.query.user){
		res.send({'error': 'User not found'});
		return;
	}
	let user = req.query.user;
	let product_id = req.body.product_id;
	let product = await grabProductInfo (product_id);
	if (!product){
		res.send({'error': 'Product not found'});
		return;
	}
	
	let user_info = await grabUserTokensFunc (user);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	//posting
	const receivedPlaintext = decrypt(req.ppkey);
	
	//set HIVE as default
	let bchain = 'HIVE';
	
	req.query.userKey = receivedPlaintext;
	
	console.log(product);
	
	//make sure proper data sent
	if (!req.body.buyer_name || !req.body.buyer_phone || !req.body.buyer_address ||
		!req.body.buyer_country || !req.body.buyer_state || !req.body.buyer_city || !req.body.buyer_zip){
			res.send({'error': 'Missing data'});
			return;
		}
	let sent_afit_cost = req.body.afit_amount;
	let sent_hive_cost = req.body.hive_amount;
	let order_quantity = req.body.order_quantity;
	let item_color = req.body.color_choice;
	
	let price_options = product.price;
	let price_options_count = price_options.length;
	for (let i=0; i < price_options_count; i++){
		let entry = price_options[i];
		console.log(entry);
		if (entry.currency == 'USD'){
			//USD price
			let item_usd_price = entry.price * order_quantity;
			console.log('item price'+item_usd_price);
			//give 1% flexibility on price change
			item_usd_price = item_usd_price * 0.99;
			console.log('flexible item price'+item_usd_price);
			console.log('exchangeAfitPrice');
			console.log(exchangeAfitPrice);
			//verify proper amount to be paid
			let afit_cost = item_usd_price * entry.percent_afit / 100 / exchangeAfitPrice.afitHiveLastUsdPrice ;
			afit_cost = Number(afit_cost.toFixed(2));
			
			
	
			if (cur_user_token_count < afit_cost){
				res.send({'error': 'Not enough balance'});
				return;
			}
			
			//HIVE price per USD
			let calcHiveUsdPrice = exchangeAfitPrice.afitHiveLastUsdPrice / exchangeAfitPrice.afitHiveLastPrice;
			console.log('HIVE price:'+calcHiveUsdPrice);
			
			let hive_cost = item_usd_price * entry.percent_hive / 100 / calcHiveUsdPrice ;
			hive_cost = Number(hive_cost.toFixed(2));
			console.log('HIVE extra cost:'+hive_cost);
			
			console.log('AFIT cost found:'+afit_cost+' v/s sent:'+sent_afit_cost + ' AFIT');
			console.log('HIVE cost found:'+hive_cost+' v/s sent:'+sent_hive_cost + ' HIVE');
			
			if (sent_afit_cost < afit_cost || sent_hive_cost < hive_cost){
				res.send({error: 'pricing may have changed, please refresh page and try again'});
				return;
			}
			
			let outcome = await utils.purchaseRealProd(req);
			if (outcome.error){
				res.send({error: outcome.error});
				return;
			}else if(!outcome.tx || !outcome.tx.ref_block_num || !outcome.tx.id || !outcome.tx.trx_num){
				res.send({error: (outcome.tx?outcome.tx.error:'transaction error')});
				return;
			}
			//if this went successfully, also deduct AFIT amount
			
			product.provider = 'actifit';
			
			//perform transaction
			let productBuyTrans = {
				user: user,
				reward_activity: 'Buy Real Product',
				buyer: user,
				seller: product.provider,
				product_id: product_id,
				product_name: product.name,
				product_price: sent_afit_cost,
				token_count: -sent_afit_cost,
				order_quantity: order_quantity,
				item_color: item_color,
				note: 'Bought Real Product '+product.name,
				date: new Date(),
			}
			try{
				console.log(productBuyTrans);
				let transaction = await db.collection('token_transactions').insert(productBuyTrans);
				console.log('success inserting post data');
			}catch(err){
				console.log(err);
				res.send({'error': 'Error performing buy action. DB storing issue'});
				return;
			}
			
			//store into user_gadgets table as well
			let userGadgetTrans = {
				user: user,
				gadget: new ObjectId(product_id),
				gadget_name: product.name,
				quantity: order_quantity,
				color: item_color,
				status: "placed",
				afit_paid: sent_afit_cost,
				hive_paid: sent_hive_cost,
				buyer_name: req.body.buyer_name,
				buyer_phone: req.body.buyer_phone,
				buyer_address: req.body.buyer_address,
				buyer_address2: req.body.buyer_address2,
				buyer_country: req.body.buyer_country,
				buyer_state: req.body.buyer_state, 
				buyer_city: req.body.buyer_city,
				buyer_zip: req.body.buyer_zip,
				date_bought: new Date(),
				last_updated: new Date(),
				note: 'Bought Product '+product.name+ ' x '+order_quantity,
			}
			try{
				console.log(userGadgetTrans);
				let transaction = await db.collection('products_bought').insert(userGadgetTrans);
				console.log('success inserting post data');
			}catch(err){
				console.log(err);
				res.send({'error': 'Error performing buy action. DB storing issue'});
				return;
			}
			
			//decrease product available count
			product.count = parseInt(product.count) - parseInt(order_quantity);
			//extreme case
			if (product.count < 0) {
				product.count = 0;
			}
			try{
				let trans = await db.collection('products').save(product);
				console.log('success updating product count');
			}catch(err){
				console.log(err);
			}
							
			//update current user's token balance & store to db
			let new_token_count = cur_user_token_count - parseFloat(sent_afit_cost);
			user_info.tokens = new_token_count;
			console.log('new_token_count:'+new_token_count);
			try{
				let trans = await db.collection('user_tokens').save(user_info);
				console.log('success updating user token count');
			}catch(err){
				console.log(err);
			}
			
			//send notification to user
			utils.sendNotification(db, user, 'actifit', 'real_product_buy', 'market', 'You successfully bought product "' + product.name + '"', 'https://actifit.io/market');
			
		
			
			res.send({status: 'success', trx: outcome.tx, tokens: new_token_count});
			
			//also notify actifit management
			for (let iter=0;iter<config.management.length;iter++){
				utils.sendNotification(db, config.management[iter], 'actifit', 'real_product_buy', 'management', 'User '+user+' successfully bought product "' + product.name+'"', 'https://actifit.io/mods-access/');
			}
		}else{
			res.send({error: 'not supported'});
			return;
		}
	}
});


async function performMultiBuyHiveTrx(req){
	let user = req.params.user;
	let product_ids = req.params.gadgets.split('-');
	
	let products_tot_price_afit = 0;
	let products_tot_hive_price = 0;
	let products_tot_hive_price_alt = 0;
	for (let i=0;i<product_ids.length;i++){
		//fetch product info
		let product = await grabProductInfo (product_ids[i]);
		if (!product){
			return ({'error': 'Product not found'});
			;
		}
		let price_options = product.price;
		let price_options_count = price_options.length;
		let item_price = 0;
		let item_price_afit = 0;
		let item_currency = req.params.bchain;
		let item_price_alt = 0;
		for (let i=0; i < price_options_count; i++){
			let entry = price_options[i];
			//calculate HIVE price
			item_price_afit = entry.price;
			item_price = entry.price * exchangeAfitPrice.afitHiveLastPrice;
			//alternate price to match if at a time where AFIT price changes
			item_price_alt = entry.price * priorExchangeAfitHivePrice;
			item_currency = entry.currency;
			//total price
			products_tot_price_afit += product.price;
			products_tot_hive_price += item_price;
			products_tot_hive_price_alt += item_price_alt;
			
		}
		
		
	}
	
	//check if query has already been verified
	let matchingEntries = await db.collection('gadget_transactions_hive').find(
		{
			blockNo: req.params.blockNo,
			trxID: req.params.trxID,
			bchain: req.params.bchain
		}).toArray();
	
	if (Array.isArray(matchingEntries) && matchingEntries.length > 0){
		return ({'error': 'Transaction already verified'});
		;
	}
	
	
	//round down number
	console.log('Before rounding');
	console.log(products_tot_hive_price);
	products_tot_hive_price = (Math.floor(products_tot_hive_price * 1000) - 1) / 1000;
	console.log('After rounding');
	console.log(products_tot_hive_price);
	
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetPayTransaction(req.params.user, req.params.gadgets, products_tot_hive_price, products_tot_hive_price_alt, 'buy-gadget', req.params.trxID, req.params.bchain, db);
	if (!ver_trx || !ver_trx.success){
		console.log(ver_trx);
		return ({status: 'error'});
		;
	}
	
	
	let provider = 'actifit';
	
	//perform transaction
	let productBuyTrans = {
		user: user,
		reward_activity: 'Buy Product',
		buyer: user,
		seller: provider,
		product_ids: product_ids,
		product_price_afit: products_tot_price_afit,
		product_price_hive_tot: products_tot_hive_price,
		hive_paid: ver_trx.amount_hive,
		currency: req.params.bchain,
		blockNo: req.params.blockNo,
		trxID: req.params.trxID,
		bchain: req.params.bchain,
		note: 'Bought Products '+req.params.gadgets,
		date: new Date(),
	}
	try{
		console.log(productBuyTrans);
		let transaction = await db.collection('gadget_transactions_hive').insert(productBuyTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		return ({'error': 'Error performing buy action. DB storing issue'});
		;
	}
	
	//add a ticket to the user to enter draw if user meets min requirements
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	if (cur_user_token_count >= config.minUserTokensGadgetTicket){
		for (let i=0;i<product_ids.length;i++){
			//fetch product info
			let product = await grabProductInfo (product_ids[i]);
			
			let price_options = product.price;
			let price_options_count = price_options.length;
			let item_price = 0;
			let item_price_afit = 0;
			let item_currency = req.params.bchain;
			let item_price_alt = 0;
			for (let i=0; i < price_options_count; i++){
				let entry = price_options[i];
				//calculate HIVE price
				item_price_afit = entry.price;
				item_price = entry.price * exchangeAfitPrice.afitHiveLastPrice;
				//alternate price to match if at a time where AFIT price changes
				item_price_alt = entry.price * priorExchangeAfitHivePrice;
				item_currency = entry.currency;
			}
			
			//perform transaction
			let ticketEntry = {
				user: user,
				product_id: product_ids[i],
				product_name: product.name,
				product_level: product.level,
				product_price_afit: item_price_afit,
				product_price_hive: item_price,
				hive_paid: ver_trx.amount_hive,
				multi_transaction: true,
				currency: req.params.bchain,
				count: 1,
				date: new Date(),
			}
			let transaction = await db.collection('gadget_buy_tickets').insert(ticketEntry);
			
			//insert notification to user about new ticket
			utils.sendNotification(db, user, 'actifit', 'ticket_collected', 'ticket', 'You collected a ticket for purchasing gadget "' + product.name + ' - L'+ product.level + '" to enter Actifit Gadget Prize Draw!', 'https://actifit.io/'+user);
		}
	}
	
	for (let i=0;i<product_ids.length;i++){
		//fetch product info
		let product = await grabProductInfo (product_ids[i]);
		//store into user_gadgets table as well
		let userGadgetTrans = {
			user: user,
			gadget: new ObjectId(product_ids[i]),
			product_type: product.type,
			gadget_name: product.name,
			gadget_level: product.level,
			status: "bought",
			span: parseInt(product.benefits.time_span),
			span_unit: product.benefits.time_unit,
			consumed: 0,
			posts_consumed: [],
			date_bought: new Date(),
			last_updated: new Date(),
			note: 'Bought Product '+product.name+ ' Level '+product.level,
		}
		try{
			console.log(userGadgetTrans);
			let transaction = await db.collection('user_gadgets').insert(userGadgetTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			return ({'error': 'Error performing buy action. DB storing issue'});
			;
		}
		
		//decrease product available count
		product.count = parseInt(product.count) - 1;
		//extreme case
		if (product.count < 0) {
			product.count = 0;
		}
		try{
			let trans = await db.collection('products').save(product);
			console.log('success updating product count');
		}catch(err){
			console.log(err);
		}
		
	}
	
	return ({'status': 'Success'});
}

/* end point for tracking multi-gadget buy orders via keychain*/
app.get('/buyMultiGadgetHiveKeychain/:user/:gadgets/:trxID/:bchain', async function (req, res) {
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}	
	let outc = await performMultiBuyHiveTrx(req);
	res.send(outc);	
});
/* end point for tracking multi-gadget buy orders */
app.get('/buyMultiGadgetHive/:user/:gadgets/:blockNo/:trxID/:bchain', async function (req, res) {
	let outc = await performMultiBuyHiveTrx(req);
	res.send(outc);
	
});

//end point for returning latest cycle
app.get("/recentGadgetBuyPrizeCycle", async function(req, res){
	let drawData = await utils.grabLastDrawData(db);
	res.send(drawData);
});

//end point for fetching all current active entry tickets
app.get('/activeGadgetBuyTickets/', async function (req, res) {
	let entries = await utils.getGadgetBuyTickets(db);
	res.send(entries);
	
});


//end point for fetching a user's active buy gadget tickets during draw period
app.get('/userActiveGadgetBuyTicketsByUser/', async function (req, res) {
	//fetch last draw date, and start counting tickets since
	let drawData = await utils.grabLastDrawData(db);
	
	let startDate = moment(drawData.drawDate).format('YYYY-MM-DD');
	
	
	console.log("startDate:"+startDate);//+" endDate:"+endDate);
	
	let result = await db.collection('gadget_buy_tickets').aggregate([
		{$match: 
			{
				date: {
					$gte: new Date(startDate),
					//$lte: new Date(startDate)
				},
			},
		},
		{$group:
			{
			   _id: '$user',
			   tickets_collected: { $sum: "$count" },
			   /*entries: { $sum: 1 }*/
			}
		}
	   ]).toArray();
	let ticketCount = 0;
	for (let i=0;i<result.length;i++){
		ticketCount += result[i].tickets_collected;
	}
	res.send({"userCount": result.length, "ticketCount": ticketCount, "result": result});
	
});

//end point for fetching a user's active buy gadget tickets during draw period
app.get('/userActiveGadgetBuyTickets/:user', async function (req, res) {
	//fetch last draw date, and start counting tickets since
	let drawData = await utils.grabLastDrawData(db);
	
	let startDate = moment(drawData.drawDate).format('YYYY-MM-DD');
	
	//let endDate = moment(moment(startDate).utc().subtract(config.contestBuyLen, 'days').toDate()).format('YYYY-MM-DD');
	
	console.log("startDate:"+startDate);//+" endDate:"+endDate);
	
	let result = await db.collection('gadget_buy_tickets').aggregate([
		{$match: 
			{
				user: req.params.user,
				date: {
					$gte: new Date(startDate),
					//$lte: new Date(startDate)
				},
			},
		},
		{$group:
			{
			   _id: null,
			   tickets_collected: { $sum: "$count" },
			   entries: { $sum: 1 }
			}
		}
	   ]).toArray();

	res.send(result);
	
});

async function performMultiBuyTrx(req){
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(req.params.user, req.params.gadgets, 'buy-gadget', req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		return ({status: 'error'});
	}
	
	//confirmed, register transaction and deduct AFIT tokens
	
	let user = req.params.user;
	let product_id_list = req.params.gadgets.split('-');
	let user_info;
	for (let i=0;i<product_id_list.length;i++){
		//fetch each product info
		let product_id = product_id_list[i];
		let product = await grabProductInfo (product_id);
		if (!product){
			return ({'error': 'Product not found'});
		}
		
		//confirm proper AFIT token balance. Test against product price
		user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		let cur_user_token_count = parseFloat(user_info.tokens);
		
		let price_options = product.price;
		let price_options_count = price_options.length;
		let item_price = 0;
		let item_currency = 'AFIT';
		let actifit_percent_cut = 10;
		for (let i=0; i < price_options_count; i++){
			let entry = price_options[i];
			item_price = entry.price;
			item_currency = entry.currency;
			actifit_percent_cut = entry.actifit_percent_cut;
		}
		
		if (cur_user_token_count < item_price){
			return ({'error': 'Account does not have enough AFIT funds'});
			
		}
		
		product.provider = 'actifit';
		
		//perform transaction
		let productBuyTrans = {
			user: user,
			reward_activity: 'Buy Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_name: product.name,
			product_level: product.level,
			product_price: item_price,
			token_count: -item_price,
			note: 'Bought Product '+product.name+ ' Level '+product.level,
			date: new Date(),
		}
		try{
			console.log(productBuyTrans);
			let transaction = await db.collection('token_transactions').insert(productBuyTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			return ({'error': 'Error performing buy action. DB storing issue'});
			
		}
		
		//store into user_gadgets table as well
		let userGadgetTrans = {
			user: user,
			gadget: new ObjectId(product_id),
			product_type: product.type,
			gadget_name: product.name,
			gadget_level: product.level,
			status: "bought",
			span: parseInt(product.benefits.time_span),
			span_unit: product.benefits.time_unit,
			consumed: 0,
			posts_consumed: [],
			date_bought: new Date(),
			last_updated: new Date(),
			note: 'Bought Product '+product.name+ ' Level '+product.level,
		}
		try{
			console.log(userGadgetTrans);
			let transaction = await db.collection('user_gadgets').insert(userGadgetTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			return ({'error': 'Error performing buy action. DB storing issue'});
			
		}
		
		//decrease product available count
		product.count = parseInt(product.count) - 1;
		//extreme case
		if (product.count < 0) {
			product.count = 0;
		}
		try{
			let trans = await db.collection('products').save(product);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
		
		//store this in escrow
		/*let productSellTrans = {
			user: config.null_account,//targetAccount,//product.provider,//config.escrow_account,
			reward_activity: 'Sell Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_price: item_price,
			token_count: item_price,
			actifit_percent_cut: actifit_percent_cut,
			note: 'Sold Product '+product.name+ ' to '+user,
			date: new Date(),
		}
		
		try{
			console.log(productSellTrans);
			let transaction = await db.collection('token_transactions').insert(productSellTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing sell action. DB storing issue'});
			return;
		}*/
			
		//update current user's token balance & store to db
		let new_token_count = cur_user_token_count - parseFloat(item_price);
		user_info.tokens = new_token_count;
		console.log('new_token_count:'+new_token_count);
		try{
			let trans = await db.collection('user_tokens').save(user_info);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
	
	}
	
	return ({'status': 'Success', 'user_tokens': user_info.tokens});
}

/* end point for tracking multi gadget buy orders */
app.get('/buyMultiGadgetKeychain/:user/:gadgets/:trxID/:bchain', async function (req, res) {
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}
	//now that we have confirmed the transaction, let us go through the standard cycle
	let outc = await performMultiBuyTrx(req);
	res.send(outc)
});

/* end point for tracking multi gadget buy orders */
app.get('/buyMultiGadget/:user/:gadgets/:blockNo/:trxID/:bchain', async function (req, res) {
	let outc = await performMultiBuyTrx(req);
	res.send(outc)
});


async function performBuyTrx(infoParam){
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(infoParam.user, infoParam.gadget, 'buy-gadget', infoParam.trxID, infoParam.bchain, db);
	if (!ver_trx){
		return ({'error': 'error verifying trx'});
		//return;
	}
	
	//confirmed, register transaction and deduct AFIT tokens
	
	let user = infoParam.user;
	let product_id = infoParam.gadget;
	
	//fetch product info
	let product = await grabProductInfo (product_id);
	if (!product){
		return({'error': 'Product not found'});
		//return;
	}
	
	//confirm proper AFIT token balance. Test against product price
	let user_info = await grabUserTokensFunc (user);
	console.log(user_info);
	let cur_user_token_count = parseFloat(user_info.tokens);
	
	let price_options = product.price;
	let price_options_count = price_options.length;
	let item_price = 0;
	let item_currency = 'AFIT';
	let actifit_percent_cut = 10;
	for (let i=0; i < price_options_count; i++){
		let entry = price_options[i];
		item_price = entry.price;
		item_currency = entry.currency;
		actifit_percent_cut = entry.actifit_percent_cut;
	}
	
	if (cur_user_token_count < item_price){
		return ({'error': 'Account does not have enough AFIT funds'});
		//return;
	}
	
	product.provider = 'actifit';
	
	//perform transaction
	let productBuyTrans = {
		user: user,
		reward_activity: 'Buy Product',
		buyer: user,
		seller: product.provider,
		product_id: product_id,
		product_type: product.type,
		product_name: product.name,
		product_level: product.level,
		product_price: item_price,
		token_count: -item_price,
		note: 'Bought Product '+product.name+ ' Level '+product.level,
		date: new Date(),
	}
	try{
		console.log(productBuyTrans);
		let transaction = await db.collection('token_transactions').insert(productBuyTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		return ({'error': 'Error performing buy action. DB storing issue'});
		//return;
	}
	
	//store into user_gadgets table as well
	let userGadgetTrans = {
		user: user,
		gadget: new ObjectId(product_id),
		product_type: product.type,
		gadget_name: product.name,
		gadget_level: product.level,
		status: "bought",
		span: parseInt(product.benefits.time_span),
		span_unit: product.benefits.time_unit,
		consumed: 0,
		posts_consumed: [],
		date_bought: new Date(),
		last_updated: new Date(),
		note: 'Bought Product '+product.name+ ' Level '+product.level,
	}
	try{
		console.log(userGadgetTrans);
		let transaction = await db.collection('user_gadgets').insert(userGadgetTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		return ({'error': 'Error performing buy action. DB storing issue'});
		//return;
	}
	
	//decrease product available count
	product.count = parseInt(product.count) - 1;
	//extreme case
	if (product.count < 0) {
		product.count = 0;
	}
	try{
		let trans = await db.collection('products').save(product);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	//store this in escrow
	/*let productSellTrans = {
		user: config.null_account,//targetAccount,//product.provider,//config.escrow_account,
		reward_activity: 'Sell Product',
		buyer: user,
		seller: product.provider,
		product_id: product_id,
		product_type: product.type,
		product_price: item_price,
		token_count: item_price,
		actifit_percent_cut: actifit_percent_cut,
		note: 'Sold Product '+product.name+ ' to '+user,
		date: new Date(),
	}
	
	try{
		console.log(productSellTrans);
		let transaction = await db.collection('token_transactions').insert(productSellTrans);
		console.log('success inserting post data');
	}catch(err){
		console.log(err);
		res.send({'error': 'Error performing sell action. DB storing issue'});
		return;
	}*/
		
	//update current user's token balance & store to db
	let new_token_count = cur_user_token_count - parseFloat(item_price);
	user_info.tokens = new_token_count;
	console.log('new_token_count:'+new_token_count);
	try{
		let trans = await db.collection('user_tokens').save(user_info);
		console.log('success updating user token count');
	}catch(err){
		console.log(err);
	}
	
	return ({'status': 'Success', 'user_tokens': user_info.tokens});
	
}

/* end point for buying gadgets via keychain */
app.get('/buyGadgetKeychain/:user/:gadget/:trxID/:bchain', async function (req, res){
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}
	//now that we have confirmed the transaction, let us go through the standard cycle
	let outc = await performBuyTrx(req.params);
	res.send(outc)
})

/* end point for tracking gadget buy orders */
app.get('/buyGadget/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {
	let outc = await performBuyTrx(req.params);
	res.send(outc)
});

/* end point for fetching pending user's friend requests */
app.get('/userFriendRequests/:user', async function (req, res) {
	let user_requests = await db.collection('user_requests').find({initiator: req.params.user, status:'pending'}).toArray();
	let user_targets = await db.collection('user_requests').find({target: req.params.user, status:'pending'}).toArray();
	res.send({sent_pending: user_requests, received_pending: user_targets});
});

/* end point for adding user's friend */
app.get('/addFriend/:userA/:userB/:blockNo/:trxID/:bchain', async function (req, res) {
	//ensure proper transaction
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'add-friend-request', req.params.blockNo, req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	
	let user_friendship = {
		initiator: req.params.userA,
		request: 'friendship',
		target: req.params.userB,
		date: new Date(),
		status: 'pending',
	};
	try{
		let transaction = await db.collection('user_requests').insert(user_friendship);
		console.log('success inserting post data');
		
		//notify recipient
		utils.sendNotification(db, req.params.userB, req.params.userA, 'friendship_request', 'friendship', 'User ' + req.params.userA + ' has sent you a friendship request', 'https://actifit.io/'+req.params.userA);
	
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}	

});


/* end point for cancelling friend request */
app.get('/cancelFriendRequest/:userA/:userB/:blockNo/:trxID/:bchain', async function (req, res) {
	//ensure proper transaction
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'cancel-friend-request', req.params.blockNo, req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	let friendshipQuery = {
		initiator: req.params.userA,
		target: req.params.userB,
		request: 'friendship',
		status: 'pending',
	}
	let userFriendship = {
		initiator: req.params.userA,
		request: 'friendship',
		target: req.params.userB,
		date: new Date(),
		status: 'cancelled',
	};
	try{
		let transaction = await db.collection('user_requests').update(friendshipQuery, userFriendship, { upsert: true });
		console.log('success inserting post data');
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}

});



/* end point for cancelling friend request */
app.get('/acceptFriend/:userA/:userB/:blockNo/:trxID/:bchain', async function (req, res) {
	//ensure proper transaction
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'accept-friendship', req.params.blockNo, req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	//need to update both ways to check which way was the original request
	let friendshipQuery = {
		initiator: req.params.userB,
		target: req.params.userA,
		request: 'friendship',
	}
	let userFriendship = {
		initiator: req.params.userB,
		request: 'friendship',
		target: req.params.userA,
		date: new Date(),
		status: 'approved',
	};
	let insertSuccess = false;
	try{
		let transaction = await db.collection('user_requests').update(friendshipQuery, userFriendship);
		console.log('success updating post data');
		
		//notify recipient
		utils.sendNotification(db, req.params.userB, req.params.userA, 'friendship_acceptance', 'friendship', 'User ' + req.params.userA + ' has accepted your friendship request', 'https://actifit.io/'+req.params.userA);
		
		insertSuccess = true;
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}
	
	if (insertSuccess){
		
		//also insert to friendship table
		
		let friendshipEntry = {
			userA: req.params.userB,
			userB: req.params.userA,
			date: new Date(),
		};
		
		try{
			let result = await db.collection('friends').insert(friendshipEntry);
			res.send({status: 'success'});
		}catch(err){
			res.send({status: 'error', details: err});
		}
	}
});


/* end point for dropping friendship */
app.get('/dropFriendship/:userA/:userB/:blockNo/:trxID/:bchain', async function (req, res) {
	//ensure proper transaction
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'cancel-friendship', req.params.blockNo, req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	try{
		//remove friendship entry both ways
		let result = await db.collection('friends').remove({userA: req.params.userA, userB: req.params.userB});
		console.log(result);
		result = await db.collection('friends').remove({userA: req.params.userB, userB: req.params.userA});
		console.log(result);
		
		//also remove requests to prevent confusion
		result = await db.collection('user_requests').remove({initiator: req.params.userA, request: 'friendship', target: req.params.userB});
		result = await db.collection('user_requests').remove({initiator: req.params.userB, request: 'friendship', target: req.params.userA});
		
		res.send({'status': 'success'});
	}catch(err){
		console.log(err);
		res.send({status: 'error'});
	}
});

/* end point for fetching all users unread notifications */
app.get('/activeNotifications/:user', async function (req, res) {
	let activeNotifications = await db.collection('notifications').find({user: req.params.user, status: 'unread'}).toArray();
	res.send(activeNotifications.reverse());
});

/* end point for fetching all users read notifications */
app.get('/readNotifications/:user', async function (req, res) {
	let activeNotifications = await db.collection('notifications').find({user: req.params.user, status: 'read'}).toArray();
	res.send(activeNotifications.reverse());
});

/* end point for fetching all users notifications */
app.get('/allNotifications/:user', async function (req, res) {
	let activeNotifications = await db.collection('notifications').find({user: req.params.user}).toArray();
	res.send(activeNotifications.reverse());
});

/* end point for fetching all users badges */
app.get('/allUserBadges/', async function (req, res) {
	let badges = await db.collection('user_badges').find().toArray();
	let distinctUsers = [...new Set(badges.map(x => x.user))];
	res.send({badges: badges, userCount: distinctUsers.length});
});

/* end point for fetching if the user had a random doubled up win before */
app.get('/luckyWinner/:user', async function (req, res) {
	let user = await db.collection('token_transactions').find({user: req.params.user, reward_activity : "Post", lucky_winner: 1}).toArray();
	res.send(user);
});

/* end point for fetching if the user had contributed to charity before */
app.get('/charityDonor/:user', async function (req, res) {
	let user = await db.collection('token_transactions').find({reward_activity : "Charity Post", giver: req.params.user}).toArray();
	res.send(user);
});

/* end point for fetching all random doubled up winners */
app.get('/luckyWinnerList/', async function (req, res) {
	let user = await db.collection('token_transactions').find({reward_activity : "Post", lucky_winner: 1}).toArray();
	res.send(user);
});

/* claim this badge and store it for this user */
app.get('/claimBadge/', async function (req, res) {
	if (req.query.user && req.query.badge){
		const iso_badge = 'iso';
		const rew_activity_badge = 'rewarded_activity_lev_';
		const doubledup_badge = 'doubledup_badge';
		const charity_badge = 'charity_badge';
		let proceed = false;
		//double check user eligibility in case of ISO
		if (req.query.badge === iso_badge){
			let isoParticipant = await db.collection('iso_participants').find({user: req.query.user}).toArray();
			if (isoParticipant.length > 0){
				proceed = true;
			}
		}else if (req.query.badge.includes(rew_activity_badge)){
		//double check user eligibility in case of Rewarded Activity
			req.params.user = req.query.user;
			let activityCount = await userRewardedPostCountFunc(req, res);
			//console.log('activityCount:'+activityCount);
			let badgeLevel = req.query.badge.replace(rew_activity_badge,'');
			//console.log('badgeLevel:'+badgeLevel);
			let rewarded_posts_rules = [
									[9,0],
									[29,1],
									[59,2],
									[89,3],
									[119,4],
									[179,5],
									[359,6],
									[539,7],
									[719,8],
									[1079,9],
									[1080,10]
								];
			rewarded_posts_rules.some(function (item){
				//console.log(item);
				//if we are attempting to claim the proper activity count passing level at proper matching level, proceed
				if (parseInt(activityCount) > item[0] && parseInt(badgeLevel) == item[1] + 1){
					proceed = true;
				}
			});
		}else if (req.query.badge === doubledup_badge){
			let doubledupWinner = await db.collection('token_transactions').find({user: req.query.user, reward_activity : "Post", lucky_winner: 1}).toArray();
			if (doubledupWinner.length > 0){
				proceed = true;
			}
		}else if (req.query.badge === charity_badge){
			let charityDonor = await db.collection('token_transactions').find({reward_activity : "Charity Post", giver: req.query.user}).toArray();
			if (charityDonor.length > 0){
				proceed = true;
			}
		}
		if (proceed){
			let user_badge = {
				user: req.query.user,
				badge: req.query.badge,
				date_claimed: new Date(),
			};
			try{
				let transaction = await db.collection('user_badges').insert(user_badge);
				console.log('success inserting post data');
				res.send({status: 'success', user: req.query.user, badge: req.query.badge});
			}catch(err){
				console.log('error');
				res.send({status: 'error'});
			}	
		}else{
			res.send({status: 'error'});
		}
	}else{
		res.send({status: 'error'});
	}
});

/* end point for checking if user took part of ISO event */
app.get('/isoParticipant/:user', async function (req, res) {
	let user = await db.collection('iso_participants').find({user: req.params.user}).toArray();
	res.send(user);
});

/* end point for checking if user took part of ISO event */
app.get('/isoParticipantList/', async function (req, res) {
	let userList = await db.collection('iso_participants').find().toArray();
	res.send(userList);
});

/* end point for returning current active delegator data by actifit */
app.get('/topDelegators', async function (req, res) {
	let delegatorList; 
	let hiveDelegatorList; 
	if (isNaN(req.query.count)){
		delegatorList = await db.collection('active_delegations').find().sort({steem_power: -1}).toArray();
		hiveDelegatorList = await db.collection('hive_active_delegations').find().sort({steem_power: -1}).toArray();
	}else{
		delegatorList = await db.collection('active_delegations').find().sort({steem_power: -1}).limit(parseInt(req.query.count)).toArray();
		hiveDelegatorList = await db.collection('hive_active_delegations').find().sort({steem_power: -1}).limit(parseInt(req.query.count)).toArray();
	}
    res.send({steem: delegatorList, hive: hiveDelegatorList});
});

activeDelegationFunc = async function (userName){
	let user = await db.collection('hive_active_delegations').findOne({_id: userName}, {fields : { _id:0} });
	console.log(user);
	return user;
}

/* end point for returning a single user last recorded active delegation amount */
app.get('/delegation/:user', async function (req, res) {
	var user = await activeDelegationFunc(req.params.user);
    res.send(user);
});


isModerator = async function(userName){
	let entryFound = false
	let moderatorList = await db.collection('team').find({name: userName, title:'moderator', status:'active'}).toArray();
	if (Array.isArray(moderatorList) && moderatorList.length>0){
		entryFound = true;
	}
	return entryFound;
}
moderatorsListFunc = async function () {
	let moderatorList = await db.collection('team').find({title:'moderator', status:'active'}).sort({name: 1}).toArray();
	return moderatorList;
}

/* end point for returning current active moderators data by actifit */
app.get('/moderators', async function (req, res) {
	var moderatorList; 
	moderatorList = await moderatorsListFunc();
    res.send(moderatorList);
});

/* end point for returning current active ambassadors data by actifit */
app.get('/ambassadors', async function (req, res) {
	var ambassadorList; 
	ambassadorList = await db.collection('team').find({title:'ambassador', status:'active'}).sort({name: 1}).toArray();
    res.send(ambassadorList);
});

/* end point for returning current active professionals list */
app.get('/professionals', async function (req, res) {
	var professionalsList; 
	professionalsList = await db.collection('professionals').find({active:true}).sort({name: 1}).toArray();
    res.send(professionalsList);
});

/* end point for returning current active product list */
app.get('/products', async function (req, res) {
	var productsList; 
	productsList = await db.collection('products').find({active:true}).sort({name: -1}).toArray();
    res.send(productsList);
});

/* end point for returning current top AFIT token holders */
app.get('/topTokenHolders', async function (req, res) {
	var tokenHolders; 
	
	//fetch banned accounts
	let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}, {fields : { user: 1, _id: 0 } }).toArray();
	//console.log(banned_users);
	let banned_arr = banned_users.map(entr => entr.user);
	banned_arr.push('');
	
	if (isNaN(req.query.count)){
		tokenHolders = await db.collection('user_tokens').find({_id:{$nin: banned_arr}}).sort({tokens: -1}).toArray();
	}else{
		tokenHolders = await db.collection('user_tokens').find({_id:{$nin: banned_arr}}).sort({tokens: -1}).limit(parseInt(req.query.count)).toArray();
	}
	let output = tokenHolders;
	if (req.query.pretty){
		output = '#|Token Holder | AFIT Tokens Held |<br/>';
		output += '|---|---|---|<br/>';
		for(var i = 0; i < tokenHolders.length; i++) {
			let tokenHolder = tokenHolders[i];
			output += (i+1) + '|';
			output += '@'+tokenHolder.user + '|';
			output += gk_add_commas(tokenHolder.tokens.toFixed(3)) + '|';
			output += '<br/>';
		}
	}
    res.send(output);
});


/* end point for returning accounts banned by actifit*/
app.get('/banned_users', async function (req, res) {
	var banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
    res.send(banned_users);
});

/* end point for returning if a user is banned by actifit*/
app.get('/is_banned/:user', async function (req, res) {
	let is_banned = await db.collection('banned_accounts').findOne({user: req.params.user, ban_status:"active"});
    console.log (is_banned!=null)
	res.send(is_banned!=null);
});

/* end point for returning if a user is powering down AFIT*/
app.get('/isPoweringDown/:user', async function (req, res) {
	let poweringDown = await db.collection('powering_down_he').findOne({user: req.params.user});
    console.log (poweringDown)
	if (!poweringDown){
		res.send({});
	}else{
		res.send(poweringDown);
	}
});

/* end point for returning the list of users powering down AFIT*/
app.get('/poweringDownList/', async function (req, res) {
	let poweringDown = await db.collection('powering_down_he').find().toArray();
    console.log (poweringDown)
	res.send(poweringDown);
});

app.get('/cancelAFITMoveSE', async function(req, res){
	if (!req.query.user || !req.query.fundsPass){
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let fundsPass = req.query.fundsPass;
		
		//confirm matching funds password
		let query = {user: user};
		
		let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(fundsPass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
		
		//reached here, we're fine
		
		try{
			let result = await db.collection('powering_down_he').remove({user: req.query.user});
			res.send({'status': 'Success'});
		}catch(err){
			console.log(err);
		}
	}
});

/* function handles the processing of AFIT power down and moving tokens to S-E */
app.get('/initiateAFITMoveSE', async function(req, res){
	if (!req.query.user || !req.query.amount || !req.query.fundsPass) {
		//make sure all params are sent
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let amount = parseFloat(req.query.amount);
		let fundsPass = req.query.fundsPass;
		
		
		//check first if user is banned, as he wont be able to move funds
		let is_banned = await db.collection('banned_accounts').findOne({user: user, ban_status:"active"});
		if (is_banned){
			res.send({'error': 'You cannot move AFIT as your account is banned'});
			return;
		}
		
		//check if amount is numeric
		if (isNaN(amount)){
			res.send({'error': 'Amount sent is non numeric'});
			return;
		}
		
		if (amount > config.max_afit_to_se_day){
			res.send({'error': 'You cannot transfer more than ' + config.max_afit_to_se_day + ' AFIT / day'});
			return;
		}
		
		//confirm matching funds password
		let query = {user: user};
		
		let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(fundsPass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
		
		//reached here, we're fine
		
		//confirm proper AFIT token balance. Test against target amount to be sent
		let user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		let cur_sender_token_count = parseFloat(user_info.tokens);	
		
		if (cur_sender_token_count < amount){
			res.send({'error': 'Account does not have enough AFIT funds'});
			return;
		}
		let tot_afitx_bal = 0;
		let afitx_se_balance = 0;
		let afitx_he_balance = 0;
		//confirm amount within AFITX conditions
		let bal = 0;
		try{
			bal = await ssc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' });
		}catch(innEr){
			console.log(innEr);
		}
		let bal_he = await hsc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' }); /*.catch((err)=>{
				console.log(err)
				if (err.message.includes('timeout')){
					switchHENode();
				}
			});;*/
		
		if (bal){
			afitx_se_balance = parseFloat(bal.balance);
		}
		if (bal_he){
			afitx_he_balance = parseFloat(bal_he.balance);
		}
		tot_afitx_bal = afitx_se_balance + afitx_he_balance;
		/*if (bal || bal_he){
			
		}else{
			res.send({'error': 'Unable to fetch AFITX Funds. Try again later.'});
			return;
		}*/
		
		//conditions only apply if he is requesting more than 300 AFIT move
		if (amount > config.free_movable_afit_day ){
			//make sure user has at least 0.1 AFITX to move tokens 
			if (tot_afitx_bal < 0.1){
				res.send({'error': 'You do not have enough AFITX to move AFIT tokens over.'});
				return;
			}
			  //console.log(amount_to_powerdown);
			  //console.log(this.afitx_se_balance);
			  //calculate amount that can be transferred daily
			if ((amount - config.free_movable_afit_day) / config.afitx_afit_move_ratio > tot_afitx_bal){
				res.send({'error': 'You do not have enough AFITX to move '+amount+ ' AFIT'});
				return;
			}
		}
		
		//register transaction for upcoming powering down cycle
		
		//query to see if user is already powering down
		let tokenPowerDownQuery = {
			user: user,
		}
		//store the transaction to the user's profile
		let tokenPowerDownTrans = {
			user: user,
			daily_afit_transfer: amount,
			min_afitx: (amount - config.free_movable_afit_day) / config.afitx_afit_move_ratio,
			date: new Date(),
		}
		
		try{
			console.log(tokenPowerDownTrans);
			let transaction = await db.collection('powering_down_he').update(tokenPowerDownQuery, tokenPowerDownTrans, { upsert: true });
			console.log('success inserting power down data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing power down. DB storing issue'});
			return;
		}
		
		res.send({'status': 'Success', trx: tokenPowerDownTrans});
	}
})

/* function handles the processing of a buy order */
app.get('/tipAccount', async function(req, res){ 
	if (!req.query.user || !req.query.targetUser || !req.query.amount || !req.query.fundsPass) {
		//make sure all params are sent
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let targetUser = req.query.targetUser;
		let amount = parseFloat(req.query.amount);
		let fundsPass = req.query.fundsPass;
		
		
		//check first if user is banned, as he wont be able to tip
		let is_banned = await db.collection('banned_accounts').findOne({user: user, ban_status:"active"});
		if (is_banned){
			res.send({'error': 'You cannot tip AFIT as your account is banned'});
			return;
		}
		
		//check first if targetUuser is banned, as he wont be able to tip
		is_banned = await db.collection('banned_accounts').findOne({user: targetUser, ban_status:"active"});
		if (is_banned){
			res.send({'error': 'You cannot tip AFIT to a banned account'});
			return;
		}
		
		//confirm matching funds password
		let query = {user: user};
		
		let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(fundsPass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
		
		//reached here, we're fine
		
		//confirm proper AFIT token balance. Test against target amount to be sent
		let user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		let cur_sender_token_count = parseFloat(user_info.tokens);
		
		if (cur_sender_token_count < amount){
			res.send({'error': 'Account does not have enough AFIT funds'});
			return;
		}
		
		//check how much the user has tipped today
		let totalTipAmount = await tippedToday(req, res);
		if (parseFloat(totalTipAmount) >= parseFloat(config.max_allowed_tips_per_day)){
			res.send({'error': 'User cannot tip more today. Max tips per day is set at '+config.max_allowed_tips_per_day + ' AFIT'});
			return;
		}
		
		if (parseFloat(totalTipAmount) + amount > parseFloat(config.max_allowed_tips_per_day)){
			res.send({'error': 'Tip amount exceeds daily limit (' + config.max_allowed_tips_per_day + ') by '+ ((parseFloat(totalTipAmount) + amount) - parseFloat(config.max_allowed_tips_per_day) ) + ' AFIT. Try a smaller amount.'});
			return;
		}
	
		//perform transaction, decrease sender amount
		let tipTrans = {
			user: user,
			reward_activity: 'Send Tip',
			recipient: targetUser,
			token_count: -amount,
			tip_amount: amount,
			note: user + ' tipped ' + targetUser + ' ' + amount + ' AFIT',
			date: new Date(),
		}
		try{
			console.log(tipTrans);
			let transaction = await db.collection('token_transactions').insert(tipTrans);
			console.log('success inserting tip data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing tip action. DB storing issue'});
			return;
		}
		
		//perform transaction, increase recipient amount
		let tipReceiptTrans = {
			user: targetUser,
			reward_activity: 'Receive Tip',
			sender: user,
			token_count: amount,
			tip_amount: amount,
			note: user + ' tipped ' + targetUser + ' ' + amount + ' AFIT',
			date: new Date(),
		}
		
		try{
			console.log(tipReceiptTrans);
			let transaction = await db.collection('token_transactions').insert(tipReceiptTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing tip action. DB storing issue'});
			return;
		}
		
		//also send notification to the recipient about tipped amount
		utils.sendNotification(db, targetUser, user, 'tip_notification', 'payment', 'User ' + user + ' has sent you a tip of '+ amount +' AFIT', 'https://actifit.io/'+user);
		
		//update sending user's token balance & store to db
		let new_token_count = cur_sender_token_count - amount;
		user_info.tokens = new_token_count;
		console.log('new_token_count:'+new_token_count);
		try{
			let trans = await db.collection('user_tokens').save(user_info);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
		
		//confirm proper AFIT token balance. Test against target amount to be sent
		let target_user_info = await grabUserTokensFunc (targetUser);
		if (target_user_info == null){
			//first time actifit user, let's create a new entry
			target_user_info = new Object();
			target_user_info._id = targetUser;
			target_user_info.user = targetUser;
			target_user_info.tokens = 0;
		}
		console.log(target_user_info);
		let cur_target_user_token_count = parseFloat(target_user_info.tokens);
		
		//update receiving user's token balance & store to db
		let upd_token_count = cur_target_user_token_count + amount;
		target_user_info.tokens = upd_token_count;
		console.log('upd_token_count:'+upd_token_count);
		try{
			let trans = await db.collection('user_tokens').save(target_user_info);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
		
		res.send({'status': 'Success', 'tipAmount': amount,'senderTokenCount': new_token_count, 'recipientTokenCount': upd_token_count});
	}
})


tippedToday = async function (req, res){
	let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	//console.log("startDate:"+startDate+" endDate:"+endDate);
	
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	
	let endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
	
	query_json = {
			"reward_activity": "Send Tip",
			"date": {
					"$lte": new Date(endDate),
					"$gt": new Date(startDate)
				}
	};
	//adjust query to include user
	//console.log(req.params.user)
	if (req.params.user){
		query_json.user = req.params.user;
	}else if (req.query.user){
		query_json.user = req.query.user;
	}
	
	let result = await db.collection('token_transactions').find(query_json).toArray();
	let totalTipAmount = 0;
	try{
		for (let i = 0; i< result.length; i++){
			//console.log(result[i]);
			totalTipAmount += parseFloat(result[i].tip_amount);
		}
		console.log('totalTipAmount:'+totalTipAmount);
	}catch(err){
		console.log(err.message);
	}
	return totalTipAmount;
}

/* end point for counting amount of tips on a single day */
app.get('/totalTipped', async function (req, res) {
	let totalTipAmount = await tippedToday(req, res);
	res.send(JSON.stringify({total_tip:totalTipAmount}));
	
});

/* end point for counting amount of tips by user on a single day */
app.get('/tippedToday/:user', async function (req, res) {
	let totalTipAmount = await tippedToday(req, res);
	res.send(JSON.stringify({total_tip:totalTipAmount}));
	
});



/* end point for counting number of reblogs on a certain date param (default current date) */
app.get('/reblogCount', async function (req, res) {
		var todayDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		//fileName = "steemrewards"+fileName+".json";
		var dateRegex = new RegExp ('^'+todayDate); // /^2018-08-05/
		if (req.query.targetDate){
			dateRegex = new RegExp ('^'+req.query.targetDate);
		}
		let query = await db.collection('token_transactions').find({
				"reward_activity": "Post Reblog",
				"date":  dateRegex
		})
		try{
			console.log('counting');
			let reblog_count = await query.count();
			console.log(reblog_count);
			res.send(JSON.stringify({reblog_count:reblog_count}));
		}catch(err){
			console.log(err.message);
		}
});

/* end point for counting number of upvotes on a certain date param (default current date) */
app.get('/upvoteCount', async function (req, res) {

		var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		if (req.query.targetDate){
			startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
		}
		var endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
		console.log("startDate:"+startDate+" endDate:"+endDate);
		//adjust query to include dates
		query_json = {
				"reward_activity": "Post Vote",
				"date": {
						"$lte": new Date(endDate),
						"$gt": new Date(startDate)
					}
		};
		
		let query = await db.collection('token_transactions').find(query_json);

		try{
			console.log('counting');
			let upvote_count = await query.count();
			console.log(upvote_count);
			res.send(JSON.stringify({upvote_count:upvote_count}));
		}catch(err){
			console.log(err.message);
		}
});


/* end point for counting number of rewarded posts on a certain date param (default current date) */
app.get('/rewardedPostCount', async function (req, res) {
		
		var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		if (req.query.targetDate){
			startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
		}
		var endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
		console.log("startDate:"+startDate+" endDate:"+endDate);
		//adjust query to include dates
		query_json = {
				"reward_activity": "Post",
				"date": {
						"$lte": new Date(endDate),
						"$gt": new Date(startDate)
					}
		};
		
		let query = await db.collection('token_transactions').find(query_json);
		
		try{
			console.log('counting');
			let rewarded_post_count = await query.count();
			console.log(rewarded_post_count);
			res.send(JSON.stringify({rewarded_post_count:rewarded_post_count}));
		}catch(err){
			console.log(err.message);
		}
});

/* refactored function to grab rewarded post count per user for use across get calls */
userRewardedPostCountFunc = async function(req, res){
	var user = req.params.user;
	//default query
	var query_json = {
			"reward_activity": "Post",
			"user": user
	};
	//if this is a sum for specific period v/s a total sum
	if (typeof req.query.period != "undefined" && !isNaN(req.query.period)){
		let days = req.query.period;
		//console.log("days:"+days);
		let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		if (!isNaN(req.query.delay)){
			startDate = moment(moment().utc().startOf('date').subtract(req.query.delay, 'days').toDate()).format('YYYY-MM-DD');
		}
		let endDate = moment(moment(startDate).utc().startOf('date').subtract(days, 'days').toDate()).format('YYYY-MM-DD');
		//console.log("startDate:"+startDate+" endDate:"+endDate);
		//adjust query to include dates
		query_json = {
				"reward_activity": "Post",
				"user": user,
				"date": {
						"$gte": new Date(endDate),
						"$lt": new Date(startDate)
					}
		};
	}

	//build up query accordingly
	let query = await db.collection('token_transactions').find(query_json);
	try{
		//grab total number of matching records
		let rewarded_post_count = await query.count();
		//console.log("rewarded_post_count:"+rewarded_post_count);
		
		return rewarded_post_count;
	}catch(err){
		console.log(err.message);
		return "";
	}
}

/* end point for counting number of rewarded posts on a certain date param (default current date) */
app.get('/userRewardedPostCount/:user', async function (req, res) {

	//grab user account
	if (typeof req.params.user!= "undefined" && req.params.user!=null){
		
		var rewarded_post_count = await userRewardedPostCountFunc(req, res);
		res.send(JSON.stringify({rewarded_post_count:rewarded_post_count}));
	}else{
		res.send("");
	}
});

calcRank = async function (req, res){
	//delegation calculation matrix
	var delegation_rules = [
		[9,0],
		[499,0.05],
		[999,0.10],
		[4999,0.20],
		[9999,0.30],
		[19999,0.40],
		[49999,0.55],
		[99999,0.65],
		[499999,0.75],
		[999999,0.90],
		[1000000,1]
	]
	
	//AFIT token calculation matrix
	//[max_afit,factor, base_afit_rank,min_afit,multiplier]
	var afit_token_rules = [
		[9,0,0,0,0],
		[999,10,0,10,0.01],
		[4999,20,10,1000,0.00375],
		[9999,30,25,5000,0.004],
		[19999,40,45,10000,0.0035],
		[49999,50,70,20000,0.001],
		[99999,60,100,50000,0.0007],
		[499999,70,135,100000,0.0001],
		[999999,80,175,500000,0.00005],
		[4999999,90,200,1000000,0.00000625],
		[5000000,100,250,5000000,0]
	]
	
	//Rewarded Posts calculation matrix
	var rewarded_posts_rules = [
		[9,0],
		[29,0.10],
		[59,0.20],
		[89,0.30],
		[119,0.40],
		[179,0.50],
		[359,0.60],
		[539,0.70],
		[719,0.80],
		[1079,0.90],
		[1080,1]
	]
	
	//Rewarded Posts calculation matrix
	var recent_reward_posts_rules = [
		[0,0],
		[2,0.20],
		[4,0.40],
		[6,0.60],
		[8,0.80],
		[9,1]
	]
	
	var user_rank = 0;
	
	//grab delegation amount
	var userDelegations = await activeDelegationFunc(req.params.user);
	
	let delegSP = 0;
	//get current delegated SP if any
	if (userDelegations != null){
		console.log('already delegated');
		delegSP = userDelegations.steem_power;
	}
	//console.log(userDelegations.steem_power);
	
	var delegation_score = 0;
	
	let afitBSC = 0;
	let afitxBSC = 0;
	let afitBNBLPBSC = 0;
	let afitxBNBLPBSC = 0;
	
	//check if user has a BSC wallet
	let wallet_entry = await db.collection('user_wallet_address').findOne({user: req.params.user});
	try{
	if (wallet_entry && wallet_entry.wallet){
		console.log(wallet_entry.wallet);
		//fetch wallet balance		
		let result = await afitContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
		let format = web3.utils.fromWei(result); // 29803630.997051883414242659
		afitBSC = parseFloat(format);
		console.log(format);
		
		result = await afitxContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
		format = web3.utils.fromWei(result); // 29803630.997051883414242659
		afitxBSC = parseFloat(format);
		console.log(format);
		
		result = await afitBNBLPContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
		format = web3.utils.fromWei(result); // 29803630.997051883414242659
		afitBNBLPBSC = parseFloat(format);
		console.log(format);		
		
		result = await afitxBNBLPContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
		format = web3.utils.fromWei(result); // 29803630.997051883414242659
		afitxBNBLPBSC = parseFloat(format);
		console.log(format);
	}
	}catch(err){
		console.log(err);
	}
	
	//check if the user has an alt account as beneficiary
	let delegator_info = await getAltAccountStatusFunc(req.params.user);
	//check if returned object is not empty
	if (Object.keys(delegator_info).length > 0){
		if (parseInt(delegator_info.user_rank_benefit) == 1){
			//consider as no delegations
			delegSP = 0;
		}
	}else{
		//also check the other case where the account is an alt-account
		delegator_info = await getAltAccountByNameFunc(req.params.user);
		//check if returned object is not empty
		if (delegator_info.length > 0){
			for (let x=0, max_limit=delegator_info.length;x<max_limit;x++){
				if (parseInt(delegator_info[x].user_rank_benefit) == 1){
					//get original user delegation amount
					userDelegations = await activeDelegationFunc(delegator_info[x].delegator);		
					if (userDelegations != null){
						delegSP += userDelegations.steem_power;
					}
				}
			}
		}
	}
	
	
	if (parseFloat(delegSP) > 0){
		delegation_score = utils.calcScore(delegation_rules, config.delegation_factor, parseFloat(delegSP));
	}
	
	user_rank += delegation_score;
	
	//grab user token count
	var userTokens = await grabUserTokensFunc(req.params.user);
	//console.log(userTokens.tokens);
	
	var afit_tokens_score = 0;
	//initialize as the BSC amount value, multiplied by multiplier
	let full_afit_bal = config.afitBSCMultiplier * afitBSC;
	
	//append AFIT LP token balance * multipler
	full_afit_bal += config.afitLPBSCMultiplier * afitBNBLPBSC;
	
	if (userTokens != null){
		full_afit_bal += parseFloat(userTokens.tokens);
		
	}
	if (full_afit_bal > 0){
		afit_tokens_score = utils.calcScoreExtended(afit_token_rules, config.afit_token_factor, parseFloat(full_afit_bal), parseFloat(config.max_afit_rank_val));	
	}
	
	
	user_rank += afit_tokens_score;
	
	//grab total rewarded posts count
	var tot_rewarded_post_count = await userRewardedPostCountFunc(req, res);
	//console.log(tot_rewarded_post_count);
	
	var tot_posts_score = utils.calcScore(rewarded_posts_rules, config.rewarded_posts_factor, parseInt(tot_rewarded_post_count));
	
	user_rank += tot_posts_score;
	
	//set the check period for config value of days days, and rerun the call to get last rewarded posting activity during this period
	req.query.period = config.recent_posts_period;
	
	//add a 2 day delay to take into consideration late voting rounds
	req.query.delay = 2;
	
	var recent_rewarded_post_count = await userRewardedPostCountFunc(req, res);
	//console.log(recent_rewarded_post_count);
	
	var recent_posts_score = utils.calcScore(recent_reward_posts_rules, config.recent_posts_factor, parseInt(recent_rewarded_post_count));
	
	user_rank += recent_posts_score;
	
	let rank_no_afitx = user_rank;
	//also append AFITX based rank. for every 1 AFITX, increase 0.1 rank
	let userHasAFITX = usersAFITXBal.find(entry => entry.account === req.params.user);
	let user_rank_afitx = 0;
	
	//initialize as the BSC amount value, multiplied by multiplier
	let full_afitx_bal = config.afitxBSCMultiplier * afitxBSC;
	
	//append AFITX LP token balance * multipler
	full_afitx_bal += config.afitxLPBSCMultiplier * afitxBNBLPBSC;
	
	if (userHasAFITX){
		full_afitx_bal += parseFloat(userHasAFITX.balance);
	}
	
	if (full_afitx_bal > 0){
		user_rank_afitx = (parseFloat(full_afitx_bal) / 10).toFixed(2);
		//max increase by holding AFITX is 150(config.max_afitx_rank_increase)
		if (user_rank_afitx > config.max_afitx_rank_increase){
			user_rank_afitx = config.max_afitx_rank_increase;
		}
		user_rank += parseFloat(user_rank_afitx);
	}
	
	var score_components = JSON.stringify({
		user_rank: user_rank.toFixed(2),
		rank_no_afitx: rank_no_afitx,
		afitx_rank: parseFloat(user_rank_afitx),
		delegation_score: delegation_score,
		afit_tokens_score: afit_tokens_score,
		tot_posts_score: tot_posts_score,
		recent_posts_score:recent_posts_score,
		afit_BSC: afitBSC,
		afitx_BSC: afitxBSC,
		afit_BNB_LP_BSC: afitBNBLPBSC,
		afitx_BNB_LP_BSC: afitxBNBLPBSC,
		full_afit_bal: full_afit_bal,
		full_afitx_bal: full_afitx_bal
	});
	console.log(score_components)
	return score_components;
}

/* end point for getting current user's Actifit rank */
app.get('/getRank/:user', async function (req, res) {
	if (typeof req.params.user!= "undefined" && req.params.user!=null){
		let score_components = await calcRank(req, res);
		res.send(score_components);
	}else{
		res.send("");
	}
});

/* function handles the backbone for grabbing Alt Account Status */
getAltAccountStatusFunc = async function (user){
	let delegator_info = null;
	if (typeof user!= "undefined" && user!=null){
		//in this case, we check the status of a single user
		var query_json = {
			"delegator": user
		};
		
		delegator_info = await db.collection('delegation_alt_beneficiaries').findOne(query_json, {fields : { _id:0} });
		if (delegator_info==null){
			delegator_info = {};
		}
		console.log(delegator_info);
	}else{
		//alternatively grab all alt-account reward delegations
		delegator_info = await db.collection('delegation_alt_beneficiaries').find().toArray();
		console.log(delegator_info);
	}
	return delegator_info;
}

/* function handles checking if alt-account is linked to a delegator */
getAltAccountByNameFunc = async function (targetUser){
	let delegator_info = null;
	if (typeof targetUser!= "undefined" && targetUser!=null){
		//in this case, we check the status of a single user
		var query_json = {
			"alt_account": targetUser
		};
		
		delegator_info = await db.collection('delegation_alt_beneficiaries').find(query_json, {fields : { _id:0} }).toArray();
		console.log(delegator_info);
	}
	return delegator_info;
}

/* end point for getting list of SP delegator accounts who wish to move their user rank and/or rewards to their alt-accounts*/
app.get('/getAltAccountStatus/:user?', async function (req, res) {
	let delegator_info = await getAltAccountStatusFunc(req.params.user);
	res.send(delegator_info);
});

/* function handles processing requests for getting AFIT token pay depending on reward activity type */
getPostRewardFunc = async function(user, url, reward_activity){
	var query_json = {
			"reward_activity": reward_activity,
			"user": user,
			"url":url
	};
	
	let post_details = await db.collection('token_transactions').findOne(query_json, {fields : { _id:0} });
	console.log(post_details);
	//fixing token amount display for 3 digits
	if (typeof post_details!= "undefined" && post_details!=null){
		if (typeof post_details.token_count!= "undefined"){
			return parseFloat(post_details.token_count.toFixed(4));
		}
	}
	//otherwise return no tokens
	return 0;
}

/* end point for getting a post's reward */
app.get('/getPostReward', async function (req, res) {
	
	if (typeof req.query.user!= "undefined" && req.query.user!=null
		&& typeof req.query.url!= "undefined" && req.query.url!=null){
		var user = req.query.user;
		var url = req.query.url;
		console.log('url:'+url);
		//grab specific reward type for user and post
		var token_count = await getPostRewardFunc(user, url, "Post");
		res.send({token_count: token_count});
	}else{
		res.send({token_count: 0});
	}
});

/* end point for retrieving a post's full AFIT Pay reward */
app.get('/getPostFullAFITPayReward', async function (req, res) {
	
	if (typeof req.query.user!= "undefined" && req.query.user!=null
		&& typeof req.query.url!= "undefined" && req.query.url!=null){
		var user = req.query.user;
		var url = req.query.url;
		
		//for the full AFIT rewards, grab only permalink portion without the community and author name
		url = url.substring(url.lastIndexOf('/')+1);
		console.log('url:'+url);
		//grab specific reward type for user and post
		var token_count = await getPostRewardFunc(user, url, "Full AFIT Payout");
		res.send({token_count: token_count});
	}else{
		res.send({token_count: 0});
	}
});


/* end point for returning total number of rewarded tokens to charities based upon user activity, along with unique user count who donated */
app.get('/getCharityRewards', async function(req, res) {

	await db.collection('token_transactions').aggregate([
		{
			$match: {reward_activity:'Charity Post'}
		},
		{
		   $group:
			{
			   _id: null,
			   tokens_distributed: { $sum: "$token_count" },
			   user_count: { $sum: 1 }
			}
		}
	   ]).toArray(function(err, results) {
		var output = 'rewarded users:'+results[0].user_count+',';
		output += 'tokens distributed:'+results[0].tokens_distributed;
		res.send(results);
		console.log(results);
	   });

});



/* end point for returning full payout posts data */
app.get('/getFullAFITPayPosts', async function(req, res) {

	await db.collection('token_transactions').find(
		{"reward_activity": "Full AFIT Payout"}).sort({'date': -1}).limit(1000).toArray(function(err, results) {
		res.send(results);
		console.log(results);
	   });

});

/* end point for returning total number of AFIT tokens paid in return for full AFIT pay along with matching STEEM + SBD */
app.get('/getFullAFITPayStats', async function(req, res) {

	await db.collection('token_transactions').aggregate([
		{
			$match: {"reward_activity": "Full AFIT Payout"}
		},
		{
		   $group:
			{
				_id: null,
				afit_tokens: { $sum: "$token_count" },
				orig_sbd_amount: { $sum: "$orig_sbd_amount" },
				orig_steem_amount: { $sum: "$orig_steem_amount" },
				orig_sp_amount: { $sum: "$orig_sp_amount" },
				transaction_count: { $sum: 1 }
			}
		}
	   ]).toArray(function(err, results) {
		res.send(results);
		console.log(results);
	   });

});


/* end point for capturing moderator activity on a specific date and for a specific period (defaults today and a single day activity) */
app.get('/moderatorActivity', async function(req, res) {
	let moderatorsList = await moderatorsListFunc();
	
	//default today
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	//default single day
	let days = 1;
	if (!isNaN(req.query.days)){
		days = req.query.days;
	}
	var endDate = moment(moment(startDate).utc().subtract(days, 'days').toDate()).format('YYYY-MM-DD');
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	await db.collection('team').aggregate([
		{
			$match: 
			{
				title:'moderator', 
				status:'active'
			}
		},
		{
			$lookup: 
			{
				from: "token_transactions", 
				localField: "name", 
				foreignField: "user", 
				as: "moderatorActivity"
			}
		}, 
		{
			$project: 
			{
				'_id':0,
				items: 
				{
					$filter: {
						input: "$moderatorActivity",
						as: "singleEntry",
						cond: { $and: [
							{ "$lte": ["$$singleEntry.date", new Date(startDate)] },
							{ "$gt": ["$$singleEntry.date", new Date(endDate)] }
						] }
					}
				}
			}
		}
	   ]).toArray(function(err, results) {
		res.send(results);
		console.log(results);
	   });

});


/* end point for capturing moderator activity stats during last week */
app.get('/moderatorWeeklyStats', async function(req, res) {
	let moderatorsList = await moderatorsListFunc();
	
	//console.log(moment().utc().startOf('date').day());
	//return;
	//default today
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	
	//make sure stats cover up to 1 week
	let days = moment().utc().startOf('date').day();
	
	//need to fetch last week data if properly set
	if (req.query.priorWeek){
		startDate = moment(moment(startDate).utc().subtract(days, 'days').toDate()).format('YYYY-MM-DD');
		days = 7;
	}
	
	var endDate = moment(moment(startDate).utc().subtract(days, 'days').toDate()).format('YYYY-MM-DD');
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	await db.collection('team').aggregate([
		{
			$match: 
			{
				title:'moderator', 
				status:'active'
			}
		},
		{
			$lookup: 
			{
				from: "token_transactions", 
				localField: "name", 
				foreignField: "user", 
				as: "moderatorActivity"
			}
		}, 
		{
			$project: 
			{
				'_id':0,
				items: 
				{
					$filter: {
						input: "$moderatorActivity",
						as: "singleEntry",
						cond: { $and: [
							{ "$lte": ["$$singleEntry.date", new Date(startDate)] },
							{ "$gt": ["$$singleEntry.date", new Date(endDate)] },
							{ "$in": ["$$singleEntry.reward_activity", ["Moderator Comment", "Post Vote"]] } 
						] }
					}
				}
			}
		},
	   ]).toArray(function(err, results) {
		res.send(results);
		console.log(results);
	   });

});


/* end point to grab current AFIT token price */
app.get('/exchangeAFITPrice', async function(req, res) {
	
	console.log('exchangeAfitPrice:'+exchangeAfitPrice);
	res.send(exchangeAfitPrice);
});

/* end point to grab current AFIT token price */
app.get('/curAFITPrice', async function(req, res) {
	//let curAFITPrice = await db.collection('afit_price').find().sort({'date': -1}).limit(1).next();
	let curAFITPrice = {
		_id: 1,
		unit_price_usd: exchangeAfitPrice.afitHiveLastUsdPrice,
		date: exchangeAfitPrice.lastUpdated
	}
	console.log('curAfitPrice:'+curAFITPrice.unit_price_usd);
	res.send(curAFITPrice);
});

/* handles the process of creating accounts*/
proceedAccountCreation = async function (req){
	//let's create the account now
	let accountCreated = false;
	let transStored = false;
	accountCreated = await utils.createAccount(req.query.new_account, req.query.new_pass, req.query.cur_bchain);
	if (accountCreated){
		transStored = await storeSignupTransaction(req);
		//proceed only if a proper referrer was sent
		if (typeof req.query.referrer != 'undefined' && req.query.referrer != 'undefined' && req.query.referrer != null){
			if (!req.query.promo_proceed || (req.query.promo_proceed && req.query.referrer_reward)){
				referralRewarded = await storeReferralReward(req);
			}
		}
	}
	console.log('account created:'+accountCreated);
	return accountCreated;
}

/* handles saving data related to signup to db */
storeSignupTransaction = async function (req){
	console.log('reward new user');
	let result = false;
	//setup new reward transaction for user
	let new_transaction = {
		account_name: req.query.new_account,
		usd_invest: parseFloat(req.query.usd_invest),
		steem_invest: parseFloat(req.query.steem_invest),
		afit_reward: parseFloat(req.query.afit_reward),
		memo: req.query.memo,
		account_created: true,
		payment_confirmed: true,
		confirming_tx: req.query.confirming_tx,
		promo_code: req.query.promo_code,
		promo_used: req.query.promo_proceed,
		signup_reward: req.query.signup_reward,
		date: new Date(),
	}
	
	
	
	
	if (typeof req.query.referrer != 'undefined' && req.query.referrer != 'undefined' && req.query.referrer != null){
		
		new_transaction['referrer'] = req.query.referrer;
		new_transaction['referrer_afit_reward'] = parseFloat(req.query.afit_reward * config.referrerBonus);
		
		//calculate proper referral reward based on user data
		
		//user rank component
		if (!req.params){
			req.params = new Object();
		}
		req.params.user = req.query.referrer;	
		let ref_rank_obj = await calcRank(req, '');
		let ref_rank = JSON.parse(ref_rank_obj);
		//let ref_rank = await ref_rank_obj.json();
		if (ref_rank){
			new_transaction['referrer_cur_rank'] = ref_rank.user_rank;
		}
		
		//afit amount component
		let user_info = await grabUserTokensFunc(req.query.referrer);
		if (user_info){
			new_transaction['referrer_cur_afit'] = user_info.tokens;
		}
		
		//afitx component
		let userHasAFITX = usersAFITXBal.find(entry => entry.account === req.params.user);
			
		if (userHasAFITX){
			new_transaction['referrer_cur_afitx'] = userHasAFITX.balance;
		}
		
	}
	
	if (typeof req.query.email != 'undefined' && req.query.email != 'undefined' && req.query.email != '' && req.query.email != null){
		new_transaction['email'] = req.query.email;
	}
	
	//make sure we're not double storing referral
	let query = { 
		account_name: req.query.new_account,
		referrer: req.query.referrer,
	};
	
	try{
	  let transaction = await db.collection('signup_transactions')
			.replaceOne(query, new_transaction, { upsert: true });
	  result = true;
	}catch(e){
	  console.log(e);
	  result = false;
	}
	
	//also store this properly into user balance
	if (!req.query.promo_proceed || (req.query.promo_proceed && req.query.signup_reward)){
	
		new_transaction = {
			user: req.query.new_account,
			reward_activity: 'Signup Reward',
			token_count: parseFloat(req.query.afit_reward),
			date: new Date(),
			steem_invest: parseFloat(req.query.steem_invest),
			usd_invest: parseFloat(req.query.usd_invest),
			note: 'Successful Signup',
		}
		
		//make sure we're not double rewarding user
		query = { 
			user: req.query.new_account,
			reward_activity: 'Signup Reward',
		};
				
		try{
		  let transaction = db.collection('token_transactions')
				.replaceOne(query, new_transaction, { upsert: true });
		  result = true;
		}catch(e){
		  console.log(e);
		  result = false;
		}
		console.log(result);
	}
	return result;
}


/* function handles saving referral info and reward if the signup came through a referral */
storeReferralReward = async function (req){
	console.log('reward referrer');
	//setup new reward transaction for user
	let refRewarded = false;
	let new_transaction = {
		user: req.query.referrer,
		reward_activity: 'Signup Referral',
		token_count: parseFloat(req.query.afit_reward * config.referrerBonus),
		date: new Date(),
		referred: req.query.new_account,
		note: 'Referral reward for signup of user '+req.query.new_account,
	}
	
	//make sure we're not double rewarding user
	let query = { 
		user: req.query.referrer,
		reward_activity: 'Signup Referral',
		referred: req.query.new_account,
	};
	
	try{
		let transaction = await db.collection('token_transactions')
			.replaceOne(query, new_transaction, { upsert: true });
		refRewarded = true;
	}catch(e){
	  console.log(e);
	}
	
	console.log('success');
	return refRewarded;
};

app.get('/confirmAFITSEBulk', async function(req,res){
	//let's call the service by S-E
	
	let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
		
	let url = new URL(config.hive_engine_trans_acct_his);
	if (bchain == 'STEEM'){
		url = new URL(config.steem_engine_trans_acct_his);
	}
	//console.log(config.steem_engine_trans_acct_his_lrg);
	//connect with our service to confirm AFIT received to proper wallet
	try{
		let se_connector = await fetch(url);
		let trx_entries = await se_connector.json();
		
		
		//console.log(trx_entries);
		trx_entries.forEach( async function(entry){
			console.log(entry);
			let user = entry.from;
			if (user != config.steem_engine_actifit_se && user != config.hive_engine_actifit_he){
				
				let exchangeType = 'HE';
				
				if (bchain == 'STEEM'){
					exchangeType = 'SE';
				}
				
				//query to see if entry already stored
				let tokenExchangeTransQuery = {
					user: user,
					se_trx_ref: entry.transactionId
				}
				//store the transaction to the user's profile
				let tokenExchangeTrans = {
					user: user,
					reward_activity: 'Move AFIT ' + exchangeType + ' to Actifit Wallet',
					token_count: parseFloat(entry.quantity),
					se_trx_ref: entry.transactionId,
					exchange: exchangeType,
					date: new Date(entry.timestamp * 1000) //timestamp linux convert to seconds first
				}
				try{
					console.log(tokenExchangeTrans);
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('token_transactions').update(tokenExchangeTransQuery, tokenExchangeTrans, { upsert: true });
					let trans_res = transaction.result;
					console.log(trans_res);
					
					if (trans_res.upserted){
						//we have a new entry, increase user token count
						
						let user_info = await grabUserTokensFunc (user);
						
						let cur_user_token_count = 0;
						if (user_info){
							cur_user_token_count = parseFloat(user_info.tokens);
							//update current user's token balance & store to db
							afit_amount = parseFloat(entry.quantity);
							let new_token_count = cur_user_token_count + parseFloat(afit_amount);
							user_info.tokens = new_token_count;
							console.log('new_token_count:'+new_token_count);
							try{
								let trans = await db.collection('user_tokens').save(user_info);
								console.log('success adding AFIT tokens to user balance');
							}catch(err){
								console.log(err);
								return;
							}
						}
					}
					
				}catch(err){
					console.log(err);
					res.write(JSON.stringify({'error': 'Error adding AFIT tokens to user balance'}));
					res.end();
					return;
				}
			}
		});
		
		res.write(JSON.stringify({'status': 'done updating AFIT SE moves'}));
		res.end();
		
	}catch(err){
		console.log(err);
	}
})

//function handles fetching recent tip transactions
app.get('/verifyTipTransactions', async function (req, res){
	let outcome = await utils.verifyTipTransactions(db);
	res.send(outcome);
})

app.get('/availableTipBalance', async function (req, res){
	if (!req.query || !req.query.user){
		res.send({})
		return;
	}
	let dt = await db.collection('tip_balance').findOne({user: req.query.user});
	res.send(dt);
})

app.get('/processTipRequest', async function (req, res){
	if (!req.query.trxId || !req.query.blkNo){
		res.send({status: "error", error: "missing data"});
		return;
	}
	
	//update tip transactions before proceeding
	utils.verifyTipTransactions(db);
	
	//fetch the relevant transaction, and process it
	let trxId = req.query.trxId;
	let blkNo = req.query.blkNo;
	
	//default chain
	let chain = 'HIVE';//req.query.chain;
	if (req.query.chain){
		chain = req.query.chain;
	}
	
	//check if trx has been processed before
	let matchCriteria = {trx_id: trxId, blk_no: blkNo, chain: chain};
	let matchTrx = await db.collection('tip_trx_processed').findOne(matchCriteria);
	console.log(matchTrx);
	if (matchTrx && matchTrx.processed==true){
		//found existing processed trx, bail
		res.send({status: "error", error: "trx already processed"});
		return;
	}
	
	let reslt = await utils.fetchChainTrx(trxId, blkNo, chain);
	console.log(reslt);
	
	if (reslt && reslt.reqUser && reslt.tgtUser && reslt.amnt){
		//recalculate tip balances
		let tipBal = await utils.updateTipBalances(db);
	
		//fetch user tip balance
		let dt = await db.collection('tip_balance').findOne({user: reslt.reqUser});
		//only send amount if user has enough balance
		if (dt && dt.tip_balance && dt.tip_balance >= reslt.amnt ){
			
			//send out the tip
			let tx_res = await utils.proceedSendToken(reslt.reqUser, config.tip_account, config.tip_account_active_key, reslt.tgtUser, reslt.amnt, chain, reslt.symbol);
			
			if (tx_res && tx_res.ref_block_num){
				//update user tip balances
				tipBal = await utils.updateTipBalances(db);
				
				//confirm trx was processed to db, to avoid any future abuse
				await db.collection('tip_trx_processed').insert({trx_id: trxId, blk_no: blkNo, chain: chain, processed: true, pay_trx_id: tx_res.ref_block_num, date:new Date()})
				reslt.content = '<img src="https://files.peakd.com/file/peakd-hive/afitbot/23yJk8EGMSLCRMAnLGQPirdaC6MdeMZMFTqrxuzYy5Qa9asTGhbLW8zqAdVGYkif4SWaD.png" >';
				reslt.content += '<br/>Hey @'+reslt.tgtUser+', you just received '+reslt.amnt+' '+reslt.symbol+' tip from @'+reslt.reqUser+'!';
				reslt.content += '<br/>For more info about tipping AFIT tokens, check out [this link](https://links.actifit.io/tipping-afit)';
				reslt.content += '<br/><img src="https://cdn.steemitimages.com/DQmXrZz658YfMQBXNTA12rmbzqWXASfaGcNSqatJJ2ba7NR/rulersig2.jpg" >'
				reslt.eligible = true;
				//also write comment on blockchain
				await utils.commentToChain(reslt);
				//success
				res.send({status: "success"});
			}
			//update tip balances
			//console.log(trx);
		}else{
			reslt.content = '<img src="https://files.peakd.com/file/peakd-hive/afitbot/23yJk8EGMSLCRMAnLGQPirdaC6MdeMZMFTqrxuzYy5Qa9asTGhbLW8zqAdVGYkif4SWaD.png" >';
			reslt.content += 'Hey @'+reslt.reqUser+', we could not send a tip as your tip balance is below threshold. To tip other users, please send a minimum of '+reslt.amnt+' '+reslt.symbol+' on hive-engine to @actifit.tip account, and then retry. ';
			reslt.content += '<br/>For more info about tipping AFIT tokens, check out [this link](https://links.actifit.io/tipping-afit)';
			reslt.content += '<br/><img src="https://cdn.steemitimages.com/DQmXrZz658YfMQBXNTA12rmbzqWXASfaGcNSqatJJ2ba7NR/rulersig2.jpg" >'
			reslt.eligible = false;
			//also write comment on blockchain
			await utils.commentToChain(reslt);
			res.send({status: "error", error: "user '+reslt.reqUser+' does not have enough tip balance"});
			return;
		}
	}else{
		res.send({status: "error", error: "trx not found"});
		return;
	}
});

//function handles updating user tip balances
app.get('/updateTipBalances', async function (req, res){
	let outcome = await utils.updateTipBalances(db);
	res.send(outcome);
})

//function handles the process of confirming AFIT S-E receipt into proper account, and increases AFIT amount held in power mode
app.get('/confirmAFITSEReceipt', async function(req,res){
	if (!req.query.user){
		res.send('{}');
	}else{
		//keeping request alive to avoid timeouts
		let intID = setInterval(function(){
			res.write(' ');
		}, 6000);
		let afit_amount = 0;
		let found_entry = false;
		try{
			let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
			//attempt to find matching transaction
			let targetUser = req.query.user;
			let match_trx = await utils.confirmSEAFITReceived(targetUser, bchain);
			console.log(match_trx);
			let exchangeType = 'HE';
			if (bchain == 'STEEM'){
				exchangeType = 'SE';
			}
			//we found a match
			if (match_trx){
				found_entry = true;				
				//query to see if entry already stored
				let tokenExchangeTransQuery = {
					user: targetUser,
					se_trx_ref: match_trx.transactionId
				}
				//store the transaction to the user's profile
				let tokenExchangeTrans = {
					user: targetUser,
					reward_activity: 'Move AFIT '+ exchangeType + ' to Actifit Wallet',
					token_count: parseFloat(match_trx.quantity),
					se_trx_ref: match_trx.transactionId,
					exchange: exchangeType,
					date: new Date(match_trx.timestamp * 1000) //timestamp linux convert to seconds first
				}
				try{
					console.log(tokenExchangeTrans);
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('token_transactions').update(tokenExchangeTransQuery, tokenExchangeTrans, { upsert: true });
					let trans_res = transaction.result;
					console.log(trans_res);
					/*console.log('nMatched:'+trans_res.nMatched);
					console.log('nUpserted:'+trans_res.upserted);
					console.log('nModified:'+trans_res.nModified);*/
					if (trans_res.upserted){
						//we have a new entry, increase user token count
						
						let user_info = await grabUserTokensFunc (targetUser);
						
						let cur_user_token_count = 0;
						if (user_info){
							cur_user_token_count = parseFloat(user_info.tokens);
							//update current user's token balance & store to db
							afit_amount = parseFloat(match_trx.quantity);
							let new_token_count = cur_user_token_count + parseFloat(afit_amount);
							user_info.tokens = new_token_count;
							console.log('new_token_count:'+new_token_count);
							try{
								let trans = await db.collection('user_tokens').save(user_info);
								console.log('success adding AFIT tokens to user balance');
							}catch(err){
								console.log(err);
								return;
							}
						}
					}else{
						//do nothing
					}
				}catch(err){
					console.log(err);
					res.write(JSON.stringify({'error': 'Error adding AFIT tokens to user balance'}));
					res.end();
					return;
				}
			}
		}catch(err){
			console.log(err);
		}
		//we're done, let's clear our running interval
		clearInterval(intID);
		//send response with confirming AFIT power up
		let status = 'success';
		if (!found_entry){
			status = 'error';
			afit_amount = '';
		}
		res.write(JSON.stringify({'afit_se_power': status, 'afit_amount': afit_amount}));
		res.end();
	}
});


//function handles the process of confirming AFITX S-E receipt into proper account, and then duplicating to new exchange
app.get('/proceedAfitxTransition', async function(req,res){
	if (!req.query.user || !req.query.amount || !req.query.txid){
		res.send('{}');
	}else{
		//keeping request alive to avoid timeouts
		let intID = setInterval(function(){
			res.write(' ');
		}, 6000);
		let found_entry = false;
		let afitx_amount = '';
		let status = '';
		try{
			let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
			//attempt to find matching transaction
			let targetUser = req.query.user;
			let amount = req.query.amount;
			let txid = req.query.txid;
			let match_trx = await utils.confirmAFITXTransition(targetUser, txid, amount, bchain);
			console.log(match_trx);
			
			//we found a match
			if (match_trx){
				found_entry = true;				
				//query to see if entry already stored
				let tokenExchangeTransQuery = {
					user: targetUser,
					token_count: amount,
					trx: match_trx.transactionId,
					block: match_trx.blockNumber,
					chain: bchain,
				}
				//store the transaction to the user's profile
				let tokenExchangeTrans = {
					user: targetUser,
					action: 'Move AFITX ',
					token_count: amount,
					net_amount: amount * (1-config.trx_burn_rate),//apply 0.5% burn rate
					trx: match_trx.transactionId,
					block: match_trx.blockNumber,
					chain: bchain,
					date: new Date(match_trx.timestamp * 1000) //timestamp linux convert to seconds first
				}
				console.log(tokenExchangeTrans);
				try{
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('afitx_transitions').find(tokenExchangeTransQuery).toArray();
					if (Array.isArray(transaction) && transaction.length > 0){
						//match found, duplicate request, ignore
						console.log('Existing processed transaction. Ignore');
						status = 'error';
					}else{
						//apply 0.5% burn rate
						amount = amount * (1-config.trx_burn_rate)
						let res = await utils.proceedAfitxMove(targetUser, amount, (bchain=='STEEM'?'HIVE':'STEEM'));
						let transaction = await db.collection('afitx_transitions').insert(tokenExchangeTrans);
						console.log('success moving & inserting transaction data');
						afitx_amount = amount;
						status = 'success';
					}
				}catch(err){
					console.log(err);
					res.write(JSON.stringify({'error': 'Error moving AFITX tokens to user balance'}));
					res.end();
					return;
				}
			}
		}catch(err){
			console.log(err);
		}
		//we're done, let's clear our running interval
		clearInterval(intID);
		//send response
		res.write(JSON.stringify({'afitx_transition': status, 'afitx_amount': afitx_amount}));
		res.end();
	}
});

//function handles the process of confirming AFIT S-E receipt into proper account, and then duplicating to new exchange
app.get('/proceedAfitTransition', async function(req,res){
	if (!req.query.user || !req.query.amount || !req.query.txid){
		res.send('{}');
	}else{
		//keeping request alive to avoid timeouts
		let intID = setInterval(function(){
			res.write(' ');
		}, 6000);
		let found_entry = false;
		let afitx_amount = '';
		let status = '';
		try{
			let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
			//attempt to find matching transaction
			let targetUser = req.query.user;
			let amount = req.query.amount;
			let txid = req.query.txid;
			let standardAfit = 1;
			let match_trx = await utils.confirmAFITXTransition(targetUser, txid, amount, bchain, standardAfit);
			console.log(match_trx);
			
			//we found a match
			if (match_trx){
				found_entry = true;				
				//query to see if entry already stored
				let tokenExchangeTransQuery = {
					user: targetUser,
					token_count: amount,
					trx: match_trx.transactionId,
					block: match_trx.blockNumber,
					chain: bchain,
				}
				//store the transaction to the user's profile
				let tokenExchangeTrans = {
					user: targetUser,
					action: 'Move AFIT',
					token_count: amount,
					net_amount: amount * (1-config.trx_burn_rate),//apply 0.5% burn rate
					trx: match_trx.transactionId,
					block: match_trx.blockNumber,
					chain: bchain,
					date: new Date(match_trx.timestamp * 1000) //timestamp linux convert to seconds first
				}
				console.log(tokenExchangeTrans);
				try{
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('afit_transitions').find(tokenExchangeTransQuery).toArray();
					if (Array.isArray(transaction) && transaction.length > 0){
						//match found, duplicate request, ignore
						console.log('Existing processed transaction. Ignore');
						status = 'error';
					}else{
						//apply 0.5% burn rate
						amount = amount * (1-config.trx_burn_rate)
						let res = await utils.proceedAfitxMove(targetUser, amount, (bchain=='STEEM'?'HIVE':'STEEM'), standardAfit);
						let transaction = await db.collection('afit_transitions').insert(tokenExchangeTrans);
						console.log('success moving & inserting transaction data');
						afitx_amount = amount;
						status = 'success';
					}
				}catch(err){
					console.log(err);
					res.write(JSON.stringify({'error': 'Error moving AFIT tokens to user balance'}));
					res.end();
					return;
				}
			}
		}catch(err){
			console.log(err);
		}
		//we're done, let's clear our running interval
		clearInterval(intID);
		//send response
		res.write(JSON.stringify({'afit_transition': status, 'afit_amount': afitx_amount}));
		res.end();
	}
});


/* function handles the processing of a buy order paid in HIVE */
app.get('/processBuyOrderHive', async function(req, res){
	if (!req.query.user || !req.query.product_id) {
		//make sure all params are sent
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let product_id = req.query.product_id;
		//confirm matching funds password
		let query = {user: user};
		
		let access_token;
		
		//fetch product info
		let product = await grabProductInfo (product_id);
		if (!product){
			res.send({'error': 'Product not found'});
			return;
		}
		
		let price_options = product.price;
		let price_options_count = price_options.length;
		let item_price = 0;
		let item_currency = 'HIVE';
		let actifit_percent_cut = 10;
		for (let i=0; i < price_options_count; i++){
			let entry = price_options[i];
			item_price = entry.price;
			item_currency = entry.currency;
			actifit_percent_cut = entry.actifit_percent_cut;
		}
		
	
		//product.provider = 'actifit.test.provider';
		
		//perform transaction
		let productBuyTrans = {
			user: user,
			reward_activity: 'Buy Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_price: item_price,
			token_count: -item_price,
			note: 'Bought Product '+product.name+ ' by '+product.provider,
			date: new Date(),
		}
		try{
			console.log(productBuyTrans);
			let transaction = await db.collection('token_transactions').insert(productBuyTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
		}
		
		
		
		//store this in escrow
		let productSellTrans = {
			user: config.escrow_account,//targetAccount,//product.provider,//config.escrow_account,
			reward_activity: 'Sell Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_price: item_price,
			token_count: item_price,
			actifit_percent_cut: actifit_percent_cut,
			note: 'Sold Product '+product.name+ ' to '+user,
			date: new Date(),
		}
		
		//alternatively, send to provider directly
		if (product.type == 'ebook'){
			//close the transaction on the fly, no need to put in escrow. Rewards goes to seller
			productSellTrans.user = product.provider;
			productSellTrans.token_count = parseFloat(item_price) * (100 - parseFloat(actifit_percent_cut)) / 100;
		}
		
		try{
			console.log(productSellTrans);
			let transaction = await db.collection('gadget_transactions_hive').insert(productSellTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing sell action. DB storing issue'});
			return;
		}		
		
		res.send({'status': 'Success', 'access_token': access_token});
	}
})


/* function handles the processing of a buy order */
app.get('/processBuyOrder', async function(req, res){
	if (!req.query.user || !req.query.product_id) {
		//make sure all params are sent
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let product_id = req.query.product_id;
		//confirm matching funds password
		let query = {user: user};
		
		let access_token;
		
		/*let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(req.query.pass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
		*/
		
		//fetch product info
		let product = await grabProductInfo (product_id);
		if (!product){
			res.send({'error': 'Product not found'});
			return;
		}
		
		//confirm proper AFIT token balance. Test against product price
		let user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		let cur_user_token_count = parseFloat(user_info.tokens);
		
		let price_options = product.price;
		let price_options_count = price_options.length;
		let item_price = 0;
		let item_currency = 'AFIT';
		let actifit_percent_cut = 10;
		for (let i=0; i < price_options_count; i++){
			let entry = price_options[i];
			item_price = entry.price;
			item_currency = entry.currency;
			actifit_percent_cut = entry.actifit_percent_cut;
		}
		
		if (cur_user_token_count < item_price){
			res.send({'error': 'Account does not have enough AFIT funds'});
			return;
		}
		
		//product.provider = 'actifit.test.provider';
		
		//perform transaction
		let productBuyTrans = {
			user: user,
			reward_activity: 'Buy Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_price: item_price,
			token_count: -item_price,
			note: 'Bought Product '+product.name+ ' by '+product.provider,
			date: new Date(),
		}
		try{
			console.log(productBuyTrans);
			let transaction = await db.collection('token_transactions').insert(productBuyTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
		}
		
		
		
		//store this in escrow
		let productSellTrans = {
			user: config.escrow_account,//targetAccount,//product.provider,//config.escrow_account,
			reward_activity: 'Sell Product',
			buyer: user,
			seller: product.provider,
			product_id: product_id,
			product_type: product.type,
			product_price: item_price,
			token_count: item_price,
			actifit_percent_cut: actifit_percent_cut,
			note: 'Sold Product '+product.name+ ' to '+user,
			date: new Date(),
		}
		
		//alternatively, send to provider directly
		if (product.type == 'ebook'){
			//close the transaction on the fly, no need to put in escrow. Rewards goes to seller
			productSellTrans.user = product.provider;
			productSellTrans.token_count = parseFloat(item_price) * (100 - parseFloat(actifit_percent_cut)) / 100;
		}
		
		try{
			console.log(productSellTrans);
			let transaction = await db.collection('token_transactions').insert(productSellTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error performing sell action. DB storing issue'});
			return;
		}
		
		if (product.type == 'ebook'){
			//also put profit to actifit.profit account
			
			productSellTrans = {
				user: config.sale_profit_account,
				reward_activity: 'Sell Product Profit',
				buyer: user,
				seller: product.provider,
				product_id: product_id,
				product_type: product.type,
				product_price: item_price,
				token_count: parseFloat(item_price) * parseFloat(actifit_percent_cut) / 100,
				actifit_percent_cut: actifit_percent_cut,
				note: 'Sale Profit Product '+product.name+ ' by ' + product.provider + ' to '+user,
				date: new Date(),
			}
			
			try{
				console.log(productSellTrans);
				let transaction = await db.collection('token_transactions').insert(productSellTrans);
				console.log('success inserting post data');
			}catch(err){
				console.log(err);
				res.send({'error': 'Error performing sell action. DB storing issue'});
				return;
			}
			
			//we also need to store this transaction alongside an access token that enables this user only to access the download ebook
			access_token = generatePassword(2);
			
			let productTokenTrans = {
				user: user,
				product_id: product_id,
				access_token: access_token,
				enabled: true,
				date: new Date(),
			}
			
			try{
				console.log(productTokenTrans);
				let transaction = await db.collection('user_product_key').insert(productTokenTrans);
				console.log('success inserting access_token');
			}catch(err){
				console.log(err);
				res.send({'error': 'Error performing sell action. DB storing issue'});
				return;
			}
			
		}
		
		
		//update current user's token balance & store to db
		let new_token_count = cur_user_token_count - parseFloat(item_price);
		user_info.tokens = new_token_count;
		console.log('new_token_count:'+new_token_count);
		try{
			let trans = await db.collection('user_tokens').save(user_info);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
		
		res.send({'status': 'Success', 'access_token': access_token});
	}
})

/* grab user token entry for user */

matchProductTrans = async function (user, product_id){
  let token_match = await db.collection('user_product_key').findOne(
	{ user: user, product_id: product_id },
	{ user: 1, product_id: 1 }
  );
  console.log(token_match);
  return token_match;
}

matchAccessToken = async function (user, product_id, access_token){
  let token_match = await db.collection('user_product_key').findOne({user: user, product_id: product_id, access_token: access_token});
  return token_match;
}

app.get("/gadgetBoughtName", async function(req, res) {
	//console.log('gadgetBought');
	//console.log(req.query);
  //check if proper params sent
  if (!req.query.user || !req.query.gadget_name || !req.query.gadget_level) {
	//make sure all params are sent
	res.send({'error':'generic error'});
  }
  
  let user = req.query.user;
  let gadget_name = req.query.gadget_name;
  let gadget_level = req.query.gadget_level;
  
  //check if the proper access token is valid for this user/product combination
  let gadget_match = await db.collection('user_gadgets').find(
	{ user: user, gadget_name: gadget_name, gadget_level: parseInt(gadget_level)},
	
  ).toArray();
  
  console.log(gadget_match);
  
  //let token_match = await matchProductTrans(user, gadget_id);
  
  res.send(gadget_match);
});


app.get("/gadgetsBought", async function(req, res){
	let gadgets = await db.collection('user_gadgets').find().toArray();
	res.send(gadgets);
});

app.get("/gadgetsBoughtByDate", async function(req, res){
	let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	let endDate = moment(moment(startDate).utc().subtract(1, 'days').toDate()).format('YYYY-MM-DD');
	let gadgets = await db.collection('user_gadgets').find(
		{
			date_bought:{
				$lte: new Date(startDate),
				$gt: new Date(endDate)
			}
		}).toArray();
	let usersArray = [];
	for (let i=0;i<gadgets.length;i++){
		let entry = gadgets[i];
		if (!usersArray.includes(entry.user)){
			usersArray.push(entry.user);
		}
	}
	console.log(usersArray);
	//, 'entries': gadgets
	res.send({'totalGadgets': gadgets.length, 'uniqueUsers': usersArray.length});
});

app.get("/gadgetsBoughtByDateDetails", async function(req, res){
	let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	let endDate = moment(moment(startDate).utc().subtract(1, 'days').toDate()).format('YYYY-MM-DD');
	let gadgets = await db.collection('user_gadgets').find(
		{
			date_bought:{
				$lte: new Date(startDate),
				$gt: new Date(endDate)
			}
		}).toArray();
	let usersArray = [];
	for (let i=0;i<gadgets.length;i++){
		let entry = gadgets[i];
		if (!usersArray.includes(entry.user)){
			usersArray.push(entry.user);
		}
	}
	console.log(usersArray);
	//, 'entries': gadgets
	res.send({'totalGadgets': gadgets.length, 'uniqueUsers': usersArray.length, 'gadgets': gadgets});
});

app.get("/friendships", async function(req, res){
	let gadgets = await db.collection('friends').find().toArray();
	res.send(gadgets);
});

app.get("/pendingFriendships", async function(req, res){
	let friendRequests = await db.collection('user_requests').find({status: 'pending'}).toArray();
	res.send(friendRequests);
});

app.get("/userRequests", async function(req, res){
	let gadgets = await db.collection('user_requests').find().toArray();
	res.send(gadgets);
});


app.get("/activeGadgets", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
  let gadget_match = await db.collection('user_gadgets').aggregate([
						{ $match: { status: "active" } },
						{ $lookup:{
									from: "products",
									/*let: { "user_gadget_id": "$gadget" },
									pipeline: [
										{ $addFields: {gadgetId: { $toObjectId: "$$user_gadget_id" }}},//not supported in mongodb < 4
										{ $match: { $expr: { $eq: [ "$_id", "$user_gadget_id" ] } } }
									],*/
									localField: "gadget",
									foreignField: "_id",
									as: "productdetails"
								} 
						},
						
					]).toArray();
  console.log(gadget_match);
  res.send(gadget_match);
});

app.get("/nonConsumedGadgetsByUser/:user", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
	let targetUser = req.params.user.replace('@','');
	let aTargetUser = '@'+targetUser;
	let gadget_match = await db.collection('user_gadgets').find({ user: { $in: [targetUser, aTargetUser]}, status : {$ne:'consumed'} }).toArray();		
	res.send(gadget_match);
});

app.get("/consumedGadgetsByUser/:user", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
	let targetUser = req.params.user.replace('@','');
	let aTargetUser = '@'+targetUser;
	let gadget_match = await db.collection('user_gadgets').find({ user: { $in: [targetUser, aTargetUser]}, status: "consumed" }).toArray();		
	res.send(gadget_match);
});

app.get("/activeGadgetsByUserApp/:user", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
	let targetUser = req.params.user.replace('@','');
	let aTargetUser = '@'+targetUser;
	let gadget_match = await db.collection('user_gadgets').find({ user: { $in: [targetUser, aTargetUser]}, status: "active" }).toArray();			
	let gadget_match_benefic = await db.collection('user_gadgets').find({ benefic: { $in: [targetUser, aTargetUser]}, status: "active" }).toArray();					
	res.send({'own': gadget_match});
});

app.get("/activeGadgetsByUser/:user", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
	let targetUser = req.params.user.replace('@','');
	let aTargetUser = '@'+targetUser;
	let gadget_match = await db.collection('user_gadgets').find({ user: { $in: [targetUser, aTargetUser]}, status: "active" }).toArray();			
	let gadget_match_benefic = await db.collection('user_gadgets').find({ benefic: { $in: [targetUser, aTargetUser]}, status: "active" }).toArray();					
	res.send({'own': gadget_match, 'benefic': gadget_match_benefic});
});

app.get("/boughtGadgetCountByUser/:user", async function(req, res) {
  //let gadget_match = await db.collection('user_gadgets').find({ status: "active"}).toArray();
  let targetUser = req.params.user.replace('@','');
  let aTargetUser = '@'+targetUser;
  let gadget_match = await db.collection('user_gadgets').aggregate([
						{ $match: { user: { $in: [targetUser, aTargetUser]} } },
						{
						   $group:
							{
							   _id: {gadget: "$gadget", status: "$status"},
							   /*tokens_distributed: { $sum: "$tokens" },*/
							   /*active_count: { $sum: }*/
							   count: { $sum: 1 }
							}
						}
					]).toArray();
  //console.log(gadget_match);
  res.send(gadget_match);
});




app.get("/gadgetBought", async function(req, res) {
	//console.log('gadgetBought');
	//console.log(req.query);
  //check if proper params sent
  if (!req.query.user || !req.query.gadget_id) {
	//make sure all params are sent
	res.send({'error':'generic error'});
  }
  
  let user = req.query.user;
  let gadget_id = new ObjectId(req.query.gadget_id);
  
  //check if the proper access token is valid for this user/product combination
  let gadget_match = await db.collection('user_gadgets').find(
	{ user: user, gadget: gadget_id },
	{ user: 1, date_bought: 1 }
  ).toArray();
  
  //console.log(gadget_match);
  
  //let token_match = await matchProductTrans(user, gadget_id);
  
  res.send(gadget_match);
});

async function performActivateMultiTrx(req){
	let user = req.params.user;
	let gadgets = req.params.gadgets
	
	//make sure friend and user are different
	if (req.params.benefic && req.params.benefic.replace('@','') == user){
		return({'error': 'User & friend cannot be the same account'});
		
	}
	
	console.log('activateGadget');
	let ver_trx = await utils.verifyGadgetTransaction(user, gadgets, 'activate-gadget', req.params.trxID, req.params.bchain, db);
	console.log(ver_trx);
	//ensure proper transaction
	if (!ver_trx){
		return({status: 'error'});
		//return;
	}
	
	let gadget_entries = req.params.gadgets.split('-');
	let err = '';
	for (let i=0;i<gadget_entries.length;i++){
		//find item to activate and proceed activating
		let gadget = new ObjectId(gadget_entries[i]);
		let gadget_match = await db.collection('user_gadgets').findOne({ user: user, gadget: gadget, status: "bought" });
		if (gadget_match){
			gadget_match.status="active";
			if (req.params.benefic){
				gadget_match.benefic = req.params.benefic;
				
				//also send notification to the beneficiary about being set for this gadget
				utils.sendNotification(db, req.params.benefic.replace('@',''), user, 'gadget_beneficiary', 'friendship', 'User ' + user + ' has set you as reward beneficiary for one of their gadgets!', 'https://actifit.io/'+user);
			}
			db.collection('user_gadgets').save(gadget_match);
			
		}else{
			err = 'Product not found';
		}
	}
	if (err != ''){
		return ({'error': err});
	}else{
		return ({'status': 'success'});
	}
}
//end point handles activating multi bought gadgets/
app.get('/activateMultiGadgetKeychain/:user/:gadgets/:trxID/:bchain/:benefic?', async function (req, res) {
	console.log('multi gadget activate keychain')
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}		
	let outc = await performActivateMultiTrx(req);
	res.send(outc);
	
});

//end point handles activating multi bought gadgets/
app.get('/activateMultiGadget/:user/:gadgets/:blockNo/:trxID/:bchain/:benefic?', async function (req, res) {
		
	let outc = await performActivateMultiTrx(req);
	res.send(outc);
	
});

//NOTICE: deprecated in favor of activateMultiGadget
//end point handles activating a bought gadget
app.get('/activateGadget/:user/:gadget/:blockNo/:trxID/:bchain/:benefic?', async function (req, res) {
	let user = req.params.user;
	let gadget = req.params.gadget;
	
	//make sure friend and user are different
	if (req.params.benefic && req.params.benefic.replace('@','') == user){
		res.send({'error': 'User & friend cannot be the same account'});
		return;
	}
	
	console.log('activateGadget');
	let ver_trx = await utils.verifyGadgetTransaction(user, gadget, 'activate-gadget', req.params.trxID, req.params.bchain, db);
	console.log(ver_trx);
	//ensure proper transaction
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	
	//find item to activate and proceed activating
	gadget = new ObjectId(gadget);
	let gadget_match = await db.collection('user_gadgets').findOne({ user: user, gadget: gadget, status: "bought" });
	if (gadget_match){
		gadget_match.status="active";
		if (req.params.benefic){
			gadget_match.benefic = req.params.benefic;
			
			//also send notification to the beneficiary about being set for this gadget
			utils.sendNotification(db, req.params.benefic.replace('@',''), user, 'gadget_beneficiary', 'friendship', 'User ' + user + ' has set you as reward beneficiary for one of their gadgets!', 'https://actifit.io/'+user);
		}
		db.collection('user_gadgets').save(gadget_match);
		res.send({'status': 'success'});
	}else{
		res.send({'error': 'Product not found'});
		
	}
});


async function performDeactivateTrx(req){
	let user = req.params.user;
	let gadget = req.params.gadget;
	
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(user, gadget, 'deactivate-gadget', req.params.trxID, req.params.bchain, db);
	if (!ver_trx){
		return ({status: 'error'});
		
	}
	
	//find item to activate and proceed activating
	gadget = new ObjectId(gadget);
	let gadget_match = await db.collection('user_gadgets').findOne({ user: user, gadget: gadget, status: "active" });
	if (gadget_match){
		gadget_match.status="bought";
		db.collection('user_gadgets').save(gadget_match);
		return ({'status': 'success'});
	}else{
		return ({'error': 'Product not found'});
		
	}	
	
}

//end point handles deactivating bought gadget via keychain
app.get('/deactivateGadgetKeychain/:user/:gadget/:trxID/:bchain', async function (req, res) {
	let conf_trx = await utils.findVerifyTrx(req, db);
	if (!conf_trx || conf_trx.error){
		res.send({status: 'error'});
		return;
	}

	let outc = await performDeactivateTrx(req);
	res.send(outc);	
});

//end point handles deactivating a bought gadget
app.get('/deactivateGadget/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {
	let outc = await performDeactivateTrx(req);
	res.send(outc);
});


app.get("/productBought", async function(req, res) {
	console.log('productBought');
	console.log(req.query);
  //check if proper params sent
  if (!req.query.user || !req.query.product_id) {
	//make sure all params are sent
	res.send({'error':'generic error'});
  }
  
  let user = req.query.user;
  let product_id = req.query.product_id;
  
  //check if the proper access token is valid for this user/product combination
  let token_match = await matchProductTrans(user, product_id);
  
  res.send(token_match);
});

app.get("/productBoughtToken", async function(req, res) {
  //check if proper params sent
  if (!req.query.user || !req.query.access_token || !req.query.product_id) {
	//make sure all params are sent
	res.send({'error':'generic error'});
  }
  
  let user = req.query.user;
  let access_token = req.query.access_token;
  let product_id = req.query.product_id;
  
  //check if the proper access token is valid for this user/product combination
  let token_match = await matchAccessToken(user, product_id, access_token);
 
  res.send(token_match);
});


app.get("/validatePassForDownload", async function(req, res) {
	let user = req.query.user;
	let product_id = req.query.product_id;
	let query = {user: user};
	let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

	if (entryFound == null){
		res.send({'error': 'Account does not have a recorded funds password'});
		return;
	}else if (!entryFound.passVerified){
		res.send({'error': 'Account\'s funds password not verified'});
		return;
	}else{
	  //create encrypted version of sent password
	  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
	  let encr_pass = cipher.update(req.query.pass, 'utf8', 'hex');
	  encr_pass += cipher.final('hex');
		if (entryFound.pass !== encr_pass){
			res.send({'error': 'Incorrect username and/or funds password'});
			return;
		}
		
		//if pass if valid, re-enable download for this link for this user
		let token_match = await db.collection('user_product_key').findOne({ user: user, product_id: product_id });
		token_match.enabled = true;
		db.collection('user_product_key').save(token_match);
		res.send({'success': 'success', 'access_token': token_match.access_token});
	}
});

/* function handles providing user for proper access to download ebook, while enforcing CORS */

app.get("/downEbook", async function(req, res) {
  //check if proper params sent
  if (!req.query.user || !req.query.access_token || !req.query.product_id) {
	//make sure all params are sent
	res.send({'error':'generic error'});
  }
  
  let user = req.query.user;
  let access_token = req.query.access_token;
  let product_id = req.query.product_id;
  
  //check if the proper access token is valid for this user/product combination
  let token_match = await matchAccessToken(user, product_id, access_token);
  console.log(token_match);
  if (!token_match){
	console.log('not found');
	res.send({error: "access not permitted"});
	return;
  }
  
  if (!token_match.enabled){
	console.log('found disabled');
	res.send({error: "user access not permitted"});
	return;
  }
  //need to set download to disabled to prevent future unauthorized access
  token_match.enabled = false;
  db.collection('user_product_key').save(token_match);

  const fileName = config.ebook1
  const filePath = config.ebook1pathlive + fileName
  
  const fs = require('fs');
  
  		
  const path = require('path');
  let pathname = path.join(__dirname, filePath);
  console.log(pathname);
  //return;

  // Check if file specified by the filePath exists 
  fs.access(pathname, (err) => {
	  if (!err) {
		console.log('match ebook');
		res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=" + fileName
        });
        fs.createReadStream(filePath).pipe(res);
		return;
	  }
	  console.log(err);
	  console.log('ebook does not exist');
	  res.writeHead(400, {"Content-Type": "text/plain"});
      res.end("ERROR File does not exist");
	});
 
})
 
 
//function handles the process of confirming payment receipt, and then proceeds with account creation, reward and delegation
app.get('/confirmPayment', async function(req,res){
	if (req.query.confirm_payment_token != config.confirmPaymentToken){
	//if (false){
		res.send('{}');
	}else{
		let paymentReceivedTx = '';
		let accountCreated = false;
		let spToDelegate = 10;
		//keeping request alive to avoid timeouts
		let intID = setInterval(function(){
			res.write(' ');
		}, 6000);
		try{
			//check if promo code was sent, and confirm against available promo codes
			if (req.query.promo_code){
			  let promo_match = await db.collection('signup_promo_codes').findOne({code: req.query.promo_code});
			  console.log(promo_match);
			  
			  if (promo_match && parseInt(promo_match.entries) > 0){
				//proceed creating account
				req.query.promo_proceed = true;
				req.query.signup_reward = promo_match.signup_reward;
				req.query.referrer_reward = promo_match.referrer_reward;
				try{
					accountCreated = await claimAndCreateAccount(req);
					//only delegate if account created and delegation is enabled
					if (accountCreated && promo_match.delegation){
						delegationSuccess = await utils.delegateToAccount(req.query.new_account, spToDelegate, req.query.cur_bchain);
					}
					
					//decrease number of permitted entries
					//update current user's token balance & store to db
					promo_match.entries = parseInt(promo_match.entries) - 1;
					console.log('promo_match.entries:'+promo_match.entries);
					try{
						let trans = await db.collection('signup_promo_codes').save(promo_match);
						console.log('success updating pending entries');
					}catch(err){
						console.log(err);
						return;
					}
				}catch(e){
					console.log(e);
				}
				paymentReceivedTx = req.query.promo_code;
			  }
			  res.write(JSON.stringify({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated}));
			  res.end();
			}else{
			    req.query.promo_proceed = false;
			
				//first step is to ensure memo has not been tampered with, nor has it been claimed before
				//to do that, let's try to find if any signup has been done using this memo
				let memo_used = await db.collection('signup_transactions').findOne({memo: req.query.memo});
				//console.log('memo_used:'+memo_used);
				if (typeof memo_used == "undefined" || memo_used == null){
					//check on which blockchain transaction was sent based on currency
					let bchain = (req.query&&req.query.bchain?req.query.bchain:'');
					if (req.query.sent_cur){
						if (req.query.sent_cur == 'STEEM' || req.query.sent_cur == 'SBD'){
							bchain = 'STEEM';
						}else if (req.query.sent_cur == 'HIVE' || req.query.sent_cur == 'HBD'){
							bchain = 'HIVE';
						}
					}
					paymentReceivedTx = await utils.confirmPaymentReceived(req, bchain);
					console.log('>>>> got TX '+paymentReceivedTx);
					if (paymentReceivedTx != ''){
						req.query.confirming_tx = paymentReceivedTx;
						console.log(req.query);
						try{
							accountCreated = await claimAndCreateAccount(req);
							if (accountCreated){
								delegationSuccess = await utils.delegateToAccount(req.query.new_account, spToDelegate, req.query.bchain);
							}
						}catch(e){
							console.log(e);
						}
					}
				}
				//res.send({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated});
				res.write(JSON.stringify({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated}));
				res.end();
			}
		}catch(err){
			console.log(err);
		}
		//we're done, let's clear our running interval
		clearInterval(intID);
		
	}
});

/* core function for discounted account claims and creation */
claimAndCreateAccount = async function (req){
	let accountClaimed = false;
	let accountCreated = false;
	let results = '';
	try{
		results = await utils.getRC(config.account);
		console.log('Current RC: ' + utils.format(results.estimated_pct) + '% ');
		if (results.estimated_pct>50){
			//if we reached min threshold, claim more spots for discounted accounts
			accountClaimed = await utils.claimDiscountedAccount(req.query.cur_bchain);
		}
	}catch(err){
		console.log('error grabbing RC');
	}
	
	console.log('discounted account claimed:'+accountClaimed);
	//proceed creating account
	try{
		accountCreated = await proceedAccountCreation(req);
	}catch(err){
		console.log(err);
	}
	return accountCreated;

};

//grab account RC
app.get('/getRC', async function (req, res){
	let result = {};
	try{
		if (req.query && req.query.user){
			result = await utils.getNewRC(req.query.user, req.query.chain);
		}
	}catch(err){
		console.log(err);
	}
	res.send(result);
})

//send notification
app.get('/sendNotification', async function(req,res){
	let passed_var = eval("req.query."+config.verifyNotifParam);
	console.log('sendnotification');
	//console.log(passed_var);
	//make sure needed security var is passed, and with proper value
	if ((typeof passed_var == 'undefined') || passed_var != config.verifyNotifToken){
		console.log('missing');
		res.send('{}');
	}else{
		if (req.query.notifType == 'new_post'){
			//first notify post owner
			utils.sendNotification(db, req.query.user, req.query.actionTaker, req.query.notifType, 'post', 'You successfully created a new actifit report "' + req.query.title + '" ', 'https://actifit.io/'+req.query.user+'/'+req.query.permlink);
			
			//fetch user friends
			let friends = await getUserFriends(req.query.user);
			//send out a notification for each friend
			for (let i=0;i<friends.length;i++){
				utils.sendNotification(db, friends[i].friend, req.query.actionTaker, req.query.notifType, 'friendship', 'Your friend ' + req.query.user + ' created a new actifit report "' + req.query.title + '" ', 'https://actifit.io/'+req.query.user+'/'+req.query.permlink);
			}
			//res.send('{status: success}');
			//return;
		}else if (req.query.notifType == 'new_comment'){
			//console.log(req.query.permlink);
			utils.sendNotification(db, req.query.user, req.query.actionTaker, req.query.notifType, 'comment', 'User "'+req.query.actionTaker+'" left you a comment on your post "' + req.query.title + '" ', 'https://actifit.io/'+req.query.actionTaker+'/'+req.query.permlink);
		}else if (req.query.notifType == 'mention'){
			//console.log(req.query.permlink);
			utils.sendNotification(db, req.query.user, req.query.actionTaker, req.query.notifType, 'mention', 'User "'+req.query.actionTaker+'" has mentioned you.', 'https://actifit.io/'+req.query.actionTaker+'/'+req.query.permlink);
		}else{
			res.send('{error: not supported}');
			return;
		}
		//
		res.send('{status: success}');
	}
});


//query our unique user count across a range - default 30 days
app.get('/findUniqueUsers', async function(req,res){
	let passedDays = 30;
	if (req.query && req.query.days){
		if(isNaN(req.query.days)){
			res.send({})
		}
		try{
			passedDays = parseInt(req.query.days);
		}catch(excp){
			res.send({error: 'error'});
		}
	}
	//today is start date
	
	let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	//go back in date according to param
	
	let days = passedDays>30?30:passedDays;
	let endDate = moment(moment(startDate).utc().subtract(days, 'days').toDate()).format('YYYY-MM-DD');
	let transQuery = {
		date: {
				$gte: new Date(endDate)
			}
	}
	let postContent = await db.collection('verified_posts').distinct('author', transQuery);
	console.log(postContent.length);
	console.log(postContent);
	res.send({uniqueUserCount: postContent.length, dayRange: days});
	
});

//function handles storing verified actifit posts to add additional security measures they came through our API and to avoid json metadata modifications
app.get('/appendVerifiedPost', async function(req,res){
	var passed_var = eval("req.query."+config.verifyParam);
	//console.log(passed_var);
	//make sure needed security var is passed, and with proper value
	if ((typeof passed_var == 'undefined') || passed_var != config.verifyPostToken){
		res.send('{}');
	}else{
		let verified_post = {
			author: req.query.author,
			permlink: req.query.permlink,
			json_metadata: JSON.parse(req.query.json_metadata),
			date: new Date(),
		};
		try{
			let transaction = await db.collection('verified_posts').insert(verified_post);
			console.log('success inserting post data');
			res.send('{success}');
		}catch(err){
			console.log(err);
			res.send('{error inserting post data}');
		}
	}
});

//function handles checking and fetching a verified post
app.get('/fetchVerifiedPost', async function(req,res){
	//make sure we have both an author and permlink passed
	if ((typeof req.query.author == 'undefined') || req.query.author == '' ||
		(typeof req.query.permlink == 'undefined') || req.query.permlink == '') {
		res.send('{}');
	}else{
		try{
			let verified_post = await db.collection('verified_posts').findOne({author: req.query.author, permlink: req.query.permlink});
			console.log('found verified post');
			res.send(verified_post);
		}catch(err){
			console.log(err);
			res.send('{}');
		}
	}
});


/* end point for checking if user has funds pass */
app.get('/userHasFundsPassSet/:user', async function (req, res) {
	let query = {user: req.params.user};
	console.log(query);
	let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });
	console.log(entryFound);
	if (entryFound != null){
		res.send({'hasFundsPass': true, 'passVerified': entryFound.passVerified, 'date': entryFound.date});
	}else{
		res.send({'hasFundsPass': false});
	}
});

/* end point for setting a user's funds pass */
app.get('/setUserFundsPass/:user/:pass', async function (req, res) {
	let query = {user: req.params.user};
	console.log(query);
	let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });
	
	let proceed = true;
	//password can be set/replaced only if none exists, or its not verified already and has not been 10 mins since setting first attempt
	if (entryFound == null || 
		(!entryFound.passVerified)){
		if (entryFound != null){
		  
		  //checking last entry date 
		  var now = moment(new Date()); //todays date
		  var end = moment(entryFound.date); // last update date
		  var duration = moment.duration(now.diff(end));
		  var mins = duration.asMinutes();
		  console.log(mins);
		  if (mins < 10){
			  res.send({'error': 'You can only update your funds pass once every 10 minutes'});
			  proceed = false;
		  }
		}
		if (proceed){
		
		  //create encrypted version of the password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(req.params.pass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			
		  //store pass with unverified status
		  let new_pass_entry = {user: req.params.user, pass: encr_pass, passVerified: false, date: new Date()};
		  try{
		    let transaction = await db.collection('account_funds_pass')
				.replaceOne(query, new_pass_entry, { upsert: true });
		    res.send({'status': 'Success'});
		  }catch(e){
		    console.log(e);
		    res.send({'error': 'Error setting your funds password. Please contact us on discord if you wish to do so.'});
		  }
		}
	}else{
		res.send({'error': 'You cannot change your verified funds password. Please contact us on discord if you wish to do so.'});
	}
	
});



//function handles the process of confirming password verification receipt, and sets proper password status accordingly
app.get('/confirmPaymentPasswordVerify', async function(req,res){
	let paymentReceivedTx = '';
	let statusUpdated = false;
	//keeping request alive to avoid timeouts
	let intID = setInterval(function(){
		res.write(' ');
	},8000);
	try{
		let bchain = (req.query&&req.query.bchain?req.query.bchain:'HIVE');
		paymentReceivedTx = await utils.confirmPaymentReceivedPassword(req, bchain);
		console.log('>>>> got TX '+paymentReceivedTx);
		if (paymentReceivedTx != ''){
			try{
				//we found the transfer, now let's update the status properly
				let query = {user: req.query.from};
				console.log(query);
				let entryFound = await db.collection('account_funds_pass').findOne(query);
				console.log(entryFound);
				if (entryFound != null &&  
					(!entryFound.passVerified)){
					try{
					  //we need to set this transaction as processed via upvote
					  entryFound.passVerified = true;
					  let transaction = await db.collection('account_funds_pass').save(entryFound);
					  statusUpdated = true;
					  console.log('saved');
					}catch(e){
					  console.log(e);
					}
				}
			}catch(e){
				console.log(e);
			}
		}
	}catch(err){
		console.log(err);
	}
	//we're done, let's clear our running interval
	clearInterval(intID);
	//res.send({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated});
	res.write(JSON.stringify({'paymentReceivedTx': paymentReceivedTx, 'statusUpdated': statusUpdated}));
	res.end();
});


//function handles the process of confirming buy event for AFIT via STEEM
app.get('/confirmBuyAction', async function(req,res){
	let match_trx = '';
	let statusUpdated = false;
	//keeping request alive to avoid timeouts
	let intID = setInterval(function(){
		res.write(' ');
	},8000);
	try{
		let bchain = (req.query&&req.query.bchain?req.query.bchain:'');
		match_trx = await utils.confirmPaymentReceivedBuy(req, bchain);
		console.log('>>>> got TX '+match_trx);
		let targetUser = req.query.from;
		if (match_trx != ''){
			try{
				//we found the transfer, now let's book proper AFIT tokens for the user
				//query to see if entry already stored
				let tokenBuyTransQuery = {
					user: targetUser,
					buy_trx_ref: match_trx
				}
				//store the transaction to the user's profile
				let tokenBuyTrans = {
					user: targetUser,
					reward_activity: 'Buy AFIT Actifit.io',
					steem_spent: parseFloat(req.query.steem_amount),
					token_count: parseFloat(req.query.afit_amount),
					buy_trx_ref: match_trx,
					date: new Date(),
				}
				try{
					console.log(tokenBuyTrans);
					//insert the query ensuring we do not write it twice
					let transaction = await db.collection('token_transactions').update(tokenBuyTransQuery, tokenBuyTrans, { upsert: true });
					let trans_res = transaction.result;
					console.log(trans_res);
					/*console.log('nMatched:'+trans_res.nMatched);
					console.log('nUpserted:'+trans_res.upserted);
					console.log('nModified:'+trans_res.nModified);*/
					if (trans_res.upserted){
						//we have a new entry, increase user token count
						
						let user_info = await grabUserTokensFunc (targetUser);
						
						let cur_user_token_count = 0;
						if (user_info){
							cur_user_token_count = parseFloat(user_info.tokens);
							//update current user's token balance & store to db
							let afit_amount = parseFloat(req.query.afit_amount);
							let new_token_count = cur_user_token_count + parseFloat(afit_amount);
							user_info.tokens = new_token_count;
							console.log('new_token_count:'+new_token_count);
							try{
								let trans = await db.collection('user_tokens').save(user_info);
								console.log('success adding AFIT tokens to user balance');
							}catch(err){
								console.log(err);
								return;
							}
						}
					}else{
						//do nothing
					}
				}catch(err){
					console.log(err);
					res.write(JSON.stringify({'error': 'Error adding AFIT tokens to user balance'}));
					res.end();
					return;
				}
			}catch(e){
				console.log(e);
			}
		}
	}catch(err){
		console.log(err);
	}
	//we're done, let's clear our running interval
	clearInterval(intID);
	//res.send({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated});
	res.write(JSON.stringify({'paymentReceivedTx': match_trx}));
	res.end();
});



/* end point finding whether user has a pending AFIT token swap */
app.get('/userHasPendingTokenSwap/:user', async function(req, res){
	let user_pending_swap = await db.collection('exchange_afit_steem').findOne({user: req.params.user,upvote_processed: {$in: [null, false, 'false']}},{fields : { _id:0} });
	res.send({user_pending_swap: user_pending_swap});
});

/* end point finding user's historical AFIT token swap */
app.get('/getUserTokenSwapHistory/:user', async function(req, res){
	let user_token_swap_hist = await db.collection('exchange_afit_steem').find({user: req.params.user},{fields : { _id:0} }).sort({'date': -1}).toArray();
	res.send({userTokenSwapHist: user_token_swap_hist});
});

/* end point for getting number of AFIT -> STEEM upvotes pending exchanges */
app.get('/getPendingTokenSwapTransCount/', async function(req, res){
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: {$ne: true}}).sort({'date': 1}).toArray();
	res.send({pendingSwap: tokenSwapTrans.length});
});

/* end point for getting exchanges pending upvotes  */
app.get('/getPendingTokenSwapTrans/', async function(req, res){
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: {$ne: true}}).sort({'date': 1}).toArray();
	//generate total AFIT value as well
	let afit_count = 0;
	for (let i=0;i<tokenSwapTrans.length;i++){
		tokenSwapTrans[i].order = i+1;
		tokenSwapTrans[i].reward_round = Math.ceil((i+1)/config.max_afit_steem_upvotes_per_session);
		afit_count += +tokenSwapTrans[i].paid_afit
	}
	res.send({pendingTransactions: tokenSwapTrans, count: tokenSwapTrans.length, afit_tokens_pending: afit_count});
});

/* end point for getting exchanges processed upvotes  */
app.get('/getProcessedTokenSwapTrans/', async function(req, res){
	let maxLimit = 300;
	if (req.query.limit){
		maxLimit = req.query.limit;
	}
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: true}).sort({'date': -1}).limit(maxLimit).toArray();
	//generate total AFIT value as well
	let afit_count = 0;
	for (let i=0;i<tokenSwapTrans.length;i++){
		afit_count += +tokenSwapTrans[i].paid_afit
	}
	res.send({count: tokenSwapTrans.length, afit_tokens_exchanged: afit_count, pendingTransactions: tokenSwapTrans});
});

/* end point for getting exchanges pending upvotes  */
app.get('/getUnverifiedFundsAccountList/', async function(req, res){
	let pendingAccounts = await db.collection('account_funds_pass').find({passVerified: {$in: [null, false, 'false']}}, {fields : {pass:0, _id: 0}}).sort({'date': 1}).toArray();
	res.send({pendingAccounts: pendingAccounts, count: pendingAccounts.length});
});

/* end point for getting exchanges pending upvotes  */
app.get('/getFullFundsAccountList/', async function(req, res){
	let fullAccountList = await db.collection('account_funds_pass').find({}, {fields : {pass:0, _id: 0}}).sort({'date': 1}).toArray();
	res.send({fullAccountList: fullAccountList, count: fullAccountList.length});
});

/* end point handling storing transaction for AFIT/STEEM upvote exchange */
app.get('/performAfitSteemExchange', async function(req, res){
	if ((typeof req.query.user == 'undefined') || req.query.user == '' ||
		(typeof req.query.pass == 'undefined') || req.query.pass == '' ||
		(typeof req.query.tokens == 'undefined') || req.query.tokens == '') {
		//make sure all params are sent
		res.send({'error':'generic error'});
	}else{
		let user = req.query.user;
		let paid_tokens = req.query.tokens;
		//confirm matching funds password
		let query = {user: user};
		
		let entryFound = await db.collection('account_funds_pass').findOne(query, {fields : { _id:0} });

		if (entryFound == null){
			res.send({'error': 'Account does not have a recorded funds password'});
			return;
		}else if (!entryFound.passVerified){
			res.send({'error': 'Account\'s funds password not verified'});
			return;
		}else{
		  //create encrypted version of sent password
		  var cipher = crypto.createCipher(config.funds_encr_mode, config.funds_encr_key);
		  let encr_pass = cipher.update(req.query.pass, 'utf8', 'hex');
		  encr_pass += cipher.final('hex');
			if (entryFound.pass !== encr_pass){
				res.send({'error': 'Incorrect username and/or funds password'});
				return;
			}
		}
	
		//confirm proper AFIT token count. Test against our own minimum, and the request's minimum
		let user_info = await grabUserTokensFunc (user);
		console.log(user_info);
		let cur_user_token_count = parseFloat(user_info.tokens);
		if (cur_user_token_count < config.min_afit_for_steem_upvote || cur_user_token_count < paid_tokens){
			res.send({'error': 'Account does not have enough AFIT funds in wallet. Minimum required is '+config.min_afit_for_steem_upvote});
			return;
		}
		
		//check if user already has an unprocessed entry
		let user_pending_swap = await db.collection('exchange_afit_steem').findOne({user: user,upvote_processed: {$in: [null, false, 'false']}});
		if (user_pending_swap){
			res.send({'error': 'You already have a pending AFIT/STEEM upvote exchange. You can only request one per each reward cycle'});
			return;
		}
		
		//decrease count
		let tokenExchangeTrans = {
			user: user,
			reward_activity: 'Exchange AFIT To Upvote',
			token_count: -paid_tokens,
			date: new Date(),
		}
		try{
			console.log(tokenExchangeTrans);
			let transaction = await db.collection('token_transactions').insert(tokenExchangeTrans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error converting AFIT to STEEM upvotes'});
			return;
		}
		
		//store in pending AFIT/Upvote list
		let exchange_trans = {
			user: user,
			paid_afit: paid_tokens,
			upvote_processed: false,
			date: new Date(),
		}
		try{
			let transaction = await db.collection('exchange_afit_steem').insert(exchange_trans);
			console.log('success inserting post data');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error storing the exchange transaction to queue'});
			return;
		}
		
		//update current user's token balance & store to db
		let new_token_count = cur_user_token_count - parseFloat(paid_tokens);
		user_info.tokens = new_token_count;
		console.log('new_token_count:'+new_token_count);
		try{
			let trans = await db.collection('user_tokens').save(user_info);
			console.log('success updating user token count');
		}catch(err){
			console.log(err);
		}
		
		res.send({'status': 'Success'});
	}
})

/* end point handling cancelling outdated exchange transactions for AFIT/STEEM upvote exchange */
app.get('/cancelOutdatedAfitSteemExchange', async function(req, res){
	//grab list of pending & outdated exchange requests 
	let startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	let endDate = moment(moment(startDate).utc().subtract(config.exchange_refund_max_days, 'days').toDate()).format('YYYY-MM-DD');
	let transQuery = {
		upvote_processed: {$in: [null, false, 'false']},
		date: {
				$lte: new Date(endDate)
			}
	}
	let outdatedTokenSwapTrans = await db.collection('exchange_afit_steem').find(transQuery).toArray();
	console.log(outdatedTokenSwapTrans);
	
	let refundedCount = 0;
	
	//go through each transaction and cancel it
	for(let i = 0, transLen = outdatedTokenSwapTrans.length; i < transLen; i++) {
		try{
			//set as processed, and flag as refunded
			outdatedTokenSwapTrans[i].refunded = true;
			outdatedTokenSwapTrans[i].refund_reason = 'overdue for '+config.exchange_refund_max_days + ' days';
			outdatedTokenSwapTrans[i].upvote_processed = true;
			await db.collection('exchange_afit_steem').save(outdatedTokenSwapTrans[i]);
			console.log('exchange transaction cancelled');
		}catch(err){
			console.log('unable to cancel exchange transaction');
			res.send({'error': 'Unable to cancel exchange transaction'});
			return;
		}
		
		//send out refunded AFIT tokens
		//decrease count
		let tokenExchangeTrans = {
			user: outdatedTokenSwapTrans[i].user,
			reward_activity: 'Refund Exchange AFIT To Upvote',
			token_count: outdatedTokenSwapTrans[i].paid_afit,
			note: 'Refund Exchange AFIT To Upvote due to overdue pending '+config.exchange_refund_max_days + ' days without Actifit report card',
			date: new Date(),
		}
		try{
			console.log(tokenExchangeTrans);
			let transaction = await db.collection('token_transactions').insert(tokenExchangeTrans);
			console.log('tokens refunded for user');
		}catch(err){
			console.log(err);
			res.send({'error': 'Error converting AFIT to STEEM upvotes'});
			return;
		}
		
		let user_info = await grabUserTokensFunc (outdatedTokenSwapTrans[i].user);
		console.log(user_info);
		let cur_user_token_count = 0;
		if (user_info){
			cur_user_token_count = parseFloat(user_info.tokens);
			//update current user's token balance & store to db
			let new_token_count = cur_user_token_count + parseFloat(outdatedTokenSwapTrans[i].paid_afit);
			user_info.tokens = new_token_count;
			console.log('new_token_count:'+new_token_count);
			try{
				let trans = await db.collection('user_tokens').save(user_info);
				console.log('success updating user token count');
			}catch(err){
				console.log(err);
				return;
			}
		}
		
		refundedCount += 1;
	}
	//we got here, we're good
	res.send({'status': 'Success', 'trans_refunded_count': refundedCount});
});

/* end point handling the display of categorized token holders */
app.get('/fetchTokenHoldersByCategory', async function(req, res){
	//connect to DB, and identify token holders by category
	await db.collection('user_tokens').aggregate([
	{
	  $project: {    
		"range": {
		   $concat: [
			  { $cond: [{$lt: ["$tokens",1]}, "< 1 AFIT", ""]}, 
			  { $cond: [{$and:[ {$gte:["$tokens", 1 ]}, {$lt: ["$tokens", 11]}]}, "1 - 10 AFIT", ""] },
			  { $cond: [{$and:[ {$gte:["$tokens",11]}, {$lt:["$tokens", 101]}]}, "11 - 100 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",101]}, {$lt:["$tokens", 1001]}]}, "101 - 1,000 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",1001]}, {$lt:["$tokens", 10001]}]}, "1,001 - 10,000 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",10001]}, {$lt:["$tokens", 50001]}]}, "10,001 - 50,000 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",50001]}, {$lt:["$tokens", 100001]}]}, "50,001 - 100,000 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",100001]}, {$lt:["$tokens", 500001]}]}, "100,001 - 500,000 AFIT", ""]},
			  { $cond: [{$and:[ {$gte:["$tokens",500001]}, {$lt:["$tokens", 1000001]}]}, "500,001 - 1,000,000 AFIT", ""]},
			  { $cond: [{$gte:["$tokens",1000001]}, "> 1,000,000 AFIT", ""]}
		   ]
		}  
	  }    
	},
	{
	  $group: { 
		"_id" : "$range", 
		count: { 
		  $sum: 1
		} 
	  }
	},
	{
	  $sort: {
		"count": -1,
	  }
	}
	]).toArray(function(err, results) {
	  if (req.query.pretty==1){
		let output = '|Category|Count|<br/>';
		output += '|---|---|<br/>';
	    for (let entry of results) {
			output += '|' + entry._id + '|' + entry.count + '<br/>';
		}
		res.send(output);
	  }else{
	    res.send(results);
	  }
    });

});


/* end point handling additional reward to user votes via web */
app.get('/rewardActifitWebVote/:user', async function(req,res){
	if (req.query.web_vote_token != config.actifitWebVoteToken){
		res.send('{}');
	}else{
		let reward_activity = 'Web Vote';
		let rewarded = await rewardActifitTokenWeb(req, reward_activity);
		res.send({'rewarded':rewarded, amount: config.actifitWebVoteRewardAmount});
	}
});

/* end point handling rewarding web edits */
app.get('/rewardActifitWebEdit/:user', async function(req,res){
	if (req.query.web_edit_token != config.actifitWebEditToken){
		res.send('{}');
	}else{
		let reward_activity = 'Web Edit';
		let rewarded = await rewardActifitTokenWeb(req, reward_activity);
		res.send({'rewarded':rewarded, amount: config.actifitWebEditRewardAmount});
	}
});

/* end point handling additional reward to user comments via web */
app.get('/rewardActifitWebComment/:user', async function(req,res){
	if (req.query.web_comment_token != config.actifitWebCommentToken){
		res.send('{}');
	}else{
		let reward_activity = 'Web Comment';
		let rewarded = await rewardActifitTokenWeb(req, reward_activity);
		res.send({'rewarded':rewarded, amount: config.actifitWebCommentRewardAmount});
	}
});


/* core function handling user rewards for various web related activities */
rewardActifitTokenWeb = async function (req, reward_activity) {
	//store outcome 
	let rewarded = false;
	
	//make sure we have user and url params set
	if (req.params.user && typeof req.query.url!= "undefined" && req.query.url!=null) {
	  try{
		//let's reward this user for performing an edit using our web interface
		let reward_date = new Date();
		
		//only one reward per day, disregard time
		reward_date.setHours(0,0,0,0);
		
		let new_transaction = {
			user: req.params.user,
			reward_activity: reward_activity,
			token_count: parseFloat(config.actifitWebEditRewardAmount),
			date: new Date(),
			reward_date: reward_date,
			url: req.query.url,
		}
		
		//make sure we're not double rewarding user. New url edits override older ones on same date
		let query = { 
			user: req.params.user,
			reward_activity: reward_activity,
			reward_date: reward_date,
		};
		
		//check if we have a match already to skip rewarding and/or notifying the user
		let user_pre_rewarded = await db.collection('token_transactions').findOne(query);
		if (typeof user_pre_rewarded == undefined || user_pre_rewarded == 'undefined' || user_pre_rewarded == null){
		  console.log('first reward today');
		  try{
		    let transaction = db.collection('token_transactions')
				.replaceOne(query, new_transaction, { upsert: true });
		    rewarded = true;
		  }catch(e){
		    console.log(e);
		  }
		}
		console.log(rewarded);
		
	  }catch(err){
		console.log(err);
	  }
	}
	
	return rewarded;
}


/* end point for returning total post count on a specific date */
app.get('/recentVerifiedPosts', async function(req, res) {
	
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	var endDate = moment(moment(startDate).utc().add(2, 'days').toDate()).format('YYYY-MM-DD');
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	let maxCount = 100;
	if (req.query.maxCount && !isNaN(req.query.maxCount)){
		maxCount = parseInt(req.query.maxCount);
	}
	
	
	
	//fetch banned accounts
	let banned_users = await db.collection('banned_accounts').find({ban_status:"active"}, {fields : { user: 1, _id: 0 } }).toArray();
	
	//console.log(banned_users);
	let banned_arr = banned_users.map(entr => entr.user);
	
	//exclude current user from fetched data
	if (req.query.exclude){
		banned_arr.push(req.query.exclude);
	}
	
	banned_arr.push('');
	//console.log(banned_arr);
	
	await db.collection('verified_posts').aggregate([
		{$match: 
			{
				date: {
					$lte: new Date(endDate),
					$gt: new Date(startDate)
				},
				author: {
					$nin: banned_arr,
				}
			},
		},
		{$sort:
			{
				date:1
			},
		},
		{$group:
			{
			   _id: '$author',
			}
		}
	   ]).limit(maxCount).toArray(function(err, results) {
		//also append total token count to the grouped display
		console.log(results.length);
		res.send(results);
	   });

});

/* end point for returning total post count on a specific date */
app.get('/recentAuthorsData', async function(req, res) {
	
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	var endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
	let maxCount = 10;
	if (req.query.maxCount && !isNaN(req.query.maxCount)){
		maxCount = parseInt(req.query.maxCount);
	}
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	await db.collection('verified_posts').aggregate([
		{
			$match: 
			{
				"date": {
					"$lte": new Date(endDate),
					"$gt": new Date(startDate)
				}
			}
		}
	   ]).toArray(async function(err, results) {
		//also append total token count to the grouped display
		console.log(results.length);
		results = results.reverse();
		let finalSet = [];
		if (!req.params){
			req.params = new Object();
		}
		for (let i=0;i < maxCount;i++){
			req.params.user = results[i].author;	
			let rank = await calcRank (req, res);
			console.log(results[i].author);
			console.log(rank);
			finalSet.push({'author': results[i].author, 'rank': rank});
		}
		res.send(finalSet);
		
	   });

});

/* end point for returning total post count on a specific date */
app.get('/totalPostsSubmitted', async function(req, res) {
	
	var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
	if (req.query.targetDate){
		startDate = moment(moment(req.query.targetDate).utc().startOf('date').toDate()).format('YYYY-MM-DD');
	}
	var endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
	console.log("startDate:"+startDate+" endDate:"+endDate);
	
	await db.collection('verified_posts').aggregate([
		{
			$match: 
			{
				"date": {
					"$lte": new Date(endDate),
					"$gt": new Date(startDate)
				}
			}
		}
	   ]).toArray(function(err, results) {
		//also append total token count to the grouped display
		console.log(results.length);
		res.send({count:results.length});
	   });

});

/* end point for fetching user's recorded metrics */
app.get('/trackedMeasurements/:user', async function(req, res) {
	let query = {"author": req.params.user,
					$or: [
						{ "json_metadata.weight": {$exists: true} },
						{ "json_metadata.height": {$exists: true} },
						{ "json_metadata.chest": {$exists: true} },
						{ "json_metadata.waist": {$exists: true} },
						{ "json_metadata.thighs": {$exists: true} },
						{ "json_metadata.bodyfat": {$exists: true} }
					]
				}
	posts = await db.collection('verified_posts').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	res.send(posts);
});



/* end point for fetching user's recorded activity records */
app.get('/trackedActivity/:user', async function(req, res) {
	let query = {"author": req.params.user,
				}
	posts = await db.collection('verified_posts').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	res.send(posts);
});



function gk_add_commas(nStr) {
	if (isNaN(nStr)){ 
		return nStr;
	}
	nStr += '';
	var x = nStr.split('.');
	var x1 = x[0];
	var x2 = x.length > 1 ? '.' + x[1] : '';
	var rgx = /(\d+)(\d{3})/;
	while (rgx.test(x1)) {
		x1 = x1.replace(rgx, '$1' + ',' + '$2');
	}
	return x1 + x2;
}	

let srvr = app.listen(appPort);
srvr.setTimeout(120000);
