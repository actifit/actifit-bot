/**
 * Challenge Engine F5 pools + resolution/payout (Trello #179) — unit tests.
 */

const { createMockDb } = require('./helpers/mock-db');
const pools = require('../arena_pools');
const merits = require('../arena_merits');

const AT = '2026-08-26T10:00:00Z';

describe('arena_pools.createPool (I2)', () => {
  test('I2 — rejects any non sponsor/DHF/treasury funding source', async () => {
    const db = createMockDb();
    for (const funding of ['stake', 'entry_fee', 'participant', 'wager', 'pot']) {
      const res = await pools.createPool(db, { id: 'p', funding, budget: 100 });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/I2/);
    }
  });

  test('creates a treasury pool and records a sponsor', async () => {
    const db = createMockDb();
    const res = await pools.createPool(db, { id: 'p1', funding: 'sponsor', sponsor: 'acme', budget: 1000, currency: 'AFIT' });
    expect(res).toMatchObject({ ok: true });
    expect(res.pool).toMatchObject({ id: 'p1', funding: 'sponsor', budget: 1000, committed: 0, paid: 0, state: 'open' });
    expect(await db.collection('sponsors').findOne({ id: 'acme' })).toMatchObject({ funded_total: 1000 });
  });

  test('rejects a negative budget and an invalid currency', async () => {
    const db = createMockDb();
    expect((await pools.createPool(db, { id: 'p', funding: 'dhf', budget: -1 })).ok).toBe(false);
    expect((await pools.createPool(db, { id: 'p', funding: 'dhf', budget: 1, currency: 'DOGE' })).ok).toBe(false);
  });
});

describe('arena_pools.commitToPool', () => {
  test('commits within budget and refuses to overcommit', async () => {
    const db = createMockDb();
    await pools.createPool(db, { id: 'pc', funding: 'treasury', budget: 100 });
    expect((await pools.commitToPool(db, 'pc', 60)).ok).toBe(true);
    expect((await pools.commitToPool(db, 'pc', 60)).ok).toBe(false);
    expect((await pools.commitToPool(db, 'nope', 1)).ok).toBe(false);
  });
});

describe('arena_pools.allocatePayouts', () => {
  test('maps ranked rows to prizes and skips ranks with no prize', () => {
    const p = pools.allocatePayouts(
      [{ entity: 'a', rank: 1 }, { entity: 'b', rank: 2 }, { entity: 'c', rank: 3 }],
      [{ rank: 1, afit: 100 }, { rank: 2, merits: 20 }]
    );
    expect(p.map((x) => x.entity)).toEqual(['a', 'b']);
    expect(p[0]).toMatchObject({ entity: 'a', afit: 100, merits: 0 });
  });

  test('excludes excluded entities (funder)', () => {
    const p = pools.allocatePayouts([{ entity: 'a', rank: 1 }], [{ rank: 1, afit: 100 }], { excludeEntities: new Set(['a']) });
    expect(p).toEqual([]);
  });
});

describe('arena_pools.resolveChallenge', () => {
  test('draws prizes → emits Merits, records results, marks pool paid, returns settle payload', async () => {
    const db = createMockDb();
    await pools.createPool(db, { id: 'pool1', funding: 'treasury', budget: 1000, currency: 'AFIT' });
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'a', flags: [] },
      { challenge_id: 'ch1', entity: 'b', flags: [] },
    ]);
    const standings = [{ entity: 'a', rank: 1 }, { entity: 'b', rank: 2 }];
    const prizes = [{ rank: 1, afit: 100, merits: 50, badges: ['champ'] }, { rank: 2, merits: 20 }];

    const res = await pools.resolveChallenge(db, { challengeId: 'ch1', poolId: 'pool1', standings, prizes, asOf: AT });
    expect(res).toMatchObject({ ok: true, paidAfit: 100, rewarded: 2 });
    expect(res.settlePayload).toMatchObject({ op: 'settle', challenge_id: 'ch1' });

    expect(await merits.balanceOf(db, 'a')).toBe(50);
    expect(await merits.balanceOf(db, 'b')).toBe(20);

    const a = await db.collection('challenge_participants').findOne({ entity: 'a' });
    expect(a.result.reward).toMatchObject({ afit: 100, merits: 50, badges: ['champ'], reward_ref: 'led_a_0' });
    expect((await db.collection('pools').findOne({ id: 'pool1' })).paid).toBe(100);
  });

  test('I7 — the pool funder is excluded from its own payout', async () => {
    const db = createMockDb();
    await pools.createPool(db, { id: 'pool2', funding: 'sponsor', sponsor: 'funderX', budget: 1000 });
    const res = await pools.resolveChallenge(db, {
      challengeId: 'ch2', poolId: 'pool2',
      standings: [{ entity: 'funderX', rank: 1 }, { entity: 'b', rank: 2 }],
      prizes: [{ rank: 1, afit: 500 }, { rank: 2, afit: 100 }], asOf: AT,
    });
    expect(res.excludedFunder).toBe('funderX');
    expect(res.paidAfit).toBe(100); // only b (rank 2) is paid
  });

  test('refuses a payout that exceeds the remaining pool budget', async () => {
    const db = createMockDb();
    await pools.createPool(db, { id: 'pool3', funding: 'dhf', budget: 50 });
    const res = await pools.resolveChallenge(db, { challengeId: 'ch3', poolId: 'pool3', standings: [{ entity: 'a', rank: 1 }], prizes: [{ rank: 1, afit: 100 }], asOf: AT });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/budget/);
  });

  test('rejects an unknown pool and missing standings', async () => {
    const db = createMockDb();
    expect((await pools.resolveChallenge(db, { challengeId: 'c', poolId: 'nope', standings: [] })).ok).toBe(false);
    await pools.createPool(db, { id: 'p', funding: 'dhf', budget: 10 });
    expect((await pools.resolveChallenge(db, { challengeId: 'c', poolId: 'p' })).ok).toBe(false);
  });

  test('ensurePoolsIndexes declares a unique index on pool id', async () => {
    const calls = { pools: [], sponsors: [] };
    const db = { collection: (name) => ({ createIndex: (spec, opts) => { calls[name].push({ spec, opts }); return Promise.resolve(); } }) };
    await pools.ensurePoolsIndexes(db);
    expect(calls.pools).toEqual(expect.arrayContaining([expect.objectContaining({ spec: { id: 1 }, opts: { unique: true } })]));
  });
});
