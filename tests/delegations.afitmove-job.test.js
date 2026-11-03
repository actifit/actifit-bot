/**
 * The daily AFIT -> Hive-Engine move job (delegations.processAfitMoves), with a mock db
 * and mocked Hive / Hive-Engine clients. Focus: nothing is sent without a readable sending
 * balance, and a debit is refunded only when the transfer is confirmed not to have happened.
 */

const dhive = require('@hiveio/dhive');
const { ObjectId } = require('mongodb');
const { createMockDb } = require('./helpers/mock-db');
const utils = require('../utils');
const mail = require('../mail');
const delegations = require('../delegations');

const KEY = dhive.PrivateKey.fromSeed('afit-move-job-test').toString();
const CONFIG = {
  account: 'actifit', active_key: KEY,
  max_afit_to_se_day: 5000, free_movable_afit_day: 300, afitx_afit_move_ratio: 100, afit_powerdown_days: 7,
};
const LANDED = (to) => ({ logs: JSON.stringify({ events: [{ contract: 'tokens', event: 'transfer', data: { from: 'actifit', to, symbol: 'AFIT', quantity: '100' } }] }) });

describe('delegations.processAfitMoves', () => {
  let db;

  const balanceOf = (user) => db.collection('user_tokens').__data().find((d) => d._id === user).tokens;
  const unresolved = () => db.collection('afit_move_unresolved').__data();

  function chain({ actifitBalance = { balance: '10000' }, send, txInfo = async () => null, status = async () => ({ status: 'unknown' }) } = {}) {
    const hsc = {
      findOne: jest.fn(async (contract, table, q) => {
        if (q.symbol === 'AFIT') {
          if (actifitBalance instanceof Error) throw actifitBalance;
          return actifitBalance;
        }
        return { balance: '100' }; // AFITX
      }),
      getTransactionInfo: jest.fn(txInfo),
    };
    const hiveClient = new dhive.Client('http://127.0.0.1:1');
    hiveClient.database.getDynamicGlobalProperties = async () => ({
      head_block_number: 5000, head_block_id: '00001388aabbccddeeff00112233445566778899', time: new Date().toISOString().slice(0, 19),
    });
    hiveClient.broadcast.send = jest.fn(send || (async () => ({ id: 'x' })));
    hiveClient.call = jest.fn(async (api, method, params) => status(params));
    return { hsc, hiveClient };
  }

  const run = (c, over = {}) => delegations.processAfitMoves(false, Object.assign({
    config: CONFIG, hsc: c.hsc, ssc: null, hiveClient: c.hiveClient,
    sleep: jest.fn(async () => {}), gapMs: 0, resolveOpts: { now: () => 0, attempts: 3 },
  }, over));

  beforeEach(() => {
    db = createMockDb();
    delegations.__setTestDb(db);
    jest.spyOn(utils, 'sendNotification').mockResolvedValue(true);
    jest.spyOn(mail, 'sendPlainMail').mockResolvedValue(true);
    db.collection('user_tokens').__seed([{ _id: 'alice', user: 'alice', tokens: 1000 }]);
    db.collection('powering_down_he').__seed([{ _id: new ObjectId(), user: 'alice', daily_afit_transfer: 100, date: new Date() }]);
  });

  afterEach(() => jest.restoreAllMocks());

  test('happy path: debits, sends once, no refund, order kept', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    const out = await run(c);
    expect(out).toMatchObject({ sent: 1, refunded: 0, unresolved: 0 });
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(balanceOf('alice')).toBe(900);
    const json = JSON.parse(c.hiveClient.broadcast.send.mock.calls[0][0].operations[0][1].json);
    expect(json.contractPayload).toMatchObject({ symbol: 'AFIT', to: 'alice', quantity: '100' });
    expect(db.collection('powering_down_he').__data()[0].last_move_day).toBeDefined();
  });

  test('the same order is not sent twice on one day', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    await run(c);
    await run(c);
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(balanceOf('alice')).toBe(900);
  });

  test('sending balance unreadable (error): nothing is sent', async () => {
    const c = chain({ actifitBalance: new Error('H-E down') });
    await expect(run(c)).resolves.toEqual({ skipped: 'balance' });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(balanceOf('alice')).toBe(1000);
  });

  test('sending balance missing: nothing is sent', async () => {
    const c = chain({ actifitBalance: null });
    await expect(run(c)).resolves.toEqual({ skipped: 'balance' });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
  });

  test('sending balance too low: the order is skipped (kept), user not debited', async () => {
    const c = chain({ actifitBalance: { balance: '50' } });
    const out = await run(c);
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(balanceOf('alice')).toBe(1000);
    expect(db.collection('powering_down_he').__data()).toHaveLength(1);
  });

  test('the sending balance is spent down across orders in one run', async () => {
    db.collection('user_tokens').__seed([{ _id: 'bob', user: 'bob', tokens: 1000 }]);
    db.collection('powering_down_he').__seed([{ _id: new ObjectId(), user: 'bob', daily_afit_transfer: 100, date: new Date() }]);
    const c = chain({ actifitBalance: { balance: '150' }, txInfo: async (id) => LANDED('alice') });
    const out = await run(c);
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(out.skipped).toBe(1);
    expect(balanceOf('bob')).toBe(1000);
  });

  test('missing config limits: nothing is sent', async () => {
    const c = chain();
    const cfg = Object.assign({}, CONFIG);
    delete cfg.max_afit_to_se_day;
    await expect(run(c, { config: cfg })).resolves.toEqual({ skipped: 'config' });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
  });

  test('broadcast error but the transfer DID land: no refund', async () => {
    const c = chain({ send: async () => { throw new Error('timeout'); }, txInfo: async () => LANDED('alice') });
    const out = await run(c);
    expect(out).toMatchObject({ refunded: 0, unresolved: 0 });
    expect(balanceOf('alice')).toBe(900);
  });

  test('broadcast error and the transaction expired without landing: refund', async () => {
    const c = chain({ send: async () => { throw new Error('timeout'); }, status: async () => ({ status: 'expired_irreversible' }) });
    const out = await run(c);
    expect(out).toMatchObject({ refunded: 1, unresolved: 0 });
    expect(balanceOf('alice')).toBe(1000);
    // looked up by the id of the transaction that was actually sent
    const sent = c.hiveClient.broadcast.send.mock.calls[0][0];
    expect(c.hiveClient.call).toHaveBeenCalledWith('transaction_status_api', 'find_transaction', { transaction_id: dhive.cryptoUtils.generateTrxId(sent), expiration: sent.expiration });
  });

  test('accepted but rejected by Hive-Engine: refund', async () => {
    const c = chain({ txInfo: async () => ({ logs: '{"errors":["overdrawn balance"]}' }) });
    const out = await run(c);
    expect(out).toMatchObject({ sent: 1, refunded: 1 });
    expect(balanceOf('alice')).toBe(1000);
  });

  test('broadcast error and the outcome cannot be determined: no refund, unresolved row', async () => {
    const c = chain({ send: async () => { throw new Error('socket hang up'); }, status: async () => { throw new Error('api down'); } });
    const out = await run(c);
    expect(out).toMatchObject({ refunded: 0, unresolved: 1 });
    expect(balanceOf('alice')).toBe(900);
    expect(unresolved()).toHaveLength(1);
    expect(unresolved()[0]).toMatchObject({ user: 'alice', amount: 100, reason: 'broadcast_error_unverified', status: 'open' });
    expect(unresolved()[0].trx_id).toMatch(/^[0-9a-f]{40}$/);
  });

  test('banned and stale orders are not sent', async () => {
    db.collection('banned_accounts').__seed([{ user: 'alice', ban_status: 'active' }]);
    db.collection('user_tokens').__seed([{ _id: 'old', user: 'old', tokens: 1000 }]);
    db.collection('powering_down_he').__seed([{ _id: new ObjectId(), user: 'old', daily_afit_transfer: 100, date: new Date(Date.now() - 30 * 86400000) }]);
    const c = chain();
    const out = await run(c);
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ skipped: 1, cancelled: 1 });
    expect(db.collection('powering_down_he').__data().map((e) => e.user)).toEqual(['alice']);
  });

  test('insufficient user balance cancels the order without sending', async () => {
    db.collection('user_tokens').__data()[0].tokens = 50;
    const c = chain();
    const out = await run(c);
    expect(out.cancelled).toBe(1);
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(db.collection('powering_down_he').__data()).toHaveLength(0);
  });

  test('every send is recorded as an attempt (trx id) and settled', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    await run(c);
    const attempts = db.collection('afit_move_attempts').__data();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ user: 'alice', amount: 100, status: 'landed', debited: true });
    expect(attempts[0].trx_id).toBe(dhive.cryptoUtils.generateTrxId(c.hiveClient.broadcast.send.mock.calls[0][0]));
    const ledger = db.collection('token_transactions').__data().find((r) => r.reward_activity === 'Move AFIT to H-E');
    expect(ledger).toMatchObject({ user: 'alice', token_count: -100, afit_move_trx: attempts[0].trx_id });
  });

  test('another process claimed the order first: nothing is debited or sent', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    db.collection('powering_down_he').updateOne.mockImplementationOnce(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    const out = await run(c);
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(balanceOf('alice')).toBe(1000);
  });

  test('a second concurrent run in the same process is refused', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    const [a, b] = await Promise.all([run(c), run(c)]);
    expect([a, b]).toContainEqual({ skipped: 'running' });
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(balanceOf('alice')).toBe(900);
  });

  test('several orders for one user: only one is sent per day', async () => {
    db.collection('powering_down_he').__seed([{ _id: new ObjectId(), user: 'alice', daily_afit_transfer: 100, date: new Date() }]);
    const c = chain({ txInfo: async () => LANDED('alice') });
    await run(c);
    await run(c);
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(balanceOf('alice')).toBe(900);
  });

  test('a failed debit (ledger write) gives the day back: the order is retried and sent', async () => {
    const c = chain({ txInfo: async () => LANDED('alice') });
    db.collection('token_transactions').insertOne.mockImplementationOnce(async () => { throw new Error('write failed'); });
    const first = await run(c);
    expect(first).toMatchObject({ sent: 0, skipped: 1 });
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(balanceOf('alice')).toBe(1000);
    expect(db.collection('powering_down_he').__data()[0].last_move_day).toBeUndefined();
    expect(db.collection('afit_move_attempts').__data()[0]).toMatchObject({ status: 'not_debited', reason: 'ledger_failed' });
    await run(c);
    expect(c.hiveClient.broadcast.send).toHaveBeenCalledTimes(1);
    expect(balanceOf('alice')).toBe(900);
  });

  test('a refund whose ledger-row removal fails is recorded with what was undone', async () => {
    const c = chain({ send: async () => { throw new Error('timeout'); }, status: async () => ({ status: 'expired_irreversible' }) });
    db.collection('token_transactions').deleteOne.mockImplementation(async () => { throw new Error('delete failed'); });
    const out = await run(c);
    expect(out).toMatchObject({ refunded: 0, unresolved: 1 });
    expect(balanceOf('alice')).toBe(1000); // the cached balance was restored
    expect(unresolved()[0]).toMatchObject({ reason: 'refund_incomplete_after_not_landed', refund: { ledgerRemoved: false, restored: true } });
    expect(db.collection('afit_move_attempts').__data()[0].status).toBe('unresolved');
  });

  describe('recovery of attempts left in flight by a stopped process', () => {
    const old = () => new Date(Date.now() - 20 * 60000);
    const recover = (c) => delegations.recoverAfitMoveAttempts({ hsc: c.hsc, hiveClient: c.hiveClient, sleep: jest.fn(async () => {}), resolveOpts: { now: () => 0 } });
    const seedAttempt = (fields) => db.collection('afit_move_attempts').__seed([Object.assign({
      _id: 'trx1', trx_id: 'trx1', expiration: '2026-11-03T10:01:00', user: 'alice', amount: 100,
      order_id: null, status: 'in_flight', debited: true, ledger_id: 'L1', date: old(),
    }, fields)]);
    const debitAlice = () => {
      db.collection('user_tokens').__data()[0].tokens = 900;
      db.collection('token_transactions').__seed([{ _id: 'L1', user: 'alice', token_count: -100, reward_activity: 'Move AFIT to H-E', afit_move_trx: 'trx1' }]);
    };

    test('debited, never landed (expired): refund', async () => {
      debitAlice();
      seedAttempt();
      const c = chain({ status: async () => ({ status: 'expired_irreversible' }) });
      const out = await recover(c);
      expect(out).toMatchObject({ recovered: 1, refunded: 1 });
      expect(balanceOf('alice')).toBe(1000);
      expect(db.collection('token_transactions').__data()).toHaveLength(0);
      expect(db.collection('afit_move_attempts').__data()[0].status).toBe('refunded');
    });

    test('stopped after the debit, before the attempt was updated (ledger found by trx id): refund when expired', async () => {
      debitAlice();
      seedAttempt({ debited: false, ledger_id: null });
      const c = chain({ status: async () => ({ status: 'expired_irreversible' }) });
      await recover(c);
      expect(balanceOf('alice')).toBe(1000);
      expect(db.collection('afit_move_attempts').__data()[0].status).toBe('refunded');
    });

    test('stopped before the debit: nothing to refund', async () => {
      seedAttempt({ debited: false, ledger_id: null });
      const c = chain({ status: async () => ({ status: 'expired_irreversible' }) });
      const out = await recover(c);
      expect(out).toMatchObject({ not_debited: 1, refunded: 0 });
      expect(balanceOf('alice')).toBe(1000);
      expect(db.collection('afit_move_attempts').__data()[0].status).toBe('not_debited');
    });

    test('landed: no refund', async () => {
      debitAlice();
      seedAttempt();
      const c = chain({ txInfo: async () => LANDED('alice') });
      const out = await recover(c);
      expect(out).toMatchObject({ landed: 1, refunded: 0 });
      expect(balanceOf('alice')).toBe(900);
    });

    test('undeterminable: no refund, unresolved row', async () => {
      debitAlice();
      seedAttempt();
      const c = chain({ status: async () => { throw new Error('down'); } });
      const out = await recover(c);
      expect(out).toMatchObject({ unresolved: 1, refunded: 0 });
      expect(balanceOf('alice')).toBe(900);
      expect(unresolved()[0]).toMatchObject({ user: 'alice', trx_id: 'trx1', reason: 'broadcast_error_unverified' });
    });

    test('recent in-flight attempts are left alone, and an attempt is settled only once', async () => {
      debitAlice();
      seedAttempt({ date: new Date() });
      const c = chain({ status: async () => ({ status: 'expired_irreversible' }) });
      await expect(recover(c)).resolves.toMatchObject({ recovered: 0 });
      db.collection('afit_move_attempts').__data()[0].date = old();
      await Promise.all([recover(c), recover(c)]);
      expect(balanceOf('alice')).toBe(1000);
    });

    test('a run settles left-over attempts before sending', async () => {
      debitAlice();
      seedAttempt();
      const c = chain({
        status: async (p) => (p.transaction_id === 'trx1' ? { status: 'expired_irreversible' } : { status: 'unknown' }),
        txInfo: async (id) => (id === 'trx1' ? null : LANDED('alice')),
      });
      const out = await run(c);
      expect(db.collection('afit_move_attempts').__data().find((a) => a._id === 'trx1').status).toBe('refunded');
      expect(out.sent).toBe(1);
      expect(balanceOf('alice')).toBe(900); // refunded 100, then today's 100 sent
    });
  });

  test('a transaction that would expire before it is sent is not sent: refund and the day is given back', async () => {
    const c = chain();
    c.hiveClient.database.getDynamicGlobalProperties = async () => ({
      head_block_number: 5000, head_block_id: '00001388aabbccddeeff00112233445566778899', time: '2020-01-01T00:00:00',
    });
    const out = await run(c);
    expect(c.hiveClient.broadcast.send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ sent: 0, refunded: 1 });
    expect(balanceOf('alice')).toBe(1000);
    expect(db.collection('powering_down_he').__data()[0].last_move_day).toBeUndefined();
    expect(db.collection('afit_move_attempts').__data()[0].status).toBe('refunded');
  });
});
