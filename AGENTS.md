# Actifit Bot

## Dev Commands

- `npm start` / `npm run api` - Start API server (port 3120)
- `npm run delegate` - HP delegation script
- `npx eslint .` - Lint code

## Setup

1. Copy `config-example.json` to `config.json` and configure
2. MongoDB must be running
3. Firebase credentials file path set in config
4. `npm install`

## Architecture

- `app.js` - Main Express API server
- `utils.js` - Shared utilities, config loader, Hive/Blurt clients
- API docs at `/api-docs` (Swagger)

## Files Never to Commit

- `config.json` - Runtime config
- `*firebase-adminsdk*.json` - Firebase credentials
- `state.json`, `HIVErewards*.json` - Generated data
- `*.log` - Log files