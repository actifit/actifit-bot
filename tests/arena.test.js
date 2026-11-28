/**
 * Challenge Engine F1 (Trello #175) — unit tests for arena.js.
 *
 * Exercises the real exported functions against the shared in-memory mock DB.
 * arena.js is dependency-injected (takes `db`) and loads no config/Firebase, so
 * it needs no special setup here.
 */

const { createMockDb } = require('./helpers/mock-db');
const arena = require('../arena');

// Build an on-chain custom_json op as the tailer would see it.
const chainOp = (body, signer, extra = {}) => ({
  id: arena.ARENA_JSON_ID,
  json: JSON.stringify(body),
  required_posting_auths: [signer],
  required_auths: [],
  trx_id: extra.trx_id || 'trx_' + Math.random().toString(36).slice(2),
  block_num: extra.block_num || 100,
  timestamp: extra.timestamp || '2026-08-25T00:00:00',
});

const createBody = (over = {}) => ({
  op: 'challenge_create',
  v: 1,
  id: 'ch_1',
  type: 'duel',
  origin_tier: 'friendly',
  window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
  entry: { mode: 'free' },
  scoring: { metric: 'activity_count', rule: 'head_to_head' },
  ...over,
});

describe('arena.validateArenaOp', () => {
  test('accepts a well-formed challenge_create', () => {
    expect(arena.validateArenaOp(createBody()).valid).toBe(true);
  });

  test('rejects a fee entry mode (invariant I1)', () => {
    const res = arena.validateArenaOp(createBody({ entry: { mode: 'fee' } }));
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/I1/);
  });

  test('rejects a scoring rule that is not skill/goal based (invariant I6)', () => {
    const res = arena.validateArenaOp(createBody({ scoring: { metric: 'steps', rule: 'random' } }));
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/I6/);
  });

  test('rejects an unknown op', () => {
    expect(arena.validateArenaOp({ op: 'nope' }).valid).toBe(false);
  });

  test('rejects a challenge_create with an invalid window', () => {
    const res = arena.validateArenaOp(createBody({ window: { start: 'x', end: 'y' } }));
    expect(res.valid).toBe(false);
  });

  test('challenge_update requires a known state', () => {
    expect(arena.validateArenaOp({ op: 'challenge_update', id: 'ch_1', state: 'active' }).valid).toBe(true);
    expect(arena.validateArenaOp({ op: 'challenge_update', id: 'ch_1', state: 'bogus' }).valid).toBe(false);
  });
});

describe('arena.canTransition', () => {
  test('permits legal transitions', () => {
    expect(arena.canTransition('draft', 'open')).toBe(true);
    expect(arena.canTransition('open', 'active')).toBe(true);
    expect(arena.canTransition('active', 'resolving')).toBe(true);
    expect(arena.canTransition('resolving', 'settled')).toBe(true);
  });

  test('forbids illegal or no-op transitions', () => {
    expect(arena.canTransition('open', 'settled')).toBe(false);
    expect(arena.canTransition('settled', 'active')).toBe(false);
    expect(arena.canTransition('open', 'open')).toBe(false);
    expect(arena.canTransition('archived', 'open')).toBe(false);
  });
});

