/**
 * Challenge Engine — house-rule COMPLIANCE conformance suite (Trello #178, §10).
 *
 * Asserts the anti-gambling invariants I1–I7 against the real modules, in one
 * place, so no future challenge type or shop item can regress them. Invariants
 * that live in a not-yet-built phase are marked as pending with the phase noted.
 */

const { createMockDb } = require('./helpers/mock-db');
const arena = require('../arena');
const merits = require('../arena_merits');
const pools = require('../arena_pools');

const AT = '2026-08-25T10:00:00Z';
const validCreate = (over = {}) => ({
  op: 'challenge_create', v: 1, id: 'ch_1', type: 'duel',
  window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
  entry: { mode: 'free' }, scoring: { metric: 'activity_count', rule: 'head_to_head' },
  ...over,
});

describe('Compliance — house-rule invariants I1–I7', () => {
  test('I1 — no fee/stake entry (challenge create)', () => {
    expect(arena.validateArenaOp(validCreate({ entry: { mode: 'fee' } })).valid).toBe(false);
    expect(arena.validateArenaOp(validCreate({ entry: { mode: 'free', fee: 100 } })).valid).toBe(false);
    expect(arena.validateArenaOp(validCreate({ entry: { mode: 'free', gate: { fee: 50 } } })).valid).toBe(false);
    expect(arena.validateArenaOp(validCreate()).valid).toBe(true);
  });

  test('I3 — Merits have no buy/deposit credit path (reason whitelist)', async () => {
    const db = createMockDb();
    for (const reason of ['purchase', 'deposit', 'buy']) {
      expect((await merits.award(db, { user: 'a', amount: 100, reason, at: AT })).ok).toBe(false);
    }
    expect(merits.CREDIT_REASONS).toEqual(['challenge_reward', 'season_chest', 'admin_adjust']);
  });

  test('I4 — Merits are non-transferable (no transfer export; admin_adjust is privileged)', async () => {
    // No transfer primitive exists...
    expect(Object.keys(merits).some((k) => /transfer|gift|send|trade/i.test(k))).toBe(false);
    // ...and the only value-moving reason (admin_adjust) is gated to an authorized
    // caller, so value cannot move between users without an operator.
    const db = createMockDb();
    expect((await merits.award(db, { user: 'a', amount: 100, reason: 'admin_adjust', at: AT })).ok).toBe(false);
    expect((await merits.award(db, { user: 'a', amount: 100, reason: 'admin_adjust', authorized: true, at: AT })).ok).toBe(true);
  });

  test('I5 — no random/loot-box shop item', async () => {
    const db = createMockDb();
    expect((await merits.addShopItem(db, { id: 'crate', kind: 'fixed_bundle', cost_merits: 100, random: true })).ok).toBe(false);
    // even a stored item that somehow carries random can't be purchased
    await db.collection('rewards_shop').insertOne({ id: 'bad', kind: 'cosmetic', cost_merits: 0, random: true });
    await merits.award(db, { user: 'a', amount: 10, reason: 'challenge_reward', at: AT });
    expect((await merits.purchase(db, { user: 'a', itemId: 'bad', at: AT })).ok).toBe(false);
    expect(merits.SHOP_KINDS).not.toEqual(expect.arrayContaining(['lootbox', 'crate', 'random']));
  });

  test('I6 — outcomes decided by verified effort/goal, never chance', () => {
    expect(arena.validateArenaOp(validCreate({ scoring: { metric: 'steps', rule: 'random' } })).valid).toBe(false);
    expect(arena.validateArenaOp(validCreate({ scoring: { metric: 'steps', rule: 'max' } })).valid).toBe(true);
    expect(arena.SCORING_RULES).toEqual(['max', 'threshold', 'head_to_head']);
  });

  test('I2 — reward pool funding is sponsor/DHF/treasury only (no participant stake)', async () => {
    const db = createMockDb();
    for (const funding of ['stake', 'entry_fee', 'participant', 'wager']) {
      expect((await pools.createPool(db, { id: 'p', funding, budget: 100 })).ok).toBe(false);
    }
    expect(pools.POOL_FUNDING).toEqual(['sponsor', 'dhf', 'treasury']);
    expect((await pools.createPool(db, { id: 'ok', funding: 'treasury', budget: 100 })).ok).toBe(true);
  });

  test('I7 — a pool funder cannot be a paid participant of a challenge it rewards', async () => {
    const db = createMockDb();
    await pools.createPool(db, { id: 'pool', funding: 'sponsor', sponsor: 'funderX', budget: 1000 });
    // funderX is enrolled AND finishes first — must still be excluded from payout.
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch', entity: 'funderX', flags: [] }]);
    const res = await pools.resolveChallenge(db, {
      challengeId: 'ch', poolId: 'pool',
      standings: [{ entity: 'funderX', rank: 1 }], prizes: [{ rank: 1, afit: 500 }], asOf: AT,
    });
    expect(res.excludedFunders).toEqual(['funderX']);
    expect(res.paidAfit).toBe(0);
  });
});
