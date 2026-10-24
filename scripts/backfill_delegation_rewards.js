/**
 * One-off catch-up for delegator AFIT rewards on days the daily job did not run.
 *
 * Each day's rows are dated at UTC midnight of the run day (the 08:00 run on 10-22 writes
 * rows dated 2026-10-22T00:00Z, for 10-21). This script computes the same rows, with the
 * same checks as the daily job, for each run day in --from..--to.
 * If any day in the range already has Delegation rows, it stops before writing anything
 * and lists them: those days were not expected to have rows, so look at them first.
 * The range must start on or after 2026-10-22 (the pause) and cover at most 7 days.
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
	if (moment.utc(from).isBefore(moment.utc('2026-10-22'))) throw new Error('--from must be 2026-10-22 or later');
	if (moment.utc(to).diff(moment.utc(from), 'days') > 6) throw new Error('at most 7 days per run');
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

	const already = [];
	for (const m of runDays) {
		const n = await db.collection('token_transactions').countDocuments({ reward_activity: /^Delegation/, date: m.toDate() });
		if (n > 0) already.push(m.format('YYYY-MM-DD') + ' (' + n + ' rows)');
	}
	if (already.length) throw new Error('these days already have Delegation rows, nothing written: ' + already.join(', '));

	if (apply) {
		console.log('Syncing delegations from chain...');
		await d.processDelegations(d.hiveClient, d.hive_history_limit, [], d.hiveDelegationTrxCol, d.hiveActDelgCol, require('../utils').getConfig().account, -1, 0);
	}

	let wrote = 0;
	try {
	for (const m of runDays) {
		const end = m.toDate();
		const start = m.clone().subtract(days, 'days').toDate();
		const r = await d.computeDelegationRewards('HIVE', d.hiveClient, d.hiveDelegationTrxCol, d.hiveActDelgCol, start, end, days);
		console.log(m.format('YYYY-MM-DD') + ': ' + r.rows.length + ' payees, ' + r.total.toFixed(3) + ' AFIT (limit ' + r.maxTotal.toFixed(3) + '), skipped ' + r.skipped.length + ', capped ' + r.capped.length + (apply ? '' : '  [dry run]'));
		if (apply) {
			await Promise.all(r.rows.map(d.upsertRewardTransaction));
			wrote += r.rows.length;
		}
	}
	} finally {
		// rebuild balances for whatever was written, even if a later day stopped the run
		if (apply && wrote) await d.updateUserTokens();
	}
	console.log(apply ? 'Done: wrote ' + wrote + ' rows.' : 'Dry run done: nothing written. Add --apply to pay.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Stopped, nothing more written: ' + e.message); process.exit(1); });
