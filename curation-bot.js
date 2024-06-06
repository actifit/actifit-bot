var fs = require("fs");
const steem = require('steem');

const hive = require('@hiveio/hive-js');

const blurt = require("@blurtfoundation/blurtjs");

//hive.config.set('rebranded_api', true)
//hive.broadcast.updateOperations()

var utils = require('./utils');
var mail = require('./mail');
var _ = require('lodash');
var moment = require('moment');
const MongoClient = require('mongodb').MongoClient;
let ObjectId = require('mongodb').ObjectId; 

const cheerio = require('cheerio')
const axios = require('axios');
const request = require("request");

let targetPostCount = 0;


var account = null;
let actSteemAccount = null;
let actBlurtAccount = null;
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

let topUsersAFITX = [];
let topUsersAFIT = [];

let gadgetsFetched = false;
let activeGadgets = [];

let allSplinterCards = [];

//version of the reward system
var reward_sys_version = 'v0.2';

var error_sent = false;

var steem_price = 1;  // This will get overridden with actual prices if a price_feed_url is specified in settings
var sbd_price = 1;    // This will get overridden with actual prices if a price_feed_url is specified in settings

let hive_price = 1;
let hbd_price = 1;

let finalEligNewbieList = []; //contains array of newbies eligible for extra vote in current round

// Load the settings from the config file
loadConfig();
//console.log('launch test comment');
//testCustomComment();


//BSC requirements
var Web3 = require('web3');

const web3 = new Web3('https://bsc-dataseed1.binance.org:443');

const minABI = [
  // balanceOf
  {
	constant: true,
	inputs: [{ name: "_owner", type: "address" }],
	name: "balanceOf",
	outputs: [{ name: "balance", type: "uint256" }],
	type: "function",
  }];



//TG bot section
/*********************************************************/

const TelegramBot = require('node-telegram-bot-api');

// Telegram token actifitNotifyBot
const token = config.tg_bot_tkn;

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, {polling: true});

// Actifit Chat ID
const chatId = config.tg_grp_chat_id;

//sendMsg('Test Message');

bot.on('message', (msg) => {
	console.log(msg);
  console.log('>>>>>>>>Received message in chat:', msg.chat.id);
  // You can store the chat ID (msg.chat.id) for future use.
});

//return;
async function sendMsg(msg){
	
		//send test msg
	console.log('sending sample message to Actifit tg')
	//await bot.
	bot.sendMessage(chatId, msg);// + JSON.stringify(data));
}

/*********************************************************/


//console.log(config.afitTokenBSC);
const afitContract = new web3.eth.Contract(minABI, config.afitTokenBSC);

loadHivePrices();
//kick off loading steem prices in 30 seconds
setTimeout(loadSteemPrices, 30*1000);

//set proper nodes
steem.api.setOptions({ 
	url: config.active_node ,
		//hive.config.set('address_prefix','TST');
	//useAppbaseApi: true
});
/*
hive.api.setOptions({ 
	url: config.active_hive_node ,
	//useAppbaseApi: true
});*/

blurt.api.setOptions({
	url: config.active_blurt_node,
})


//hive.config.set('alternative_api_endpoints', config.alt_hive_nodes);

hive.api.setOptions({ 
	url: config.active_hive_node,
	//address_prefix: 'TST',
	//chain_id: '4200000000000000000000000000000000000000000000000000000000000000'
	//useAppbaseApi: true
});

//console.log('grab proposal voters');
let proposalVotersArray = [];
const actifitProposalId = 250;
//grabProposalVoters(actifitProposalId);


var STEEMIT_100_PERCENT = 10000;
var STEEMIT_VOTE_REGENERATION_SECONDS = (5 * 60 * 60 * 24);
var HOURS = 60 * 60;

//keep alive
var http = require("http");


let active_actifit_api = config.actifit_api_url;//default API node for actifit
let acti_api_nodes = config.actifit_api_nodes;//alt nodes

function switchActiApi(){
	const randomIndex = Math.floor(Math.random() * acti_api_nodes.length);
	console.log(randomIndex);
	console.log(acti_api_nodes[randomIndex]);
	active_actifit_api = acti_api_nodes[randomIndex];
}


//check status of user uploaded vids

setInterval(function(){
	//request('http://localhost:3120/userVidNotifier', function (error, response, body) {
	request(active_actifit_api+'userVidNotifier', function (error, response, body) {
			console.log('update vid status and send notification');
			console.log(response);
			//console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
			//console.log('error: '+ error)
		});
		

}, 1 * 60 * 1000); //every 1 min
//}, 30 * 1000); //every 30 seconds

setInterval(function() {
  try{
	
	if (!is_voting){
		//let's also run our token exchange cleanup process
		console.log('running cleanup');
		request(active_actifit_api+'cancelOutdatedAfitSteemExchange', function (error, response, body) {
			console.log('cleanup result');
			console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
			console.log('error: '+ error)
		});
		
		
		//let's also run the cleanup for any missed AFIT SE to Actifit wallet processes
		request(active_actifit_api+'confirmAFITSEBulk?bchain=HIVE', function (error, response, body) {
			console.log('process any missed AFIT HE to Actifit Wallet');
			console.log(response);
			//console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
			//console.log('error: '+ error)
		});
		
		
		//grabProposalVoters(actifitProposalId);
	}
	
	//switch API node
	switchActiApi();
	
  }catch(err){
	console.log('error:'+err);
  }

}, 600000); // every 10 minutes (600000)



/* function for broadcasting price change */

setInterval(function() {
  try{
	
	if (!is_voting){
		//also load prices & broadcast updates to witness nodes (STEEM & HIVE)
		loadHivePrices();
		//in 30 seconds load steem prices
		setTimeout(loadSteemPrices, 30*1000);
	}
	
  }catch(err){
	console.log('error:'+err);
  }

}, 3600000); // every 1 hour (3600000)


let crypto = require('crypto');

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





var botNames;
//fetchGadgets();
let tokensBurntLastRound = false;
//const SSC = require('sscjs');
//const ssc = new SSC(config.steem_engine_rpc);

//const hsc = new SSC(config.hive_engine_rpc);

// Initial Load of top AFITX token holders
// Top 25 will be stored in topUsersAFITX
fetchAFITXTopHolders();


//grab all splinterlands data
fetchAllSplinterCards();

//return;


//testSplinterlandsFunc();

async function testSplinterlandsFunc(){
	let rarityColl = await fetchUserSplinterData('mcfarhat');
	//go through rarity cards, and append boosts accordingly
	let splinter_boosts = [];
	let val = 0;
	for (let curs = 1; curs < rarityColl.length;curs++){
		let curRarity = rarityColl[curs];
		//if we have more than 10 cards owned for each rarity, apply an extra boost
		if (curRarity >= 10){
			let extraTokens = await calculateSplinterExtraRewards(curs);
			splinter_boosts.push({rarity: curs, cardCount: curRarity, extraRewards: extraTokens})
			//console.log()
			
			val += parseInt(extraTokens);
		}
	}
	console.log(splinter_boosts);
	console.log(val)
}

async function calculateSplinterExtraRewards(rarity){
	if (rarity == 1){
		return 5;
	}else if (rarity == 2){
		return 10;
	}else if (rarity == 3){
		return 15;
	}else if (rarity == 4){
		return 20;
	}
}

async function fetchUserSplinterData(username){
	if (allSplinterCards == null || allSplinterCards.length < 1){
		//need to fetch all cards collection
		console.log('fetching splinterlands full collection data anew')
		await fetchAllSplinterCards();
	}
	//fetch user's cards
	let cardColl = await fetchUserSplinterCards(username);
	//compare and match user's cards and populate rarity to each card (join)
	if (cardColl != null){
		for (let i=0;i<cardColl.length;i++){
			//prepare entry
			let ent = cardColl[i];
			let matchCriteria = {id:ent.card_detail_id};
			let matchEntry = _.find(allSplinterCards, matchCriteria);
			//console.log(matchEntry);
			ent.rarity = matchEntry.rarity;
			ent.name = matchEntry.name;
			ent.color = matchEntry.color;
			ent.type = matchEntry.type;
			ent.id = matchEntry.card_detail_id;
		}
	}
	//console.log(cardColl);
	let rarityColl = [];
	if (cardColl != null){
		for (let i=1;i<5;i++){
			rarityColl[i] = await findSpecialCardsCount(cardColl, i);
		}
	}
	return rarityColl;
	// console.log('rarity collection:');
	// console.log(rarityColl);
}

async function findSpecialCardsCount(userCards, rarityParam){
	let match = {rarity: rarityParam}
	//using filter to find all matches
	let matchCount = _.filter(userCards, match);
	if (matchCount != null && matchCount.length > 0){
		console.log('cards with rarity '+ rarityParam + ':'+matchCount.length)
		return matchCount.length;
	}else{
		console.log('zero matches for rarity '+rarityParam);
		return 0;
	}
}

async function fetchAllSplinterCards(){
	console.log('>>>>>>>>>>>>>splinterlands ALL cards');
	try{
		
		//let fetch_gadgets_res = await axios.get(active_actifit_api + 'activeGadgets');
		let gadUrl = config.splinter_api_all_cards;
		
		//console.log(gadUrl);
		let outcome = await axios.get(gadUrl);
		//console.log(outcome.data);
		if (outcome && outcome.data){
			allSplinterCards = outcome.data;
		}else{
			console.log('no cards found');
		}
		//console.log(activeGadgets);
	}catch(err){
		console.log(err);
	}
	
}

async function fetchUserSplinterCards(username){
	try{
		console.log('>>>>>>>>>>>>>splinterlands user cards');
		
		
		
		
		//let fetch_gadgets_res = await axios.get(active_actifit_api + 'activeGadgets');
		let gadUrl = config.splinter_api_url_user_collections.replace('_USERNAME_', username);
		
		//alternate different splinterlands API end points
		let rndCall = utils.generateRandomNumber(1, 9);
		if (rndCall > 5){
			gadUrl = config.splinter_api_url_user_collections_alt.replace('_USERNAME_', username);
		}
		
		//console.log(gadUrl);
		let outcome = await axios.get(gadUrl);
		console.log(outcome.data.player);
		if (outcome && outcome.data && outcome.data.player == username ){
			console.log(outcome.data.cards.length+' cards found');
			return outcome.data.cards;
		}else{
			console.log('no cards found');
			return null;
		}
		//console.log(activeGadgets);
	}catch(err){
		console.log(err);
		return null;
	}
	
}


//grab list of active gadgets
async function fetchGadgets(){
	try{
		console.log('>>>>>>>>>>>>>fetchGadgets');
		
		//let fetch_gadgets_res = await axios.get(active_actifit_api + 'activeGadgets');
		let gadUrl = active_actifit_api + 'activeGadgets';
		if (config.testing){
			gadUrl = config.api_test_url + 'activeGadgets';
		}
		//console.log(gadUrl);
		let fetch_gadgets_res = await axios.get(gadUrl);
		
		activeGadgets = fetch_gadgets_res.data;
		gadgetsFetched = true;
		//console.log(activeGadgets);
	}catch(err){
		console.log(err);
	}
}

//initial call
fetchAFITData();

setInterval(fetchAFITData, 1200000); // every 20 minutes (1200000)

async function fetchAFITData(){
	try{
	  if (!is_voting){
		// Load updated top AFITX token holders every 10 minutes
		// Top 25 will be stored in topUsersAFITX
		fetchAFITXTopHolders();
		
		fecthAFITHEHolders();
	  }
	}catch(err){
		console.log(err);
	}
}

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
	  utils.log("Connected successfully to server ");

	  db = client.db(db_name);

	  // Get the documents collection
	  collection = db.collection(collection_name);
	  
	  /*let test = await db.collection('afit_price').find().sort({'date': -1}).limit(1).next();
	  console.log(test);*/
		
		
//testerr();

//return
 
	  
	  //testBoostData();
	  //only start the process once we connected to the DB
	  startProcess();
	  
	  // Load updated STEEM and SBD prices every 30 minutes
	  /*loadPrices();
	  setInterval( function (){
		if (!is_voting){
			loadPrices()
		}
	  }, 30 * 60 * 1000);*/
	  
	  //updateUserTokens();
	} else {
		utils.log(err, 'api');
	}
  
});


async function testerr(){
	console.log('testerr1');
	await fetchAFITXTopHolders();
	await fecthAFITHEHolders();
	let tstact = await grabUserTokensFunc('isofish');
	console.log('testerr2');
	console.log(tstact);
	
}


