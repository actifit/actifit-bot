# Building the unique ledger indexes

`token_transactions` (the AFIT ledger, ~23M rows) gets two **partial unique** indexes that
make credits idempotent at the database level. The API does **not** build them at startup:
even a partial index has to examine every document, which is real IO on the primary plus a
brief exclusive lock when the build commits. On startup the API only logs
`!!! token_transactions index … is MISSING` for each one that is absent
(`afit_balance.ensureLedgerIndexes`).

| Index | Key | Partial filter | Guards |
|---|---|---|---|
| `afit_deposit_unique` | `{ user: 1, se_trx_ref: 1 }` | `{ se_trx_ref: { $type: 'string' } }` | one credit per Hive-Engine deposit transaction |
| `afit_web_reward_unique` | `{ user: 1, reward_activity: 1, reward_date: 1 }` | `{ reward_date: { $gte: ISODate('2026-10-29') } }` | one web vote/edit/comment reward per user per day, from 2026-10-29 on |

The web-reward index only covers rows from 2026-10-29 on: the ledger holds historical
duplicate web rewards (2019-2020, from before the per-user lock). They were spent long ago
and are kept as they are, so they are left outside the index rather than deleted.

`$type` (not `$exists`) on purpose: `$exists` also matches an explicit `null`, which would
pull ordinary rows into a unique index.

Until they exist, the code-level guard still holds: both the deposit credit and the web
reward run under the per-user AFIT lock (`request_locks`, `afit:<user>`) with an upsert keyed
on the same fields, so concurrent requests for one user are serialised.

## Procedure (off-peak, `mongosh` against the primary)

### 1. Check for duplicates first

A unique build fails on the first duplicate it meets. Both checks only look at the rows the
partial index would cover.

```js
// deposits credited more than once
db.token_transactions.aggregate([
  { $match: { se_trx_ref: { $type: 'string' } } },
  { $group: { _id: { user: '$user', ref: '$se_trx_ref' }, n: { $sum: 1 }, ids: { $push: '$_id' }, total: { $sum: '$token_count' } } },
  { $match: { n: { $gt: 1 } } },
], { allowDiskUse: true })

// web rewards recorded more than once for the same day
db.token_transactions.aggregate([
  { $match: { reward_date: { $gte: ISODate('2026-10-29') } } },
  { $group: { _id: { user: '$user', activity: '$reward_activity', day: '$reward_date' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { n: { $gt: 1 } } },
], { allowDiskUse: true })
```

Any result is a real double credit. Resolve each one (keep one row, remove the extras, then
rebuild that user's cached balance with `/recalculateUserTokens` or the daily rebuild) and
re-run the check until both return nothing.

### 2. Build

```js
db.token_transactions.createIndex(
  { user: 1, se_trx_ref: 1 },
  { name: 'afit_deposit_unique', unique: true, partialFilterExpression: { se_trx_ref: { $type: 'string' } } }
)
db.token_transactions.createIndex(
  { user: 1, reward_activity: 1, reward_date: 1 },
  { name: 'afit_web_reward_unique', unique: true, partialFilterExpression: { reward_date: { $gte: ISODate('2026-10-29') } } }
)
```

### 3. Verify

```js
db.token_transactions.getIndexes().filter(i => /^afit_(deposit|web_reward)_unique$/.test(i.name))
```

Both should be listed with `unique: true` and the partial filter above. The next API start
no longer logs the MISSING warning.

### Rollback

```js
db.token_transactions.dropIndex('afit_deposit_unique')
db.token_transactions.dropIndex('afit_web_reward_unique')
```

## `verified_tx` unique index on `tx_id`

`verified_tx` is the replay guard for signed on-chain payments: `utils.findVerifyTrx` refuses a
transaction id that already has a row, then stores the row once the chain confirms it. Two
requests racing with the same transaction can both pass that lookup before either stores its
row. A unique index on `tx_id` makes the second insert fail; the API treats that duplicate-key
error as "trx already exists" and refuses the second request.

| Index | Key | Partial filter | Guards |
|---|---|---|---|
| `verified_tx_unique` | `{ tx_id: 1 }` | `{ tx_id: { $type: 'string' } }` | one stored row (one use) per chain transaction |

The filter keeps out rows without a string `tx_id` (some older broadcast results), which would
otherwise all collide on `null`. As with the ledger indexes, the API does not build it: at
startup it logs `!!! verified_tx unique index on tx_id is MISSING` until one exists (any unique
index on exactly `{ tx_id: 1 }` counts, whatever its name).

### 1. Check for duplicates first

```js
db.verified_tx.aggregate([
  { $match: { tx_id: { $type: 'string' } } },
  { $group: { _id: '$tx_id', n: { $sum: 1 }, ids: { $push: '$_id' }, dates: { $push: '$date' } } },
  { $match: { n: { $gt: 1 } } },
], { allowDiskUse: true })
```

Each result is one transaction stored more than once. The rows are only a record of what was
verified, so keep the oldest row of each group and remove the others (check first whether the
duplicate also produced a second credit or delivery, and fix that separately):

```js
db.verified_tx.aggregate([
  { $match: { tx_id: { $type: 'string' } } },
  { $sort: { _id: 1 } },
  { $group: { _id: '$tx_id', n: { $sum: 1 }, ids: { $push: '$_id' } } },
  { $match: { n: { $gt: 1 } } },
], { allowDiskUse: true }).forEach((g) => db.verified_tx.deleteMany({ _id: { $in: g.ids.slice(1) } }))
```

Re-run the check until it returns nothing.

### 2. Build

```js
db.verified_tx.createIndex(
  { tx_id: 1 },
  { name: 'verified_tx_unique', unique: true, partialFilterExpression: { tx_id: { $type: 'string' } } }
)
```

If the collection already has a plain (non-unique) `{ tx_id: 1 }` index and the server refuses
a second index on the same key, drop the plain one first (`db.verified_tx.dropIndex('tx_id_1')`,
using the name `getIndexes()` shows) and build the unique one right after; lookups by `tx_id`
use either.

### 3. Verify

```js
db.verified_tx.getIndexes().filter(i => i.name === 'verified_tx_unique')
```

### Rollback

```js
db.verified_tx.dropIndex('verified_tx_unique')
```
