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
