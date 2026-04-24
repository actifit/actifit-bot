/**
 * Test fixture factories for MongoDB collections.
 *
 * Each factory returns a plain object that can be inserted
 * directly into the memory DB.
 */

const { ObjectId } = require('mongodb');

function createUserToken(user = 'testuser', tokens = 1000) {
  return {
    _id: user,
    user,
    tokens,
    tokens_hive: tokens,
    tokens_blurt: 0,
  };
}

function createLoginToken(user = 'testuser', token = 'jwt-token-string') {
  return {
    user,
    token,
    date: new Date(),
  };
}

function createUserSettings(user = 'testuser', settings = {}) {
  return {
    user,
    settings: {
      notifications: true,
      lang: 'en',
      ...settings,
    },
  };
}

function createBannedAccount(user = 'banneduser', status = 'active') {
  return {
    user,
    ban_status: status,
    date: new Date(),
  };
}

function createTokenTransaction(user = 'testuser', amount = 10, rewardActivity = 'Post Vote') {
  return {
    user,
    token_count: amount,
    reward_activity: rewardActivity,
    date: new Date(),
    url: 'https://hive.blog/@testuser/test-post',
  };
}

function createUserWalletAddress(user = 'testuser', address = '0x1234567890abcdef', chain = 'BSC') {
  return {
    user,
    wallet_address: address,
    chain,
    date: new Date(),
  };
}

function createProduct(name = 'Test Gadget', price = 100, enabled = true) {
  return {
    _id: new ObjectId(),
    name,
    price,
    enabled,
  };
}

function createSurvey(question = 'Test Survey?', options = ['Yes', 'No'], enabled = true) {
  return {
    _id: new ObjectId(),
    question,
    options,
    enabled,
    date: new Date(),
  };
}

function createNotification(user = 'testuser', type = 'new_post', status = 'unread') {
  return {
    user,
    type,
    status,
    date: new Date(),
    details: { message: 'Test notification' },
  };
}

module.exports = {
  createUserToken,
  createLoginToken,
  createUserSettings,
  createBannedAccount,
  createTokenTransaction,
  createUserWalletAddress,
  createProduct,
  createSurvey,
  createNotification,
};
