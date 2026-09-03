/**
 * Actifitter of the Month (Trello #110) — unit tests for featured.js.
 * Dependency-injected (takes `db`), no config/Firebase — runs on the mock DB.
 */

const { createMockDb } = require('./helpers/mock-db');
const featured = require('../featured');

describe('featured.sanitizeFeatured', () => {
  it('returns null without a username, and when hidden', () => {
    expect(featured.sanitizeFeatured(null)).toBeNull();
    expect(featured.sanitizeFeatured({})).toBeNull();
    expect(featured.sanitizeFeatured({ username: 'a', visible: false })).toBeNull();
  });

  it('keeps only public fields and coerces numeric stats', () => {
    const out = featured.sanitizeFeatured({
      _id: 'current', username: 'jane', display_name: 'Jane', photo_url: 'https://x/y.jpg',
      testimonial: 'hi', cta: 'join', month: '2026-08',
      stats: { rank: '12', activity_count: 350000, afit: '1.5', months_active: 18, bogus: 'x' },
      internal: 'secret', updated_at: 'now'
    });
    expect(out).toEqual({
      username: 'jane', display_name: 'Jane', photo_url: 'https://x/y.jpg',
      testimonial: 'hi', cta: 'join', month: '2026-08',
      stats: { rank: 12, activity_count: 350000, afit: 1.5, months_active: 18 }
    });
    expect(out.internal).toBeUndefined();
    expect(out.stats.bogus).toBeUndefined();
  });

  it('drops non-finite stats rather than emitting NaN', () => {
    const out = featured.sanitizeFeatured({ username: 'j', stats: { rank: 'abc', afit: 10 } });
    expect(out.stats).toEqual({ afit: 10 });
  });

  it('only accepts an absolute http(s) photo_url', () => {
    expect(featured.sanitizeFeatured({ username: 'j', photo_url: 'https://x/y.jpg' }).photo_url).toBe('https://x/y.jpg');
    expect(featured.sanitizeFeatured({ username: 'j', photo_url: 'javascript:alert(1)' }).photo_url).toBeUndefined();
    expect(featured.sanitizeFeatured({ username: 'j', photo_url: '/relative.jpg' }).photo_url).toBeUndefined();
  });

  it('clamps over-long strings', () => {
    const long = 'x'.repeat(5000);
    expect(featured.sanitizeFeatured({ username: 'j', testimonial: long }).testimonial.length).toBe(2000);
    expect(featured.sanitizeFeatured({ username: ('u').repeat(60) }).username.length).toBe(40);
  });
});

describe('featured set/get round-trip', () => {
  it('upserts then reads back the sanitized doc', async () => {
    const db = createMockDb();
    const res = await featured.setFeaturedActifitter(db, {
      username: 'jane', display_name: 'Jane Doe', photo_url: 'https://x/y.jpg',
      testimonial: 'Actifit changed my life', cta: 'Join Jane!', month: '2026-08',
      stats: { rank: 12, afit: 15400 }
    });
    expect(res.ok).toBe(true);
    const got = await featured.getFeaturedActifitter(db);
    expect(got.username).toBe('jane');
    expect(got.display_name).toBe('Jane Doe');
    expect(got.stats).toEqual({ rank: 12, afit: 15400 });
    // no internal fields leak to the public read
    expect(got.visible).toBeUndefined();
    expect(got.updated_at).toBeUndefined();
  });

  it('defaults display_name to username and requires a username', async () => {
    const db = createMockDb();
    expect((await featured.setFeaturedActifitter(db, {})).ok).toBe(false);
    await featured.setFeaturedActifitter(db, { username: 'bob' });
    expect((await featured.getFeaturedActifitter(db)).display_name).toBe('bob');
  });

  it('returns null when nothing is set', async () => {
    const db = createMockDb();
    expect(await featured.getFeaturedActifitter(db)).toBeNull();
  });

  it('a second set overwrites the single doc (not a duplicate)', async () => {
    const db = createMockDb();
    await featured.setFeaturedActifitter(db, { username: 'alice' });
    await featured.setFeaturedActifitter(db, { username: 'carol' });
    expect((await featured.getFeaturedActifitter(db)).username).toBe('carol');
    const all = await db.collection(featured.COLLECTION).find({}).toArray();
    expect(all.length).toBe(1);
  });

  it('a hidden (visible:false) spotlight reads back as null', async () => {
    const db = createMockDb();
    await featured.setFeaturedActifitter(db, { username: 'jane', visible: false });
    expect(await featured.getFeaturedActifitter(db)).toBeNull();
  });

  it('sanitizes stats on write (drops garbage/dotted keys before Mongo)', async () => {
    const db = createMockDb();
    await featured.setFeaturedActifitter(db, { username: 'jane', stats: { rank: 3, 'a.b': 1, $x: 2, junk: 'no' } });
    expect((await featured.getFeaturedActifitter(db)).stats).toEqual({ rank: 3 });
    const stored = await db.collection(featured.COLLECTION).findOne({ _id: 'current' });
    expect(Object.keys(stored.stats)).toEqual(['rank']); // dotted/$ keys never stored
  });
});

