var utils = require('./utils');
var mail = require('./mail');
const steem = require('steem');
const { forEach } = require('p-iteration');

const MongoClient = require('mongodb').MongoClient;
const assert = require('assert');


var config = utils.getConfig();

// Connection URL
const url = config.mongo_uri;
var postsProcessing = false;
var db;
var collection;
// Database Name
const db_name = config.db_name;
const collection_name = 'posts';

// Use connect method to connect to the server
MongoClient.connect(url, function(err, client) {
	if(!err) {
		assert.equal(null, err);
	  console.log("Connected successfully to server");

	  db = client.db(db_name);

	  // Get the documents collection
	  collection = db.collection(collection_name);
	  
	  updateUserTokens();
		runPostsProcess();
		//run every 31 mins
		setInterval(runPostsProcess, 31 * 60 * 1000);
		//run every 40 mins
		setInterval(updateUserTokens, 41 * 60 * 1000);

	} else {
		utils.log(err, 'import');
		/*mail.sendPlainMail('Database Error', err, '')
      .then(function(res, err) {
  			if (!err) {
  				console.log(res);
  			} else {
  				utils.log(err, 'import');
  			}
  		});
		process.exit();*/
	}
  
});


function runPostsProcess(){
	if(postsProcessing){
	return;
	}
  postsProcessing = true;
	getPosts();
}

async function getPosts(index) {

	console.log('>>>>>>>> attempt getPosts <<<<<<<<<<<');

	console.log('---- Getting Posts ----');
  var query = {tag: config.main_tag, limit: 100};
  if (index) {
  	console.log('--> More posts <--');
  	query.start_author = index.start_author;
  	query.start_permlink = index.start_permlink;
  }
	
	 //grab banned user list before rewarding
	var banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
	console.log('found banned users');
   
  steem.api.getDiscussionsByCreated(query, function (err, result) {
  	if (result && !err) {
      if(result.length == 0 || !result[0]) {
          utils.log('No posts found for this tag: ' + config.main_tag, 'import');
			  postsProcessing = false;
          return;
      }
	    console.log('Post count: ' + result.length);
			   
		  
		  let posts = utils.filterPosts(result, banned_users, config.account, config.main_tag);

		  //if the result was not an array, bail out
		  if (posts == -1){
			console.log('done looking for posts');
			
			postsProcessing = false;
			return;
		  }
		  
      console.log('Filtered count: ' + posts.length);
      // Upsert posts      
			var bulk = collection.initializeUnorderedBulkOp();
				console.log('check post');
			var step_count = -1;
	    for(var i = 0; i < posts.length; i++) {
	    	let post = posts[i]
	    	try {
          post.json_metadata = JSON.parse(post.json_metadata);
					  step_count = post.json_metadata.step_count;
          if (step_count < 5000)
            continue;
          else if (step_count < 6000)
            post.token_rewards = 20;
          else if(step_count < 7000)
            post.token_rewards = 35;
          else if(step_count < 8000)
            post.token_rewards = 50;
          else if(step_count < 9000)
            post.token_rewards = 65;
          else if(step_count < 10000)
            post.token_rewards = 80;
					  else if(step_count > 150000)
						continue;
          else
            post.token_rewards = 100;
        } catch (err) {
          utils.log('Error parsing json metadata');
          console.log(err);
          continue;
        }
	      bulk.find( { permlink: post.permlink } ).upsert().replaceOne(
				   post
				);
	    }
			//do not attempt insertion if no results found on this round
			if (posts.length == 0){
				let last_post = result[result.length - 1];
				if (!index || (index.start_permlink != last_post.permlink && index.start_author != last_post.author && result.length >= 100)){
						return getPosts({start_author: last_post.author, start_permlink: last_post.permlink});
					}
			}else{
	    bulk.execute()
		    .then(async function (res) {
		    	var mes = res.nInserted + ' posts inserted - ' + res.nUpserted + ' posts upserted - ' + res.nModified + ' posts updated';
		    	utils.log(mes, 'import');
		    	let last_post = posts[posts.length - 1];
		    	await processTransactions(posts);
		    	console.log('Inserted transactions');
		    	if (!index || (index.start_permlink != last_post.permlink && index.start_author != last_post.author && result.length >= 100))
		    		return getPosts({start_author: last_post.author, start_permlink: last_post.permlink});
				console.log('No more new posts');
			  	return;
		  	})
			  .catch(function (err) {
			  	utils.log(err, 'import');
					/*mail.sendPlainMail('Error en mongo upsert', err, config.report_emails)
			      .then(function(res, err) {
			  			if (!err) {
			  				console.log(res);
			  				return;
			  			} else {
			  				console.log(err);
			  				return;
			  			}
						});*/
				  }).finally(function() {
					   //making sure we don't get caught up in infinite loop after some error
					   postsProcessing = false;
			  		});
				  
			}
    } else {
      utils.log(err, 'import');
		  /*mail.sendPlainMail('0 posts...', err, config.report_emails)
      .then(function(res, err) {
  			if (!err) {
  				console.log(res);
  				return;
  			} else {
  				console.log(err);
  				return;
  			}
			});*/
    }
  });
}

