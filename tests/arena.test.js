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
      rewards: [{ entity: 'bob', afit: 25, merits: 50, badges: ['winner'], he_tx: 'tx123' }],
    };

    const denied = await arena.indexArenaOp(db, chainOp(settleBody, 'alice'));
    expect(denied.ok).toBe(false);

    const res = await arena.indexArenaOp(db, chainOp(settleBody, 'actifit'));
    expect(res).toEqual(expect.objectContaining({ ok: true, action: 'settled' }));

    expect((await db.collection('challenges').findOne({ id: 'ch_1' })).state).toBe('settled');
    const bob = await db.collection('challenge_participants').findOne({ entity: 'bob' });
    expect(bob.result).toMatchObject({ rank: 1, reward: { afit: 25, merits: 50, he_tx: 'tx123' } });
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
