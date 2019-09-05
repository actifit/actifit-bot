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

	  // Get the documents collection
	  collection = db.collection(collection_name);
	} else {
		utils.log(err, 'api');
	}
  
});

let schedule = require('node-schedule')

const SSC = require('sscjs');
const ssc = new SSC(config.steem_engine_rpc);

let rule = new schedule.RecurrenceRule();

let usersAFITXBal = [];
let fullSortedAFITXList = [];
//initial fetch
fetchAFITXBal(0);
  
//fetch new AFITX user account balance every 5 mins
let scJob = schedule.scheduleJob('*/5 * * * *', async function(){
  //reset array
  //usersAFITXBal = [];
  fetchAFITXBal(0);
});

//allows setting acceptable origins to be included across all function calls
app.use(function(req, res, next) {
  var allowedOrigins = ['*', 'https://actifit.io', 'http://localhost:3000'];
  var origin = req.headers.origin;
  if(allowedOrigins.indexOf(origin) > -1){
	   res.setHeader('Access-Control-Allow-Origin', origin);
  }
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
	if (offset == 0){
		console.log('no AFITX data, fetch again in 30 secs');
		setTimeout(function(){
			fetchAFITXBal(0);
		}, 30000);
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

async function getAFITXUserData(user){
	let ind = fullSortedAFITXList.findIndex(v => v.account == user)
	let entry = fullSortedAFITXList.find(v => v.account == user)
	return {ind: ind, entry: entry}
}

/* function handles calculating and returning user token count */
grabUserTokensFunc = async function (username){
	let user = await collection.findOne({_id: username});
	console.log(user);
	//fixing token amount display for 3 digits
	if (typeof user!= "undefined" && user!=null){
		if (typeof user.tokens!= "undefined"){
			user.tokens = user.tokens.toFixed(3)
		}
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
  
  
app.get('/votingStatus', async function (req, res) {
	let votingStatus = await db.collection('voting_status').findOne({});
	res.send(votingStatus);
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

/* end point for transactions display by type (limited by 1000) */
app.get('/transactionsByType/', async function (req, res) {
	let query = {};
	let transactions = {};
	let proceed = false;
	if (req.query.type){
		proceed = true;
		query = {reward_activity: req.query.type}
		
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
		transactions = await db.collection('token_transactions').find(query).sort({date: 1}).limit(1000).toArray();
	}
    res.send(transactions);
});

/* end point for user referrals display (per user or general referrals */
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
	var delegatorList; 
	if (isNaN(req.query.count)){
		delegatorList = await db.collection('active_delegations').find().sort({steem_power: -1}).toArray();
	}else{
		delegatorList = await db.collection('active_delegations').find().sort({steem_power: -1}).limit(parseInt(req.query.count)).toArray();
	}
    res.send(delegatorList);
});

activeDelegationFunc = async function (userName){
	let user = await db.collection('active_delegations').findOne({_id: userName}, {fields : { _id:0} });
	console.log(user);
	return user;
}

/* end point for returning a single user last recorded active delegation amount */
app.get('/delegation/:user', async function (req, res) {
	var user = await activeDelegationFunc(req.params.user);
    res.send(user);
});

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
	if (isNaN(req.query.count)){
		tokenHolders = await db.collection('user_tokens').find().sort({tokens: -1}).toArray();
	}else{
		tokenHolders = await db.collection('user_tokens').find().sort({tokens: -1}).limit(parseInt(req.query.count)).toArray();
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
	let poweringDown = await db.collection('powering_down').findOne({user: req.params.user});
    console.log (poweringDown)
	if (!poweringDown){
		res.send({});
	}else{
		res.send(poweringDown);
	}
});

/* end point for returning the list of users powering down AFIT*/
app.get('/poweringDownList/', async function (req, res) {
	let poweringDown = await db.collection('powering_down').find().toArray();
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
			let result = await db.collection('powering_down').remove({user: req.query.user});
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
		let afitx_se_balance = 0;
		//confirm amount within AFITX conditions
		let bal = await ssc.findOne('tokens', 'balances', { account: user, symbol: 'AFITX' });
		if (bal){
			afitx_se_balance = bal.balance;
		}else{
			res.send({'error': 'Unable to fetch AFITX Funds. Try again later.'});
			return;
		}
		
		//make sure user has at least 0.1 AFITX to move tokens
		if (afitx_se_balance < 0.1){
			res.send({'error': 'You do not have enough AFITX to move AFIT tokens over.'});
			return;
		}
		  //console.log(amount_to_powerdown);
		  //console.log(this.afitx_se_balance);
		  //calculate amount that can be transferred daily
		if (amount / 100 > afitx_se_balance){
			res.send({'error': 'You do not have enough AFITX to move '+afitx_se_balance+ ' AFIT'});
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
			let transaction = await db.collection('powering_down').update(tokenPowerDownQuery, tokenPowerDownTrans, { upsert: true });
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

/* end point for getting current user's Actifit rank */
app.get('/getRank/:user', async function (req, res) {
	
	if (typeof req.params.user!= "undefined" && req.params.user!=null){
	
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
			return post_details.token_count;
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
	accountCreated = await utils.createAccount(req.query.new_account, req.query.new_pass);
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
	let url = new URL(config.steem_engine_trans_acct_his_lrg);
	//console.log(config.steem_engine_trans_acct_his_lrg);
	//connect with our service to confirm AFIT received to proper wallet
	try{
		let se_connector = await fetch(url);
		let trx_entries = await se_connector.json();
		
		
		//console.log(trx_entries);
		trx_entries.forEach( async function(entry){
			console.log(entry);
			let user = entry.from;
			//query to see if entry already stored
			let tokenExchangeTransQuery = {
				user: user,
				se_trx_ref: entry.txid
			}
			//store the transaction to the user's profile
			let tokenExchangeTrans = {
				user: user,
				reward_activity: 'Move AFIT SE to Actifit Wallet',
				token_count: parseFloat(entry.quantity),
				se_trx_ref: entry.txid,
				date: new Date(entry.timestamp)
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
			//attempt to find matching transaction
			let targetUser = req.query.user;
			let match_trx = await utils.confirmSEAFITReceived(targetUser);
			console.log(match_trx);
			//we found a match
			if (match_trx){
				found_entry = true;
				//query to see if entry already stored
				let tokenExchangeTransQuery = {
					user: targetUser,
					se_trx_ref: match_trx.txid
				}
				//store the transaction to the user's profile
				let tokenExchangeTrans = {
					user: targetUser,
					reward_activity: 'Move AFIT SE to Actifit Wallet',
					token_count: parseFloat(match_trx.quantity),
					se_trx_ref: match_trx.txid,
					date: new Date(match_trx.timestamp)
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
	if (req.query.confirm_payment_token != config.confirmPaymentToken){
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
						delegationSuccess = await utils.delegateToAccount(req.query.new_account, spToDelegate);
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
					paymentReceivedTx = await utils.confirmPaymentReceived(req);
					console.log('>>>> got TX '+paymentReceivedTx);
					if (paymentReceivedTx != ''){
						req.query.confirming_tx = paymentReceivedTx;
						console.log(req.query);
						try{
							accountCreated = await claimAndCreateAccount(req);
							if (accountCreated){
								delegationSuccess = await utils.delegateToAccount(req.query.new_account, spToDelegate);
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
			accountClaimed = await utils.claimDiscountedAccount();
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
		paymentReceivedTx = await utils.confirmPaymentReceivedPassword(req, config.signup_account);
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
		match_trx = await utils.confirmPaymentReceivedBuy(req, config.signup_account);
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
