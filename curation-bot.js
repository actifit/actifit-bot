var fs = require("fs");
const steem = require('steem');
var utils = require('./utils');
var mail = require('./mail');
var _ = require('lodash');
var moment = require('moment');
const MongoClient = require('mongodb').MongoClient;

const cheerio = require('cheerio')
const axios = require('axios');
const request = require("request");

var account = null;
var last_trans = 0;
var members = [];
var whitelist = [];
var config = null;
var first_load = true;
var is_voting = false;
var last_voted = 0;
var vote_time;
var last_votes = Array();
var skip = false;
var version = '0.3.4';
var lucky_winner_id = -1;


let usersAFITXBal = [];
let topUsersAFITX = [];

//version of the reward system
var reward_sys_version = 'v0.2';

var error_sent = false;

var steem_price = 1;  // This will get overridden with actual prices if a price_feed_url is specified in settings
var sbd_price = 1;    // This will get overridden with actual prices if a price_feed_url is specified in settings

var STEEMIT_100_PERCENT = 10000;
var STEEMIT_VOTE_REGENERATION_SECONDS = (5 * 60 * 60 * 24);
var HOURS = 60 * 60;

//keep alive
var http = require("http");
setInterval(function() {
  try{
    http.get("http://actifitvoter.herokuapp.com");
	
	if (!is_voting){
		//let's also run our token exchange cleanup process
		console.log('running cleanup');
		request('https://actifitbot.herokuapp.com/cancelOutdatedAfitSteemExchange', function (error, response, body) {
			console.log('cleanup result');
			console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
			console.log('error: '+ error)
		});
		
		//let's also run the cleanup for any missed AFIT SE to Actifit wallet processes
		request('https://actifitbot.herokuapp.com/confirmAFITSEBulk', function (error, response, body) {
			console.log('process any missed AFIT SE to Actifit Wallet');
			console.log(response);
			//console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
			//console.log('error: '+ error)
		});
	}
	
  }catch(err){
	console.log('error:'+err);
  }

}, 600000); // every 10 minutes (600000)

var crypto = require('crypto');

const activity_rules = [
	[4999,0],
	[5999,0.20],
	[6999,0.35],
	[7999,0.50],
	[8999,0.65],
	[9999,0.80],
	[10000,1.00],
	[149999,1.00],
	[150000,0],
]

const content_rules = [
	[99,0],
	[399,0.20],
	[799,0.35],
	[1199,0.50],
	[1599,0.65],
	[1999,0.80],
	[2000,1.00]
]

const img_rules = [
	[0,0],
	[1,0.2],
	[2,0.4],
	[3,0.6],
	[4,0.8],
	[5,1]
]

const vid_rules = [
	[0,0],
	[1,1]
]

const upv_rules = [
	[0,0],
	[10,0.2],
	[20,0.4],
	[30,0.6],
	[50,0.8],
	[100,1]
]

const cmts_rules = [
	[0,0],
	[2,0.2],
	[4,0.4],
	[6,0.6],
	[8,0.8],
	[10,1]
]

//our pre-defined image pool
const actifit_img_urls =  [
	"https://cdn.steemitimages.com/DQmXv9QWiAYiLCSr3sKxVzUJVrgin3ZZWM2CExEo3fd5GUS/sep3.png",
	"https://cdn.steemitimages.com/DQmRgAoqi4vUVymaro8hXdRraNX6LHkXhMRBZxEo5vVWXDN/ACTIVITYCOUNT.png",
	"https://cdn.steemitimages.com/DQmZ6ZT8VaEpaDzB16qZzK8omffbWUpEpe4BkJkMXmN3xrF/ACTIVITYTYPE.png",
	"https://cdn.steemitimages.com/DQmdnh1nApZieHZ3s1fEhCALDjnzytFwo78zbAY5CLUMpoG/TRACKM.png",
	"https://cdn.steemitimages.com/DQmfSsFiXem7AxWG1NCiYYPAjtT4Y7LR8FsXpfsZQe7XqPC/h1.png",
	"https://cdn.steemitimages.com/DQmVqJVEWUwicFRtkEz2WYq2mDH61mQLDsrzN1yBrKLrpyZ/w1a.png",
	"https://cdn.steemitimages.com/DQmPJ2Vvi3mBQXKHoy5CTG7fyLFWMG8JaAZ8y1XZFeDkRUC/bd1.png",
	"https://cdn.steemitimages.com/DQmZ2Lfwg77FLaf3YpU1VPLsJvnBt1F8DG8y6t6xUAKnsYq/w1.png",
	"https://cdn.steemitimages.com/DQmbbAAFy6hwwBWqtSmcSwosTyNZi9rcd6GNeugQRY9MF1h/t1.png",
	"https://cdn.steemitimages.com/DQmbaoNBT5Unnjqh8JgP6TPj4mFKFnyKkLgP6eDYnnkiLkB/c1.png",
	
	"https://cdn.steemitimages.com/DQmQqfpSmcQtfrHAtzfBtVccXwUL9vKNgZJ2j93m8WNjizw/l5.png",
	"https://cdn.steemitimages.com/DQmbWy8KzKT1UvCvznUTaFPw6wBUcyLtBT5XL9wdbB7Hfmn/l6.png",
	
	"https://cdn.steemitimages.com/DQmNp6YwAm2qwquALZw8PdcovDorwaBSFuxQ38TrYziGT6b/A-20.png", 
	"https://cdn.steemitimages.com/DQmY5UUP99u5ob3D8MA9JJW23zXLjHXHSRofSH3jLGEG1Yr/A-10.png", 
	"https://cdn.steemitimages.com/DQmRDW8jdYmE37tXvM6xPxuNnzNQnUJWSDnxVYyRJEHyc9H/A-14.png", 
	"https://cdn.steemitimages.com/DQmPscjCVBggXvJT2GaUp66vbtyxzdzyHuhnzc38WDp4Smg/A-3.png", "https://cdn.steemitimages.com/DQmVoLkmU47N4fM75HVY7se7JiMzdXhQKQUZ5fyCDwh1BrE/A-13.png",
	"https://cdn.steemitimages.com/DQmcngR7AdBJio52C5stkD5C7vgsQ1yDH57Lb4J96Pys4a9/A-6.png","https://cdn.steemitimages.com/DQmdL69SXfqqKKoaEC55u3wsiMyAhcSErdK1fYjckAUyMCz/A-2.png", "https://cdn.steemitimages.com/DQmRgZTP4R6q9DfAWf9dNuqXWgvxkduxuH5QJfeyUVEqsk9/A-8.png", "https://cdn.steemitimages.com/DQmWzwdS5u4G1GheceM1bmBC3HL6zWubUGYbPkCmEcEDXrD/A-4.png", "https://cdn.steemitimages.com/DQmUVjgmJHvtbYB2APdxqNxxkZeJ2KvPeXEE7v3BpxGJkbR/A-18.png", "https://cdn.steemitimages.com/DQmdMW7LzuiKLi9vaEWsXnWGcU1oMHbF4983L16CE63dvwz/A-17.png",
	"https://cdn.steemitimages.com/DQmVD3pXR4EHzYeCapMNSanTeK9wGJeJ24XYJhZSUmjJReR/A-11.png", "https://cdn.steemitimages.com/DQmY67NW9SgDEsLo2nsAw4nYcddrTjp4aHNLyogKvGuVMMH/A-9.png", "https://cdn.steemitimages.com/DQmcrdacUAEHoeiX9gNVAiiL5iydmJoPve2nXpzszNtJZPb/A-12.png", "https://cdn.steemitimages.com/DQmbP8GuFvcHUyh7bKDheDN5iz8ERPCYzMaSVoRT2R5ZYPE/A-15.png","https://cdn.steemitimages.com/DQmW1VsUNbEjTUKawau4KJQ6agf41p69teEvdGAj1TMXmuc/A-5.png",
	"https://cdn.steemitimages.com/DQmeBn1PLf6a3QaXjM23EbQcaKtfDckgtGPHE4DApoUeBEJ/A-1.png", "https://cdn.steemitimages.com/DQmV7NRosGCmNLsyHGzmh4Vr1pQJuBPEy2rk3WvnEUDxDFA/A-21.png", "https://cdn.steemitimages.com/DQmdNAWWwv6MAJjiNUWRahmAqbFBPxrX8WLQvoKyVHHqih1/A-19.png","https://cdn.steemitimages.com/DQmVNqM8wQj2TnfwqSPYtfAuPHYjeBXSFekCHGZw9K3B9Gi/A-16.png", "https://cdn.steemitimages.com/DQma7nn1yV2w9iY6qXDBJUoTWkELTYxot7R9eoG1M3Tbtqn/A-7.png"];


