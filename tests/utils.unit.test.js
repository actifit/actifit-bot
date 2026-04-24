/**
 * Unit tests for pure utility functions that don't require external services
 */

const path = require('path');

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
  const MockMongoClient = jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ db: () => ({}) })),
  }));
  MockMongoClient.connect = jest.fn((url, opts, cb) => {
    setTimeout(() => cb(null, { db: () => ({}) }), 10);
  });
  return { ...actual, MongoClient: MockMongoClient };
});

// Suppress unhandled rejections and uncaught exceptions from background processes in utils.js
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

// Require utils after mocks are set up
const utils = require('../utils');

describe('Utils Unit Tests', () => {

  describe('Currency/Token parsing', () => {
    test('getCurrency returns token symbol from amount string', () => {
      expect(utils.getCurrency('100 AFIT')).toBe('AFIT');
      expect(utils.getCurrency('50.5 HIVE')).toBe('HIVE');
      expect(utils.getCurrency('0.001 BTC')).toBe('BTC');
    });
  });

  describe('Time formatting utilities', () => {
    test('toTimer formats seconds as HH:MM:SS', () => {
      // HOURS = 60 * 60 = 3600
      expect(utils.toTimer(3661)).toBe('01:01:01');
      expect(utils.toTimer(60)).toBe('00:01:00');
      expect(utils.toTimer(0)).toBe('00:00:00');
    });

    test('toHrMn formats minutes as HHhr(s):MMmin(s)', () => {
      expect(utils.toHrMn(90)).toBe('00hr(s):01min(s)');
      expect(utils.toHrMn(3600)).toBe('01hr(s):00min(s)');
      expect(utils.toHrMn(0)).toBe('00hr(s):00min(s)');
    });
  });

  describe('Number formatting', () => {
    test('format adds thousand separators', () => {
      expect(utils.format(1000, 0, '.', ',')).toBe('1,000');
      expect(utils.format(1000000, 0, '.', ',')).toBe('1,000,000');
      expect(utils.format(1234567.89, 2, '.', ',')).toBe('1,234,567.89');
    });
  });

  describe('Array utilities', () => {
    test('sortArrLodash sorts arrays descending by balance', () => {
      const arr = [{ balance: '10', user: 'a' }, { balance: '100', user: 'b' }, { balance: '5', user: 'c' }];
      const sorted = utils.sortArrLodash(arr);
      expect(sorted[0].user).toBe('b');
      expect(sorted[1].user).toBe('a');
      expect(sorted[2].user).toBe('c');
    });
  });

  describe('asyncForEach', () => {
    test('processes all array elements in order', async () => {
      const results = [];
      await utils.asyncForEach([1, 2, 3], async (item) => {
        results.push(item);
      });
      expect(results).toEqual([1, 2, 3]);
    });

    test('handles empty arrays', async () => {
      const results = [];
      await utils.asyncForEach([], async (item) => {
        results.push(item);
      });
      expect(results).toEqual([]);
    });
  });

  describe('generateRandomNumber', () => {
    test('returns integer within range', () => {
      const result = utils.generateRandomNumber(1, 10);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(10);
    });

    test('returns exact value when min equals max', () => {
      expect(utils.generateRandomNumber(5, 5)).toBe(5);
    });
  });

  describe('Config loader', () => {
    test('getConfig returns configuration object', () => {
      const config = utils.getConfig();
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
      expect(config.account).toBe('actifit');
      expect(config.testing).toBe(true);
    });

    test('getConfig caches result', () => {
      const config1 = utils.getConfig();
      const config2 = utils.getConfig();
      expect(config1).toBe(config2);
    });
  });

  describe('Voting power calculations', () => {
    test('timeTilFullPower returns number', () => {
      const result = utils.timeTilFullPower(0);
      expect(typeof result).toBe('number');
    });

    test('timeTilKickOffVoting returns number', () => {
      const result = utils.timeTilKickOffVoting(10000, 10000);
      expect(typeof result).toBe('number');
    });
  });

  describe('Score calculation', () => {
    test('calcScore returns factor * rule value', () => {
      const rules = [[100, 1], [1000, 2], [10000, 3]];
      expect(utils.calcScore(rules, 10, 50)).toBe(10);   // 10 * 1
      expect(utils.calcScore(rules, 10, 500)).toBe(20);  // 10 * 2
      expect(utils.calcScore(rules, 10, 5000)).toBe(30); // 10 * 3
    });

    test('calcScoreExtended calculates with extended rule format', () => {
      // rules format: [threshold, unused, base, offset, multiplier]
      const rules = [[100, 0, 0, 0, 1]];
      // result = factor * (base + multiplier * (value - offset)) / max_val
      // = 10 * (0 + 1 * (50 - 0)) / 5 = 100
      expect(utils.calcScoreExtended(rules, 10, 50, 5)).toBe(100);
    });
  });

  describe('Load user list', () => {
    test('loadUserList handles null location', (done) => {
      utils.loadUserList(null, (result) => {
        expect(result).toBeNull();
        done();
      });
    });

    test('loadUserList handles empty string location', (done) => {
      utils.loadUserList('', (result) => {
        expect(result).toBeNull();
        done();
      });
    });
  });

  describe('Log function', () => {
    test('log function exists and is callable', () => {
      expect(typeof utils.log).toBe('function');
      expect(() => utils.log('test message')).not.toThrow();
    });
  });

});
