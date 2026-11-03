/**
 * afit_transfers: AFIT tips, the AFIT -> Hive-Engine move order, and the transfer
 * outcome lookup used before any refund. Pure module: db and chains are mocked.
 */

const dhive = require('@hiveio/dhive');
const { createMockDb } = require('./helpers/mock-db');
const afitTransfers = require('../afit_transfers');

const isValidName = (name) => typeof name === 'string' && /^[a-z][a-z0-9.-]{2,15}$/.test(name);

function tipDeps(db, over = {}) {
  return Object.assign({
    db,
    config: { max_allowed_tips_per_day: 100 },
    withAfitLock: async (user, fn) => ({ value: await fn() }),
    busyError: 'busy',
    tippedToday: async (user) => db.collection('token_transactions').__data()
      .filter((r) => r.user === user && r.reward_activity === 'Send Tip')
      .reduce((s, r) => s + r.tip_amount, 0),
    accountExists: async () => true,
    isValidName,
    notify: jest.fn(() => Promise.resolve(true)),
  }, over);
}

const balanceOf = (db, user) => {
  const doc = db.collection('user_tokens').__data().find((d) => d._id === user);
  return doc ? doc.tokens : undefined;
};

describe('afitAmount', () => {
  test.each([
    [10, 10], ['10', 10], ['0.5', 0.5], [1.234, 1.234], ['1.234', 1.234],
  ])('accepts %p', (v, out) => expect(afitTransfers.afitAmount(v)).toBe(out));

  test.each([
    [0], [-1], ['-1'], [NaN], [Infinity], ['abc'], [''], ['1e3'], [' 5'], ['0x10'], [1.2345], ['1.2345'], [null], [undefined], [true], [[5]], ['0.000'],
  ])('rejects %p', (v) => expect(afitTransfers.afitAmount(v)).toBeNull());
});

describe('tipAccount', () => {
  let db;
  beforeEach(() => {
    db = createMockDb();
    db.collection('user_tokens').__seed([{ _id: 'alice', user: 'alice', tokens: 50 }, { _id: 'bob', user: 'bob', tokens: 5 }]);
  });

  test('happy path: moves the AFIT, writes both ledger rows with user, default note', async () => {
    const deps = tipDeps(db);
    const out = await afitTransfers.tipAccount(deps, 'alice', { targetUser: '@bob', amount: '10' });
    expect(out).toEqual({ status: 'Success', tipAmount: 10, senderTokenCount: 40, recipientTokenCount: 15 });
    expect(balanceOf(db, 'alice')).toBe(40);
    expect(balanceOf(db, 'bob')).toBe(15);
    const rows = db.collection('token_transactions').__data();
    const send = rows.find((r) => r.reward_activity === 'Send Tip');
    const recv = rows.find((r) => r.reward_activity === 'Receive Tip');
    expect(send).toMatchObject({ user: 'alice', token_count: -10, tip_amount: 10, recipient: 'bob', note: 'alice tipped bob 10 AFIT' });
    expect(recv).toMatchObject({ user: 'bob', token_count: 10, sender: 'alice', note: 'alice tipped bob 10 AFIT' });
    // the notification text never says "undefined"
    for (const call of deps.notify.mock.calls) expect(call[5]).not.toMatch(/undefined/);
  });

  test('the sent tip counts toward the daily cap (ledger row carries user)', async () => {
    const deps = tipDeps(db);
    await expect(afitTransfers.tipAccount(deps, 'alice', { targetUser: 'bob', amount: 30 })).resolves.toMatchObject({ status: 'Success' });
    expect(await deps.tippedToday('alice')).toBe(30);
  });

  test('daily cap: a tip over the remaining allowance is refused and nothing moves', async () => {
    db.collection('user_tokens').__data()[0].tokens = 500;
    const deps = tipDeps(db, { tippedToday: async () => 90 });
    const out = await afitTransfers.tipAccount(deps, 'alice', { targetUser: 'bob', amount: 20 });
    expect(out.error).toMatch(/exceeds daily limit \(100\) by 10 AFIT/);
    expect(balanceOf(db, 'alice')).toBe(500);
    expect(balanceOf(db, 'bob')).toBe(5);
  });

  test('daily cap reached', async () => {
    const out = await afitTransfers.tipAccount(tipDeps(db, { tippedToday: async () => 100 }), 'alice', { targetUser: 'bob', amount: 1 });
    expect(out.error).toMatch(/cannot tip more today/);
  });

  test('missing cap in config fails closed', async () => {
    const out = await afitTransfers.tipAccount(tipDeps(db, { config: {} }), 'alice', { targetUser: 'bob', amount: 1 });
    expect(out.error).toMatch(/temporarily unavailable/);
    expect(balanceOf(db, 'alice')).toBe(50);
  });

  test('insufficient funds', async () => {
    const out = await afitTransfers.tipAccount(tipDeps(db), 'bob', { targetUser: 'alice', amount: 6 });
    expect(out).toEqual({ error: 'Account does not have enough AFIT funds' });
    expect(balanceOf(db, 'bob')).toBe(5);
    expect(balanceOf(db, 'alice')).toBe(50);
  });

  test('self-tip, invalid recipient, unknown recipient, bad amounts are refused', async () => {
    const deps = tipDeps(db);
    expect((await afitTransfers.tipAccount(deps, 'alice', { targetUser: 'alice', amount: 1 })).error).toMatch(/own account/);
    expect((await afitTransfers.tipAccount(deps, 'alice', { targetUser: 'Bad Name!', amount: 1 })).error).toMatch(/Invalid recipient/);
    expect((await afitTransfers.tipAccount(deps, 'alice', { targetUser: { $ne: 1 }, amount: 1 })).error).toMatch(/Invalid recipient/);
    expect((await afitTransfers.tipAccount(tipDeps(db, { accountExists: async () => null }), 'alice', { targetUser: 'bob', amount: 1 })).error).toMatch(/not found/);
    expect((await afitTransfers.tipAccount(tipDeps(db, { accountExists: async () => { throw new Error('node down'); } }), 'alice', { targetUser: 'bob', amount: 1 })).error).toMatch(/not found/);
    for (const amount of [-5, '1.2345', 'abc', 0]) {
      expect((await afitTransfers.tipAccount(deps, 'alice', { targetUser: 'bob', amount })).error).toBeDefined();
    }
    expect(balanceOf(db, 'alice')).toBe(50);
    expect(db.collection('token_transactions').__data()).toHaveLength(0);
  });

  test('banned sender or recipient', async () => {
    db.collection('banned_accounts').__seed([{ user: 'bob', ban_status: 'active' }]);
    expect((await afitTransfers.tipAccount(tipDeps(db), 'alice', { targetUser: 'bob', amount: 1 })).error).toMatch(/banned account/);
    expect((await afitTransfers.tipAccount(tipDeps(db), 'bob', { targetUser: 'alice', amount: 1 })).error).toMatch(/account is banned/);
  });

  test('a failed credit gives the sender the AFIT back', async () => {
    const deps = tipDeps(db, { withAfitLock: async (user, fn) => (user === 'bob' ? { busy: true } : { value: await fn() }) });
    const out = await afitTransfers.tipAccount(deps, 'alice', { targetUser: 'bob', amount: 10 });
    expect(out.error).toMatch(/DB storing issue/);
    expect(balanceOf(db, 'alice')).toBe(50);
    expect(balanceOf(db, 'bob')).toBe(5);
  });

  test('a custom note is used and capped in length', async () => {
    await afitTransfers.tipAccount(tipDeps(db), 'alice', { targetUser: 'bob', amount: 1, note: 'x'.repeat(600) });
    const send = db.collection('token_transactions').__data().find((r) => r.reward_activity === 'Send Tip');
    expect(send.note).toHaveLength(500);
  });
});

