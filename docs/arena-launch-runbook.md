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

### Daily Focus: the prize was never the binding constraint (2026-10-02)

First production review of the live contests. In the first 9 days the Arena settled
12 challenges, all with on-chain settle trx, and paid **475 AFIT** across 9 payments -
about **1% of the 50,000/week budget**. The machinery is fine. Participation is not:
**6 people have ever entered, 3 have ever earned.**

`def_daily_focus` ran **8 times and paid 5 AFIT in total**, to one person. The flat
prize is now 50, but the prize was only half the problem:

```
def_daily_focus    {"metric":"goal_hit","rule":"threshold","threshold":10000}
```

Every other default scores `activity_count` / `max`. Daily Focus demands **10,000 steps
in a SINGLE day**, and `prizesForStandings` pays nothing to a finisher whose verified
score is 0. Measured against the people actually playing:

| user | weekly total | daily avg | clears 10k/day |
| --- | --- | --- | --- |
| wahaceggy | 103,963 | ~14,850 | yes - the only 5 AFIT ever paid |
| rajpootg | 23,455 (3 days) | ~7,800 | no |
| thepavsalford | 10,748 | ~1,500 | no |

thepavsalford's total for the entire WEEK is 10,748 - just over what the daily asks for
in one day. So entrants log real activity, score 0, and earn nothing. That is working as
designed and still wrong: the threshold is set above what this user base walks.

**Changing it is not a code edit.** `scoring` lives on the challenge document, which
comes from the on-chain `challenge_create` op, and `arena_jobs.nextOccurrence` copies
`scoring: ch.scoring` forward - so each occurrence inherits the previous one's threshold
indefinitely. Lowering it means broadcasting a corrected contest, not patching a
constant. Worth deciding alongside the prize.

**Emission impact of flat 50:** the zero-score rule still gates it, so only finishers who
clear the threshold are paid. Today that is one person: 50/day, 350/week. A six-person
roster all clearing it would be 300/day, 2,100/week - **4.2%** of the weekly budget.

### Reward guards (confirmed 2026-09-12, defaulted in code by #79)

| Key | Default | Meaning |
| --- | --- | --- |
| `arena_afit_daily_cap` | **`0` (off)** | Per-user daily AFIT ceiling. **Deliberately OFF for contest prizes** (2026-09-27) - a prize cannot be farmed, and each contest's own schedule bounds it. Set a positive number to re-enable. |
| `arena_afit_weekly_budget` | `50000` | Global rolling-7-day treasury emission ceiling |
| `arena_funded_min_afit` | `20000` | Holdings gate to fund a creator prize |
| `arena_fund_cut_pct` | `5` | Platform fee on a funded pool (burned) |
| `arena_fund_min_pool` | `50` | Minimum funded prize |

These default in code (`app.js`), so the **weekly treasury budget** cannot ship OFF
by omission. It is a *ceiling, not a target* (~5x expected launch emission); an
explicit `0` disables it — don't. `arena_afit_daily_cap` is the deliberate exception:
it defaults to **0**, i.e. no per-user cap on contest prizes.

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
      prints), then `pm2 save`.

      Verify without rebooting: `pm2 kill`, then `systemctl start pm2-root`, then
      **check the env, not just the process list** - `curl -s localhost:3120/thread_param/`
      for `app` and `pm2 env <id> | grep BOT_THREAD` for `delegations`. `pm2 status`
      only proves the processes came back by NAME; whether `BOT_THREAD` survived the
      resurrect is the entire point of the test, and `status` cannot show it.

      **Two further warnings.** `pm2 kill` stops the daemon and
      EVERY process on that box - on api that is api.actifit.io, on api2 it is the
      Arena tailer and `delegations` - so it is a deliberate short outage: one box at
      a time, never both. And `systemctl start` restores from the last `pm2 save`
      dump, not from the repo configs, so run it only AFTER adopting the configs and
      saving - otherwise the box comes back on the old env, which for `delegations`
      means the manual-run branch described in the pm2 section below - no outward
      transfer, but today's AFIT ledger rows get recomputed and the wrong values are
      PERMANENT (nothing revisits that date).

      The unit is named after the user pm2 runs as. `pm2-root` is correct only if that
      is root - otherwise it is `pm2-<user>`, and checking `pm2-root` fails
      misleadingly.

      The in-process alarm **cannot** cover this. It only reports on sweeps that
      happen, so a process that never started is invisible to it — which is exactly
      what a reboot produces.
