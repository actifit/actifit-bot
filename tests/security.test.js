/**
 * Security regression tests for vulnerability fixes
 *
 * These tests verify:
 * 1. eval() has been removed from app.js and curation-bot.js
 * 2. ObjectId constructors are wrapped in try/catch
 * 3. JSON.parse on user input is wrapped in try/catch
 * 4. The actual endpoints handle invalid input gracefully
 */

const path = require('path');

// Set up mocks BEFORE requiring fs or app.js
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

  return {
    ...actual,
    MongoClient: MockMongoClient,
  };
});

jest.doMock('dsteem', () => ({
  Client: jest.fn(() => ({
    api: {
      setOptions: jest.fn(),
      getAccountsAsync: jest.fn(() => Promise.resolve([{}])),
      getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})),
    },
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
  },
  broadcast: {},
}));

jest.doMock('@blurtfoundation/blurtjs', () => ({
  api: {
    setOptions: jest.fn(),
    getAccountsAsync: jest.fn(() => Promise.resolve([{}])),
    getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})),
  },
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

// Suppress unhandled rejections and uncaught exceptions from background blockchain operations
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const fs = require('fs');
const request = require('supertest');
let app;

beforeAll((done) => {
  // Prevent background timers from keeping the process alive
  const origSetTimeout = global.setTimeout;
  const origSetInterval = global.setInterval;
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

  origSetTimeout(done, 300);
});

describe('Security Regression Tests', () => {

  describe('Static source analysis', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const botSource = fs.readFileSync(path.join(__dirname, '../curation-bot.js'), 'utf8');

    test('app.js contains no eval() calls', () => {
      expect(appSource).not.toMatch(/eval\s*\(/);
    });

    test('curation-bot.js contains no eval() calls', () => {
      expect(botSource).not.toMatch(/eval\s*\(/);
    });

    test('app.js ObjectId constructors on user input are wrapped in try/catch', () => {
      const lines = appSource.split('\n');
      const errors = [];

      lines.forEach((line, index) => {
        // Only flag ObjectId calls that directly use user input (req.query, req.params, req.body)
        if (!line.match(/new ObjectId\(/) || !line.match(/req\.(query|params|body)/)) return;

        // Look back up to 5 lines for a try { without an intervening catch
        const context = lines.slice(Math.max(0, index - 5), index + 1).join('\n');
        const lastTry = context.lastIndexOf('try {');
        const lastCatch = context.lastIndexOf('catch (');

        if (lastTry === -1 || (lastCatch !== -1 && lastCatch > lastTry)) {
          errors.push(`Line ${index + 1}: ${line.trim()}`);
        }
      });

      expect(errors).toEqual([]);
    });

    test('app.js JSON.parse on user input is wrapped in try/catch', () => {
      const lines = appSource.split('\n');
      const errors = [];

      lines.forEach((line, index) => {
        // Look for JSON.parse that involves req.query, req.body, or conf_trx
        if (!(line.match(/JSON\.parse\(/) && line.match(/req\.(query|body)|conf_trx/))) return;

        // Look back up to 5 lines for a try { without an intervening catch
        const context = lines.slice(Math.max(0, index - 5), index + 1).join('\n');
        const lastTry = context.lastIndexOf('try {');
        const lastCatch = context.lastIndexOf('catch (');

        if (lastTry === -1 || (lastCatch !== -1 && lastCatch > lastTry)) {
          errors.push(`Line ${index + 1}: ${line.trim()}`);
        }
      });

      expect(errors).toEqual([]);
    });
  });

  describe('Endpoint behavior - eval() replacement', () => {
    test('/appendVerifiedPost rejects missing verification token', async () => {
      const res = await request(app)
        .get('/appendVerifiedPost')
        .query({ author: 'test', permlink: 'test-post' });

      expect(res.text).toBe('{}');
    });

    test('/appendVerifiedPost rejects invalid verification token', async () => {
      const res = await request(app)
        .get('/appendVerifiedPost')
        .query({
          author: 'test',
          permlink: 'test-post',
          verifyParam: 'wrong-token'
        });

      expect(res.text).toBe('{}');
    });

    test('/appendVerifiedPost accepts valid verification token', async () => {
      const res = await request(app)
        .get('/appendVerifiedPost')
        .query({
          verifyParam: 'test-post-token',
          author: 'test',
          permlink: 'test-post',
          json_metadata: '{"step_count": 5000}'
        });

      expect(res.text).toBe('{success}');
    });

    test('/sendNotification rejects missing verification token', async () => {
      const res = await request(app)
        .get('/sendNotification')
        .query({ user: 'test', notifType: 'new_post' });

      expect(res.text).toBe('{}');
    });

    test('/sendNotification rejects invalid verification token', async () => {
      const res = await request(app)
        .get('/sendNotification')
        .query({
          user: 'test',
          notifType: 'new_post',
          verifyNotifParam: 'wrong-token'
        });

      expect(res.text).toBe('{}');
    });
  });

  describe('Endpoint behavior - JSON.parse error handling', () => {
    test('/appendVerifiedPost returns error for malformed JSON metadata', async () => {
      const res = await request(app)
        .get('/appendVerifiedPost')
        .query({
          verifyParam: 'test-post-token',
          author: 'test',
          permlink: 'test-post',
          json_metadata: '{invalid json'
        });

      expect(res.text).toBe('{}');
    });

    test('/appendVerifiedPost accepts valid JSON metadata', async () => {
      const res = await request(app)
        .get('/appendVerifiedPost')
        .query({
          verifyParam: 'test-post-token',
          author: 'test',
          permlink: 'test-post',
          json_metadata: '{"step_count": 5000}'
        });

      expect(res.text).toBe('{success}');
    });
  });

  describe('Endpoint behavior - ObjectId validation', () => {
    test('/gadgetBought returns error for invalid ObjectId', async () => {
      const res = await request(app)
        .get('/gadgetBought')
        .query({ user: 'testuser', gadget_id: 'invalid-id' });

      expect(res.body.error).toBe('Invalid gadget ID format');
    });

    test('/gadgetBought accepts valid ObjectId', async () => {
      const res = await request(app)
        .get('/gadgetBought')
        .query({ user: 'testuser', gadget_id: '507f1f77bcf86cd799439011' });

      expect(res.body.error).toBeUndefined();
    });

  });

});
