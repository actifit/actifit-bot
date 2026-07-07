# RC Delegations — Cancel Outgoing Delegations from `actifit.pay`

Cancels outgoing **RC (Resource Credit) direct delegations** from the pay account
(`actifit.pay`) by re-delegating each with `max_rc: 0`.

This is the runnable replacement for the old `rc_delegations_script.txt` snapshot
(which had no imports, no node setup, and an empty key). The private key lives in a
**separate, gitignored config file** — never in the script.

Files:

| File | Purpose |
| --- | --- |
| `rc_delegations_cancel.js` | The runnable script |
| `rc_delegations_config.example.json` | Config template (safe to commit) |
| `rc_delegations_config.json` | **Your real config with the private key** (gitignored) |

---

## 1. Setup

```bash
cd actifitbot
cp rc_delegations_config.example.json rc_delegations_config.json
```

Then edit `rc_delegations_config.json` and set `pay_account_posting_key`.

> **Which key?** RC delegation is authorized by the account's **private POSTING
> key** (the op uses `required_posting_auths: ['actifit.pay']`) — *not* the active
> key. This is the same value your main `config.json` stores as
> `pay_account_posting_key`.

`rc_delegations_config.json` is already in `.gitignore` (next to `config.json`), so
the key won't be committed.

---

## 2. Run

Via npm:

```bash
npm run rc-cancel
```

Or directly:

```bash
node rc_delegations_cancel.js
```

By default the config ships with `"dry_run": true`, so the first run **only logs
what it would cancel** and broadcasts nothing. Review that output, then go live.

### CLI flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Force a dry run (log only, no broadcast) — overrides config |
| `--live` | Force a real broadcast — overrides config |
| `--recent` | Order by recency (keep the newest delegations) — overrides config |
| `--config <path>` | Use a different config file (default `./rc_delegations_config.json`) |

Typical flow:

```bash
# 1. See what would happen — dry run + recency ordering are both defaults
node rc_delegations_cancel.js

# 2. When satisfied, actually cancel (keeps the newest `keep_recent`)
node rc_delegations_cancel.js --live
```

---

## 3. Config reference (`rc_delegations_config.json`)

| Field | Default | Meaning |
| --- | --- | --- |
| `pay_account` | `actifit.pay` | Account whose outgoing RC delegations are cancelled |
| `pay_account_posting_key` | — | **Private posting key** of `pay_account` (required for `--live`) |
| `active_hive_node` | `https://api.hive.blog` | Primary Hive API node |
| `alt_hive_nodes` | *(list)* | Fallback nodes |
| `excludeList` | *(list)* | Accounts that must **never** be cancelled (exact account names) |
| `min_total_to_run` | `60` | Only run if there are **more** than this many active delegations |
| `keep_recent` | `20` | Leave this many delegations untouched (throttle — see below) |
| `delay_ms` | `3000` | Delay between broadcasts, in ms (avoids rate/RC issues) |
| `dry_run` | `true` | If true, log only — no broadcast |
| `order` | `recent` | `recent` (chronological) or `account` (alphabetical) — see below |
| `history_scan_limit` | `100000` | Max account-history ops to scan when `order: recent` |

---

## 4. How it decides what to cancel

1. **Fetch** all active RC delegations from `actifit.pay` (paginated, 1000/page).
2. **Bail** if the total is `<= min_total_to_run`.
3. **Order** the list (see below).
4. **Keep** the last `keep_recent` entries untouched.
5. **Cancel** the rest — but always **skip anything in `excludeList`**.
6. Wait `delay_ms` between each broadcast.

### `keep_recent` is a throttle

The script intentionally leaves `keep_recent` delegations in place each run. This
lets you drain a large delegation set over **several runs** instead of firing
hundreds of ops at once. To cancel *everything* in one pass, set `keep_recent: 0`.

### `excludeList` is always honored

An excluded account is never cancelled, regardless of `order` — if it lands in the
cancel range it's skipped; if it lands in the kept tail it's never reached. Match
names **exactly** as they appear on-chain (e.g. `actifit.h-e`, not `actifit-he`).

### Ordering: `account` vs `recent`

- **`recent`** (default): reconstructs the real chronological order by scanning
  `actifit.pay`'s account history for the `delegate_rc` ops (the RC API carries no
  timestamp). Delegations are then sorted **oldest-first**, so `keep_recent` keeps
  the **genuinely newest** and cancellation drains the oldest first.
- **`account`**: the order returned by the RC API, which is alphabetical by
  delegatee name — effectively arbitrary with respect to time. Cheaper (no history
  scan); use it if you don't care which delegations are kept vs. cancelled.

`recent` mode reads account history in pages until every active delegatee is dated,
bounded by `history_scan_limit`. Any delegatee not found within that cap is treated
as oldest (cancelled first) and the script prints a note. This cap only exists to
prevent an unbounded deep scan on a very busy account; it does not change how many
delegations get cancelled.

---

## 5. Safety notes

- **Always dry-run first.** The default config does this for you.
- The key file `rc_delegations_config.json` is gitignored — keep it that way.
- Cancelling an RC delegation sets the recipient's delegated RC to 0; it does not
  affect HP (vesting) delegations.
- `delay_ms` spaces out broadcasts; lowering it too far risks node rate limits.