- [ ] Every pm2 config's `name` matches what `pm2 status` actually shows, on the box
      it will be started on. A mismatch silently DOUBLES the process rather than
      replacing it (see the pm2 section below).
- [ ] **`free -m` shows non-zero Swap on api AND api2 — read §6c BEFORE promoting.**
      Promoting to `master` triggers `npm install --production` on both boxes. api has
      957 MB of RAM, and a box without swap is one release away from a failed deploy
      that can take the API down with it. §6c sits after this checklist for length
      reasons, but it is a **precondition of the Deploy items above**, not a follow-up.
      Never run `npm ci` on these boxes.

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
the constraint is the weekly budget, not the per-user cap. It cannot reduce a reward a
winner has already banked either — a re-credit never writes less than the row already
present. Lowering it simply does nothing for this problem.

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

`npm ci` also DELETES `node_modules` before it installs, so an interrupted run can
leave the app with no dependencies at all - and anything that restarts it in that
window crash-loops.

What was actually observed on 2026-09-28: an `npm ci` on api was OOM-killed, briefly
took the app with it (api.actifit.io returned 502 for a few minutes), and left the box
unable to fork a new ssh session. Afterwards `node_modules` was still intact and the
app came back on restart. Why it survived was never established, so treat that recovery
as luck of unknown shape rather than a mechanism to rely on.

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

Three committed pm2 configs now pin it, deliberately one per process:

| Server | pm2 process | File | `BOT_THREAD` |
| --- | --- | --- | --- |
| api2.actifit.io | `app` | `appconfig.api2.js` | `SECOND_API` (runs the Arena) |
| api.actifit.io | `app` | `appconfig.api.js` | unset (correct - keeps CORS) |
| api2.actifit.io **only** | `delegations` | `delegationsconfig.js` | `MAIN` (reward pipeline) |

`delegationsconfig.js` is deployed to both boxes but must only ever be STARTED on
api2 - see the delegations section below.

**Capture the existing environment FIRST.** `pm2 delete app` discards every
variable that lives only in pm2's stored state - which is the exact failure this
PR exists to end, so do not reproduce it while fixing it. `app.js` reads
`BOT_THREAD`, `NODE_ENV`, `PORT`, `TRUST_PROXY_HOPS`, `X_BEARER_TOKEN` and
`X_ACTIFITAPP_USER_ID`. **Three of the five have a `config.json` fallback; two do
not:**

| Var | `config.json` fallback | If it goes missing |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | `trust_proxy_hops` | every rate-limit bucket breaks |
| `X_BEARER_TOKEN` | `x_bearer_token` | X engagement path silently broken (console only, no alarm) |
| `X_ACTIFITAPP_USER_ID` | `x_actifitapp_user_id` | same path |
| `PORT` | **none** — `app.js` is `process.env.PORT \|\| 3120` | **silently rebinds to 3120** |
| `NODE_ENV` | **none** | test-mode guards change meaning |

`PORT` is the trap, because neither `appconfig.api.js` nor `appconfig.api2.js` pins
it. If a box's `app` has `PORT` living only in pm2 state - which is this section's
whole premise - then `pm2 delete` + `pm2 start appconfig.*.js` moves the listener to
3120 without saying so. Worse, the verification below *assumes* 3120, so a
non-default `PORT` makes that curl fail in a way that looks like a `BOT_THREAD`
problem. Check `pm2 env <id> | grep PORT` before deleting, and if it is set to
anything other than 3120, add it to the config file first.

