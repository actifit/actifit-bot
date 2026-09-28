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

These default in code (`app.js`), so the **weekly treasury budget** cannot ship OFF by omission. `arena_afit_daily_cap` is the deliberate exception: it defaults to **0 (no per-user cap on contest prizes)** — see the table above.
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
- [ ] `arena_afit_weekly_budget` present and non-zero (step 5 table). NOTE
      `arena_afit_daily_cap` is deliberately **0/absent** — it does not apply to
      contest prizes. Set it explicitly in `config.json` so the choice is declared
      rather than inherited from a code default.
- [ ] A test email actually ARRIVES from the box. `report_emails` alone is NOT
      enough — `smtp_host`, `smtp_usr`, `smtp_key` and `smtp_from` all have to be
      right, and a wrong one usually hangs or fails silently rather than erroring.
      Prove it, do not assume it:

      ```
      cd /home/actifit-bot && node scripts/arena_alert_test.js
      ```

      It sends one real alert through the exact path the alarm uses and writes
      nothing. A page nobody receives is worse than no page, because this checklist
      says it is covered.
- [ ] One tailer/jobs instance only (api2); `@actifit` RC headroom confirmed
- [ ] `@actifit` **posting** key in the api2 process config (settle/recurrence
      broadcasts are skipped without it — never the active key)
- [ ] `config.report_emails` set, so a settlement stall actually pages someone
      (step 6b). Without it the alarm is log-only.
- [ ] `db.arena_health.findOne({_id:'resolve_sweep'})` returns a record with
      `alerting: false` after the first sweep (step 6b) — this is the ONLY check
      that distinguishes a stalled Arena from a healthy idle one
- [ ] **Both boxes have an ENABLED pm2 boot unit**: `systemctl is-enabled pm2-root`
      prints `enabled` on api AND api2. Neither box had one before 2026-09-27, which
      meant an unattended reboot of api2 would silently stop Arena settlement *and*
      the delegator reward pipeline. Create it with `pm2 startup` (run the command it
      prints), then `pm2 save`. Verify without rebooting: `pm2 kill` followed by
      `systemctl start pm2-root`, then `pm2 status`.

      The in-process alarm **cannot** cover this. It only reports on sweeps that
      happen, so a process that never started is invisible to it — which is exactly
      what a reboot produces.
- [ ] Every pm2 config's `name` matches what `pm2 status` actually shows, on the box
      it will be started on. A mismatch silently DOUBLES the process rather than
      replacing it (see the pm2 section below).

## 6b. Is settlement actually running?

**This is the check to run when someone asks "is the Arena healthy?".** Every other
check in this runbook can pass while settlement is completely stopped:

- the tailer cursor keeps advancing (the tailer is a separate job and is fine)
- `/arena/challenges` keeps returning 6 (when the treasury is dry the recurrence
  roll is skipped too, so the challenge list does not change either)
- no process has crashed and nothing looks wrong in `pm2 status`

Settlement records its own state, so ask it directly:

```js
// on the SECOND_API box, or any mongo client against the live DB
db.arena_health.findOne({ _id: 'resolve_sweep' })
```

| field | meaning |
| --- | --- |
| `last_run_at` | when the sweep last ran. Stale by more than ~1h = the cron is not firing at all |
| `last_success_at` | when something last actually settled |
| `stalled_ticks` | consecutive sweeps that failed with nothing settled. `0` is healthy |
| `alerting` | true once `stalled_ticks` reaches 2 (~1h stuck) |
| `stalled_since` | when the current stall began |
| `last_summary.budgetExhausted` | `> 0` means the weekly AFIT treasury budget is dry |

A sweep with nothing due reports `stalled_ticks: 0` — **idle is not stalled**, and the
record distinguishes them.

`last_success_at` means *the last time a settle op was broadcast*, not the last time a
sweep ran. Most hourly sweeps legitimately have nothing due, and the seeded cadences
close at 1 / 7 / 14 / 30 day intervals — so **a `last_success_at` days old is normal**
and is not by itself a stall. `alerting` is the signal; `last_success_at` is context.

### What this alarm does NOT cover

Be honest about the edges, because the checklist implies more coverage than exists:

| Failure | Caught? |
| --- | --- |
| Weekly treasury exhausted | yes — mails, and clears itself |
| A challenge failing every sweep | yes — even if others settle alongside it |
| No posting key / broadcaster dead | yes — its own `cannot_broadcast` alert |
| Resolve cron stopped, or a hung read wedged the in-flight guard | yes — the aggregation sweep heartbeats it |
| `arena_jobs_enabled: false` | **no** |
| `BOT_THREAD` unset, so the whole Arena block is skipped | **NO — and this is the known silent killer** |

The last two cannot be detected from inside a process that was never scheduled to run.
They need **outside** monitoring: alert if `arena_health.resolve_sweep.last_run_at`
stops advancing, from something that is not this app.

### If `budgetExhausted > 0`

The weekly AFIT treasury budget is exhausted. This is a controlled stop, not damage:

- **no wrong reward has been written or broadcast** — the refusal is the point. Before
  this guard existed, winners were settled at a reduced amount (or zero) on-chain,
  permanently, and never retried
- challenges are NOT settled, NO settle ops are broadcast, and recurring contests do
  NOT roll into their next occurrence, so no unpayable contests are created
- it clears by itself when the weekly bucket rolls over, and everything settles then

To resume sooner, raise `arena_afit_weekly_budget` in `config.json` and restart.

**Do not lower `arena_afit_daily_cap` in response to this alarm.** It does not help —
the constraint is the weekly budget, not the per-user cap. (An earlier version of this
note claimed lowering it could reduce a reward a winner had already banked: that is
**not** true — a re-credit never writes less than the row already present. The reason
is simply that it does nothing for this problem.)

