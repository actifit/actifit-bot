/**
 * Challenge Engine F2 verification service (Trello #176) — unit tests.
 *
 * Pure core (computeWindowScore / flagAnomalies / metricValue) tested directly;
 * the DB-touching paths (fetchVerifiedActivity / verifyChallenge) run against the
 * shared in-memory mock seeded with verified_posts + challenge + participants.
 */

const { createMockDb } = require('./helpers/mock-db');
const verify = require('../arena_verify');

const post = (author, dateISO, step_count, permlink = 'p') => ({
  author,
  permlink: `${permlink}-${dateISO}`,
  date: new Date(dateISO),
  json_metadata: { step_count },
});

const WINDOW = { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' };

describe('arena_verify.metricValue', () => {
  test('defaults to step_count for activity/steps', () => {
    expect(verify.metricValue({ step_count: 5000 }, 'activity_count')).toBe(5000);
    expect(verify.metricValue({ step_count: 5000 }, 'steps')).toBe(5000);
  });
  test('goal_hit is 1 when there is any activity, else 0', () => {
    expect(verify.metricValue({ step_count: 1 }, 'goal_hit')).toBe(1);
    expect(verify.metricValue({ step_count: 0 }, 'goal_hit')).toBe(0);
  });
  test('workout_minutes reads its own field', () => {
    expect(verify.metricValue({ workout_minutes: 30 }, 'workout_minutes')).toBe(30);
  });
});

describe('arena_verify.computeWindowScore', () => {
  test('sums per day (multiple posts a day aggregate), reports days + best_day', () => {
    const records = [
      { date: '2026-08-10T01:00:00Z', step_count: 5000 },
      { date: '2026-08-10T20:00:00Z', step_count: 1000 }, // same UTC day
      { date: '2026-08-11T10:00:00Z', step_count: 6000 },
      { date: '2026-08-12T10:00:00Z', step_count: 7000 },
    ];
    const s = verify.computeWindowScore(records, { metric: 'activity_count' });
    expect(s.total).toBe(19000);
    expect(s.days).toBe(3);
    expect(s.best_day).toBe(7000);
    expect(s.per_day[0]).toEqual({ day: '2026-08-10', value: 6000 });
  });

  test('empty records → zeroed score', () => {
    expect(verify.computeWindowScore([], { metric: 'steps' })).toMatchObject({ total: 0, days: 0, best_day: 0 });
  });
});

describe('arena_verify.flagAnomalies', () => {
  const scoreOf = (records) => verify.computeWindowScore(records, { metric: 'activity_count' });

  test('clean, steady activity produces no flags', () => {
    const s = scoreOf([
      { date: '2026-08-10T10:00:00Z', step_count: 5000 },
      { date: '2026-08-11T10:00:00Z', step_count: 6000 },
      { date: '2026-08-12T10:00:00Z', step_count: 7000 },
    ]);
    expect(verify.flagAnomalies(s)).toEqual([]);
  });

  test('an implausible single day is flagged', () => {
    const s = scoreOf([
      { date: '2026-08-10T10:00:00Z', step_count: 5000 },
      { date: '2026-08-11T10:00:00Z', step_count: 6000 },
      { date: '2026-08-12T10:00:00Z', step_count: 300000 },
    ]);
    const flags = verify.flagAnomalies(s);
    expect(flags.some((f) => f.type === 'implausible_daily' && f.value === 300000)).toBe(true);
  });

  test('a spike vs the participant own median is flagged', () => {
    const s = scoreOf([
      { date: '2026-08-10T10:00:00Z', step_count: 4000 },
      { date: '2026-08-11T10:00:00Z', step_count: 5000 },
      { date: '2026-08-12T10:00:00Z', step_count: 6000 },
      { date: '2026-08-13T10:00:00Z', step_count: 90000 }, // > 5× median(5000)
    ]);
    expect(verify.flagAnomalies(s).some((f) => f.type === 'spike')).toBe(true);
  });
});

describe('arena_verify.fetchVerifiedActivity', () => {
  test('filters by author + window and extracts step_count', async () => {
    const db = createMockDb();
    db.collection('verified_posts').__seed([
      post('alice', '2026-08-10T10:00:00Z', 5000),
      post('alice', '2026-07-01T10:00:00Z', 9999), // before window
      post('bob', '2026-08-10T10:00:00Z', 4000),
    ]);
    const recs = await verify.fetchVerifiedActivity(db, 'alice', WINDOW);
    expect(recs).toHaveLength(1);
    expect(recs[0].step_count).toBe(5000);
  });
});

describe('arena_verify.verifyChallenge', () => {
  const seed = (db) => {
    db.collection('challenges').__seed([
      { id: 'ch_v', window: WINDOW, scoring: { metric: 'activity_count', rule: 'max' } },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch_v', entity: 'alice', flags: [] },
      { challenge_id: 'ch_v', entity: 'bob', flags: [] },
    ]);
    db.collection('verified_posts').__seed([
      post('alice', '2026-08-10T10:00:00Z', 5000),
      post('alice', '2026-08-11T10:00:00Z', 6000),
      post('alice', '2026-08-12T10:00:00Z', 7000),
      post('bob', '2026-08-10T10:00:00Z', 5000),
      post('bob', '2026-08-11T10:00:00Z', 6000),
      post('bob', '2026-08-12T10:00:00Z', 300000), // implausible
    ]);
  };

  test('materializes verified scores and flags a cheater for review', async () => {
    const db = createMockDb();
    seed(db);
    const res = await verify.verifyChallenge(db, 'ch_v', { asOf: '2026-09-01T00:00:00Z' });
    expect(res).toMatchObject({ ok: true, participants: 2, flagged: 1 });

    const alice = await db.collection('challenge_participants').findOne({ entity: 'alice' });
    expect(alice.score).toMatchObject({ verified: 18000, days: 3, source: 'verified_posts', as_of: '2026-09-01T00:00:00Z' });
    expect(alice.flags).toEqual([]);

    const bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.score.verified).toBe(311000);
    expect(bob.flags).toContain('anticheat_review');
    expect(bob.anomalies.some((f) => f.type === 'implausible_daily')).toBe(true);
  });

  test('is idempotent — re-running does not duplicate the anticheat flag', async () => {
    const db = createMockDb();
    seed(db);
    await verify.verifyChallenge(db, 'ch_v');
    await verify.verifyChallenge(db, 'ch_v');
    const bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.flags.filter((f) => f === 'anticheat_review')).toHaveLength(1);
  });

  test('a later correction clears a stale anticheat flag on re-run', async () => {
    const db = createMockDb();
    seed(db);
    await verify.verifyChallenge(db, 'ch_v'); // bob flagged

    // Correction: the implausible post is revoked (removed from verified_posts).
    db.collection('verified_posts').deleteOne({ author: 'bob', permlink: 'p-2026-08-12T10:00:00Z' });
    await verify.verifyChallenge(db, 'ch_v');

    const bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.flags).not.toContain('anticheat_review');
    expect(bob.score.verified).toBe(11000);
  });

  test('unknown challenge is rejected', async () => {
    const res = await verify.verifyChallenge(createMockDb(), 'nope');
    expect(res.ok).toBe(false);
  });
});

