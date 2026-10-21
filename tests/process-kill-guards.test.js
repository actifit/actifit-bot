/**
 * Guards for RPC answers that used to escape into async contexts nothing catches.
 *
 * TWO DIFFERENT RISK CLASSES — do not conflate them:
 *
 *  - `claimRewards` (via /claimRewards, app.js) and `findVerifyTrx` (via 13 routes) are
 *    genuine PROCESS KILLS. Those handlers are async with no try/catch, there is no
 *    Express error handler, and Node defaults to --unhandled-rejections=throw.
 *  - `getEstimatedReward` is NOT. That handler already has its own try/catch; its bug
 *    was a degraded response (`{error:'failed to calculate estimate'}` for every
 *    caller). It is covered in tests/endpoints.test.js, where the supertest harness
 *    lives.
 *
 * WHAT THESE TESTS MUST ASSERT, learned the hard way: an earlier version of this file
 * checked only the FAILURE VALUE (`resolves.toBe(false)`). That passes against a
 * `findVerifyTrx` that returns false immediately and never polls at all — i.e. one
 * where every signup and gadget payment verification is silently dead. Every test
 * below therefore asserts that the work was actually DRIVEN, not just that the return
 * value looks right.
 *
 * Config and credentials are mocked so this runs on any machine. The previous version
 * read the real gitignored config.json and initialised Firebase with production
 * credentials to run a unit test.
 */

const path = require('path');

const mockConfigFs = () => {
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
};
jest.doMock('node:fs', mockConfigFs);
jest.doMock('fs', mockConfigFs);
jest.doMock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => 'mock-cert') },
  messaging: jest.fn(() => ({ sendAll: jest.fn(), sendEach: jest.fn() })),
}));

const blurt = require('@blurtfoundation/blurtjs');
const hive = require('@hiveio/hive-js');
const utils = require('../utils');

const BlurtApi = blurt.api.constructor;
const config = utils.getConfig();

const ACCT = { name: 'alice', reward_hive_balance: '0.000 HIVE', reward_hbd_balance: '0.000 HBD', reward_vesting_balance: '0.000000 VESTS' };

describe('claimRewards — a missing account must not kill the process', () => {
  let origNode, origAlts;

  beforeEach(() => {
    origNode = config.blurt_node;
    origAlts = config.alt_blurt_nodes;
    // Pin the endpoint list. Reading whatever the host happens to have configured made
    // the BLURT tests pass vacuously on a machine with none: fetchOneAccount returns
    // null before building a client, so `send` is never called and the assertion on the
    // return value still passes.
    config.blurt_node = 'https://b1.test';
    config.alt_blurt_nodes = ['https://b1.test', 'https://b2.test'];
  });

  afterEach(() => {
    config.blurt_node = origNode;
    config.alt_blurt_nodes = origAlts;
    jest.restoreAllMocks();
  });

  it('returns an error for a Hive account that does not exist, rather than throwing', async () => {
    // get_accounts answers [] for an unknown account. The old guard tested the ARRAY
    // (truthy) rather than the element, so it fell through to targetAccount[0] ->
    // undefined -> undefined.reward_hive_balance -> TypeError.
    const spy = jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([]);

    await expect(utils.claimRewards('ghost', '5Kfake', 'HIVE')).resolves.toEqual({ error: 'account not found' });
    expect(spy).toHaveBeenCalledWith(['ghost']);
  });

  it('returns an error when the Hive node rejects, rather than throwing', async () => {
    // The old code did `.catch(err => {return err;})` — resolving the Error AS the
    // value, so the truthy guard passed and the next property read threw.
    const spy = jest.spyOn(hive.api, 'getAccountsAsync').mockRejectedValue(new Error('HTTP 503'));

    await expect(utils.claimRewards('alice', '5Kfake', 'HIVE')).resolves.toEqual({ error: 'account not found' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('claims successfully when the account exists', async () => {
    // Pins the array-vs-element contract: fetchOneAccount must hand back the ELEMENT.
    // Without this, returning the raw array goes unnoticed by the failure-path tests.
    jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([
      { ...ACCT, reward_hive_balance: '1.000 HIVE' },
    ]);
    const bc = jest.spyOn(hive.broadcast, 'claimRewardBalanceAsync').mockResolvedValue({ ref_block_num: 123 });

    await expect(utils.claimRewards('alice', '5Kfake', 'HIVE')).resolves.toEqual({ success: true });
    expect(bc).toHaveBeenCalled();
  });

  it('returns an error for a user with no BLURT account, having tried every endpoint', async () => {
    // THIS is the case that fired in production: /claimRewards calls the BLURT leg on
    // every request and most Hive users have no Blurt account.
    const tried = [];
    jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
      tried.push(this.options.uri);
      cb(null, []);
    });

    await expect(utils.claimRewards('hive-only', '5Kfake', 'BLURT')).resolves.toEqual({ error: 'account not found' });
    expect(tried).toEqual(['https://b1.test', 'https://b2.test']);
  });

  it('returns an error when every Blurt endpoint is down', async () => {
    const tried = [];
    jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
      tried.push(this.options.uri);
      cb(new Error('HTTP 503'));
    });

    await expect(utils.claimRewards('alice', '5Kfake', 'BLURT')).resolves.toEqual({ error: 'account not found' });
    expect(tried).toEqual(['https://b1.test', 'https://b2.test']);
  });
});

