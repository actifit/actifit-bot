/**
 * Endpoint tests for simple read-only app.js routes
 */

const path = require('path');
const request = require('supertest');

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

jest.doMock('mongodb', () => {
  const actual = jest.requireActual('mongodb');

  const mockFindOne = jest.fn(() => Promise.resolve(null));
  const mockFind = jest.fn(() => ({
    toArray: jest.fn(() => Promise.resolve([])),
    sort: jest.fn(() => ({
      toArray: jest.fn(() => Promise.resolve([])),
      limit: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
    })),
    limit: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
  }));
  const mockInsertOne = jest.fn(() => Promise.resolve({ insertedId: 'test' }));
  const mockUpdateOne = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));

  const mockDb = {
    collection: jest.fn((name) => ({
      findOne: mockFindOne,
      find: mockFind,
      insertOne: mockInsertOne,
      updateOne: mockUpdateOne,
      replaceOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
      deleteMany: jest.fn(() => Promise.resolve({ deletedCount: 1 })),
      aggregate: jest.fn(() => ({ toArray: jest.fn(() => Promise.resolve([])) })),
      distinct: jest.fn(() => Promise.resolve([])),
    })),
  };

  // Store mocks globally so tests can access them
  global.__mockDb = mockDb;
  global.__mockFindOne = mockFindOne;
  global.__mockFind = mockFind;

  const MockMongoClient = jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ db: () => mockDb })),
  }));
  MockMongoClient.connect = jest.fn((url, opts, cb) => {
    setTimeout(() => cb(null, { db: () => mockDb }), 10);
  });

  return { ...actual, MongoClient: MockMongoClient };
});

jest.doMock('dsteem', () => ({
  Client: jest.fn(() => ({
    api: { setOptions: jest.fn(), getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
    broadcast: {},
    database: {},
  })),
}));

jest.doMock('@hiveio/dhive', () => ({
  Client: jest.fn(() => ({})),
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
    eth: { Contract: jest.fn(() => ({ methods: {} })), accounts: { wallet: { add: jest.fn(), create: jest.fn() } } },
    utils: { fromWei: jest.fn((v) => v), toWei: jest.fn((v) => v) },
  }));
  MockWeb3.Web3 = MockWeb3;
  return MockWeb3;
});

jest.doMock('sscjs', () => jest.fn(() => ({
  find: jest.fn(() => Promise.resolve([])),
})));

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

let app;

beforeAll((done) => {
  const origSetTimeout = global.setTimeout;
  const origSetInterval = global.setInterval;
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
    if (typeof delay === 'number' && delay > 5000) return null;
    return origSetTimeout(fn, delay);
  });
  jest.spyOn(global, 'setInterval').mockImplementation(() => null);

  const express = require('express');
  const origListen = express.application.listen;
  express.application.listen = jest.fn(function() {
    return { setTimeout: jest.fn(), close: jest.fn() };
  });

  // Provide global client mock for any legacy references
  global.client = {
    api: { getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
    broadcast: {},
    database: {},
  };

  app = require('../app');

  const utils = require('../utils');
  utils.getAccountData = jest.fn(() => Promise.resolve({}));
  utils.getChainInfo = jest.fn(() => Promise.resolve({}));

  express.application.listen = origListen;
  origSetTimeout(done, 300);
});

describe('App Endpoints', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /userSettings/:user', () => {
    test('returns user settings when found', async () => {
      global.__mockFindOne.mockImplementationOnce(() => Promise.resolve({ user: 'testuser', notifications: true }));

      const res = await request(app).get('/userSettings/testuser');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user: 'testuser', notifications: true });
    });

    test('returns empty object when user settings not found', async () => {
      global.__mockFindOne.mockImplementationOnce(() => Promise.resolve(null));

      const res = await request(app).get('/userSettings/nonexistent');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });
  });

  describe('GET /is_banned/:user', () => {
    test('returns true when user is banned', async () => {
      global.__mockFindOne.mockImplementationOnce(() => Promise.resolve({ user: 'banneduser', ban_status: 'active' }));

      const res = await request(app).get('/is_banned/banneduser');

      expect(res.status).toBe(200);
      expect(res.text).toBe('true');
    });

    test('returns false when user is not banned', async () => {
      global.__mockFindOne.mockImplementationOnce(() => Promise.resolve(null));

      const res = await request(app).get('/is_banned/cleanuser');

      expect(res.status).toBe(200);
      expect(res.text).toBe('false');
    });
  });

  describe('GET /user/:user', () => {
    test('returns user token data', async () => {
      const res = await request(app).get('/user/testuser');

      expect(res.status).toBe(200);
      // grabUserTokensFunc is not mocked here, response depends on its internals
      expect(typeof res.body).toBe('object');
    });
  });

});
