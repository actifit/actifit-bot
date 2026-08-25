/**
 * Challenge Engine F3 aggregation/standings (Trello #177) — unit tests.
 *
 * Pure core (rankRows / fixturePoints / computeStandings) tested directly;
 * buildStandings runs against the shared mock DB seeded with participant scores.
 */

const { createMockDb } = require('./helpers/mock-db');
const standings = require('../arena_standings');

describe('arena_standings.rankRows', () => {
  test('ranks desc by key and stamps promote/hold/relegate', () => {
    const r = standings.rankRows(
      [{ entity: 'a', score: 100 }, { entity: 'b', score: 300 }, { entity: 'c', score: 200 }],
      { key: 'score', promotion: { up: 1, down: 1 } }
    );
    expect(r.map((x) => x.entity)).toEqual(['b', 'c', 'a']);
    expect(r[0]).toMatchObject({ rank: 1, movement: 'promote' });
    expect(r[1].movement).toBe('hold');
    expect(r[2]).toMatchObject({ rank: 3, movement: 'relegate' });
  });

  test('breaks ties deterministically by entity and assigns distinct ranks', () => {
    const r = standings.rankRows([{ entity: 'z', score: 100 }, { entity: 'a', score: 100 }], { key: 'score' });
    expect(r.map((x) => x.entity)).toEqual(['a', 'z']);
    expect(r.map((x) => x.rank)).toEqual([1, 2]);
    expect(r.every((x) => x.movement === 'hold')).toBe(true);
  });
});

describe('arena_standings.fixturePoints (POLIAC head-to-head)', () => {
  test('accumulates W/D/L and 3/1/0 points across fixtures', () => {
    const table = standings.fixturePoints([
      { a: { entity: 'a', score: 5000 }, b: { entity: 'b', score: 3000 } }, // a wins
      { a: { entity: 'a', score: 4000 }, b: { entity: 'c', score: 4000 } }, // a/c draw
    ]);
    const by = Object.fromEntries(table.map((x) => [x.entity, x]));
    expect(by.a).toMatchObject({ played: 2, won: 1, drawn: 1, lost: 0, points: 4, score: 9000 });
    expect(by.b).toMatchObject({ played: 1, won: 0, lost: 1, points: 0 });
    expect(by.c).toMatchObject({ played: 1, drawn: 1, points: 1 });
  });

  test('skips malformed fixtures', () => {
    expect(standings.fixturePoints([null, { a: { entity: 'a', score: 1 } }])).toEqual([]);
  });
});

describe('arena_standings.computeStandings', () => {
  test('score mode ranks by summed score', () => {
    const s = standings.computeStandings([{ entity: 'a', score: 100 }, { entity: 'b', score: 300 }], { mode: 'score' });
    expect(s[0]).toMatchObject({ entity: 'b', rank: 1 });
  });

  test('head_to_head mode ranks by fixture points', () => {
    const s = standings.computeStandings([
      { a: { entity: 'a', score: 5000 }, b: { entity: 'b', score: 3000 } },
      { a: { entity: 'b', score: 6000 }, b: { entity: 'c', score: 1000 } },
    ], { mode: 'head_to_head' });
    // a: 3pts/score 5000, b: 3pts/score 9000 — tie on points, b wins the SCORE tiebreak
    expect(s[0]).toMatchObject({ entity: 'b', points: 3, rank: 1 });
    expect(s.find((x) => x.entity === 'c').points).toBe(0);
  });
});

