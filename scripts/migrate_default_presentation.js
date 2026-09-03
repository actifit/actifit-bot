/**
 * migrate_default_presentation.js — backfill the Trello #182 presentation
 * fields (tagline, how_it_works, prize_summary, recurrence, art) onto EXISTING
 * default-contest docs WITHOUT touching their windows or state.
 *
 * Use this to roll #182 out to the current index-only `def_*` docs when you are
 * NOT re-broadcasting on-chain (#183). A delete+reseed would recompute the
 * windows and shift active contests; a `$set` migration preserves them.
 *
 * Usage (host with config.json + Mongo access):
 *   node scripts/migrate_default_presentation.js --dry   # preview, no writes
 *   node scripts/migrate_default_presentation.js         # apply
 *
 * Idempotent: re-running just re-$sets the same display strings.
 */

const { MongoClient } = require('mongodb');
const config = require('../config.json');
const arenaApi = require('../arena_api.js');

const DRY = process.argv.slice(2).includes('--dry');
const FIELDS = ['tagline', 'how_it_works', 'prize_summary', 'recurrence', 'art'];

(async () => {
	// Pull the canonical copy straight from defaultContests (nowMs is irrelevant
	// here — we only read the display fields, never the windows).
	const patches = arenaApi.defaultContests(Date.now()).map((c) => {
		const set = {};
		for (const f of FIELDS) if (typeof c[f] === 'string' && c[f].trim()) set[f] = c[f];
		return { id: c.id, set };
	});

	if (DRY) {
		console.log('[dry-run] would $set presentation fields on:');
		for (const p of patches) console.log('  -', p.id, '=>', Object.keys(p.set).join(', '));
		return;
	}

	const client = new MongoClient(config.testing ? config.mongo_local : config.mongo_uri);
	try {
		await client.connect();
		const db = client.db(config.db_name);
		let updated = 0;
		for (const p of patches) {
			if (Object.keys(p.set).length === 0) { console.log(`  ${p.id}: no presentation fields — skipped`); continue; } // avoid an empty-$set throw
			const r = await db.collection('challenges').updateOne({ id: p.id }, { $set: p.set });
			console.log(`  ${p.id}: matched ${r.matchedCount}, modified ${r.modifiedCount}`);
			updated += r.modifiedCount || 0;
		}
		console.log(`\ndone — ${updated} doc(s) updated (missing ids are skipped; re-seed those first if needed).`);
	} finally {
		await client.close();
	}
})().catch((e) => { console.error(e); process.exit(1); });
