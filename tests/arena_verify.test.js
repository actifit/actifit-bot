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

  test('goal_hit enforces the daily THRESHOLD on the day total (anti-farm)', () => {
    const s = verify.computeWindowScore([
      { date: '2026-08-10T01:00:00Z', step_count: 4000 },
      { date: '2026-08-10T20:00:00Z', step_count: 7000 }, // day total 11000 >= 10000 → hit
      { date: '2026-08-11T10:00:00Z', step_count: 1 },    // 1 step → NOT a hit
      { date: '2026-08-12T10:00:00Z', step_count: 9999 }, // just under → NOT a hit
    ], { metric: 'goal_hit', rule: 'threshold', threshold: 10000 });
    expect(s.per_day.find((d) => d.day === '2026-08-10').value).toBe(1);
    expect(s.per_day.find((d) => d.day === '2026-08-11').value).toBe(0);
    expect(s.per_day.find((d) => d.day === '2026-08-12').value).toBe(0);
    expect(s.total).toBe(1); // only the 10k+ day counts
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

// ---------------------------------------------------------------------------
// Trello #186 (epic #184, Movement Challenges Phase A): the non-step
// `routine_completion` source — honor-system daily check-ins.
// ---------------------------------------------------------------------------

const completion = (challenge_id, entity, atISO) => ({
  challenge_id, entity, day: atISO.slice(0, 10), at: new Date(atISO),
});

describe('arena_verify — routine_completion metric (#186)', () => {
  test('is the only self-reported metric; step metrics are not', () => {
    expect(verify.isSelfReportedMetric('routine_completion')).toBe(true);
    for (const m of ['activity_count', 'steps', 'goal_hit', 'workout_minutes', undefined]) {
      expect(verify.isSelfReportedMetric(m)).toBe(false);
    }
    expect(verify.metricValue({}, 'routine_completion')).toBe(1);
  });

  test('computeWindowScore: duplicate rows on a day collapse to 1; total = completed days', () => {
    const s = verify.computeWindowScore([
      { date: '2026-08-01T07:00:00Z' },
      { date: '2026-08-01T21:00:00Z' }, // same UTC day — never counts twice
      { date: '2026-08-02T07:00:00Z' },
      { date: '2026-08-04T07:00:00Z' },
    ], { metric: 'routine_completion', rule: 'max' });
    expect(s.per_day).toEqual([
      { day: '2026-08-01', value: 1 },
      { day: '2026-08-02', value: 1 },
      { day: '2026-08-04', value: 1 },
    ]);
    expect(s.total).toBe(3);
    expect(s.best_day).toBe(1);
    expect(s.streak).toBe(2); // 01-02 run, broken by the missing 03
  });

  test('a completion challenge produces no anti-cheat flags (all days are 1)', () => {
    const s = verify.computeWindowScore(
      ['01', '02', '03', '04', '05'].map((d) => ({ date: `2026-08-${d}T08:00:00Z` })),
      { metric: 'routine_completion', rule: 'max' });
    expect(verify.flagAnomalies(s)).toEqual([]);
  });
});

describe('arena_verify.longestStreak', () => {
  test('counts consecutive UTC days, across a month boundary', () => {
    expect(verify.longestStreak([
      { day: '2026-08-30', value: 1 }, { day: '2026-08-31', value: 1 }, { day: '2026-09-01', value: 1 },
    ])).toBe(3);
  });
  test('a zero-value day breaks the run; a resumed run is measured on its own', () => {
    expect(verify.longestStreak([
      { day: '2026-08-01', value: 1 }, { day: '2026-08-02', value: 0 },
      { day: '2026-08-03', value: 1 }, { day: '2026-08-04', value: 1 }, { day: '2026-08-05', value: 1 },
    ])).toBe(3);
  });
  test('empty → 0; also reported for step metrics (consecutive active days)', () => {
    expect(verify.longestStreak([])).toBe(0);
    const s = verify.computeWindowScore([
      { date: '2026-08-10T10:00:00Z', step_count: 5000 },
      { date: '2026-08-11T10:00:00Z', step_count: 5000 },
    ], { metric: 'activity_count' });
    expect(s.streak).toBe(2);
  });
});

describe('arena_verify.recordCompletion (#186)', () => {
  test('first check-in of a UTC day creates; a repeat the same day is a no-op', async () => {
    const db = createMockDb();
    const a = await verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice', at: '2026-08-03T07:00:00Z' });
    const b = await verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice', at: '2026-08-03T22:00:00Z' });
    const c = await verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice', at: '2026-08-04T07:00:00Z' });
    expect(a).toEqual({ ok: true, created: true, day: '2026-08-03' });
    expect(b).toEqual({ ok: true, created: false, day: '2026-08-03' });
    expect(c).toEqual({ ok: true, created: true, day: '2026-08-04' });
    expect(await db.collection('routine_completions').find({ entity: 'alice' }).toArray()).toHaveLength(2);
  });

  test('a concurrent duplicate (unique-index E11000) reports "already done", not an error', async () => {
    const db = createMockDb();
    db.collection('routine_completions').updateOne = jest.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })));
    expect(await verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice', at: '2026-08-03T07:00:00Z' }))
      .toEqual({ ok: true, created: false, day: '2026-08-03' });
  });

  test('other DB errors propagate', async () => {
    const db = createMockDb();
    db.collection('routine_completions').updateOne = jest.fn(() => Promise.reject(new Error('mongo down')));
    await expect(verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice' })).rejects.toThrow('mongo down');
  });

  test('rejects missing challengeId / entity and an invalid date', async () => {
    const db = createMockDb();
    expect((await verify.recordCompletion(db, { entity: 'alice' })).ok).toBe(false);
    expect((await verify.recordCompletion(db, { challengeId: 'ch_m' })).ok).toBe(false);
    expect((await verify.recordCompletion(db, { challengeId: 'ch_m', entity: 'alice', at: 'not-a-date' })).ok).toBe(false);
    expect((await verify.recordCompletion(db)).ok).toBe(false);
  });

  test('ensureCompletionIndexes creates the unique per-day key', async () => {
    const createIndex = jest.fn(() => Promise.resolve('ok'));
    const db = { collection: () => ({ createIndex }) };
    await verify.ensureCompletionIndexes(db);
    expect(createIndex).toHaveBeenCalledWith({ challenge_id: 1, entity: 1, day: 1 }, { unique: true });
  });
});