// Fixes from the 2-agent review of PR #53.
describe('arena_standings — review hardening', () => {
  test('rankRows: overlapping promote/relegate zones — promote wins, no double movement', () => {
    const r = standings.rankRows([{ entity: 'a', score: 10 }, { entity: 'b', score: 20 }], { key: 'score', promotion: { up: 2, down: 2 } });
    expect(r.every((x) => x.movement === 'promote')).toBe(true);
  });

  test('score mode emits a `points` field mirroring score (uniform §3.3 row shape)', () => {
    const s = standings.computeStandings([{ entity: 'a', score: 100 }], { mode: 'score' });
    expect(s[0]).toMatchObject({ entity: 'a', score: 100, points: 100 });
  });

  test('fixturePoints skips a self-fixture', () => {
    expect(standings.fixturePoints([{ a: { entity: 'x', score: 5 }, b: { entity: 'x', score: 5 } }])).toEqual([]);
  });

  test('standingsId separates programs and is stable', () => {
    const poliac = standings.standingsId('season', { kind: 'season', index: 1, program: 'poliac' }, 'gold');
    const squads = standings.standingsId('season', { kind: 'season', index: 1, program: 'squads' }, 'gold');
    expect(poliac).not.toBe(squads);
    expect(poliac).toBe(standings.standingsId('season', { kind: 'season', index: 1, program: 'poliac' }, 'gold'));
  });

  test('buildStandings: a hold in ANY leg excludes the whole entity', async () => {
    const db = createMockDb();
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'a', cohort: 'g', score: { verified: 18000 }, flags: [] },
      { challenge_id: 'ch2', entity: 'a', cohort: 'g', score: { verified: 5000 }, flags: ['anticheat_review'] },
      { challenge_id: 'ch1', entity: 'b', cohort: 'g', score: { verified: 12000 }, flags: [] },
    ]);
    const res = await standings.buildStandings(db, { challengeIds: ['ch1', 'ch2'], cohort: 'g' });
    expect(res).toMatchObject({ ok: true, ranked: 1, held: 1 });
    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.rows.map((r) => r.entity)).toEqual(['b']); // a excluded despite a clean leg
  });

  test('buildStandings: a participant with no score field defaults to 0', async () => {
    const db = createMockDb();
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch1', entity: 'x', cohort: 'g', flags: [] }]);
    const res = await standings.buildStandings(db, { challengeIds: ['ch1'], cohort: 'g' });
    expect(res.ranked).toBe(1);
    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.rows[0]).toMatchObject({ entity: 'x', score: 0 });
  });

  test('buildStandings: a cohort with no participants writes an empty standings doc', async () => {
    const db = createMockDb();
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch1', entity: 'a', cohort: 'g', score: { verified: 1 }, flags: [] }]);
    const res = await standings.buildStandings(db, { challengeIds: ['ch1'], cohort: 'nope' });
    expect(res).toMatchObject({ ok: true, ranked: 0 });
    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.rows).toEqual([]);
  });

  test('buildStandings: computed_at defaults to an ISO timestamp when asOf is omitted', async () => {
    const db = createMockDb();
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch1', entity: 'a', cohort: 'g', score: { verified: 1 }, flags: [] }]);
    const res = await standings.buildStandings(db, { challengeIds: ['ch1'], cohort: 'g' });
    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('ensureStandingsIndexes declares a unique index on id', async () => {
    const calls = [];
    const db = { collection: () => ({ createIndex: (spec, opts) => { calls.push({ spec, opts }); return Promise.resolve(); } }) };
    await standings.ensureStandingsIndexes(db);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { id: 1 }, opts: { unique: true } })]));
  });
});

describe('arena_standings.isHeld', () => {
  test('true only when anticheat_review is present', () => {
    expect(standings.isHeld({ flags: ['anticheat_review'] })).toBe(true);
    expect(standings.isHeld({ flags: ['vip'] })).toBe(false);
    expect(standings.isHeld({})).toBe(false);
  });
});

describe('arena_standings.buildStandings', () => {
  let db;
  beforeEach(() => {
    db = createMockDb();
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'a', cohort: 'gold', score: { verified: 18000 }, flags: [] },
      { challenge_id: 'ch1', entity: 'b', cohort: 'gold', score: { verified: 12000 }, flags: [] },
      { challenge_id: 'ch1', entity: 'c', cohort: 'gold', score: { verified: 30000 }, flags: ['anticheat_review'] },
      { challenge_id: 'ch2', entity: 'a', cohort: 'gold', score: { verified: 5000 }, flags: [] },
      { challenge_id: 'ch1', entity: 'd', cohort: 'silver', score: { verified: 9000 }, flags: [] },
    ]);
  });

  test('aggregates verified scores across challenges, excludes held, ranks + movement', async () => {
    const res = await standings.buildStandings(db, {
      challengeIds: ['ch1', 'ch2'], scope: 'season', window: { kind: 'season', index: 1 }, cohort: 'gold', promotion: { up: 1, down: 1 }, asOf: '2026-09-01T00:00:00Z',
    });
    expect(res).toMatchObject({ ok: true, ranked: 2, held: 1 });

    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.rows.map((r) => r.entity)).toEqual(['a', 'b']); // a=23000 > b=12000; c held-out; d other cohort
    expect(doc.rows[0]).toMatchObject({ entity: 'a', score: 23000, rank: 1, movement: 'promote' });
    expect(doc.rows[1]).toMatchObject({ entity: 'b', movement: 'relegate' });
    expect(doc.computed_at).toBe('2026-09-01T00:00:00Z');
  });

  test('includeHeld:true keeps a flagged participant in the table', async () => {
    const res = await standings.buildStandings(db, { challengeIds: ['ch1', 'ch2'], cohort: 'gold', includeHeld: true });
    expect(res.ranked).toBe(3);
    const doc = await db.collection('standings').findOne({ id: res.id });
    expect(doc.rows[0].entity).toBe('c'); // 30000, now included, tops the table
  });

  test('is idempotent — re-running replaces the one standings doc', async () => {
    const p = { challengeIds: ['ch1', 'ch2'], scope: 'season', window: { kind: 'season', index: 1 }, cohort: 'gold' };
    await standings.buildStandings(db, p);
    await standings.buildStandings(db, p);
    const all = await db.collection('standings').find({}).toArray();
    expect(all).toHaveLength(1);
  });

  test('rejects an empty challenge set', async () => {
    expect((await standings.buildStandings(db, {})).ok).toBe(false);
  });
});
