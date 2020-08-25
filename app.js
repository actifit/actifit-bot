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

// Connection URL
let url = config.mongo_uri;
if (config.testing){
	url = config.mongo_local;
}

var db;
var collection;
// Database Name
const db_name = config.db_name;
const collection_name = 'user_tokens';


// Use connect method to connect to the server
MongoClient.connect(url, function(err, client) {
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
	  
	} else {
		utils.log(err, 'api');
	}
  
});

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

let usersAFITXBal = [];
let usersAFITXBalHE = [];
let fullSortedAFITXList = [];
//initial fetch
fetchAFITXBal(0);
  
//fetch new AFITX user account balance every 5 mins
let scJob = schedule.scheduleJob('*/5 * * * *', async function(){
  //reset array
  //usersAFITXBal = [];
  fetchAFITXBal(0);
  
  //only run cleanup on secondary thread to avoid duplication of effort and collision
  if (process.env.BOT_THREAD == 'SECOND_API'){
	disableUserLogin();
  }
});

//allows setting acceptable origins to be included across all function calls
app.use(function(req, res, next) {
  var allowedOrigins = ['*', 'https://actifit.io', 'http://localhost:3000'];
  var origin = req.headers.origin;
  if(allowedOrigins.indexOf(origin) > -1){
	   res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type, x-acti-token');
  return next();
});

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

async function loadExchAfitPrice(){
	try{
		console.log('loading AFIT exchange prices');
		let afitSEPrice = await ssc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);
		
		let afitHEPrice = await hsc.find('market', 'metrics', {symbol : 'AFIT' }, 1000, 0, '', false);
		
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
	}else{
		//done with AFITX SE, proceed with AFITX HE
		fetchAFITXBalHE(0);
	}
  }
  }catch(err){
	  console.log(err);
	  if (offset == 0){
		console.log('no AFITX data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBal(0);
		}, 30000);
	  }
  }
  //console.log(usersAFITXBal);
}