describe('initiateAfitMove', () => {
  let db;
  const config = { max_afit_to_se_day: 5000, free_movable_afit_day: 300, afitx_afit_move_ratio: 100 };
  const deps = (over = {}) => Object.assign({
    db,
    config,
    hsc: { findOne: jest.fn(async () => ({ balance: '50' })) },
    ssc: { findOne: jest.fn(async () => { throw new Error('S-E down'); }) },
    grabUserTokens: async (user) => ({ tokens: (db.collection('user_tokens').__data().find((d) => d._id === user) || { tokens: 0 }).tokens.toFixed(3) }),
  }, over);

  beforeEach(() => {
    db = createMockDb();
    db.collection('user_tokens').__seed([{ _id: 'alice', user: 'alice', tokens: 2000 }]);
  });

  test('records the order (S-E outage does not matter)', async () => {
    const out = await afitTransfers.initiateAfitMove(deps(), 'alice', { amount: '1000' });
    expect(out.status).toBe('Success');
    const rows = db.collection('powering_down_he').__data();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user: 'alice', daily_afit_transfer: 1000, min_afitx: 7 });
  });

  test('a small amount needs no AFITX lookup', async () => {
    const d = deps({ hsc: { findOne: jest.fn(async () => { throw new Error('H-E down'); }) } });
    await expect(afitTransfers.initiateAfitMove(d, 'alice', { amount: 300 })).resolves.toMatchObject({ status: 'Success' });
    expect(d.hsc.findOne).not.toHaveBeenCalled();
  });

  test.each([[-1], [0], ['abc'], ['1.2345'], ['1e3'], [NaN]])('rejects amount %p', async (amount) => {
    const out = await afitTransfers.initiateAfitMove(deps(), 'alice', { amount });
    expect(out.error).toBeDefined();
    expect(db.collection('powering_down_he').__data()).toHaveLength(0);
  });

  test('missing limits in config fail closed', async () => {
    for (const drop of ['max_afit_to_se_day', 'free_movable_afit_day', 'afitx_afit_move_ratio']) {
      const cfg = Object.assign({}, config);
      delete cfg[drop];
      const out = await afitTransfers.initiateAfitMove(deps({ config: cfg }), 'alice', { amount: 10 });
      expect(out.error).toMatch(/temporarily unavailable/);
    }
    expect(db.collection('powering_down_he').__data()).toHaveLength(0);
  });

  test('over the daily max, over the balance, not enough AFITX, AFITX unreadable', async () => {
    expect((await afitTransfers.initiateAfitMove(deps(), 'alice', { amount: 6000 })).error).toMatch(/more than 5000/);
    expect((await afitTransfers.initiateAfitMove(deps(), 'alice', { amount: 2500 })).error).toMatch(/enough AFIT funds/);
    expect((await afitTransfers.initiateAfitMove(deps({ hsc: { findOne: async () => ({ balance: '1' }) } }), 'alice', { amount: 1000 })).error).toMatch(/enough AFITX to move 1000/);
    expect((await afitTransfers.initiateAfitMove(deps({ hsc: { findOne: async () => null } }), 'alice', { amount: 1000 })).error).toMatch(/enough AFITX/);
    expect((await afitTransfers.initiateAfitMove(deps({ hsc: { findOne: async () => { throw new Error('x'); } } }), 'alice', { amount: 1000 })).error).toMatch(/Unable to fetch AFITX/);
    expect(db.collection('powering_down_he').__data()).toHaveLength(0);
  });

  test('banned user', async () => {
    db.collection('banned_accounts').__seed([{ user: 'alice', ban_status: 'active' }]);
    expect((await afitTransfers.initiateAfitMove(deps(), 'alice', { amount: 10 })).error).toMatch(/banned/);
  });
});