describe('arena.indexArenaOp — lifecycle', () => {
  let db;
  beforeEach(() => { db = createMockDb(); });

  const create = (over, signer = 'alice', extra) => arena.indexArenaOp(db, chainOp(createBody(over), signer, extra));

  test('challenge_create inserts a challenge owned by the signer', async () => {
    const res = await create();
    expect(res).toEqual(expect.objectContaining({ ok: true, action: 'challenge_created' }));
    const ch = await db.collection('challenges').findOne({ id: 'ch_1' });
    expect(ch).toMatchObject({ id: 'ch_1', state: 'open', created_by: 'alice', origin_tier: 'friendly' });
  });

  test('official challenge must be signed by the official account', async () => {
    const bad = await create({ origin_tier: 'official' }, 'alice');
    expect(bad.ok).toBe(false);
    const good = await arena.indexArenaOp(db, chainOp(createBody({ origin_tier: 'official' }), 'actifit'));
    expect(good.ok).toBe(true);
  });

  test('duplicate challenge_create is rejected (idempotent id)', async () => {
    await create();
    const dup = await create();
    expect(dup.ok).toBe(false);
    expect(dup.reason).toMatch(/already exists/);
  });

  test('an invalid op (fee entry) is not indexed', async () => {
    const res = await create({ entry: { mode: 'fee' } });
    expect(res.ok).toBe(false);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });

  test('a valid badge_rule is stored on the challenge', async () => {
    const res = await create({ rewards: { badges: ['October Sprinter'] }, badge_rule: 'top3' });
    expect(res.ok).toBe(true);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toMatchObject({ badge_rule: 'top3' });
  });

  test('an invalid badge_rule is rejected (not indexed)', async () => {
    const res = await create({ rewards: { badges: ['X'] }, badge_rule: 'everyone-forever' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/badge_rule/);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });

  test('an over-long or over-count badge reward is rejected', async () => {
    expect((await create({ rewards: { badges: ['x'.repeat(61)] } })).ok).toBe(false);
    expect((await create({ rewards: { badges: ['a', 'b', 'c', 'd', 'e', 'f'] } })).ok).toBe(false);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });

  test('join records the signer as the participant', async () => {
    await create();
    const res = await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    expect(res).toEqual(expect.objectContaining({ ok: true, action: 'joined' }));
    const p = await db.collection('challenge_participants').findOne({ challenge_id: 'ch_1', entity: 'bob' });
    expect(p).toMatchObject({ entity: 'bob', state: 'enrolled' });
  });

  test('join ignores a spoofed entity field and uses the signer', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1', entity: 'victim' }, 'bob'));
    expect(await db.collection('challenge_participants').findOne({ entity: 'victim' })).toBeNull();
    expect(await db.collection('challenge_participants').findOne({ entity: 'bob' })).not.toBeNull();
  });

  test('join on an unknown challenge is rejected', async () => {
    const res = await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'nope' }, 'bob'));
    expect(res.ok).toBe(false);
  });

  test('double join is rejected', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    const dup = await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    expect(dup.ok).toBe(false);
    expect(dup.reason).toMatch(/already joined/);
  });

  test('enroll is official-only and skips already-enrolled entities', async () => {
    await create();
    const denied = await arena.indexArenaOp(db, chainOp({ op: 'enroll', challenge_id: 'ch_1', entities: ['x', 'y'] }, 'alice'));
    expect(denied.ok).toBe(false);

    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'x'));
    const res = await arena.indexArenaOp(db, chainOp({ op: 'enroll', challenge_id: 'ch_1', entities: ['x', 'y', 'z'] }, 'actifit'));
    expect(res).toEqual(expect.objectContaining({ ok: true, action: 'enrolled', count: 2 }));
    expect(await db.collection('challenge_participants').find({ challenge_id: 'ch_1' }).toArray()).toHaveLength(3);
  });

  test('challenge_update enforces the state machine and authorisation', async () => {
    await create();
    const illegal = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'resolving' }, 'alice'));
    expect(illegal.ok).toBe(false);
    expect(illegal.reason).toMatch(/illegal transition/);

    const unauth = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'active' }, 'mallory'));
    expect(unauth.ok).toBe(false);

    const ok = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'active' }, 'alice'));
    expect(ok.ok).toBe(true);
    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).state).toBe('active');
  });

  test('leave marks a participant as left', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    const res = await arena.indexArenaOp(db, chainOp({ op: 'leave', challenge_id: 'ch_1' }, 'bob'));
    expect(res.ok).toBe(true);
    expect((await db.collection('challenge_participants').findOne({ entity: 'bob' })).state).toBe('left');
    // re-leave is an idempotent no-op
    const again = await arena.indexArenaOp(db, chainOp({ op: 'leave', challenge_id: 'ch_1' }, 'bob'));
    expect(again).toMatchObject({ ok: true, noop: true });
  });

  test('cannot leave a settled challenge (a late leave must not mutate final records)', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    await db.collection('challenges').updateOne({ id: 'ch_1' }, { $set: { state: 'settled' } });
    const res = await arena.indexArenaOp(db, chainOp({ op: 'leave', challenge_id: 'ch_1' }, 'bob'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot leave a settled/);
    expect((await db.collection('challenge_participants').findOne({ entity: 'bob' })).state).toBe('enrolled');
  });

  test('settle is official-only, records results, and closes the challenge', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'bob'));
    await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'carol'));

    const settleBody = {
      op: 'settle',
      challenge_id: 'ch_1',
      standings: [
        { entity: 'bob', rank: 1, score_verified: 12040 },
        { entity: 'carol', rank: 2, score_verified: 9000 },
      ],
      rewards: [{ entity: 'bob', afit: 25, badges: ['winner'], reward_ref: 'arena_challenge:ch_1' }],
    };

    const denied = await arena.indexArenaOp(db, chainOp(settleBody, 'alice'));
    expect(denied.ok).toBe(false);

    const res = await arena.indexArenaOp(db, chainOp(settleBody, 'actifit'));
    expect(res).toEqual(expect.objectContaining({ ok: true, action: 'settled' }));

    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).state).toBe('settled');
    const bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.result).toMatchObject({ rank: 1, reward: { afit: 25, badges: ['winner'], reward_ref: 'arena_challenge:ch_1' } });
    const carol = await db.collection('challenge_participants').findOne({ entity: 'carol' });
    expect(carol.result).toMatchObject({ rank: 2, reward: null });

    const again = await arena.indexArenaOp(db, chainOp(settleBody, 'actifit'));
    expect(again.ok).toBe(false);
  });

  test('cannot join a settled challenge', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'settle', challenge_id: 'ch_1', standings: [], rewards: [] }, 'actifit'));
    const res = await arena.indexArenaOp(db, chainOp({ op: 'join', challenge_id: 'ch_1' }, 'late'));
    expect(res.ok).toBe(false);
  });
});

