/**
 * Behavior tests for the SERVER-SIDE signup payment gate (Trello #51).
 *
 * confirmPaymentReceived used to accept any on-chain transfer >= the CLIENT's
 * steem_invest, so a tampered APK could underpay. The gate now derives the
 * required amount itself (our USD cost / a server-sourced price). These tests
 * pin that real utils.js logic: the CoinGecko boundary is the only thing mocked.
 *
 * What we assert (caller's perspective):
 *   - live price -> correct required crypto (HIVE and HBD), with the 10% drift buffer
 *   - the fallback chain when CoinGecko is down: bot price -> HBD peg -> low-price floor
 *   - a bad signupCostUsd can neither open the gate nor brick every signup
 *   - the accept/reject decision the poll makes (>= requiredCrypto)
 */

const path = require('path');

// Redirect config.json -> test-config.json (same trick as utils.unit.test.js)
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

// Stub every heavy dependency utils.js pulls in at require-time.
jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
  messaging: jest.fn(() => ({ sendEach: jest.fn(() => Promise.resolve({ successCount: 1, failureCount: 0 })) })),
}));
jest.doMock('@hiveio/dhive', () => ({
  Client: jest.fn(() => ({ database: { getDynamicGlobalProperties: jest.fn(() => Promise.resolve({})) } })),
}));
jest.doMock('dblurt', () => ({ Client: jest.fn(() => ({})) }));
jest.doMock('@hiveio/hive-js', () => ({
  config: { set: jest.fn() },
  api: { setOptions: jest.fn(), getAccountsAsync: jest.fn(() => Promise.resolve([{}])) },
  broadcast: {},
}));
jest.doMock('@blurtfoundation/blurtjs', () => ({ api: { setOptions: jest.fn() } }));
jest.doMock('web3', () => {
  const M = jest.fn(() => ({ eth: { Contract: jest.fn(() => ({ methods: {} })) }, utils: { fromWei: (v) => v, toWei: (v) => v } }));
  M.Web3 = M;
  return M;
});
jest.doMock('sscjs', () => jest.fn(() => ({ find: jest.fn(() => Promise.resolve([])) })));
jest.doMock('mongodb', () => {
  const actual = jest.requireActual('mongodb');
  const C = jest.fn(() => ({ connect: jest.fn(() => Promise.resolve({ db: () => ({}) })) }));
  C.connect = jest.fn((url, opts, cb) => setTimeout(() => cb(null, { db: () => ({}) }), 10));
  return { ...actual, MongoClient: C };
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const utils = require('../utils');
const cfg = utils.getConfig();

// Production runs on Node 20 (global fetch + AbortSignal.timeout both native). The local Jest
// runner may be an older Node that lacks AbortSignal.timeout; shim it so utils.js's real fetch
// path executes instead of throwing straight into the catch. fetch itself is mocked per-test.
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    if (t && t.unref) t.unref();
    return c.signal;
  };
}

// --- boundary mock: CoinGecko ------------------------------------------------
// Node's global `fetch` is a getter-style global, so a plain `global.fetch = ...`
// assignment silently no-ops and utils.js would hit the real network. Install the
// mock as a real data property instead.
function setFetch(fn) {
  Object.defineProperty(global, 'fetch', { value: fn, configurable: true, writable: true });
}
function coingeckoReturns(hiveUsd, hbdUsd) {
  setFetch(jest.fn(() => Promise.resolve({
    json: () => Promise.resolve({ hive: { usd: hiveUsd }, hive_dollar: { usd: hbdUsd } }),
  })));
}
function coingeckoDown() {
  setFetch(jest.fn(() => Promise.reject(new Error('network down'))));
}

const HIVE_PRICE = 0.0437;   // ~ real HIVE price at time of writing
const HBD_PRICE = 0.9738;
const botPrice = (usd) => ({ hive: { usd } });

beforeEach(() => {
  utils._resetSignupPriceCache();
  delete cfg.signupCostUsd;
  delete cfg.signupFallbackHiveUsd;
});
afterEach(() => {
  jest.restoreAllMocks();
  // Any fetch after a test is a mistake — surface it loudly rather than hitting the network.
  setFetch(jest.fn(() => Promise.reject(new Error('unexpected fetch outside a test'))));
});

describe('signupRequiredCrypto — live CoinGecko price', () => {
  test('requires cost/price with a 10% buffer for HIVE', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const req = await utils.signupRequiredCrypto('HIVE', null);
    // $2 / 0.0437 * 0.90 = 41.19 HIVE
    expect(req).toBeCloseTo((2 / HIVE_PRICE) * 0.9, 2);
  });

  test('prices HBD off the HBD quote, not the HIVE quote', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const req = await utils.signupRequiredCrypto('HBD', null);
    // $2 / 0.9738 * 0.90 = 1.848 HBD
    expect(req).toBeCloseTo((2 / HBD_PRICE) * 0.9, 3);
    expect(req).toBeLessThan(2); // must not demand a full 2 HBD for a $2 signup
  });

  test('scales with a configured signupCostUsd', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    cfg.signupCostUsd = 3;
    const req = await utils.signupRequiredCrypto('HIVE', null);
    expect(req).toBeCloseTo((3 / HIVE_PRICE) * 0.9, 2);
  });
});

