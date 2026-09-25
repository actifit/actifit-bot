# Challenge Engine ("The Arena") — Launch / Enablement Runbook

How to bring the challenge engine live in production, in order, with verification
and rollback at each step. The engine (F1–F6) is merged to `develop` as modules
(`arena*.js`); this runbook covers turning it **on**.

Spec: web repo `tasks/challenge-engine-spec.md`. Epic: Trello #171.

---

## 0. Preconditions

- `actifit-bot` deployed from `develop` (or `master` once promoted) with all
  `arena*.js` modules present. Node 20, MongoDB reachable.
- `config.json` has the standard keys plus the arena keys (see
  `config-example.json`): `arena_tailer_enabled`, `arena_tailer_start_block`,
  `arena_official_account`, and `alt_hive_nodes`.
- The `@actifit` (or `config.arena_official_account`) posting key is available to
  the process that will broadcast **official** ops (seed / enroll / settle).

Nothing below runs until you flip the flags — a plain deploy is inert (the
tailer is off, no routes write, no jobs are scheduled).

---

## 1. Indexes (automatic, verify)

On boot `connectDB()` calls `ensureArenaIndexes`, `ensureStandingsIndexes`,
`ensureMeritsIndexes`, `ensurePoolsIndexes`, and `ensureEventsIndexes`
(best-effort, non-fatal). Verify in mongo:

```
db.challenges.getIndexes()              // unique { id:1 }
db.challenge_participants.getIndexes()  // unique { challenge_id:1, entity:1 }
db.merits_ledger.getIndexes()           // { user:1, at:1 }
db.rewards_shop.getIndexes()            // unique { id:1 }
db.pools.getIndexes()                   // unique { id:1 }
db.challenge_resolutions.getIndexes()   // unique { challenge_id:1 }
db.arena_events.getIndexes()            // { user:1, at:-1 }
```

**Rollback:** none needed — indexing is idempotent and safe.

---

## 2. Read API (already live on deploy)

The public GET routes are mounted unconditionally (rate-limited, 120/min/IP):

```
curl https://api2.actifit.io/arena/challenges
curl https://api2.actifit.io/arena/challenges/<id>
curl https://api2.actifit.io/arena/standings?scope=league
curl "https://api2.actifit.io/arena/merits/<user>?limit=20"
curl "https://api2.actifit.io/arena/badges/<user>?limit=50"   # earned challenge badges
curl https://api2.actifit.io/arena/shop
curl https://api2.actifit.io/arena/pools/<id>
curl https://api2.actifit.io/arena/events/<user>
```

They return empty collections until steps 3–4 populate data. No rollback (reads
are inert).

There is also a **prepare/validate** write endpoint (chain-first: the client
broadcasts the signed op; the server only validates it up front):

```
curl -X POST https://api2.actifit.io/arena/ops/validate \
  -H 'content-type: application/json' \
  -d '{"op":{"op":"join","v":1,"challenge_id":"<id>"}}'
```

