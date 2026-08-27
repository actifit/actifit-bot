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
});