// Schedule to run every minute
if (!config.testing){
	if (!is_voting){
		//we should only kickstart the bot if no voting round is running
		setInterval(startProcess, 40 * 1000);
	}
}else{
	setTimeout(startProcess, 20 * 1000);
}




async function testBoostData(){
	await fetchGadgets();
	
	let postData = [];
	
	let boost_res;
	
	/*let boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'SPORTS', 'unit', {author: 'mcfarhat', permlink: 'bingo'}, true);
	console.log('testBoostData 1');
	postData = boost_res.user_post_boosts;
	
	//check if user has a SPORTS boost as percent increments
	let appendNetPercTokens = boost_res.extra_boost;
	console.log(appendNetPercTokens);
	console.log(postData);
	
	//let test = await grabConsumeUserBoostByType('@mcfarhat', 'AFIT', 'percent_reward', {author: 'mcfarhat', 'permlink': 'bingo'}, true);
	boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'AFIT', 'unit', {author: 'mcfarhat', permlink: 'bingo'}, true);
	
	postData = postData.concat(boost_res.user_post_boosts);
	appendNetPercTokens = boost_res.extra_boost;
	console.log('testBoostData 2');*/
	
	/*
	let boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'AFIT', 'range', {author: 'mcfarhat', permlink: 'bingo'}, true);
				
	postData = postData.concat(boost_res.user_post_boosts);
	
	//check if user has a User Rank boost as percent increments
	let appendTokens = boost_res.extra_boost;
	console.log('>>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<');
	//console.log(test);
	//store used boosts to the post
	//console.log(test.user_post_boosts);
	console.log(appendTokens);
	console.log(postData);
	
	console.log(boost_res.user_post_boosts[0].productdetails[0].benefits.boosts);
	*/
	
	
	boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'APX', 'percent', {author: 'mcfarhat', permlink: 'bingo'}, true);
				
	postData = postData.concat(boost_res.user_post_boosts);
	
	//check if user has a User Rank boost as percent increments
	appendTokens = boost_res.extra_boost;
	console.log('>>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<');
	//console.log(test);
	//store used boosts to the post
	//console.log(test.user_post_boosts);
	console.log(appendTokens);
	console.log(postData);
	
	console.log(boost_res.user_post_boosts[0].productdetails[0].benefits.boosts);
	
	/*boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'SPORTS', 'percent_reward', {author: 'mcfarhat', permlink: 'bingo'}, true);
				
	postData = postData.concat(boost_res.user_post_boosts);
	
	//check if user has a User Rank boost as percent increments
	appendTokens = boost_res.extra_boost;
	console.log('>>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<');
	//console.log(test);
	//store used boosts to the post
	//console.log(test.user_post_boosts);
	console.log(appendTokens);
	console.log(postData);
	
	console.log(boost_res.user_post_boosts[0].productdetails[0].benefits.boosts);
	
	boost_res = await grabConsumeUserBoostByType('@mcfarhat', 'User Rank', 'unit', {author: 'mcfarhat', permlink: 'bingo'}, true);
				
	postData = postData.concat(boost_res.user_post_boosts);
	
	//check if user has a User Rank boost as percent increments
	appendTokens = boost_res.extra_boost;
	console.log('>>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<');
	//console.log(test);
	//store used boosts to the post
	//console.log(test.user_post_boosts);
	console.log(appendTokens);
	console.log(postData);
	
	console.log(boost_res.user_post_boosts[0].productdetails[0].benefits.boosts);*/
	
	//check if user has a User Rank boost as percent increments
	//console.log(test.extra_boost);
}

//unit contains values such as SPORTS, AFIT, User Rank
//type contains values such as unit, percent
async function grabConsumeUserBoostByType(user, unit, type, post, consume){
	
	//console.log(activeGadgets);
	let extra_boost = 0;
	user = user.replace('@','');
	let userSteem = '@' + user;
	let userNamesVar = [userSteem, user];
	let user_post_boosts = [];
	
	//apply boosts by user
	if (Array.isArray(activeGadgets) && activeGadgets.length > 0){
		let matchingGadgets = activeGadgets.filter( gadget => userNamesVar.includes (gadget.user) );
		let matchingFriendGadgets = activeGadgets.filter( gadget => userNamesVar.includes (gadget.benefic) );
		//console.log(matchingGadgets);
		//console.log(matchingFriendGadgets);
		if (!Array.isArray(matchingGadgets)){
			matchingGadgets = matchingFriendGadgets;
		}else if (Array.isArray(matchingFriendGadgets)){
			matchingGadgets = matchingGadgets.concat(matchingFriendGadgets);
		}
		console.log('>>>>matchingGadgets');
		console.log(matchingGadgets);
		let maxCount = matchingGadgets.length;
		//go through each gadget and process its boosts
		for (let i=0;i<maxCount;i++){
			if (Array.isArray( matchingGadgets[i].productdetails) &&  matchingGadgets[i].productdetails.length > 0){
				let boosts = matchingGadgets[i].productdetails[0].benefits.boosts;
				if (Array.isArray( boosts) &&  boosts.length > 0){
					let maxBoosts = boosts.length;
					//to ensure we only consume proper matching boosts
					let match = false;
					
					let is_benefic = false;
					for (let j=0;j<maxBoosts;j++){
						if (boosts[j].boost_unit == unit){
							console.log('unit found '+unit);
							if (boosts[j].boost_type == type){
								console.log('type found '+type);
								if (boosts[j].boost_beneficiary == 'self' && userNamesVar.includes(matchingGadgets[i].user)
									|| boosts[j].boost_beneficiary == 'friend' && userNamesVar.includes(matchingGadgets[i].benefic)){
										
										//condition for range boost
										if (!boosts[j].boost_amount && boosts[j].boost_min_amount && boosts[j].boost_max_amount){
											boosts[j].boost_amount = parseInt(Math.random() * (parseInt(boosts[j].boost_max_amount) - parseInt(boosts[j].boost_min_amount) + 1) + parseInt(boosts[j].boost_min_amount));
										}
										
										console.log('extra amount '+boosts[j].boost_amount);
										extra_boost += parseFloat(boosts[j].boost_amount);
										match = true;
										
										//append this entry to the list of consumed boosts
										user_post_boosts.push(matchingGadgets[i]);
										
										if (boosts[j].boost_beneficiary == 'friend' && userNamesVar.includes(matchingGadgets[i].benefic)){
											is_benefic = true;
										}
										if (consume && !config.testing){
											let gadgetId = new ObjectId(matchingGadgets[i].gadget)
											//store transaction
											let productBoostTrans = {
												user: user,
												gadget: gadgetId,
												gadget_name: matchingGadgets[i].gadget_name,
												gadget_level: matchingGadgets[i].gadget_level,
												beneficiary_type: boosts[j].boost_beneficiary,
												beneficiary_originator: matchingGadgets[i].user,
												boost_type: boosts[j].boost_type,
												boost_amount: boosts[j].boost_amount,
												boost_unit: boosts[j].boost_unit,
												date: new Date(),
											}
											try{
												console.log(productBoostTrans);
												let transaction = await db.collection('user_boost_consumed').insert(productBoostTrans);
												console.log('success inserting post data');
											}catch(err){
												console.log(err);
												console.log('Error performing buy action. DB storing issue');
												return;
											}
										}
								}
							}
						}
					}
					
					//consume gadget
					if (match && consume){
						try{
							let gadgetId = new ObjectId(matchingGadgets[i].gadget);
							console.log(gadgetId);
							let gadget_match;
							console.log('gadget_match');
							console.log(gadget_match);
							//this could be a benefic gadget, so we need to check benefic cases as well
							if (is_benefic){
								gadget_match = await db.collection('user_gadgets').findOne({ benefic: {$in: [user, userSteem]}, status: "active", gadget: gadgetId });
							}else{
								gadget_match = await db.collection('user_gadgets').findOne({ user: {$in: [user, userSteem]}, status: "active", gadget: gadgetId });
							}
							if (gadget_match){
								/*let benefic = user;
								if (matchingGadgets[i].benefic){
									benefic = matchingGadgets[i].benefic;
								}*/
								let skip = false;
								let skipConsumption = false;
								//check if post already registered, if so skip it
								if (Array.isArray(gadget_match.posts_consumed) && gadget_match.posts_consumed.find(
									(rwd_post => rwd_post.author == post.author && rwd_post.permlink == post.permlink))){
									skip = true;	
								}
								//check if this is a benefic case and which has multiple boosts, so that we dont consume it more than once.
								
								if (maxBoosts > 1 && is_benefic){
									try{
										//find its index in the original gadgets array, and make sure it gets only consumed this time
										let gad_index = activeGadgets.findIndex(gadget => userNamesVar.includes (gadget.benefic) );
										
										if (activeGadgets[gad_index].roundConsumed){
											skipConsumption = true;
										}
										activeGadgets[gad_index].roundConsumed = true;
									}catch(boostErr){
										console.log(boostErr);
									}
								}
								if (!skip){
									if (!Array.isArray(gadget_match.posts_consumed)){
										gadget_match.posts_consumed = [];
									}
									let consumed_pst = new Object();
									consumed_pst.author = post.author;
									consumed_pst.permlink = post.permlink;
									//consumed_pst.benefic = post.benefic;
									
									gadget_match.posts_consumed.push(consumed_pst);
									if (!skipConsumption){
										gadget_match.consumed += 1;
										if (gadget_match.consumed >= gadget_match.span){
											gadget_match.status="consumed";
										}
									}
									gadget_match.last_updated = new Date();
									console.log('updating user gadget');
									console.log(gadget_match);
									if (!config.testing){
										let transaction = db.collection('user_gadgets').save(gadget_match);
										console.log('success inserting post data');
									}
								}
							}
						}catch(err){
							console.log(err);
							return;
						}
					}
				}
			}
		}
	}
	console.log('user_post_boosts');
	console.log(user_post_boosts);
	return {'extra_boost': extra_boost, 'user_post_boosts':user_post_boosts};
}



var votePosts;
var lastIterationCount = 0;

let queryCount = 0;

