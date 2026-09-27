// pm2 config for the `app` process on **api.actifit.io** (the primary API box).
//
// BOT_THREAD is deliberately NOT set here. app.js branches on it in two places:
//   - `== 'SECOND_API'`  -> single-instance work (login cleanup, and the Arena
//                           tailer + aggregation/resolution sweeps). api2 owns it.
//   - `!= 'SECOND_API'`  -> the app-level CORS header, which this box DOES want.
// An unset value is therefore correct for api, and setting SECOND_API here would
// both duplicate the Arena payout sweeps and drop CORS on this box.
//
// See appconfig.api2.js for why these files exist at all.
//
// Usage on api:
//   pm2 delete app
//   pm2 start appconfig.api.js
//   pm2 save
//   curl -s localhost:3120/thread_param/   # must print an EMPTY line
module.exports = {
  apps: [{
    name: 'app',
    script: 'app.js',
    cwd: '/home/actifit-bot',
    exec_mode: 'fork',
    instances: 1,
    // BOT_THREAD is deliberately absent: app.js gates the Arena tailer, the
    // aggregation/settlement sweeps and disableUserLogin on == 'SECOND_API', and
    // the app-level CORS header on != 'SECOND_API'. Unset makes the first three
    // false and CORS true, which is exactly what this box needs.
    //
    // CAUTION: `env: {}` documents intent, it does NOT enforce it. pm2 MERGES this
    // over the environment its daemon inherited - it does not start from empty. If
    // BOT_THREAD is exported in the deploy user's shell or profile, the process
    // still sees it. The curl check below is the actual verification, not this line.
    // To force it: env: { BOT_THREAD: '' } - '' is still != 'SECOND_API', so CORS
    // stays on while every == 'SECOND_API' guard is deterministically false.
    env: {}
  }]
}
