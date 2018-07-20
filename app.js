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

app.get('/user/:user', async function (req, res) {
	let user = await collection.findOne({_id: req.params.user}, {fields : { _id:0} });
	console.log(user);
    res.header('Access-Control-Allow-Origin', '*');	
    res.send(user);
});

app.get('/transactions/:user?', async function (req, res) {
	let query = {};
	if(req.params.user)
		query = {user: req.params.user}
	let transactions = await db.collection('token_transactions').find(query, {fields : { _id:0} }).sort({date: -1}).limit(250).toArray();
	res.header('Access-Control-Allow-Origin', '*');	
    res.send(transactions);
});

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
		res.header('Access-Control-Allow-Origin', '*');	
		res.send(results);
		console.log(results);
	   });

});

app.get('/rewarded-activity-count', async function(req, res) {

	await db.collection("posts").aggregate( [
		{ $count: "rewardCount" }
	]).toArray(function(err, results) {
		console.log(results);
		res.header('Access-Control-Allow-Origin', '*');	
		res.send(results[0].rewardCount);
	});
}

app.listen(process.env.PORT || 3000);