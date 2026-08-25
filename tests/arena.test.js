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
    const illegal = await arena.indexArenaOp(db, chainOp({ op: 'challenge_update', id: 'ch_1', state: 'settled' }, 'alice'));
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
