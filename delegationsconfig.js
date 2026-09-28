// pm2 ecosystem config for the DELEGATIONS process.
//
// Start it with:
//   cd /home/actifit-bot
//   pm2 delete delegations
//   pm2 start delegationsconfig.js
//   pm2 save                       # REQUIRED, or a reboot loses the env again
//
// Before deleting, capture what pm2 currently holds:
//   pm2 env <id>                   # `pm2 describe` does NOT list the variables
// `pm2 delete` discards every variable that lives only in pm2's stored state, which
// is exactly how BOT_THREAD went missing on the api boxes. Diff that output against
// this file and add anything missing here FIRST.
//
// What the settings below are actually protecting:
//
// BOT_THREAD='MAIN' gates the entire reward pipeline in delegations.js - the 08:00
// delegator rewards, the 10:00 AFIT-to-Hive-Engine move, and the 00:01 gadget buy
// prize. If it is absent the process starts, logs, and silently pays NOBODY. Nothing
// alarms: the Arena settlement alarm cannot see this process at all.
//
// cwd is load-bearing, not tidiness. utils.getConfig() reads "config.json" on a
// RELATIVE path resolved from process.cwd(), so a process started from anywhere else
// reads a different file - or none. That is a silent wrong-config failure, and it is
// why getConfig() now logs the resolved path it actually loaded.
//
// exec_mode 'fork' + instances 1 is a MONEY guard. In cluster mode pm2 gives every
// worker the same env, so each one would schedule the same reward jobs and pay
// delegators N times over. `pm2 scale delegations 2` would do the same thing.
// This process moves more value than the api ones, and nothing downstream
// de-duplicates a second full payout run.
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
