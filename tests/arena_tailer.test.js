/**
 * Challenge Engine F1 live tailer (Trello #175) — unit tests for arena_tailer.js.
 *
 * The tailer's core (extract → process → resumable catch-up) is pure and
 * dependency-injected, so it is tested against the shared mock DB plus a fake
 * hive client — no network, no real blocks.
 */

const { createMockDb } = require('./helpers/mock-db');
const tailer = require('../arena_tailer');
const arena = require('../arena');

const createBody = (id = 'ch_1') => ({
  op: 'challenge_create',
  v: 1,
  id,
  type: 'duel',
  origin_tier: 'friendly',
  window: { start: '2026-08-25T00:00:00Z', end: '2026-08-26T00:00:00Z' },
  entry: { mode: 'free' },
  scoring: { metric: 'activity_count', rule: 'head_to_head' },
});

const arenaOp = (body, signer = 'alice') => ['custom_json', {
  id: arena.ARENA_JSON_ID,
  json: JSON.stringify(body),
  required_posting_auths: [signer],
  required_auths: [],
}];

// A raw block carrying one operation per transaction.
const block = (ops, trxIds, timestamp = '2026-08-25T00:00:00') => ({
  timestamp,
  transactions: ops.map((o) => ({ operations: [o] })),
  transaction_ids: trxIds,
});

const fakeHive = (head, blocks) => ({
  blockchain: { getCurrentBlockNum: async () => head },
  database: { getBlock: async (n) => (blocks ? blocks[n] : block([], [])) },
});

describe('arena_tailer.extractArenaOps', () => {
  test('extracts only actifit_arena ops, with chain-derived fields', () => {
    const b = {
      timestamp: '2026-08-25T00:00:00',
      transactions: [
        { operations: [arenaOp(createBody())] },
        { operations: [['custom_json', { id: 'actifit_vote', json: '{}', required_posting_auths: ['bob'] }]] },
        { operations: [['vote', { voter: 'x' }]] },
      ],
      transaction_ids: ['trxA', 'trxB', 'trxC'],
    };
    const ops = tailer.extractArenaOps(b, 42);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: arena.ARENA_JSON_ID, trx_id: 'trxA', block_num: 42, timestamp: '2026-08-25T00:00:00' });
    expect(ops[0].required_posting_auths).toEqual(['alice']);
  });

  test('returns [] for a malformed / empty block', () => {
    expect(tailer.extractArenaOps(null, 1)).toEqual([]);
    expect(tailer.extractArenaOps({}, 1)).toEqual([]);
    expect(tailer.extractArenaOps(block([], []), 1)).toEqual([]);
  });
});

describe('arena_tailer.processArenaBlock', () => {
  test('applies each arena op in the block to the index', async () => {
    const db = createMockDb();
    const res = await tailer.processArenaBlock(db, block([arenaOp(createBody())], ['trx1']), 100);
    expect(res[0]).toMatchObject({ ok: true, action: 'challenge_created', trx_id: 'trx1' });
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).not.toBeNull();
  });
});

describe('arena_tailer.catchUpOnce', () => {
  test('processes cursor→head, persists the cursor, and is idempotent on re-run', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 0); // explicit prior state, so it backfills 1..5
    const blocks = {
      1: block([], []),
      2: block([], []),
      3: block([arenaOp(createBody())], ['trx3']),
      4: block([], []),
      5: block([], []),
    };
    const hive = fakeHive(5, blocks);

    const r = await tailer.catchUpOnce(db, hive);
    expect(r).toMatchObject({ from: 1, to: 5, processed: 5 });
    expect(await tailer.loadCursor(db)).toBe(5);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).not.toBeNull();

    // head unchanged → nothing new
    const r2 = await tailer.catchUpOnce(db, hive);
    expect(r2.processed).toBe(0);
    // and only one challenge exists (the replay was an idempotent no-op)
    expect(await db.collection('challenges').find({}).toArray()).toHaveLength(1);
  });

  test('resumes from the saved cursor, not from zero', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 3);
    const seen = [];
    const hive = { blockchain: { getCurrentBlockNum: async () => 5 }, database: { getBlock: async (n) => { seen.push(n); return block([], []); } } };
    const r = await tailer.catchUpOnce(db, hive);
    expect(seen).toEqual([4, 5]);
    expect(r).toMatchObject({ from: 4, to: 5, processed: 2 });
  });

  test('caps a batch at maxBlocksPerTick', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 0);
    const r = await tailer.catchUpOnce(db, fakeHive(1000), { maxBlocksPerTick: 10 });
    expect(r.processed).toBe(10);
    expect(await tailer.loadCursor(db)).toBe(10);
  });

  test('stops the batch when a block is not yet available', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 0);
    const hive = { blockchain: { getCurrentBlockNum: async () => 5 }, database: { getBlock: async (n) => (n <= 3 ? block([], []) : null) } };
    const r = await tailer.catchUpOnce(db, hive);
    expect(r.processed).toBe(3);
    expect(await tailer.loadCursor(db)).toBe(3);
  });

  test('does nothing when head is at or behind the cursor', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 5);
    const r = await tailer.catchUpOnce(db, fakeHive(5));
    expect(r.processed).toBe(0);
  });
});