// Load the settings from the config file
loadConfig();
var botNames;


const SSC = require('sscjs');
const ssc = new SSC(config.steem_engine_rpc);


// Initial Load of top AFITX token holders
// Top 25 will be stored in topUsersAFITX
fetchAFITXBal(0);

setInterval(function(){
	try{
	  if (!is_voting){
		// Load updated top AFITX token holders every 10 minutes
		// Top 25 will be stored in topUsersAFITX
		fetchAFITXBal(0);
	  }
	}catch(err){
		console.log(err);
	}
}, 1200000); // every 20 minutes (1200000)

steem.api.setOptions({ 
	url: config.active_node ,
	//useAppbaseApi: true
});

utils.log("* START - Version: " + version + " *");

// Connection URL
var url = config.mongo_uri;

//check if this is a test scenario to use local DB url
if (config.testing){
	url = config.mongo_local;
}
//utils.log('db url:'+url);
var db;
var collection;

var db_name = config.db_name;

const collection_name = 'banned_accounts';

var banned_users;

var moderator_list;

var skippable_posts;

var afit_steem_upvote_list;

var cur_afit_price;

var helping_accounts_votes = 0;


// Check if bot state has been saved to disk, in which case load it
if (fs.existsSync('state.json')) {
  var state = JSON.parse(fs.readFileSync("state.json"));

  if (state.last_trans)
    last_trans = state.last_trans;

  if (state.last_voted)
    last_voted = state.last_voted;

  if (state.vote_time)
    vote_time = state.vote_time;

  utils.log('Restored saved bot state: ' + JSON.stringify(state));
}

// Check if members list has been saved to disk, in which case load it
if (fs.existsSync('members.json')) {
  var members_file = JSON.parse(fs.readFileSync("members.json"));
  members = members_file.members;
  utils.log('Loaded ' + members.length + ' members.');
}


// Use connect method to connect to the server
MongoClient.connect(url, function(err, client) {
	if(!err) {
	  utils.log("Connected successfully to server "+url);

	  db = client.db(db_name);

	  // Get the documents collection
	  collection = db.collection(collection_name);
	  //only start the process once we connected to the DB
	  startProcess();
	  
	  // Load updated STEEM and SBD prices every 30 minutes
	  loadPrices();
	  setInterval(loadPrices, 30 * 60 * 1000);
	  
	  //updateUserTokens();
	} else {
		utils.log(err, 'api');
	}
  
});


// Schedule to run every minute
if (!config.testing){
	setInterval(startProcess, 60 * 1000);
}else{
	setTimeout(startProcess, 20 * 1000);
}


var votePosts;
var lastIterationCount = 0;

let queryCount = 0;

let properties, rewardFund, rewardBalance, recentClaims, totalSteem, totalVests, votePowerReserveRate, sbd_print_percentage;

async function setIsVoting(running){
	try{
		is_voting = running;
		let votingStatus = await db.collection('voting_status').findOne({});
		if (!votingStatus){
			votingStatus = new Object();
		}
		votingStatus.is_voting = running;
		if (running){
			votingStatus.voting_start = new Date();
		}else{
			votingStatus.voting_end = new Date();
		}
		db.collection('voting_status').save(votingStatus);
	}catch(err){
		console.log(err);
	}
}


//handles grabbing the vote value /STEEM
  function getVoteValue(voteWeight, account, currentVotingPower, steem_price) {
	if (rewardBalance && recentClaims && steem_price && votePowerReserveRate) {
	  let voteValue = getVoteRShares(voteWeight, account, currentVotingPower * 100)
		* rewardBalance / recentClaims
		* steem_price;
	  
	  return voteValue;
	}
  }
  //calculate voting value based on rshares contribution
  function getVoteRShares (voteWeight, account, power) {
  
	let effective_vesting_shares = Math.round(getVestingShares(account) * 1000000);
	let voting_power = account.voting_power;
	let weight = voteWeight * 100;
	let last_vote_time = new Date((account.last_vote_time) + 'Z');

	let elapsed_seconds = (new Date() - last_vote_time) / 1000;

	let regenerated_power = Math.round((STEEMIT_100_PERCENT * elapsed_seconds) / STEEMIT_VOTE_REGENERATION_SECONDS);

	let current_power = power || Math.min(voting_power + regenerated_power, STEEMIT_100_PERCENT);
	let max_vote_denom = votePowerReserveRate * STEEMIT_VOTE_REGENERATION_SECONDS / (60 * 60 * 24);
	let used_power = Math.round((current_power * weight) / STEEMIT_100_PERCENT);
	used_power = Math.round((used_power + max_vote_denom - 1) / max_vote_denom);

	let rshares = Math.round((effective_vesting_shares * used_power) / (STEEMIT_100_PERCENT))

	return rshares;
  }
  //grab account vesting shares value
  function getVestingShares(account) {
	var effective_vesting_shares = parseFloat(account.vesting_shares.replace(" VESTS", ""))
		+ parseFloat(account.received_vesting_shares.replace(" VESTS", ""))
	   - parseFloat(account.delegated_vesting_shares.replace(" VESTS", ""));
	return effective_vesting_shares;
  }
  //handles display vote value in USD
  function getVoteValueUSD(voteWeight, account, currentVotingPower, sbd_price) {
	let vote_value = getVoteValue(voteWeight, account, currentVotingPower, steem_price);
	const steempower_value = vote_value * 0.5
	const sbd_print_percentage_half = (0.5 * sbd_print_percentage)
	const sbd_value = vote_value * sbd_print_percentage_half
	const steem_value = vote_value * (0.5 - sbd_print_percentage_half)
	let vote_value_usd = ((sbd_value * sbd_price) + steem_value + steempower_value).toFixed(3);
	return vote_value_usd
  }


async function startProcess() {
  if(!botNames)
    botNames = await utils.loadBots();
  //if (config.detailed_logging)
    utils.log('Start process');
  // Load the settings from the config file each time so we can pick up any changes
  loadConfig();

  // Load the bot account info
  steem.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      utils.log(err, result);
    else {
      account = result[0];

    }
  });

  var oneMoreDay = new Date(new Date(vote_time).getTime() + (24 * 60 * 60 * 1000));
  var today = new Date();
  //deactivating condition of 24 hrs to pass
  var passedOneDay = true;//today >= oneMoreDay;

  //utils.log('found banned users');
  //utils.log(banned_users);
  
  /*for (var n = 0; n < banned_users.length; n++) {
  utils.log(banned_users[n].user);
            //if (post.author == banned_users[n].user){
				//utils.log('User '+post.author+' is banned, skipping his post:' + post.url);
				//user_banned = true;
				//break;
			//}
          }
  return;*/
  
  
  
  //utils.updateSteemVariables();
  console.log('account');	
  console.log(account!=null);	
  console.log('skip:'+skip);	
  console.log('is_voting:'+is_voting);	
  console.log('passedOneDay:'+passedOneDay);	

  if (account && !skip && !is_voting && passedOneDay) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    utils.log('Voting Power: ' + utils.format(vp) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp*100)));

    // We are at voting power kick start - time to vote!
	//utils.log(vp >= parseFloat(config.vp_kickstart)/100);
    if (vp >= parseFloat(config.vp_kickstart)/100 || config.testing) {
	
		// Check if there are any rewards to claim before voting
		if (!config.testing){
			claimRewards();
		}
		
		
		//reset number of helping votes case
		helping_accounts_votes = 0;
		
		
		// Load Steem global variables

		properties = await steem.api.getDynamicGlobalPropertiesAsync();
		  //grab reward fund data
		rewardFund = await steem.api.getRewardFundAsync("post");
		rewardBalance = parseFloat(rewardFund.reward_balance.replace(" STEEM", ""));
		recentClaims = rewardFund.recent_claims;
		
		totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0]);
		totalVests = Number(properties.total_vesting_shares.split(' ')[0]);
		
		votePowerReserveRate = properties.vote_power_reserve_rate;
		sbd_print_percentage = properties.sbd_print_rate / 10000;
		
		utils.log('lets vote');
		skip = true;
		  
		utils.log('fetch banned users list');  
		//grab banned user list before rewarding
		banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
	  
		//grab list of moderators
		var moderator_api_url = config.api_url+'moderators';
		var moderator_info = await axios.get(moderator_api_url);
		utils.log(moderator_info.data);
		var moderator_array = moderator_info.data;
		moderator_list = [];
		for (var mod_it=0;mod_it<moderator_array.length;mod_it++){
			moderator_list.push(moderator_array[mod_it].name);
		}
		utils.log(moderator_list);
		
		//grab list of users exchanging AFIT for STEEM upvotes who were not processed yet by oldest
		afit_steem_upvote_list = await db.collection('exchange_afit_steem').find({upvote_processed: {$in: [null, false, 'false']}}).sort({'date': 1}).toArray();
		
		console.log('afit_steem_upvote_list');
		console.log(afit_steem_upvote_list);
	
		//grab AFIT token price
		cur_afit_price = await db.collection('afit_price').find().sort({'date': -1}).limit(1).next();
		console.log('curAfitPrice:'+cur_afit_price.unit_price_usd);
		
		//grab list of skippable posts
		skippable_posts = await db.collection('posts_to_skip').find().toArray();
		
		console.log('skippable_posts');
		console.log(skippable_posts);
	  
		var query = {tag: config.main_tag, limit: 100};
		
		if (config.testing){
			query.limit = config.max_query_count;
		}
		votePosts = Array();
		processVotes(query, false);      
    }else{
		//if we're not voting, let's check to claim some more discounted account spots
		utils.getRC(config.account).then(function(results){
			utils.log('Current RC: ' + utils.format(results.estimated_pct) + '% | Time until full: ' + utils.toTimer(results.fullin));
			if (results.estimated_pct>config.account_claim_rc_min){
				//if we reached min threshold, claim more spots for discounted accounts
				utils.claimDiscountedAccount();
			}			
		}, function(err) {
			utils.log("Error fetching RC");
			utils.log(err);
		});
	}
    
  } else if(skip)
    skip = false;
  else if (!account)
    utils.log('Loading account data...');
  else utils.log('Voting... or waiting for a day to pass');
}