async function processTransactions(posts) {
	console.log('---- Updating Transactions ----');
	let transactions = [];
	let collection = db.collection('token_transactions');
	var bulk = collection.initializeUnorderedBulkOp();
	await forEach(posts, async (post) => {
		//by default the reward owner is the author
		var reward_user = post.author;
		var activity_type = 'Post';
		var note = '';
		//if we find this is a charity run, let's switch it to the actual charity name
		if (typeof post.json_metadata.charity != 'undefined' && post.json_metadata.charity != '' && post.json_metadata.charity != 'undefined'){
			reward_user = post.json_metadata.charity;
			activity_type = 'Charity Post';
			note = 'Charity donation via activity by user '+post.author;
		}		
		let post_transaction = {
			user: reward_user,
			reward_activity: activity_type,
			token_count: post.token_rewards,
			url: post.url,
			date: post.created,
			note: note
		}
		 bulk.find(
			{ 
				user: post_transaction.user,
				reward_activity: post_transaction.reward_activity,
				url: post_transaction.url
			})
			.upsert().replaceOne(post_transaction); 
		transactions.push(post_transaction);
		post.active_votes.forEach(async vote => {
			//skip self vote from rewards
			if (post.author != vote.voter){
			let vote_transaction = {
				user: vote.voter,
				reward_activity: 'Post Vote',
				token_count: 1,
				url: post.url,
				date: vote.time
			}
			bulk.find(
			{ 
				user: vote_transaction.user,
				reward_activity: vote_transaction.reward_activity,
				url: vote_transaction.url
			})
			.upsert().replaceOne(vote_transaction);
			transactions.push(vote_transaction);
			}
		});
		let reblogs = await steem.api.getRebloggedByAsync(post.author, post.permlink);
		console.log('------------------ REBLOGS --------------------');
		console.log(reblogs);
		reblogs.forEach(async reblog => {
			if(reblog != post.author){
				let reblog_transaction = {
					user: reblog,
					reward_activity: 'Post Reblog',
					token_count: 1,
					url: post.url,
					date: post.created
				}
				console.log('---Reblog transaction ----');
				console.log(reblog_transaction);
				bulk.find(
				{ 
					user: reblog_transaction.user,
					reward_activity: reblog_transaction.reward_activity,
					url: reblog_transaction.url
				})
				.upsert().replaceOne(reblog_transaction);
				transactions.push(reblog_transaction);
			}				
		});
	});
	// console.log(transactions);
	return bulk.execute();
}

async function updateUserTokens() {
	console.log('---- Updating Users ----');

	try{
	let query = await db.collection('token_transactions').aggregate([
		{ $group: { _id: "$user", tokens: { $sum: "$token_count" } } },
		{ $sort: { tokens: -1 } },
		{ $project: { 
			 _id: "$_id",
			 user: "$_id",
			 tokens: "$tokens",
			 }
		 }
	  	])
	
		let user_tokens = await query.toArray();
		await db.collection('user_tokens').remove({});
		return await db.collection('user_tokens').insert(user_tokens);
	}catch(err){
		console.log('>>save data error:'+err.message);
	}
}

async function processVotedPosts() {

	let transactions = await getAccountVotes(config.account);
	let postsData = [];

	await forEach(transactions, async (txs) => {
		await steem.api.getContentAsync(txs.author, txs.permlink)
			.then(postObject => {
							if	(utils.checkBeneficiary(postObject) || postObject.author == config.account) {
									console.log('--- Post has correct beneficiaries or was posted by config account -----');
									postsData.push(postObject);
							} else {
									console.log('--- Post missing beneficiaries -----');
									console.log(postObject.url);
							}
					})
			.catch(error => {console.log(error)});
	});

	upsertPosts(postsData);
	return postsData;

}

async function getAccountVotes(account) {
	let voteByAccount = []
	await steem.api.getAccountHistoryAsync(account, -1, 10000)
			.filter( tx => tx[1].op[0] === 'vote' && tx[1].op[1].voter == account)
			.each((transaction) => {
					voteByAccount.push(transaction[1].op[1])
					console.log(transaction[1].op[1])
			})
	console.log(voteByAccount.length);
	return voteByAccount;
}

async function getReblogs(post) {
	console.log('----- Getting reblogs ----');
	let res;
	res = await steem.api.getRebloggedByAsync(post.author, post.permlink);
	console.log(res);
	return res;
}

async function upsertPosts(posts) {
	// Upsert posts      
	var bulk = collection.initializeUnorderedBulkOp();
	for(var i = 0; i < posts.length; i++) {
		let post = posts[i]
		var step_count = -1;
		try {
			post.json_metadata = JSON.parse(post.json_metadata);
			step_count = post.json_metadata.step_count;
			if (step_count < 5000)
				continue;
			else if (step_count < 6000)
				post.token_rewards = 20;
			else if(step_count < 7000)
				post.token_rewards = 35;
			else if(step_count < 8000)
				post.token_rewards = 50;
			else if(step_count < 9000)
				post.token_rewards = 65;
			else if(step_count < 10000)
				post.token_rewards = 80;
			else
				post.token_rewards = 100;
		} catch (err) {
			utils.log('Error parsing json metadata');
			console.log(err);
			continue;
		}
		bulk.find( { permlink: post.permlink } ).upsert().replaceOne(
			 post
		);
	}
	
	return bulk.execute()
		.then(async function (res) {
			var mes = res.nInserted + ' posts inserted - ' + res.nUpserted + ' posts upserted - ' + res.nModified + ' posts updated';
			utils.log(mes, 'import');
			await processTransactions(posts);
			console.log('----Super upsert ready ----');
			return;
		})
		.catch(function (err) {
			utils.log(err, 'import');
			mail.sendPlainMail('Error en mongo upsert', err, config.report_emails)
				.then(function(res, err) {
					if (!err) {
						console.log(res);
						return;
					} else {
						console.log(err);
						return;
					}
				});
		})
}