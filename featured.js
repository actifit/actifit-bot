/**
 * Featured Actifitter — "Actifitter of the Month" spotlight (Trello #110).
 *
 * A single editorial document (a recognition/social-proof spotlight of one real
 * user: photo, testimonial, key stats, CTA), served read-only to every client.
 * The web home page renders it and hides the section when nothing is set.
 *
 * This is recognition only — NOT a competition payout or wager (house rule).
 * The pick is editorial; stats are a snapshot captured when it is set (monthly).
 *
 * Load-time safe: requires nothing config/Firebase-bound.
 */

'use strict';

const COLLECTION = 'featured_actifitter';
const DOC_ID = 'current'; // single-doc collection, fixed id

function str(v, max = 2000) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Keep only known public fields (defensive — the doc is editorial/ours, but the
// read is public so we never echo internal bookkeeping).
function sanitizeFeatured(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.visible === false) return null;
  const s = doc.stats && typeof doc.stats === 'object' ? doc.stats : {};
  const stats = {};
  for (const k of ['rank', 'activity_count', 'afit', 'months_active']) {
    const v = num(s[k]);
    if (v !== undefined) stats[k] = v;
  }
  const out = {
    username: str(doc.username, 40),
    display_name: str(doc.display_name, 80),
    photo_url: str(doc.photo_url, 500),
    testimonial: str(doc.testimonial, 2000),
    cta: str(doc.cta, 200),
    month: str(doc.month, 7), // YYYY-MM
    stats
  };
  // A spotlight without a user is not renderable.
  if (!out.username) return null;
  return out;
}

/** The current featured Actifitter (public, sanitized) or null when unset. */
async function getFeaturedActifitter(db) {
  const doc = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
  return sanitizeFeatured(doc);
}

/** Upsert the single featured document. `data` is editorial input + stats. */
async function setFeaturedActifitter(db, data = {}) {
  const now = new Date().toISOString();
  const doc = {
    username: str(data.username, 40),
    display_name: str(data.display_name, 80) || str(data.username, 40),
    photo_url: str(data.photo_url, 500),
    testimonial: str(data.testimonial, 2000),
    cta: str(data.cta, 200),
    month: str(data.month, 7),
    stats: (data.stats && typeof data.stats === 'object') ? data.stats : {},
    visible: data.visible !== false,
    updated_at: now
  };
  if (!doc.username) return { ok: false, reason: 'username is required' };
  await db.collection(COLLECTION).updateOne(
    { _id: DOC_ID },
    { $set: doc, $setOnInsert: { _id: DOC_ID, created_at: now } },
    { upsert: true }
  );
  return { ok: true, username: doc.username };
}

// The single-doc collection needs no special indexes (keyed by _id). Kept for
// symmetry with the other modules' ensure*Indexes and future-proofing.
async function ensureFeaturedIndexes(_db) {
  return;
}

module.exports = {
  COLLECTION,
  DOC_ID,
  sanitizeFeatured,
  getFeaturedActifitter,
  setFeaturedActifitter,
  ensureFeaturedIndexes
};
