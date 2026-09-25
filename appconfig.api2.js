// pm2 config for the `app` process on **api2.actifit.io** (SECOND_API).
//
// WHY THIS FILE EXISTS: BOT_THREAD for `app` lived only in on-server pm2 state,
// declared nowhere in the repo. It silently disappeared from api.actifit.io at
// some point — a `pm2 delete` + fresh `pm2 start`, or a reboot resurrecting a
// dump saved without it, drops it with no error. Nothing could restore it,
// because nothing recorded what it should be.
//
// That matters now: the Arena tailer and the aggregation/resolution sweeps are
// gated on BOT_THREAD == 'SECOND_API'. If it vanishes here, settlement stops
// SILENTLY — winners simply are not paid and nothing alarms.
//
// Usage on api2:
//   pm2 delete app
//   pm2 start appconfig.api2.js
//   pm2 save            <-- REQUIRED, or a reboot loses it again
//   curl -s localhost:3120/thread_param/   # must print SECOND_API
//
// instances/exec_mode are pinned deliberately: `pm2 scale app 2` would inherit
// BOT_THREAD into every instance and run two tailers and two payout sweeps.
module.exports = {
  apps: [{
    name: 'app',
    script: 'app.js',
    cwd: '/home/actifit-bot',   // getConfig() reads config.json by RELATIVE path
    exec_mode: 'fork',
    instances: 1,
    env: {
      BOT_THREAD: 'SECOND_API'
    }
  }]
}