function loadPrices() {
  if(config.price_source == 'coinmarketcap') {
    // Load the price feed data
    request.get('https://api.coinmarketcap.com/v1/ticker/steem/', function (e, r, data) {
      try {
        steem_price = parseFloat(JSON.parse(data)[0].price_usd);

        utils.log("Loaded STEEM price: " + steem_price);
      } catch (err) {
        utils.log('Error loading STEEM price: ' + err);
      }
    });

    // Load the price feed data
    request.get('https://api.coinmarketcap.com/v1/ticker/steem-dollars/', function (e, r, data) {
      try {
        sbd_price = parseFloat(JSON.parse(data)[0].price_usd);

        utils.log("Loaded SBD price: " + sbd_price);
      } catch (err) {
        utils.log('Error loading SBD price: ' + err);
      }
    });
  } else if (config.price_source && config.price_source.startsWith('http')) {
    request.get(config.price_source, function (e, r, data) {
      try {
        sbd_price = parseFloat(JSON.parse(data).sbd_price);
        steem_price = parseFloat(JSON.parse(data).steem_price);

        utils.log("Loaded STEEM price: " + steem_price);
        utils.log("Loaded SBD price: " + sbd_price);
      } catch (err) {
        utils.log('Error loading STEEM/SBD prices: ' + err);
      }
    });
  } else {
    // Load STEEM price in BTC from bittrex and convert that to USD using BTC price in coinmarketcap
    request.get('https://api.coinmarketcap.com/v1/ticker/bitcoin/', function (e, r, data) {
      request.get('https://bittrex.com/api/v1.1/public/getticker?market=BTC-STEEM', function (e, r, btc_data) {
        try {
          steem_price = parseFloat(JSON.parse(data)[0].price_usd) * parseFloat(JSON.parse(btc_data).result.Last);
          utils.log('Loaded STEEM Price from Bittrex: ' + steem_price);
        } catch (err) {
          utils.log('Error loading STEEM price from Bittrex: ' + err);
        }
      });

      request.get('https://bittrex.com/api/v1.1/public/getticker?market=BTC-SBD', function (e, r, btc_data) {
        try {
          sbd_price = parseFloat(JSON.parse(data)[0].price_usd) * parseFloat(JSON.parse(btc_data).result.Last);
          utils.log('Loaded SBD Price from Bittrex: ' + sbd_price);
        } catch (err) {
          utils.log('Error loading SBD price from Bittrex: ' + err);
        }
      });
    });
  }
}