describe('signupRequiredCrypto — fallback chain when CoinGecko is down', () => {
  test('falls back to the bot hivePrice global for HIVE', async () => {
    coingeckoDown();
    const req = await utils.signupRequiredCrypto('HIVE', botPrice(0.05));
    expect(req).toBeCloseTo((2 / 0.05) * 0.9, 5); // 36 HIVE
  });

  test('uses the low-price floor when BOTH CoinGecko and the bot price are gone', async () => {
    coingeckoDown();
    const req = await utils.signupRequiredCrypto('HIVE', null);
    // default assumed $0.05 -> 36 HIVE (~$1.57 at real price), NOT the old ~4 HIVE
    expect(req).toBeCloseTo((2 / 0.05) * 0.9, 5);
    expect(req).toBeGreaterThan(30);
  });

  test('honours a configured signupFallbackHiveUsd', async () => {
    coingeckoDown();
    cfg.signupFallbackHiveUsd = 0.04;
    const req = await utils.signupRequiredCrypto('HIVE', null);
    expect(req).toBeCloseTo((2 / 0.04) * 0.9, 5); // 45 HIVE
  });

  test('pegs HBD to ~$1 when no live quote is available', async () => {
    coingeckoDown();
    const req = await utils.signupRequiredCrypto('HBD', null);
    expect(req).toBeCloseTo(1.8, 5); // 2/1.0*0.9
  });

  test('never consults the client figure — signature takes no client amount', () => {
    // Guard against a regression that re-introduces client trust: the function
    // arity is (sentCur, botHivePrice), so there is no client-amount parameter.
    expect(utils.signupRequiredCrypto.length).toBe(2);
  });
});

describe('signupRequiredCrypto — malformed signupCostUsd cannot open or brick the gate', () => {
  test.each([
    ['non-numeric', 'abc'],
    ['zero', 0],
    ['negative', -5],
    ['empty string', ''],
  ])('a %s cost falls back to the $2 default (gate stays finite and > 0)', async (_label, bad) => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    cfg.signupCostUsd = bad;
    const req = await utils.signupRequiredCrypto('HIVE', null);
    expect(Number.isFinite(req)).toBe(true);   // NOT NaN -> would reject EVERY signup
    expect(req).toBeGreaterThan(0);             // NOT <= 0 -> would accept dust
    expect(req).toBeCloseTo((2 / HIVE_PRICE) * 0.9, 2); // defaulted to $2
  });
});

describe('accept/reject decision the poll makes (sentAmount >= requiredCrypto)', () => {
  test('accepts a correct payment and rejects an underpayment at the live price', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const required = await utils.signupRequiredCrypto('HIVE', null); // ~41.19
    const decide = (sent) => parseFloat(sent) >= required;

    expect(decide(2 / HIVE_PRICE)).toBe(true);  // legit: paid exactly $2 worth (~45.8)
    expect(decide(46)).toBe(true);              // legit with headroom
    expect(decide(41.2)).toBe(true);            // right at the buffered line
    expect(decide(30)).toBe(false);             // tampered underpayment (~$1.31)
    expect(decide(0.001)).toBe(false);          // the original exploit amount
  });
});

describe('price cache (boundary is not hammered)', () => {
  test('a successful quote is reused within the cache window (one fetch)', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    await utils.signupRequiredCrypto('HIVE', null);
    await utils.signupRequiredCrypto('HBD', null);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a failed quote is negative-cached so an outage does not stampede CoinGecko', async () => {
    coingeckoDown();
    await utils.signupUsdPrices();
    await utils.signupUsdPrices();
    await utils.signupUsdPrices();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('actifit-landingpage (web) signup stays compatible', () => {
  // The web signup quotes crypto = minSignupUSDCost / hivePrice, where
  // minSignupUSDCost = 2 (landingpage nuxt.config) matches the bot's signupCostUsd = 2
  // default, and hivePrice is the bot's own /hivePrice rounded to 3 decimals. The server's
  // 10% buffer must absorb that rounding so a MINIMUM web signup is never newly rejected.
  // If this ever fails, the two repos' cost settings have drifted out of sync.
  const WEB_MIN_USD = 2;
  const webHiveQuote = (usd, priceRaw) => usd / Number(priceRaw.toFixed(3)); // page rounds price to 3dp

  test('a minimum $2 HIVE web signup clears the server requirement', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const required = await utils.signupRequiredCrypto('HIVE', null);
    const paid = webHiveQuote(WEB_MIN_USD, HIVE_PRICE);
    expect(paid).toBeGreaterThanOrEqual(required);
  });

  test('a minimum $2 HBD web signup clears the server requirement', async () => {
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const required = await utils.signupRequiredCrypto('HBD', null);
    const paid = WEB_MIN_USD / 1; // page uses hbdPrice default 1 -> 2.000 HBD
    expect(paid).toBeGreaterThanOrEqual(required);
  });

  test('web signups are not rejected at the $2 minimum across a range of HIVE prices', async () => {
    for (const price of [0.02, 0.0437, 0.08, 0.15, 0.30]) {
      utils._resetSignupPriceCache();
      coingeckoReturns(price, HBD_PRICE);
      const required = await utils.signupRequiredCrypto('HIVE', null);
      const paid = webHiveQuote(WEB_MIN_USD, price);
      expect(paid).toBeGreaterThanOrEqual(required);
    }
  });
});
