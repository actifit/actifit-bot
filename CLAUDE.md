# CLAUDE.md — actifit-bot

Guidance for Claude Code when working in this repo.

## Repo basics

- Node/Express backend serving `api2.actifit.io`. Native MongoDB driver
  (`db.collection(...)`, dependency-injected `db`), dhive/hive-js. Node 22.
- **No CI.** `master` auto-deploys to 2 servers (api + api2) via GitHub Actions.
  Heroku no longer runs this code: since 2026-10-22 the `actifitbot` Heroku app
  runs only the pass-through proxy (repo `actifitbot-heroku-proxy`, no secrets, no
  DB) that forwards old app builds to api/api2. Never merge to `master` without
  explicit user confirmation.
- Mongo connection is read from `config.json` (gitignored): `app.js` uses
  `config.testing ? config.mongo_local : config.mongo_uri`, db `config.db_name`.
  In production `testing: false` → `mongo_uri` is the live DB.
- Modules must be **load-time-safe** (no config/Firebase access at `require`).

## Arena / Challenge Engine ("The Arena")

Chain-first shared backend consumed by web/Android/iOS. Clients broadcast
`actifit_arena` Hive `custom_json` ops signed by their own key; the tailer
indexes them into Mongo. **Hive is the system of record; the DB is a
materialized index.** Merits are intentionally OFF-chain (non-transferable).

Compliance invariants I1–I7 are enforced in code + `tests/compliance.test.js`
(no fee entry, pool funding sponsor/DHF/treasury only, non-transferable Merits,
skill/goal scoring, etc.). **No gambling / wagering / user-staked pots / paid
random crates.** Do not weaken these.

### Default contests are on-chain (resolved 2026-09-23)

The six `def_*` default contests were first seeded **index-only** (2026-08-27,
synthetic `seed_<id>` trx ids, nothing on Hive). That was fixed on 2026-09-23 via
Path B in `docs/arena-launch-runbook.md`: the index-only rows were deleted, the six
ops were broadcast signed by @actifit (blocks 110164368-110164374), and the tailer
indexed them with real `trx_id`/`block_num`. Recurring instances now roll forward
on-chain as `def_<name>@<date>` with `parent_id` set.

Do **not** run `scripts/seed_arena_contests.js` against the live DB again: it writes
index-only rows, and `indexArenaOp` rejects a `challenge_create` for an existing id
(it never overwrites provenance), so a stray seed would block the real op.

### Arena notifications

`arena_notify.js` sends results (`arena_results`) and closing-soon reminders
(`arena_closing`) through `utils.sendNotification` (inbox + FCM), category `arena`.
Only official, public challenges are named in the text (user titles would be a
phishing vector, and the inbox is readable without login). On by default inside
`arena_jobs_enabled`; to stop it set `arena_notify_enabled: false` in **api2's**
config.json and `pm2 restart app` (never `pm2 delete` + start by hand — that drops
`BOT_THREAD` and stops settlement).

## Conventions

- Use `git -C <path>` (not `cd && git`).
- Every substantive PR gets an independent multi-agent review round before merge.
- Document analysis/review findings on the PR/issue, not just in chat.