// Fixes from the 3-agent review of PR #50.
describe('arena.indexArenaOp — review hardening (B1–B4)', () => {
  let db;
  beforeEach(() => { db = createMockDb(); });
  const create = (over, signer = 'alice', extra) => arena.indexArenaOp(db, chainOp(createBody(over), signer, extra));

  // B1 — settle must not resurrect a terminal challenge.
  test('B1: settle cannot resurrect a cancelled challenge', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'cancelled' }, 'alice'));
    const res = await arena.indexArenaOp(db, chainOp({ op: 'settle', challenge_id: 'ch_1', standings: [], rewards: [] }, 'actifit'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot settle a cancelled/);
    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).state).toBe('cancelled');
  });

  // B2 — a creator must not self-drive into a terminal state via challenge_update.
  test('B2: creator cannot reach settled/archived via challenge_update; official settle still works', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'active' }, 'alice'));
    await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'resolving' }, 'alice'));

    const selfSettle = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'settled' }, 'alice'));
    expect(selfSettle.ok).toBe(false);
    expect(selfSettle.reason).toMatch(/only via the settle op/);

    const selfArchive = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'archived' }, 'alice'));
    expect(selfArchive.ok).toBe(false);
    expect(selfArchive.reason).toMatch(/only the official account may archive/);

    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).state).toBe('resolving');

    const settled = await arena.indexArenaOp(db, chainOp({ op: 'settle', challenge_id: 'ch_1', standings: [], rewards: [] }, 'actifit'));
    expect(settled.ok).toBe(true);
  });

  // B3 — no monetary field may ride on an entry, and unknown fields are stripped.
  test('B3: validateArenaOp rejects a monetary entry field (invariant I1)', () => {
    const r = arena.validateArenaOp(createBody({ entry: { mode: 'free', stake: 5 } }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/monetary/);
  });

  test('B3: entry.fee is rejected and not persisted', async () => {
    const res = await create({ entry: { mode: 'free', fee: 100 } });
    expect(res.ok).toBe(false);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });

  test('B3: unknown entry fields are stripped from the stored doc', async () => {
    await create({ entry: { mode: 'free', foo: 'bar' } });
    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).entry).toEqual({ mode: 'free' });
  });

  // B4 — replays are idempotent no-ops, not rejections.
  test('B4: replaying the same challenge_create is a no-op; a different op reusing the id is rejected', async () => {
    const body = createBody();
    const first = await arena.indexArenaOp(db, chainOp(body, 'alice', { trx_id: 't_create' }));
    expect(first).toMatchObject({ ok: true, action: 'challenge_created' });
    expect(first.noop).toBeUndefined();

    const replay = await arena.indexArenaOp(db, chainOp(body, 'alice', { trx_id: 't_create' }));
    expect(replay).toMatchObject({ ok: true, noop: true });

    const collision = await arena.indexArenaOp(db, chainOp(body, 'alice', { trx_id: 't_other' }));
    expect(collision.ok).toBe(false);
  });

  test('B4: replaying the same join is a no-op (no duplicate participant)', async () => {
    await create();
    const j = { op: 'join', challenge_id: 'ch_1' };
    const first = await arena.indexArenaOp(db, chainOp(j, 'bob', { trx_id: 't_join' }));
    expect(first).toMatchObject({ ok: true, action: 'joined' });
    const replay = await arena.indexArenaOp(db, chainOp(j, 'bob', { trx_id: 't_join' }));
    expect(replay).toMatchObject({ ok: true, noop: true });
    expect(await db.collection('challenge_participants').find({ challenge_id: 'ch_1' }).toArray()).toHaveLength(1);
  });

  test('B4: a replayed challenge_update onto the current state is a no-op, not an error', async () => {
    await create();
    const up = { op: 'challenge_update', id: 'ch_1', state: 'active' };
    expect((await arena.indexArenaOp(db, chainOp(up, 'alice'))).ok).toBe(true);
    expect(await arena.indexArenaOp(db, chainOp(up, 'alice'))).toMatchObject({ ok: true, noop: true });
  });

  test('B4: replaying the same settle is a no-op', async () => {
    await create();
    const s = { op: 'settle', challenge_id: 'ch_1', standings: [], rewards: [] };
    const first = await arena.indexArenaOp(db, chainOp(s, 'actifit', { trx_id: 't_settle' }));
    expect(first).toMatchObject({ ok: true, action: 'settled' });
    const replay = await arena.indexArenaOp(db, chainOp(s, 'actifit', { trx_id: 't_settle' }));
    expect(replay).toMatchObject({ ok: true, noop: true });
  });

  // Confirms the whole-object $set fix (dotted paths did not nest in the mock).
  test('settle nests audit + source metadata correctly', async () => {
    await create();
    await arena.indexArenaOp(db, chainOp({ op: 'settle', challenge_id: 'ch_1', standings: [], rewards: [] }, 'actifit', { trx_id: 't_s', timestamp: '2026-08-25T12:00:00' }));
    const ch = await db.collection('challenges').findOne({ id: 'ch_1' });
    expect(ch.audit.settled_at).toBe('2026-08-25T12:00:00');
    expect(ch.source.settle_trx_id).toBe('t_s');
  });
});