### If `alerting` is true but `budgetExhausted` is 0

Something else is failing and it will **not** clear on its own. Read `arena.log` on the
SECOND_API box for the per-challenge reason.

### Alert mail

The transport defaults to SparkPost but is not limited to it — set `smtp_host` /
`smtp_port` (and `smtp_secure: true` for port 465) to use an ordinary mailbox. Whatever
you choose, `smtp_from` must be an address that provider has authorised this account to
send as, which is the usual reason mail is accepted and then never arrives.

Alerts go to `config.report_emails` on a state **change** — one mail when it starts,
one when it recovers, not one per tick. If `report_emails` is unset the alert is only
logged, and the log line says so.

## 6c. Server prerequisites - read before running ANY npm command

**Never run `npm ci` on these boxes.** Use `npm install --production`, which is what
`.github/workflows/deploy.yml` has always run. The difference is not stylistic:

| | packages installed | outcome on api |
| --- | --- | --- |
| `npm ci` | ~1,060 (includes devDependencies) | **OOM-killed** (2026-09-28) |
| `npm install --production` | 30 direct + their tree | fine |

`npm ci` also DELETES `node_modules` before it downloads anything, so an interrupted
run leaves the app with no dependencies at all - and anything that restarts it in that
window crash-loops. On 2026-09-28 an `npm ci` on api was OOM-killed, briefly took the
app with it (api.actifit.io returned 502 for a few minutes), and left the box unable to
fork a new ssh session. It recovered only because the kill landed during the download
phase, BEFORE the delete completed.

**Swap is a prerequisite, not a nicety.** api has **957 MB** of RAM. Check before any
install:

```
free -m                       # if the Swap row reads 0, add it FIRST
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

This matters beyond manual work: the deploy workflow runs `npm install --production` on
**every release**, so a box without swap is one release away from a failed deploy.

**If a box is too starved to open a new ssh session,** `kill` is a bash builtin and
needs no fork - so in the stuck session, Ctrl-Z then `kill -9 %1` works where Ctrl-C
and a second login both fail. Prefer that to a reboot: a running app keeps serving from
modules already in memory, while a reboot cannot come back until dependencies exist.

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

**Capture the existing environment FIRST.** `pm2 delete app` discards every
variable that lives only in pm2's stored state - which is the exact failure this
PR exists to end, so do not reproduce it while fixing it. `app.js` reads
`BOT_THREAD`, `NODE_ENV`, `PORT`, `TRUST_PROXY_HOPS`, `X_BEARER_TOKEN` and
`X_ACTIFITAPP_USER_ID`. Most have a `config.json` fallback that takes precedence,
but `X_BEARER_TOKEN` failing over produces a silently broken X engagement path
(logged to console only, no alarm), and a wrong `TRUST_PROXY_HOPS` breaks every
rate-limit bucket.

```
pm2 describe app            # or: pm2 env <id>
```

Diff that against the config file and add anything it declares that the file does
not. Only then:

```
pm2 delete app
pm2 start appconfig.api2.js    # or appconfig.api.js on api
pm2 save                       # REQUIRED, or a reboot loses it again
curl -s localhost:3120/thread_param/
```

The curl is the real verification, not the config file: pm2 merges an app's `env`
over the environment its daemon inherited, so `env: {}` cannot by itself clear a
`BOT_THREAD` exported in the deploy user's shell. On api2 it must print
`SECOND_API`; on api it must print an empty line.

**Starting the wrong file on the wrong box** is the thing to avoid: both declare
`name: 'app'`, so nothing structurally prevents it. On api the loudest symptom is
CORS silently dropping on the primary API box (`app.js` flips its `!= 'SECOND_API'`
branch false), breaking the mobile app and web frontend - before any Arena
double-run matters.

**The `delegations` process has the same exposure and its own config.** Its whole
reward pipeline - the 08:00 delegator rewards, the 10:00 AFIT-to-Hive-Engine move and
the 00:01 gadget prize - is gated on `BOT_THREAD == 'MAIN'`. Without it the process
starts, logs, and silently pays nobody, and the Arena settlement alarm cannot see that
process at all. `delegationsconfig.js` pins it, along with `cwd` (getConfig reads
config.json relative to the working directory) and `fork`/`instances: 1` (in cluster
mode every worker would schedule the same reward jobs and pay delegators N times).

Same pre-step as above - capture `pm2 env <id>` BEFORE `pm2 delete delegations`,
because the delete discards anything living only in pm2's state:

```
cd /home/actifit-bot
pm2 status                     # CONFIRM the running name matches the config's `name`
pm2 env <id>                   # diff against delegationsconfig.js first
pm2 delete delegations
pm2 start delegationsconfig.js
pm2 save
```

**Check `pm2 status` against the config's `name` field before adopting any of these
files.** pm2 keys processes by name, so a config whose `name` does not match the
running process does not replace it and does not warn - it starts a SECOND worker
beside it. For `delegations` that means two processes both running the 08:00 delegator
rewards, the 10:00 AFIT-to-Hive-Engine move and the 00:01 gadget prize: two full payout
runs, with nothing downstream de-duplicating them. This is not hypothetical - the first
version of `delegationsconfig.js` in this repo said `api-delegations` while the live
process was `delegations`.

They are separate files on purpose: one shared config started on both boxes
would make both `SECOND_API` and double-run the payout sweeps. Both pin
`instances: 1` / `exec_mode: fork`, because `pm2 scale app 2` would inherit the
env into every instance and run two tailers and two settlement sweeps.

---

**Fast global rollback:** `arena_tailer_enabled: false` + `arena_jobs_enabled:
false`, restart. The read routes stay up but inert and no funds move.
