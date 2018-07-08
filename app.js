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
		mail.sendPlainMail('Database Error', err, 'cryptouru@gmail.com')
      .then(function(res, err) {
  			if (!err) {
  				console.log(res);
  			} else {
  				utils.log(err, 'api');
  			}
  		});
		process.exit();
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
    res.render('home', data);
});

app.get('/user/:user', async function (req, res) {
	let user = await collection.findOne({_id: req.params.user});
	console.log(user);
    res.send(user);
});

app.get('/transactions', async function (req, res) {
	let transactions = await db.collection('token_transactions').find().sort({date: -1}).limit(250).toArray();
    res.send(transactions);
});

app.listen(3000);