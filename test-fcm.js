const { MongoClient } = require('mongodb');

async function getConfig() {
  const config = require('./config.json');
  return config;
}

async function testFCM() {
  const config = await getConfig();
  
  console.log('Connecting to MongoDB...');
  const client = await MongoClient.connect(config.mongo_uri);
  const db = client.db(config.mongo_db);
  
  const testUser = 'hdev.fund';
  const testDetails = 'Test notification from local';
  const testUrl = 'https://actifit.io';
  
  console.log('Sending FCM notification to user:', testUser);
  
  const utils = require('./utils');
  
  try {
    await utils.sendFirebaseNotification(db, testUser, testDetails, testUrl);
    console.log('Notification sent (check logs above for result)');
  } catch (error) {
    console.log('Error sending notification:', error);
  }
  
  await client.close();
  console.log('Done');
}

testFCM();