`delegations.js` reads only `BOT_THREAD` and `NODE_ENV`, so `delegationsconfig.js`
pinning `BOT_THREAD` alone is complete for that process.

```
pm2 status                  # get the numeric <id>, and CONFIRM the running name
pm2 env <id>                # `pm2 describe` does NOT list the variables
```

Use `pm2 env`, not `pm2 describe`. `describe` prints a process summary with no
environment in it, so capturing with it looks like it worked, captures nothing, and
then `pm2 delete app` destroys the only copy - the exact failure this section exists
to end.

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

**The `delegations` process has the same exposure and its own config — and it is
api2-only.** `delegationsconfig.js` ships to both boxes via `deploy.yml`, but only api2
may ever start it. Its scheduler branch is selected by `BOT_THREAD == 'MAIN'` and
covers the 08:00 delegator rewards, the 10:00 AFIT-to-Hive-Engine move, the **11:00
delegation cancellation**, the 00:01 gadget prize, and **`processBSCTransfers` every 3
minutes**.

**A missing `BOT_THREAD` here neither silences the process nor pays anyone.** The
`else` branch in `delegations.js` calls `runRewards(false, false)` immediately at boot —
the same entry point the weekly local run uses (§8). It:

- recomputes today's off-chain AFIT delegator rows via `upsertRewardTransaction`, a
  keyed `replaceOne(upsert)` on `{user, chain, date, reward_activity, orig_account}`, so
  it **overwrites** today's rows rather than doubling them; `updateUserTokens()` then
  rebuilds `user_tokens` from them. (One narrow exception: `user` and `reward_activity`
  are part of that key, so if `delegation_alt_beneficiaries` changed between runs the old
  row survives *beside* the new one. The upsert is also not awaited, so a Mongo error
  there is another unhandled rejection.);
- **on a Monday only**, runs `processSteemRewards`, which computes HIVE/HBD amounts and
  writes them to `HIVErewards<date>.json`. **There is no transfer code in it** — only a
  commented-out SteemConnect signing-URL builder and a mail send. The file *is* the
  deliverable; transfers are done by hand afterwards;
- installs **two** timers — `setInterval(claimRewards, 1h)` and
  `setInterval(loadSteemPrices, 5min)` — which accumulate per invocation along with a
  fresh MongoClient. `claimRewards` is **not** benign; see below.

**No outward transfer is reachable on this path.** Nothing pays a delegator, no BSC
send, no Hive-Engine op. The only broadcast anywhere in the source is a **self-directed**
`claim_reward_balance` for `config.full_pay_benef_account` (`actifit.funds`), and it
cannot currently even get that far.

**But the wrong rows are permanent — do not round this off to "harmless".** The upsert
key includes `date`, set to today's UTC midnight, so tomorrow's 08:00 run writes
`date=D+1` and **never revisits `date=D`**. And `updateUserTokens()` is a `$group` sum
over **all** of `token_transactions` with `$out: user_tokens`, so every future rebuild
re-derives balances from the poisoned row. A bad row written today is baked into
displayed balances indefinitely.

The delegation snapshot it computes from is at most ~24h old **while `MAIN` is running
normally on api2**, because that job passes `updateDelegations = true` daily. In the
case actually being described here — the env went missing, so no `MAIN` job is running —
the snapshot age is **unbounded**.

Nothing alarms either way; the Arena settlement alarm cannot see this process at all.

#### Whether it self-repairs depends on the clock

The 08:00 `MAIN` pass writes the **same** `date` key, so:

| Accidental start | Outcome |
| --- | --- |
| **Before 08:00 UTC** | That day's 08:00 pass recomputes the same date with a fresh snapshot and **overwrites the bad rows**. Self-repairing; no action needed beyond fixing the env. |
| **At or after 08:00 UTC** | Nothing ever revisits that date. **Repair by hand** — see below. |

