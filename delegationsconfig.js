// pm2 ecosystem config for the DELEGATIONS process.
//
// *** api2.actifit.io ONLY. ***
//
// This file is deployed to BOTH boxes (deploy.yml pushes to SERVER1_HOST and
// SERVER2_HOST alike), but only ONE box may ever run it. Two `delegations` workers
// on two boxes share one MongoDB, one Hive posting key and one BSC bridge wallet,
// and the per-box `pm2 status` check below cannot detect that - on the wrong box the
// name check passes trivially, because nothing of that name is running there.
//
// Start it with:
//   cd /home/actifit-bot
//   pm2 delete delegations
//   pm2 start delegationsconfig.js
//   pm2 save                       # REQUIRED, or a reboot loses the env again
//   pm2 logs delegations --lines 30 --nostream
//
// That last line is the verification, and it is not optional. delegations.js prints
// '>>>>>>>>>MAIN DELEGATION THREAD<<<<<<<<<<<' when the env took effect, so look for
// it. `pm2 status` will NOT tell you - it shows name/pid/uptime, never the
// environment, so a green row proves only that something started. A process that came
// up WITHOUT BOT_THREAD does not sit idle waiting to be noticed - see the analysis
// below for what it does instead, and how much it matters.
//
// Adopt it OUTSIDE 07:50-11:10 UTC and away from the :03-:57 BSC ticks. node-schedule
// does not backfill a missed fire, and reward rows are stamped with the run's own date
// (delegations.js writes `date: today startOf date`), so a job whose clock time lands
// in the delete/start gap is a SKIPPED DAY, not a deferred one.
//
// Before deleting, capture what pm2 currently holds:
//   pm2 env <id>                   # `pm2 describe` does NOT list the variables
// `pm2 delete` discards every variable that lives only in pm2's stored state, which
// is exactly how BOT_THREAD went missing on the api boxes. Diff that output against
// this file and add anything missing here FIRST.
//
// What the settings below are actually protecting:
//
// BOT_THREAD='MAIN' selects the scheduler branch in delegations.js - the 08:00
// delegator rewards, the 10:00 AFIT-to-Hive-Engine move, the 11:00 delegation
// cancellation, the 00:01 gadget buy prize, and processBSCTransfers every 3 minutes.
//
// If it is absent the process neither goes quiet nor pays anyone. The `else` at the end
// of the bootstrap calls `runRewards(false, false)` immediately at boot - the same entry
// point the weekly local run uses (see below). It:
//
//   - recomputes today's off-chain AFIT delegator rows via upsertRewardTransaction,
//     a keyed replaceOne(upsert) on {user, chain, date, reward_activity, orig_account}
//     - so it OVERWRITES today's rows rather than doubling them - and then
//     updateUserTokens() rebuilds user_tokens from them;
//   - on a MONDAY only, runs processSteemRewards, which computes HIVE/HBD amounts and
//     writes them to HIVErewards<date>.json. There is no transfer code in it at all -
//     only a commented-out SteemConnect signing-URL builder and a mail send. The file
//     IS the deliverable; the transfers are done by hand afterwards;
//   - installs TWO timers: setInterval(claimRewards, 1h) and
//     setInterval(loadSteemPrices, 5min). Both accumulate per invocation, along with a
//     fresh MongoClient, for as long as the process lives. See the claimRewards note
//     below - it is NOT benign.
//
// NO OUTWARD TRANSFER IS REACHABLE on this path - nothing pays a delegator, no BSC
// send, no Hive-Engine op. The only broadcast anywhere in the source is a
// SELF-DIRECTED claim_reward_balance for config.full_pay_benef_account (actifit.funds)
// inside claimRewards, and see below for why it cannot currently even get that far.
//
// But do NOT round that off to "harmless". The wrong rows are PERMANENT:
//
//   - the upsert key includes `date`, set to today's UTC midnight, so tomorrow's 08:00
//     run writes date=D+1 and NEVER revisits date=D;
//   - updateUserTokens() is a $group sum over ALL of token_transactions with
//     $out: user_tokens, so every future rebuild re-derives balances from the poisoned
//     row.
//
// So a bad row written today is baked into displayed balances indefinitely - UNLESS the
// accidental start was before 08:00 UTC, in which case that day's scheduled pass writes
// the same date key with a fresh snapshot and overwrites it. After 08:00, repair is
// manual; the runbook has the procedure.
//
// claimRewards IS BROKEN, and it is a latent process-killer rather than a no-op.
// It reads reward_steem_balance / reward_sbd_balance, which DO NOT EXIST on a Hive
// account object (verified on chain: hiveapi.actifit.io returns neither field for
// actifit.funds). utils.js uses the correct reward_hive_balance / reward_hbd_balance,
// with the STEEM names commented out beside them, so the right names are known here.
//
// The consequence depends on the account's pending rewards:
//
//   - all three balances 0 -> parseFloat(undefined) is NaN, NaN > 0 is false, so the
//     guard fails and it logs "no rewards to claim for now". Harmless. This is the
//     CURRENT state - actifit.funds reads 0.000 HIVE / 0.000 HBD / 0.000000 VESTS as
//     of 2026-09-28, which is why nothing is visibly wrong today.
//   - any pending reward_vesting_balance -> the guard passes on that third term, and
//     the very next line does .split(' ') on the ABSENT reward_steem_balance and throws
//     TypeError. claimRewards is async and called from setInterval with no .catch, and
//     nothing in delegations.js installs an unhandledRejection handler, so on Node 20
//     (package.json pins 20.x) that terminates the process.
//
// Expected shape if it ever fires: the timer is only installed by runRewards, which on
// MAIN is called by the 08:00 job - so roughly ONE crash a day, an hour or so after
// 08:00, followed by a pm2 restart. Not an hourly loop, because a restarted MAIN
// process only re-schedules 08:00 and does not call runRewards again. Check
// `pm2 describe delegations` for a restart count that climbs about once a day.
//
// Tracked as issue #109, with the on-chain verification and the fix. Do not
// rediagnose it from this comment.
//
// THE MANUAL RUN IS DELIBERATE AND IN USE, BUT IT DOES NOT HAPPEN ON THIS BOX.
// Delegator rewards autorun daily here under MAIN. The HIVE/HBD rewards file is
// generated MANUALLY once per week, on a Monday, from a LOCAL dev machine - not from
// api2 - through this same else branch (`npm run delegate`, no BOT_THREAD set).
//
// So on THIS box the else branch has no legitimate use: every way of reaching it here
// is an accident. Do not "fix" it into a no-op anyway - that would break the local
// weekly run, which is what it exists for.
//
// That weekly run is NOT read-only: startProcess writes token_transactions and rebuilds
// user_tokens BEFORE it reaches the Monday gate, against production Mongo, and the
// process does not exit on its own. See section 8 of docs/arena-launch-runbook.md for
// the actual procedure - do not reconstruct it from this comment.
//
// cwd is load-bearing, not tidiness. utils.getConfig() reads "config.json" on a
// RELATIVE path resolved from process.cwd(), so a process started from anywhere else
// reads a DIFFERENT file - or none.
//
// The "or none" case is loud: getConfig() logs `FATAL: cannot read config.json from
// <resolved path>` and rethrows. The dangerous case is the other one - a valid but
// stale config.json in an unexpected cwd, which is indistinguishable from a correct
// one at runtime. That is why getConfig() now logs the path it actually loaded.
//
// exec_mode 'fork' + instances 1 keeps pm2 from cloning this entry into N workers,
// each of which would inherit the same env and schedule the same reward jobs. That is
// worth pinning, but be precise about what it does NOT cover, because the guard is
// narrower than it looks:
//
//  - It does not stop a SECOND, DIFFERENTLY-NAMED entry (see the `name` note below).
//    That is the multiplication that nearly happened here, and `instances: 1` is
//    blind to it.
//  - It does not stop this one process from duplicating work internally.
//    processBSCTransfers has no in-flight guard and fires 19x/hour, and each runRewards
//    call registers ANOTHER pair of timers (claimRewards hourly, loadSteemPrices every
//    5 min) and opens another MongoClient, none of which is ever cleared.
//  - `pm2 scale` is cluster-only and is refused on a fork app, so the risk is this
//    config shipping as cluster mode, not someone typing `scale`.
//
// Why any of this matters more here than on the api processes: the jobs on this side
// move real value OUTWARD and are not all idempotent.
//
//  - 08:00 delegator rewards ARE deduplicated - upsertRewardTransaction is a keyed
//    replaceOne(upsert) on user+chain+date+reward_activity+orig_account, so a same-day
//    rerun replaces rather than doubles.
//  - processBSCTransfers is NOT. It calls sendAfitBSC (a real BEP20 transfer from
//    config.bridgeWallet) and only marks the queue row AFTER the send returns, so a
//    duplicate alive for three minutes re-sends the whole pending bridge queue.
//  - processGadgetBuyPrize is NOT. It broadcasts the Hive transfer first and inserts
//    the gadget_buy_prize_draw record after - no pre-claim lock.
//  - moveAFITToSE broadcasts per powering_down_he row.
//
// So the window that matters is MINUTES, not "three clock times a day".
//
// Related history, worth not relearning: delegations.js used to gate its bootstrap on
// `require.main === module`, which is always false under pm2's fork wrapper - the
// schedulers never registered, the event loop emptied, the process exited, and pm2
// crash-looped it. See the comment above that guard in delegations.js.
module.exports = {
  apps: [{
    // This MUST match the name of the process already running on the box, which is
    // `delegations`. pm2 keys processes BY NAME: start this file under any other name
    // and pm2 does not replace the running worker or complain, it happily adds a
    // SECOND one alongside it - and then both schedule the 08:00 delegator rewards,
    // the 10:00 AFIT-to-Hive-Engine move and the 00:01 gadget prize. Two full payout
    // runs, with nothing downstream de-duplicating them.
    //
    // This is not hypothetical: `api-delegations` is a plausible-looking name that does
    // NOT match the live process, and it would have doubled the worker rather than
    // failing. Check `pm2 status` against this line before adopting the config anywhere.
    name: 'delegations',
    script: 'delegations.js',
    cwd: '/home/actifit-bot',
    exec_mode: 'fork',
    instances: 1,
    env: {
      BOT_THREAD: 'MAIN'
    }
  }]
}
