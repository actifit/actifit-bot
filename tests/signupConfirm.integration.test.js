/**
 * Integration test for the REAL confirmPaymentReceived poll (Trello #51).
 *
 * This drives the actual utils.js function end-to-end: it computes the required
 * amount from the (mocked) CoinGecko price, polls the (mocked) chain client for
 * account history, and resolves with the tx id on a sufficient payment or with
 * '' on timeout. Only the two boundaries are faked -- the price API and the Hive
 * node -- so the accept/reject decision under test is the production code path.
 *
 * The poll runs on a 5s setInterval; Jest's async fake timers advance it without
 * real waiting.
 */

const path = require('path');
const moment = require('moment');

jest.doMock('node:fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readFileSync: jest.fn((f, o) =>
    actual.readFileSync(path.basename(f) === 'config.json' ? path.join(__dirname, 'test-config.json') : f, o)) };
});
jest.doMock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readFileSync: jest.fn((f, o) =>
    actual.readFileSync(path.basename(f) === 'config.json' ? path.join(__dirname, 'test-config.json') : f, o)) };
});

jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
  messaging: jest.fn(() => ({ sendEach: jest.fn(() => Promise.resolve({ successCount: 1, failureCount: 0 })) })),
}));

// The chain client: get_account_history returns whatever the current test staged
// on global.__acctHistory. (global keeps us clear of jest's mock-factory scope rules.)
jest.doMock('@hiveio/dhive', () => ({
  Client: jest.fn(() => ({
    database: {
      getDynamicGlobalProperties: jest.fn(() => Promise.resolve({})),
      call: jest.fn((method) =>
        Promise.resolve(method === 'get_account_history' ? (global.__acctHistory || []) : [])),
    },
  })),
}));
jest.doMock('dblurt', () => ({ Client: jest.fn(() => ({})) }));
jest.doMock('@hiveio/hive-js', () => ({ config: { set: jest.fn() }, api: { setOptions: jest.fn() }, broadcast: {} }));
jest.doMock('@blurtfoundation/blurtjs', () => ({ api: { setOptions: jest.fn() } }));
jest.doMock('web3', () => { const M = jest.fn(() => ({ eth: {}, utils: {} })); M.Web3 = M; return M; });
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

// Older local Node lacks AbortSignal.timeout; a plain signal is enough for tests
// (and avoids spawning a real timer under fake timers).
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = () => new AbortController().signal;
}

function setFetch(fn) { Object.defineProperty(global, 'fetch', { value: fn, configurable: true, writable: true }); }
function coingeckoReturns(hiveUsd, hbdUsd) {
  setFetch(jest.fn(() => Promise.resolve({ json: () => Promise.resolve({ hive: { usd: hiveUsd }, hive_dollar: { usd: hbdUsd } }) })));
}

const SIGNUP_ACCOUNT = 'actifit';
const HIVE_PRICE = 0.0437;   // $2 signup => ~46 HIVE required (~41 after the 10% buffer)
const HBD_PRICE = 0.9738;

// Build one account-history entry: [seq, { op:['transfer',{...}], timestamp, trx_id }].
function transfer({ to = SIGNUP_ACCOUNT, from = 'someuser', amount, memo, trx_id = 'tx_default', minutesAgo = 1 }) {
  return [1, {
    op: ['transfer', { from, to, amount, memo }],
    timestamp: moment().subtract(minutesAgo, 'minutes').format('YYYY-MM-DDTHH:mm:ss'),
    trx_id,
  }];
}