async function fetchAFITXBalHE(offset){
  try{
  console.log('--- Fetch new AFITX token balance ---');
  console.log(offset);
  let tempArr = await hsc.find('tokens', 'balances', { symbol : 'AFITX' }, 1000, offset, '', false) //max amount, offset,
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
	let ind = fullSortedAFITXList.findIndex(v => v.account == user)
	let entry = fullSortedAFITXList.find(v => v.account == user)
	return {ind: ind, entry: entry}
}

/* function handles calculating and returning user token count */
grabUserTokensFunc = async function (username){
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

  
app.get('/votingStatus', async function (req, res) {
	let votingStatus = await db.collection('voting_status').findOne({});
	accountQueries += 1;
	if (accountQueries > 10){
		accountQueries = 0;
		accountRefresh = true;
	}
	let bchain = (req.query&&req.query.bchain?req.query.bchain:'');
	//fetch anew account data if account is empty or we need to refresh account data
	if (!account || accountRefresh){
		console.log('refreshing account data');
		account = await utils.getAccountData(config.account, bchain);
		accountRefresh = false;
	}
	let vp_res = await utils.getVotingPower(account);
	
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
			let user_tkn = await db_col.findOne({user: user, token: req.query.token});
			//console.log(user_tkn);
			if (!user_tkn || !user_tkn.ppkey){
				console.error('Authentication failed. Key not found');
				res.send({error: 'Authentication failed. Key not found'});
				return;
			}
			req.ppkey = user_tkn.ppkey;
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
	/*console.log(user);
	console.log(operation);
	console.log((typeof operation));
	console.log(match_arr);
	console.log(match_arr[0][1]);*/
	
	//perform transaction
	let performTrx = await utils.processSteemTrx(match_arr[0][1], userKey, bchain);
	console.log(performTrx);
	if (!performTrx.tx.block_num){
		res.send({error: true, trx: performTrx});
	}else{
		res.send({success: true, trx: performTrx});
	}
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
	/*console.log(user);
	console.log(operation);
	console.log((typeof operation));
	console.log(match_arr);
	console.log(match_arr[0][1]);*/
	
	//perform transaction
	let performTrx = await utils.processSteemTrx(match_arr[0][1], userKey, bchain);
	console.log(performTrx);
	if (!performTrx.tx.block_num){
		res.send({error: true, trx: performTrx});
	}else{
		res.send({success: true, trx: performTrx});
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


app.get('/resetLogin', checkHdrs, async function (req, res) {
	let db_col = db.collection('user_login_token');
	let result = await db_col.remove({user: req.query.user, token: req.query.token});
	res.send({success: true});
});

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
	let user = await grabUserTokensFunc(req.params.user);
    res.send(user);
});

/* end point for user transactions display (per user or general actifit token transactions, limited by 1000) */
app.get('/transactions/:user?', async function (req, res) {
	let query = {};
	var transactions;
	if(req.params.user){
		query = {user: req.params.user}
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(1000).toArray();
	}else{
		//only limit returned transactions in case this is a general query
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(1000).toArray();
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
	if (req.query.type){
		proceed = true;
		query = {reward_activity: req.query.type}
		
	}
	if (req.query.datesort){
		dateSort = parseInt(req.query.datesort)
		
	}
	let startDate = '';
	let endDate = '';
	if (req.query.startDate){
		startDate = moment(moment(req.query.startDate).utc().startOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	}
	if (req.query.endDate){
		//let endDate = moment(moment(startDate).utc().add(1, 'days').toDate()).format('YYYY-MM-DD');
		endDate = moment(moment(req.query.endDate).utc().endOf('date').add(1, 'days').toDate()).format('YYYY-MM-DD');
	}
	if (startDate && endDate){
		query["date"] = {
					"$lt": new Date(endDate),
					"$gte": new Date(startDate)
				};
	}else if (startDate){
		query["date"] = {
					"$gte": new Date(startDate)
				};
	}
	console.log(query);
	if (proceed){
		transactions = await db.collection('token_transactions').find(query).sort({date: dateSort}).limit(1000).toArray();
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
		}
		
		collection = db.collection('team_transactions');
		let modTransRes = await collection.insert(modTrans);
		console.log(modTransRes)
		
		res.send(result);
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

/* end point for fetching user's friends */
app.get('/userFriends/:user', async function (req, res) {
	let friendsA = await db.collection('friends').find({userA: req.params.user}, {fields : {userB:1, _id:0}}).toArray();
	let friendsB = await db.collection('friends').find({userB: req.params.user}, {fields : {userA:1, _id:0}}).toArray();
	console.log(friendsA);
	console.log(friendsB);
	friendsA = JSON.parse(JSON.stringify(friendsA).replace(/userB/g,'friend'));
	friendsB = JSON.parse(JSON.stringify(friendsB).replace(/userA/g,'friend'));
	res.send(friendsA.concat(friendsB));
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

/* end point for tracking gadget buy orders */
app.get('/buyGadgetHive/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {
	
	let user = req.params.user;
	let product_id = req.params.gadget;
	
	//fetch product info
	let product = await grabProductInfo (product_id);
	if (!product){
		res.send({'error': 'Product not found'});
		return;
	}
	
	//check if query has already been verified
	let matchingEntries = await db.collection('gadget_transactions_hive').find(
		{
			blockNo: req.params.blockNo,
			trxID: req.params.trxID,
			bchain: req.params.bchain
		}).toArray();
	
	if (Array.isArray(matchingEntries) && matchingEntries.length > 0){
		res.send({'error': 'Transaction already verified'});
		return;
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
	let ver_trx = await utils.verifyGadgetPayTransaction(req.params.user, req.params.gadget, item_price, item_price_alt, 'buy-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx || !ver_trx.success){
		res.send({status: 'error'});
		return;
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
		blockNo: req.params.blockNo,
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
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
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
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
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
	
	
	res.send({'status': 'Success'});
});


/* end point for tracking multi-gadget buy orders */
app.get('/buyMultiGadgetHive/:user/:gadgets/:blockNo/:trxID/:bchain', async function (req, res) {
	
	let user = req.params.user;
	let product_ids = req.params.gadgets.split('-');
	
	let products_tot_price_afit = 0;
	let products_tot_hive_price = 0;
	let products_tot_hive_price_alt = 0;
	for (let i=0;i<product_ids.length;i++){
		//fetch product info
		let product = await grabProductInfo (product_ids[i]);
		if (!product){
			res.send({'error': 'Product not found'});
			return;
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
		res.send({'error': 'Transaction already verified'});
		return;
	}
	
	
	//round down number
	console.log('Before rounding');
	console.log(products_tot_hive_price);
	products_tot_hive_price = (Math.floor(products_tot_hive_price * 1000) - 1) / 1000;
	console.log('After rounding');
	console.log(products_tot_hive_price);
	
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetPayTransaction(req.params.user, req.params.gadgets, products_tot_hive_price, products_tot_hive_price_alt, 'buy-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx || !ver_trx.success){
		res.send({status: 'error'});
		return;
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
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
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
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
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
	
	res.send({'status': 'Success'});
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

/* end point for tracking multi gadget buy orders */
app.get('/buyMultiGadget/:user/:gadgets/:blockNo/:trxID/:bchain', async function (req, res) {

	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(req.params.user, req.params.gadgets, 'buy-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
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
			res.send({'error': 'Product not found'});
			return;
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
			res.send({'error': 'Account does not have enough AFIT funds'});
			return;
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
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
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
			res.send({'error': 'Error performing buy action. DB storing issue'});
			return;
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
	
	res.send({'status': 'Success', 'user_tokens': user_info.tokens});
});

/* end point for tracking gadget buy orders */
app.get('/buyGadget/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {

	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(req.params.user, req.params.gadget, 'buy-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	
	//confirmed, register transaction and deduct AFIT tokens
	
	let user = req.params.user;
	let product_id = req.params.gadget;
	
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
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
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
		res.send({'error': 'Error performing buy action. DB storing issue'});
		return;
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
	
	res.send({'status': 'Success', 'user_tokens': user_info.tokens});
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
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'add-friend-request', req.params.blockNo, req.params.trxID, req.params.bchain);
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
		utils.sendNotification(db, req.params.userB, req.params.userA, 'friendship_request', 'User ' + req.params.userA + ' has sent you a friendship request', 'https://actifit.io/'+req.params.userA);
	
		res.send({status: 'success'});
	}catch(err){
		console.log('error');
		res.send({status: 'error'});
	}	

});


/* end point for cancelling friend request */
app.get('/cancelFriendRequest/:userA/:userB/:blockNo/:trxID/:bchain', async function (req, res) {
	//ensure proper transaction
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'cancel-friend-request', req.params.blockNo, req.params.trxID, req.params.bchain);
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
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'accept-friendship', req.params.blockNo, req.params.trxID, req.params.bchain);
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
		utils.sendNotification(db, req.params.userB, req.params.userA, 'friendship_acceptance', 'User ' + req.params.userA + ' has accepted your friendship request', 'https://actifit.io/'+req.params.userA);
		
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
	let ver_trx = await utils.verifyFriendTransaction(req.params.userA, req.params.userB, 'cancel-friendship', req.params.blockNo, req.params.trxID, req.params.bchain);
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
		let bal = await ssc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' });
		let bal_he = await hsc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' });
		
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
		
		//make sure user has at least 0.1 AFITX to move tokens
		if (tot_afitx_bal < 0.1){
			res.send({'error': 'You do not have enough AFITX to move AFIT tokens over.'});
			return;
		}
		  //console.log(amount_to_powerdown);
		  //console.log(this.afitx_se_balance);
		  //calculate amount that can be transferred daily
		if (amount / 100 > tot_afitx_bal){
			res.send({'error': 'You do not have enough AFITX to move '+amount+ ' AFIT'});
			return;
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
			min_afitx: amount / 100,
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
		utils.sendNotification(db, targetUser, user, 'tip_notification', 'User ' + user + ' has sent you a tip of '+ amount +' AFIT', 'https://actifit.io/'+user);
		
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
	var afit_token_rules = [
		[9,0],
		[999,0.10],
		[4999,0.20],
		[9999,0.30],
		[19999,0.40],
		[49999,0.50],
		[99999,0.60],
		[499999,0.70],
		[999999,0.80],
		[4999999,0.90],
		[5000000,1]
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
	if (userTokens != null){
		afit_tokens_score = utils.calcScore(afit_token_rules, config.afit_token_factor, parseFloat(userTokens.tokens));
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
	
	if (userHasAFITX){
		user_rank_afitx = (parseFloat(userHasAFITX.balance) / 10).toFixed(2);
		//max increase by holding AFITX is 100
		if (user_rank_afitx > 100){
			user_rank_afitx = 100;
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
		recent_posts_score:recent_posts_score
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
	let curAFITPrice = await db.collection('afit_price').find().sort({'date': -1}).limit(1).next();
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

//function handles the process of confirming AFITX S-E receipt into proper account, and then duplicating to new exchange
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
	console.log('gadgetBought');
	console.log(req.query);
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
  console.log(gadget_match);
  res.send(gadget_match);
});


app.get("/gadgetBought", async function(req, res) {
	console.log('gadgetBought');
	console.log(req.query);
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
  
  console.log(gadget_match);
  
  //let token_match = await matchProductTrans(user, gadget_id);
  
  res.send(gadget_match);
});


//end point handles activating a bought gadget
app.get('/activateMultiGadget/:user/:gadgets/:blockNo/:trxID/:bchain/:benefic?', async function (req, res) {
	let user = req.params.user;
	let gadgets = req.params.gadgets
	
	//make sure friend and user are different
	if (req.params.benefic && req.params.benefic.replace('@','') == user){
		res.send({'error': 'User & friend cannot be the same account'});
		return;
	}
	
	console.log('activateGadget');
	let ver_trx = await utils.verifyGadgetTransaction(user, gadgets, 'activate-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	console.log(ver_trx);
	//ensure proper transaction
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	
	let gadget_entries = req.params.gadgets.split('-');
	
	for (let i=0;i<gadget_entries.length;i++){
		//find item to activate and proceed activating
		let gadget = new ObjectId(gadget_entries[i]);
		let gadget_match = await db.collection('user_gadgets').findOne({ user: user, gadget: gadget, status: "bought" });
		if (gadget_match){
			gadget_match.status="active";
			if (req.params.benefic){
				gadget_match.benefic = req.params.benefic;
				
				//also send notification to the beneficiary about being set for this gadget
				utils.sendNotification(db, req.params.benefic.replace('@',''), user, 'gadget_beneficiary', 'User ' + user + ' has set you as reward beneficiary for one of their gadgets!', 'https://actifit.io/'+user);
			}
			db.collection('user_gadgets').save(gadget_match);
			res.send({'status': 'success'});
		}else{
			res.send({'error': 'Product not found'});
			
		}
	}
});


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
	let ver_trx = await utils.verifyGadgetTransaction(user, gadget, 'activate-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
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
			utils.sendNotification(db, req.params.benefic.replace('@',''), user, 'gadget_beneficiary', 'User ' + user + ' has set you as reward beneficiary for one of their gadgets!', 'https://actifit.io/'+user);
		}
		db.collection('user_gadgets').save(gadget_match);
		res.send({'status': 'success'});
	}else{
		res.send({'error': 'Product not found'});
		
	}
});

//end point handles deactivating a bought gadget
app.get('/deactivateGadget/:user/:gadget/:blockNo/:trxID/:bchain', async function (req, res) {
	let user = req.params.user;
	let gadget = req.params.gadget;
	
	//ensure proper transaction
	let ver_trx = await utils.verifyGadgetTransaction(user, gadget, 'deactivate-gadget', req.params.blockNo, req.params.trxID, req.params.bchain);
	if (!ver_trx){
		res.send({status: 'error'});
		return;
	}
	
	//find item to activate and proceed activating
	gadget = new ObjectId(gadget);
	let gadget_match = await db.collection('user_gadgets').findOne({ user: user, gadget: gadget, status: "active" });
	if (gadget_match){
		gadget_match.status="bought";
		db.collection('user_gadgets').save(gadget_match);
		res.send({'status': 'success'});
	}else{
		res.send({'error': 'Product not found'});
		
	}
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
  
  let token_match = await db.collection('user_product_key').findOne({user: user, access_token: access_token});
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
	//if (req.query.confirm_payment_token != config.confirmPaymentToken){
	if (false){
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
				console.log('memo_used:'+memo_used);
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
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: {$in: [null, false, 'false']}}).sort({'date': 1}).toArray();
	res.send({pendingSwap: tokenSwapTrans.length});
});

/* end point for getting exchanges pending upvotes  */
app.get('/getPendingTokenSwapTrans/', async function(req, res){
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: {$in: [null, false, 'false']}}).sort({'date': 1}).toArray();
	//generate total AFIT value as well
	let afit_count = 0;
	for (let i=0;i<tokenSwapTrans.length;i++){
		tokenSwapTrans[i].order = i+1;
		tokenSwapTrans[i].reward_round = Math.ceil((i+1)/config.max_afit_steem_upvotes_per_session);
		afit_count += +tokenSwapTrans[i].paid_afit
	}
	res.send({pendingTransactions: tokenSwapTrans, count: tokenSwapTrans.length, afit_tokens_pending: afit_count});
});

/* end point for getting exchanges pending upvotes  */
app.get('/getProcessedTokenSwapTrans/', async function(req, res){
	let tokenSwapTrans = await db.collection('exchange_afit_steem').find({upvote_processed: {$in: [true, 'true']}}).sort({'date': 1}).toArray();
	//generate total AFIT value as well
	let afit_count = 0;
	for (let i=0;i<tokenSwapTrans.length;i++){
		afit_count += +tokenSwapTrans[i].paid_afit
	}
	res.send({pendingTransactions: tokenSwapTrans, count: tokenSwapTrans.length, afit_tokens_exchanged: afit_count});
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
			reward_activity: 'Exchange AFIT To STEEM Upvote',
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
			reward_activity: 'Refund Exchange AFIT To STEEM Upvote',
			token_count: outdatedTokenSwapTrans[i].paid_afit,
			note: 'Refund Exchange AFIT To STEEM Upvote due to overdue pending '+config.exchange_refund_max_days + ' days without Actifit report card',
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

app.listen(appPort);