// Fixes from the 2-agent review of PR #52.
describe('arena_verify — review hardening', () => {
  test('fetchVerifiedActivity FAILS CLOSED on a missing/partial window', async () => {
    await expect(verify.fetchVerifiedActivity(createMockDb(), 'alice', null)).rejects.toThrow(/window/);
    await expect(verify.fetchVerifiedActivity(createMockDb(), 'alice', { start: WINDOW.start })).rejects.toThrow(/window/);
    await expect(verify.fetchVerifiedActivity(createMockDb(), 'alice', { end: WINDOW.end })).rejects.toThrow(/window/);
  });

  test('verifyChallenge rejects a windowless challenge and writes nothing', async () => {
    const db = createMockDb();
    db.collection('challenges').__seed([{ id: 'ch_nowin', scoring: { metric: 'activity_count' } }]);
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch_nowin', entity: 'alice', flags: [] }]);
    const res = await verify.verifyChallenge(db, 'ch_nowin');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/window/);
    expect((await db.collection('challenge_participants').findOne({ entity: 'alice' })).score).toBeUndefined();
  });

  test('goal_hit aggregates to 0/1 per day, not per post', () => {
    const s = verify.computeWindowScore([
      { date: '2026-08-10T01:00:00Z', step_count: 5000 },
      { date: '2026-08-10T20:00:00Z', step_count: 1000 }, // 2nd post same day
      { date: '2026-08-11T10:00:00Z', step_count: 6000 },
    ], { metric: 'goal_hit' });
    expect(s.per_day.find((d) => d.day === '2026-08-10').value).toBe(1);
    expect(s.total).toBe(2); // two days hit, not three posts
    expect(s.best_day).toBe(1);
  });

  test('a short-window (2-day) extreme jump is flagged by day_ratio', () => {
    const s = verify.computeWindowScore([
      { date: '2026-08-10T10:00:00Z', step_count: 1000 },
      { date: '2026-08-11T10:00:00Z', step_count: 199000 },
    ], { metric: 'activity_count' });
    expect(verify.flagAnomalies(s).some((f) => f.type === 'day_ratio')).toBe(true);
  });

  test('a modest 2-day ratio is not flagged', () => {
    const s = verify.computeWindowScore([
      { date: '2026-08-10T10:00:00Z', step_count: 3000 },
      { date: '2026-08-11T10:00:00Z', step_count: 9000 },
    ], { metric: 'activity_count' });
    expect(verify.flagAnomalies(s)).toEqual([]);
  });

  test('verifyParticipant returns the score shape and writes nothing to the DB', async () => {
    const db = createMockDb();
    db.collection('verified_posts').__seed([post('alice', '2026-08-10T10:00:00Z', 5000)]);
    const v = await verify.verifyParticipant(db, { window: WINDOW, scoring: { metric: 'activity_count' } }, { entity: 'alice' });
    expect(v).toMatchObject({ verified: 5000, raw: 5000, days: 1, best_day: 5000, metric: 'activity_count', source: 'verified_posts' });
    expect(v.anomalies).toEqual([]);
    expect(await db.collection('challenge_participants').find({}).toArray()).toHaveLength(0);
  });

  test('a participant with no verified posts scores zero and is not flagged', async () => {
    const db = createMockDb();
    db.collection('challenges').__seed([{ id: 'ch_z', window: WINDOW, scoring: { metric: 'activity_count' } }]);
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch_z', entity: 'ghost', flags: [] }]);
    const res = await verify.verifyChallenge(db, 'ch_z');
    expect(res).toMatchObject({ ok: true, participants: 1, flagged: 0 });
    const p = await db.collection('challenge_participants').findOne({ entity: 'ghost' });
    expect(p.score).toMatchObject({ verified: 0, days: 0, best_day: 0 });
    expect(p.flags).toEqual([]);
  });

  test('flag merge preserves an unrelated pre-existing flag; persists best_day + metric', async () => {
    const db = createMockDb();
    db.collection('challenges').__seed([{ id: 'ch_f', window: WINDOW, scoring: { metric: 'activity_count' } }]);
    db.collection('challenge_participants').__seed([{ challenge_id: 'ch_f', entity: 'bob', flags: ['vip'] }]);
    db.collection('verified_posts').__seed([
      post('bob', '2026-08-10T10:00:00Z', 5000),
      post('bob', '2026-08-11T10:00:00Z', 6000),
      post('bob', '2026-08-12T10:00:00Z', 300000),
    ]);
    await verify.verifyChallenge(db, 'ch_f');
    let bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.flags).toEqual(expect.arrayContaining(['vip', 'anticheat_review']));
    expect(bob.score.best_day).toBe(300000);
    expect(bob.score.metric).toBe('activity_count');

    db.collection('verified_posts').deleteOne({ author: 'bob', permlink: 'p-2026-08-12T10:00:00Z' });
    await verify.verifyChallenge(db, 'ch_f');
    bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.flags).toContain('vip');
    expect(bob.flags).not.toContain('anticheat_review');
  });

  test('verifyChallenge scopes writes to its own challenge_id', async () => {
    const db = createMockDb();
    db.collection('challenges').__seed([
      { id: 'ch_a', window: WINDOW, scoring: { metric: 'activity_count' } },
      { id: 'ch_b', window: WINDOW, scoring: { metric: 'activity_count' } },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch_a', entity: 'alice', flags: [] },
      { challenge_id: 'ch_b', entity: 'alice', flags: [] },
    ]);
    db.collection('verified_posts').__seed([post('alice', '2026-08-10T10:00:00Z', 5000)]);
    await verify.verifyChallenge(db, 'ch_a');
    expect((await db.collection('challenge_participants').findOne({ challenge_id: 'ch_a', entity: 'alice' })).score.verified).toBe(5000);
    expect((await db.collection('challenge_participants').findOne({ challenge_id: 'ch_b', entity: 'alice' })).score).toBeUndefined();
  });
});
