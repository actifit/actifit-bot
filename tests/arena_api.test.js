/**
 * Challenge Engine F6 read API + notifications + default seeding (Trello #180).
 */

const { createMockDb } = require('./helpers/mock-db');
const api = require('../arena_api');
const arena = require('../arena');

const NOW = 1756000000000; // fixed epoch ms (deterministic windows)
const AT = '2026-08-26T10:00:00Z';

describe('arena_api read models', () => {
  const seed = (db) => {
    db.collection('challenges').__seed([
      { id: 'ch1', type: 'duel', state: 'open', community: 'hive-1' },
      { id: 'ch2', type: 'liveops', state: 'settled', community: null },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'alice', flags: [] },
      { challenge_id: 'ch2', entity: 'bob', flags: [] },
    ]);
  };

  test('listChallenges filters by type/state and by entity', async () => {
    const db = createMockDb();
    seed(db);
    expect((await api.listChallenges(db, { type: 'duel' })).map((c) => c.id)).toEqual(['ch1']);
    expect((await api.listChallenges(db, { state: 'settled' })).map((c) => c.id)).toEqual(['ch2']);
    expect((await api.listChallenges(db, { entity: 'alice' })).map((c) => c.id)).toEqual(['ch1']);
    expect((await api.listChallenges(db)).length).toBe(2);
  });

  test('getChallenge returns the challenge + its participants, or null', async () => {
    const db = createMockDb();
    seed(db);
    const got = await api.getChallenge(db, 'ch1');
    expect(got.challenge.id).toBe('ch1');
    expect(got.participants.map((p) => p.entity)).toEqual(['alice']);
    expect(await api.getChallenge(db, 'nope')).toBeNull();
  });

  test('getStandings resolves by id and by scope', async () => {
    const db = createMockDb();
    db.collection('standings').__seed([
      { id: 'std_a', scope: 'season', cohort: 'gold', rows: [] },
      { id: 'std_b', scope: 'league', cohort: 'silver', rows: [] },
    ]);
    expect((await api.getStandings(db, { id: 'std_a' })).cohort).toBe('gold');
    expect((await api.getStandings(db, { scope: 'league' })).map((s) => s.id)).toEqual(['std_b']);
  });

  test('getMerits returns balance + a ledger page', async () => {
    const db = createMockDb();
    db.collection('merits_ledger').__seed([
      { user: 'alice', delta: 100, at: '2026-08-26T01:00:00Z' },
      { user: 'alice', delta: -30, at: '2026-08-26T02:00:00Z' },
      { user: 'bob', delta: 5, at: '2026-08-26T01:00:00Z' },
    ]);
    const m = await api.getMerits(db, 'alice');
    expect(m.balance).toBe(70);
    expect(m.ledger).toHaveLength(2);
  });

  test('getShop lists items and can filter to in-stock', async () => {
    const db = createMockDb();
    db.collection('rewards_shop').__seed([
      { id: 's1', stock: 'unlimited' },
      { id: 's2', stock: 0 },
      { id: 's3', stock: 3 },
    ]);
    expect((await api.getShop(db)).length).toBe(3);
    expect((await api.getShop(db, { inStockOnly: true })).map((i) => i.id).sort()).toEqual(['s1', 's3']);
  });

  test('getPool returns a pool status', async () => {
    const db = createMockDb();
    db.collection('pools').__seed([{ id: 'p1', budget: 1000, paid: 100 }]);
    expect((await api.getPool(db, 'p1')).paid).toBe(100);
  });
});

describe('arena_api notifications', () => {
  test('emitEvent records a known type and rejects an unknown one', async () => {
    const db = createMockDb();
    expect((await api.emitEvent(db, { type: 'results_settled', user: 'a', challenge_id: 'ch1', at: AT })).ok).toBe(true);
    expect((await api.emitEvent(db, { type: 'bogus', user: 'a' })).ok).toBe(false);
    expect(await db.collection('arena_events').find({ user: 'a' }).toArray()).toHaveLength(1);
  });

  test('listEvents returns a user feed newest-first', async () => {
    const db = createMockDb();
    await api.emitEvent(db, { type: 'challenge_opening', user: 'a', at: '2026-08-26T01:00:00Z' });
    await api.emitEvent(db, { type: 'chest_awarded', user: 'a', at: '2026-08-26T03:00:00Z' });
    await api.emitEvent(db, { type: 'fixture_today', user: 'b', at: '2026-08-26T02:00:00Z' });
    const feed = await api.listEvents(db, 'a');
    expect(feed.map((e) => e.type)).toEqual(['chest_awarded', 'challenge_opening']);
  });
});

describe('arena_api default contests (§7.5)', () => {
  test('defaultContests are 6, include Weekend Warrior, and all validate (I1/I6 clean)', () => {
    const set = api.defaultContests(NOW);
    expect(set).toHaveLength(6);
    expect(set.map((c) => c.title)).toContain('Weekend Warrior');
    for (const body of set) {
      expect(body.origin_tier).toBe('official');
      expect(body.entry).toEqual({ mode: 'free' });
      expect(arena.validateArenaOp(body).valid).toBe(true);
    }
  });

  test('seedDefaultContests creates the 6 challenges and is idempotent', async () => {
    const db = createMockDb();
    const res = await api.seedDefaultContests(db, { officialAccount: 'actifit', nowMs: NOW, at: AT });
    expect(res.seeded).toBe(6);
    expect(await db.collection('challenges').find({}).toArray()).toHaveLength(6);
    const ww = await db.collection('challenges').findOne({ id: 'def_weekend_warrior' });
    expect(ww).toMatchObject({ state: 'open', origin_tier: 'official', title: 'Weekend Warrior' });

    // Re-seed: idempotent (same trx_ids) → no new challenges.
    const again = await api.seedDefaultContests(db, { officialAccount: 'actifit', nowMs: NOW, at: AT });
    expect(again.seeded).toBe(0);
    expect(await db.collection('challenges').find({}).toArray()).toHaveLength(6);
  });

  test('seedDefaultContests requires nowMs', async () => {
    expect((await api.seedDefaultContests(createMockDb(), {})).ok).toBe(false);
  });
});