describe('signTransfer', () => {
  test('signs a custom_json transfer and returns its transaction id before broadcasting', async () => {
    const key = dhive.PrivateKey.fromSeed('afit-transfers-test');
    const client = new dhive.Client('http://127.0.0.1:1');
    client.database.getDynamicGlobalProperties = async () => ({
      head_block_number: 1000, head_block_id: '000003e8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6', time: '2026-11-03T10:00:00',
    });
    const out = await afitTransfers.signTransfer(client, { account: 'actifit', key, to: 'alice', quantity: 12.5 });
    expect(out.trxId).toMatch(/^[0-9a-f]{40}$/);
    expect(out.expiration).toBe('2026-11-03T10:01:00');
    expect(out.trxId).toBe(dhive.cryptoUtils.generateTrxId(out.signed));
    expect(out.signed.signatures).toHaveLength(1);
    const op = out.signed.operations[0];
    expect(op[0]).toBe('custom_json');
    expect(op[1]).toMatchObject({ required_auths: ['actifit'], id: 'ssc-mainnet-hive' });
    expect(JSON.parse(op[1].json).contractPayload).toEqual({ symbol: 'AFIT', to: 'alice', quantity: '12.5', memo: '' });
  });
});

describe('resolveTransfer', () => {
  const base = (hsc, hiveClient) => ({
    trxId: 'abc', expiration: '2026-11-03T10:01:00', to: 'alice', hsc, hiveClient, sleep: jest.fn(async () => {}), now: () => 0, attempts: 3,
  });
  const landedLogs = JSON.stringify({ events: [{ contract: 'tokens', event: 'transfer', data: { from: 'actifit', to: 'alice', symbol: 'AFIT', quantity: '10' } }] });

  test('landed when the engine shows the transfer', async () => {
    const r = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => ({ logs: landedLogs }) }, { call: jest.fn() }));
    expect(r.outcome).toBe('landed');
  });

  test('failed_on_engine when the engine logged errors', async () => {
    const r = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => ({ logs: '{"errors":["overdrawn balance"]}' }) }, { call: jest.fn() }));
    expect(r.outcome).toBe('failed_on_engine');
  });

  test('not_landed only on expired_irreversible', async () => {
    const r = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => null }, { call: async () => ({ status: 'expired_irreversible' }) }));
    expect(r.outcome).toBe('not_landed');
  });

  test('unknown when nothing can be confirmed', async () => {
    const r1 = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => { throw new Error('down'); } }, { call: async () => { throw new Error('down'); } }));
    expect(r1.outcome).toBe('unknown');
    const r2 = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => null }, { call: async () => ({ status: 'within_irreversible_block' }) }));
    expect(r2).toEqual({ outcome: 'unknown', hiveStatus: 'within_irreversible_block' });
    const r3 = await afitTransfers.resolveTransfer(base({ getTransactionInfo: async () => null }, { call: async () => ({ status: 'expired_reversible' }) }));
    expect(r3.outcome).toBe('unknown');
  });
});
