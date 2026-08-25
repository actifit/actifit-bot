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
