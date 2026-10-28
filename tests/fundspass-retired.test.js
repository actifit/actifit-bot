/**
 * Funds passwords are retired: the old funds-password routes answer 410 FUNDS_PASS_RETIRED
 * and the routes that used them now require the login session.
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

const RETIRED = {
  error: 'Funds passwords have been retired. Your login session is used instead.',
  code: 'FUNDS_PASS_RETIRED',
};

// Every route that used to read, set, verify or list funds passwords. Each one is still
// registered, so an old client gets a clear JSON answer rather than a 404 page.
const retiredRoutes = [
  ['get', '/validatePassForDownload?user=alice&product_id=1&pass=x'],
  ['post', '/setUserFundsPass'],
  ['get', '/confirmPaymentPasswordVerify?from=alice&bchain=HIVE'],
  ['get', '/userHasFundsPassSet/alice'],
  ['get', '/resetFundsPass?user=alice'],
  ['get', '/getUnverifiedFundsAccountList/'],
  ['get', '/getFullFundsAccountList/'],
];

describe('retired funds-password routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(retiredRoutes)('%s %s answers 410 FUNDS_PASS_RETIRED without touching the database', async (method, url) => {
    const res = await request(app)[method](url).send({ user: 'alice', pass: 'anything' });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(RETIRED);
    expect(global.__mockDb.collection).not.toHaveBeenCalled();
  });

  it('the same answer comes back with a session header too (no auth needed to learn it is gone)', async () => {
    const res = await request(app).post('/setUserFundsPass').set('x-acti-token', 'anything').send({ pass: 'x' });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(RETIRED);
  });

  it('no funds-password helper is left in app.js or utils.js', () => {
    const fs = jest.requireActual('fs');
    const src = ['../app.js', '../utils.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/verifyFundsPass|encryptFundsPass|createLegacyCipher|confirmPaymentReceivedPassword/);
    expect(src).not.toMatch(/collection\(['"]account_funds_pass['"]\)/);
  });

  it('cancelAFITMoveSE and reissueDownloadToken refuse a request without a session', async () => {
    const cancel = await request(app).post('/cancelAFITMoveSE').set('X-Forwarded-For', '198.51.100.1').send({ user: 'alice', fundsPass: 'x' });
    expect(cancel.body).toEqual({ success: false, message: 'Auth token is not provided' });
    const reissue = await request(app).get('/reissueDownloadToken?product_id=1&user=alice&pass=x').set('X-Forwarded-For', '198.51.100.2');
    expect(reissue.body).toEqual({ success: false, message: 'Auth token is not provided' });
    expect(global.__mockDb.collection).not.toHaveBeenCalledWith('powering_down_he');
    expect(global.__mockDb.collection).not.toHaveBeenCalledWith('user_product_key');
  });
});
