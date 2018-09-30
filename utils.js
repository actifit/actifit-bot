var fs = require("fs");
const steem = require('steem');
var _ = require('lodash');
const axios = require('axios');
var config;

steem.api.setOptions({ url: 'https://api.steemit.com' });

var STEEMIT_100_PERCENT = 10000;
var STEEMIT_VOTE_REGENERATION_SECONDS = (5 * 60 * 60 * 24);
var HOURS = 60 * 60;

 var steemPrice;
 var rewardBalance;
 var recentClaims;
 var currentUserAccount;
 var votePowerReserveRate;
 var totalVestingFund;
 var totalVestingShares;
 var botNames;
 
 function updateSteemVariables() {
     steem.api.getRewardFund("post", function (e, t) {
         console.log(e,t);
         rewardBalance = parseFloat(t.reward_balance.replace(" STEEM", ""));
         recentClaims = t.recent_claims;
     });
     steem.api.getCurrentMedianHistoryPrice(function (e, t) {
         steemPrice = parseFloat(t.base.replace(" SBD", "")) / parseFloat(t.quote.replace(" STEEM", ""));
     });
     steem.api.getDynamicGlobalProperties(function (e, t) {
         votePowerReserveRate = t.vote_power_reserve_rate;
         totalVestingFund = parseFloat(t.total_vesting_fund_steem.replace(" STEEM", ""));
         totalVestingShares = parseFloat(t.total_vesting_shares.replace(" VESTS", ""));
     });

     setTimeout(updateSteemVariables, 180 * 1000)
 }
 // updateSteemVariables();

 /*function getVotingPower(account) {
     var voting_power = account.voting_power;
     var last_vote_time = new Date((account.last_vote_time) + 'Z');
     var elapsed_seconds = (new Date() - last_vote_time) / 1000;
     var regenerated_power = Math.round((STEEMIT_100_PERCENT * elapsed_seconds) / STEEMIT_VOTE_REGENERATION_SECONDS);
     var current_power = Math.min(voting_power + regenerated_power, STEEMIT_100_PERCENT);
     return current_power;
 }*/
 
	//fixed implementation of proper voting power calculation
	function getVotingPower(account) {
		const totalShares = parseFloat(account.vesting_shares) + parseFloat(account.received_vesting_shares) - parseFloat(account.delegated_vesting_shares) - parseFloat(account.vesting_withdraw_rate);

            const elapsed = Math.floor(Date.now() / 1000) - account.voting_manabar.last_update_time;
            const maxMana = totalShares * 1000000;
            // 432000 sec = 5 days
            let currentMana = parseFloat(account.voting_manabar.current_mana) + elapsed * maxMana / 432000;

            if (currentMana > maxMana) {
                currentMana = maxMana;
            }

            const currentManaPerc = currentMana * 100 / maxMana;
			
			console.log(currentManaPerc);
		return currentManaPerc;
 }

 function getVoteRShares(voteWeight, account, power) {
     if (!account) {
         return;
     }

     if (rewardBalance && recentClaims && steemPrice && votePowerReserveRate) {

         var effective_vesting_shares = Math.round(getVestingShares(account) * 1000000);
         var voting_power = account.voting_power;
         var weight = voteWeight * 100;
         var last_vote_time = new Date((account.last_vote_time) + 'Z');


         var elapsed_seconds = (new Date() - last_vote_time) / 1000;
         var regenerated_power = Math.round((STEEMIT_100_PERCENT * elapsed_seconds) / STEEMIT_VOTE_REGENERATION_SECONDS);
         var current_power = power || Math.min(voting_power + regenerated_power, STEEMIT_100_PERCENT);
         var max_vote_denom = votePowerReserveRate * STEEMIT_VOTE_REGENERATION_SECONDS / (60 * 60 * 24);
         var used_power = Math.round((current_power * weight) / STEEMIT_100_PERCENT);
         used_power = Math.round((used_power + max_vote_denom - 1) / max_vote_denom);

         var rshares = Math.round((effective_vesting_shares * used_power) / (STEEMIT_100_PERCENT))

         return rshares;

     }
 }

 function getVoteValue(voteWeight, account, power) {
     if (!account) {
         return;
     }
     if (rewardBalance && recentClaims && steemPrice && votePowerReserveRate) {
         var voteValue = getVoteRShares(voteWeight, account, power)
           * rewardBalance / recentClaims
           * steemPrice;

         return voteValue;

     }
 }

function timeTilFullPower(cur_power){
     return (STEEMIT_100_PERCENT - cur_power) * STEEMIT_VOTE_REGENERATION_SECONDS / STEEMIT_100_PERCENT;
 }

 function getVestingShares(account) {
     var effective_vesting_shares = parseFloat(account.vesting_shares.replace(" VESTS", ""))
       + parseFloat(account.received_vesting_shares.replace(" VESTS", ""))
       - parseFloat(account.delegated_vesting_shares.replace(" VESTS", ""));
     return effective_vesting_shares;
 }

 function getCurrency(amount) {
   return amount.substr(amount.indexOf(' ') + 1);
 }
 
 function loadUserList(location, callback) {
  if(!location) {
    if(callback)
      callback(null);

    return;
  }

  if (location.startsWith('http://') || location.startsWith('https://')) {
    // Require the "request" library for making HTTP requests
    var request = require("request");

    request.get(location, function (e, r, data) {
      try {
        if(callback)
          callback(data.replace(/[\r]/g, '').split('\n'));
      } catch (err) {
        console.log('Error loading blacklist from: ' + location + ', Error: ' + err);

        if(callback)
          callback(null);
      }
    });
  } else if (fs.existsSync(location)) {
    if(callback)
      callback(fs.readFileSync(location, "utf8").replace(/[\r]/g, '').split('\n'));
  } else if(callback)
    callback([]);
}

