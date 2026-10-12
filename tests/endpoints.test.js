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
  api: {
    setOptions: jest.fn(),
    getAccountsAsync: jest.fn(() => Promise.resolve([{}])),
    getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})),
    // Needed by /getEstimatedReward; its shape guards are what the tests below pin.
    getContentAsync: jest.fn(() => Promise.resolve({})),
    getContentRepliesAsync: jest.fn(() => Promise.resolve([])),
  },
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

  // Regression cover for the RPC-shape guards in getEstimatedReward.
  //
  // The bug was taken from a live error log: `(hiveReplies || []).filter is not a
  // function`. `|| []` only substitutes for null/undefined, so a TRUTHY non-array -
  // which is what a node returns when it errors - went straight through and threw.
  //
  // This route is NOT a process kill: it has its own try/catch. The symptom was that
  // every caller silently got `{error:'failed to calculate estimate'}` instead of a
  // number. These tests pin the difference between a degraded-but-honest answer and a
  // confidently wrong one.
  describe('GET /getEstimatedReward — upstream shape guards', () => {
    const utilsMod = require('../utils');

    const primeDb = () => {
      global.__mockFindOne
        // verified_posts: the user's latest post
        .mockImplementationOnce(() => Promise.resolve({
          author: 'alice', permlink: 'p1', date: new Date(),
          json_metadata: { step_count: 9000, image: [] },
        }))
        // token_transactions: not already rewarded
        .mockImplementationOnce(() => Promise.resolve(null))
        // user_tokens via grabUserTokensFunc: clear the AFIT eligibility floor
        .mockImplementationOnce(() => Promise.resolve({ _id: 'alice', tokens: 10000 }));
    };

    test('scores the post when the node answers with a truthy non-array for replies', async () => {
      primeDb();
      utilsMod.hive.api.getContentAsync.mockResolvedValue({
        body: 'x'.repeat(500), net_votes: 12, active_votes: [],
      });
      // The exact shape that threw in production.
      utilsMod.hive.api.getContentRepliesAsync.mockResolvedValue({ error: { code: -32000 } });

      const res = await request(app).get('/getEstimatedReward?user=alice');

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(typeof res.body.estimated_afit).toBe('number');
    });

    test('tolerates a replies array containing a null element', async () => {
      primeDb();
      utilsMod.hive.api.getContentAsync.mockResolvedValue({
        body: 'x'.repeat(500), net_votes: 3, active_votes: [],
      });
      utilsMod.hive.api.getContentRepliesAsync.mockResolvedValue([null, { body: 'y'.repeat(80) }]);

      const res = await request(app).get('/getEstimatedReward?user=alice');

      expect(res.body.error).toBeUndefined();
      expect(typeof res.body.estimated_afit).toBe('number');
    });

    test('reports node_unavailable rather than scoring a post it never read', async () => {
      // Deliberately NOT a silent zero: defaulting the post to {} would ship an
      // authoritative-looking breakdown with content, upvote and moderator scores all
      // zero - a materially understated estimate presented as fact.
      primeDb();
      utilsMod.hive.api.getContentAsync.mockResolvedValue({ error: { code: -32000 } });
      utilsMod.hive.api.getContentRepliesAsync.mockResolvedValue([]);

      const res = await request(app).get('/getEstimatedReward?user=alice');

      expect(res.body.status).toBe('node_unavailable');
      expect(res.body.estimated_afit).toBeUndefined();
    });

    test('tolerates a truthy non-array for active_votes', async () => {
      primeDb();
      utilsMod.hive.api.getContentAsync.mockResolvedValue({
        body: 'x'.repeat(500), net_votes: 5, active_votes: { oops: true },
      });
      utilsMod.hive.api.getContentRepliesAsync.mockResolvedValue([]);

      const res = await request(app).get('/getEstimatedReward?user=alice');

      expect(res.body.error).toBeUndefined();
      expect(typeof res.body.estimated_afit).toBe('number');
    });
  });

});
