/**
 * Unit tests for the shared in-memory mock DB helper — specifically the `$inc` /
 * conditional / upsert / `$setOnInsert` behavior the #178 atomicity code relies
 * on. These pin the mock's fidelity to the real MongoDB semantics it models.
 */

const { createMockDb } = require('./helpers/mock-db');

describe('mock-db updateOne — $inc / conditional / upsert', () => {
  test('$inc increments a matched doc', async () => {
    const db = createMockDb();
    db.collection('c').__seed([{ id: 'x', n: 5 }]);
    const r = await db.collection('c').updateOne({ id: 'x' }, { $inc: { n: 3 } });
    expect(r.modifiedCount).toBe(1);
    expect((await db.collection('c').findOne({ id: 'x' })).n).toBe(8);
  });

  test('a conditional query that does not match: no change, modifiedCount 0', async () => {
    const db = createMockDb();
    db.collection('c').__seed([{ id: 'x', n: 5 }]);
    const r = await db.collection('c').updateOne({ id: 'x', n: { $gte: 10 } }, { $inc: { n: -1 } });
    expect(r.modifiedCount).toBe(0);
    expect((await db.collection('c').findOne({ id: 'x' })).n).toBe(5);
  });

  test('upsert seeds a doc from scalar query keys + $setOnInsert, skipping operator keys', async () => {
    const db = createMockDb();
    const r = await db.collection('c').updateOne({ user: 'u', balance: { $gte: 1 } }, { $setOnInsert: { balance: 100 } }, { upsert: true });
    expect(r.upsertedCount).toBe(1);
    const doc = await db.collection('c').findOne({ user: 'u' });
    expect(doc).toMatchObject({ user: 'u', balance: 100 }); // operator-valued query key not seeded
  });

  test('$setOnInsert is ignored when the doc already exists', async () => {
    const db = createMockDb();
    db.collection('c').__seed([{ user: 'u', balance: 500 }]);
    await db.collection('c').updateOne({ user: 'u' }, { $setOnInsert: { balance: 0 } }, { upsert: true });
    expect((await db.collection('c').findOne({ user: 'u' })).balance).toBe(500); // not reset to 0
  });

  test('updateOne without upsert on a miss inserts nothing', async () => {
    const db = createMockDb();
    const r = await db.collection('c').updateOne({ id: 'none' }, { $inc: { n: 1 } });
    expect(r).toMatchObject({ modifiedCount: 0, upsertedCount: 0 });
    expect(await db.collection('c').find({}).toArray()).toHaveLength(0);
  });
});

// The arena cap/budget maths now rests on this hand-rolled aggregation engine, so
// it needs its own coverage - otherwise a bug in the MOCK reads as a bug in the
// code under test (or worse, hides one).
describe('mock-db aggregate()', () => {
  const { createMockDb } = require('./helpers/mock-db');

  test('$match narrows, $group sums', async () => {
    const db = createMockDb();
    db.collection('t').__seed([
      { user: 'a', n: 5 }, { user: 'a', n: 7 }, { user: 'b', n: 100 },
    ]);
    const out = await db.collection('t').aggregate([
      { $match: { user: 'a' } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ]).toArray();
    expect(out).toEqual([{ _id: null, total: 12 }]);
  });

  test('an empty match returns NO documents, like real $group with _id:null', async () => {
    const db = createMockDb();
    db.collection('t').__seed([{ user: 'a', n: 5 }]);
    const out = await db.collection('t').aggregate([
      { $match: { user: 'nobody' } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ]).toArray();
    // real MongoDB returns [] here - the production code relies on agg[0] being undefined
    expect(out).toEqual([]);
    expect((out[0] && out[0].total) || 0).toBe(0);
  });

  test('$sum IGNORES non-numeric values, matching real MongoDB', async () => {
    const db = createMockDb();
    db.collection('t').__seed([
      { n: 10 }, { n: '90' }, { n: null }, { }, { n: 5 },
    ]);
    const out = await db.collection('t').aggregate([
      { $group: { _id: null, total: { $sum: '$n' } } },
    ]).toArray();
    // 10 + 5 only. A Number() coercion would wrongly give 105.
    expect(out[0].total).toBe(15);
  });

  test('$sum of a literal counts documents', async () => {
    const db = createMockDb();
    db.collection('t').__seed([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const out = await db.collection('t').aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]).toArray();
    expect(out[0].n).toBe(3);
  });

  test('range $match on Dates works, so date-bounded queries are really tested', async () => {
    const db = createMockDb();
    db.collection('t').__seed([
      { n: 1, date: new Date('2026-08-25T23:00:00Z') },
      { n: 2, date: new Date('2026-08-26T00:00:00Z') },
      { n: 4, date: new Date('2026-08-26T23:59:59Z') },
      { n: 8, date: new Date('2026-08-27T00:00:00Z') },
    ]);
    const out = await db.collection('t').aggregate([
      { $match: { date: { $gte: new Date('2026-08-26T00:00:00Z'), $lt: new Date('2026-08-27T00:00:00Z') } } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ]).toArray();
    expect(out[0].total).toBe(6);   // 2 + 4; boundaries are [inclusive, exclusive)
  });

  test('an unsupported $match OPERATOR throws instead of matching everything', () => {
    const db = createMockDb();
    db.collection('t').__seed([{ n: 1 }, { n: 2 }]);
    // $type used to fall through the matcher and match every document
    expect(() => db.collection('t').aggregate([{ $match: { n: { $type: 'number' } } }]))
      .toThrow(/unsupported operator \$type/);
  });

  test('an unsupported stage THROWS rather than silently returning everything', async () => {
    const db = createMockDb();
    db.collection('t').__seed([{ a: 1 }]);
    // thrown SYNCHRONOUSLY from aggregate(), before any promise exists
    expect(() => db.collection('t').aggregate([{ $lookup: { from: 'x' } }]))
      .toThrow(/unsupported stage/);
  });
});
