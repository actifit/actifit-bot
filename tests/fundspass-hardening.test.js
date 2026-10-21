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

// ---------------------------------------------------------------------------
// Deliberately NOT installing the no-op process.on('unhandledRejection') that
// endpoints.test.js uses. These tests exist to detect an escaped rejection, and that
// handler would disarm the only signal that proves the fix works.
// ---------------------------------------------------------------------------

let app;
const escaped = [];
const onRejection = (e) => escaped.push(e);
const onException = (e) => escaped.push(e);

beforeAll((done) => {
  const origSetTimeout = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
    if (typeof delay === 'number' && delay > 5000) return null;
    return origSetTimeout(fn, delay);
  });
  jest.spyOn(global, 'setInterval').mockImplementation(() => null);

  const express = require('express');
  const origListen = express.application.listen;
  express.application.listen = jest.fn(function () {
    return { setTimeout: jest.fn(), close: jest.fn() };
  });

  global.client = {
    api: { getAccountsAsync: jest.fn(() => Promise.resolve([{}])), getDynamicGlobalPropertiesAsync: jest.fn(() => Promise.resolve({})) },
    broadcast: {},
    database: {},
  };

  app = require('../app');
  express.application.listen = origListen;
  origSetTimeout(done, 300);
});

beforeEach(() => {
  escaped.length = 0;
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
});

/**
 * /validatePassForDownload (app.js:8962) is the sharpest of the six verifyFundsPass call
 * sites: no checkHdrs, no rate limiter, and req.query.pass goes straight into the cipher.
 * The handler is async with no try/catch, there is no Express error handler, and the app
 * installs no unhandledRejection handler - so a throw inside verifyFundsPass does not
 * fail the request, it ENDS THE API PROCESS.
 *
 * A legacy (IV-less) stored value is used throughout, because that is the branch ~99% of
 * account_funds_pass rows take and the one this release changed.
 */
const LEGACY_ROW = {
  user: 'alice',
  // 32 hex chars, no 'iv:' prefix - the old createCipher format.
  pass: 'b5b29331c1bb4026166dd1138c397d8a',
  passVerified: true,
};

describe('verifyFundsPass must never throw into an async route handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.__mockFindOne.mockImplementation(() => Promise.resolve({ ...LEGACY_ROW }));
  });

  // Each case is a request an unauthenticated caller can send today.
  const cases = [
    ['pass omitted entirely',        '?user=alice&product_id=1'],
    ['pass repeated (array value)',  '?user=alice&product_id=1&pass=a&pass=b'],
    ['pass empty',                   '?user=alice&product_id=1&pass='],
  ];

  it.each(cases)('survives %s', async (_label, qs) => {
    const res = await request(app).get('/validatePassForDownload' + qs);

    // The specific response matters less than the fact that one came back at all: before
    // the guard, cipher.update(undefined) threw TypeError and the process exited.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error');
    expect(escaped).toEqual([]);
  });

  it('still rejects a wrong password with the normal error, not a crash', async () => {
    const res = await request(app).get('/validatePassForDownload?user=alice&product_id=1&pass=definitely-wrong');

    expect(res.body.error).toMatch(/Incorrect username and\/or funds password/);
    expect(escaped).toEqual([]);
  });

  it('survives a stored value with a malformed iv: prefix', async () => {
    // Buffer.from(garbage,'hex') truncates silently, then createCipheriv throws
    // "Invalid initialization vector" - turning one corrupt row into a crash loop for
    // that user: every retry kills the process again.
    global.__mockFindOne.mockImplementation(() => Promise.resolve({ ...LEGACY_ROW, pass: 'zz:deadbeef' }));

    const res = await request(app).get('/validatePassForDownload?user=alice&product_id=1&pass=anything');

    expect(res.body).toHaveProperty('error');
    expect(escaped).toEqual([]);
  });

  it('does not accept an empty password against an empty stored value', async () => {
    // Both-empty is the dangerous symmetry: a row whose pass was never written must not
    // be unlockable by sending nothing. Guarded at the top of verifyFundsPass.
    global.__mockFindOne.mockImplementation(() => Promise.resolve({ ...LEGACY_ROW, pass: '' }));

    const res = await request(app).get('/validatePassForDownload?user=alice&product_id=1&pass=');

    expect(res.body.error).toBeDefined();
    expect(escaped).toEqual([]);
  });

  it('accepts the correct legacy password - the guard did not break verification', async () => {
    // POSITIVE CONTROL - the whole point of the release. Without this, every assertion
    // above would still pass against a verifyFundsPass that returns false unconditionally,
    // i.e. one that locks out all 2824 legacy users while looking perfectly safe.
    //
    // Expected value is the GENUINE crypto.createCipher output on Node v20.20.2 for
    // 'password123' under tests/test-config.json's funds_encr_key, not a value produced
    // by the code under test.
    global.__mockFindOne.mockImplementation(() => Promise.resolve({
      ...LEGACY_ROW,
      pass: 'fca4995ef47d81e7f3fbd716225a9a92',
    }));

    const res = await request(app).get('/validatePassForDownload?user=alice&product_id=1&pass=password123');

    // Verification succeeded, so the handler ran on to the download-access branch. The
    // shared findOne mock answers the user_product_key lookup with the same row, which is
    // truthy, so the route reaches its success response.
    expect(res.body.error).toBeUndefined();
    expect(res.body.success).toBe('success');
    expect(escaped).toEqual([]);
  });
});