#### Repairing a poisoned day

**This takes precedence over the adoption window below.** That window exists to avoid
*missing* a scheduled job during a planned switchover; it is not a reason to leave wrong
balances in place. Fix the env immediately, then repair.

1. **Identify the rows.** In mongosh, with `D` the UTC midnight of the affected day:

   ```
   db.token_transactions.find({ date: ISODate("<D>T00:00:00Z"), chain: "HIVE",
                                reward_activity: /^Delegation/ }).count()
   ```

   Compare against a known-good neighbouring day's count. A materially different count
   is the alt-beneficiary double-write case noted in the table below.

2. **Re-run the pass for that date with a fresh snapshot.** The cleanest route is to let
   the scheduled job do it: if `D` is today and it is still before 08:00 UTC, just fix
   the env and wait. Otherwise delete that date's delegation rows and re-run:

   ```
   db.token_transactions.deleteMany({ date: ISODate("<D>T00:00:00Z"), chain: "HIVE",
                                      reward_activity: /^Delegation/ })
   ```

   then run the reward pass **on that same UTC day** (the `date` stamp comes from the
   run's own clock, so a later day cannot reproduce it — if `D` has already passed, the
   values must be recomputed and inserted deliberately rather than by re-running).

3. **Rebuild balances.** `updateUserTokens()` is a `$group` sum over the whole
   collection with `$out: user_tokens`, so it is the repair step as well as the damage
   vector — any subsequent run of it picks up the corrected rows.

**Escalate rather than guess** if step 2 lands on a past date. Getting it wrong writes a
second permanent wrong value on top of the first.

### `claimRewards` is broken — tracked as #109

Noted here only because it affects the **healthy `MAIN` process** too: the 08:00 job
calls `runRewards`, which installs the same hourly timer.

`claimRewards` reads `reward_steem_balance` / `reward_sbd_balance`, which do not exist
on a Hive account object. While `actifit.funds` has no pending rewards the guard fails
and it logs `no rewards to claim for now` — harmless, and the current state. Once that
account does have a pending reward, it throws an unhandled `TypeError` from a
`setInterval` with no `.catch`, which on Node 20 **terminates the process**.

**Check:** `pm2 describe delegations` on api2. A restart count climbing roughly once a
day is this bug firing. A flat count means it is still dormant.

Full analysis, on-chain verification and the suggested fix are in **#109**. Do not
rediagnose it here.

