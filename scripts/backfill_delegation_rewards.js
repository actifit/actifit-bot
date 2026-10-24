/**
 * One-off catch-up for delegator AFIT rewards on days the daily job did not run.
 *
 * Each day's rows are dated at UTC midnight of the run day (the 08:00 run on 10-22 writes
 * rows dated 2026-10-22T00:00Z, for 10-21). This script computes the same rows, with the
 * same checks as the daily job, for each run day in --from..--to that has no Delegation
 * rows yet. A day that already has rows is skipped, so running it twice pays nothing twice.
 *
 * Dry run by default: it prints what it would pay and writes nothing.
 *
 *   node scripts/backfill_delegation_rewards.js --from 2026-10-22 --to 2026-10-24
 *   node scripts/backfill_delegation_rewards.js --from 2026-10-22 --to 2026-10-24 --apply
 *
 * --apply first syncs the stored delegations from chain (as the 08:00 run does), then writes
 * the rows and rebuilds balances once. Run it on the delegations box, from the bot folder,
 * while the delegations process is stopped, and not between 07:45 and 08:15 UTC.
 */
process.env.DELEGATIONS_NO_BOOT = '1';

const moment = require('moment');
const d = require('../delegations');

function arg(name) {
	const i = process.argv.indexOf('--' + name);
	return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
	const apply = process.argv.includes('--apply');
	const from = arg('from');
	const to = arg('to');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
		throw new Error('usage: --from YYYY-MM-DD --to YYYY-MM-DD [--apply]');
	}
	const now = moment.utc();
	const minutes = now.hours() * 60 + now.minutes();
	if (minutes >= 7 * 60 + 45 && minutes <= 8 * 60 + 15) throw new Error('too close to the 08:00 UTC daily run; try again after 08:15');

	const days = 2; // same window as the daily job
	const runDays = [];
	for (let m = moment.utc(from).startOf('day'); !m.isAfter(moment.utc(to).startOf('day')); m.add(1, 'day')) {
		if (m.isAfter(now)) break;
		runDays.push(m.clone());
	}

	const db = await d.connectRewardsDb();
	await d.updateProperties();

	if (apply) {
		console.log('Syncing delegations from chain...');
		await d.processDelegations(d.hiveClient, d.hive_history_limit, [], d.hiveDelegationTrxCol, d.hiveActDelgCol, require('../utils').getConfig().account, -1, 0);
	}

	let wrote = 0;
	for (const m of runDays) {
		const end = m.toDate();
		const existing = await db.collection('token_transactions').countDocuments({ reward_activity: /^Delegation/, date: end });
		if (existing > 0) { console.log(m.format('YYYY-MM-DD') + ': already has ' + existing + ' rows, skipped'); continue; }
		const start = m.clone().subtract(days, 'days').toDate();
		const r = await d.computeDelegationRewards('HIVE', d.hiveClient, d.hiveDelegationTrxCol, d.hiveActDelgCol, start, end, days);
		console.log(m.format('YYYY-MM-DD') + ': ' + r.rows.length + ' payees, ' + r.total.toFixed(3) + ' AFIT (limit ' + r.maxTotal.toFixed(3) + '), skipped ' + r.skipped.length + ', capped ' + r.capped.length + (apply ? '' : '  [dry run]'));
		if (apply) {
			await Promise.all(r.rows.map(d.upsertRewardTransaction));
			wrote += r.rows.length;
		}
	}
	if (apply && wrote) {
		await d.updateUserTokens();
	}
	console.log(apply ? 'Done: wrote ' + wrote + ' rows.' : 'Dry run done: nothing written. Add --apply to pay.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Stopped, nothing more written: ' + e.message); process.exit(1); });
