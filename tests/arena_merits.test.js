/**
 * Challenge Engine F4 Merits ledger + rewards shop (Trello #178) — unit tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const merits = require('../arena_merits');

const AT = '2026-08-25T10:00:00Z';

describe('arena_merits.award (credit / I3 / emission cap)', () => {
  test('credits a whitelisted reason and records balance_after', async () => {
    const db = createMockDb();
    const res = await merits.award(db, { user: 'alice', amount: 300, reason: 'challenge_reward', ref: 'ch1', at: AT });
    expect(res.ok).toBe(true);
    expect(res.entry).toMatchObject({ user: 'alice', delta: 300, reason: 'challenge_reward', balance_after: 300, immutable: true });
    expect(await merits.balanceOf(db, 'alice')).toBe(300);
  });

  test('I3 — rejects a non-whitelisted (buy/deposit) credit reason', async () => {
    const db = createMockDb();
    for (const reason of ['purchase', 'deposit', 'buy', 'transfer_in']) {
      const res = await merits.award(db, { user: 'alice', amount: 100, reason, at: AT });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/I3/);
    }
    expect(await merits.balanceOf(db, 'alice')).toBe(0);
  });

  test('rejects a non-positive amount', async () => {
    const db = createMockDb();
    expect((await merits.award(db, { user: 'a', amount: 0, reason: 'challenge_reward', at: AT })).ok).toBe(false);
    expect((await merits.award(db, { user: 'a', amount: -5, reason: 'challenge_reward', at: AT })).ok).toBe(false);
  });

  test('enforces the per-user daily emission cap (anti-sybil)', async () => {
    const db = createMockDb();
    expect((await merits.award(db, { user: 'a', amount: 800, reason: 'challenge_reward', at: AT })).ok).toBe(true);
    const partial = await merits.award(db, { user: 'a', amount: 400, reason: 'challenge_reward', at: AT });
    expect(partial).toMatchObject({ ok: true, capped: true });
    expect(partial.entry.delta).toBe(200); // only the room up to the 1000 cap
    const denied = await merits.award(db, { user: 'a', amount: 100, reason: 'challenge_reward', at: AT });
    expect(denied).toMatchObject({ ok: false, capped: true });
    expect(await merits.balanceOf(db, 'a')).toBe(1000);
  });

  test('admin_adjust is exempt from the emission cap', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 1000, reason: 'challenge_reward', at: AT });
    const res = await merits.award(db, { user: 'a', amount: 5000, reason: 'admin_adjust', at: AT });
    expect(res.ok).toBe(true);
    expect(await merits.balanceOf(db, 'a')).toBe(6000);
  });
});

describe('arena_merits.spend (debit / I4)', () => {
  test('debits when the balance is sufficient and blocks when not', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 1000, reason: 'challenge_reward', at: AT });
    const ok = await merits.spend(db, { user: 'a', amount: 300, ref: 'sh1', at: AT });
    expect(ok.ok).toBe(true);
    expect(ok.entry.delta).toBe(-300);
    expect(await merits.balanceOf(db, 'a')).toBe(700);

    const no = await merits.spend(db, { user: 'a', amount: 2000, at: AT });
    expect(no).toMatchObject({ ok: false });
    expect(no.reason).toMatch(/insufficient/);
  });

  test('I4 — the module exports no transfer path (Merits are non-transferable)', () => {
    const keys = Object.keys(merits);
    expect(keys.some((k) => /transfer|send|gift|trade/i.test(k))).toBe(false);
    expect(merits.CREDIT_REASONS).not.toEqual(expect.arrayContaining(['transfer_in', 'deposit', 'purchase']));
  });
});

describe('arena_merits shop (I5)', () => {
  test('I5 — refuses a random/loot-box item at creation', async () => {
    const db = createMockDb();
    const res = await merits.addShopItem(db, { id: 'crate', kind: 'fixed_bundle', cost_merits: 100, random: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/I5/);
  });

  test('adds a fixed-content item (random hard-set false) and rejects an unknown kind', async () => {
    const db = createMockDb();
    const good = await merits.addShopItem(db, { id: 'skin', kind: 'cosmetic', cost_merits: 200 });
    expect(good).toMatchObject({ ok: true });
    expect(good.item.random).toBe(false);
    expect((await merits.addShopItem(db, { id: 'x', kind: 'lootbox', cost_merits: 1 })).ok).toBe(false);
  });

  test('purchase spends merits, decrements stock, records the purchase', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 500, reason: 'challenge_reward', at: AT });
    await merits.addShopItem(db, { id: 'boost1', kind: 'boost', cost_merits: 100, stock: 1 });

    const res = await merits.purchase(db, { user: 'a', itemId: 'boost1', at: AT });
    expect(res.ok).toBe(true);
    expect(await merits.balanceOf(db, 'a')).toBe(400);
    expect((await db.collection('rewards_shop').findOne({ id: 'boost1' })).stock).toBe(0);
    expect(await db.collection('merits_purchases').find({ user: 'a' }).toArray()).toHaveLength(1);

    const soldOut = await merits.purchase(db, { user: 'a', itemId: 'boost1', at: AT });
    expect(soldOut).toMatchObject({ ok: false });
  });

  test('purchase fails on insufficient merits and leaves stock untouched', async () => {
    const db = createMockDb();
    await merits.addShopItem(db, { id: 'pricey', kind: 'cosmetic', cost_merits: 999, stock: 5 });
    const res = await merits.purchase(db, { user: 'broke', itemId: 'pricey', at: AT });
    expect(res.ok).toBe(false);
    expect((await db.collection('rewards_shop').findOne({ id: 'pricey' })).stock).toBe(5);
  });

  test('ensureMeritsIndexes declares a unique index on shop id', async () => {
    const calls = { rewards_shop: [], merits_ledger: [] };
    const db = { collection: (name) => ({ createIndex: (spec, opts) => { calls[name].push({ spec, opts }); return Promise.resolve(); } }) };
    await merits.ensureMeritsIndexes(db);
    expect(calls.rewards_shop).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { id: 1 }, opts: { unique: true } })]));
  });
});