> **On api2 that branch has no legitimate use** — every route to it there is an
> accident (a stale `pm2 save` dump, the env lost on restart, a typo in an ecosystem
> file's `env` block).
>
> It is, however, the entry point for the **weekly HIVE/HBD rewards run**, which is a
> deliberate procedure carried out from a **local machine** — see **§8**. That is why
> the branch must not be turned into a no-op, however much it reads like dead code.

`delegationsconfig.js` pins that env, plus `cwd` (getConfig reads `config.json` relative
to the working directory) and `fork`/`instances: 1`.

**Be precise about what `instances: 1` protects.** It stops pm2 cloning one entry into
N workers. It does **not** stop a second differently-named entry (below), and it does
**not** stop this single process duplicating work internally — `processBSCTransfers` has
no in-flight guard at 19 fires/hour, and each `runRewards` call adds **two** more
timers (`claimRewards` hourly, `loadSteemPrices` every 5 min) plus another MongoClient,
none of which is ever cleared.

Which jobs actually double-spend, if a duplicate ever does run:

| Job | Duplicate-safe? |
| --- | --- |
| 08:00 delegator rewards | **no double-PAY, but not harmless** — `upsertRewardTransaction` is a keyed `replaceOne(upsert)` on `user+chain+date+reward_activity+orig_account`, so a rerun *on the same UTC day* replaces rather than doubles. It does **not** follow that a rerun is harmless: the replacement can carry worse values, and no later run revisits that date. Two exceptions where it genuinely doubles: `user` and `reward_activity` are part of the key, so if `delegation_alt_beneficiaries` changed between runs the old row survives *beside* the new one, and `updateUserTokens()` sums both |
| `processBSCTransfers` (every 3 min) | **NO** — sends real BEP20 AFIT from `config.bridgeWallet`, then marks the queue row *after* the send |
| 00:01 gadget prize | **NO** — broadcasts the Hive transfer first, inserts the draw record after; no pre-claim lock |
| 10:00 `moveAFITToSE` | **NO** — broadcasts per `powering_down_he` row |
| 11:00 `redeemDelegations` | unverified — treat as unsafe |

So the exposure window is **minutes, not three clock times a day**. A duplicate alive
for three minutes re-sends the entire pending BSC bridge queue.

**Adopt outside 07:50–11:10 UTC and away from the :03–:57 BSC ticks.** `pm2 delete` then
`pm2 start` leaves a gap with no scheduler, and node-schedule does not backfill a missed
fire. Reward rows are stamped with the run's own date, so a job whose clock time lands
in that gap is a **skipped day**, not a deferred one.

Same pre-step as above - capture `pm2 env <id>` BEFORE `pm2 delete delegations`,
because the delete discards anything living only in pm2's state:

```
cd /home/actifit-bot
pm2 status                     # CONFIRM the running name matches the config's `name`
pm2 env <id>                   # diff against delegationsconfig.js first
pm2 delete delegations
pm2 start delegationsconfig.js
pm2 save
pm2 logs delegations --lines 30 --nostream   # <- the actual verification
```

**Verify, do not assume.** The `app` path has `curl /thread_param/`; this one has the
boot log. `delegations.js` prints `>>>>>>>>>MAIN DELEGATION THREAD<<<<<<<<<<<` when
the env took effect, so that line's presence is the proof. `pm2 env <id> | grep
BOT_THREAD` works too. `pm2 status` does **not** - it shows name, pid and uptime, never
the environment, so a green row proves only that something started.

This matters here because a `delegations` process that comes up *without* the env does
not sit idle waiting to be noticed - it takes the manual-run branch and recomputes
today's AFIT ledger rows. No outward transfer happens, but a wrong value can be
PERMANENT, because nothing revisits that date - see the analysis earlier in this
section, and the repair procedure with it.

**Check `pm2 status` against the config's `name` field before adopting any of these
files.** pm2 keys processes by name, so a config whose `name` does not match the
running process does not replace it and does not warn - it starts a SECOND worker
beside it. For `delegations` that means two processes both running the 08:00 delegator
rewards, the 10:00 AFIT-to-Hive-Engine move and the 00:01 gadget prize: two full payout
runs, with nothing downstream de-duplicating them. This is not hypothetical - the first
version of `delegationsconfig.js` in this repo said `api-delegations` while the live
process was `delegations`.

**These files are documentation until someone adopts them.** `deploy.yml` runs `pm2
restart all`, which reuses pm2's *stored* env and never re-reads an ecosystem file. So
editing `appconfig.*.js` or `delegationsconfig.js` - including following their own
"add anything missing here FIRST" instruction - changes nothing on the boxes until a
human re-runs `pm2 delete` + `pm2 start <file>` + `pm2 save` there.

Nothing detects that drift. The repo can say one thing and the box do another, which is
a softer version of the bug these files exist to prevent - so treat a config edit as
needing a deployment step of its own, and re-verify with the checks above afterwards.

They are separate files on purpose: one shared config started on both boxes
would make both `SECOND_API` and double-run the payout sweeps. All three pin
`instances: 1` / `exec_mode: fork`, because in cluster mode pm2 hands every worker
the same env, so `BOT_THREAD` would reach each one and run two tailers and two
settlement sweeps. (`pm2 scale` is cluster-only and is refused on a fork app, so the
risk is a config shipping as cluster mode, not someone typing `scale`.)

## 8. The weekly HIVE/HBD rewards run (local, Mondays)

A recurring manual procedure, not part of launch. Delegator **AFIT** rewards autorun
daily on api2 under `MAIN`; the **HIVE/HBD** reward figures are produced by hand, once a
week, from a local machine.

```
cd <repo root>                # getConfig() reads ./config.json relative to cwd
npm run delegate              # = node delegations.js, with BOT_THREAD UNSET
#   wait for: The file was saved!
#   then Ctrl-C
```

Output: `HIVErewards<YYYY-MM-DD>.json` in the working directory (gitignored). That file
**is** the deliverable — the transfers are done by hand afterwards. There is no transfer
code in this path; what is commented out in `processSteemRewards` is a SteemConnect
signing-URL builder and a mail send, never a broadcast.

### Four things about this that are not obvious

**1. It is not read-only. It writes production.** `runRewards(false, false)` →
`startProcess` runs `processTokenRewards` **and** `updateUserTokens()` *before* it ever
reaches the Monday gate. So every weekly run rewrites that day's AFIT delegator rows in
`token_transactions` and rebuilds the `user_tokens` balance collection — against
**production Mongo**, because `config.testing` is false and `config.mongo_uri` points at
the live host. This is normally harmless, and the reason is worth understanding rather
than trusting:

- The run passes `updateDelegations = false`, so it does **not** refresh the delegation
  snapshot; it reads whatever `hive_active_delegations` already holds.
- That snapshot lives in the **shared production** database, and api2's 08:00 `MAIN` pass
  refreshed it that same morning.
- So a run after 08:00 UTC recomputes from an already-fresh snapshot and writes
  **the same values back**. A run before 08:00 UTC is then overwritten by that day's
  08:00 pass. Either ordering is fine.

**The case that is not fine:** running after 08:00 UTC on a day when api2's 08:00 pass
**did not run** (process down, env missing, box rebooted). Then the snapshot age is
unbounded, the values written are stale, and per §7 nothing ever revisits that date.
**Before running, confirm the 08:00 pass happened** — `pm2 logs delegations --nostream`
on api2, or check that `hive_active_delegations` was updated today.

**2. The process never exits.** `runRewards` installs `setInterval(loadSteemPrices, 5min)`
and `setInterval(claimRewards, 1h)` and never clears them, so the event loop stays alive
after the file is written. Ctrl-C once you see `The file was saved!`. Leaving it running
means an hourly `claimRewards` against production — see §7 for why that one is a latent
process-killer.

**3. Run it well after 00:00 UTC Monday.** The Monday gate is `new Date().getDay() == 1`
— **local** time — while the reward window uses `moment().utc()`, and the filename is a
UTC-midnight `Date` formatted in **local** mode. Those disagree on either side of UTC, in
both directions: east of UTC, a run at 01:00 Monday local is still Sunday in UTC, so the
gate passes but the window and the filename are a day early; west of UTC, a late-Sunday
run is already Monday UTC and skips the gate entirely, producing no file and no error.
Mid-morning UTC Monday avoids both. **If a weekly run ever silently produces nothing,
check the clock first.**

**4. It signs with the production posting key.** `claimRewards` loads
`config.full_pay_posting_key` from the local `config.json`. Treat that file as a
production secret on whatever machine this runs on.

### If the file looks wrong or empty

- **Check `config.testing`.** If it is `true`, `runRewards` silently uses
  `config.mongo_local` instead of production — an empty or garbage file with no error.
- **`fs.writeFile` overwrites silently**, so a second run the same day replaces the first
  file without warning.
- **Wrong date in the filename** is the timezone problem in point 3.

---

**Fast global rollback:** `arena_tailer_enabled: false` + `arena_jobs_enabled:
false`, restart. The read routes stay up but inert and no funds move.
