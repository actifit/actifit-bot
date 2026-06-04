/**
 * reconcile_deposits.js
 *
 * Finds AFIT deposits to actifit.h-e that were recorded in the token_transactions
 * ledger but never credited to the user's running balance (user_tokens.tokens),
 * caused by the wrong replaceOne filter ({ user: ... } instead of { _id: ... })
 * introduced in commit 7ba9bf2 (2026-02-12).
 *
 * For every affected user it compares:
 *   ledgerSum  = SUM(token_count) over all token_transactions for the user
 *   stored     = user_tokens.tokens (the running balance shown to the user)
 *
 * This is exactly what /recalculateUserTokens does. If ledgerSum > stored, the
 * user is missing credits (the stranded deposits live in the ledger already).
 *
 * USAGE:
 *   node scripts/reconcile_deposits.js                 # read-only report
 *   node scripts/reconcile_deposits.js --fix           # set tokens = ledgerSum for mismatched users
 *   node scripts/reconcile_deposits.js --since 2026-02-12   # window for the on-chain deposit scan
 *   node scripts/reconcile_deposits.js --tolerance 0.001    # ignore tiny float diffs (default 0.001)
 *
 * Read-only by default. --fix mirrors the existing /recalculateUserTokens logic
 * (balance := ledger sum), so it cannot double-credit and is idempotent.
 */

const { MongoClient } = require('mongodb');
const config = require('../config.json');

const args = process.argv.slice(2);
const DO_FIX = args.includes('--fix');
const getArg = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SINCE = getArg('--since', '2026-02-12');
const TOLERANCE = parseFloat(getArg('--tolerance', '0.001'));
const HE_ACCOUNT = config.hive_engine_actifit_he || 'actifit.h-e';
const HISTORY_URL = `https://history.hive-engine.com/accountHistory?account=${HE_ACCOUNT}&symbol=AFIT&limit=500`;
const INTERNAL = new Set([HE_ACCOUNT, 'actifit', 'afitx.h-e', 'actifit.tip']);

async function fetchDeposits(sinceTs) {
	const res = await fetch(HISTORY_URL);
	const rows = await res.json();
	return rows.filter(x =>
		x.to === HE_ACCOUNT &&
		x.symbol === 'AFIT' &&
		!INTERNAL.has(x.from) &&
		(x.timestamp || 0) >= sinceTs
	);
}

(async () => {
	const sinceTs = Math.floor(new Date(SINCE + 'T00:00:00Z').getTime() / 1000);
	const url = config.testing ? config.mongo_local : config.mongo_uri;
	const client = new MongoClient(url);

	try {
		await client.connect();
		const db = client.db(config.db_name);

		// 1. on-chain deposits in the window -> set of users who deposited
		const deposits = await fetchDeposits(sinceTs);
		const depositors = [...new Set(deposits.map(d => d.from))].sort();
		console.log(`On-chain AFIT deposits to ${HE_ACCOUNT} since ${SINCE}: ${deposits.length} from ${depositors.length} users\n`);

		// 2. for each depositor, compare ledger sum vs stored running balance
		const mismatches = [];
		for (const user of depositors) {
			const agg = await db.collection('token_transactions').aggregate([
				{ $match: { user } },
				{ $group: { _id: null, token_balance: { $sum: '$token_count' } } }
			]).toArray();
			let ledgerSum = agg.length ? parseFloat(agg[0].token_balance) : 0;
			if (ledgerSum < 0) ledgerSum = 0;

			const doc = await db.collection('user_tokens').findOne({ _id: user });
			const stored = doc ? parseFloat(doc.tokens) || 0 : 0;

			// did the in-window deposits actually land in the ledger?
			const userDeps = deposits.filter(d => d.from === user);
			const missingLedger = [];
			for (const d of userDeps) {
				const row = await db.collection('token_transactions').findOne({ user, se_trx_ref: d.transactionId });
				if (!row) missingLedger.push(d.transactionId);
			}

			const diff = ledgerSum - stored;
			if (Math.abs(diff) > TOLERANCE || missingLedger.length) {
				mismatches.push({ user, stored, ledgerSum, diff, missingLedger });
			}
		}

		// 3. report
		if (!mismatches.length) {
			console.log('No discrepancies found. All depositor balances match their ledger.');
		} else {
			console.log('USER                 STORED         LEDGER          DIFF   MISSING_LEDGER_ROWS');
			console.log('-'.repeat(92));
			for (const m of mismatches) {
				console.log(
					`${m.user.padEnd(20)} ${m.stored.toFixed(3).padStart(12)} ${m.ledgerSum.toFixed(3).padStart(13)} ${m.diff.toFixed(3).padStart(13)}   ${m.missingLedger.length ? m.missingLedger.join(',') : '-'}`
				);
			}
			console.log('-'.repeat(92));
			const totalUnderCredited = mismatches.filter(m => m.diff > 0).reduce((s, m) => s + m.diff, 0);
			console.log(`Users off: ${mismatches.length} | net under-credited (ledger>stored): ${totalUnderCredited.toFixed(3)} AFIT`);
			const anyMissing = mismatches.filter(m => m.missingLedger.length);
			if (anyMissing.length) {
				console.log(`\n⚠ ${anyMissing.length} user(s) have deposits with NO ledger row at all — those cannot be`);
				console.log(`  recovered by recalculation; they must be credited manually from the on-chain tx.`);
			}
		}

		// 4. optional fix: balance := ledger sum (same as /recalculateUserTokens)
		if (DO_FIX && mismatches.length) {
			console.log('\n--fix: setting user_tokens.tokens = ledgerSum for mismatched users...');
			for (const m of mismatches) {
				const doc = (await db.collection('user_tokens').findOne({ _id: m.user })) || { _id: m.user, name: m.user };
				doc.tokens = m.ledgerSum;
				await db.collection('user_tokens').replaceOne({ _id: m.user }, doc, { upsert: true });
				console.log(`  ${m.user}: ${m.stored.toFixed(3)} -> ${m.ledgerSum.toFixed(3)}`);
			}
			console.log('Done. (Users with missing ledger rows still need manual crediting.)');
		} else if (mismatches.length) {
			console.log('\nRead-only run. Re-run with --fix to apply, or call /recalculateUserTokens for each listed user.');
		}
	} finally {
		await client.close();
	}
})().catch(err => { console.error(err); process.exit(1); });
