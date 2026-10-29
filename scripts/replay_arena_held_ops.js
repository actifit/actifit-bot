/**
 * Replay arena ops the tailer HELD for a posting-key rotation (arena_held_ops).
 *
 * The tailer does not index an op signed by an account under a key-rotation flag, or one
 * signed before a cleared account's key change (key_rotation.decideChainOp). An op the user
 * signed with the NEW key before logging in again (which is what clears the flag) is held
 * too. Once the flag is cleared with the key-change block recorded, such an op is allowed:
 * this script re-checks every held op against the CURRENT flag state and indexes the ones
 * now allowed, through the tailer's own indexArenaOp path (idempotent). Ops still not
 * allowed stay held. A replayed row is marked (replayed_at, replay_result) and never
 * replayed again.
 *
 * Replays run with the tier floor (the signer's moderator tier is not resolved here) and
 * without challenge funding, so a create that needs either is recorded as rejected; the
 * user can broadcast it again.
 *
 * Usage (on a host with config.json + Mongo access, e.g. the app server):
 *   node scripts/replay_arena_held_ops.js           # DRY RUN: lists what would be replayed
 *   node scripts/replay_arena_held_ops.js --apply   # index the allowed ops
 */

'use strict';

const { MongoClient } = require('mongodb');
const config = require('../config.json');
const keyRotation = require('../key_rotation');
const tailer = require('../arena_tailer');

const APPLY = process.argv.includes('--apply');

(async () => {
	const client = await MongoClient.connect(config.testing ? config.mongo_local : config.mongo_uri);
	try {
		const db = client.db(config.db_name);
		// only the flag lookup is used (checkChainOp); nothing here reads the chain
		const tracker = keyRotation.createTracker({
			getCollection: () => db.collection('key_rotation_required'),
			getAccount: async () => null,
			checkRotation: async () => ({ allowed: false, reason: 'chain_error' }),
			endSessions: async () => {},
		});
		const results = await tailer.replayHeldOps(db, {
			apply: APPLY,
			keyRotationCheck: tracker.checkChainOp,
			officialAccount: config.arena_official_account || config.account || 'actifit',
		});
		for (const r of results) {
			console.log([r.status.padEnd(12), String(r.block_num).padStart(10), r.trx_id, r.reason || (r.result && (r.result.action || r.result.reason)) || ''].join('  '));
		}
		const count = (st) => results.filter((r) => r.status === st).length;
		console.log((APPLY ? 'APPLIED' : 'DRY RUN') + ': ' + results.length + ' held op(s) checked - '
			+ (APPLY ? count('replayed') + ' replayed, ' + count('rejected') + ' rejected by the indexer, ' : count('would_replay') + ' would be replayed, ')
			+ count('still_held') + ' still held');
		if (!APPLY && count('would_replay')) console.log('Re-run with --apply to index them.');
	} finally {
		await client.close();
	}
})().catch((e) => { console.error(e); process.exit(1); });
