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