describe('arena_tailer.getTargetBlock + cursor', () => {
  test('prefers last-irreversible over head', async () => {
    const hive = { blockchain: { getCurrentBlockNum: async () => 100 }, database: { getDynamicGlobalProperties: async () => ({ head_block_number: 100, last_irreversible_block_num: 85 }) } };
    expect(await tailer.getTargetBlock(hive)).toBe(85);
  });

  test('falls back to head when LIB is unavailable', async () => {
    const hive = { blockchain: { getCurrentBlockNum: async () => 100 }, database: {} };
    expect(await tailer.getTargetBlock(hive)).toBe(100);
  });

  test('loadCursor returns null when no cursor doc exists; saveCursor round-trips', async () => {
    const db = createMockDb();
    expect(await tailer.loadCursor(db)).toBeNull();
    await tailer.saveCursor(db, 42);
    expect(await tailer.loadCursor(db)).toBe(42);
  });

  test('cold start with no cursor snaps to the current target (no genesis crawl)', async () => {
    const db = createMockDb();
    let getBlockCalls = 0;
    const hive = {
      blockchain: { getCurrentBlockNum: async () => 90000000 },
      database: { getDynamicGlobalProperties: async () => ({ last_irreversible_block_num: 90000000 }), getBlock: async () => { getBlockCalls++; return block([], []); } },
    };
    const r = await tailer.catchUpOnce(db, hive);
    expect(r.processed).toBe(0);
    expect(getBlockCalls).toBe(0);
    expect(await tailer.loadCursor(db)).toBe(90000000);
  });

  test('cold start honors an explicit start_block (backfill)', async () => {
    const db = createMockDb();
    const seen = [];
    const hive = {
      blockchain: { getCurrentBlockNum: async () => 5 },
      database: { getDynamicGlobalProperties: async () => ({ last_irreversible_block_num: 5 }), getBlock: async (n) => { seen.push(n); return block([], []); } },
    };
    const r = await tailer.catchUpOnce(db, hive, { startBlock: 2 });
    expect(seen).toEqual([3, 4, 5]);
    expect(r.processed).toBe(3);
  });
});

describe('arena_tailer.extractArenaOps — edge cases', () => {
  test('pairs the transaction trx_id across a multi-op transaction', () => {
    const b = {
      timestamp: 't',
      transactions: [
        { operations: [['vote', { voter: 'x' }], arenaOp(createBody('ch_a'))] },
        { operations: [arenaOp(createBody('ch_b'), 'bob')] },
      ],
      transaction_ids: ['trx1', 'trx2'],
    };
    expect(tailer.extractArenaOps(b, 7).map((o) => o.trx_id)).toEqual(['trx1', 'trx2']);
  });

  test('passes an object json payload through unchanged', () => {
    const body = createBody();
    const b = {
      timestamp: 't',
      transactions: [{ operations: [['custom_json', { id: arena.ARENA_JSON_ID, json: body, required_posting_auths: ['alice'], required_auths: [] }]] }],
      transaction_ids: ['trxO'],
    };
    expect(tailer.extractArenaOps(b, 1)[0].json).toBe(body);
  });

  test('an arena op with no matching transaction_id is rejected (indexArenaOp needs trx_id)', async () => {
    const db = createMockDb();
    const b = { timestamp: 't', transactions: [{ operations: [arenaOp(createBody())] }], transaction_ids: [] };
    const res = await tailer.processArenaBlock(db, b, 1);
    expect(res[0].ok).toBe(false);
    expect(await db.collection('challenges').findOne({ id: 'ch_1' })).toBeNull();
  });
});

describe('arena_tailer.startArenaTailer (loop)', () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  test('polls, advances the cursor, and stop() halts further ticks', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 0);
    let gdgp = 0;
    let getBlockCalls = 0;
    const hive = {
      blockchain: { getCurrentBlockNum: async () => 3 },
      database: { getDynamicGlobalProperties: async () => { gdgp++; return { last_irreversible_block_num: 3 }; }, getBlock: async () => { getBlockCalls++; return block([], []); } },
    };
    const handle = tailer.startArenaTailer(db, { hiveClient: hive, pollMs: 10 });
    await delay(80);
    expect(await tailer.loadCursor(db)).toBe(3);
    expect(getBlockCalls).toBe(3); // blocks 1,2,3 each processed once, then caught up
    handle.stop();
    await delay(20);
    const snapshot = gdgp;
    await delay(40);
    expect(gdgp).toBe(snapshot); // no ticks after stop()
  });

  test('an error in a tick is caught and the loop keeps running', async () => {
    const db = createMockDb();
    await tailer.saveCursor(db, 0);
    let calls = 0;
    const hive = {
      blockchain: { getCurrentBlockNum: async () => 2 },
      database: {
        getDynamicGlobalProperties: async () => { calls++; if (calls === 1) throw new Error('node down'); return { last_irreversible_block_num: 2 }; },
        getBlock: async () => block([], []),
      },
    };
    const handle = tailer.startArenaTailer(db, { hiveClient: hive, pollMs: 10 });
    await delay(80);
    handle.stop();
    expect(calls).toBeGreaterThan(1); // survived the throwing first tick
    expect(await tailer.loadCursor(db)).toBe(2); // and recovered
  });

  test('calls ensureArenaIndexes on start', async () => {
    const spy = jest.spyOn(arena, 'ensureArenaIndexes').mockResolvedValue();
    const db = createMockDb();
    const hive = { blockchain: { getCurrentBlockNum: async () => 0 }, database: { getDynamicGlobalProperties: async () => ({ last_irreversible_block_num: 0 }), getBlock: async () => block([], []) } };
    const handle = tailer.startArenaTailer(db, { hiveClient: hive, pollMs: 1000 });
    expect(spy).toHaveBeenCalledWith(db);
    handle.stop();
    spy.mockRestore();
  });
});