function format(n, c, d, t) {
  var c = isNaN(c = Math.abs(c)) ? 2 : c,
      d = d == undefined ? "." : d,
      t = t == undefined ? "," : t,
      s = n < 0 ? "-" : "",
      i = String(parseInt(n = Math.abs(Number(n) || 0).toFixed(c))),
      j = (j = i.length) > 3 ? j % 3 : 0;
   return s + (j ? i.substr(0, j) + t : "") + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + t) + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : "");
 }

 function toTimer(ts) {
   var h = Math.floor(ts / HOURS);
   var m = Math.floor((ts % HOURS) / 60);
   var s = Math.floor((ts % 60));
   return padLeft(h, 2) + ':' + padLeft(m, 2) + ':' + padLeft(s, 2);
 }

 function padLeft(v, d) {
   var l = (v + '').length;
   if (l >= d) return v + '';
   for(var i = l; i < d; i++)
     v = '0' + v;
   return v;
 }

 async function loadBots() {
  var query = await axios.get('https://steembottracker.net/bid_bots');
  var bidBots = query.data;
  var query = await axios.get('https://steembottracker.net/other_bots');
  var otherBots = query.data;
  // console.log(bidBots);
  // console.log(otherBots);
  var allBots = bidBots.concat(otherBots);
  botNames = _.map(allBots, 'name');
  // console.log(botNames);
  return botNames;
 }

 // the weight param is actually 100*1,000 at max to consume 20% VP
 // with 100 being the max 100% per single vote, and 1,000 being the max potentially used votes
 // so if we were to only consume 10 % of our VP, the weight would be set at 50,000 instead of default value of 100,000
 function calculateVotes(posts, weight) {
  if(typeof weight == 'undefined') {
    weight = 100000;
  }
  var data = {};
  var x = 0;
  // Rate multiplier post count  
  var rmc = _.countBy(posts, 'rate_multiplier');
  console.log(rmc);
  _.forEach(rmc, function(value, key) {
    x += key * value;
  });
  console.log(x);
  data.power_per_vote = Math.floor(weight / x);
  return data
 }

 function filterPosts(posts, banned_users) {
  var results = Array();
  let config = getConfig();
  //takes care of making sure if we reached too far back in history
   var dateSurpassed = 0;

  
  for(var i = 0; i < posts.length; i++) {
    var post = posts[i];

    // Check if post category is main tag
    if (post.category != config.main_tag) {
      console.log('Post does not match category tag. ' + post.url);
      continue;
    }
    //check if account was voted
    let voted = _.findIndex(post.active_votes, ['voter', config.account]);
    if (voted == -1) {
      console.log('Post was not voted. ' + post.url);
      continue;
    }
    // Check if account is beneficiary 
    var benefit = checkBeneficiary(post);
    
    if(!benefit)
      continue;
	  
	
	//check if user is banned
	var user_banned = false;
	for (var n = 0; n < banned_users.length; n++) {
		if (post.author == banned_users[n].user){
			console.log('User '+post.author+' is banned, skipping his post:' + post.url);
			user_banned = true;
			break;
		}
	  }   
	if (user_banned) continue;
	
	//go back only to predefined days in history
	if((new Date() - new Date(post.created + 'Z')) >= (config.max_days * 24 * 60 * 60 * 1000)) {
			dateSurpassed += 1;
			continue;
		}

    results.push(post);
  }
  //if we got to old posts and received at least 10 posts, inform calling function that no need to move forward further
  if (results.length == 0 && dateSurpassed>10){
	return -1;
  }
  return results;
    
 }

 function checkBeneficiary(post) {
  let config = getConfig();
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
   if(!benefit)
     return false;

   return true;

 }
 
  /**
  * function handles mapping and calculating relevant score
  * params: 
  * * 2D array providing couplets of rules
  * * factor multipier for data
  * * current value to compare
  */
 function calcScore(rules_array, factor, value){
	var result;
	for (var i=0; i<rules_array.length; i++){
		var rule = rules_array[i];
		if (value<=rule[0]){
			result = factor * rule[1];
			break;
		}else{
			//default until we find a larger range that fits better
			result = factor * rule[1];
		}
	}
	return result;
}

 function log(msg, name) { 
  if (!name)
    var name = 'log';
  console.log(new Date().toString() + ' - ' + msg); 
  fs.appendFileSync( name + '.log', new Date().toString() + ' - ' + msg + "\n");
 }

 function getConfig() {
  if (config)
    return config;
  else {
    console.log('I get config');
    config = JSON.parse(fs.readFileSync("config.json"));
    return config;
  }
 }

 async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}


 module.exports = {
   getVotingPower: getVotingPower,
   getVoteValue: getVoteValue,
   timeTilFullPower: timeTilFullPower,
   getVestingShares: getVestingShares,
   loadUserList: loadUserList,
   getCurrency: getCurrency,
   format: format,
   toTimer: toTimer,
   log: log,
   calcScore: calcScore,
   calculateVotes: calculateVotes,
   filterPosts: filterPosts,
   getConfig: getConfig,
   loadBots: loadBots,
   checkBeneficiary: checkBeneficiary,
   asyncForEach: asyncForEach
 }