// Fixes from the second (2-agent) review of PR #50.
describe('arena — review round 2 hardening (M1 + coverage)', () => {
  let db;
  beforeEach(() => { db = createMockDb(); });
  const create = (over, signer = 'alice', extra) => arena.indexArenaOp(db, chainOp(createBody(over), signer, extra));

  // M1 — a monetary field nested inside entry.gate must not survive (B3, one level deeper).
  test('M1: a monetary field nested in entry.gate is rejected (invariant I1)', async () => {
    const res = await create({ entry: { mode: 'free', gate: { min_activity: 5000, fee: 100 } } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/monetary/);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });

  test('M1: unknown entry.gate keys are stripped from the stored doc', async () => {
    await create({ entry: { mode: 'activity_gated', gate: { min_activity: 5000, foo: 'bar' } } });
    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).entry)
      .toEqual({ mode: 'activity_gated', gate: { min_activity: 5000 } });
  });

  test('rejects an invalid visibility', () => {
    expect(arena.validateArenaOp(createBody({ visibility: 'secret' })).valid).toBe(false);
  });

  test('rejects an unsupported op version and persists a valid one', async () => {
    expect(arena.validateArenaOp(createBody({ v: 2 })).valid).toBe(false);
    expect(arena.validateArenaOp(createBody({ v: 0 })).valid).toBe(false);
    await create({ v: 1 });
    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).v).toBe(1);
  });

  // indexArenaOp guard branches that the happy-path tests never reach.
  const rawOp = (over = {}) => ({
    id: arena.ARENA_JSON_ID,
    json: JSON.stringify(createBody()),
    required_posting_auths: ['alice'],
    required_auths: [],
    trx_id: 't',
    ...over,
  });

  test('rejects an op whose id is not actifit_arena', async () => {
    expect((await arena.indexArenaOp(db, rawOp({ id: 'something_else' }))).ok).toBe(false);
  });

  test('rejects an op with unparseable json', async () => {
    expect((await arena.indexArenaOp(db, rawOp({ json: '{not valid' }))).ok).toBe(false);
  });

  test('rejects an op with no signer', async () => {
    const res = await arena.indexArenaOp(db, rawOp({ required_posting_auths: [], required_auths: [] }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no signer/);
  });

  test('rejects an op with no trx_id', async () => {
    const res = await arena.indexArenaOp(db, rawOp({ trx_id: undefined }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no trx_id/);
  });

  test('opSigner falls back to the active auth when no posting auth is present', () => {
    expect(arena.opSigner({ required_posting_auths: [], required_auths: ['boss'] })).toBe('boss');
  });

  // ensureArenaIndexes: the shared mock has no createIndex, so drive a bespoke one.
  test('ensureArenaIndexes declares the unique id + participant indexes', async () => {
    const calls = { challenges: [], challenge_participants: [] };
    const idxDb = { collection: (name) => ({ createIndex: (spec, opts) => { calls[name].push({ spec, opts }); return Promise.resolve(); } }) };
    await arena.ensureArenaIndexes(idxDb);
    expect(calls.challenges).toEqual(expect.arrayContaining([
      expect.objectContaining({ spec: { id: 1 }, opts: { unique: true } }),
    ]));
    expect(calls.challenge_participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ spec: { challenge_id: 1, entity: 1 }, opts: { unique: true } }),
    ]));
  });

  // The dup-key catch branch: unreachable via the shared mock (it never throws),
  // so inject a collection whose insertOne rejects with E11000 after findOne misses.
  test('a duplicate-key insert race is treated as an idempotent no-op', async () => {
    const raceDb = {
      collection: () => ({
        findOne: () => Promise.resolve(null),
        insertOne: () => { const e = new Error('E11000 duplicate key'); e.code = 11000; return Promise.reject(e); },
      }),
    };
    const res = await arena.indexArenaOp(raceDb, chainOp(createBody(), 'alice', { trx_id: 't_race' }));
    expect(res).toMatchObject({ ok: true, action: 'challenge_created', noop: true });
  });
});

