module.exports = {
  apps: [{
    name: 'api-delegations',
    script: 'delegations.js',
    env: {
      BOT_THREAD: 'MAIN'
    }
  }]
}