/**
 * broadcast_arena_contests.js — broadcast the six default contests ON-CHAIN
 * (Path B / Trello #183). Signs `actifit_arena` custom_json `challenge_create`
 * ops with @actifit's POSTING key so the tailer indexes them as the canonical
 * on-chain record (real trx_id/block_num), replacing the index-only seed.
 *
 * Prereqs in config.json: `posting_key` (@actifit posting authority),
 * `arena_official_account` (default "actifit"), a Hive node.
 *
 * Usage (on the server, with the real config.json):
 *   node scripts/broadcast_arena_contests.js --dry   # print, broadcast nothing
 *   node scripts/broadcast_arena_contests.js         # broadcast the 6 ops
 *
 * After it prints the block numbers, set in config.json:
 *   arena_tailer_start_block = <MIN block printed, minus a small margin>
 *   arena_tailer_enabled     = true
 * then restart the bot so the tailer indexes them.
 *
 * Recognition/goal contests only — no wagering (house rule).
 */

const dhive = require('@hiveio/dhive');
const config = require('../config.json');
const arena = require('../arena.js');
const arenaApi = require('../arena_api.js');

const DRY = process.argv.slice(2).includes('--dry');
const NODE = config.active_hive_node || (Array.isArray(config.alt_hive_nodes) && config.alt_hive_nodes[0]) || 'https://api.hive.blog';
const OFFICIAL = config.arena_official_account || config.account || 'actifit';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const contests = arenaApi.defaultContests(Date.now());

	if (DRY) {
		console.log(`[dry-run] would broadcast ${contests.length} actifit_arena challenge_create ops as @${OFFICIAL} via ${NODE}:`);
		for (const c of contests) console.log('  -', c.id, '|', c.type, '|', c.title);
		console.log('[dry-run] nothing broadcast.');
		return;
	}

	if (!config.posting_key) { console.error('config.posting_key is required to broadcast'); process.exit(1); }
	if (!/actifit/i.test(NODE)) {
		console.warn(`⚠️  Broadcasting via ${NODE} — NOT an Actifit node. These ops are irreversible; set config.active_hive_node to hiveapi.actifit.io to land via our own infra (house rule). Ctrl-C to abort.`);
	}
	const client = new dhive.Client(NODE);
	const key = dhive.PrivateKey.fromString(config.posting_key);

	const results = [];
	for (const body of contests) {
		try {
			const r = await client.broadcast.json({
				required_auths: [],
				required_posting_auths: [OFFICIAL],
				id: arena.ARENA_JSON_ID,
				json: JSON.stringify(body),
			}, key);
			results.push({ id: body.id, block: r.block_num });
			console.log('OK  ', body.id, 'trx', r.id, 'block', r.block_num);
		} catch (e) {
			console.error('FAIL', body.id, e && e.message);
			results.push({ id: body.id, error: e && e.message });
		}
		await wait(3000); // one op per ~block; be gentle on RC/nonce
	}

	const blocks = results.filter((r) => r.block).map((r) => r.block);
	const failed = results.filter((r) => r.error);
	if (blocks.length) {
		const min = Math.min(...blocks);
		console.log(`\n${blocks.length}/${contests.length} broadcast. Next, in config.json:`);
		console.log(`  arena_tailer_start_block = ${min}   (or a few blocks earlier)`);
		console.log('  arena_tailer_enabled     = true');
		console.log(`  arena_official_account   = "${OFFICIAL}"`);
		console.log('then restart the bot; the tailer will index these with real trx_id/block_num.');
	}
	if (failed.length) { process.exitCode = 1; console.error(`${failed.length} failed — see FAIL lines above.`); }
})().catch((e) => { console.error(e); process.exit(1); });