describe('challenge presentation metadata (Trello #182)', () => {
  it('persists bounded presentation fields on create', async () => {
    const db = createMockDb();
    const body = createBody({
      id: 'ch_pres', tagline: 'Climb the board', how_it_works: 'Log activity all week',
      prize_summary: 'Earn Actifit Merits', recurrence: 'Weekly', art: 'step-league',
    });
    const res = await arena.indexArenaOp(db, chainOp(body, 'someuser'));
    expect(res.ok).toBe(true);
    const doc = await db.collection('challenges').findOne({ id: 'ch_pres' });
    expect(doc.tagline).toBe('Climb the board');
    expect(doc.how_it_works).toBe('Log activity all week');
    expect(doc.prize_summary).toBe('Earn Actifit Merits');
    expect(doc.recurrence).toBe('Weekly');
    expect(doc.art).toBe('step-league');
  });

  it('drops non-string / empty and clamps over-long presentation fields', async () => {
    const db = createMockDb();
    const body = createBody({
      id: 'ch_pres2', tagline: { nope: 1 }, recurrence: '   ', art: 42,
      how_it_works: 'y'.repeat(5000),
    });
    await arena.indexArenaOp(db, chainOp(body, 'someuser'));
    const doc = await db.collection('challenges').findOne({ id: 'ch_pres2' });
    expect(doc.tagline).toBeUndefined();   // non-string dropped
    expect(doc.recurrence).toBeUndefined(); // blank dropped
    expect(doc.art).toBeUndefined();        // non-string dropped
    expect(doc.how_it_works.length).toBe(2000); // clamped to bound
  });

  it('omits presentation keys entirely when none are provided', async () => {
    const db = createMockDb();
    await arena.indexArenaOp(db, chainOp(createBody({ id: 'ch_bare' }), 'someuser'));
    const doc = await db.collection('challenges').findOne({ id: 'ch_bare' });
    expect('tagline' in doc).toBe(false);
    expect('art' in doc).toBe(false);
  });
});

// Trello #186: a self-reported metric (honor-system check-ins) may never carry
// an AFIT prize — a creator-funded pool would be drainable by false check-ins.
describe('arena.validateArenaOp — self-reported metric guard (#186)', () => {
  const mobility = (rewards) => createBody({
    type: 'daily_focus',
    scoring: { metric: 'routine_completion', rule: 'max', threshold: 1 },
    ...(rewards !== undefined ? { rewards } : {}),
  });

  test('rejects an AFIT prize on routine_completion', () => {
    const res = mobility({ afit: 100 });
    const v = arena.validateArenaOp(res);
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/self-reported/);
  });

  test('accepts a badge-only / zero-AFIT routine_completion challenge', () => {
    expect(arena.validateArenaOp(mobility({ afit: 0, badges: ['mobility_14d'] })).valid).toBe(true);
    expect(arena.validateArenaOp(mobility({ badges: ['mobility_14d'] })).valid).toBe(true);
    expect(arena.validateArenaOp(mobility()).valid).toBe(true);
  });

  test('step metrics may still carry an AFIT prize (unchanged)', () => {
    expect(arena.validateArenaOp(createBody({ rewards: { afit: 100 } })).valid).toBe(true);
  });
});