let userInfo,tokenCount;

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
  /*if(!botNames)
    botNames = await utils.loadBots();*/
  //if (config.detailed_logging)
    utils.log('Start process');
  // Load the settings from the config file each time so we can pick up any changes
  loadConfig();
	
	
	//load steem account data
	
	
	
	/*await steem.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      utils.log(err, result);
    else {
      actSteemAccount = result[0];
	  //console.log(actSteemAccount);
    }
	});*/
	
	//load blurt account data
	console.log('load blurt data');
	
	await blurt.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      utils.log(err, result);
    else {
      actBlurtAccount = result[0];
	  
	  //claimRewards('BLURT');
	  //console.log(actBlurtAccount);
	  //claimRewards('BLURT');
	  //console.log(actSteemAccount);
    }
	});
	
	//return;
	
  
	/*await steem.api.setOptions({ 
		url: config.active_hive_node ,
		//useAppbaseApi: true
	});*/
  
  // Load hive account info
  console.log('load hive data');
  
  /*hive.api.setOptions({
	  address_prefix: 'TST',
	  chain_id: '42',
	  useTestNet: true,
	});*/
  
  hive.api.getAccounts([config.account], function (err, result) {
    if (err || !result)
      utils.log(err, result);
    else {
      account = result[0];
	  //console.log(account);
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
  //console.log('account');	
  //console.log(account!=null);	
  console.log('skip:'+skip);	
  console.log('is_voting:'+is_voting);	
  console.log('passedOneDay:'+passedOneDay);	
  
	/*
	
	let newbieList= await fetch('http://localhost:3120/activeVerifiedNewbies/');
	console.log(newbieList);
	let newbieEligListRes = await newbieList.json();
	console.log(newbieEligListRes);
	let interimEligList = [];
	
	let votePosts = [];
	votePosts.push({author: 'mcfarhat'});
	votePosts.push({author: 'mcfarhat1'});
	votePosts.push({author: 'mcfarhat2'});
	votePosts.push({author: 'mcf'});
	votePosts.push({author: 'mcfabc'});
	votePosts.push({author: 'mcf1'});
	votePosts.push({author: 'mcf2'});
	votePosts.push({author: 'mcf3'});
	votePosts.push({author: 'mcf4'});
	
	
	console.log(votePosts);
	
	for (let lpr=0;lpr<newbieEligListRes.length;lpr++){
	//update list to contain users having a post
		let matchPst = votePosts.find( user_post => user_post.author === newbieEligListRes[lpr].user);
		if (matchPst){
			interimEligList.push(newbieEligListRes[lpr].user);
		}
		console.log(matchPst);
	}
	
	console.log('current full eligible list');
	console.log(interimEligList);
	if (interimEligList.length<=config.max_newbie_reward_count){
		//we have all our list already
		finalEligNewbieList = interimEligList;
	}else{
		while(finalEligNewbieList.length < config.max_newbie_reward_count){
			let r = Math.floor(Math.random() * (interimEligList.length)); //generate random number between 0 and array length
			//only append the item if not already added
			if (finalEligNewbieList.indexOf(interimEligList[r]) === -1){
				finalEligNewbieList.push(interimEligList[r]);
			}
		}
	}
	console.log('final selected list');
	console.log(finalEligNewbieList);

	if (finalEligNewbieList.length > 0){
		console.log('we have eligible newbies for extra rewards!');
		let entryIdx = finalEligNewbieList.indexOf('mcfabc');
		if (entryIdx !== -1){
			vote_weight = config.max_newbie_vote_pct;
			console.log('Newbie user '+'mcfabc'+' eligible for extra vote. Vote weight:'+vote_weight);
			finalEligNewbieList.splice(entryIdx, 1);
		}
	}
	
	console.log(finalEligNewbieList);

	return;
	*/
	
	//BuyAndBurn(true);
	
  
	
  if (account && !skip && !is_voting && passedOneDay) {
    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);
	let vpRestart = parseFloat(config.vp_kickstart) - 125;
	let vpRestartLimit = vpRestart + 2;
	console.log('vpRestart:'+vpRestart);
	
    utils.log('Voting Power: ' + utils.format(vp) + '% | Time until next vote: ' + utils.toTimer(utils.timeTilFullPower(vp*100)));
	
	//disabling buying and burning tokens
	/*console.log(config.vpTokenBurn);
	if (vp >= config.vpTokenBurn/100 && vp < (config.vpTokenBurn+10)/100){
		console.log('Buy AFIT & Burn em Case');
		if (!tokensBurntLastRound){
			BuyAndBurn(false);
			tokensBurntLastRound = true;
		}
	}else{
		tokensBurntLastRound = false;
	}*/
	
	
	/*
	if (vp >= vpRestart/100 && vp < vpRestartLimit/100) {
		//restart server to avoid voting round breakdown
		//https://devcenter.heroku.com/articles/platform-api-reference
		console.log('contacting heroku server');

		request.post(
			{
				url: 'https://api.heroku.com/apps/' + config.heroku_app_id + '/dynos/' + config.heroku_app_dyno + '/actions/stop',
				//url: 'https://api.heroku.com/apps/' + config.heroku_app_id + '/dynos',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/vnd.heroku+json; version=3',
					'Authorization': 'Bearer ' + config.heroku_app_token
				}
			},
			function(error, response, body) {
				// Do stuff
				console.log(response);
				console.log(body);
			}
		);
		/////////////////
	}*/
    // We are at voting power kick start - time to vote!
	//utils.log(vp >= parseFloat(config.vp_kickstart)/100);
    if (vp >= parseFloat(config.vp_kickstart)/100 || config.testing) {
	
		// Check if there are any rewards to claim before voting
		if (!config.testing){
			//await claimRewards('STEEM');
			try{
			await claimRewards('HIVE');
			await claimRewards('BLURT');
			}catch(errclaim){
				console.log(errclaim);
			}
		}
		
		//fetch gadget assignments
		
		let fet_res = await fetchGadgets();
		
		console.log(activeGadgets);
		
		//reset number of helping votes case
		helping_accounts_votes = 0;
		
		// Load Steem global variables
		
		console.log('properties');
		properties = await hive.api.getDynamicGlobalPropertiesAsync();
		console.log('got properties');
		  //grab reward fund data
		rewardFund = await hive.api.getRewardFundAsync("post");
		console.log('got reward fund');
		rewardBalance = parseFloat(rewardFund.reward_balance.replace(" STEEM", "").replace(" HIVE", "").replace(" BLURT", ""));
		recentClaims = rewardFund.recent_claims;
		
		if (properties.total_vesting_fund_steem){
			totalSteem = Number(properties.total_vesting_fund_steem.split(' ')[0]);
		}else if (properties.total_vesting_fund_hive){
			totalSteem = Number(properties.total_vesting_fund_hive.split(' ')[0]);
		}else{
			totalSteem = Number(properties.total_vesting_fund_blurt.split(' ')[0]);
		}
		totalVests = Number(properties.total_vesting_shares.split(' ')[0]);
		
		votePowerReserveRate = properties.vote_power_reserve_rate;
		sbd_print_percentage = properties.sbd_print_rate / 10000;
		
		utils.log('lets vote');
		skip = true;
		  
		utils.log('fetch banned users list');  
		//grab banned user list before rewarding
		banned_users = await db.collection('banned_accounts').find({ban_status:"active"}).toArray();
	  
		//grab list of moderators
		var moderator_api_url = active_actifit_api+'moderators';
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
		
		//grab list of active gadgets
		//fetchGadgets();
		
		
	  
		var query = {tag: config.main_tag, limit: 100};
		
		if (config.testing){
			query.limit = config.max_query_count;
		}
		votePosts = Array();
		processVotes(query, false);      
    }else{
		utils.log('claim RC ')
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

function BuyAndBurn(test){
	console.log('init');
	//fetch sell book
	ssc.find('market', 'sellBook', {symbol: 'AFIT'}, 10, 0, [{ index: 'priceDec', descending: false }],  (err, result) => {
		console.log(result);
		//fetch enough sell orders to place our own buy order
		let totalSteemSold = 0;
		const target = config.targetTokenBurnSteem;
		let targetPrice = 0;
		for (let i=0, max=result.length;i<max;i++){
			totalSteemSold += result[i].price * result[i].quantity;
			console.log(totalSteemSold);
			if (totalSteemSold >= target){
				targetPrice = result[i].price;
				break;
			}
		}
		console.log('targetPrice:'+targetPrice);
		//place order for buying tokens
		//calculate needed AFIT quantity to match target
		let quantity = Math.ceil(target / targetPrice);
		console.log('AFIT to buy:'+quantity);
		if (test){
			quantity = 0.1;
		}
		let json = "{\"contractName\":\"market\",\"contractAction\":\"buy\",\"contractPayload\":{\"symbol\":\"AFIT\",\"quantity\":\"" + quantity + "\",\"price\":\"" + targetPrice + "\"}}";
		
		steem.broadcast.customJson(config.active_key, [config.account], [], 'ssc-mainnet1', json, (err, result) => {
		  if (!err && result) {
			console.log('success buyin');
			console.log(result);
			
			json = "{\"contractName\":\"tokens\",\"contractAction\":\"transfer\",\"contractPayload\":{\"symbol\":\"AFIT\",\"to\":\"null\",\"quantity\":\"" + quantity + "\",\"memo\":\"\"}}";
			//burn those tokens
			steem.broadcast.customJson(config.active_key, [config.account], [], 'ssc-mainnet1', json, (err, result) => {
				if (!err && result) {
					console.log('success burnin');
					console.log(result);
				} else {
					console.log('err');
					console.log(err);
				}
			});
			
		  } else {
			console.log('err');
			console.log(err);
		  }
		});
		
		
	});
}

function setSteemPrice(json){
	steem_price = parseFloat(json.steem.usd); 
	console.log('STEEM price:'+steem_price)
	//witness deactivated. No further need to broadcast
	/*if (!config.testing){
		broadcastFeed('STEEM')
	}*/
}

function setSbdPrice(json){
	sbd_price = parseFloat(json['steem-dollars'].usd);
	console.log('SBD price:'+sbd_price)
}

function setHivePrice(json){
	let tmp_hive_price = parseFloat(json.hive.usd); 
	console.log('new HIVE price:'+tmp_hive_price)
	if (hive_price != tmp_hive_price){
		console.log('HIVE price change (old)'+hive_price)
		hive_price = tmp_hive_price;
		if (!config.testing){
			broadcastFeed('HIVE')
		}
	}
	hive_price = tmp_hive_price;
}

function setHbdPrice(json){
	hbd_price = parseFloat(json['hive_dollar'].usd);
	console.log('HBD price:'+hbd_price)
}

function loadHivePrices() {
  fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd').then(
		res => {res.json().then(json => setHivePrice(json)).catch(e => console.log('Error loading HIVE price: ' + e))
  }).catch(e => console.log('Error loading HIVE price: ' + e))
  
  //grab SBD price
  fetch('https://api.coingecko.com/api/v3/simple/price?ids=hive_dollar&vs_currencies=usd').then(
	res => {res.json().then(json => setHbdPrice(json)).catch(e => console.log('Error loading HBD price: ' + e))
  }).catch(e => console.log('Error loading HBD price: ' + e))
}

function loadSteemPrices() {
  fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem&vs_currencies=usd').then(
		res => {res.json().then(json => setSteemPrice(json)).catch(e => console.log('Error loading STEEM price: ' + e))
  }).catch(e => console.log('Error loading STEEM price: ' + e))
  
  //grab SBD price
  fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem-dollars&vs_currencies=usd').then(
	res => {res.json().then(json => setSbdPrice(json)).catch(e => console.log('Error loading SBD price: ' + e))
  }).catch(e => console.log('Error loading SBD price: ' + e))
  
  /*
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
  
  */
}


//handles sending out price feed for witness nodes
function broadcastFeed (type) {
	//STEEM witness
	let peg_multi = config.peg_multi ? config.peg_multi : 1;
	let price_val = steem_price;
	let pegged_cur = ' SBD';
	let origType = type;
	if (type == 'HIVE'){
		price_val = hive_price;
		//below two lines are hacks since steem-js is not yet accepting HIVE and HBD
		pegged_cur = ' HBD';
		//type = 'HIVE';
		/*steem.api.setOptions({ 
			url: config.active_hive_node ,
			//useAppbaseApi: true
		});*/
	}else{
		/*steem.api.setOptions({ 
			url: config.active_node ,
			//useAppbaseApi: true
		});*/
	}
	let exchange_rate = { base: price_val.toFixed(3) + pegged_cur, quote: (1 / peg_multi).toFixed(3) + ' ' + type };
	utils.log('Broadcasting ' + origType + ' feed_publish transaction: ' + JSON.stringify(exchange_rate));
	hive.broadcast.feedPublish(config.active_key, config.account, exchange_rate, function (err, result) {
		if (result && !err) {
		  console.log(result);
		  utils.log('Broadcast successful!');
		} else {
		  utils.log('Error broadcasting feed_publish transaction: ' + err);

		  /*if (retries == 5)
			failover();

		  if (retries < 2)
			setTimeout(function () { publishFeed(price, retries + 1); }, 10 * 1000);*/
		}
	});
}



//var post_scores = [];
function processVotes(query, subsequent) {
  
  utils.log('processVotes');
  
  //fetch top AFITX holders as of current
  //top 25 will be stored in topUsersAFITX
  //fetchAFITXBal(0);
	
  /*
  steem.api.setOptions({ 
	url: config.active_hive_node ,
	//useAppbaseApi: true
});*/
  
  hive.api.getDiscussionsByCreated(query, async function (err, result) {
	//track how many queries were ran
	queryCount += 1;
    if (result && !err) {
		//is_voting = true;
		if (!config.testing){
			setIsVoting(true);
		}
      
		utils.log(result.length + ' posts to process...');      
		
		//initialize inserting posts to db
		
		var bulk = db.collection('posts').initializeUnorderedBulkOp();
		
		//connect to the token_transactions table to start rewarding
		var bulk_transactions = db.collection('token_transactions').initializeUnorderedBulkOp();
		
		var bulk_posts_skip = db.collection('posts_to_skip').initializeUnorderedBulkOp();
		
		let proceed_bulk = false;
		let proceed_bulk_transactions = false;
		let proceed_bulk_posts_skip = false;
		
		for(var i = 0; i < result.length; i++) {
			
			var post = result[i];
			if (config.testing && i == 0){
				console.log('switch author');
				console.log(post.author);
				//post.author = 'mcfarhat';
				//post.permlink = 'actifit-witness-vote-application-msp';
			}
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
			if (post.active_votes.find(v => v.voter == 'actifit')) {
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
			
			/*
				let referrer_reward_acct = '';
				let reward_pct = 0;
				let referrer_reward_amt = 0;
				let activity_afit_reward = 20;
			for (var x = 0; x < post.beneficiaries.length; x++) {
					let testAccount = post.beneficiaries[x].account;
					if (testAccount != config.beneficiaries[0]
						&& testAccount != config.beneficiaries[1]
						&& testAccount != config.full_pay_benef_account){
							referrer_reward_acct = testAccount;
							reward_pct = parseInt(post.beneficiaries[x].weight)/100;
							referrer_reward_amt = reward_pct * activity_afit_reward;
							activity_afit_reward = activity_afit_reward * (100-reward_pct);
							break;
				  }
				}
				if (referrer_reward_acct){
					console.log(referrer_reward_acct);
					console.log(reward_pct);
					console.log(referrer_reward_amt);
					console.log(activity_afit_reward);
					return;
				}
			*/
			
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
				
					let ver_url = active_actifit_api + "fetchVerifiedPost";			
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
					if (!config.testing){
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
						
						proceed_bulk_posts_skip = true;
						
					  continue;
					}
				}
				
				
				/**************** Post Score calculation section *******************/
				
				/******************* activity count criteria *********************/
				
				//calculate activity count score
				post.activity_score = utils.calcScore(activity_rules, config.activity_factor, post.json.step_count);
				
				//console.log('step count:'+post.json.step_count);
				//console.log('activity score:'+post.activity_score);
				
				//skip post if it has less than min activity recorded
				if (!config.testing && post.activity_score == 0){
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
					let comments = await hive.api.getContentRepliesAsync(post.author, post.permlink);
					
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
							
							if (!config.testing){
							
								bulk_transactions.find(
								{ 
									user: comment_transaction.user,
									reward_activity: comment_transaction.reward_activity,
									url: comment_transaction.url,
									comment_url: comment_transaction.comment_url
								}).upsert().replaceOne(comment_transaction);
								
								proceed_bulk_transactions = true;
								
								utils.log('found comment>>>>');
								utils.log(comment_transaction);
							}
						}
					}
				//}
				//utils.log("comments:"+matching_comment_count);
				//calculate comment score
				post.comment_score = utils.calcScore(cmts_rules, config.comments_factor, matching_comment_count);
				
				/******************* user rank criteria *********************/
				//var request = require('request');
				var rank_api_url = active_actifit_api+'getRank/'+post.author;
				var user_rank_info = await axios.get(rank_api_url);
				//utils.log(user_rank_info.user_rank);
				post.user_rank = parseFloat(user_rank_info.data.user_rank);
				
				console.log('old user rank:'+post.user_rank);
				
				let boost_res = await grabConsumeUserBoostByType(post.author, 'User Rank', 'percent', post, true);
				//store used boosts to the post
				post.user_post_boosts = boost_res.user_post_boosts;
				
				//check if user has a User Rank boost as percent increments
				let appendPercRank = boost_res.extra_boost;
				
				//append as percentage
				post.user_rank += appendPercRank * post.user_rank / 100;
				post.boost_user_rank_percent = appendPercRank;
				
				console.log('new user rank:'+post.user_rank);
				
				boost_res = await grabConsumeUserBoostByType(post.author, 'User Rank', 'unit', post, true);
				post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
				
				//check if user has a User Rank boost as percent increments
				let appendUnitRank = boost_res.extra_boost;
				
				//append as percentage
				post.user_rank += appendUnitRank;
				post.boost_user_rank_unit = appendUnitRank;
				
				console.log('new user rank:'+post.user_rank);
				
				//calculate user rank score relying on positive votes only
				post.user_rank_score = parseFloat(user_rank_info.data.user_rank)*parseInt(config.rank_factor)/100;
				//utils.log('rank'+post.user_rank_score);
				
				
				//calculate total post score
				post.post_score = post.activity_score + post.content_score + post.media_score + post.upvote_score + post.comment_score + post.moderator_score + post.user_rank_score;
				
				console.log('old post score:'+post.post_score);
				
				post.afit_pre_boost = post.post_score;
				
				//fetch user's token count to make sure of eligibility to AFIT rewards
				userInfo = await grabUserTokensFunc(post.author);
				tokenCount = parseFloat(userInfo.tokens);
				console.log('gotten '+post.author + ' AFIT bal ' + tokenCount);
				
				//this only applies to users having enough AFIT threshold. Otherwise their boosts will not be consumed
				if (tokenCount >= parseFloat(config.min_afit_reward_elig)){
					
					//check splinterlands eligibility for extra rewards, returns owned cards by rarity
					let rarityColl = await fetchUserSplinterData(post.author);
					//go through rarity cards, and append boosts accordingly
					post.splinter_boosts = [];
					for (let curs = 1; curs < rarityColl.length;curs++){
						let curRarity = rarityColl[curs];
						//if we have 10 or more cards owned for each rarity, apply an extra boost
						if (curRarity >= 10){
							let extraTokens = await calculateSplinterExtraRewards(curs);
							post.splinter_boosts.push({rarity: curs, cardCount: curRarity, extraRewards: extraTokens})
							
							post.post_score += parseInt(extraTokens);
						}
					}
					
					//check if user has an AFIT boost as percent increments
					boost_res = await grabConsumeUserBoostByType(post.author, 'AFIT', 'percent_reward', post, true);
					
					post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
					
					//check if user has a User Rank boost as percent increments
					let appendPercTokens = boost_res.extra_boost;
					
					//append as percentage
					post.post_score += appendPercTokens * post.post_score / 100;
					post.boost_afit_percent_reward = appendPercTokens;
					
					console.log('new post score:'+post.post_score);
					
					//check if user has an AFIT boost as unit entries
					
					boost_res = await grabConsumeUserBoostByType(post.author, 'AFIT', 'unit', post, true);
					
					post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
					
					//check if user has a User Rank boost as percent increments
					let appendTokens = boost_res.extra_boost;
					
					//append tokens
					post.post_score += appendTokens;
					post.boost_afit_units = appendTokens;
					
					console.log('new post score:'+post.post_score);
					
					//check if user has an AFIT boost as range entries
					
					boost_res = await grabConsumeUserBoostByType(post.author, 'AFIT', 'range', post, true);
					
					post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
					
					//check if user has a User Rank boost as percent increments
					appendTokens = boost_res.extra_boost;
					
					//append tokens
					post.post_score += appendTokens;
					post.boost_afit_units = appendTokens;
					
					console.log('new post score:'+post.post_score);
					
				}
				
			
				
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
				if (!config.testing){
					bulk.find( { permlink: post.permlink } ).upsert().replaceOne(
								   post
								);
					proceed_bulk = true;
				}
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
				
				//check if the post has other beneficiaries (as a result of referral) so as to give them portion of AFIT rewards
				let referrer_reward_acct = '';
				let reward_pct = 0;
				let referrer_reward_amt = 0;
				
				for (var x = 0; x < post.beneficiaries.length; x++) {
					let testAccount = post.beneficiaries[x].account;
					if (testAccount != config.beneficiaries[0]
						&& testAccount != config.beneficiaries[1]
						&& testAccount != config.full_pay_benef_account){
							referrer_reward_acct = testAccount;
							reward_pct = parseInt(post.beneficiaries[x].weight)/100;
							referrer_reward_amt = parseFloat((reward_pct * activity_afit_reward / 100).toFixed(4));
							activity_afit_reward = parseFloat((activity_afit_reward * (100-reward_pct) / 100).toFixed(4));
							break;
					}
				}
				
				//AFIT Requirement: verify user count before rewarding as might not be eligible
				
				let post_transaction = {
					user: reward_user,
					reward_activity: activity_type,
					token_count: activity_afit_reward,
					url: post.url,
					date: new Date(post.created),
					note: note,
					reward_system: reward_sys_version
				}
				
				//fetch user's token count to make sure of eligibility to AFIT rewards
				userInfo = await grabUserTokensFunc(reward_user);
				tokenCount = parseFloat(userInfo.tokens);
				//console.log('gotten '+post.author + ' AFIT bal ' + tokenCount);
				
				//give out 0 rewards if user does not reach threshold
				if (tokenCount < parseFloat(config.min_afit_reward_elig)){
					console.log('>> '+reward_user+' '+tokenCount+' AFIT less than min reqt')
					post_transaction.token_count = 0;
					post.zero_afit=true;
				}else{
					console.log('>>>> '+reward_user+' min AFIT reqt met '+tokenCount)
				}
				
				
				//also in case of charity, we need to append the actual user
				if (typeof post.json.charity != 'undefined' && post.json.charity != '' && post.json.charity != 'undefined'){
					post_transaction['giver'] = post.author;
				}
			  
				if (!config.testing){
					bulk_transactions.find(
					{ 
						user: post_transaction.user,
						reward_activity: post_transaction.reward_activity,
						url: post_transaction.url
					}).upsert().replaceOne(post_transaction); 
					proceed_bulk_transactions = true;
				}
				//reward back to referrer
				
				//AFIT Requirement: also no referrer reward if user does not have enough count
				
				try{
				if (referrer_reward_acct){
					note = "Referral Reward Share From User Activity Report"
					let ref_trans = {
						user: referrer_reward_acct,
						reward_activity: 'Referral Beneficiary',
						token_count: referrer_reward_amt,
						referral_percent: reward_pct,
						post_author: post.author,
						url: post.url,
						date: new Date(post.created),
						note: note,
						reward_system: reward_sys_version
					}
					
					//fetch user's token count to make sure of eligibility to AFIT rewards
					userInfo = await grabUserTokensFunc(reward_user);
					tokenCount = parseFloat(userInfo.tokens);
					console.log('gotten '+post.author + ' AFIT bal ' + tokenCount);
					
					//give out 0 rewards if user does not reach threshold
					if (tokenCount < parseFloat(config.min_afit_reward_elig)){
						ref_trans.token_count = 0;
						post.zero_afit=true;
					}
					
					if (!config.testing){
						//we also need to insert another transaction to capture the actual activity/reward by the user
						bulk_transactions.find(
						{ 
							user: ref_trans.user,
							reward_activity: ref_trans.reward_activity,
							post_author: ref_trans.post_author,
							url: ref_trans.url
						}).upsert().replaceOne(ref_trans);
						proceed_bulk_transactions = true;
					}
				}
				}catch(ref_benef_exc){
					console.log(ref_benef_exc);
				}
				
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
					
					if (!config.testing){
					//we also need to insert another transaction to capture the actual activity/reward by the user
					bulk_transactions.find(
					{ 
						user: charity_trans.user,
						reward_activity: charity_trans.reward_activity,
						url: charity_trans.url
					}).upsert().replaceOne(charity_trans);
					proceed_bulk_transactions = true;
					}
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
							
							if (!config.testing){
								bulk_transactions.find(
								{ 
									user: vote_transaction.user,
									reward_activity: vote_transaction.reward_activity,
									url: vote_transaction.url
								}).upsert().replaceOne(vote_transaction);
								//transactions.push(vote_transaction);
								proceed_bulk_transactions = true;
							}
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
		utils.log(proceed_bulk_posts_skip);
		try{
			if (proceed_bulk_posts_skip && !config.testing){
				await bulk_posts_skip.execute();
			}
		}catch(bulkerr){
			utils.log(bulkerr);
		}
		
		utils.log('votePosts.length:'+votePosts.length);
		utils.log(proceed_bulk);
		utils.log(proceed_bulk_transactions);
		if (votePosts.length>0 && !config.testing){
			try{
				//store posts
				if (proceed_bulk){
					await bulk.execute();
					console.log('database insertion complete');
				}
			}catch(bulkerr){
				utils.log(bulkerr);
				console.log('error database insertion');
			}
			try{
				//award transaction tokens
				if (proceed_bulk_transactions){
					await bulk_transactions.execute();
				}
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
				/*	
					//Sort posts by reverse score, so as when popping them we get sorted by highest
					votePosts.sort(function(post1, post2) {
					  
					  return post1.post_score - post2.post_score;
					});
				*/
				
				//}
		
				
				utils.log(vote_data.power_per_vote + ' power per full vote.');
				
				
				/************************* winner reward ******************************/
				
				
				//special pick verified newbie rewards
				
				//grab list of eligible verified newbie accounts
				
				let newbieList= await fetch(active_actifit_api+'activeVerifiedNewbies/');
				let newbieEligListRes = await newbieList.json();
				let interimEligList = [];
				finalEligNewbieList = [];
				
				for (let lpr=0;lpr<newbieEligListRes.length;lpr++){
				//update list to contain users having a post
					let matchPst = votePosts.find( user_post => user_post.author === newbieEligListRes[lpr].user);
					if (matchPst){
						interimEligList.push(newbieEligListRes[lpr].user);
						matchPst.newbie_reward = 1;
					}
					console.log(matchPst);
				}
				
				console.log('current full eligible list');
				console.log(interimEligList);
				if (interimEligList.length<=config.max_newbie_reward_count){
					//we have all our list already
					finalEligNewbieList = interimEligList;
				}else{
					while(finalEligNewbieList.length < config.max_newbie_reward_count){
						let r = Math.floor(Math.random() * (interimEligList.length)); //generate random number between 0 and array length
						//only append the item if not already added
						if (finalEligNewbieList.indexOf(interimEligList[r]) === -1){
							finalEligNewbieList.push(interimEligList[r]);
						}
					}
				}
				console.log('final selected list');
				console.log(finalEligNewbieList);
			
				//let's pick a random winner to double up his votes and adjust his AFIT reward score
				
				try{
					lucky_winner_id = utils.generateRandomNumber(1, votePosts.length);
					let post = votePosts[lucky_winner_id];
					
					
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
					
					//AFIT Requirement: also zero out user rewards if balance is less than threshold
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
					
					userInfo = await grabUserTokensFunc(reward_user);
					tokenCount = parseFloat(userInfo.tokens);

					
					//give out 0 rewards if user does not reach threshold
					if (tokenCount < parseFloat(config.min_afit_reward_elig)){
						post_transaction.token_count = 0;
						post_transaction.lucky_winner = 0;
						post.zero_afit=true;
					}
					
					
					//adjust post_score according to reward
					post.post_score = post.post_score * reward_factor;
					post.rate_multiplier = post.post_score / 100;
					post.reward_factor = reward_factor;
					post.lucky_winner = 1;
				  
					if (!config.testing){
						bulk_transactions.find(
						{ 
							user: post_transaction.user,
							reward_activity: post_transaction.reward_activity,
							url: post_transaction.url
						}).upsert().replaceOne(post_transaction); 		
						//award transaction tokens
						await bulk_transactions.execute();
					}
					
				}catch(bulkerr){
					utils.log(bulkerr);
				}
				
				utils.log(votePosts[lucky_winner_id].post_score);
				
				/***************** Check for AFIT/STEEM upvote exchange ******************/
				
				
				let extra_reward_arr = [
									{afit: 5, upvote: 10},//legacy support
									{afit: 10, upvote: 15},//legacy support
									{afit: 15, upvote: 20},//legacy support
									{afit: 20, upvote: 25},//legacy support
									{afit: 500, upvote: 10},//legacy support
									{afit: 1000, upvote: 15},//legacy support
									{afit: 1500, upvote: 20},//legacy support
									{afit: 2000, upvote: 25},//legacy support
									{afit: 50, upvote: 10},
									{afit: 100, upvote: 15},
									{afit: 150, upvote: 20},
									{afit: 200, upvote: 25},
									];
				
				try{
				
					//assign an ID to this reward cycle
					let reward_cycle_ID = 'RC' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase()
					
					//calculate current vote value, and relating voting percentage needed
					//get vote value at 100%
					//let full_vote_value = getVoteValueUSD(100, account, 100, hive_price);
					//console.log('full_vote_value')
					//console.log(full_vote_value)
					
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
							/*
							//calculate total paid AFIT in USD (which should be equal to a 65% reward, since Actifit removes 10% benefic, and author reward removes 75%
							let usd_val_no_benef = parseFloat(cur_upvote_entry.paid_afit) * parseFloat(cur_afit_price.unit_price_usd);//20*0.02=0.4
							
							//expand the USD val to take into consideration 75% curation reward
							let usd_val_no_curation = usd_val_no_benef * 0.75 / 0.65; //0.4*0.75/0.65=0.4615384615384615
							
							//final upvote value after avoiding deductions
							let usd_val = usd_val_no_benef / 0.5; //0.4/0.5=0.8
							
							//emulate proper voting power to give user matching rewards
							let user_added_vote_weight = usd_val * 100 / full_vote_value; //0.8*100/full_vote_value
							*/
							
							let user_added_vote_weight_entry = extra_reward_arr.find( match => match.afit === parseInt(cur_upvote_entry.paid_afit));
							
							console.log('>>>>user_added_vote_weight_entry');
							
							console.log(user_added_vote_weight_entry);
							
							let user_added_vote_weight = user_added_vote_weight_entry.upvote;
							
							let entry_index = votePosts.findIndex( user_post => user_post.author === cur_upvote_entry.user);
							
							
							//decrease by 1% since assisting accounts will vote too (pay & funds) only if we still have room to use them
							//only consume half of those now, leave the rest to other accounts
							if (helping_accounts_votes < (config.max_helping_votes / 2)){
								//user_added_vote_weight -= 1;
								
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
							//cur_upvote_entry.usd_val_no_benef = +usd_val_no_benef;
							//cur_upvote_entry.usd_val_no_curation = +usd_val_no_curation.toFixed(2);
							//cur_upvote_entry.usd_val = +usd_val.toFixed(2);
							
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
								
								/*
								//calculate total paid AFIT in USD (which should be equal to a 65% reward, since Actifit removes 10% benefic, and author reward removes 75%
								let usd_val_no_benef = parseFloat(cur_upvote_entry.paid_afit) * parseFloat(cur_afit_price.unit_price_usd);
								
								//expand the USD val to take into consideration 75% curation reward
								let usd_val_no_curation = usd_val_no_benef * 0.75 / 0.65
								
								//final upvote value after avoiding deductions
								let usd_val = usd_val_no_benef / 0.5 
								
								//emulate proper voting power to give user matching rewards
								let user_added_vote_weight = usd_val * 100 / full_vote_value;
								*/
								
								let user_added_vote_weight_entry = extra_reward_arr.find( match => match.afit === parseInt(cur_upvote_entry.paid_afit));
							
								let user_added_vote_weight = user_added_vote_weight_entry.upvote;
							
								let entry_index = votePosts.findIndex( user_post => user_post.author === cur_upvote_entry.user);
								
								//decrease by 1% since assisting accounts will vote too (pay & funds) only if we still have room to use them
								if (helping_accounts_votes < config.max_helping_votes){
									//user_added_vote_weight -= 1;
									
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
								//cur_upvote_entry.usd_val_no_benef = +usd_val_no_benef;
								//cur_upvote_entry.usd_val_no_curation = +usd_val_no_curation.toFixed(2);
								//cur_upvote_entry.usd_val = +usd_val.toFixed(2);
								
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
				sendMsg('Rewards round has now started! If you created an actifit report recently with more than 5,000 steps, you might receive HIVE/HBD/AFIT rewards.');
				targetPostCount = votePosts.length;
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

async function fecthAFITHEHolders(){
	console.log('--- Fetch AFIT user balances --- ');
	let holderList = await fetch(active_actifit_api+'topAFITHEHolders');
	if (holderList != null){
		topUsersAFIT = await holderList.json();
	}
	//console.log(topUsersAFIT);
}

async function fetchAFITXTopHolders(){

	console.log('--- Fetch AFITX top users --- ');
	let holderList = await fetch(active_actifit_api+'topAFITXHolders?count='+config.topAFITXCount);
	if (holderList != null){
		topUsersAFITX = await holderList.json();
	}
	console.log(topUsersAFITX);
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
		
		
		sendMsg('Rewards round is now complete! '+targetPostCount+' actifit reports have received rewards. Congrats to all participants! If your actifit report did not receive rewards yet, stay tuned for the next round starting in less than 24 hours');
		
        //is_voting = false;
		setIsVoting(false);
        error_sent = false;
        saveState();
		
		//since we're done voting, we need to update all user tokens to reflect new rewards
		if (!config.testing){
			updateUserTokens();
		}
        //reportEmail(config.report_emails)
      }, config.voting_posting_delay);
    }
  })
  .catch(err => {
      utils.log(err);
  })
}


async function sendVote(post, retries, power_per_vote) {
	
	
	utils.log('Voting on: ' + post.url + ' with count'+post.json.step_count);
	var token_count = post.post_score;//parseFloat(post.rate_multiplier)*100;
  
	console.log(power_per_vote);
  
	var vote_weight = Math.floor(post.rate_multiplier * power_per_vote);
	let stdrd_vote_weight = vote_weight * config.partner_comm_vote_mult;
	console.log('vote weight:'+vote_weight);
	
	//if user had paid AFIT for extra STEEM upvotes, add this to their upvote value
	if (post.additional_vote_weight){
		vote_weight += post.additional_vote_weight
		console.log('new vote weight:'+vote_weight);
	}
	
	//check if this user is a newbie eligible for extra rewards
	if (Array.isArray(finalEligNewbieList) && finalEligNewbieList.length > 0){
		console.log('we have eligible newbies for extra rewards!');
		let entryIdx = finalEligNewbieList.indexOf(post.author);
		if (entryIdx !== -1){
			vote_weight = config.max_newbie_vote_pct;
			console.log('Newbie user '+post.author+' eligible for extra vote. Vote weight:'+vote_weight);
			finalEligNewbieList.splice(entryIdx, 1);
		}
	}
	
	post_rank += 1;
	
	//if this is a sponsored athlete, give them special reward
	if (config.sponsored_athletes.includes(post.author)){
		vote_weight = config.sponsored_athlete_upvote_reward;
	}
  
  
	if (vote_weight > config.max_vote_per_post){
		vote_weight = config.max_vote_per_post;
	}
	
	//append a min val boost for very low vote rewards
	if (vote_weight < config.extra_boost_min_val){
		vote_weight += config.extra_boost_pct_increase;
	}
	
	utils.log('|#'+post_rank+'|@'+post.author+'|'+ post.json.step_count +'|'+token_count+' Tokens|'+utils.format(vote_weight / 100)+'%|[post](https://www.actifit.io'+post.url+')');
  
	
	if (stdrd_vote_weight > config.max_vote_per_post){
		stdrd_vote_weight = config.max_vote_per_post;
	}
	
	let net_rewards_vote_weight = stdrd_vote_weight;
	
	console.log('old sports percent:'+stdrd_vote_weight);
	
	/*if (config.testing){
		console.log('switch author');
		console.log(post.author);
		post.author = 'mcfarhat';
		post.permlink = 'actifit-witness-vote-application-msp';
	}*/
	
	let boost_res = await grabConsumeUserBoostByType(post.author, 'SPORTS', 'percent_reward', post, true);
				
	post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
	
	//check if user has a SPORTS boost as percent increments
	let appendPercTokens = boost_res.extra_boost;
	
	//append as percentage
	stdrd_vote_weight += appendPercTokens * stdrd_vote_weight / 100;
	stdrd_vote_weight = Math.floor(stdrd_vote_weight);
	post.boost_sports_percent_reward = appendPercTokens;
	
	console.log('new sports percent:'+stdrd_vote_weight);
	
	//check if user has a SPORTS boost as percent increments
	
	boost_res = await grabConsumeUserBoostByType(post.author, 'SPORTS', 'percent', post, true);
				
	post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
	
	//check if user has a SPORTS boost as percent increments
	let appendNetPercTokens = boost_res.extra_boost;
	
	//append as percentage
	stdrd_vote_weight += appendNetPercTokens * 100;
	stdrd_vote_weight = Math.floor(stdrd_vote_weight);
	post.boost_sports_percent = appendNetPercTokens;
	
	console.log('new sports percent:'+stdrd_vote_weight);
	
	
	//check if user has an APPICS boost as percent 
	
	//first need to make sure the post benefits from APX vote (meaning has APX tag)
	
	let tags = JSON.parse(post.json_metadata).tags;
	
	console.log('checking APX ');
	//console.log(tags);
	//console.log(tags.findIndex(item => config.appics_tag.toLowerCase() === item.toLowerCase()));
	
	if(tags && tags.length > 0 && tags.findIndex(item => config.appics_tag.toLowerCase() === item.toLowerCase()) != -1) {
		
		utils.log('Post contains APX tag for extra vote ' + post.url);
		
		let curAuthor = post.author;
		if (config.testing){
			//curAuthor= 'mcfarhat';
		}
		boost_res = await grabConsumeUserBoostByType(curAuthor, 'APX', 'percent', post, true);
					
		post.user_post_boosts = post.user_post_boosts.concat(boost_res.user_post_boosts);
		
		let appendApxPercTokens = boost_res.extra_boost;
		
		//append as percentage
		let boost_apx_percent = appendApxPercTokens * 100;
		boost_apx_percent = Math.floor(boost_apx_percent);
		post.boost_apx_percent = boost_apx_percent;
		post.vote_appics = true;
		
		console.log('new APX percent:' + post.boost_apx_percent);
	
	}
	
	post.vote_weight = vote_weight;
	last_votes.push(post);

	return new Promise(async (resolve, reject) => {
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
				//db.collection('exchange_afit_steem').save(cur_upvote_entry);
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
			
			let res;
			
			
			if (config.hive_voting_active){
			
				//first bchain transactions
				console.log('set HIVE node');
				/*
				steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
				//vote first using pay and funds accounts only if we have an AFIT/STEEM exchange operation and we have room to upvote using helping accounts
				if (post.additional_vote_weight && post.helperVotes){
					let vote_percent_add_accounts = config.helping_account_percent;//at 50%: 5000
					try{
											
						utils.log('voting with '+config.full_pay_benef_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);
						/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
						res = await hive.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.full_pay_benef_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": vote_percent_add_accounts
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.full_pay_posting_key }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}catch(err){
						utils.log(err);
					}
					
					try{
						utils.log('voting with '+config.pay_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);			
						/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
						res = await hive.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.pay_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": vote_percent_add_accounts
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.pay_account_post_key }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
					
					}catch(err){
						utils.log(err);
					}
					
				}
				
				//if additional partner accounts enabled, vote using them as well
				try{
					if (config.zzan_active){
						utils.log('voting with '+config.zzan_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);			
						/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
						res = await hive.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.zzan_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": stdrd_vote_weight
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.zzan_pk }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}
				}catch(err){
					utils.log(err);
				}
				
				try{
					if (config.sports_active){
						utils.log('voting with '+config.sports_active+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);			
						/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
						res = await hive.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.sports_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": stdrd_vote_weight
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.sports_pk }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}
				}catch(err){
					utils.log(err);
				}
				
				//append appics account gadget-based voting 
				
					if (config.appics_active && post.vote_appics){
						
						try{
							utils.log('voting with '+config.appics_account+ ' '+utils.format(post.boost_apx_percent / 100) + '% vote cast for: ' + post.url);			
							/*steem.api.setOptions({ 
								url: config.active_hive_node ,
								//useAppbaseApi: true
							});*/
							res = await hive.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.appics_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": post.boost_apx_percent
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.appics_pk }
						   ).catch(e => console.log(e))
							console.log(res);
							if (res && res.block_num) {
								utils.log('success');
							}
						
						}catch(err){
							utils.log(err);
						}
					}
				
				try{
					utils.log('voting with '+config.rewards_account+ ' '+utils.format(net_rewards_vote_weight * 3 / 100) + '% vote cast for: ' + post.url);			
					/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
					res = await hive.broadcast.sendAsync( 
						   { 
							   operations: [ 
									   ['vote', 
										 {
											"voter": config.rewards_account,
											"author": post.author,
											"permlink": post.permlink,
											"weight": net_rewards_vote_weight * 3
										  }
									   ]
								   ], 
							   extensions: [] 
							}, 
						   { posting: config.rewards_account_pk }
					   ).catch(e => console.log(e))
					console.log(res);
					if (res && res.block_num) {
						utils.log('success');
					}
					
				}catch(err){
					utils.log(err);
				}	
								
				try{
					utils.log('voting with '+account.name+ ' '+utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);			
					/*steem.api.setOptions({ 
							url: config.active_hive_node ,
							//useAppbaseApi: true
						});*/
					res = await hive.broadcast.sendAsync( 
						   { 
							   operations: [ 
									   ['vote', 
										 {
											"voter": account.name,
											"author": post.author,
											"permlink": post.permlink,
											"weight": vote_weight
										  }
									   ]
								   ], 
							   extensions: [] 
							}, 
						   { posting: config.posting_key }
					   ).then(async function(rest, err) {
							
							
							//notify user of voting success
							utils.sendNotification(db, post.author, account.name, 'post_reward', 'Your activity report "'+ post.title + '" has been rewarded!', 'https://actifit.io'+post.url);
							
							//store exchange transaction as complete
							if (post.additional_vote_weight){
								console.log('Exchange vote');
								let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
												entry.post_permlink === post.permlink && 
												entry.user === post.author);
								console.log(cur_upvote_entry);
								cur_upvote_entry.upvote_processed = true;
								db.collection('exchange_afit_steem').save(cur_upvote_entry);
								
								
								if (post.top_afitx_holder){
									//notify user of top AFITX vote
									utils.sendNotification(db, post.author, account.name, 'top_afitx_holder_vote', 'You received extra vote reward of ' + utils.format(post.additional_vote_weight / 100) + '% for being a top AFITX holder on activity report "'+ post.title + '"!', 'https://actifit.io'+post.url);
									
									sendMsg('Actifit User @'+post.author+' received extra reward on their recent Actifit Post via AFIT vote exchange and being a **top AFITX holder**! 🤩 '+'https://actifit.io'+post.url);
									
								}else{
									//notify user of exchange vote
									utils.sendNotification(db, post.author, account.name, 'exchange_vote', 'You received extra vote reward of ' + utils.format(post.additional_vote_weight / 100) + '% for your exchange request on activity report "'+ post.title + '"!', 'https://actifit.io'+post.url);
									sendMsg('Actifit User @'+post.author+' received extra reward on their recent Actifit Post via AFIT vote exchange! 🤩 '+'https://actifit.io'+post.url);
								}
							}
							
							
							
							if(config.comment_location && config.comment){
								await sendComment(post, 0, vote_weight, 'HIVE')
								.then( res => {
									//resolve(res)
									
									
									console.log(res)
								}).catch(err => {
									console.log(err);
								})
								
								//await customComment(post);
								
						   }
					   }).catch(e => console.log(e))
					console.log(res);
					if (res && res.block_num) {
						utils.log('success');
						
						
						
						
							
							//wait 5 seconds before commenting
							//await delay(5000);						
							
							//setTimeout(function () { 	
							/*	await sendComment(post, 0, vote_weight, config.active_hive_node)
									.then( res => {
										//resolve(res)
										console.log(res)
									})
									.catch(err => {
										console.log(err);
									})*/
							//}, config.voting_posting_delay);
						/*}else{
							//resolve(result);   
						}*/
					}else{
						 // Try again one time on error
						/*if (retries < config.max_vote_comment_retries){
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
						}*/
					}
					
					
				
				}catch(mainerr){
					utils.log(mainerr);
				}
			}
		
			if (config.steem_voting_active){
				
				/*************************************************/
				/*************************************************/
				/*************************************************/
				
				//second blockchain transactions
				console.log('set STEEM node');
				/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
				//vote first using pay and funds accounts only if we have an AFIT/STEEM exchange operation and we have room to upvote using helping accounts
				if (post.additional_vote_weight && post.helperVotes){
					let vote_percent_add_accounts = config.helping_account_percent;//at 50%: 5000
					try{
											
						utils.log('voting with '+config.full_pay_benef_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);
						
						/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
						res = await steem.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.full_pay_benef_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": vote_percent_add_accounts
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.full_pay_posting_key }
						  ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}catch(err){
						utils.log(err);
					}
					
					try{
						utils.log('voting with '+config.pay_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);						
						/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
						res = await steem.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.pay_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": vote_percent_add_accounts
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.pay_account_post_key }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
					
					}catch(err){
						utils.log(err);
					}
					
				}
				
				//if additional partner accounts enabled, vote using them as well
				try{
					if (config.zzan_active){
						utils.log('voting with '+config.zzan_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);						
						/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
						res = await steem.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.zzan_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": stdrd_vote_weight
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.zzan_pk }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}
				}catch(err){
					utils.log(err);
				}
				
				try{
					if (config.sports_active){
						utils.log('voting with '+config.sports_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);						
						/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
						res = await steem.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.sports_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": stdrd_vote_weight
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.sports_pk }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.block_num) {
							utils.log('success');
						}
						
					}
				}catch(err){
					utils.log(err);
				}
				
				//append appics account gadget-based voting 
				
					if (config.appics_active && post.vote_appics){
						
						try{
							utils.log('voting with '+config.appics_account+ ' '+utils.format(post.boost_apx_percent / 100) + '% vote cast for: ' + post.url);						
							/*steem.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
							res = await steem.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.appics_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": post.boost_apx_percent
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.appics_pk }
						   ).catch(e => console.log(e))
							console.log(res);
							if (res && res.block_num) {
								utils.log('success');
							}
						
						}catch(err){
							utils.log(err);
						}
					}
				
				try{
				utils.log('voting with '+config.rewards_account+ ' '+utils.format(net_rewards_vote_weight / 100) + '% vote cast for: ' + post.url);						
					/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
					res = await steem.broadcast.sendAsync( 
						   { 
							   operations: [ 
									   ['vote', 
										 {
											"voter": config.rewards_account,
											"author": post.author,
											"permlink": post.permlink,
											"weight": net_rewards_vote_weight
										  }
									   ]
								   ], 
							   extensions: [] 
							}, 
						   { posting: config.rewards_account_pk }
					   ).catch(e => console.log(e))
					console.log(res);
					if (res && res.block_num) {
						utils.log('success');
					}
					
				}catch(err){
					utils.log(err);
				}	
								
				try{
					
					/*if (post.additional_vote_weight && vote_weight > config.min_vote_weight_decrease){
						//decrease amount by 1% across votes to be able to reward team
						vote_weight -= config.extra_vote_weight_increase;//
					}*/
					
					//increase amount by 2% across votes to be able to reward team
					vote_weight += config.extra_vote_weight_increase;
					
					utils.log('voting with '+account.name+ ' '+utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);						
					/*steem.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
					res = await steem.broadcast.sendAsync( 
						   { 
							   operations: [ 
									   ['vote', 
										 {
											"voter": account.name,
											"author": post.author,
											"permlink": post.permlink,
											"weight": vote_weight
										  }
									   ]
								   ], 
							   extensions: [] 
							}, 
						   { posting: config.posting_key }
					   )
					   .then(async function(rest, err) {
							
							//store exchange transaction as complete
							/*if (post.additional_vote_weight){
								console.log('Exchange vote');
								let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
												entry.post_permlink === post.permlink && 
												entry.user === post.author);
								console.log(cur_upvote_entry);
								cur_upvote_entry.upvote_processed = true;
								db.collection('exchange_afit_steem').save(cur_upvote_entry);
							}*/
					  
							/*if(config.comment_location && config.comment){
									
								//setTimeout(function () { 	
								
									//wait 5 seconds before commenting
									//await delay(5000);
								
									await sendComment(post, 0, vote_weight, 'STEEM')
										.then( res => {
											//resolve(res)
										}).catch(err => {
											//reject(err);
										})
								//}, config.voting_posting_delay);
							}else{
								//resolve('');   
							} */
					   }).catch(e => console.log(e))
					console.log(res);
					if (res && res.block_num) {
						utils.log('success');
						
						//store exchange transaction as complete
						/*if (post.additional_vote_weight){
							console.log('Exchange vote');
							let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
											entry.post_permlink === post.permlink && 
											entry.user === post.author);
							console.log(cur_upvote_entry);
							cur_upvote_entry.upvote_processed = true;
							db.collection('exchange_afit_steem').save(cur_upvote_entry);
						}*/
						
						
					}else{
						 // Try again one time on error
						/*if (retries < config.max_vote_comment_retries){
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
						}*/
					}
				
				}catch(mainerr){
					utils.log(mainerr);
				}
				
			}
			
			if (config.blurt_voting_active){
				
				/*************************************************/
				/*************************************************/
				/*************************************************/
				
				//second blockchain transactions
				console.log('set blurt node');
				/*blurt.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
				//vote first using pay and funds accounts only if we have an AFIT/blurt exchange operation and we have room to upvote using helping accounts
				let altAcctsBlurtVotingOn = false;
				
				if (altAcctsBlurtVotingOn){
					if (post.additional_vote_weight && post.helperVotes){
						let vote_percent_add_accounts = config.helping_account_percent;//at 50%: 5000
						try{
												
							utils.log('voting with '+config.full_pay_benef_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);
							
							/*blurt.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
							res = await blurt.broadcast.sendAsync( 
								   { 
									   operations: [ 
											   ['vote', 
												 {
													"voter": config.full_pay_benef_account,
													"author": post.author,
													"permlink": post.permlink,
													"weight": vote_percent_add_accounts
												  }
											   ]
										   ], 
									   extensions: [] 
									}, 
								   { posting: config.full_pay_posting_key }
							  ).catch(e => console.log(e))
							console.log(res);
							if (res && res.ref_block_num) {
								utils.log('success');
							}
							
						}catch(err){
							utils.log(err);
						}
						
						try{
							utils.log('voting with '+config.pay_account+ ' '+utils.format(vote_percent_add_accounts / 100) + '% vote cast for: ' + post.url);						
							/*blurt.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
							res = await blurt.broadcast.sendAsync( 
								   { 
									   operations: [ 
											   ['vote', 
												 {
													"voter": config.pay_account,
													"author": post.author,
													"permlink": post.permlink,
													"weight": vote_percent_add_accounts
												  }
											   ]
										   ], 
									   extensions: [] 
									}, 
								   { posting: config.pay_account_post_key }
							   ).catch(e => console.log(e))
							console.log(res);
							if (res && res.ref_block_num) {
								utils.log('success');
							}
						
						}catch(err){
							utils.log(err);
						}
						
					}
					
					//if additional partner accounts enabled, vote using them as well
					try{
						if (config.zzan_active){
							utils.log('voting with '+config.zzan_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);						
							/*blurt.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
							res = await blurt.broadcast.sendAsync( 
								   { 
									   operations: [ 
											   ['vote', 
												 {
													"voter": config.zzan_account,
													"author": post.author,
													"permlink": post.permlink,
													"weight": stdrd_vote_weight
												  }
											   ]
										   ], 
									   extensions: [] 
									}, 
								   { posting: config.zzan_pk }
							   ).catch(e => console.log(e))
							console.log(res);
							if (res && res.ref_block_num) {
								utils.log('success');
							}
							
						}
					}catch(err){
						utils.log(err);
					}
					
					try{
						if (config.sports_active){
							utils.log('voting with '+config.sports_account+ ' '+utils.format(stdrd_vote_weight / 100) + '% vote cast for: ' + post.url);						
							/*blurt.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
							res = await blurt.broadcast.sendAsync( 
								   { 
									   operations: [ 
											   ['vote', 
												 {
													"voter": config.sports_account,
													"author": post.author,
													"permlink": post.permlink,
													"weight": stdrd_vote_weight
												  }
											   ]
										   ], 
									   extensions: [] 
									}, 
								   { posting: config.sports_pk }
							   ).catch(e => console.log(e))
							console.log(res);
							if (res && res.ref_block_num) {
								utils.log('success');
							}
							
						}
					}catch(err){
						utils.log(err);
					}
					
					//append appics account gadget-based voting 
					
						if (config.appics_active && post.vote_appics){
							
							try{
								utils.log('voting with '+config.appics_account+ ' '+utils.format(post.boost_apx_percent / 100) + '% vote cast for: ' + post.url);						
								/*blurt.api.setOptions({ 
									url: config.active_node ,
									//useAppbaseApi: true
								});*/
								res = await blurt.broadcast.sendAsync( 
								   { 
									   operations: [ 
											   ['vote', 
												 {
													"voter": config.appics_account,
													"author": post.author,
													"permlink": post.permlink,
													"weight": post.boost_apx_percent
												  }
											   ]
										   ], 
									   extensions: [] 
									}, 
								   { posting: config.appics_pk }
							   ).catch(e => console.log(e))
								console.log(res);
								if (res && res.ref_block_num) {
									utils.log('success');
								}
							
							}catch(err){
								utils.log(err);
							}
						}
					
					try{
					utils.log('voting with '+config.rewards_account+ ' '+utils.format(net_rewards_vote_weight / 100) + '% vote cast for: ' + post.url);						
						/*blurt.api.setOptions({ 
								url: config.active_node ,
								//useAppbaseApi: true
							});*/
						res = await blurt.broadcast.sendAsync( 
							   { 
								   operations: [ 
										   ['vote', 
											 {
												"voter": config.rewards_account,
												"author": post.author,
												"permlink": post.permlink,
												"weight": net_rewards_vote_weight
											  }
										   ]
									   ], 
								   extensions: [] 
								}, 
							   { posting: config.rewards_account_pk }
						   ).catch(e => console.log(e))
						console.log(res);
						if (res && res.ref_block_num) {
							utils.log('success');
						}
						
					}catch(err){
						utils.log(err);
					}

				}		
								
				try{
					
					/*if (post.additional_vote_weight && vote_weight > config.min_vote_weight_decrease){
						//decrease amount by 1% across votes to be able to reward team
						vote_weight -= config.extra_vote_weight_increase;//
					}*/
					
					//increase amount by 2% across votes to be able to reward team
					vote_weight += config.blurt_extra_vote_weight_increase;
					
					utils.log('voting with '+account.name+ ' '+utils.format(vote_weight / 100) + '% vote cast for: ' + post.url);						
					/*blurt.api.setOptions({ 
							url: config.active_node ,
							//useAppbaseApi: true
						});*/
					res = await blurt.broadcast.sendAsync( 
						   { 
							   operations: [ 
									   ['vote', 
										 {
											"voter": account.name,
											"author": post.author,
											"permlink": post.permlink,
											"weight": vote_weight
										  }
									   ]
								   ], 
							   extensions: [] 
							}, 
						   { posting: config.posting_key }
					   )
					   .then(async function(rest, err) {
							
							//store exchange transaction as complete
							/*if (post.additional_vote_weight){
								console.log('Exchange vote');
								let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
												entry.post_permlink === post.permlink && 
												entry.user === post.author);
								console.log(cur_upvote_entry);
								cur_upvote_entry.upvote_processed = true;
								db.collection('exchange_afit_steem').save(cur_upvote_entry);
							}*/
							
							//no comments for now on blurt due to trx cost
							/*if(config.comment_location && config.comment){
									
								//setTimeout(function () { 	
								
									//wait 5 seconds before commenting
									//await delay(5000);
								
									await sendComment(post, 0, vote_weight, 'STEEM')
										.then( res => {
											//resolve(res)
										}).catch(err => {
											//reject(err);
										})
								//}, config.voting_posting_delay);
							}else{
								//resolve('');   
							} */
					   }).catch(e => console.log(e))
					console.log(res);
					if (res && res.ref_block_num) {
						utils.log('success');
						
						//store exchange transaction as complete
						/*if (post.additional_vote_weight){
							console.log('Exchange vote');
							let cur_upvote_entry = afit_steem_upvote_list.find( entry => entry.post_author === post.author && 
											entry.post_permlink === post.permlink && 
											entry.user === post.author);
							console.log(cur_upvote_entry);
							cur_upvote_entry.upvote_processed = true;
							db.collection('exchange_afit_steem').save(cur_upvote_entry);
						}*/
						
						
					}else{
						 // Try again one time on error
						/*if (retries < config.max_vote_comment_retries){
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
						}*/
					}
				
				}catch(mainerr){
					utils.log(mainerr);
				}
				
			}
			
			resolve('');
		}
	});
}

