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
      { id: 'ch1', type: 'duel', state: 'open', community: 'hive-1', visibility: 'public' },
      { id: 'ch2', type: 'liveops', state: 'settled', community: null, visibility: 'public' },
      { id: 'ch3', type: 'duel', state: 'open', visibility: 'private' },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'alice', flags: ['anticheat_review'], source: { trx_id: 't' } },
      { challenge_id: 'ch2', entity: 'bob', flags: [] },
    ]);
  };

  test('listChallenges filters by type/state and by entity; excludes non-public by default', async () => {
    const db = createMockDb();
    seed(db);
    expect((await api.listChallenges(db, { type: 'duel' })).map((c) => c.id)).toEqual(['ch1']); // ch3 private, excluded
    expect((await api.listChallenges(db, { state: 'settled' })).map((c) => c.id)).toEqual(['ch2']);
    expect((await api.listChallenges(db, { entity: 'alice' })).map((c) => c.id)).toEqual(['ch1']);
    expect((await api.listChallenges(db)).length).toBe(2); // only public
    expect((await api.listChallenges(db, { includeNonPublic: true })).length).toBe(3);
  });

  test('listChallenges ignores a Mongo-operator injection in a filter value', async () => {
    const db = createMockDb();
    seed(db);
    // {$ne:'duel'} would EXCLUDE the duel if it reached the query; sanitized, it's dropped.
    const rows = await api.listChallenges(db, { type: { $ne: 'duel' } });
    expect(rows.map((c) => c.id).sort()).toEqual(['ch1', 'ch2']);
  });

  test('getChallenge returns the challenge + participants with internal flags/source projected out', async () => {
    const db = createMockDb();
    seed(db);
    const got = await api.getChallenge(db, 'ch1');
    expect(got.challenge.id).toBe('ch1');
    expect(got.participants.map((p) => p.entity)).toEqual(['alice']);
    expect(got.participants[0].flags).toBeUndefined(); // anti-cheat state not leaked
    expect(got.participants[0].source).toBeUndefined();
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
    expect(m.ledger[0].delta).toBe(-30); // newest first
  });

  test('getBadges lists a user\'s earned badges across challenges, newest first, enriched', async () => {
    const db = createMockDb();
    db.collection('challenges').__seed([
      { id: 'cA', title: 'Step League', type: 'league_fixture', art: 'step-league', window: { end: '2026-08-20T00:00:00Z' } },
      { id: 'cB', title: 'Weekend Warrior', type: 'liveops', art: 'weekend-warrior', window: { end: '2026-08-25T00:00:00Z' } },
      { id: 'cC', type: 'duel', window: { end: '2026-08-10T00:00:00Z' } },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'cA', entity: 'alice', result: { rank: 1, reward: { afit: 100, badges: ['Champion'] } } },
      { challenge_id: 'cB', entity: 'alice', result: { rank: 2, reward: { afit: 40, badges: ['Weekend Hero', 'Streak'] } } },
      { challenge_id: 'cC', entity: 'alice', result: { rank: 5, reward: { afit: 0, badges: [] } } }, // no badge → excluded
      { challenge_id: 'cA', entity: 'bob', result: { rank: 2, reward: { badges: ['Runner-up'] } } }, // other user
    ]);
    db.collection('challenge_resolutions').__seed([
      { challenge_id: 'cA', at: '2026-08-20T01:00:00Z' },
      { challenge_id: 'cB', at: '2026-08-25T01:00:00Z' },
    ]);

    const r = await api.getBadges(db, 'alice');
    expect(r.user).toBe('alice');
    expect(r.count).toBe(3); // Champion + Weekend Hero + Streak (cC awards none)
    // newest first: cB (08-25) before cA (08-20); a multi-badge challenge expands
    expect(r.badges.map((b) => b.badge)).toEqual(['Weekend Hero', 'Streak', 'Champion']);
    expect(r.badges[0]).toMatchObject({ badge: 'Weekend Hero', challenge_id: 'cB', title: 'Weekend Warrior', art: 'weekend-warrior', type: 'liveops', rank: 2 });
    // never leaks another user's badge
    expect(r.badges.some((b) => b.badge === 'Runner-up')).toBe(false);
  });

  test('getBadges returns an empty list (not an error) for a user with no settled badges', async () => {
    const db = createMockDb();
    db.collection('challenge_participants').__seed([
      { challenge_id: 'cX', entity: 'carol', result: { rank: 3, reward: { afit: 10, badges: [] } } },
    ]);
    expect(await api.getBadges(db, 'carol')).toEqual({ user: 'carol', count: 0, badges: [] });
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

  test('emitEvent rejects a null event and oversized data; defaults at + null fields', async () => {
    const db = createMockDb();
    expect((await api.emitEvent(db, null)).ok).toBe(false);
    expect((await api.emitEvent(db, { type: 'chest_awarded', data: { blob: 'x'.repeat(5000) } })).ok).toBe(false);
    const res = await api.emitEvent(db, { type: 'promoted', user: 'a' });
    expect(res.ok).toBe(true);
    expect(res.event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.event.challenge_id).toBeNull();
  });

  test('ensureEventsIndexes declares the user+at index', async () => {
    const calls = [];
    const db = { collection: () => ({ createIndex: (spec) => { calls.push(spec); return Promise.resolve(); } }) };
    await api.ensureEventsIndexes(db);
    expect(calls).toEqual(expect.arrayContaining([{ user: 1, at: -1 }]));
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

  test('defaultContests map to the §7.5 engine types', () => {
    const byId = Object.fromEntries(api.defaultContests(NOW).map((c) => [c.id, c.type]));
    expect(byId).toMatchObject({
      def_weekly_step_league: 'league_fixture',
      def_daily_focus: 'daily_focus',
      def_season_ladder: 'league_fixture', // `season` is a wrapper, not a challenge type
      def_weekly_top_n: 'liveops',
      def_weekend_warrior: 'liveops',
      def_monthly_liveops: 'liveops',
    });
  });

  test('defaultContests windows are well-formed (start < end; daily=1d, weekend=2d)', () => {
    const day = 24 * 60 * 60 * 1000;
    const by = Object.fromEntries(api.defaultContests(NOW).map((c) => [c.id, c.window]));
    for (const w of Object.values(by)) expect(Date.parse(w.start)).toBeLessThan(Date.parse(w.end));
    expect(Date.parse(by.def_daily_focus.end) - Date.parse(by.def_daily_focus.start)).toBe(day);
    expect(Date.parse(by.def_weekend_warrior.end) - Date.parse(by.def_weekend_warrior.start)).toBe(2 * day);
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
