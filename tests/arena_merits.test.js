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

  test('admin_adjust (authorized) is exempt from the emission cap', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 1000, reason: 'challenge_reward', at: AT });
    const res = await merits.award(db, { user: 'a', amount: 5000, reason: 'admin_adjust', authorized: true, at: AT });
    expect(res.ok).toBe(true);
    expect(await merits.balanceOf(db, 'a')).toBe(6000);
  });

  test('admin_adjust WITHOUT authorization is rejected (privileged path)', async () => {
    const db = createMockDb();
    const res = await merits.award(db, { user: 'a', amount: 5000, reason: 'admin_adjust', at: AT });
    expect(res).toMatchObject({ ok: false });
    expect(res.reason).toMatch(/authorization/);
    expect(await merits.balanceOf(db, 'a')).toBe(0);
  });

  test('reports requested/emitted/dropped when capped', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 800, reason: 'challenge_reward', at: AT });
    const res = await merits.award(db, { user: 'a', amount: 400, reason: 'challenge_reward', at: AT });
    expect(res).toMatchObject({ requested: 400, emitted: 200, dropped: 200 });
  });

  test('the emission cap resets on the next UTC day', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 1000, reason: 'challenge_reward', at: '2026-08-25T23:00:00Z' });
    const next = await merits.award(db, { user: 'a', amount: 1000, reason: 'challenge_reward', at: '2026-08-26T01:00:00Z' });
    expect(next.ok).toBe(true);
    expect(next.capped).toBeUndefined();
    expect(await merits.balanceOf(db, 'a')).toBe(2000);
  });

  test('ledger rows carry a stable led_ id and balance_after reconciles with balanceOf', async () => {
    const db = createMockDb();
    const r1 = await merits.award(db, { user: 'a', amount: 500, reason: 'challenge_reward', at: AT });
    const r2 = await merits.spend(db, { user: 'a', amount: 200, ref: 'sh', at: AT });
    const r3 = await merits.award(db, { user: 'a', amount: 100, reason: 'season_chest', at: AT });
    expect(r1.entry.id).toBe('led_a_0');
    expect([r1.entry.balance_after, r2.entry.balance_after, r3.entry.balance_after]).toEqual([500, 300, 400]);
    expect(r3.entry.balance_after).toBe(await merits.balanceOf(db, 'a'));
    expect(r1.entry.immutable).toBe(true);
  });

  test('rejects an invalid at timestamp', async () => {
    const db = createMockDb();
    expect((await merits.award(db, { user: 'a', amount: 10, reason: 'challenge_reward', at: 'not-a-date' })).ok).toBe(false);
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

  test('a free (0-cost) item is purchasable (no debit, still records + decrements)', async () => {
    const db = createMockDb();
    await merits.addShopItem(db, { id: 'freebie', kind: 'badge', cost_merits: 0, stock: 2 });
    const res = await merits.purchase(db, { user: 'a', itemId: 'freebie', at: AT });
    expect(res).toMatchObject({ ok: true, ledger: null });
    expect((await db.collection('rewards_shop').findOne({ id: 'freebie' })).stock).toBe(1);
    expect(await db.collection('merits_purchases').find({ user: 'a' }).toArray()).toHaveLength(1);
    expect(await merits.balanceOf(db, 'a')).toBe(0);
  });

  test('purchase of an unknown item fails cleanly', async () => {
    const db = createMockDb();
    expect((await merits.purchase(db, { user: 'a', itemId: 'nope', at: AT })).ok).toBe(false);
  });

  test('ensureMeritsIndexes declares shop id + ledger + balances indexes', async () => {
    const calls = { rewards_shop: [], merits_ledger: [], merits_balances: [] };
    const db = { collection: (name) => ({ createIndex: (spec, opts) => { calls[name].push({ spec, opts }); return Promise.resolve(); } }) };
    await merits.ensureMeritsIndexes(db);
    expect(calls.rewards_shop).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { id: 1 }, opts: { unique: true } })]));
    expect(calls.merits_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { user: 1, at: 1 } })]));
    expect(calls.merits_balances).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { user: 1 }, opts: { unique: true } })]));
  });
});

describe('arena_merits — atomicity (#178)', () => {
  test('an atomic guarded decrement prevents overdraw when two spends contend', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 100, reason: 'challenge_reward', at: AT });
    const [r1, r2] = await Promise.all([
      merits.spend(db, { user: 'a', amount: 100, at: AT }),
      merits.spend(db, { user: 'a', amount: 100, at: AT }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1); // exactly one succeeds
    expect(await merits.balanceOf(db, 'a')).toBe(0); // never negative
  });

  test('a stock:1 item cannot be oversold by two concurrent buyers', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 500, reason: 'challenge_reward', at: AT });
    await merits.award(db, { user: 'b', amount: 500, reason: 'challenge_reward', at: AT });
    await merits.addShopItem(db, { id: 'rare', kind: 'cosmetic', cost_merits: 10, stock: 1 });
    const [r1, r2] = await Promise.all([
      merits.purchase(db, { user: 'a', itemId: 'rare', at: AT }),
      merits.purchase(db, { user: 'b', itemId: 'rare', at: AT }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1); // only one buyer wins
    expect((await db.collection('rewards_shop').findOne({ id: 'rare' })).stock).toBe(0);
  });

  test('balanceOf reads the authoritative counter; ledger stays in lock-step', async () => {
    const db = createMockDb();
    await merits.award(db, { user: 'a', amount: 300, reason: 'challenge_reward', at: AT });
    await merits.spend(db, { user: 'a', amount: 120, at: AT });
    expect((await db.collection('merits_balances').findOne({ user: 'a' })).balance).toBe(180);
    expect(await merits.balanceOf(db, 'a')).toBe(180);
  });

  // Migration: users with ledger history but no counter doc (predating #178).
  test('award on a legacy user seeds the FULL prior balance, not just the new delta', async () => {
    const db = createMockDb();
    db.collection('merits_ledger').__seed([{ user: 'old', delta: 5000, reason: 'challenge_reward', at: '2026-08-20T10:00:00Z' }]);
    await merits.award(db, { user: 'old', amount: 100, reason: 'challenge_reward', at: AT });
    expect(await merits.balanceOf(db, 'old')).toBe(5100); // 5000 backfilled + 100
  });

  test('spend on a legacy user works (counter backfilled from the ledger)', async () => {
    const db = createMockDb();
    db.collection('merits_ledger').__seed([{ user: 'old', delta: 5000, reason: 'challenge_reward', at: '2026-08-20T10:00:00Z' }]);
    const r = await merits.spend(db, { user: 'old', amount: 300, at: AT });
    expect(r.ok).toBe(true);
    expect(await merits.balanceOf(db, 'old')).toBe(4700);
  });

  test('purchase refunds the stock reservation when the debit fails (stock:1)', async () => {
    const db = createMockDb();
    await merits.addShopItem(db, { id: 'one', kind: 'cosmetic', cost_merits: 100, stock: 1 });
    const broke = await merits.purchase(db, { user: 'broke', itemId: 'one', at: AT });
    expect(broke.ok).toBe(false);
    expect((await db.collection('rewards_shop').findOne({ id: 'one' })).stock).toBe(1); // reservation refunded
    await merits.award(db, { user: 'rich', amount: 500, reason: 'challenge_reward', at: AT });
    const rich = await merits.purchase(db, { user: 'rich', itemId: 'one', at: AT });
    expect(rich.ok).toBe(true);
    expect((await db.collection('rewards_shop').findOne({ id: 'one' })).stock).toBe(0);
  });
});