// Trello #187: the on-chain `checkin` op — a participant's daily check-in on a
// self-reported routine challenge. Signer = participant, block time = check-in time.
describe('arena.indexArenaOp — checkin (#187)', () => {
  const MWIN = { start: '2026-08-01T00:00:00Z', end: '2026-08-15T00:00:00Z' };
  let db;
  beforeEach(() => {
    db = createMockDb();
    db.collection('challenges').__seed([
      { id: 'mob', state: 'active', window: MWIN, scoring: { metric: 'routine_completion', rule: 'max' } },
      { id: 'steps', state: 'active', window: MWIN, scoring: { metric: 'activity_count', rule: 'max' } },
      { id: 'mob_done', state: 'settled', window: MWIN, scoring: { metric: 'routine_completion', rule: 'max' } },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'mob', entity: 'bob', state: 'enrolled', flags: [] },
      { challenge_id: 'mob', entity: 'quitter', state: 'left', flags: [] },
      { challenge_id: 'steps', entity: 'bob', state: 'enrolled', flags: [] },
      { challenge_id: 'mob_done', entity: 'bob', state: 'settled', flags: [] },
    ]);
  });
  const checkin = (signer, extra = {}, body = {}) =>
    arena.indexArenaOp(db, chainOp({ op: 'checkin', v: 1, challenge_id: 'mob', ...body }, signer, { timestamp: '2026-08-03T23:30:00', ...extra }));
  const rows = () => db.collection('routine_completions').find({}).toArray();

  test('records the SIGNER on the BLOCK day, with on-chain provenance', async () => {
    const res = await checkin('bob', { trx_id: 'trx_c1', block_num: 777 });
    expect(res).toEqual({ ok: true, action: 'checked_in', day: '2026-08-03' });
    const [r] = await rows();
    expect(r).toMatchObject({ challenge_id: 'mob', entity: 'bob', day: '2026-08-03', source: { trx_id: 'trx_c1', block_num: 777 } });
    // The zone-less Hive timestamp is read as UTC, never server-local time.
    expect(r.at.toISOString()).toBe('2026-08-03T23:30:00.000Z');
  });

  test('a spoofed entity field is ignored — the signer is checked in', async () => {
    await checkin('bob', {}, { entity: 'victim' });
    expect((await rows()).map((r) => r.entity)).toEqual(['bob']);
  });

  test('a second check-in the same UTC day is a no-op; the next day counts', async () => {
    await checkin('bob', { timestamp: '2026-08-03T08:00:00' });
    expect(await checkin('bob', { timestamp: '2026-08-03T20:00:00' })).toEqual({ ok: true, action: 'checked_in', day: '2026-08-03', noop: true });
    expect(await checkin('bob', { timestamp: '2026-08-04T08:00:00' })).toEqual({ ok: true, action: 'checked_in', day: '2026-08-04' });
    expect(await rows()).toHaveLength(2);
  });

  test('rejects non-participants and participants who left', async () => {
    expect(await checkin('stranger')).toMatchObject({ ok: false, reason: 'not a participant' });
    expect(await checkin('quitter')).toMatchObject({ ok: false, reason: 'not a participant' });
    expect(await rows()).toHaveLength(0);
  });

  test('rejects a step challenge, a settled challenge and an unknown one', async () => {
    expect(await checkin('bob', {}, { challenge_id: 'steps' })).toMatchObject({ ok: false, reason: 'challenge does not take check-ins' });
    expect(await checkin('bob', {}, { challenge_id: 'mob_done' })).toMatchObject({ ok: false, reason: expect.stringMatching(/not accepting check-ins/) });
    expect(await checkin('bob', {}, { challenge_id: 'nope' })).toMatchObject({ ok: false, reason: 'unknown challenge' });
    expect(await rows()).toHaveLength(0);
  });

  test('rejects a block time outside the window even while the challenge is still active', async () => {
    expect(await checkin('bob', { timestamp: '2026-08-15T00:00:00' })).toMatchObject({ ok: false, reason: 'outside challenge window' });
    expect(await checkin('bob', { timestamp: '2026-07-31T23:59:59' })).toMatchObject({ ok: false, reason: 'outside challenge window' });
  });

  test('an op with no block timestamp is rejected (never falls back to now)', async () => {
    const op = chainOp({ op: 'checkin', v: 1, challenge_id: 'mob' }, 'bob');
    delete op.timestamp;
    expect(await arena.indexArenaOp(db, op)).toMatchObject({ ok: false, reason: 'op has no block timestamp' });
  });

  test('review: a re-tailed check-in after the challenge settled is a no-op, not a rejection', async () => {
    await checkin('bob', { trx_id: 'trx_same' });
    await db.collection('challenges').updateOne({ id: 'mob' }, { $set: { state: 'settled' } });
    expect(await checkin('bob', { trx_id: 'trx_same' })).toEqual({ ok: true, action: 'checked_in', day: '2026-08-03', noop: true });
    // ...but a DIFFERENT op that day on a settled challenge is still refused
    expect(await checkin('bob', { trx_id: 'trx_other', timestamp: '2026-08-04T08:00:00' })).toMatchObject({ ok: false });
  });

  test('review: refused once the challenge is resolved (never written after scoring)', async () => {
    db.collection('challenge_resolutions').__seed([{ challenge_id: 'mob' }]);
    expect(await checkin('bob')).toMatchObject({ ok: false, reason: 'challenge already resolved' });
    expect(await rows()).toHaveLength(0);
  });

  test('review: squad routine challenges do not take per-user check-ins', async () => {
    db.collection('challenges').__seed([{ id: 'sq', state: 'active', window: MWIN, participants_kind: 'squad',
      scoring: { metric: 'routine_completion', rule: 'max' } }]);
    db.collection('challenge_participants').__seed([{ challenge_id: 'sq', entity: 'teamx', state: 'enrolled', flags: [] }]);
    expect(await checkin('teamx', {}, { challenge_id: 'sq' })).toMatchObject({ ok: false, reason: expect.stringMatching(/squad/) });
  });

  test('review: a garbage block timestamp fails safely', async () => {
    expect(await checkin('bob', { timestamp: 'garbage' })).toMatchObject({ ok: false, reason: 'invalid at' });
    expect(await rows()).toHaveLength(0);
  });

  test('arena_write.buildCheckinOp builds a valid op', () => {
    const op = require('../arena_write').buildCheckinOp('mob');
    expect(op).toEqual({ op: 'checkin', v: 1, challenge_id: 'mob' });
    expect(arena.validateArenaOp(op).valid).toBe(true);
  });

  test('validateArenaOp requires challenge_id on a checkin', () => {
    expect(arena.validateArenaOp({ op: 'checkin', v: 1 }).valid).toBe(false);
    expect(arena.validateArenaOp({ op: 'checkin', v: 1, challenge_id: 'mob' }).valid).toBe(true);
  });
});

