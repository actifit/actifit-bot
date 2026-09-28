// pm2 ecosystem config for the DELEGATIONS process.
//
// Start it with:
//   cd /home/actifit-bot
//   pm2 delete api-delegations
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
// delegators N times over. `pm2 scale api-delegations 2` would do the same thing.
// This process moves more value than the api ones, and nothing downstream
// de-duplicates a second full payout run.
//
// Related history, worth not relearning: delegations.js used to gate its bootstrap on
// `require.main === module`, which is always false under pm2's fork wrapper - the
// schedulers never registered, the event loop emptied, the process exited, and pm2
// crash-looped it. See the comment above that guard in delegations.js.
module.exports = {
  apps: [{
    name: 'api-delegations',
    script: 'delegations.js',
    cwd: '/home/actifit-bot',
    exec_mode: 'fork',
    instances: 1,
    env: {
      BOT_THREAD: 'MAIN'
    }
  }]
}
