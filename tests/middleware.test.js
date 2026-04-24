/**
 * Tests for authentication middleware (checkHdrs)
 */

const path = require('path');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'test-secret-key-for-jwt-verification-in-tests-only';

jest.doMock('node:fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, 'test-config.json'), options);
      }
      return actual.readFileSync(filePath, options);
    }),
  };
});

jest.doMock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, 'test-config.json'), options);
      }
      return actual.readFileSync(filePath, options);
    }),
  };
});

jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
  messaging: jest.fn(() => ({
    sendAll: jest.fn(() => Promise.resolve({ successCount: 1, failureCount: 0 })),
    sendEach: jest.fn(() => Promise.resolve({ successCount: 1, failureCount: 0 })),
  })),
}));

jest.doMock('dsteem', () => ({
  Client: jest.fn(() => ({
    api: { setOptions: jest.fn(), getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
    broadcast: {},
    database: { getDynamicGlobalProperties: jest.fn(() => Promise.resolve({})) },
  })),
}));

jest.doMock('@hiveio/dhive', () => ({
  Client: jest.fn(() => ({
    database: { getDynamicGlobalProperties: jest.fn(() => Promise.resolve({})) },
  })),
}));

jest.doMock('dblurt', () => ({
  Client: jest.fn(() => ({})),
}));

jest.doMock('@hiveio/hive-js', () => ({
  config: { set: jest.fn() },
  api: { setOptions: jest.fn(), getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
  broadcast: {},
}));

jest.doMock('@blurtfoundation/blurtjs', () => ({
  api: { setOptions: jest.fn(), getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
}));

jest.doMock('web3', () => {
  const MockWeb3 = jest.fn(() => ({
    eth: {
      Contract: jest.fn(() => ({ methods: {} })),
      accounts: { wallet: { add: jest.fn(), create: jest.fn() } },
    },
    utils: {
      fromWei: jest.fn((v) => v),
      toWei: jest.fn((v) => v),
    },
  }));
  MockWeb3.Web3 = MockWeb3;
  return MockWeb3;
});

jest.doMock('sscjs', () => jest.fn(() => ({
  find: jest.fn(() => Promise.resolve([])),
})));

jest.doMock('mongodb', () => {
  const actual = jest.requireActual('mongodb');
  const mockDb = {
    collection: jest.fn(() => ({
      find: jest.fn(() => ({
        toArray: jest.fn(() => Promise.resolve([])),
        sort: jest.fn(() => ({
          toArray: jest.fn(() => Promise.resolve([])),
          limit: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
        })),
        limit: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
      })),
      findOne: jest.fn(() => Promise.resolve(null)),
      insertOne: jest.fn(() => Promise.resolve({ insertedId: 'test' })),
      updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
      replaceOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
      deleteMany: jest.fn(() => Promise.resolve({ deletedCount: 1 })),
      aggregate: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
      distinct: jest.fn(() => Promise.resolve([])),
    })),
  };
  const MockMongoClient = jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ db: () => mockDb })),
  }));
  MockMongoClient.connect = jest.fn((url, opts, cb) => {
    setTimeout(() => cb(null, { db: () => mockDb }), 10);
  });
  return { ...actual, MongoClient: MockMongoClient };
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const request = require('supertest');
let app;

beforeAll((done) => {
  const origSetTimeout = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
    if (typeof delay === 'number' && delay > 5000) return null;
    return origSetTimeout(fn, delay);
  });
  jest.spyOn(global, 'setInterval').mockImplementation(() => null);

  // Prevent app from binding to port 3120 in tests
  const express = require('express');
  const origListen = express.application.listen;
  express.application.listen = jest.fn(function() {
    return { setTimeout: jest.fn(), close: jest.fn() };
  });

  // utils.js references `client` (dsteem) which is commented out; provide a global mock so app.js can boot
  global.client = {
    api: {
      getAccountsAsync: jest.fn(() => Promise.resolve([{}])),
      getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})),
    },
    broadcast: {},
    database: {},
  };

  app = require('../app');

  // Replace background blockchain calls to prevent teardown errors
  const utils = require('../utils');
  utils.getAccountData = jest.fn(() => Promise.resolve({}));
  utils.getChainInfo = jest.fn(() => Promise.resolve({}));

  // Restore original listen for other tests
  express.application.listen = origListen;

  origSetTimeout(done, 1500);
});

describe('Authentication Middleware (checkHdrs)', () => {

  test('rejects request without token', async () => {
    const res = await request(app)
      .get('/voteSurvey')
      .query({ user: 'testuser', id: 'test-id', option: '1' });

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Auth token is not provided');
  });

  test('rejects request with invalid token', async () => {
    const res = await request(app)
      .get('/voteSurvey')
      .set('Authorization', 'Bearer invalid-token')
      .query({ user: 'testuser', id: 'test-id', option: '1' });

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Token is not valid');
  });

  test('rejects request with missing user param', async () => {
    const validToken = jwt.sign({ user: 'testuser' }, TEST_SECRET);

    const res = await request(app)
      .get('/voteSurvey')
      .set('Authorization', 'Bearer ' + validToken)
      .query({ id: 'test-id', option: '1' });

    // When user is missing from req.query, it returns error
    expect(res.body.error).toBe('user not supplied');
  });

  test('rejects valid token when DB login token not found', async () => {
    const validToken = jwt.sign({ user: 'testuser' }, TEST_SECRET);

    const res = await request(app)
      .get('/voteSurvey')
      .set('Authorization', 'Bearer ' + validToken)
      .query({ user: 'testuser', id: 'test-id', option: '1' });

    // DB is mocked to return empty array, so auth should fail
    expect(res.body.error).toBe('Authentication failed. Key not found');
  });

  test('handles x-acti-token header with same validation', async () => {
    const validToken = jwt.sign({ user: 'testuser' }, TEST_SECRET);

    const res = await request(app)
      .get('/voteSurvey')
      .set('x-acti-token', validToken)
      .query({ user: 'testuser', id: 'test-id', option: '1' });

    // Same as above - valid token but no DB entry
    expect(res.body.error).toBe('Authentication failed. Key not found');
  });

});
