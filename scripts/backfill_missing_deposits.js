/**
 * backfill_missing_deposits.js
 *
 * One-off recovery for AFIT deposits to actifit.h-e that were never processed
 * because /confirmAFITSEBulk was auth-gated on 2026-05-21 (commit e46d9db) while
 * the scheduler kept calling it without the admin_ops_token. Those deposits have
 * NO token_transactions ledger row and were never credited.
 *
 * This replicates exactly what /confirmAFITSEBulk does per entry:
 *   - insert ledger row { user, reward_activity:'Move AFIT HE to Actifit Wallet',
 *       token_count, se_trx_ref, exchange:'HE', date }
 *   - increment user_tokens.tokens by the deposit quantity (filter { _id: user })
 *
 * Idempotent: skips any deposit that already has a ledger row (se_trx_ref).
 *
 * USAGE:
 *   node scripts/backfill_missing_deposits.js            # DRY RUN (no writes)
 *   node scripts/backfill_missing_deposits.js --commit   # apply credits
 */

const { MongoClient } = require('mongodb');
const config = require('../config.json');

const COMMIT = process.argv.includes('--commit');
const SINCE = '2026-02-12';
const HE_ACCOUNT = config.hive_engine_actifit_he || 'actifit.h-e';
const HISTORY_URL = `https://history.hive-engine.com/accountHistory?account=${HE_ACCOUNT}&symbol=AFIT&limit=500`;
const INTERNAL = new Set([HE_ACCOUNT, 'actifit', 'afitx.h-e', 'actifit.tip']);

(async () => {
	const sinceTs = Math.floor(new Date(SINCE + 'T00:00:00Z').getTime() / 1000);
	const client = new MongoClient(config.testing ? config.mongo_local : config.mongo_uri);
	await client.connect();
	const db = client.db(config.db_name);

	try {
		const rows = await (await fetch(HISTORY_URL)).json();
		const deposits = rows
			.filter(x => x.to === HE_ACCOUNT && x.symbol === 'AFIT' && !INTERNAL.has(x.from) && (x.timestamp || 0) >= sinceTs)
			.sort((a, b) => a.timestamp - b.timestamp);

		console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} | scanning ${deposits.length} on-chain deposits since ${SINCE}\n`);

		let credited = 0, skipped = 0, totalAfit = 0;
		for (const d of deposits) {
			const user = d.from;
			const query = { user, se_trx_ref: d.transactionId };
			const existing = await db.collection('token_transactions').findOne(query);
			if (existing) { skipped++; continue; }

			const qty = parseFloat(d.quantity) || 0;
			const before = await db.collection('user_tokens').findOne({ _id: user });
			const beforeBal = before ? parseFloat(before.tokens) || 0 : 0;
			const afterBal = beforeBal + qty;

			console.log(`CREDIT ${user.padEnd(16)} +${qty.toFixed(3).padStart(11)}  ${beforeBal.toFixed(3)} -> ${afterBal.toFixed(3)}  (${d.transactionId})`);
			totalAfit += qty; credited++;

			if (COMMIT) {
				// 1. ledger row (mirrors handler shape)
				await db.collection('token_transactions').replaceOne(query, {
					user,
					reward_activity: 'Move AFIT HE to Actifit Wallet',
					token_count: qty,
					se_trx_ref: d.transactionId,
					exchange: 'HE',
					date: new Date(d.timestamp * 1000)
				}, { upsert: true });

				// 2. balance increment (keyed by _id)
				const doc = before || { _id: user, name: user, user, tokens: 0 };
				doc.tokens = afterBal;
				await db.collection('user_tokens').replaceOne({ _id: user }, doc, { upsert: true });
			}
		}

		console.log(`\n${COMMIT ? 'Applied' : 'Would credit'}: ${credited} deposit(s), ${totalAfit.toFixed(3)} AFIT | already-processed skipped: ${skipped}`);
		if (!COMMIT && credited) console.log('Re-run with --commit to apply.');
	} finally {
		await client.close();
	}
})().catch(e => { console.error(e); process.exit(1); });
