/**
 * Guards against three ways an RPC answer used to end the API process.
 *
 * The shared shape of all three: an `await` whose rejection, or whose unexpected
 * return shape, escapes into an async context nothing is catching. Express 4 does not
 * catch a rejection from an async handler, nothing here installs an
 * `unhandledRejection` handler, and package.json pins Node 20 — where the default is
 * `--unhandled-rejections=throw`. So an escape is a process exit, not a failed request.
 *
 * These are not hypothetical shapes: `getEstimatedReward error: TypeError:
 * (hiveReplies || []).filter is not a function` was taken from the live app-error.log
 * on 2026-10-12.
 */

const blurt = require('@blurtfoundation/blurtjs');
const hive = require('@hiveio/hive-js');
const utils = require('../utils');

const BlurtApi = blurt.api.constructor;

describe('claimRewards — a missing account must not kill the process', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns an error for a Hive account that does not exist, rather than throwing', async () => {
    // get_accounts answers [] for an unknown account. The old guard tested the ARRAY
    // (truthy) instead of the element, so it fell through to targetAccount[0] ->
    // undefined -> undefined.reward_hive_balance -> TypeError.
    jest.spyOn(hive.api, 'getAccountsAsync').mockResolvedValue([]);

    await expect(utils.claimRewards('ghost', '5Kfake', 'HIVE')).resolves.toEqual({ error: 'account not found' });
  });

  it('returns an error when the Hive node rejects, rather than throwing', async () => {
    // The old code did `.catch(err => {return err;})`, resolving the Error AS the
    // value — so the truthy guard passed and the next property read threw.
    jest.spyOn(hive.api, 'getAccountsAsync').mockRejectedValue(new Error('HTTP 503'));

    await expect(utils.claimRewards('someone', '5Kfake', 'HIVE')).resolves.toEqual({ error: 'account not found' });
  });

  it('returns an error for a user with no BLURT account — the common case', async () => {
    // THIS is the one that actually fired. /claimRewards (app.js:2408) calls the BLURT
    // leg on every request, and most Hive users have no Blurt account, so [] was the
    // normal answer rather than an edge case.
    jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
      cb(null, []);
    });

    await expect(utils.claimRewards('hive-only-user', '5Kfake', 'BLURT')).resolves.toEqual({ error: 'account not found' });
  });

  it('returns an error when every Blurt endpoint is down', async () => {
    jest.spyOn(BlurtApi.prototype, 'send').mockImplementation(function (api, data, cb) {
      cb(new Error('HTTP 503'));
    });

    await expect(utils.claimRewards('someone', '5Kfake', 'BLURT')).resolves.toEqual({ error: 'account not found' });
  });
});

describe('findVerifyTrx — a bad RPC answer must not kill the polling process', () => {
  const makeReq = (operation) => ({
    params: { trxID: 'deadbeef' },
    query: { bchain: 'HIVE', operation },
  });
  // The pre-flight lookup is the only DB call before the interval starts.
  const db = { collection: () => ({ findOne: async () => null }) };

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects a malformed operation parameter up front instead of 30 identical throws', async () => {
    // Deterministic bad input: every one of the 30 ticks would have thrown the same
    // SyntaxError inside the async callback, i.e. 30 chances to end the process.
    const out = await utils.findVerifyTrx(makeReq('{not json'), db, true);

    expect(out).toBe(false);
  });

  it('does not reject when the node throws on every attempt', async () => {
    // A node that 429s, 503s, or lacks the account-history plugin is ordinary. The
    // poll should burn its attempts and resolve false — never reject.
    jest.useFakeTimers();
    jest.spyOn(hive.api, 'getTransactionAsync').mockRejectedValue(new Error('HTTP 503'));

    const pending = utils.findVerifyTrx(makeReq('[]'), db, true);
    // 30 attempts x 5s, with headroom.
    await jest.advanceTimersByTimeAsync(170000);

    await expect(pending).resolves.toBe(false);
  });

  it('does not reject when the node answers with an unexpected shape', async () => {
    jest.useFakeTimers();
    jest.spyOn(hive.api, 'getTransactionAsync').mockResolvedValue('not an object');

    const pending = utils.findVerifyTrx(makeReq('[]'), db, true);
    await jest.advanceTimersByTimeAsync(170000);

    await expect(pending).resolves.toBe(false);
  });
});