beforeEach(() => {
  utils._resetSignupPriceCache();
  coingeckoReturns(HIVE_PRICE, HBD_PRICE);
  cfg.signup_account = SIGNUP_ACCOUNT;
  delete cfg.signupCostUsd;
  delete cfg.signupFallbackHiveUsd;
  cfg.signupPaymentTimeoutMins = 15;
  global.__acctHistory = [];
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('confirmPaymentReceived — accepts a sufficient payment', () => {
  test('resolves with the tx id and records the real on-chain amount', async () => {
    jest.useFakeTimers();
    const memo = 'signup:GOODPAY1';
    global.__acctHistory = [transfer({ amount: '46.000 HIVE', memo, trx_id: 'good_tx_1' })];
    const req = { query: { sent_cur: 'HIVE', memo, steem_invest: '0.001' } };

    const p = utils.confirmPaymentReceived(req, 'HIVE', null);
    await jest.advanceTimersByTimeAsync(5000);   // fire the first poll tick
    const tx = await p;

    expect(tx).toBe('good_tx_1');
    // reward must anchor to what was ACTUALLY paid, never the client's steem_invest
    expect(req.verified_payment).toEqual({ amount: 46, currency: 'HIVE' });
  });

  test('accepts a correct HBD payment', async () => {
    jest.useFakeTimers();
    const memo = 'signup:GOODHBD';
    global.__acctHistory = [transfer({ amount: '2.000 HBD', memo, trx_id: 'good_hbd' })];
    const req = { query: { sent_cur: 'HBD', memo, steem_invest: '0.001' } };

    const p = utils.confirmPaymentReceived(req, 'HIVE', null);
    await jest.advanceTimersByTimeAsync(5000);
    const tx = await p;

    expect(tx).toBe('good_hbd');
    expect(req.verified_payment).toEqual({ amount: 2, currency: 'HBD' });
  });
});

describe('confirmPaymentReceived — rejects on the amount (the #51 fix)', () => {
  test('does NOT accept a tampered underpayment even with a low client steem_invest', async () => {
    jest.useFakeTimers();
    const memo = 'signup:TAMPER1';
    // client claims it only owes 5, and pays 5 -- but 5 HIVE (~$0.22) is far below the ~41 required
    global.__acctHistory = [transfer({ amount: '5.000 HIVE', memo, trx_id: 'low_tx' })];
    cfg.signupPaymentTimeoutMins = 0.1;   // ~6s deadline: tick@5s evaluates+rejects, tick@10s times out
    const req = { query: { sent_cur: 'HIVE', memo, steem_invest: '5' } };

    const p = utils.confirmPaymentReceived(req, 'HIVE', null);
    await jest.advanceTimersByTimeAsync(10000);
    const tx = await p;

    expect(tx).toBe('');                       // no tx accepted
    expect(req.verified_payment).toBeUndefined(); // nothing recorded -> no account, no reward
  });

  test('the same payment WOULD have been accepted under the old client-trusting check', async () => {
    // Guards the regression: old logic was `sentAmount >= steem_invest - 0.1`.
    // 5 >= 5 - 0.1 == true, so the tampered pay would have passed before the fix.
    const sent = 5, clientClaim = 5;
    expect(sent >= clientClaim - 0.1).toBe(true);           // old gate: ACCEPTED (bad)
    coingeckoReturns(HIVE_PRICE, HBD_PRICE);
    const required = await utils.signupRequiredCrypto('HIVE', null);
    expect(sent >= required).toBe(false);                   // new gate: REJECTED (good)
  });
});

describe('confirmPaymentReceived — binds to memo and currency', () => {
  test('ignores a sufficient payment carrying a different memo', async () => {
    jest.useFakeTimers();
    global.__acctHistory = [transfer({ amount: '50.000 HIVE', memo: 'signup:SOMEONE_ELSE', trx_id: 'other_memo' })];
    cfg.signupPaymentTimeoutMins = 0.1;
    const req = { query: { sent_cur: 'HIVE', memo: 'signup:MINE', steem_invest: '0.001' } };

    const p = utils.confirmPaymentReceived(req, 'HIVE', null);
    await jest.advanceTimersByTimeAsync(10000);
    const tx = await p;

    expect(tx).toBe('');
    expect(req.verified_payment).toBeUndefined();
  });

  test('ignores a sufficient payment sent in the wrong currency', async () => {
    jest.useFakeTimers();
    const memo = 'signup:WRONGCUR';
    // 50 HBD is plenty of USD, but the request said HIVE -> currency mismatch must not match
    global.__acctHistory = [transfer({ amount: '50.000 HBD', memo, trx_id: 'wrong_cur' })];
    cfg.signupPaymentTimeoutMins = 0.1;
    const req = { query: { sent_cur: 'HIVE', memo, steem_invest: '0.001' } };

    const p = utils.confirmPaymentReceived(req, 'HIVE', null);
    await jest.advanceTimersByTimeAsync(10000);
    const tx = await p;

    expect(tx).toBe('');
    expect(req.verified_payment).toBeUndefined();
  });
});
