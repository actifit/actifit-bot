/**
 * Integration-style tests using a shared mock MongoDB.
 *
 * These tests seed realistic data into the mock DB, hit endpoints,
 * and verify responses — no external services required.
 */

const path = require('path');
const request = require('supertest');
const { createMockDb } = require('../helpers/mock-db');
const fixtures = require('../fixtures');

// Build a shared mock DB that persists across the test file
const mockDb = createMockDb();

jest.doMock('node:fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, options) => {
      if (path.basename(filePath) === 'config.json') {
        return actual.readFileSync(path.join(__dirname, '../test-config.json'), options);
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
        return actual.readFileSync(path.join(__dirname, '../test-config.json'), options);
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

  global.client = {
    api: { getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
    broadcast: {},
    database: {},
  };

  app = require('../../app');

  const utils = require('../../utils');
  utils.getAccountData = jest.fn(() => Promise.resolve({}));
  utils.getChainInfo = jest.fn(() => Promise.resolve({}));

  express.application.listen = origListen;
  origSetTimeout(done, 300);
});

beforeEach(() => {
  mockDb.__clearAll();
  jest.clearAllMocks();
});

describe('Integration Tests — User & Content Flow', () => {

  describe('GET /userSettings/:user', () => {
    test('returns user settings when found', async () => {
      const settings = fixtures.createUserSettings('alice', { theme: 'dark' });
      mockDb.collection('user_settings').__seed([settings]);

      const res = await request(app).get('/userSettings/alice');

      expect(res.status).toBe(200);
      expect(res.body.user).toBe('alice');
      expect(res.body.settings.theme).toBe('dark');
    });

    test('returns empty object when not found', async () => {
      const res = await request(app).get('/userSettings/bob');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });
  });

  describe('GET /is_banned/:user', () => {
    test('returns true for active banned user', async () => {
      mockDb.collection('banned_accounts').__seed([fixtures.createBannedAccount('troll')]);

      const res = await request(app).get('/is_banned/troll');

      expect(res.status).toBe(200);
      expect(res.text).toBe('true');
    });

    test('returns false for non-banned user', async () => {
      const res = await request(app).get('/is_banned/alice');
      expect(res.status).toBe(200);
      expect(res.text).toBe('false');
    });
  });

  describe('GET /user/:user', () => {
    test('returns user token data', async () => {
      mockDb.collection('user_tokens').__seed([fixtures.createUserToken('alice', 5000)]);

      const res = await request(app).get('/user/alice');

      expect(res.status).toBe(200);
      expect(res.body.user).toBe('alice');
      expect(res.body.tokens).toBe('5000.000');
    });

    test('returns empty-ish object for unknown user', async () => {
      const res = await request(app).get('/user/unknown');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });
  });

  describe('GET /userFullBal/:user', () => {
    test('returns full balance', async () => {
      mockDb.collection('user_tokens').__seed([fixtures.createUserToken('alice', 9999)]);

      const res = await request(app).get('/userFullBal/alice');

      expect(res.status).toBe(200);
      expect(res.body.user).toBe('alice');
      expect(res.body.tokens).toBe('9999.000');
    });
  });

  describe('GET /transactions/:user', () => {
    test('returns user transactions only', async () => {
      mockDb.collection('token_transactions').__seed([
        fixtures.createTokenTransaction('alice', 10, 'Post Vote'),
        fixtures.createTokenTransaction('alice', 20, 'Post Vote'),
        fixtures.createTokenTransaction('bob', 5, 'Post Vote'),
      ]);

      const res = await request(app).get('/transactions/alice');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    test('returns empty array when no transactions', async () => {
      const res = await request(app).get('/transactions/charlie');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });
  });

  describe('GET /activeNotifications/:user', () => {
    test('returns only unread notifications', async () => {
      mockDb.collection('notifications').__seed([
        fixtures.createNotification('alice', 'new_post', 'unread'),
        fixtures.createNotification('alice', 'friend_req', 'unread'),
        fixtures.createNotification('alice', 'new_post', 'read'),
      ]);

      const res = await request(app).get('/activeNotifications/alice');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    test('returns empty array when no notifications', async () => {
      const res = await request(app).get('/activeNotifications/bob');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });
  });

  describe('GET /news', () => {
    test('returns only enabled news', async () => {
      mockDb.collection('news').__seed([
        { title: 'New Feature', enabled: true, date: new Date() },
        { title: 'Old Feature', enabled: false, date: new Date() },
      ]);

      const res = await request(app).get('/news');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].title).toBe('New Feature');
    });
  });

  describe('GET /surveys', () => {
    test('returns only enabled surveys', async () => {
      mockDb.collection('surveys').__seed([
        fixtures.createSurvey('Do you like Actifit?', ['Yes', 'No'], true),
        fixtures.createSurvey('Old survey', ['A', 'B'], false),
      ]);

      const res = await request(app).get('/surveys');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].question).toBe('Do you like Actifit?');
    });
  });

  describe('GET /moderators', () => {
    test('returns list of moderators', async () => {
      mockDb.collection('team').__seed([
        { name: 'mod1', title: 'moderator', status: 'active' },
        { name: 'mod2', title: 'moderator', status: 'active' },
      ]);

      const res = await request(app).get('/moderators');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });
  });

  describe('GET /banned_users', () => {
    test('returns list of banned users', async () => {
      mockDb.collection('banned_accounts').__seed([
        fixtures.createBannedAccount('troll1'),
        fixtures.createBannedAccount('troll2'),
      ]);

      const res = await request(app).get('/banned_users');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });
  });

  describe('GET /products', () => {
    test('returns active products', async () => {
      mockDb.collection('products').__seed([
        { name: 'Gadget A', price: 100, active: true },
        { name: 'Gadget B', price: 200, active: false },
      ]);

      const res = await request(app).get('/products');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].name).toBe('Gadget A');
    });
  });

});