//var post_scores = [];
function processVotes(query, subsequent) {
  
  utils.log('processVotes');
  
  //fetch top AFITX holders as of current
  //top 25 will be stored in topUsersAFITX
  //fetchAFITXBal(0);
	
  
  steem.api.getDiscussionsByCreated(query, async function (err, result) {
	//track how many queries were ran
	queryCount += 1;
    if (result && !err) {
		//is_voting = true;
		setIsVoting(true);
      
		utils.log(result.length + ' posts to process...');      
		
		//initialize inserting posts to db
		
		var bulk = db.collection('posts').initializeUnorderedBulkOp();
		
		//connect to the token_transactions table to start rewarding
		var bulk_transactions = db.collection('token_transactions').initializeUnorderedBulkOp();
		
		var bulk_posts_skip = db.collection('posts_to_skip').initializeUnorderedBulkOp();
		
		
		for(var i = 0; i < result.length; i++) {
			
			var post = result[i];
			
		
			//if this is a subsequent call, we need to skip first post
			if (subsequent && i==0){
				// utils.log('skip post:'+post.title);
				//continue to next element
				continue;
			}
	
			//if this is the last post, save it to skip it in next iteration
			if (i == result.length - 1){
				utils.log('storing last post iteration: ' + post.url);
				//update query element to include the most recent post for a starting point of the next iteration
				query['start_permlink'] = post.permlink;
				query['start_author'] = post.author;									
			}

			if (!config.testing){
				// Make sure the post is older than config time
				if (new Date(post.created) >= new Date(new Date().getTime() - (config.min_hours * 60 * 60 * 1000))) { 
				  utils.log('This post is too new for a vote: ' + post.url);
				  continue;
				}
			}

			// Check if the bot already voted on this post
			if(post.active_votes.find(v => v.voter == 'actifit')) {
			  utils.log('Bot already voted on: ' + post.url);
			  continue;
			}
			
			
			//post.json_metadata = JSON.parse(body);
			
			// Check if any tags on this post are blacklisted in the settings
			if ((config.blacklisted_tags && config.blacklisted_tags.length > 0) || (config.whitelisted_tags && config.whitelisted_tags.length > 0) && post.json_metadata && post.json_metadata != '') {
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
			/*if (post.category != config.main_tag) {
			  utils.log('Post does not match category tag. ' + post.url);
			  continue;
			}*/

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
			}
			
			// Check if account is beneficiary 
			var benefit = 0;
			for (var x = 0; x < post.beneficiaries.length; x++) {
			  for (var n = 0; n < config.beneficiaries.length; n++) {
				if (post.beneficiaries[x].account === config.beneficiaries[n])
				  benefit ++;
			  }          
			  if (benefit === config.beneficiaries.length) {
				benefit = true;
				break;
			  }
			}
			if (!benefit) {
			  utils.log('Post does not match account beneficiary. ' + post.url);
			  continue;
			}
			
			//check if user is banned
			var user_banned = false;
			for (var n = 0; n < banned_users.length; n++) {
				if (post.author == banned_users[n].user){
					utils.log('User '+post.author+' is banned, skipping his post:' + post.url);
					user_banned = true;
					break;
				}
			}   
			if (user_banned) continue;
			
			//skip any posts that are more than max days old
			if((new Date() - new Date(post.created + 'Z')) >= (config.max_days * 24 * 60 * 60 * 1000)) {
				continue;
			}		
			
			//skip any posts that are flagged as skippable in prior iterations
			
			var post_skippable = false;
			for (var n = 0; n < skippable_posts.length; n++) {
				if (post.author == skippable_posts[n].author && post.permlink == skippable_posts[n].permlink){
					utils.log('>>>>>>>Post by '+post.author+' is skippable, move ahead:' + post.url);
					post_skippable = true;
					break;
				}
			  }   
			if (post_skippable) continue;
			
			try {
			
				console.log('parsing data by post '+post.url);
			
				post.json = JSON.parse(post.json_metadata);
					
				//we need to fetch the proper json_metadata from our own DB to ensure those have not been changed
				
				if (!config.testing){
				
					let ver_url = config.api_url + "fetchVerifiedPost";			
					let critical_fields = ['step_count', 'actiCrVal', 'actifitUserID', 'activityDate'];
					
					let incons_detected = false;
					let incons_field = '';
					
					try{
						var verf_res = await axios.get(ver_url, {
								params:{
									author: post.author, 
									permlink: post.permlink
								}
							});
						
						
						//let's compare mission critical data to find if manipulation was done
						let auth_meta = verf_res.data.json_metadata;
						//console.log(auth_meta);
						//if either stored or current metadata is non-empty we need to investigate further
						if (auth_meta != '' || post.json_metadata != ''){
							//check all critical values
							critical_fields.some(function(element) {
							  //initialize incons field in case we find a match (or lack of)
							  incons_field = element;
							  let stored_meta = eval("auth_meta."+element);
							  let new_meta = eval("post.json."+element);
							  /*console.log('stored_meta');
							  console.log(stored_meta);
							  console.log('new_meta');
							  console.log(new_meta);*/
							  //if old data is not empty
							  if (typeof stored_meta != 'undefined' && stored_meta != ''){
								if (stored_meta instanceof Array ){
								  if (new_meta instanceof Array){
									//our arrays are single valued, compare first entry
									if (stored_meta[0] != new_meta[0]){
									  //different value, manipulation
									  incons_detected = true;
									  return true;
									}
								  }else{
									//different object types, manipulation
									incons_detected = true;
									return true;
								  }
								}else{
								  if (stored_meta != new_meta){
									//different value, manipulation
									incons_detected = true;
									return true;
								  }
								}
							  }else{
								//original data is empty, need to check if new data is not
								if (typeof new_meta != 'undefined' && new_meta != ''){
								  incons_detected = true;
								  return true;
								}
							  }
							});
						}
					}catch(verf_err){
						console.log('error finding matching post on DB');
						console.dir(verf_err);
					}
					//console.log('data inconsistency: ' + incons_detected);
					//check if we found metadata issue
					if (incons_detected){
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						console.log('problematic field:' + incons_field);
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						console.log('***********************');
						//we've got a problem, skip this post/guy. We might want to report too.
						continue;
					}
				}
				
				
				//check if the post has an encryption key val, and ensure it is the proper one
				if (post.json.actiCrVal){
					var txt_to_encr = post.author + post.permlink + post.json.step_count ;
					var cipher = crypto.createCipher(config.encr_mode, config.encr_key);
					let encr_txt = cipher.update(txt_to_encr, 'utf8', 'hex');
					encr_txt += cipher.final('hex');
					//test the result to the post's relevant data
					if (post.json.actiCrVal != encr_txt){
						//wrong, skip post
						utils.log('post has incorrect actiCrVal');
						continue;
					}
					//utils.log('post is valid');
				}else{
					utils.log('post does not contain actiCrVal');
					continue;
				}
					
				//console.log('still here');
				//moving this section before the actual token rewards
				
				//due to the difference in server times, a user's post might have same date created.
				//to avoid this issue, we will accept 2 posts for every user
				//so we will check if 2 posts are already accumulated for the user, and if so reject the third
				
				let last_index = _.findLastIndex(votePosts, ['author', post.author]);
				let first_index = _.findIndex(votePosts, ['author', post.author]);
				let skip_date_diff = false;
				
				//if both posts have the same date using new json metadata format, definitely bail out
				if (last_index != -1){
					utils.log('---- User has 2 posts, lets check if they have same target date ------');
					let last_voted = votePosts[last_index];
					let json_meta_vals = JSON.parse(last_voted.json_metadata);
					if ((typeof json_meta_vals.activityDate != 'undefined' && json_meta_vals.activityDate != '' && json_meta_vals.activityDate != 'undefined') &&
						(typeof post.json.activityDate != 'undefined' && post.json.activityDate != '' && post.json.activityDate != 'undefined')){
						//both posts have values and particularly same value
						if (json_meta_vals.activityDate.length == post.json.activityDate.length 
							&& json_meta_vals.activityDate.length > 0
							&& json_meta_vals.activityDate[0] == post.json.activityDate[0]){
							utils.log('same target date with value '+ json_meta_vals.activityDate + ' ...skipping');
							//skip new post
							skip_date_diff = true
						}else{
							utils.log('posts okay different dates');
						}
					}else{
						if (first_index!=last_index) {
							utils.log('---- User already has more than 2 posts in 24 hours ------');
					var last_date = moment(last_voted.created).format('D');
					let first_voted = votePosts[first_index];
					var first_date = moment(first_voted.created).format('D');
					var this_date = moment(post.created).format('D');
					//if all 3 dates match, skip it
					if ((last_date == this_date) && (first_date == this_date)) {
						utils.log('---- Last voted -----');
						utils.log(new Date (last_voted.created));
						utils.log('---- First voted -----');
						utils.log(new Date (first_voted.created));
						utils.log('---- This voted -----');
						utils.log(new Date (post.created));
						utils.log('---- Moment-----');
						utils.log(last_date);
						utils.log(first_date);
						utils.log(this_date);
						
						//skip new post
						skip_date_diff = true;
					}          
						}else{
							utils.log('reject a post if a prior one exists that is less than 6 hours away');
					utils.log(post.author+post.url);
					//adding condition to reject a post if a prior one exists that is less than 6 hours away
					//utils.log(last_voted.author+last_voted.url);
					var last_date = moment(last_voted.created).toDate();
					var this_date = moment(post.created).toDate();
					//check the hours difference
					var hours_diff = Math.abs(this_date - last_date) / 36e5;
					if (hours_diff<parseFloat(config.min_posting_hours_diff)){
						//skip new post
						utils.log('hours difference:'+hours_diff+'...skipping');
						
						skip_date_diff = true;
					}
					
				}
					}
				}
				
				
				//store this entry to db to make sure we skip it in future voting iterations
				if (skip_date_diff){
				  
				  let post_entry_skip = {
					author: post.author,
					permlink: post.permlink,
					date: new Date(post.created),
				  }
				
				  bulk_posts_skip.find(
					{ 
						author: post.author,
						permlink: post.permlink
					}).upsert().replaceOne(post_entry_skip);
					
				  continue;
				}
				
				
				/**************** Post Score calculation section *******************/
				
				/******************* activity count criteria *********************/
				
				//calculate activity count score
				post.activity_score = utils.calcScore(activity_rules, config.activity_factor, post.json.step_count);
				
				//console.log('step count:'+post.json.step_count);
				//console.log('activity score:'+post.activity_score);
				
				//skip post if it has less than min activity recorded
				if (post.activity_score == 0){
					continue;
				}
				
				/******************* content criteria *********************/
				const $ = cheerio.load('<div class="actifit_container">'+post.body+'</div>');
				
				//grab text without HTML, and remove extra spacing
				var pure_text = $('.actifit_container').text().replace(/\s+/g,' ');
				
				//calculate content score
				post.content_score = utils.calcScore(content_rules, config.content_factor, pure_text.length);
				
				/******************* media criteria *********************/
				
				
				//grab proper images, skipping our default images
				
				var new_imgs = 0;
				
				var recorded_imgs = [];
				//go through each image from the content and check if it matches one of our existing images
				$('img').each(function(i, elem) {
					//if this image is not part of ours, add it
					if (!actifit_img_urls.includes($(this).attr('src'))){
						new_imgs += 1;
						recorded_imgs.push($(this).attr('src'));
						//utils.log($(this).attr('src'));
					}
				});

				//grab listing of recorded images as part of json
				var json_img_list = post.json.image;
				
				//utils.log(json_img_list);
				
				//try to see if some images were not captured by our approach for HTML content, and grab them from json meta
				if (json_img_list.length>0){
					for (let img_entry of json_img_list) {
						//if this image is not part of ours, add it
						if (!actifit_img_urls.includes(img_entry) && !recorded_imgs.includes(img_entry)){
							new_imgs += 1;
							recorded_imgs.push(img_entry);
						}
					};
				}
				
				//utils.log('2>>>new_imgs:'+new_imgs);
				
				//utils.log('>>>> unique images:'+new_imgs);
				//calculate img score
				post.media_score = utils.calcScore(img_rules, config.media_factor, new_imgs);
				
				/******************* upvote criteria *********************/
				
				//calculate upvote score relying on positive votes only
				post.upvote_score = utils.calcScore(upv_rules, config.upvotes_factor, post.net_votes);
				//utils.log('upvotes:'+post.net_votes);
				
				/***************** moderator upvote factor ******************/
				
				//check if a moderator upvoted the post to give it better reward
				//we need to skip self-votes reward to avoid extra rewarding mods for self-votes
				post.moderator_score = 0;
				post.active_votes.some(function(vote){
					if (moderator_list.includes(vote.voter) && vote.voter != post.author){
						post.moderator_score = parseInt(config.moderator_upvote_factor);
						//utils.log('found moderator upvote'+vote.voter);
						return true;
					}
				});
				
				//utils.log(post.moderator_score);
				
				/******************* comments criteria *********************/
				var matching_comment_count = 0;
				//if (!config.testing){
					let comments = await steem.api.getContentRepliesAsync(post.author, post.permlink);
					
					for(var cmt_it = 0; cmt_it < comments.length; cmt_it++) {
						//utils.log('>>>>>>'+comments[cmt_it].body);
						const $ = cheerio.load('<div class="comment_container">'+comments[cmt_it].body+'</div>');
						var comment_pure = $('.comment_container').text().replace(/\s+/g,' ');
						//utils.log(comment_pure);
						if (comment_pure.length > 50){
							matching_comment_count += 1;
						}
						
						//check if the comment is made by a moderator, if it is we need to reward the moderator
						//we need to skip own comment reward to avoid extra rewarding mods
						if (moderator_list.includes(comments[cmt_it].author) && comments[cmt_it].author != post.author){
							let comment_transaction = {
								user: comments[cmt_it].author,
								reward_activity: 'Moderator Comment',
								token_count: parseInt(config.moderator_comment_reward),
								url: post.url,
								comment_url: comments[cmt_it].url,
								date: new Date(comments[cmt_it].created)
							}
							bulk_transactions.find(
							{ 
								user: comment_transaction.user,
								reward_activity: comment_transaction.reward_activity,
								url: comment_transaction.url,
								comment_url: comment_transaction.comment_url
							}).upsert().replaceOne(comment_transaction);
							utils.log('found comment>>>>');
							utils.log(comment_transaction);
						}
					}
				//}
				//utils.log("comments:"+matching_comment_count);
				//calculate comment score
				post.comment_score = utils.calcScore(cmts_rules, config.comments_factor, matching_comment_count);
				
				/******************* user rank criteria *********************/
				//var request = require('request');
				var rank_api_url = config.api_url+'getRank/'+post.author;
				var user_rank_info = await axios.get(rank_api_url);
				//utils.log(user_rank_info.user_rank);
				post.user_rank = user_rank_info.data.user_rank;
				//calculate user rank score relying on positive votes only
				post.user_rank_score = parseFloat(user_rank_info.data.user_rank)*parseInt(config.rank_factor)/100;
				//utils.log('rank'+post.user_rank_score);
				
				
				//calculate total post score
				post.post_score = post.activity_score + post.content_score + post.media_score + post.upvote_score + post.comment_score + post.moderator_score + post.user_rank_score;
				
				//rate multiplier to allow assigning proper steem upvote value per each post according to its post_score/afit payout
				post.rate_multiplier = post.post_score / 100;
				//post_scores.push([post.url,post.post_score]);
				//utils.log(post);
			
			} catch (err) {
			  utils.log('Error parsing json metadata');
			  utils.log(err);
			  continue;
			}
			
			//utils.log('Voting on: ' + post.url);
			votePosts.push(post);
			
			try{
				utils.log('going through selected post '+post.url);
				//insert post if not inserted before
				bulk.find( { permlink: post.permlink } ).upsert().replaceOne(
							   post
							);
				
				//post token rewards DB transaction
				
				//by default the reward owner is the author
				var reward_user = post.author;
				var activity_type = 'Post';
				var note = '';
				var result;
				//if we find this is a charity run, let's switch it to the actual charity name
				if (typeof post.json.charity != 'undefined' && post.json.charity != '' && post.json.charity != 'undefined'){
					reward_user = post.json.charity[0];
					activity_type = 'Charity Post';
					note = 'Charity donation via activity by user '+post.author;
				}
				let activity_afit_reward = post.post_score;
				//if this is a sponsored athlete, give them special reward
				if (config.sponsored_athletes.includes(reward_user)){
					activity_afit_reward = config.sponsored_athlete_afit_reward;
				}
				let post_transaction = {
					user: reward_user,
					reward_activity: activity_type,
					token_count: activity_afit_reward,
					url: post.url,
					date: new Date(post.created),
					note: note,
					reward_system: reward_sys_version
				}
				//also in case of charity, we need to append the actual user
				if (typeof post.json.charity != 'undefined' && post.json.charity != '' && post.json.charity != 'undefined'){
					post_transaction['giver'] = post.author;
				}
			  
				bulk_transactions.find(
				{ 
					user: post_transaction.user,
					reward_activity: post_transaction.reward_activity,
					url: post_transaction.url
				}).upsert().replaceOne(post_transaction); 
				
				//the proper transaction without reward
				if (typeof post.json.charity != 'undefined' && post.json.charity != '' && post.json.charity != 'undefined'){
					note = "Charity donation reference post transaction without rewards"
					let charity_trans = {
						user: post.author,
						reward_activity: 'Post',
						token_count: 0,
						url: post.url,
						date: new Date(post.created),
						note: note,
						charity: post.json.charity,
						reward_system: reward_sys_version
					}
					
					//we also need to insert another transaction to capture the actual activity/reward by the user
					bulk_transactions.find(
					{ 
						user: charity_trans.user,
						reward_activity: charity_trans.reward_activity,
						url: charity_trans.url
					}).upsert().replaceOne(charity_trans);
				
				}
				
				//reward upvoters
				//make sure we already have a positive rshares
				//switching to net_rshares as the older vote_rshares is deprecated
				var total_post_upv_shares = parseInt(post.net_rshares);
				//utils.log('total_post_upv_shares'+total_post_upv_shares);
				if (total_post_upv_shares>0){
					
					//calculate max token payment based upon post pending payout
					var max_afits = Math.min(parseFloat(post.pending_payout_value) * parseFloat(config.per_post_alloc_afits), parseFloat(config.per_post_alloc_afits));
					//utils.log('max afits '+max_afits);
					
					//utils.log(post.active_votes);
					post.active_votes.forEach(async vote => {

						//grab user's contribution to the upvote pool
						var upv_tokens = parseInt(vote.rshares);
						
						//skip votes of banned users
						var user_banned = false;
						for (var n = 0; n < banned_users.length; n++) {
							if (vote.voter == banned_users[n].user){
								utils.log('User '+vote.voter+' is banned, skipping his vote on post:' + post.url);
								user_banned = true;
								break;
							}
						} 
					
						//skip self vote from rewards and make sure this is a positive upvote
						if (post.author != vote.voter && upv_tokens>0 && !user_banned){
							//calculate the percentage of the user's contribution, and allocate him his AFIT tokens share
							var voter_tokens = upv_tokens / total_post_upv_shares * max_afits;
							//console.log(voter_tokens);
							voter_tokens = parseFloat(voter_tokens.toFixed(3));
							let used_date = vote.time;
							if (used_date == undefined || used_date == ''){
							  used_date = post.created;
							}
							let vote_transaction = {
								user: vote.voter,
								reward_activity: 'Post Vote',
								token_count: voter_tokens,
								url: post.url,
								date: new Date(used_date)//vote.time)
							}
							bulk_transactions.find(
							{ 
								user: vote_transaction.user,
								reward_activity: vote_transaction.reward_activity,
								url: vote_transaction.url
							}).upsert().replaceOne(vote_transaction);
							//transactions.push(vote_transaction);
							
							//utils.log(vote_transaction);
						}
					});
				}
				//result = posts_collection.insert(post);
			}catch(err){
				utils.log(err);
			}
		}//end of loop going through posts
		
		//properly stored any future skippable posts
		try{
			await bulk_posts_skip.execute();
		}catch(bulkerr){
			utils.log(bulkerr);
		}
		
		if (votePosts.length>0){
			try{
				//store posts
				await bulk.execute();
			}catch(bulkerr){
				utils.log(bulkerr);
			}
			try{
				//award transaction tokens
				bulk_transactions.execute();
			}catch(bulkerr){
				utils.log(bulkerr);
			}
		}
	  
	  
		//if this is the first try, or the new count of posts is bigger than the one before, let's try adding again
		if (!config.testing && (!subsequent || votePosts.length > lastIterationCount || queryCount < config.max_query_count)){
		
			//update last count
			lastIterationCount = votePosts.length;
			//call again with subsequent enabled to avoid duplicate posts, disparse the calls by 1 sec to avoid API timeouts
			utils.log("query:"+query['tag']);
			utils.log("query:"+query['start_permlink']);
			
			setTimeout(processVotes, 1000, query, true);
		
		}else{
			if (votePosts.length > 0) {
				utils.log(votePosts.length + ' posts to vote...');
				var vote_data = utils.calculateVotes(votePosts, config.vote_weight);
				
				
				//if (!config.testing){
					votePosts.sort(function(post1, post2) {
					  //Sort posts by reverse score, so as when popping them we get sorted by highest
					  return post1.post_score - post2.post_score;
					});
				//}
		
				
				utils.log(vote_data.power_per_vote + ' power per full vote.');
				
				
				/************************* winner reward ******************************/
			
				//let's pick a random winner to double up his votes and adjust his AFIT reward score
				
				try{
					lucky_winner_id = utils.generateRandomNumber(1, votePosts.length);
					let post = votePosts[lucky_winner_id];
					
					utils.log('before');
					utils.log(votePosts[lucky_winner_id].post_score);
					
					let reward_user = post.author;
					let activity_type = 'Post';
					let note = '';
					let reward_factor = 2;
					
					//if we find this is a charity run, let's switch it to the actual charity name
					if (typeof post.json.charity != 'undefined' && post.json.charity != '' && post.json.charity != 'undefined'){
						reward_user = post.json.charity[0];
						activity_type = 'Charity Post';
						note = 'Charity donation via actifit post by user '+post.author;
					}	
					
					var bulk_transactions = db.collection('token_transactions').initializeUnorderedBulkOp();
					
					let post_transaction = {
						user: reward_user,
						reward_activity: activity_type,
						token_count: post.post_score * reward_factor,
						orig_token_count: post.post_score,
						url: post.url,
						date: new Date(post.created),
						note: note,
						lucky_winner: 1,
						reward_factor: reward_factor,
						reward_system: reward_sys_version
					}
					
					//adjust post_score according to reward
					post.post_score = post.post_score * reward_factor;
					post.rate_multiplier = post.post_score / 100;
					post.reward_factor = reward_factor;
					post.lucky_winner = 1;
				  
					bulk_transactions.find(
					{ 
						user: post_transaction.user,
						reward_activity: post_transaction.reward_activity,
						url: post_transaction.url
					}).upsert().replaceOne(post_transaction); 		

					
					//award transaction tokens
					await bulk_transactions.execute();
				}catch(bulkerr){
					utils.log(bulkerr);
				}
				utils.log('after');
				utils.log(votePosts[lucky_winner_id].post_score);
				
				/***************** Check for AFIT/STEEM upvote exchange ******************/
				try{
				
					//assign an ID to this reward cycle
					let reward_cycle_ID = 'RC' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase()
					
					//calculate current vote value, and relating voting percentage needed
					//get vote value at 100%
					let full_vote_value = getVoteValueUSD(100, account, 100, sbd_price);
					console.log('full_vote_value')
					console.log(full_vote_value)
					
					console.log('topUsersAFITX')
					console.log(topUsersAFITX);
					
					//number of found exchanges to perform in coming round
					let matched_exchanges = 0;
					//number of entries, maximum set by config
					let list_length = Math.min(topUsersAFITX.length, config.topAFITXCount);
					
					
					//loop through top AFITX holders to get confirmed upvotes
					for (let xx=0 ; xx < list_length && matched_exchanges < config.max_afit_steem_upvotes_per_session ; xx++){
						let cur_top_entry = topUsersAFITX[xx];
						//find a matching report card, if exists
						console.log(cur_top_entry.account);
						let result = votePosts.find( user_post => user_post.author === cur_top_entry.account);
						console.log('matching priority post');
						//console.log(result);
						
						//also find matching exchange request
						
						let cur_upvote_entry = afit_steem_upvote_list.find( upvote_request => upvote_request.user === cur_top_entry.account);
						
						//console.log('cur_upvote_entry');
						
						//console.log(cur_upvote_entry);
						
						if (result && cur_upvote_entry){
							console.log('>>match found');
							matched_exchanges += 1;
							//found a match, need to increase rewards according to AFIT pay
							//calculate total paid AFIT in USD (which should be equal to a 65% reward, since Actifit removes 10% benefic, and author reward removes 75%
							let usd_val_no_benef = parseFloat(cur_upvote_entry.paid_afit) * parseFloat(cur_afit_price.unit_price_usd);
							
							//expand the USD val to take into consideration 75% curation reward
							let usd_val_no_curation = usd_val_no_benef * 0.75 / 0.65
							
							//final upvote value after avoiding deductions
							let usd_val = usd_val_no_benef / 0.65 
							
							//emulate proper voting power to give user matching rewards
							let user_added_vote_weight = usd_val * 100 / full_vote_value;
							
							let entry_index = votePosts.findIndex( user_post => user_post.author === cur_upvote_entry.user);
							
							//decrease by 1% since assisting accounts will vote too (pay & funds) only if we still have room to use them
							//only consume half of those now, leave the rest to other accounts
							if (helping_accounts_votes < (config.max_helping_votes / 2)){
								user_added_vote_weight -= 1;
								
								helping_accounts_votes += 1;
								
								votePosts[entry_index].helperVotes = true;
							}
							
							user_added_vote_weight = user_added_vote_weight.toFixed(2);
							
							votePosts[entry_index].additional_vote_weight = Math.floor(user_added_vote_weight * 100);
							votePosts[entry_index].afit_swapped = cur_upvote_entry.paid_afit;
							votePosts[entry_index].top_afitx_holder = 1;
							console.log('Additional Vote Weight for AFIT/STEEM Upvote Exchange: '+votePosts[entry_index].author + ' ' + votePosts[entry_index].url);
							console.log(votePosts[entry_index].additional_vote_weight);
							
							//we need to set params of this transaction
							cur_upvote_entry.additional_vote_weight = votePosts[entry_index].additional_vote_weight / 100;
							cur_upvote_entry.usd_val_no_benef = +usd_val_no_benef;
							cur_upvote_entry.usd_val_no_curation = +usd_val_no_curation.toFixed(2);
							cur_upvote_entry.usd_val = +usd_val.toFixed(2);
							
							cur_upvote_entry.reward_cycle_ID = reward_cycle_ID;
							
							cur_upvote_entry.top_afitx_holder = 1
							
							cur_upvote_entry.post_author = votePosts[entry_index].author;
							cur_upvote_entry.post_permlink = votePosts[entry_index].permlink;
							
							db.collection('exchange_afit_steem').save(cur_upvote_entry);
							
							//console.log(votePosts[entry_index]);
							
						}
					}
					
					console.log('afit_steem_upvote_list');
					console.log(afit_steem_upvote_list);
					
					//number of entries
					list_length = afit_steem_upvote_list.length;
					
					//loop through pending AFIT swaps, consuming older ones
					for (let xx=0 ; xx < list_length && matched_exchanges < config.max_afit_steem_upvotes_per_session ; xx++){
						let cur_upvote_entry = afit_steem_upvote_list[xx];
						//find a matching report card, if exists
						let result = votePosts.find( user_post => user_post.author === cur_upvote_entry.user);
						console.log('matching second post');
						//console.log(result);
						if (result != null){
							console.log('>>match found. Check if added already');
							//if this post has not been recorded yet
							if (!result.additional_vote_weight){
								console.log('fresh game');
							matched_exchanges += 1;
							//found a match, need to increase rewards according to AFIT pay
							//calculate total paid AFIT in USD (which should be equal to a 65% reward, since Actifit removes 10% benefic, and author reward removes 75%
							let usd_val_no_benef = parseFloat(cur_upvote_entry.paid_afit) * parseFloat(cur_afit_price.unit_price_usd);
							
							//expand the USD val to take into consideration 75% curation reward
							let usd_val_no_curation = usd_val_no_benef * 0.75 / 0.65
							
							//final upvote value after avoiding deductions
							let usd_val = usd_val_no_benef / 0.65 
							
							//emulate proper voting power to give user matching rewards
							let user_added_vote_weight = usd_val * 100 / full_vote_value;
							
							let entry_index = votePosts.findIndex( user_post => user_post.author === cur_upvote_entry.user);
							
							//decrease by 1% since assisting accounts will vote too (pay & funds) only if we still have room to use them
							if (helping_accounts_votes < config.max_helping_votes){
								user_added_vote_weight -= 1;
								
								helping_accounts_votes += 1;
								
								votePosts[entry_index].helperVotes = true;
							}
							
							user_added_vote_weight = user_added_vote_weight.toFixed(2);
							
							votePosts[entry_index].additional_vote_weight = Math.floor(user_added_vote_weight * 100);
							votePosts[entry_index].afit_swapped = cur_upvote_entry.paid_afit;
							console.log('Additional Vote Weight for AFIT/STEEM Upvote Exchange: '+votePosts[entry_index].author + ' ' + votePosts[entry_index].url);
							console.log(votePosts[entry_index].additional_vote_weight);
							
							//we need to set params of this transaction
							cur_upvote_entry.additional_vote_weight = votePosts[entry_index].additional_vote_weight / 100;
							cur_upvote_entry.usd_val_no_benef = +usd_val_no_benef;
							cur_upvote_entry.usd_val_no_curation = +usd_val_no_curation.toFixed(2);
							cur_upvote_entry.usd_val = +usd_val.toFixed(2);
							
							cur_upvote_entry.reward_cycle_ID = reward_cycle_ID;
							
							cur_upvote_entry.post_author = votePosts[entry_index].author;
							cur_upvote_entry.post_permlink = votePosts[entry_index].permlink;
							
							db.collection('exchange_afit_steem').save(cur_upvote_entry);
							}
						}
					}
					console.log('done going through pending AFIT to STEEM upvote exchange');
					console.log('matched_exchanges:'+matched_exchanges);
				}catch(err){
					utils.log(err);
				}
				
				/********************* proceed with STEEM upvotes ************************/
				
				votingProcess(votePosts, vote_data.power_per_vote);
			
			} else {
				utils.log('No posts to vote...');
				if(!error_sent) {
				  //errorEmail('No posts to vote...', config.report_emails);          
				  error_sent = true;
				}
			}
		}
      last_voted++;
    } else {
      utils.log(err, result);
	  //since we encountered an error, we need to restart the process
	  //is_voting = false;
	  setIsVoting(false);
	  votePosts = Array();
      //errorEmail(err, config.report_emails);
    }
  });
}

