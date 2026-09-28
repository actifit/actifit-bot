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
// environment, so a green row proves only that something started. And per the note
// below, a process that came up without BOT_THREAD does not wait to be noticed.
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
// If it is absent the process does NOT go quiet, and it does NOT pay either - both of
// which this comment has claimed at various points. What actually happens: the `else`
// at the end of the bootstrap calls `runRewards(false, false)` immediately at boot,
// which is the MANUAL-RUN entry point, in active weekly use (see below). It:
//
//   - recomputes today's off-chain AFIT delegator rows via upsertRewardTransaction,
//     a keyed replaceOne(upsert) - so it OVERWRITES today's rows rather than doubling
//     them - and updateUserTokens() then rebuilds user_tokens from them;
//   - on a MONDAY only, runs processSteemRewards, which computes HIVE/HBD amounts and
//     writes them to HIVErewards<date>.json. The transfer code there is commented out;
//   - installs setInterval(claimRewards, 1h), which claims @actifit's OWN pending
//     rewards. Benign, but the timers and MongoClients accumulate per invocation.
//
// NOTHING IS BROADCAST AND NO FUNDS MOVE on this path. So an accidental start is a
// wrong-VALUE bug in the off-chain ledger - today's rows recomputed from a delegation
// snapshot up to ~24h old, since the scheduled 08:00 job refreshes it daily - not a
// wrong payout. It is bounded, and the next scheduled run corrects it.
//
// It is still worth not doing accidentally, because updateUserTokens() propagates the
// wrong values into displayed balances. Nothing alarms either way: the Arena
// settlement alarm cannot see this process at all.
//
// THE MANUAL RUN IS DELIBERATE AND IN USE. Delegator rewards autorun daily under
// MAIN; the HIVE/HBD rewards file is generated MANUALLY once per week, on a Monday,
// through exactly this branch (`npm run delegate` / node delegations.js with no
// BOT_THREAD). Do not "fix" the else branch into a no-op without replacing that
// entry point - see issue #107.
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