/* function handles calculating and returning user token count */
grabUserTokensFunc = async function (username){
	let user = await db.collection('user_tokens').findOne({_id: username});
	console.log(user);
	//fixing token amount display for 3 digits
	if (typeof user!= "undefined" && user!=null){
		if (typeof user.tokens!= "undefined"){
			user.tokens = user.tokens.toFixed(3)
		}
	}else{
		user = new Object();
		user._id=username;
		user.name=username;
		user.tokens=0;
	}
	//also append tokens on hive-engine & steem-engine
	let heEntry = topUsersAFIT.find(entry => entry.account === username);
	if (heEntry && !isNaN(heEntry.balance) && heEntry.balance>0){
		user.tokens = parseFloat(user.tokens) + parseFloat(heEntry.balance);
		//console.log(user.tokens);
	}
	
	//also append tokens on BSC
		//check if user has a BSC wallet
	let wallet_entry = await db.collection('user_wallet_address').findOne({user: username});
	try{
		if (wallet_entry && wallet_entry.wallet){
			//console.log(wallet_entry.wallet);
			//fetch wallet balance		
			let result = await afitContract.methods.balanceOf(wallet_entry.wallet).call(); // 29803630997051883414242659
			let format = web3.utils.fromWei(result); // 29803630.997051883414242659
			afitBSC = parseFloat(format);
			//console.log(format);
			user.tokens = parseFloat(user.tokens) + afitBSC;
		}
	}catch(exc){
		console.log('error fetching wallet balance / BSC')
	}
	console.log(user.tokens);
	return user;
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

async function testCustomComment(){
	let cstmquery = {tag: 'arabpromovault', limit: 1};
	hive.api.getDiscussionsByBlog(cstmquery, async function (err, result) {
		if (result && result.length>0){
			console.log('found post')
			let post = result[0];
			console.log(result);
			await customComment(post);
			console.log('done with comment')
		}
	
	})
}

async function customComment(post){
	if (proposalVotersArray.includes(post.author)){
		utils.log('author '+post.author+'already voted for actifit proposal. No need to remind ')
		//skip, we dont need to notify the user as he already voted for our proposal
		return;
	}
	let parentAuthor = post.author;
	let parentPermlink = post.permlink;
	let jsonMetadata = { tags: ['actifit'], app: 'actifit/v'+version};
	let permlink = 're-' + parentAuthor.replace(/\./g, '') + '-' + parentPermlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();
	
	let content = "Hey @"+post.author+"! Great seeing your actifit report! Now is the time to support actifit's growth and services on hive blockchain. <br /> Please vote for our DHF proposal via link [here](https://peakd.com/proposals/250)";
	
	let chainLnk = hive;
	const operations = [ 
		   ['comment', 
			 { 
			   "parent_author": post.author, 
			   "parent_permlink": post.permlink, 
			   "author": config.rewards_account,
			   "permlink": permlink, 
			   "title": 'Support Actifit DHF', 
			   "body": content, 
			   "json_metadata" : JSON.stringify(jsonMetadata)
			 } 
		   ]
	];
	
	console.log(operations);
	
	let res = await chainLnk.broadcast.sendAsync( 
		   { 
			   operations: operations, 
			   extensions: [] 
			}, 
		   { posting: config.rewards_account_pk }
	   ).catch(e => console.log(e))
	utils.log(res);
	if (res && res.block_num) {
		utils.log('Posted comment: ' + permlink);
		//resolve(res);
	}
	
}

async function grabProposalVoters (targetProposal){
	//curl -s --data '{"jsonrpc":"2.0", "method":"condenser_api.list_proposal_votes", "params":[[250], 10, "by_proposal_voter", "ascending", "active"], "id":1}' https://api.hive.blog | more
	
	//let targetProposal = 250;
	
	let outc = await hive.api.callAsync('condenser_api.list_proposal_votes', [[targetProposal], 1000, 'by_proposal_voter', 'ascending', 'all']);//{start:[250], limit: 1000, order: 'by_proposal_voter', order_direction: 'ascending', status: 'active'});
	
	//filter items by target proposal id as the result contains following proposals as well
	
	proposalVotersArray = outc.filter((obj) => obj.proposal['id'] === targetProposal)
							.map((obj) => obj.voter).sort();
							
	console.log(proposalVotersArray)
	console.log('voter count:')
	console.log(proposalVotersArray.length);

    console.log('total voting value:');
	let propInstance = await hive.api.callAsync('condenser_api.find_proposals', [[targetProposal]]);//{start:[250], limit: 1000, order: 'by_proposal_voter', order_direction: 'ascending', status: 'active'});
    console.log(propInstance[0].total_votes);
	//console.log(proposalVotersArray);
	
}

async function sendComment(post, retries, vote_weight, bchain_node) {
	var parentAuthor = post.author;
	var parentPermlink = post.permlink;
	var rate_multiplier = post.rate_multiplier;
	var post_step_count = post.json.step_count;
	
	var content = "";
	// Return promise
	//return new Promise( async (resolve, reject) => {
		
		//start off with proposal notice
		let proposal_msg = fs.readFileSync(config.proposal_comment_location, "utf8");
		
		if (config.proposal_comment_active){
			content = proposal_msg;
		}
		
		if (post.zero_afit){
			content += fs.readFileSync(config.comment_noafit_location, "utf8");	
		}else{
			content += fs.readFileSync(config.comment_location, "utf8");
		}
		
		
		
		let content_sign = fs.readFileSync(config.comment_sign_location, "utf8");

		// If promotion content is specified in the config then use it to comment on the upvoted post
		if (content && content != '') {

			// Generate the comment permlink via steemit standard convention
			var permlink = 're-' + parentAuthor.replace(/\./g, '') + '-' + parentPermlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();

			var token_count = post.post_score;//parseFloat(rate_multiplier)*100;
			
			//if this is a sponsored athlete, give them special reward
			if (config.sponsored_athletes.includes(parentAuthor)){
				token_count = config.sponsored_athlete_afit_reward;
			}
			
			token_count = Math.ceil(token_count * 10000) / 10000;
			
			// Replace variables in the promotion content
			content = content.replace(/\{weight\}/g, utils.format(vote_weight / 100)).replace(/\{token_count\}/g,token_count).replace(/\{step_count\}/g,post_step_count);
			
			console.log('post.user_post_boosts');
			console.log(post.user_post_boosts);
			
			//create proper display for boosts consumed
			let boost_content = '';
			
			//add splinterlands boost data
			//post.splinter_boosts.concat({rarity: curs, cardCount: curRarity, extraRewards: extraTokens})
			if (post.splinter_boosts !=null && post.splinter_boosts.length >0 ){
				boost_content += '<div>The following splinterland boosts were applied to your post:</div>';
				post.splinter_boosts.forEach(boost => {
					// Access each boost object here
					let boost_title = 'Common';
					if (boost.rarity == 2){
						boost_title = 'Rare';
					}else if (boost.rarity == 3){
						boost_title = 'Epic';
					}else if (boost.rarity == 4){
						boost_title = 'Legendary';
					}
					boost_content += '<li>'+boost.cardCount+' '+boost_title+' Cards Boost: +'+ boost.extraRewards+' AFIT';
					console.log(boost.rarity, boost.cardCount, boost.extraRewards);
				});

			}
			
			let maxGadgets = post.user_post_boosts.length;
			let maxGadgetsDisplay = (config.max_comment_gadgets_display<maxGadgets?config.max_comment_gadgets_display:maxGadgets);
			if (maxGadgetsDisplay>0){
				boost_content += '<div>The following boosts were applied to your post:</div>';
			}
			boost_content += '<b><div style="display:flex; flex-wrap: wrap;">';
			for (let i=0;i < maxGadgetsDisplay;i++){
				let cur_boost = post.user_post_boosts[i];
				let prod_info = cur_boost.productdetails[0];
				boost_content += '<div style="flex-direction: column; padding: 5px;">';
				boost_content += '<div class="avatar pro-card-av" style="';
				if (cur_boost.gadget_level > 2){
					boost_content += 'border-color: red;';
				}else if (cur_boost.gadget_level > 1){
					boost_content += 'border-color: orange;';
				}
				boost_content += 'background-image: url(https://actifit.io/img/gadgets/' + prod_info.image + '); width: 90px; height: 90px;"></div>';
				//append standard images to display on the other front-ends
				boost_content += '<img src="https://actifit.io/img/gadgets/' + prod_info.image + '" class="no-actifit">';
				
				boost_content += '<div>';
				for (let iter=0;iter < cur_boost.gadget_level;iter++){
					boost_content += '<i class="fas fa-star text-brand"></i>';
				}				
				boost_content += '</div>';
				boost_content += '<div>'+cur_boost.gadget_name + ' - L'+cur_boost.gadget_level+'</div>';
				console.log('prod_info');
				console.log(prod_info);
				let boosts = prod_info.benefits.boosts;
				if (Array.isArray( boosts) &&  boosts.length > 0){
					let maxBoosts = boosts.length;
					for (let j=0;j<maxBoosts;j++){
						let boost = boosts[j];
						boost_content += '<div>+ ' + boost.boost_amount + ' ' + boost.boost_type.replace('percent_reward','%').replace('percent','%').replace('unit',' ').replace('range',' ') + ' ' + boost.boost_unit + '</div>';
						if (cur_boost.benefic && (cur_boost.benefic == post.author || cur_boost.benefic == '@' + post.author)){
							boost_content += '<div>Thanks to your friend @'+ cur_boost.user + '</div>';
						}
					}
				}
				boost_content += '</div>';
			}
			boost_content += '</div></b>';
			if (maxGadgetsDisplay<maxGadgets){
				//let user know other gadgets were not shown due to being too long for comment
				boost_content += '<div>... and '+(maxGadgets - maxGadgetsDisplay)+' other gadgets.</div>';
			}
			let reward_diff = parseFloat(token_count) - parseFloat(post.afit_pre_boost);
			if (reward_diff > 0){
				boost_content += '<div><i>Boosts increased your AFIT earnings by '+reward_diff.toFixed(4)+' AFIT</i></div>';
			}
			content = content.replace(/\{boost_list\}/g, boost_content);
			
			//replace(/\{milestone\}/g, milestone_txt).
			let community_tag = "hive-193552";
			//adding proper meta content for later relevant reward via afit_tokens data
			var jsonMetadata = { community:[community_tag], tags: [community_tag, 'actifit'], app: 'actifit/v'+version, activity_count: post_step_count, user_rank: post.user_rank, content_score: post.content_score, media_score: post.media_score, upvote_score: post.upvote_score, comment_score: post.comment_score, user_rank_score: post.user_rank_score, moderator_score: post.moderator_score, post_activity_score: post.activity_score, afit_tokens: token_count, post_upvote: vote_weight };
			
			//if this reward contains an exchange amount, list it here
			if (post.additional_vote_weight != null){
				jsonMetadata.promoted_post = true;
				jsonMetadata.additional_vote_weight = post.additional_vote_weight;
				console.log('new vote weight:'+vote_weight);
				content = content.replace(/\{exchange_vote}/g,'**'+utils.format(post.additional_vote_weight/100)+'% of this upvote value is a result of an exchange transaction you performed for '+post.afit_swapped+' AFIT tokens !**');
			}else{
				content = content.replace(/\{exchange_vote}/g,'') 
			}
			
			//user is a newbie winner. Let him know
			if (post.newbie_reward != null){
				if (Array.isArray(finalEligNewbieList) && finalEligNewbieList.length > 0 && vote_weight >= config.max_newbie_vote_pct){
					jsonMetadata.newbie_reward = true;
					content = content.replace(/\{newbie_reward}/g,'***You received a special 20% vote for being a verified newbie! Newbie rewards apply to new verified actifit users on discord, and are given daily to 5 newbies for up to 60 days from the date of your verification*** ');
					
					sendMsg('Actifit User @'+parentAuthor+' received special newbie reward on their recent Actifit Post! 🤩 '+'https://actifit.io'+post.url);
					
				}else{
					content = content.replace(/\{newbie_reward}/g,'');
				}
			}else{
				content = content.replace(/\{newbie_reward}/g,'');
			}
			
			//if this is a top AFITX reward exchange
			if (post.top_afitx_holder != null){
				jsonMetadata.top_afitx_holder = true;
			}
			//if user is lucky winner, add a relevant message

			if (typeof post.lucky_winner != 'undefined' && post.lucky_winner != '' && post.lucky_winner != 'undefined'){
				content = content.replace(/\{lucky_reward}/g,'**You were also selected randomly as a LUCKY WINNER for the day. Your rewards were DOUBLED - DOUBLE CONGRATS!!**');
				jsonMetadata.lucky_winner = 1;
				
				sendMsg('Actifit User @'+parentAuthor+' received the DOUBLE REWARD for the day on their recent Actifit Post! 🤩 '+'https://actifit.io'+post.url);
			}else{
				content = content.replace(/\{lucky_reward}/g,'') 
			}
			
			//only add signature if content is not lengthier than 10,000 characters
			try{
				if (content.length < 10000){
					content += content_sign;
				}
			}catch(exc_len){
				console.log('error testing/appending comment signature');
			}
			
			if (!config.testing){
				// Broadcast the comment
				
				try{
				
				/*steem.api.setOptions({ 
						url: bchain_node ,
						//useAppbaseApi: true
					});*/
				let chainLnk = hive;
				if (bchain_node == 'STEEM'){
					chainLnk = steem;
				}
				console.log(jsonMetadata);
				const operations = [ 
					   ['comment', 
						 { 
						   "parent_author": parentAuthor, 
						   "parent_permlink": parentPermlink, 
						   "author": account.name, 
						   "permlink": permlink, 
						   "title": '', 
						   "body": content, 
						   "json_metadata" : JSON.stringify(jsonMetadata)
						 } 
					   ]
				];
				
				console.log(operations);
				
				let res = await chainLnk.broadcast.sendAsync( 
					   { 
						   operations: operations, 
						   extensions: [] 
						}, 
					   { posting: config.posting_key }
				   ).catch(e => console.log(e))
				utils.log(res);
				if (res && res.block_num) {
					utils.log('Posted comment: ' + permlink);
					//resolve(res);
				}
				
				/*steem.broadcast.comment(config.posting_key, parentAuthor, parentPermlink, account.name, permlink, permlink, content, jsonMetadata, function (err, result) {
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
				});*/
				
				}catch(com_err){
					utils.log(com_err);
				}
				
			}else{
				utils.log('comment');
				console.log(content);
				console.log(jsonMetadata);
				//resolve('');
			}
		}else{
			//reject('Failed to load content');
		}
	//});
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


async function claimRewards(target_chain) {
	console.log('>>>>> claiming rewards');
	if (!config.auto_claim_rewards)
		return;
	
	let targetAccount = actSteemAccount;
	
	let claim_currency
	let claim_currency_stable
	let chainLnk
	if (target_chain == 'STEEM'){
		claim_currency = targetAccount.reward_steem_balance
		claim_currency_stable = targetAccount.reward_sbd_balance
		chainLnk = steem;
	}
	
	if (target_chain == 'HIVE'){
		targetAccount = account;
		claim_currency = targetAccount.reward_hive_balance;//targetAccount.reward_steem_balance.replace("HIVE", "STEEM");
		claim_currency_stable = targetAccount.reward_hbd_balance;//targetAccount.reward_sbd_balance.replace("HBD", "SBD");
		chainLnk = hive;
		
	}
	
	if (target_chain == 'BLURT'){
		targetAccount = actBlurtAccount;
		claim_currency = targetAccount.reward_blurt_balance;//targetAccount.reward_steem_balance.replace("HIVE", "STEEM");
		claim_currency_stable = targetAccount.reward_vesting_blurt;//targetAccount.reward_sbd_balance.replace("HBD", "SBD");
		chainLnk = blurt;
		if (parseFloat(claim_currency) > 0 || parseFloat(claim_currency_stable) > 0 || parseFloat(targetAccount.reward_vesting_balance) > 0) {
			await chainLnk.broadcast.claimRewardBalance(config.posting_key, config.account, claim_currency, targetAccount.reward_vesting_balance, function (err, result) {
				if (err) {
					console.log('error claiming rewards');
					utils.log(err);
				}
			});
		}
		return;
	}
	
	// Make api call only if you have actual reward
	if (parseFloat(claim_currency) > 0 || parseFloat(claim_currency_stable) > 0 || parseFloat(targetAccount.reward_vesting_balance) > 0) {
		
		
		await chainLnk.broadcast.claimRewardBalance(config.posting_key, config.account, claim_currency, claim_currency_stable, targetAccount.reward_vesting_balance, function (err, result) {
			if (err) {
				console.log('error claiming rewards');
				utils.log(err);
			}

			if (result) {
				/*
				var rewards_message = "$$$ ==> Rewards Claim";
				if (parseFloat(targetAccount.reward_sbd_balance) > 0) { rewards_message = rewards_message + ' SBD: ' + parseFloat(targetAccount.reward_sbd_balance); }
				if (parseFloat(targetAccount.reward_steem_balance) > 0) { rewards_message = rewards_message + ' STEEM: ' + parseFloat(targetAccount.reward_steem_balance); }
				if (parseFloat(targetAccount.reward_vesting_balance) > 0) { rewards_message = rewards_message + ' VESTS: ' + parseFloat(targetAccount.reward_vesting_balance); }

				utils.log(rewards_message);*/
				
				//now attempt to claim rewards with HIVE
				if (!target_chain){
					claimRewards('HIVE');
				}

				// If there are liquid post rewards, withdraw them to the specified account
				/*if (parseFloat(targetAccount.reward_sbd_balance) > 0 && config.post_rewards_withdrawal_account && config.post_rewards_withdrawal_account != '') {

					// Send liquid post rewards to the specified account
					steem.broadcast.transfer(config.active_key, config.account, config.post_rewards_withdrawal_account, targetAccount.reward_sbd_balance, 'Liquid Post Rewards Withdrawal', function (err, response) {
						if (err){
							utils.log(err, response);
						}else{
							utils.log('$$$ Auto withdrawal - liquid post rewards: ' + targetAccount.reward_sbd_balance + ' sent to @' + config.post_rewards_withdrawal_account);
						}
					});
				}*/
			}
		});
	}else{
		console.log('nothing to claim. Try other chain if possible');
		//now attempt to claim rewards with HIVE
		if (!target_chain){
			claimRewards('HIVE');
		}
	}
}
