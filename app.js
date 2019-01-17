var express = require('express');
var exphbs  = require('express-handlebars');
const MongoClient = require('mongodb').MongoClient;
var utils = require('./utils');
const moment = require('moment')

var appPort = process.env.PORT || 3120;

var app = express();

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

var config = utils.getConfig();

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


/* function handles calculating and returning user token count */
grabUserTokensFunc = async function (req, res){
	let user = await collection.findOne({_id: req.params.user}, {fields : { _id:0} });
	console.log(user);
	//fixing token amount display for 3 digits
	if (typeof user!= "undefined" && user!=null){
		if (typeof user.tokens!= "undefined"){
			user.tokens = user.tokens.toFixed(3)
		}
	}
	return user;
}

/* end point for user total token count display */
app.get('/user/:user', async function (req, res) {
	let user = await grabUserTokensFunc(req,res);
    res.send(user);
});

/* end point for user transactions display (per user or general actifit token transactions, limited by 1000 */
app.get('/transactions/:user?', async function (req, res) {
	let query = {};
	var transactions;
	if(req.params.user){
		query = {user: req.params.user}
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	}else{
		//only limit returned transactions in case this is a general query
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(1000).toArray();
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
		var output = 'rewarded users:'+results[0].user_count+',';
		output += 'tokens distributed:'+results[0].tokens_distributed;
		res.send(results);
		console.log(results);
	   });

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
		var days = req.query.period;
		//console.log("days:"+days);
		var startDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		var endDate = moment(moment().utc().startOf('date').subtract(days, 'days').toDate()).format('YYYY-MM-DD');
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
			if (Object.keys(delegator_info).length > 0){
				if (parseInt(delegator_info.user_rank_benefit) == 1){
					//get original user delegation amount
					userDelegations = await activeDelegationFunc(delegator_info.delegator);		
					if (userDelegations != null){
						delegSP = userDelegations.steem_power;
					}
				}
			}
		}
		
		
		if (parseFloat(delegSP) > 0){
			delegation_score = utils.calcScore(delegation_rules, config.delegation_factor, parseFloat(delegSP));
		}
		
		user_rank += delegation_score;
		
		//grab user token count
		var userTokens = await grabUserTokensFunc(req,res);
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
		
		var recent_rewarded_post_count = await userRewardedPostCountFunc(req, res);
		//console.log(recent_rewarded_post_count);
		
		var recent_posts_score = utils.calcScore(recent_reward_posts_rules, config.recent_posts_factor, parseInt(recent_rewarded_post_count));
		
		user_rank += recent_posts_score;
		
		var score_components = JSON.stringify({
			user_rank: user_rank,
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
		
		delegator_info = await db.collection('delegation_alt_beneficiaries').findOne(query_json, {fields : { _id:0} });
		if (delegator_info==null){
			delegator_info = {};
		}
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
			referralRewarded = await storeReferralReward(req);
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
		}, 3000);
		try{
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
		}catch(err){
			console.log(err);
		}
		//we're done, let's clear our running interval
		clearInterval(intID);
		//res.send({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated});
		res.write(JSON.stringify({'paymentReceivedTx':paymentReceivedTx, 'accountCreated': accountCreated}));
		res.end();
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