// Trello #188: on a routine challenge scoring.threshold = minimum completed days.
describe('arena.validateArenaOp: routine finisher threshold (#188)', () => {
  const WIN14 = { start: '2026-12-01T00:00:00Z', end: '2026-12-15T00:00:00Z' };
  const mob = (threshold) => createBody({ type: 'daily_focus', window: WIN14, rewards: { badges: ['mobility_14d'] }, badge_rule: 'all',
    scoring: { metric: 'routine_completion', rule: 'threshold', ...(threshold !== undefined ? { threshold } : {}) } });
  test('accepts a whole number of days within the window', () => {
    expect(arena.validateArenaOp(mob(10)).valid).toBe(true);
    expect(arena.validateArenaOp(mob(14)).valid).toBe(true);
  });
  test('rejects a missing threshold, 0, fractions, strings and more days than the window holds', () => {
    for (const bad of [undefined, 0, -1, 2.5, '10', 15]) {
      const v = arena.validateArenaOp(mob(bad));
      expect(v.valid).toBe(false);
      expect(v.errors.join(' ')).toMatch(/whole number of days/);
    }
  });
  test('step challenges keep their own threshold meaning (e.g. 5000 steps)', () => {
    expect(arena.validateArenaOp(createBody({ type: 'daily_focus', scoring: { metric: 'goal_hit', rule: 'threshold', threshold: 5000 } })).valid).toBe(true);
  });
});
