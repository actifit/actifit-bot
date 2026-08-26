/**
 * Challenge Engine F6 HTTP read routes (Trello #180) — real supertest coverage
 * on a bare Express app (no config/Firebase-bound server needed).
 */

const express = require('express');
const request = require('supertest');
const { createMockDb } = require('./helpers/mock-db');
const { registerArenaRoutes } = require('../arena_routes');

describe('arena_routes (HTTP)', () => {
  let db;
  let app;
  beforeEach(() => {
    db = createMockDb();
    db.collection('challenges').__seed([
      { id: 'ch1', type: 'duel', state: 'open', visibility: 'public', title: 'Open Duel' },
      { id: 'ch2', type: 'liveops', state: 'open', visibility: 'private', title: 'Secret' },
    ]);
    db.collection('challenge_participants').__seed([
      { challenge_id: 'ch1', entity: 'alice', flags: ['anticheat_review'], source: { trx_id: 't' } },
    ]);
    db.collection('standings').__seed([{ id: 'std1', scope: 'league', cohort: 'gold', rows: [] }]);
    db.collection('merits_ledger').__seed([{ user: 'alice', delta: 100, at: '2026-08-26T01:00:00Z' }]);
    db.collection('rewards_shop').__seed([{ id: 's1', stock: 5 }, { id: 's2', stock: 0 }]);
    db.collection('pools').__seed([{ id: 'p1', budget: 1000, paid: 100 }]);

    app = express();
    registerArenaRoutes(app, () => db);
  });

  test('GET /arena/challenges returns PUBLIC challenges only', async () => {
    const r = await request(app).get('/arena/challenges');
    expect(r.status).toBe(200);
    expect(r.body.map((c) => c.id)).toEqual(['ch1']);
  });

  test('GET /arena/challenges cannot force includeNonPublic via the query', async () => {
    const r = await request(app).get('/arena/challenges?includeNonPublic=true');
    expect(r.body.map((c) => c.id)).toEqual(['ch1']); // private still hidden
  });

  test('GET /arena/challenges?type=duel filters; injection value is ignored', async () => {
    expect((await request(app).get('/arena/challenges?type=duel')).body.map((c) => c.id)).toEqual(['ch1']);
    // ?type[$ne]=duel would exclude the duel if it reached Mongo; sanitized → still returns it
    expect((await request(app).get('/arena/challenges?type[$ne]=duel')).body.map((c) => c.id)).toEqual(['ch1']);
  });

  test('GET /arena/challenges/:id → 200 with flags projected out, 404 for unknown', async () => {
    const r = await request(app).get('/arena/challenges/ch1');
    expect(r.status).toBe(200);
    expect(r.body.challenge.title).toBe('Open Duel');
    expect(r.body.participants[0].flags).toBeUndefined();
    expect((await request(app).get('/arena/challenges/nope')).status).toBe(404);
  });

  test('GET /arena/standings by scope', async () => {
    const r = await request(app).get('/arena/standings?scope=league');
    expect(r.body.map((s) => s.id)).toEqual(['std1']);
  });

  test('GET /arena/merits/:user', async () => {
    const r = await request(app).get('/arena/merits/alice');
    expect(r.body).toMatchObject({ user: 'alice', balance: 100 });
  });

  test('GET /arena/shop and ?inStockOnly=true', async () => {
    expect((await request(app).get('/arena/shop')).body.length).toBe(2);
    expect((await request(app).get('/arena/shop?inStockOnly=true')).body.map((i) => i.id)).toEqual(['s1']);
  });

  test('GET /arena/pools/:id → 200 / 404', async () => {
    expect((await request(app).get('/arena/pools/p1')).body.paid).toBe(100);
    expect((await request(app).get('/arena/pools/nope')).status).toBe(404);
  });

  test('GET /arena/events/:user returns the feed', async () => {
    const r = await request(app).get('/arena/events/alice');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});
