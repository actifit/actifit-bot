var fs = require("fs");
const steem = require('steem');
var utils = require('./utils');
var mail = require('./mail');
var _ = require('lodash');
var moment = require('moment');
const MongoClient = require('mongodb').MongoClient;

const cheerio = require('cheerio')
const axios = require('axios');

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

//version of the reward system
var reward_sys_version = 'v0.2';

var error_sent = false;

var crypto = require('crypto');

const activity_rules = [
	[4999,0],
	[5999,0.20],
	[6999,0.35],
	[7999,0.50],
	[8999,0.65],
	[9999,0.80],
	[10000,1.00]
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

steem.api.setOptions({ url: 'https://api.steemit.com' });//https://gtg.steem.house:8090
//steem.api.setOptions({ url: 'https://gtg.steem.house:8090' });

utils.log("* START - Version: " + version + " *");

// Load the settings from the config file
loadConfig();
var botNames;


// Connection URL
var url = config.mongo_uri;

//check if this is a test scenario to use local DB url
if (config.testing){
	url = config.mongo_local;
}
console.log('db url:'+url);
var db;
var collection;

var db_name = config.db_name;
const collection_name = 'banned_accounts';

var banned_users;

var moderator_list;

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
	  console.log("Connected successfully to server");

	  db = client.db(db_name);

	  // Get the documents collection
	  collection = db.collection(collection_name);
	  //only start the process once we connected to the DB
startProcess();
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

async function startProcess() {
  if(!botNames)
    botNames = await utils.loadBots();
  if (config.detailed_logging)
    console.log('Start process');
  // Load the settings from the config file each time so we can pick up any changes
  loadConfig();

  // Load the bot account info
  steem.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      console.log(err, result);
    else {
      account = result[0];

    }
  });

  var oneMoreDay = new Date(new Date(vote_time).getTime() + (24 * 60 * 60 * 1000));
  var today = new Date();
  //deactivating condition of 24 hrs to pass
  var passedOneDay = true;//today >= oneMoreDay;

  //console.log('found banned users');
  //console.log(banned_users);
  
  /*for (var n = 0; n < banned_users.length; n++) {
  console.log(banned_users[n].user);
            //if (post.author == banned_users[n].user){
				//utils.log('User '+post.author+' is banned, skipping his post:' + post.url);
				//user_banned = true;
				//break;
			//}
          }
  return;*/

  if (account && !skip && !is_voting && passedOneDay) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    if (config.detailed_logging)
      utils.log('Voting Power: ' + utils.format(vp) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));

    console.log('Voting Power: ' + utils.format(vp) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));
	
    // We are at voting power kick start - time to vote!
	//console.log(vp >= parseFloat(config.vp_kickstart)/100);
    if (vp >= parseFloat(config.vp_kickstart)/100 || config.testing) {
		// Check if there are any rewards to claim before voting
		if (!config.testing){
			claimRewards();
		}
	
		console.log('lets vote');
      skip = true;
	  
		console.log('fetch banned users list');  
		//grab banned user list before rewarding
		banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
	  
		//grab list of moderators
		var moderator_api_url = config.api_url+'moderators';
		var moderator_info = await axios.get(moderator_api_url);
		console.log(moderator_info.data);
		var moderator_array = moderator_info.data;
		moderator_list = [];
		for (var mod_it=0;mod_it<moderator_array.length;mod_it++){
			moderator_list.push(moderator_array[mod_it].name);
		}
		console.log(moderator_list);
	  
	  var query = {tag: config.main_tag, limit: 100};
	  votePosts = Array();
      processVotes(query, false);      
    }else{
		//if we're not voting, let's check to claim some more discounted account spots
		utils.getRC(config.account).then(function(results){
			console.log('Current RC: ' + utils.format(results.estimated_pct) + '% | Time until full: ' + utils.toTimer(results.fullin));
			if (results.estimated_pct>config.account_claim_rc_min){
				//if we reached min threshold, claim more spots for discounted accounts
				utils.claimDiscountedAccount();
			}
			
		}, function(err) {
			console.log("Error fetching RC");
			console.log(err);
		});
    }
    
  } else if(skip)
    skip = false;
  else if (!account)
    console.log('Loading account data...');
  else console.log('Voting... or waiting for a day to pass');
}
//var post_scores = [];
function processVotes(query, subsequent) {
  

  steem.api.getDiscussionsByCreated(query, async function (err, result) {
    if (result && !err) {
      is_voting = true;
      
      utils.log(result.length + ' posts to process...');      

		//initialize inserting posts to db
		
		var bulk = db.collection('posts').initializeUnorderedBulkOp();
		
		//connect to the token_transactions table to start rewarding
		var bulk_transactions = db.collection('token_transactions').initializeUnorderedBulkOp();
		
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
				utils.log('storing last post iteration: ' + post.url);
				//update query element to include the most recent post for a starting point of the next iteration
				query['start_permlink'] = post.permlink;
				query['start_author'] = post.author;									
			}

        // Make sure the post is older than config time
        if (new Date(post.created) >= new Date(new Date().getTime() - (config.min_hours * 60 * 60 * 1000))) { 
          utils.log('This post is too new for a vote: ' + post.url);
          continue;
        }

        // Check if the bot already voted on this post
        if(post.active_votes.find(v => v.voter == 'actifit')) {
          utils.log('Bot already voted on: ' + post.url);
          continue;
        }

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
		
		//skip any posts that are more than 1.5 days old
		if((new Date() - new Date(post.created + 'Z')) >= (config.max_days * 24 * 60 * 60 * 1000)) {
			continue;
		}
			
        try {
			
          post.json = JSON.parse(post.json_metadata);
		
		
		//check if the post has an encryption key val, and ensure it is the proper one
		if (post.json.actiCrVal){
					var txt_to_encr = post.author + post.permlink + post.json.step_count ;
			var cipher = crypto.createCipher(config.encr_mode, config.encr_key);
			let encr_txt = cipher.update(txt_to_encr, 'utf8', 'hex');
			encr_txt += cipher.final('hex');
			//test the result to the post's relevant data
			if (post.json.actiCrVal != encr_txt){
				//wrong, skip post
				console.log('post has incorrect actiCrVal');
				continue;
			}
			//console.log('post is valid');
		}else{
			console.log('post does not contain actiCrVal');
			continue;
		}

				/**************** Post Score calculation section *******************/
				
				/******************* activity count criteria *********************/
				
				//calculate activity count score
				post.activity_score = utils.calcScore(activity_rules, config.activity_factor, post.json.step_count);
				
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
						//console.log($(this).attr('src'));
					}
				});

				//grab listing of recorded images as part of json
				var json_img_list = post.json.image;
				
				//console.log(json_img_list);
				
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
				
				//console.log('2>>>new_imgs:'+new_imgs);
				
				//console.log('>>>> unique images:'+new_imgs);
				//calculate img score
				post.media_score = utils.calcScore(img_rules, config.media_factor, new_imgs);
				
				/******************* upvote criteria *********************/
				
				//calculate upvote score relying on positive votes only
				post.upvote_score = utils.calcScore(upv_rules, config.upvotes_factor, post.net_votes);
				//console.log('upvotes:'+post.net_votes);
				
				/***************** moderator upvote factor ******************/
				
				//check if a moderator upvoted the post to give it better reward
				post.moderator_score = 0;
				post.active_votes.some(function(vote){
					if (moderator_list.includes(vote.voter)){
						post.moderator_score = parseInt(config.moderator_upvote_factor);
						//console.log('found moderator upvote'+vote.voter);
						return true;
					}
				});
				
				//console.log(post.moderator_score);
				
				/******************* comments criteria *********************/
				
				
				let comments = await steem.api.getContentRepliesAsync(post.author, post.permlink);
				var matching_comment_count = 0;
				for(var cmt_it = 0; cmt_it < comments.length; cmt_it++) {
					//console.log('>>>>>>'+comments[cmt_it].body);
					const $ = cheerio.load('<div class="comment_container">'+comments[cmt_it].body+'</div>');
					var comment_pure = $('.comment_container').text().replace(/\s+/g,' ');
					//console.log(comment_pure);
					if (comment_pure.length > 50){
						matching_comment_count += 1;
					}
					
					//check if the comment is made by a moderator, if it is we need to reward the moderator
					if (moderator_list.includes(comments[cmt_it].author)){
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
						console.log('found comment>>>>');
						console.log(comment_transaction);
					}
				}
				//console.log("comments:"+matching_comment_count);
				//calculate comment score
				post.comment_score = utils.calcScore(cmts_rules, config.comments_factor, matching_comment_count);
				
				/******************* user rank criteria *********************/
				//var request = require('request');
				var rank_api_url = config.api_url+'getRank/'+post.author;
				var user_rank_info = await axios.get(rank_api_url);
				//console.log(user_rank_info.user_rank);
				post.user_rank = user_rank_info.data.user_rank;
				//calculate user rank score relying on positive votes only
				post.user_rank_score = parseFloat(user_rank_info.data.user_rank)*parseInt(config.rank_factor)/100;
				//console.log('rank'+post.user_rank_score);
				
				
				//calculate total post score
				post.post_score = post.activity_score + post.content_score + post.media_score + post.upvote_score + post.comment_score + post.moderator_score + post.user_rank_score;
				
				//rate multiplier to allow assigning proper steem upvote value per each post according to its post_score/afit payout
				post.rate_multiplier = post.post_score / 100;
				//post_scores.push([post.url,post.post_score]);
				//console.log(post);
			
			} catch (err) {
			  console.log('Error parsing json metadata');
			  console.log(err);
			  continue;
			}
		
			//due to the difference in server times, a user's post might have same date created.
			//to avoid this issue, we will accept 2 posts for every user
			//so we will check if 2 posts are already accumulated for the user, and if so reject the third
		
        let last_index = _.findLastIndex(votePosts, ['author', post.author]);
			let first_index = _.findIndex(votePosts, ['author', post.author]);
			
			if (last_index != -1 && (first_index!=last_index)) {
				console.log('---- User already has more than 2 posts in 24 hours ------');
          let last_voted = votePosts[last_index];
          var last_date = moment(last_voted.created).format('D');
				let first_voted = votePosts[first_index];
				var first_date = moment(first_voted.created).format('D');
          var this_date = moment(post.created).format('D');
				//if all 3 dates match, skip it
				if ((last_date == this_date) && (first_date == this_date)) {
            console.log('---- Last voted -----');
            console.log(new Date (last_voted.created));
					console.log('---- First voted -----');
					console.log(new Date (first_voted.created));
            console.log('---- This voted -----');
            console.log(new Date (post.created));
            console.log('---- Moment-----');
            console.log(last_date);
					console.log(first_date);
            console.log(this_date);
					continue;
          }          
			}else if (last_index != -1){
				console.log('last_index:'+last_index);
				console.log(post.author+post.url);
				//adding condition to reject a post if a prior one exists that is less than 6 hours away
				let last_voted = votePosts[last_index];
				//console.log(last_voted.author+last_voted.url);
				var last_date = moment(last_voted.created).toDate();
				var this_date = moment(post.created).toDate();
				//check the hours difference
				var hours_diff = Math.abs(this_date - last_date) / 36e5;
				if (hours_diff<parseFloat(config.min_posting_hours_diff)){
					//skip new post
					console.log('hours difference:'+hours_diff+'...skipping');
					continue;
				}
				
        }        
			
			
			console.log('Voting on: ' + post.url);
			votePosts.push(post);
			
			try{
				console.log('going through '+post.url);
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
					reward_user = post.json.charity;
					activity_type = 'Charity Post';
					note = 'Charity donation via activity by user '+post.author;
				}		
				let post_transaction = {
					user: reward_user,
					reward_activity: activity_type,
					token_count: post.post_score,
					url: post.url,
					date: new Date(post.created),
					note: note,
					reward_system: reward_sys_version
				}
			  
				bulk_transactions.find(
				{ 
					user: post_transaction.user,
					reward_activity: post_transaction.reward_activity,
					url: post_transaction.url
				}).upsert().replaceOne(post_transaction); 
				
				//reward upvoters
				//make sure we already have a positive rshares
				var total_post_upv_shares = parseInt(post.vote_rshares);
				if (total_post_upv_shares>0){
					
					//calculate max token payment based upon post pending payout
					var max_afits = Math.min(parseFloat(post.pending_payout_value) * parseFloat(config.per_post_alloc_afits), parseFloat(config.per_post_alloc_afits));
					//console.log('max afits '+max_afits);
					post.active_votes.forEach(async vote => {

						//grab user's contribution to the upvote pool
						var upv_tokens = parseInt(vote.rshares);
					
						//skip self vote from rewards and make sure this is a positive upvote
						if (post.author != vote.voter && upv_tokens>0){
							//calculate the percentage of the user's contribution, and allocate him his AFIT tokens share
							var voter_tokens = upv_tokens / total_post_upv_shares * max_afits;
							voter_tokens = parseFloat(voter_tokens.toFixed(3));
							let vote_transaction = {
								user: vote.voter,
								reward_activity: 'Post Vote',
								token_count: voter_tokens,
								url: post.url,
								date: new Date(vote.time)
      }
							bulk_transactions.find(
							{ 
								user: vote_transaction.user,
								reward_activity: vote_transaction.reward_activity,
								url: vote_transaction.url
							}).upsert().replaceOne(vote_transaction);
							//transactions.push(vote_transaction);
							
							//console.log(vote_transaction);
						}
					});
				}
				//result = posts_collection.insert(post);
			}catch(err){
				console.log(err);
			}
		}//end of loop going through posts
		
		if (votePosts.length>0){
			try{
				//store posts
				await bulk.execute();
				//award transaction tokens
				bulk_transactions.execute();
			}catch(bulkerr){
				console.log(bulkerr);
			}
		}
	  
	  
		//if this is the first try, or the new count of posts is bigger than the one before, let's try adding again
		if (!subsequent || votePosts.length>lastIterationCount){
		
			//update last count
			lastIterationCount = votePosts.length;
			//call again with subsequent enabled to avoid duplicate posts, disparse the calls by 1 sec to avoid API timeouts
			console.log("query:"+query['tag']);
			console.log("query:"+query['start_permlink']);
			setTimeout(processVotes, 1000, query, true);
		
		}else{


	      if (votePosts.length > 0) {
	        utils.log(votePosts.length + ' posts to vote...');
				var vote_data = utils.calculateVotes(votePosts, config.vote_weight);
	        votePosts.sort(function(post1, post2) {
				  //Sort posts by reverse score, so as when popping them we get sorted by highest
				  return post1.post_score - post2.post_score;
	        });
	
				
	        utils.log(vote_data.power_per_vote + ' power per full vote.');
				/*utils.log(vote_data.power_per_vote * 0.8 + ' power per second vote.');
	        utils.log(vote_data.power_per_vote * 0.65 + ' power per third vote.');
	        utils.log(vote_data.power_per_vote * 0.5 + ' power per fourth vote.');
	        utils.log(vote_data.power_per_vote * 0.35 + ' power per fifth vote.');
				utils.log(vote_data.power_per_vote * 0.2 + ' power per lowest vote.');*/
				
				var tot_weight = 0;
				for (var xx=0;xx<votePosts.length;xx++){
					var vote_weight = Math.floor(votePosts[xx].rate_multiplier * vote_data.power_per_vote);
					console.log('url:'+votePosts[xx].url+' VP:'+vote_weight)
					tot_weight += vote_weight;
				}
				console.log('total weight consumed'+tot_weight);
				
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
      console.log(err, result);
      //errorEmail(err, config.report_emails);
    }
  });
}
var post_rank = 0;
function votingProcess(posts, power_per_vote) {
  // Get the first bid in the list
  sendVote(posts.pop(), 0, power_per_vote)
  .then( res => {
    // If there are more posts, vote on the next one after 5 seconds
    if (posts.length > 0) {
      setTimeout(function () { votingProcess(posts, power_per_vote); }, 3000);
    } else {
	post_rank = 0;
      setTimeout(function () {
        utils.log('=======================================================');
        utils.log('Voting Complete!');
        utils.log('=======================================================');
        is_voting = false;
        error_sent = false;
        saveState();
		
		//since we're done voting, we need to update all user tokens to reflect new rewards
		updateUserTokens();
        //reportEmail(config.report_emails)
      }, 5000);
    }
  })
  .catch(err => {
      console.log(err);
  })
}

