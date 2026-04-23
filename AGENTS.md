# Actifit Bot

## Dev Commands

- `npm start` / `npm run api` — Start Express API server (port `3120`, or `PORT` env var)
- `npm run delegate` — Run HP delegation script (`delegations.js`)
- `npm run all` — Runs API and delegation scripts together (`app.js | delegations.js`)
- `npm test` — Run Jest test suite (`tests/**/*.test.js`)
- `npx jest tests/<file>.test.js` — Run a single test file
- `npx eslint .` — Lint code

## Setup

1. Node `20.x` is required (`engines` in `package.json`)
2. `npm install`
3. Copy `config-example.json` to `config.json` and configure
4. MongoDB must be running (app connects on startup)
5. Firebase Admin SDK credentials file path must be set in `config.json` as `GOOGLE_APPLICATION_CREDENTIALS`

## Architecture

- `app.js` — Main Express API server (Swagger docs at `/api-docs`)
- `curation-bot.js` — Main curation/voting bot (`package.json` `main` entry)
- `delegations.js` — HP delegation script
- `utils.js` — Shared utilities, config loader, Hive/Blurt/Steem clients, Firebase init
- `save-data.js` — Data persistence helpers
- `mail.js` — Email notifications
- `swagger.yaml` — OpenAPI spec served by `app.js`

**Important:** `utils.js` eagerly loads `config.json` and initializes Firebase Admin on `require()`. Any script that imports `utils.js` will crash at module load time if `config.json` or the Firebase credentials file is missing or invalid.

## Testing

- Jest config: `jest.config.js`
- Test files: `tests/**/*.test.js`
- Setup file: `tests/setup.js`
- Default test timeout: `10000` ms
- Tests mock native Node modules (`node:fs`, `node:crypto`) because Jest cannot resolve them in this environment

## Files Never to Commit

- `config.json` — Runtime secrets and config
- `*firebase-adminsdk*.json` — Firebase credentials
- `state.json`, `HIVErewards*.json` — Generated data
- `*.log`, `log.log`, `tbshoot.log` — Log files
- `coverage/` — Jest coverage output
- `downloads/` — Downloaded files