describe('featured.pullStats (api2 field mapping)', () => {
  const ok = (data) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });

  it('maps getRank->user_rank->rank and user->tokens->afit, hitting the right URLs', async () => {
    const calls = [];
    const fetchImpl = (url) => {
      calls.push(url);
      if (url.includes('getRank/')) return ok({ user_rank: 12 });
      if (url.includes('user/')) return ok({ tokens: 15400 });
      return Promise.resolve({ ok: false });
    };
    const stats = await featured.pullStats('https://api2.actifit.io/', 'Jane', fetchImpl);
    expect(stats).toEqual({ rank: 12, afit: 15400 });
    expect(calls[0]).toBe('https://api2.actifit.io/getRank/Jane');
    expect(calls[1]).toBe('https://api2.actifit.io/user/jane'); // user endpoint lowercased
  });

  it('drops a stat when its response is not ok or the field is missing/non-numeric', async () => {
    const fetchImpl = (url) => url.includes('getRank/')
      ? Promise.resolve({ ok: false })
      : ok({ tokens: 'not-a-number' });
    expect(await featured.pullStats('https://x/', 'bob', fetchImpl)).toEqual({});
  });

  it('is best-effort: a throwing fetch yields the partial/empty result, never rejects', async () => {
    const fetchImpl = (url) => url.includes('getRank/') ? ok({ user_rank: 3 }) : Promise.reject(new Error('down'));
    expect(await featured.pullStats('https://x/', 'jane', fetchImpl)).toEqual({ rank: 3 });
  });

  it('returns {} with no username or no fetch impl', async () => {
    expect(await featured.pullStats('https://x/', '', () => ok({}))).toEqual({});
    expect(await featured.pullStats('https://x/', 'jane', null)).toEqual({});
  });
});

describe('featured route (HTTP)', () => {
  const express = require('express');
  const request = require('supertest');

  const appWith = (db) => {
    const app = express();
    featured.registerFeaturedRoute(app, () => db);
    return app;
  };

  it('GET /featuredActifitter returns the sanitized doc', async () => {
    const db = createMockDb();
    await featured.setFeaturedActifitter(db, { username: 'jane', display_name: 'Jane', stats: { rank: 5 } });
    const r = await request(appWith(db)).get('/featuredActifitter');
    expect(r.status).toBe(200);
    expect(r.body.username).toBe('jane');
    expect(r.body.stats).toEqual({ rank: 5 });
    expect(r.body.visible).toBeUndefined(); // internal fields never leak over HTTP
  });

  it('GET /featuredActifitter returns null (200) when nothing is set', async () => {
    const r = await request(appWith(createMockDb())).get('/featuredActifitter');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });

  it('GET /featuredActifitter returns 500 on a driver error, not a crash', async () => {
    const brokenDb = { collection: () => ({ findOne: () => { throw new Error('db down'); } }) };
    const r = await request(appWith(brokenDb)).get('/featuredActifitter');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'featured_actifitter' });
  });
});
