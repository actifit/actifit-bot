/**
 * Challenge Engine — F1 live tailer (Trello #175, epic #171).
 *
 * Streams Hive blocks, extracts `actifit_arena` custom_json ops, and feeds each
 * to `arena.indexArenaOp` — turning the validated indexer (arena.js) into a
 * running, resumable chain tailer. This is the last piece of F1's DoD.
 *
 * Structure (pure core → runnable loop, so the logic is unit-testable):
 *   - extractArenaOps(block, blockNum)  — pull the arena ops out of a raw block
 *   - processArenaBlock(db, block, n)   — apply one block's ops to the index
 *   - catchUpOnce(db, hiveClient)       — resume from the saved cursor to head
 *   - startArenaTailer(db, opts)        — schedule catchUpOnce on an interval
 *
 * Progress is persisted in `arena_tailer_state` ({_id:'cursor', block_num}) so a
 * restart resumes where it left off; re-processing a block is safe because
 * indexArenaOp is idempotent (a re-tailed op returns {ok:true, noop:true}).
 *
 * Load-time safe: requires only `arena` (no config/Firebase) and `@hiveio/dhive`
 * (a library). No hive client is built until startArenaTailer() runs.
 */

'use strict';

const dhive = require('@hiveio/dhive');
const arena = require('./arena');

const TAILER_STATE = 'arena_tailer_state';
const CURSOR_ID = 'cursor';
const DEFAULT_NODES = ['https://api.hive.blog', 'https://api.deathwing.me'];

/**
 * Pull the `actifit_arena` custom_json ops out of a raw Hive block, shaped as
 * the chainOp objects indexArenaOp expects.
 */
function extractArenaOps(block, blockNum) {
	const out = [];
	if (!block || !Array.isArray(block.transactions)) return out;
	const ids = Array.isArray(block.transaction_ids) ? block.transaction_ids : [];
	block.transactions.forEach((tx, i) => {
		const ops = (tx && Array.isArray(tx.operations)) ? tx.operations : [];
		for (const op of ops) {
			if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
			const payload = op[1] || {};
			if (payload.id !== arena.ARENA_JSON_ID) continue;
			out.push({
				id: payload.id,
				json: payload.json,
				required_posting_auths: payload.required_posting_auths || [],
				required_auths: payload.required_auths || [],
				trx_id: ids[i] || null,
				block_num: blockNum,
				timestamp: block.timestamp || null,
			});
		}
	});
	return out;
}

/** Apply every arena op in one block to the index. Returns the per-op results. */
async function processArenaBlock(db, block, blockNum, opts = {}) {
	const chainOps = extractArenaOps(block, blockNum);
	const results = [];
	for (const chainOp of chainOps) {
		const res = await arena.indexArenaOp(db, chainOp, opts);
		results.push({ trx_id: chainOp.trx_id, ...res });
		if (typeof opts.log === 'function') {
			const status = res.ok ? `${res.action}${res.noop ? ' (noop)' : ''}` : `REJECTED ${res.reason}`;
			opts.log(`arena blk ${blockNum} ${chainOp.trx_id}: ${status}`);
		}
	}
	return results;
}

async function loadCursor(db, startBlock) {
	const doc = await db.collection(TAILER_STATE).findOne({ _id: CURSOR_ID });
	return (doc && Number.isInteger(doc.block_num)) ? doc.block_num : (startBlock || 0);
}

async function saveCursor(db, blockNum) {
	await db.collection(TAILER_STATE).replaceOne(
		{ _id: CURSOR_ID },
		{ _id: CURSOR_ID, block_num: blockNum, updated_at: new Date() },
		{ upsert: true }
	);
}

/**
 * Process every block from the saved cursor up to the current head (bounded to
 * `maxBlocksPerTick`), persisting the cursor after each block so a crash resumes
 * cleanly. Returns { from, to, processed }.
 */
async function catchUpOnce(db, hiveClient, opts = {}) {
	const maxBatch = opts.maxBlocksPerTick || 100;
	const cursor = await loadCursor(db, opts.startBlock || 0);
	const head = await hiveClient.blockchain.getCurrentBlockNum();
	if (!Number.isInteger(head) || head <= cursor) {
		return { from: cursor + 1, to: cursor, processed: 0 };
	}
	const target = Math.min(head, cursor + maxBatch);
	let processed = 0;
	for (let n = cursor + 1; n <= target; n++) {
		const block = await hiveClient.database.getBlock(n);
		if (!block) break; // not available yet — stop, retry next tick
		await processArenaBlock(db, block, n, opts);
		await saveCursor(db, n);
		processed++;
	}
	return { from: cursor + 1, to: cursor + processed, processed };
}

/**
 * Start the resumable tailer on a polling interval. Config-gated by the CALLER
 * (app.js only calls this when config.arena_tailer_enabled is set), so it never
 * auto-starts in production without an explicit opt-in.
 * @returns a handle with .stop().
 */
function startArenaTailer(db, opts = {}) {
	const hiveClient = opts.hiveClient || new dhive.Client(opts.nodes || DEFAULT_NODES);
	const pollMs = opts.pollMs || 3000;
	const handle = { stopped: false, timer: null };

	arena.ensureArenaIndexes(db).catch((e) => {
		if (typeof opts.log === 'function') opts.log(`ensureArenaIndexes failed: ${e.message}`);
	});

	const tick = async () => {
		if (handle.stopped) return;
		try {
			await catchUpOnce(db, hiveClient, opts);
		} catch (e) {
			if (typeof opts.log === 'function') opts.log(`arena tailer tick error: ${e.message}`);
		}
		if (!handle.stopped) handle.timer = setTimeout(tick, pollMs);
	};

	handle.timer = setTimeout(tick, pollMs);
	handle.stop = () => { handle.stopped = true; if (handle.timer) clearTimeout(handle.timer); };
	return handle;
}

module.exports = {
	TAILER_STATE,
	extractArenaOps,
	processArenaBlock,
	loadCursor,
	saveCursor,
	catchUpOnce,
	startArenaTailer,
};