function sendVote(post, retries, power_per_vote) {
  utils.log('Voting on: ' + post.url + ' with count'+post.json.step_count);
	var token_count = post.post_score;//parseFloat(post.rate_multiplier)*100;
  
	var vote_weight = Math.floor(post.rate_multiplier * power_per_vote);
  post_rank += 1;
  utils.log('|#'+post_rank+'|@'+post.author+'|'+ post.json.step_count +'|'+token_count+' Tokens|'+utils.format(vote_weight / 100)+'%|[post](https://www.steemit.com'+post.url+')');
  
  if (vote_weight > config.max_vote_per_post){
		vote_weight = config.max_vote_per_post;
	}
  post.vote_weight = vote_weight;
  last_votes.push(post);

  return new Promise((resolve, reject) => {
		if(config.testing){
			//resolve('');
			if(config.comment_location && config.comment){
				setTimeout(function () { 	
					sendComment(post, vote_weight)
						.then( res => {
							resolve('')
						})
						.catch(err => {
							reject(err);
						})
				}, 3000);
			}else{
				resolve('');   
			}
		}else{
    steem.broadcast.vote(config.posting_key, account.name, post.author, post.permlink, vote_weight, function (err, result) {
        if (!err && result) {
            utils.log(utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);

					if(config.comment_location && config.comment){
                setTimeout(function () { 
							sendComment(post, vote_weight)
                        .then( res => {
                            resolve(res)
                        })
                        .catch(err => {
                            reject(err);
                        })
                }, 3000);
					}else{
                resolve(result);   
					}
        } else {
            utils.log(err, result);

             // Try again one time on error
					if (retries < 10)
            sendVote(post, retries + 1);
            else {
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
	console.log('---- Updating Users ----');

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
		//remove old token count per user
		await db.collection('user_tokens').remove({});
		//insert new count per user
		await db.collection('user_tokens').insert(user_tokens);
	}catch(err){
		console.log('>>save data error:'+err.message);
	}
}


function sendComment(post, vote_weight) {
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
	
    // Replace variables in the promotion content
			content = content.replace(/\{weight\}/g, utils.format(vote_weight / 100)).replace(/\{token_count\}/g,token_count).replace(/\{step_count\}/g,post_step_count);

			//replace(/\{milestone\}/g, milestone_txt).
    
			//adding proper meta content for later relevant reward via afit_tokens data
			var jsonMetadata = { tags: ['actifit'], app: 'actifit/v'+version, activity_count: post_step_count, user_rank: post.user_rank, content_score: post.content_score, media_score: post.media_score, upvote_score: post.upvote_score, comment_score: post.comment_score, user_rank_score: post.user_rank_score, moderator_score: post.moderator_score, post_activity_score: post.activity_score, afit_tokens: token_count, post_upvote: vote_weight };
			if (!config.testing){
      // Broadcast the comment
		steem.broadcast.comment(config.posting_key, parentAuthor, parentPermlink, account.name, permlink, permlink, content, jsonMetadata, function (err, result) {
          if (!err && result) {
          utils.log('Posted comment: ' + permlink);
          resolve(result);
          } else {
          utils.log('Error posting comment: ' + permlink);
          reject(err);
          }
      });
			}else{
				console.log('comment');
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
          console.log(res);
        } else {
          console.log(err);
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