async function fetchAFITXBal(offset){
  try{
	  console.log('--- Fetch AFITX token balance --- '+offset);
	  console.log(offset);
	  let tempArr = await ssc.find('tokens', 'balances', { symbol : 'AFITX' }, 1000, offset, '', false) //max amount, offset,
	  if (offset == 0 && tempArr.length > 0){
		  console.log('>>Found new results, reset older ones');
		  //reset existing data if we have fresh new data
		  usersAFITXBal = [];
		  topUsersAFITX = [];
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
		}else{
			console.log('AFITX list fetching complete');
			usersAFITXBal = utils.sortArrLodash(usersAFITXBal);
			//skip first entry as thats Actifit account
			topUsersAFITX = usersAFITXBal.slice(1, config.topAFITXCount);
			
			console.log(topUsersAFITX);
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

var post_rank = 0;
function votingProcess(posts, power_per_vote) {
  // Get the first bid in the list
  sendVote(posts.pop(), 0, power_per_vote)
  .then( res => {
    // If there are more posts, vote on the next one after 5 seconds
    if (posts.length > 0) {
      setTimeout(function () { votingProcess(posts, power_per_vote); }, config.voting_posting_delay);
    } else {
	post_rank = 0;
      setTimeout(function () {
        utils.log('=======================================================');
        utils.log('Voting Complete!');
        utils.log('=======================================================');
        //is_voting = false;
		setIsVoting(false);
        error_sent = false;
        saveState();
		
		//since we're done voting, we need to update all user tokens to reflect new rewards
		updateUserTokens();
        //reportEmail(config.report_emails)
      }, config.voting_posting_delay);
    }
  })
  .catch(err => {
      utils.log(err);
  })
}


function sendVote(post, retries, power_per_vote) {
	utils.log('Voting on: ' + post.url + ' with count'+post.json.step_count);
	var token_count = post.post_score;//parseFloat(post.rate_multiplier)*100;
  
	var vote_weight = Math.floor(post.rate_multiplier * power_per_vote);
	let stdrd_vote_weight = vote_weight * config.partner_comm_vote_mult;
	console.log('vote weight:'+vote_weight);
	
	//if user had paid AFIT for extra STEEM upvotes, add this to their upvote value
	if (post.additional_vote_weight){
		vote_weight += post.additional_vote_weight
		console.log('new vote weight:'+vote_weight);
	}
	post_rank += 1;
	utils.log('|#'+post_rank+'|@'+post.author+'|'+ post.json.step_count +'|'+token_count+' Tokens|'+utils.format(vote_weight / 100)+'%|[post](https://www.steemit.com'+post.url+')');
  
	//if this is a sponsored athlete, give them special reward
	if (config.sponsored_athletes.includes(post.author)){
		vote_weight = config.sponsored_athlete_upvote_reward;
	}
  
  
	if (vote_weight > config.max_vote_per_post){
		vote_weight = config.max_vote_per_post;
	}
	
	if (stdrd_vote_weight > config.max_vote_per_post){
		stdrd_vote_weight = config.max_vote_per_post;
	}
	
	post.vote_weight = vote_weight;
	last_votes.push(post);

	return new Promise((resolve, reject) => {
		if(config.testing){
			//resolve('');
			
			//console.log(afit_steem_upvote_list);
			if (post.additional_vote_weight){
				console.log('Exchange vote');
				//store exchange transaction as complete
				let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
								entry.post_permlink === post.permlink && 
								entry.user === post.author);
				console.log(cur_upvote_entry);
				cur_upvote_entry.upvote_processed = true;
				db.collection('exchange_afit_steem').save(cur_upvote_entry);
			}
			
			if(config.comment_location && config.comment){
				setTimeout(function () { 	
					sendComment(post, 0, vote_weight)
						.then( res => {
							resolve('')
						})
						.catch(err => {
							reject(err);
						})
				}, config.voting_posting_delay);
			}else{
				resolve('');   
			}
		}else{
			//vote first using pay and funds accounts only if we have an AFIT/STEEM exchange operation and we have room to upvote using helping accounts
			if (post.additional_vote_weight && post.helperVotes){
				let vote_percent_add_accounts = config.helping_account_percent;//at 50%: 5000
				try{
					steem.broadcast.vote(config.full_pay_posting_key, config.full_pay_benef_account, post.author, post.permlink, vote_percent_add_accounts, function (err, result) {
						utils.log('voting with '+config.full_pay_benef_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);
						if (!err && result) {
							utils.log(err, result);
						}
					});
				}catch(err){
					utils.log(err);
				}
				try{
					steem.broadcast.vote(config.pay_account_post_key, config.pay_account, post.author, post.permlink, vote_percent_add_accounts, function (err, result) {
						utils.log('voting with '+config.pay_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);
						if (!err && result) {
							utils.log(err, result);
						}
					});
				}catch(err){
					utils.log(err);
				}
			}
			
			//if additional partner accounts enabled, vote using them as well
			try{
				if (config.zzan_active){
					steem.broadcast.vote(config.zzan_pk, config.zzan_account, post.author, post.permlink, stdrd_vote_weight, function (err, result) {
						utils.log('voting with '+config.zzan_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);
						if (!err && result) {
							utils.log(err, result);
						}
					});
				}
			}catch(err){
				utils.log(err);
			}
			
			try{
				if (config.sports_active){
					steem.broadcast.vote(config.sports_pk, config.sports_account, post.author, post.permlink, stdrd_vote_weight, function (err, result) {
						utils.log('voting with '+config.sports_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);
						if (!err && result) {
							utils.log(err, result);
						}
					});
				}
			}catch(err){
				utils.log(err);
			}
			
			steem.broadcast.vote(config.posting_key, account.name, post.author, post.permlink, vote_weight, function (err, result) {
				if (!err && result) {
					utils.log(utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);
					
					//store exchange transaction as complete
					if (post.additional_vote_weight){
						console.log('Exchange vote');
						let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
										entry.post_permlink === post.permlink && 
										entry.user === post.author);
						console.log(cur_upvote_entry);
						cur_upvote_entry.upvote_processed = true;
						db.collection('exchange_afit_steem').save(cur_upvote_entry);
					}

					if(config.comment_location && config.comment){
						setTimeout(function () { 	
							sendComment(post, 0, vote_weight)
								.then( res => {
									resolve(res)
								})
								.catch(err => {
									reject(err);
								})
						}, config.voting_posting_delay);
					}else{
						resolve(result);   
					}
				}else{
					utils.log(err, result);

					 // Try again one time on error
					if (retries < config.max_vote_comment_retries){
						//try to vote again
						setTimeout(function () { 	
							sendVote(post, retries + 1, power_per_vote)
								.then( res => {
									resolve(res)
								})
								.catch(err => {
									reject(err);
								})
						}, config.voting_posting_delay);
					}else {
						var message = '============= Vote transaction failed '+retries+' times for: ' + post.url + ' ==============='
						utils.log(message);
						reject(err);
					//errorEmail(message, config.report_emails);
					}
				}
			});
		}
	});
}


//function handles updating current user token count
async function updateUserTokens() {
	utils.log('---- Updating Users ----');
	let insert_res
	try{
		//group all token transactions per user, and sum them to generate new total count
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
		console.log('grab query all items');
		//remove old token count per user
		await db.collection('user_tokens').remove({});
		console.log('removed all entries');
		console.log(user_tokens);
		//insert new count per user
		insert_res = await db.collection('user_tokens').insertMany(user_tokens);
		console.log(insert_res.insertedCount);
		console.log('inserted all entries');
	}catch(err){
		console.log(insert_res);
		console.log(err);
		utils.log('>>save data error:'+err.message);
	}
}


function sendComment(post, retries, vote_weight) {
	var parentAuthor = post.author;
	var parentPermlink = post.permlink;
	var rate_multiplier = post.rate_multiplier;
	var post_step_count = post.json.step_count;
	
	var content = null;
	// Return promise
	return new Promise((resolve, reject) => {
		content = fs.readFileSync(config.comment_location, "utf8");

		// If promotion content is specified in the config then use it to comment on the upvoted post
		if (content && content != '') {

			// Generate the comment permlink via steemit standard convention
			var permlink = 're-' + parentAuthor.replace(/\./g, '') + '-' + parentPermlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();

			var token_count = post.post_score;//parseFloat(rate_multiplier)*100;
			
			//if this is a sponsored athlete, give them special reward
			if (config.sponsored_athletes.includes(parentAuthor)){
				token_count = config.sponsored_athlete_afit_reward;
			}
			
			// Replace variables in the promotion content
			content = content.replace(/\{weight\}/g, utils.format(vote_weight / 100)).replace(/\{token_count\}/g,token_count).replace(/\{step_count\}/g,post_step_count);
			
			//replace(/\{milestone\}/g, milestone_txt).
			
			//adding proper meta content for later relevant reward via afit_tokens data
			var jsonMetadata = { tags: ['actifit'], app: 'actifit/v'+version, activity_count: post_step_count, user_rank: post.user_rank, content_score: post.content_score, media_score: post.media_score, upvote_score: post.upvote_score, comment_score: post.comment_score, user_rank_score: post.user_rank_score, moderator_score: post.moderator_score, post_activity_score: post.activity_score, afit_tokens: token_count, post_upvote: vote_weight };
			
			//if this reward contains an exchange amount, list it here
			if (post.additional_vote_weight != null){
				jsonMetadata.promoted_post = true;
				jsonMetadata.additional_vote_weight = post.additional_vote_weight;
				console.log('new vote weight:'+vote_weight);
				content = content.replace(/\{exchange_vote}/g,'**'+utils.format(post.additional_vote_weight/100)+'% of this upvote value is a result of an exchange transaction you performed for '+post.afit_swapped+' AFIT tokens !**');
			}else{
				content = content.replace(/\{exchange_vote}/g,'') 
			}
			
			//if this is a top AFITX reward exchange
			if (post.top_afitx_holder != null){
				jsonMetadata.top_afitx_holder = true;
			}
			//if user is lucky winner, add a relevant message

			if (typeof post.lucky_winner != 'undefined' && post.lucky_winner != '' && post.lucky_winner != 'undefined'){
				content = content.replace(/\{lucky_reward}/g,'**You were also selected randomly as a LUCKY WINNER for the day. Your rewards were DOUBLED - DOUBLE CONGRATS!!**');
				jsonMetadata.lucky_winner = 1;
			}else{
				content = content.replace(/\{lucky_reward}/g,'') 
			}
			
			if (!config.testing){
				// Broadcast the comment
				steem.broadcast.comment(config.posting_key, parentAuthor, parentPermlink, account.name, permlink, permlink, content, jsonMetadata, function (err, result) {
					  if (!err && result) {
						utils.log('Posted comment: ' + permlink);
						resolve(result);
					  } else {
						utils.log('Error posting comment: ' + permlink);
						if (retries < config.max_vote_comment_retries){
							utils.log('Try again');
							setTimeout(function () { 	
								sendComment(post, retries + 1, vote_weight)
									.then( res => {
										resolve(res)
									})
									.catch(err => {
										reject(err);
									})
							}, config.voting_posting_delay);
						}
						//reject(err);
					  }
				});
			}else{
				utils.log('comment');
				console.log(content);
				console.log(jsonMetadata);
				resolve('');
			}
		}else{
			reject('Failed to load content');
		}
	});
  // Check if the bot should resteem this post
  /* if (config.resteem)
    resteem(parentAuthor, parentPermlink); */
}

function reportEmail(to) {

  var data = {};
  data.posts = last_votes;
  data.total_votes = _.sumBy(last_votes, 'net_votes');
  data.total_money = _.sumBy(last_votes, 'vote_weight');

  mail.sendWithTemplate('Report Mail', data, to, 'votes');
  last_votes = Array();

}

function errorEmail(message, to) {

  mail.sendPlainMail('Info Mail', message, to)
      .then(function(res, err) {
        if (!err) {
          utils.log(res);
        } else {
          utils.log(err);
        }
      });
}

function resteem(author, permlink) {
  var json = JSON.stringify(['reblog', {
    account: config.account,
    author: author,
    permlink: permlink
  }]);

  steem.broadcast.customJson(config.posting_key, [], [config.account], 'follow', json, (err, result) => {
    if (!err && result) {
      utils.log('Resteemed Post: @' + author + '/' + permlink);
    } else {
      utils.log('Error resteeming post: @' + author + '/' + permlink);
    }
  });
}

function saveState() {
  var state = {
    last_trans: last_trans,
    last_voted: last_voted,
    vote_time: new Date()
  };

  // Save the state of the bot to disk
  fs.writeFile('state.json', JSON.stringify(state), function (err) {
    if (err)
      utils.log(err);
  });
}

function loadConfig() {
  config = JSON.parse(fs.readFileSync("config.json"));
}

function sendPayment(to, amount, currency, reason, retries, data) {
  if(!retries)
    retries = 0;

  // Make sure the recipient isn't on the no-refund list (for exchanges and things like that).
  if (reason != 'forward_payment' && config.no_refund && config.no_refund.indexOf(to) >= 0) {
    utils.log("Payment not sent to: @" + to + " for: " + reason + ' because they are on the no_refund list.');
    return;
  }

  // Replace variables in the memo text
  var memo = config.transfer_memos[reason];
  memo = memo.replace(/{amount}/g, utils.format(amount, 3) + ' ' + currency);
  memo = memo.replace(/{currency}/g, currency);
  memo = memo.replace(/{account}/g, config.account);
  memo = memo.replace(/{to}/g, to);
  memo = memo.replace(/{tag}/g, data);

  // Issue the payment.
  steem.broadcast.transfer(config.active_key, config.account, to, utils.format(amount, 3) + ' ' + currency, memo, function (err, response) {
    if (err) {
      utils.log('Error sending payment to @' + to + ' for: ' + amount + ' ' + currency + ', Error: ' + err);

      // Try again on error
      if(retries < 2)
        setTimeout(function() { refund(to, amount, currency, reason, retries + 1, data) }, (Math.floor(Math.random() * 10) + 3) * 1000);
      else
        utils.log('============= Payment failed three times for: @' + to + ' ===============');
    } else {
      utils.log('Payment of ' + amount + ' ' + currency + ' sent to @' + to + ' for reason: ' + reason);
    }
  });
}

function claimRewards() {
	if (!config.auto_claim_rewards)
		return;

	// Make api call only if you have actual reward
	if (parseFloat(account.reward_steem_balance) > 0 || parseFloat(account.reward_sbd_balance) > 0 || parseFloat(account.reward_vesting_balance) > 0) {
		steem.broadcast.claimRewardBalance(config.posting_key, config.account, account.reward_steem_balance, account.reward_sbd_balance, account.reward_vesting_balance, function (err, result) {
			if (err) {
				utils.log(err);
			}

			if (result) {

				var rewards_message = "$$$ ==> Rewards Claim";
				if (parseFloat(account.reward_sbd_balance) > 0) { rewards_message = rewards_message + ' SBD: ' + parseFloat(account.reward_sbd_balance); }
				if (parseFloat(account.reward_steem_balance) > 0) { rewards_message = rewards_message + ' STEEM: ' + parseFloat(account.reward_steem_balance); }
				if (parseFloat(account.reward_vesting_balance) > 0) { rewards_message = rewards_message + ' VESTS: ' + parseFloat(account.reward_vesting_balance); }

				utils.log(rewards_message);

				// If there are liquid post rewards, withdraw them to the specified account
				if (parseFloat(account.reward_sbd_balance) > 0 && config.post_rewards_withdrawal_account && config.post_rewards_withdrawal_account != '') {

					// Send liquid post rewards to the specified account
					steem.broadcast.transfer(config.active_key, config.account, config.post_rewards_withdrawal_account, account.reward_sbd_balance, 'Liquid Post Rewards Withdrawal', function (err, response) {
						if (err){
							utils.log(err, response);
						}else{
							utils.log('$$$ Auto withdrawal - liquid post rewards: ' + account.reward_sbd_balance + ' sent to @' + config.post_rewards_withdrawal_account);
						}
					});
				}
			}
		});
	}
}
