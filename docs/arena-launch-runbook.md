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

---

## 3. Seed the default contest set (§7.5)

Makes the Arena feel alive (Weekly Step League, Daily Focus, Season Ladder,
Weekly Top-N, **Weekend Warrior**, Monthly Live-Ops). Two ways:

- **Index-only (staging / dry-run):** run `arena_api.seedDefaultContests(db, {
  officialAccount, nowMs: Date.now() })` from a node script against the target
  DB. This inserts the challenges into the index (idempotent — fixed ids).
- **On-chain (production):** broadcast the six `challenge_create` ops from
  `arena_api.defaultContests(Date.now())` signed by `@actifit`, then let the
  tailer (step 4) index them. This is the real, tamper-proof path.

Verify: `curl .../arena/challenges` returns the 6 contests, `state=open`.

**Rollback:** set each seeded challenge `state:'cancelled'` (or delete the index
rows in staging). The fixed ids make a re-seed a no-op, so re-running is safe.

> ⚠️ The default windows are frozen at seed time (a re-seed can't roll them
> forward). A scheduled **refresh** job is a tracked follow-up (#180); until it
> exists, re-create expired defaults with fresh ids or new windows.

---

## 4. Enable the on-chain tailer

Ingests `actifit_arena` `custom_json` ops (joins, official ops) into the index.

1. Set `arena_tailer_start_block` to the **current head block** (NOT 0 — 0 now
   means "start at head" via cold-start snap, but set it explicitly to be safe).
2. Set `arena_tailer_enabled: true`.
3. Restart the process. Expect a `Arena tailer started` log line, then
   `arena blk <n> <trx>: <action>` lines as ops land.

It targets **last-irreversible** blocks (reorg-safe), resumes from a persisted
cursor (`arena_tailer_state`), and runs **one instance only** (see the module
header — two instances double-poll).

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
