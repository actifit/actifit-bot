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
		{ $count: "reward_count" }
	]).toArray(function(err, results) {
		console.log(results);
		utils.log(results, 'rewarded-activity-count');
		res.header('Access-Control-Allow-Origin', '*');	
		res.send(results);
	});
});

app.get('/api/top5p0sts', function(req, res) {
		
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
	
	//grab actifit posts still unvoted
	var query = {tag: 'actifit', limit: 100};
	
	var last_iteration_count = 0;
	
	//first call
	extra_post_looper(query, false);
	
	var votePosts = Array();
	
	//this function is needed to allow grabbing more than 100 posts, until our queue is done
	function extra_post_looper(query, subsequent){
	
		
		steem.api.getDiscussionsByCreated(query, function (err, result) {
			if (result && !err) {
			  
			  console.log(result.length + ' posts to process...');      

			  for(var i = 0; i < result.length; i++) {
				var post = result[i];
				
				
				//if this is a subsequent call, we need to skip first post
				if (subsequent && i==0){
					// console.log('skip post:'+post.title);
					//continue to next element
					continue;
				}
			
				
				//if this is the last post, save it to skip it in next iteration
				if (i == result.length - 1){
					console.log('storing last post iteration: ' + post.url);
					//update query element to include the most recent post for a starting point of the next iteration
					query['start_permlink'] = post.permlink;
					query['start_author'] = post.author;									
				}
				

				// Make sure the post is less than 6.5 days
				if((new Date() - new Date(post.created + 'Z')) >= (6.5 * 24 * 60 * 60 * 1000)) {
				  console.log('This post is too old for a vote: ' + post.url);
				  continue;
				}

				// Make sure the post is older than 24hs
				/*if (new Date(post.created) >= new Date(new Date().getTime() - (config.min_hours * 60 * 60 * 1000))) { 
				  console.log('This post is too new for a vote: ' + post.url);
				  continue;
				}*/

				// Check if the bot already voted on this post
				if(post.active_votes.find(v => v.voter == 'actifit')) {
				  console.log('Bot already voted on: ' + post.url);
				  continue;
				}

				// Check if any tags on this post are blacklisted in the settings
				/*if ((config.blacklisted_tags && config.blacklisted_tags.length > 0) || (config.whitelisted_tags && config.whitelisted_tags.length > 0) && post.json_metadata && post.json_metadata != '') {
				  var tags = JSON.parse(post.json_metadata).tags;

				  if((config.blacklisted_tags && config.blacklisted_tags.length > 0) && tags && tags.length > 0 && tags.find(t => config.blacklisted_tags.indexOf(t) >= 0)) {
					utils.log('Post contains one or more blacklisted tags. ' + post.url);
					continue;
				  }

				  if((config.whitelisted_tags && config.whitelisted_tags.length > 0) && tags && tags.length > 0 && !tags.find(t => config.whitelisted_tags.indexOf(t) >= 0)) {
					utils.log('Post does not contain a whitelisted tag. ' + post.url);
					continue;
				  }
				}

				// Check if post category is main tag
				if (post.category != config.main_tag) {
				  utils.log('Post does not match category tag. ' + post.url);
				  continue;
				}

				// Check if this post has been flagged by any flag signal accounts
				if(config.flag_signal_accounts) {
				  if(post.active_votes.find(function(v) { return v.percent < 0 && config.flag_signal_accounts.indexOf(v.voter) >= 0; })) {
					utils.log('Post was downvoted by a flag signal account. ' + post.url);
					continue;
				  }
				}

				// Check if this post has been voted by any type of paid bot
				if(botNames && config.no_paid_bots) {
				  if(post.active_votes.find(function(v) { return botNames.includes(v.voter); })) {
					utils.log('Post was vote by a paid bot account. ' + post.url);
					continue;
				  }
				}*/

				// If cero votes continue
				/*if(post.active_votes.length == 0)
				  continue;*/

				// Check if account is beneficiary 
				var benefit = 0;
				for (var x = 0; x < post.beneficiaries.length; x++) {
				  for (var n = 0; n < 2; n++) {
					if (post.beneficiaries[x].account === 'actifit' || post.beneficiaries[x].account === 'actifit.pay')
					  benefit ++;
				  }          
				  if (benefit === 2) {
					benefit = true;
					break;
				  }
				}
				if (!benefit) {
				  console.log('Post does not match account beneficiary. ' + post.url);
				  continue;
				}
				
						//check if user is banned
				var banned_users = [];
				for (var n = 0; n < banned_users.length; n++) {
					if (post.author === banned_users[n]){
						utils.log('User '+post.author+' is banned, skipping his post:' + post.url);
						continue;
					}
				  }


				//special one time conditions
				if (post.author === 'pelvis'){
					continue;
				}
				
				if((new Date() - new Date(post.created + 'Z')) >= (3 * 24 * 60 * 60 * 1000)) {
					continue;
				}
				
				try {
				  post.json = JSON.parse(post.json_metadata);
				  var step_count = post.json.step_count;
				  if (step_count < 5000)
					continue;
				  else if (step_count < 6000)
					post.rate_multiplier = 0.2;
				  else if(step_count < 7000)
					post.rate_multiplier = 0.35;
				  else if(step_count < 8000)
					post.rate_multiplier = 0.5;
				  else if(step_count < 9000)
					post.rate_multiplier = 0.65;
				  else if(step_count < 10000)
					post.rate_multiplier = 0.8;
				  else
					post.rate_multiplier = 1;
				} catch (err) {
				  //utils.log('Error parsing json metadata');
				  console.log(err);
				  continue;
				}
				
				let last_index = _.findLastIndex(votePosts, ['author', post.author]);
				if (last_index != -1) {
				  console.log('---- User already has vote ------');
				  let last_voted = votePosts[last_index];
				  var last_date = moment(last_voted.created).format('D');
				  var this_date = moment(post.created).format('D');
				  if (last_date != this_date) {
					//console.log('Voting on: ' + post.url);
					console.log('Adding: ' + post.url + ' with step count:'+post.json.step_count);
					votePosts.push(post);
				  } else {
					console.log('---- Last voted -----');
					console.log(new Date (last_voted.created));
					console.log('---- This voted -----');
					console.log(new Date (post.created));
					console.log('---- Moment-----');
					console.log(last_date);
					console.log(this_date);
				  }          
				  
				} else {
					console.log('Adding: ' + post.url + ' with step count:'+post.json.step_count);
				  //console.log('Voting on: ' + post.url);
				  votePosts.push(post);
				}    
			  }
			  //store the count of added posts for future comparison
			  if (!subsequent){
				last_iteration_count = votePosts.length;
				console.log("last_iteration_count:"+last_iteration_count);
			  }
				//if this is the first try, or the new count of posts is bigger than the one before, let's try adding again
				if (!subsequent || votePosts.length>last_iteration_count){
				
					//update last count
					last_iteration_count = votePosts.length;
					//call again with subsequent enabled to avoid duplicate posts, disparse the calls by 1 sec to avoid API timeouts
					console.log("query:"+query['tag']);
					console.log("query:"+query['start_permlink']);
					setTimeout(extra_post_looper, 1000, query, true);
				
				}else{
						 //sort voted posts by step count
						votePosts.sort(function(post1, post2) {
							// Ascending: first age less than the previous
							return post2.json.step_count - post1.json.step_count;
						});
					  /*let testPost = {rate_multiplier: 0.8};
					  votePosts.push(testPost);*/
					  if (votePosts.length > 0) {
						console.log(votePosts.length + ' posts to vote...');
						var output='';
						for (var xcount=0;xcount<votePosts.length;xcount++){
							var cur_post = votePosts[xcount];
							console.log('user:'+cur_post.author + 'post '+cur_post.url+': '+cur_post.json.step_count);
							output += '#'+(xcount+1) + ' @' +cur_post.author + ' ' + gk_add_commas(cur_post.json.step_count);
							
							output += ' '+cur_post.url;
							
							output += ';';
							//only top 5 posts
							if (xcount>3) break;
						}
						res.header('Access-Control-Allow-Origin', '*');	
						res.send(output );
						/*vote_data = utils.calculateVotes(votePosts, config.vote_weight);
						//utils.log(vote_data.total_votes + ' total votes to divide.');
						utils.log(vote_data.power_per_vote + ' power per full vote.');
						utils.log(vote_data.power_per_vote * 0.8 + ' power per second vote.');
						utils.log(vote_data.power_per_vote * 0.65 + ' power per third vote.');
						utils.log(vote_data.power_per_vote * 0.5 + ' power per fourth vote.');
						utils.log(vote_data.power_per_vote * 0.35 + ' power per fith vote.');
						utils.log(vote_data.power_per_vote * 0.2 + ' power per lowest vote.');
						if(config.testing)
						  process.exit();
						else
						  votingProcess(votePosts, vote_data.power_per_vote);*/

					  } else {
						res.header('Access-Control-Allow-Origin', '*');	
						res.send('zero');
					  }
				}
			  
			 
			} else {
				res.header('Access-Control-Allow-Origin', '*');	
			  res.send(err);
			}
	  });
  
  }
	
	
});

app.listen(process.env.PORT || 3000);