Tier derivation is **wired** (#180): the caller/signer tier is resolved
server-side — `official` = the `@actifit` account, `community` = an **active
moderator** (`team` collection), else `friendly`. It is applied **advisorily** at
this validate endpoint (from a body `username`) and **authoritatively** at ingest
(keyed on the op's cryptographic signer in `arena.indexArenaOp`), so a friendly
account can no longer index a `community`/AFIT-pool challenge. ⚠️ **Outstanding
half of §7.4:** the `getRank`-threshold branch (a rank-qualified *non*-moderator
qualifying as community) is not yet wired — it drops into the `isCommunity` hook
in `app.js` when added; until then such users are floored to `friendly`
(under-permissive, fail-safe). The named REST write endpoints (`/join`, `/leave`,
create, `/sponsor`, `/score`) and the broadcast of official ops are still to come.

---

## 3. Seed the default contest set (§7.5)

> 🛑 **ALREADY EXECUTED — 2026-09-23 13:06 UTC. DO NOT RE-RUN THIS STEP.**
> The six contests were broadcast on-chain as @actifit via `hiveapi.actifit.io`,
> landing in blocks **110164368, 110164369, 110164371, 110164372, 110164373,
> 110164374** (MIN = **110164368**). The pre-existing index-only `def_*` rows were
> deleted afterwards, so `challenges` is empty and ready for the tailer.
> Re-running `broadcast_arena_contests.js` would mint a SECOND irreversible set of
> six ops with fresh windows; the ids are fixed, so the tailer indexes whichever
> lands first and rejects the rest — wasted RC and permanent junk on chain.
> **Use `arena_tailer_start_block: 110164363` and go straight to §4.**

Makes the Arena feel alive (Weekly Step League, Daily Focus, Season Ladder,
Weekly Top-N, **Weekend Warrior**, Monthly Live-Ops). Two ways:

- **Index-only (staging / dry-run):** `node scripts/seed_arena_contests.js`
  (wraps `arena_api.seedDefaultContests`). Inserts the challenges into the index
  (idempotent — fixed ids). Carries the §182 presentation copy on fresh inserts.
- **On-chain (production, the real path — resolves the index-only tech debt):**
  broadcasts the six contests as real `actifit_arena` `custom_json` so the tailer
  indexes them with genuine `trx_id`/`block_num`. **Follow in order — the delete
  and cursor steps are MANDATORY, or the tailer silently skips the ops:**

  1. **Point at our own node.** Set `active_hive_node` to `hiveapi.actifit.io`
     (not a public node) before broadcasting — the ops are irreversible and must
     land via infrastructure we control (house rule). The broadcaster prints the
     resolved node; check it.
  2. **Delete the existing index-only `def_*` docs first.** They were seeded with
     synthetic `trx_id`s, and `indexArenaOp` **rejects** a `challenge_create`
     whose id already exists (it does NOT overwrite provenance — `arena.js:307-314`).
     Skip this and the tailer skips all six on-chain ops, leaving the fake
     `seed_def_*` trx / `block_num:0`. Run `node scripts/seed_arena_contests.js
     --clear` (or `db.challenges.deleteMany({ id: /^def_/ })`).
  3. **Clear the tailer cursor** if the tailer was ever enabled before:
     `db.arena_tailer_state.deleteMany({})`. The saved cursor **wins** over
     `arena_tailer_start_block` (see step 4), so a stale cursor past the broadcast
     blocks would skip the ops.
  4. **Broadcast:** `node scripts/broadcast_arena_contests.js --dry`, then without
     `--dry`. Signs with `@actifit`'s **posting** key (`config.posting_key`) and
     prints each block + the MIN block to use as `arena_tailer_start_block`.
     ⚠️ **Irreversible** — `custom_json` ops cannot be unsent (unlike migrate's
     reversible `$set`). On partial failure, re-running re-broadcasts the succeeded
     ids (harmless — tailer is idempotent by id/trx) but then use the **earliest
     block across both runs** as the start block.
  5. Set `arena_tailer_start_block` = that min block (or a few earlier), then
     enable the tailer (step 4). It indexes the six with real `trx_id`/`block_num`.

**Backfilling #182 presentation copy onto ALREADY index-only defaults:** a seed
re-run no-ops on existing ids (so it won't add the new fields), and a
delete+reseed would **shift the contest windows**. To add the copy in place
without moving windows: `node scripts/migrate_default_presentation.js` (`--dry`
first) — `$set`s only the display fields (reversible). Not needed if you take the
on-chain path above (which deletes then re-creates the docs from chain).

Verify: `curl .../arena/challenges` returns the 6 contests, `state=open`, now
carrying `tagline`/`how_it_works`/`prize_summary`/`recurrence`/`art`.

**Rollback:** set each seeded challenge `state:'cancelled'` (or delete the index
rows in staging). The fixed ids make a re-seed a no-op, so re-running is safe.

> ⚠️ The default windows are frozen at seed time (a re-seed can't roll them
> forward). A scheduled **refresh** job is a tracked follow-up (#180); until it
> exists, re-create expired defaults with fresh ids or new windows.

---

## 4. Enable the on-chain tailer

Ingests `actifit_arena` `custom_json` ops (joins, official ops) into the index.

1. Set `arena_tailer_start_block` to the block to start from. **For this launch:
   `110164363`.** It MUST be a JSON **number**, not a quoted string, and MUST be
   **strictly below** the first op block (110164368): the cursor means *last
   processed* and the loop resumes at `cursor + 1`, so setting it to exactly the
   MIN block skips the first contest.
   ⚠️ **If this key is absent, `0`, or a string, `arena_tailer.js:125` snaps the
   cursor to the current last-irreversible block and PERSISTS it immediately** —
   the six ops are then skipped permanently and silently, and adding the key
   later does NOT help, because a saved cursor always wins. There is no error
   log; `/arena/challenges` simply stays `[]`. **This is
   honored only on a COLD start** (no saved cursor): the persisted
   `arena_tailer_state` cursor always wins (`arena_tailer.js:123`), so if the
   tailer ran before, **clear that cursor** (`db.arena_tailer_state.deleteMany({})`)
   or it resumes from where it left off and may skip the just-broadcast blocks.
   (0 is reserved — set an explicit block.) Verify unconditionally before
   restarting: `db.arena_tailer_state.countDocuments()` must be **0**. The tailer indexes up to the
   **last-irreversible** block, not the reversible head, so a start block above
   LIB simply waits.
2. Set `arena_tailer_enabled: true`. **Safe to set on every instance** — the
   tailer only starts on the `BOT_THREAD == 'SECOND_API'` process (api2), so it
   can't double-poll even across the 2 servers + Heroku. Just make sure **api2**'s
   `config.json` has it and that process gets restarted.
3. Restart the process(es). Expect a single `Arena tailer started` log line (on
   **api2** only), then `arena blk <n> <trx>: <action>` lines as ops land.

It targets **last-irreversible** blocks (reorg-safe), resumes from a persisted
cursor (`arena_tailer_state`), and runs on the **single SECOND_API instance only**
(api2 — two instances would double-poll).

Verify: broadcast a test `join` from a throwaway account; confirm a
`challenge_participants` row appears within a few blocks.

**Rollback:** set `arena_tailer_enabled: false` and restart. The cursor persists,
so re-enabling resumes cleanly.

---

## 5. Scheduled jobs (BUILT — enable with `arena_jobs_enabled`)

All three are built, unit-tested and multi-agent reviewed (#74 aggregation,
#75 resolution/settlement + recurrence, #76 idempotency, #77 AFIT pivot,
#78 creator-funded pools, #81 badge award). They are **off by default** and gated
by a single flag.

1. Set `arena_jobs_enabled: true`. Optional cron overrides:
   `arena_aggregate_cron` (default `*/15 * * * *`) and `arena_resolve_cron`
   (default `35 * * * *` — deliberately offset from the aggregation ticks).
2. Restart. Expect `Arena aggregation job scheduled (...)` +
   `Arena resolution job scheduled (...)` on **api2** only.

Both jobs sit inside the `process.env.BOT_THREAD == 'SECOND_API'` block, so the
flag is **safe to set on every instance** — the 2 servers + Heroku cannot
double-run a payout even with identical config.

> ⚠️ **Why SECOND_API and not MAIN.** `MAIN` is no longer honoured by `app.js`:
> `BOT_THREAD` is **unset** on api.actifit.io, `SECOND_API` on api2, and unset on
> Heroku, so a `MAIN` guard never fires (verified via `GET /thread_param/` on all
> three). `SECOND_API` is the live single-instance marker — `disableUserLogin`
> already uses it for exactly this reason. Do **not** "fix" this by switching to
> `!= 'SECOND_API'`: that is true on BOTH api and Heroku and would double-credit
> AFIT. The Arena therefore runs on **api2**.

- **Aggregation** (`aggregateActiveChallenges`) — verify + materialize
  `challenge_participants.score` and the standings board from `verified_posts`.
  Emits nothing, broadcasts nothing, moves no funds.
- **Resolution / settlement** (`resolveDueChallenges`) — for each DUE challenge:
  build standings → credit **off-chain AFIT** → write participant results +
  a `challenge_resolutions` record → broadcast the `settle` op as `@actifit`
  (**posting** authority only) → roll recurring defaults into their next window
  → emit F6 notifications. Idempotent per challenge (unique
  `challenge_resolutions.challenge_id`) and per credit.

### Reward guards (confirmed 2026-09-12, defaulted in code by #79)

| Key | Default | Meaning |
| --- | --- | --- |
| `arena_afit_daily_cap` | `500` | Max AFIT a single user can be credited per day |
| `arena_afit_weekly_budget` | `50000` | Global rolling-7-day treasury emission ceiling |
| `arena_funded_min_afit` | `20000` | Holdings gate to fund a creator prize |
| `arena_fund_cut_pct` | `5` | Platform fee on a funded pool (burned) |
| `arena_fund_min_pool` | `50` | Minimum funded prize |

These now **default correctly in code** (`app.js`), so the guard cannot ship OFF
by omission. The weekly budget is a *ceiling, not a target* (~5x expected launch
emission). An explicit `0` disables it — don't.

Creator-funded pools are debited from the funder's own off-chain AFIT at ingest,
split 50/30/20, the funder is excluded from winning (invariant I7), and any
unpaid remainder is refunded at settlement. Badge-only contests move **zero**
AFIT and touch no pool.

> ✅ The #178 single-writer concern from the earlier draft of this runbook is
> **resolved** — Merit/AFIT crediting is idempotent (keyed on user+reason+ref)
> and resolution runs as one sequential sweep on a single instance.

**Rollback:** `arena_jobs_enabled: false` + restart. Already-written resolutions
stay (they are the settled record); no new funds move.

---

## 6. Go / no-go checklist

Deploy:

- [ ] `actifit-bot` `develop` -> `master` promoted (auto-deploys 2 servers; then
      `git push heroku master` separately)
- [ ] `actifit-landingpage` `develop` -> `master` promoted (run the
      `npm ci` lockfile pre-flight first)

Data + flags:

- [ ] Indexes present (step 1). NOTE: `token_transactions` already carries
      `{reward_activity:1}`, `{reward_activity:1,date:1}` and `{user:1,date:-1}`
      in production (verified live) — the arena credit path is indexed.
- [ ] Read API responds, including `/arena/badges/<user>` (step 2)
- [ ] Six `def_*` contests broadcast **on-chain** and indexed with real
      `trx_id`/`block_num` — NOT the index-only seed (step 3)
- [ ] `arena_tailer_enabled: true` + `arena_tailer_start_block` set, cursor
      cleared if the tailer ever ran (step 4)
- [ ] Tailer verified: `arena_tailer_state.block_num` is ADVANCING and
      `/arena/challenges` returns 6 (a stalled cursor looks identical to a
      healthy idle tailer — check the number moves, not just the log line)
- [ ] `arena_jobs_enabled: true`; both jobs logged on **api2** (SECOND_API) only (step 5)
- [ ] Emission guards present and non-zero (step 5 table)
- [ ] One tailer/jobs instance only (api2); `@actifit` RC headroom confirmed
- [ ] `@actifit` **posting** key in the api2 process config (settle/recurrence
      broadcasts are skipped without it — never the active key)

## 7. Keeping BOT_THREAD from vanishing

`BOT_THREAD` for the `app` process used to live only in on-server pm2 state and
was declared nowhere in the repo. It silently disappeared from api.actifit.io at
some point, and nothing could restore it because nothing recorded what it should
be. With the Arena gated on `SECOND_API`, losing it on api2 stops settlement
**silently** - winners are not paid and nothing alarms.

Two committed pm2 configs now pin it, deliberately one per server:

| Server | File | `BOT_THREAD` |
| --- | --- | --- |
| api2.actifit.io | `appconfig.api2.js` | `SECOND_API` (runs the Arena) |
| api.actifit.io | `appconfig.api.js` | unset (correct - keeps CORS) |

```
pm2 delete app
pm2 start appconfig.api2.js    # or appconfig.api.js on api
pm2 save                       # REQUIRED, or a reboot loses it again
curl -s localhost:3120/thread_param/
```

They are separate files on purpose: one shared config started on both boxes
would make both `SECOND_API` and double-run the payout sweeps. Both pin
`instances: 1` / `exec_mode: fork`, because `pm2 scale app 2` would inherit the
env into every instance and run two tailers and two settlement sweeps.

---

**Fast global rollback:** `arena_tailer_enabled: false` + `arena_jobs_enabled:
false`, restart. The read routes stay up but inert and no funds move.
