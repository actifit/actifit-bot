/**
 * seed_featured_actifitter.js — set the "Actifitter of the Month" spotlight
 * (Trello #110). Run monthly by an editor with server + DB access.
 *
 * Reads an editorial JSON payload (see featured_actifitter.example.json):
 *   { username, display_name, photo_url, testimonial, cta, month, stats?, visible? }
 * and upserts the single featured document consumed by GET /featuredActifitter.
 *
 * With --pull-stats, rank + AFIT are fetched from the public api2 endpoints for
 * the username and merged UNDER any stats provided in the file (file wins), so
 * you can auto-fill the machine stats and type in the editorial ones.
 *
 * Usage (on a host with config.json + Mongo access):
 *   node scripts/seed_featured_actifitter.js --file path/to/payload.json [--pull-stats]
 *   node scripts/seed_featured_actifitter.js --file payload.json --dry   # preview, no write
 *
 * Recognition/social-proof only — never a payout or wager (house rule).
 */

const fs = require('fs');
const { MongoClient } = require('mongodb');
const config = require('../config.json');
const featured = require('../featured.js');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getArg = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const FILE = getArg('--file', args.find((a) => a.endsWith('.json')));
const DRY = has('--dry');
const PULL = has('--pull-stats');
const API_BASE = (config.api_url || 'https://api2.actifit.io/').replace(/\/?$/, '/');

(async () => {
	if (!FILE || !fs.existsSync(FILE)) {
		console.error('Provide an editorial payload: --file path/to/payload.json (see scripts/featured_actifitter.example.json)');
		process.exit(1);
	}
	const payload = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	if (!payload.username) { console.error('payload.username is required'); process.exit(1); }

	if (PULL) {
		const auto = await featured.pullStats(API_BASE, payload.username);
		payload.stats = { ...auto, ...(payload.stats || {}) }; // file-provided stats win
		console.log('pulled stats for @' + payload.username + ':', JSON.stringify(auto));
	}

	if (DRY) {
		console.log('[dry-run] would set featured Actifitter:');
		console.log(JSON.stringify({ ...payload, stats: payload.stats || {} }, null, 2));
		return;
	}

	const client = new MongoClient(config.testing ? config.mongo_local : config.mongo_uri);
	try {
		await client.connect();
		const db = client.db(config.db_name);
		const res = await featured.setFeaturedActifitter(db, payload);
		if (!res.ok) { console.error('failed:', res.reason); process.exitCode = 1; return; }
		console.log('featured Actifitter set -> @' + res.username + (payload.month ? ' (' + payload.month + ')' : ''));
		console.log('verify: GET ' + API_BASE + 'featuredActifitter');
	} finally {
		await client.close();
	}
})().catch((err) => { console.error(err); process.exit(1); });
