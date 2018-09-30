var express = require('express');
var exphbs  = require('express-handlebars');
const MongoClient = require('mongodb').MongoClient;
var utils = require('./utils');
const moment = require('moment')


var app = express();

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

var config = utils.getConfig();

// Connection URL
const url = config.mongo_uri;

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
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(user);
});


/* end point for user transactions display (per user or general actifit token transactions, limited by 250 */
app.get('/transactions/:user?', async function (req, res) {
	let query = {};
	var transactions;
	if(req.params.user){
		query = {user: req.params.user}
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).toArray();
	}else{
		//only limit returned transactions in case this is a general query
		transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(250).toArray();
	}
	res.header('Access-Control-Allow-Origin', '*');	
    res.send(transactions);
});

/* end point for returning number of awarded users and tokens distributed */
app.get('/userTokensInfo', async function(req, res) {

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
		res.header('Access-Control-Allow-Origin', '*');	
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
		res.header('Access-Control-Allow-Origin', '*');	
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
		res.header('Access-Control-Allow-Origin', '*');	
		res.send(results);
	});
});

/* end point for returning charity data supported by actifit */
app.get('/charities', async function (req, res) {
	var charities = await db.collection('available_charities').find({status:"enabled"}, {charity_name: 1}).sort({charity_name: 1}).toArray();
    res.header('Access-Control-Allow-Origin', '*');	
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
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(delegatorList);
});

activeDelegationFunc = async function (req, res){
	let user = await db.collection('active_delegations').findOne({_id: req.params.user}, {fields : { _id:0} });
	console.log(user);
	return user;
}

/* end point for returning a single user last recorded active delegation amount */
app.get('/delegation/:user', async function (req, res) {
	var user = await activeDelegationFunc(req, res);
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(user);
});

/* end point for returning current active moderators data by actifit */
app.get('/moderators', async function (req, res) {
	var moderatorList; 
	moderatorList = await db.collection('team').find({title:'moderator', status:'active'}).sort({name: 1}).toArray();
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(moderatorList);
});

/* end point for returning current active ambassadors data by actifit */
app.get('/ambassadors', async function (req, res) {
	var ambassadorList; 
	ambassadorList = await db.collection('team').find({title:'ambassador', status:'active'}).sort({name: 1}).toArray();
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(ambassadorList);
});

/* end point for returning current top AFIT token holders */
app.get('/topTokenHolders', async function (req, res) {
	var delegatorList; 
	if (isNaN(req.query.count)){
		delegatorList = await db.collection('user_tokens').find().sort({tokens: -1}).toArray();
	}else{
		delegatorList = await db.collection('user_tokens').find().sort({tokens: -1}).limit(parseInt(req.query.count)).toArray();
	}
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(delegatorList);
});


/* end point for returning accounts banned by actifit*/
app.get('/bannedUsers', async function (req, res) {
	var banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
    res.header('Access-Control-Allow-Origin', '*');	
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
			res.header('Access-Control-Allow-Origin', '*');	
			res.send(JSON.stringify({reblog_count:reblog_count}));
		}catch(err){
			console.log(err.message);
		}
});

/* end point for counting number of upvotes on a certain date param (default current date) */
app.get('/upvoteCount', async function (req, res) {
		var todayDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		//fileName = "steemrewards"+fileName+".json";
		var dateRegex = new RegExp ('^'+todayDate); // /^2018-08-05/
		if (req.query.targetDate){
			dateRegex = new RegExp ('^'+req.query.targetDate);
		}
		let query = await db.collection('token_transactions').find({
				"reward_activity": "Post Vote",
				"date":  dateRegex
		})
		try{
			console.log('counting');
			let upvote_count = await query.count();
			console.log(upvote_count);
			res.header('Access-Control-Allow-Origin', '*');	
			res.send(JSON.stringify({upvote_count:upvote_count}));
		}catch(err){
			console.log(err.message);
		}
});

/* end point for counting number of rewarded posts on a certain date param (default current date) */
app.get('/rewardedPostCount', async function (req, res) {
		var todayDate = moment(moment().utc().startOf('date').toDate()).format('YYYY-MM-DD');
		//fileName = "steemrewards"+fileName+".json";
		var dateRegex = new RegExp ('^'+todayDate); // /^2018-08-05/
		if (req.query.targetDate){
			dateRegex = new RegExp ('^'+req.query.targetDate);
		}
		let query = await db.collection('token_transactions').find({
				"reward_activity": "Post",
				"date":  dateRegex
		})
		try{
			console.log('counting');
			let rewarded_post_count = await query.count();
			console.log(rewarded_post_count);
			res.header('Access-Control-Allow-Origin', '*');	
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
		var startDateRegex = new RegExp ('^'+startDate); // /^2018-08-05/
		var endDateRegex = new RegExp ('^'+endDate); // /^2018-08-05/
		//console.log("startDate:"+startDate+" endDate:"+endDate);
		//adjust query to include dates
		query_json = {
				"reward_activity": "Post",
				"user": user,
				"date": {
						"$gte": endDate,
						"$lt": startDate
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
		res.header('Access-Control-Allow-Origin', '*');	
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
			[10,1]
		]
		
		var user_rank = 0;
		
		//grab delegation amount
		var userDelegations = await activeDelegationFunc(req, res);
		//console.log(userDelegations.steem_power);
		
		var delegation_score = utils.calcScore(delegation_rules, config.delegation_factor, parseFloat(userDelegations.steem_power));
		
		user_rank += delegation_score;
		
		//grab user token count
		var userTokens = await grabUserTokensFunc(req,res);
		//console.log(userTokens.tokens);
		
		var afit_tokens_score = utils.calcScore(afit_token_rules, config.afit_token_factor, parseFloat(userTokens.tokens));
		
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
		
		res.header('Access-Control-Allow-Origin', '*');	
		res.send(score_components);
	}else{
		res.send("");
	}
});

app.listen(process.env.PORT || 3000);
