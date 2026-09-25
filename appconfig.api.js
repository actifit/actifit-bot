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
    env: {}
  }]
}