describe('findVerifyTrx — a bad RPC or DB answer must not kill the polling process', () => {
  const OPS = [['vote', { voter: 'alice' }]];
  const makeReq = (operation) => ({
    params: { trxID: 'deadbeef' },
    query: { bchain: 'HIVE', operation },
  });
  const okDb = () => ({ collection: () => ({ findOne: async () => null, insertOne: async () => ({ insertedId: 'x' }) }) });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects a malformed operation parameter BEFORE any polling starts', async () => {
    // Deterministic bad input: inlined in the loop it threw the identical SyntaxError on
    // all 30 ticks, i.e. 30 chances to end the process. Asserting the spy is untouched
    // pins WHERE the parse happens — the previous version only noticed because the test
    // ran for 150s and hit Jest's timeout.
    const getTx = jest.spyOn(hive.api, 'getTransactionAsync');

    await expect(utils.findVerifyTrx(makeReq('{not json'), okDb(), true)).resolves.toBe(false);
    expect(getTx).not.toHaveBeenCalled();
  });

  it('polls its full budget and resolves false when the node throws every time', async () => {
    // The assertion that matters is the CALL COUNT. Without it, an implementation that
    // never polls at all passes — which would mean every payment verification silently
    // dead while the suite stayed green.
    jest.useFakeTimers();
    const getTx = jest.spyOn(hive.api, 'getTransactionAsync').mockRejectedValue(new Error('HTTP 503'));

    const pending = utils.findVerifyTrx(makeReq(JSON.stringify(OPS)), okDb(), true);
    await jest.advanceTimersByTimeAsync(170000);

    await expect(pending).resolves.toBe(false);
    expect(getTx).toHaveBeenCalledTimes(29);
    expect(getTx).toHaveBeenCalledWith('deadbeef');
  });

  it('lets nothing escape the interval callback as an unhandled rejection', async () => {
    // Asserted directly rather than relying on Jest's reporter to notice — a stray
    // process.on('unhandledRejection') in setup.js would otherwise disarm the only
    // signal guarding the headline fix.
    jest.useFakeTimers();
    jest.spyOn(hive.api, 'getTransactionAsync').mockRejectedValue(new Error('HTTP 503'));
    const escaped = [];
    const onRej = (e) => escaped.push(e);
    process.on('unhandledRejection', onRej);
    try {
      const pending = utils.findVerifyTrx(makeReq(JSON.stringify(OPS)), okDb(), true);
      await jest.advanceTimersByTimeAsync(170000);
      await pending;
    } finally {
      process.off('unhandledRejection', onRej);
    }

    expect(escaped).toEqual([]);
  });

  it('survives a Mongo failure on the replay-guard lookup', async () => {
    // The first Mongo call sits outside the polling loop's protection, and all 13
    // callers are unauthenticated routes whose handlers have no try/catch.
    const db = { collection: () => ({ findOne: async () => { throw new Error('Mongo blip'); } }) };

    await expect(utils.findVerifyTrx(makeReq(JSON.stringify(OPS)), db, true)).resolves.toEqual({ error: 'verification unavailable' });
  });

  it('does not report a match it failed to record', async () => {
    // nostore FALSY — the production default for 10 of the 13 callers, and the only
    // path the store/matchFound ordering affects. verified_tx is both the replay guard
    // and the source the stage-two verifiers re-read, so reporting success for a row
    // that was never written loses the user's payment with nothing to redeem.
    jest.useFakeTimers();
    const insertOne = jest.fn(async () => { throw new Error('Mongo write blip'); });
    const db = { collection: () => ({ findOne: async () => null, insertOne }) };
    const tx = {
      transaction_id: 'deadbeef',
      ref_block_num: 42,
      operations: OPS,
      expiration: new Date(Date.now() + 60000).toISOString(),
    };
    jest.spyOn(hive.api, 'getTransactionAsync').mockResolvedValue(tx);

    const pending = utils.findVerifyTrx(makeReq(JSON.stringify(OPS)), db);
    await jest.advanceTimersByTimeAsync(170000);

    expect(insertOne).toHaveBeenCalled();
    await expect(pending).resolves.toBe(false);
  });

  it('reports the match once the row is recorded', async () => {
    jest.useFakeTimers();
    const insertOne = jest.fn(async () => ({ insertedId: 'x' }));
    const db = { collection: () => ({ findOne: async () => null, insertOne }) };
    const tx = {
      transaction_id: 'deadbeef',
      ref_block_num: 42,
      operations: OPS,
      expiration: new Date(Date.now() + 60000).toISOString(),
    };
    jest.spyOn(hive.api, 'getTransactionAsync').mockResolvedValue(tx);

    const pending = utils.findVerifyTrx(makeReq(JSON.stringify(OPS)), db);
    await jest.advanceTimersByTimeAsync(170000);

    expect(insertOne).toHaveBeenCalled();
    await expect(pending).resolves.toEqual(tx);
  });
});
