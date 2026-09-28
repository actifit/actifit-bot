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
// If it is absent the process does NOT go quiet. Read delegations.js around the
// `else` at the end of the bootstrap: it calls `runRewards(false, false)` IMMEDIATELY,
// unscheduled, at boot. `testRun` is false, so that is a real reward pass - it writes
// token_transactions rows and updateUserTokens() then rebuilds user_tokens from them.
// Worse, the second argument is `updateDelegations = false`, so it pays from a STALE
// delegation snapshot, and because the 08:00 job never registers in this mode nothing
// ever corrects the rows it wrote.
//
// So a missing BOT_THREAD is not a silent no-op, it is a silent WRONG PAYOUT, repeated
// on every restart if pm2 crash-loops the process. An earlier version of this comment
// claimed it "silently pays NOBODY", which is backwards and would lead an operator to
// treat a missing env as harmless. Nothing alarms either way: the Arena settlement
// alarm cannot see this process at all.
//
// cwd is load-bearing, not tidiness. utils.getConfig() reads "config.json" on a
// RELATIVE path resolved from process.cwd(), so a process started from anywhere else
// reads a different file - or none. That is a silent wrong-config failure, and it is
// why getConfig() now logs the resolved path it actually loaded.
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
//    call registers ANOTHER setInterval(claimRewards, 1h) and opens another MongoClient,
//    so the timers accumulate for as long as the process lives.
//  - `pm2 scale` is cluster-only, so it is not actually the threat an earlier version
//    of this comment named.
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
    // An earlier draft of this file said 'api-delegations', which is exactly that bug.
    // Check `pm2 status` against this line before adopting the config anywhere.
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
