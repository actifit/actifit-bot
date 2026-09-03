# CLAUDE.md — actifit-bot

Guidance for Claude Code when working in this repo.

## Repo basics

- Node/Express backend serving `api2.actifit.io`. Native MongoDB driver
  (`db.collection(...)`, dependency-injected `db`), dhive/hive-js. Node 20.
- **No CI.** `master` auto-deploys to 2 servers via GitHub Actions **and** a
  separate `git push heroku master`. Never merge to `master` without explicit
  user confirmation.
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

### ⚠️ TECH DEBT: default contests are seeded INDEX-ONLY, not on-chain

`scripts/seed_arena_contests.js` (and `arena_api.seedDefaultContests`) write the
six default contests **directly into the `challenges` collection** with a
synthetic `trx_id` (`seed_<id>`) via `arena.indexArenaOp`. **Nothing is
broadcast to Hive.** This was used on 2026-08-27 to seed the live DB
(`heroku_ch0sdt2p`) so the web `/arena` page had data.

Consequence: those six `def_*` challenges exist in the index but have **no
on-chain record**, which violates the chain-first "Hive is the system of record"
guarantee. This is a deliberate shortcut for first-visibility, **not** the
launch path.

**Fix properly down the road (Path B in `docs/arena-launch-runbook.md`):**
1. Broadcast the six ops from `arena_api.defaultContests(Date.now())` signed by
   @actifit (real `custom_json` on Hive).
2. Enable the tailer (`config.arena_tailer_enabled: true` +
   `arena_tailer_start_block`) so it indexes them from the chain with real
   `trx_id`/`block_num`.
3. **Delete the index-only `def_*` rows FIRST** (`node scripts/seed_arena_contests.js
   --clear`) before broadcasting. `indexArenaOp` **rejects** a `challenge_create`
   for an existing id — it does NOT overwrite provenance (`arena.js:307-314`), so
   without the delete the tailer skips the on-chain ops and the fake `seed_*`
   trx / `block_num:0` remain. Also clear the `arena_tailer_state` cursor if the
   tailer ran before (the saved cursor overrides `arena_tailer_start_block`).
   Tooling + full steps: `scripts/broadcast_arena_contests.js` and
   `docs/arena-launch-runbook.md` §3.

Until this is done, treat the seeded defaults as staging data.

## Conventions

- Use `git -C <path>` (not `cd && git`).
- Every substantive PR gets an independent multi-agent review round before merge.
- Document analysis/review findings on the PR/issue, not just in chat.
