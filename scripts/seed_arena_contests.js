/**
 * seed_arena_contests.js — index the six default Arena contests into the DB.
 *
 * This is the "index-only" seeding path from docs/arena-launch-runbook.md
 * (step 3a). It writes the official default challenges straight into the arena
 * index so /arena has something to show, WITHOUT broadcasting on-chain. It does
 * NOT require the @actifit posting key and does NOT need the tailer running.
 *
 * For the real launch, prefer the on-chain path (broadcast the ops from
 * arena_api.defaultContests(Date.now()) signed by @actifit, then let the tailer
 * index them). This script is for staging / first-visibility / demos.
 *
 * The operation is idempotent: the six contests use fixed ids, so re-running
 * re-indexes the same documents (no duplicates). Re-running after their windows
 * have passed refreshes the windows to `now`.
 *
 * Usage (run on a host with config.json + Mongo access, e.g. the app server):
 *   node scripts/seed_arena_contests.js            # seed
 *   node scripts/seed_arena_contests.js --dry      # print what would be seeded, write nothing
 *
 * Connection + official account are read from config.json, mirroring app.js.
 */

const { MongoClient } = require('mongodb');
const config = require('../config.json');
const arena = require('../arena.js');
const arenaApi = require('../arena_api.js');

const DRY = process.argv.slice(2).includes('--dry');
// --clear DELETES the six index-only default docs (the mandatory pre-step before
// the on-chain seed — indexArenaOp won't overwrite an existing id's provenance).
const CLEAR = process.argv.slice(2).includes('--clear');

(async () => {
	const url = config.testing ? config.mongo_local : config.mongo_uri;
	const officialAccount = config.arena_official_account || 'actifit';
	const nowMs = Date.now();
	const ids = arenaApi.defaultContests(nowMs).map(c => c.id);

	if (DRY) {
		if (CLEAR) {
			console.log(`[dry-run] would DELETE ${ids.length} default contest docs: ${ids.join(', ')}`);
		} else {
			console.log(`[dry-run] would seed ${ids.length} official contests as @${officialAccount}:`);
			for (const c of arenaApi.defaultContests(nowMs)) console.log(`  - ${c.id}  (${c.type})  ${c.title || ''}`);
		}
		console.log('[dry-run] no database writes performed.');
		return;
	}

	const client = new MongoClient(url);
	try {
		await client.connect();
		const db = client.db(config.db_name);

		if (CLEAR) {
			const r = await db.collection('challenges').deleteMany({ id: { $in: ids } });
			console.log(`cleared ${r.deletedCount} default contest doc(s): ${ids.join(', ')}`);
			return;
		}

		// Make sure the collections this touches are indexed (safe if app.js
		// already created them — index creation is idempotent).
		await arena.ensureArenaIndexes(db);

		const res = await arenaApi.seedDefaultContests(db, { officialAccount, nowMs });

		const summary = (res.results || []).map(r => ({
			id: r.id,
			ok: r.ok,
			noop: r.noop || false,
			reason: r.reason || undefined
		}));
		console.log(JSON.stringify(summary, null, 2));
		console.log(
			`\nseed complete as @${officialAccount}: ` +
			`ok=${res.ok} newly_seeded=${res.seeded} total=${summary.length}`
		);
		if (!res.ok) {
			process.exitCode = 1;
			console.error('one or more contests failed to seed — see reasons above.');
		}
	} finally {
		await client.close();
	}
})().catch(err => {
	console.error(err);
	process.exit(1);
});
