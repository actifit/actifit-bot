var express = require('express');
var exphbs  = require('express-handlebars');
const MongoClient = require('mongodb').MongoClient;
var utils = require('./utils');


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

/* end point for user total token count display */
app.get('/user/:user', async function (req, res) {
	let user = await collection.findOne({_id: req.params.user}, {fields : { _id:0} });
	console.log(user);
	//fixing token amount display for 3 digits
	if (typeof user!= "undefined" && user!=null){
		if (typeof user.tokens!= "undefined"){
			user.tokens = user.tokens.toFixed(3)
		}
	}
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

/* end point for returning a single user last recorded delegation amount */
app.get('/delegation/:user', async function (req, res) {
	let user = await db.collection('active_delegations').findOne({_id: req.params.user}, {fields : { _id:0} });
	console.log(user);
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

app.listen(process.env.PORT || 3000);
