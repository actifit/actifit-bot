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

⚠️ Until tier derivation from `getRank`/role is wired, every caller is treated as
the **friendly** tier — so `community`/`official` challenge creates won't validate
yet (tracked, #180). The named REST write endpoints (`/join`, `/leave`, create,
`/sponsor`, `/score`) and the broadcast of official ops are also still to come.

---

## 3. Seed the default contest set (§7.5)

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
     whose id already exists (it does NOT overwrite provenance — `arena.js:307`).
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

1. Set `arena_tailer_start_block` to the block to start from (for the on-chain
   seed, the MIN block the broadcaster printed, or a few earlier). **This is
   honored only on a COLD start** (no saved cursor): the persisted
   `arena_tailer_state` cursor always wins (`arena_tailer.js:123`), so if the
   tailer ran before, **clear that cursor** (`db.arena_tailer_state.deleteMany({})`)
   or it resumes from where it left off and may skip the just-broadcast blocks.
   (0 is reserved — set an explicit block.) The tailer indexes up to the
   **last-irreversible** block, not the reversible head, so a start block above
   LIB simply waits.
2. Set `arena_tailer_enabled: true`. **Safe to set on every instance** — the
   tailer only starts on the `BOT_THREAD == 'MAIN'` process (`app.js:202`), so it
   can't double-poll even across the 2 servers + Heroku. Just make sure the MAIN
   process's config has it and gets restarted.
3. Restart the process(es). Expect a single `Arena tailer started` log line (on
   MAIN only), then `arena blk <n> <trx>: <action>` lines as ops land.

It targets **last-irreversible** blocks (reorg-safe), resumes from a persisted
cursor (`arena_tailer_state`), and runs on the **single MAIN instance only**
(the guard at `app.js:202` — two instances would double-poll).

Verify: broadcast a test `join` from a throwaway account; confirm a
`challenge_participants` row appears within a few blocks.

**Rollback:** set `arena_tailer_enabled: false` and restart. The cursor persists,
so re-enabling resumes cleanly.

---

## 5. Scheduled jobs (not yet built — deferred)

These are the remaining wiring, tracked on the sub-cards, and must NOT be enabled
until built + reviewed:

- **Verification + aggregation** (F2/F3): a periodic job that runs
  `verifyChallenge` then `buildStandings` for active challenges/cohorts.
- **Resolution/payout** (F5): on a challenge's window close, run
  `resolveChallenge`, broadcast the returned `settle` op, and execute the
  Hive-Engine AFIT transfers (filling `he_tx`).
- **Notification emitters** (F6/§9): fire `emitEvent` from lifecycle transitions.

> 🚨 **BLOCKER for concurrent writes:** the Merits ledger + shop stock are still
> single-writer (read-then-write). The **F4 atomic-counter redesign (#178)** must
> land before resolution/purchase run concurrently, or double-spend / stock
> oversell is possible. Until then, run resolution as a single sequential sweep.

---

## 6. Go / no-go checklist

- [ ] Indexes present (step 1)
- [ ] Read API responds (step 2)
- [ ] Default contests seeded + visible (step 3)
- [ ] Tailer enabled, test join indexed (step 4)
- [ ] #178 atomicity landed **before** any concurrent write job (step 5)
- [ ] One tailer instance only; `@actifit` RC headroom confirmed

**Fast global rollback:** `arena_tailer_enabled: false` + don't schedule the
jobs. The read routes stay up but inert; no funds move without the (not-yet-built,
reviewed) resolution job.
