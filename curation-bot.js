var fs = require("fs");
const steem = require('steem');
var utils = require('./utils');
var mail = require('./mail');
var _ = require('lodash');
var moment = require('moment');

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
var version = '0.0.1';
var error_sent = false;

steem.api.setOptions({ url: 'https://api.steemit.com' });//https://gtg.steem.house:8090

utils.log("* START - Version: " + version + " *");

// Load the settings from the config file
loadConfig();
var botNames;

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

startProcess();
// Schedule to run every minute
setInterval(startProcess, 60 * 1000);


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

      // Check if there are any rewards to claim.
      claimRewards();
    }
  });

  var oneMoreDay = new Date(new Date(vote_time).getTime() + (24 * 60 * 60 * 1000));
  var today = new Date();
  //deactivating condition of 24 hrs to pass
  var passedOneDay = true;//today >= oneMoreDay;

  if (account && !skip && !is_voting && passedOneDay) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    if (config.detailed_logging)
      utils.log('Voting Power: ' + utils.format(vp / 100) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));

    console.log('Voting Power: ' + utils.format(vp / 100) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp)));
    // We are at voting power kick start - time to vote!
    if (vp >= config.vp_kickstart) {
      skip = true;
	  
	  var query = {tag: config.main_tag, limit: 100};
	  votePosts = Array();
      processVotes(query, false);      
    }
    
  } else if(skip)
    skip = false;
  else if (!account)
    console.log('Loading account data...');
  else console.log('Voting... or waiting for a day to pass');
}

function processVotes(query, subsequent) {
  

  steem.api.getDiscussionsByCreated(query, function (err, result) {
    if (result && !err) {
      is_voting = true;
      
      utils.log(result.length + ' posts to process...');      

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
        // Make sure the post is less than 6.5 days
        /*if((new Date() - new Date(post.created + 'Z')) >= (6.5 * 24 * 60 * 60 * 1000)) {
          utils.log('This post is too old for a vote: ' + post.url);
          continue;
        }*/

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
		
		for (var n = 0; n < config.banned_users.length; n++) {
            if (post.author === config.banned_users[n]){
				utils.log('User '+post.author+' is banned, skipping his post:' + post.url);
				continue;
			}
          }   
        
		
		//skip any posts that are more than 1.5 days old
		if((new Date() - new Date(post.created + 'Z')) >= (1.5 * 24 * 60 * 60 * 1000)) {
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
          utils.log('Error parsing json metadata');
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
            console.log('Voting on: ' + post.url);
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
          console.log('Voting on: ' + post.url);
          votePosts.push(post);
        }        
      }
      /*let testPost = {rate_multiplier: 0.8};
      votePosts.push(testPost);*/
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
	        vote_data = utils.calculateVotes(votePosts, config.vote_weight);
	        votePosts.sort(function(post1, post2) {
	          // Ascending: first age less than the previous
	          return post1.json.step_count - post2.json.step_count;
	        });
	
	        //utils.log(vote_data.total_votes + ' total votes to divide.');
	        utils.log(vote_data.power_per_vote + ' power per full vote.');
	        utils.log(vote_data.power_per_vote * 0.8 + ' power per second vote.');
	        utils.log(vote_data.power_per_vote * 0.65 + ' power per third vote.');
	        utils.log(vote_data.power_per_vote * 0.5 + ' power per fourth vote.');
	        utils.log(vote_data.power_per_vote * 0.35 + ' power per fifth vote.');
	        utils.log(vote_data.power_per_vote * 0.2 + ' power per lowest vote.');
	        if(config.testing)
	          return;
	        else
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
  sendVote(posts.pop(), 20, power_per_vote)
  .then( res => {
    // If there are more bids, vote on the next one after 10 seconds
    if (posts.length > 0) {
      setTimeout(function () { votingProcess(posts, power_per_vote); }, 10000);
    } else {
	post_rank = 0;
      setTimeout(function () {
        utils.log('=======================================================');
        utils.log('Voting Complete!');
        utils.log('=======================================================');
        is_voting = false;
        error_sent = false;
        saveState();
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
  var token_count = parseFloat(post.rate_multiplier)*100;
  
  var vote_weight = Math.ceil(post.rate_multiplier * power_per_vote);
  post_rank += 1;
  utils.log('|#'+post_rank+'|@'+post.author+'|'+ post.json.step_count +'|'+token_count+' Tokens|'+utils.format(vote_weight / 100)+'%|[post](https://www.steemit.com'+post.url+')');
  
  if (vote_weight > config.max_vote_per_post){
		vote_weight = config.max_vote_per_post;
	}
  post.vote_weight = vote_weight;
  last_votes.push(post);

  return new Promise((resolve, reject) => {
    steem.broadcast.vote(config.posting_key, account.name, post.author, post.permlink, vote_weight, function (err, result) {
        if (!err && result) {
            utils.log(utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);

            if(config.comment_location && config.comment)
                setTimeout(function () { 
                    sendComment(post.author, post.permlink, vote_weight, post.rate_multiplier, post.json.step_count)
                        .then( res => {
                            resolve(res)
                        })
                        .catch(err => {
                            reject(err);
                        })
                }, 10000);
            else 
                resolve(result);   
        } else {
            utils.log(err, result);

             // Try again one time on error
            if (retries < 1)
            sendVote(post, retries + 1);
            else {
            var message = '============= Vote transaction failed '+retries+' times for: ' + post.url + ' ==============='
            utils.log(message);
            reject(err);
            //errorEmail(message, config.report_emails);
            }
        }
    });
  });
}

function sendComment(parentAuthor, parentPermlink, vote_weight, rate_multiplier, post_step_count) {
  var content = null;
  // Return promise
  return new Promise((resolve, reject) => {
  content = fs.readFileSync(config.comment_location, "utf8");

  // If promotion content is specified in the config then use it to comment on the upvoted post
  if (content && content != '') {

    // Generate the comment permlink via steemit standard convention
    var permlink = 're-' + parentAuthor.replace(/\./g, '') + '-' + parentPermlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();

	var token_count = parseFloat(rate_multiplier)*100;
	var milestone_txt = "level 1 milestone";
	if(token_count < 36)
		milestone_txt = "level 2 milestone";
	else if(token_count < 51)
		milestone_txt = "level 3 milestone";
	else if(token_count < 66)
		milestone_txt = "level 4 milestone";
	else if(token_count < 81)
		milestone_txt = "level 5 milestone";
	else
		milestone_txt = "the top level milestone";

	
    // Replace variables in the promotion content
    content = content.replace(/\{weight\}/g, utils.format(vote_weight / 100)).replace(/\{milestone\}/g, milestone_txt).replace(/\{token_count\}/g,token_count).replace(/\{step_count\}/g,post_step_count);

    
      // Broadcast the comment
      steem.broadcast.comment(config.posting_key, parentAuthor, parentPermlink, account.name, permlink, permlink, content, '{"app":"communitybot/' + version + '"}', function (err, result) {
          if (!err && result) {
          utils.log('Posted comment: ' + permlink);
          resolve(result);
          } else {
          utils.log('Error posting comment: ' + permlink);
          reject(err);
          }
      });
  } else
    reject('Failed to load content');
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
            if (err)
              utils.log(err, response);
            else {
              utils.log('$$$ Auto withdrawal - liquid post rewards: ' + account.reward_sbd_balance + ' sent to @' + config.post_rewards_withdrawal_account);
            }
          });
        }
      }
    });
  }
}