describe('arena_verify.fetchRoutineCompletions (#186)', () => {
  test('scoped to the challenge and bounded to the window', async () => {
    const db = createMockDb();
    db.collection('routine_completions').__seed([
      completion('ch_m', 'alice', '2026-08-03T07:00:00Z'),
      completion('ch_m', 'alice', '2026-09-03T07:00:00Z'), // outside the window
      completion('ch_other', 'alice', '2026-08-04T07:00:00Z'), // another challenge
      completion('ch_m', 'bob', '2026-08-05T07:00:00Z'), // another participant
    ]);
    const rows = await verify.fetchRoutineCompletions(db, 'ch_m', 'alice', WINDOW);
    expect(rows).toEqual([{ date: new Date('2026-08-03T07:00:00Z') }]);
  });

  test('fails CLOSED on a missing/invalid window', async () => {
    const db = createMockDb();
    await expect(verify.fetchRoutineCompletions(db, 'ch_m', 'alice', null)).rejects.toThrow(/window/);
    await expect(verify.fetchRoutineCompletions(db, 'ch_m', 'alice', { start: '2026-08-02', end: '2026-08-01' })).rejects.toThrow(/window/);
  });
});

describe('arena_verify.verifyChallenge — routine_completion end-to-end (#186)', () => {
  function seedMobility() {
    const db = createMockDb();
    db.collection('challenges').__seed([
      { id: 'ch_mob', window: WINDOW, scoring: { metric: 'routine_completion', rule: 'max' } },
      { id: 'ch_steps', window: WINDOW, scoring: { metric: 'activity_count', rule: 'max' } },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch_mob', entity: 'alice', flags: [], state: 'enrolled' },
      { challenge_id: 'ch_mob', entity: 'bob', flags: [], state: 'enrolled' },
      { challenge_id: 'ch_steps', entity: 'alice', flags: [], state: 'enrolled' },
    ]);
    db.collection('routine_completions').__seed([
      completion('ch_mob', 'alice', '2026-08-01T07:00:00Z'),
      completion('ch_mob', 'alice', '2026-08-02T07:00:00Z'),
      completion('ch_mob', 'alice', '2026-08-03T07:00:00Z'),
      completion('ch_mob', 'alice', '2026-08-05T07:00:00Z'),
    ]);
    // Alice also walked a lot — steps must NOT leak into the mobility score, and
    // completions must NOT leak into the step challenge.
    db.collection('verified_posts').__seed([post('alice', '2026-08-01T10:00:00Z', 12000)]);
    return db;
  }

  test('scores from completions (days + streak), never from steps', async () => {
    const db = seedMobility();
    const res = await verify.verifyChallenge(db, 'ch_mob', { asOf: '2026-08-31T00:00:00Z' });
    expect(res).toEqual({ ok: true, participants: 2, flagged: 0 });
    const alice = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_mob', entity: 'alice' });
    expect(alice.score).toMatchObject({ verified: 4, days: 4, streak: 3, metric: 'routine_completion', source: 'routine_completions' });
    const bob = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_mob', entity: 'bob' });
    expect(bob.score).toMatchObject({ verified: 0, days: 0, streak: 0 });
  });

  test('step challenges are unchanged by the new source', async () => {
    const db = seedMobility();
    await verify.verifyChallenge(db, 'ch_steps');
    const alice = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_steps', entity: 'alice' });
    expect(alice.score).toMatchObject({ verified: 12000, metric: 'activity_count', source: 'verified_posts' });
  });
});
