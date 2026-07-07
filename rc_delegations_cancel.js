/*
 * rc_delegations_cancel.js
 *
 * Cancels outgoing RC (Resource Credit) direct delegations from the pay account
 * (actifit.pay) by re-delegating with max_rc: 0.
 *
 * This is the runnable version of rc_delegations_script.txt. It loads its
 * credentials from a SEPARATE config file (rc_delegations_config.json) so the
 * private key never lives inside the script.
 *
 * RC delegation is authorized by the account's POSTING key
 * (required_posting_auths), matching the working delegateRC() in utils.js.
 *
 * Setup:
 *   cp rc_delegations_config.example.json rc_delegations_config.json
 *   # edit rc_delegations_config.json -> set pay_account_posting_key
 *
 * Run:
 *   node rc_delegations_cancel.js                 # uses dry_run from config
 *   node rc_delegations_cancel.js --live          # force real broadcast
 *   node rc_delegations_cancel.js --dry-run       # force dry run (no broadcast)
 *   node rc_delegations_cancel.js --recent        # order by recency (keep newest)
 *   node rc_delegations_cancel.js --config path   # use a different config file
 */

const fs = require('fs');
const hive = require('@hiveio/hive-js');

// ---- load separate config -------------------------------------------------
function loadConfig() {
  const args = process.argv.slice(2);
  const cfgFlagIdx = args.indexOf('--config');
  const cfgPath = cfgFlagIdx !== -1 ? args[cfgFlagIdx + 1] : './rc_delegations_config.json';

  if (!fs.existsSync(cfgPath)) {
    console.error('Missing config file: ' + cfgPath);
    console.error('Copy rc_delegations_config.example.json to rc_delegations_config.json and set pay_account_posting_key.');
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  // CLI overrides for the dry_run flag
  if (args.includes('--live')) cfg.dry_run = false;
  if (args.includes('--dry-run')) cfg.dry_run = true;

  // defaults
  cfg.min_total_to_run = cfg.min_total_to_run != null ? cfg.min_total_to_run : 60;
  cfg.keep_recent = cfg.keep_recent != null ? cfg.keep_recent : 20;
  cfg.delay_ms = cfg.delay_ms != null ? cfg.delay_ms : 3000;
  cfg.excludeList = cfg.excludeList || [];
  cfg.order = cfg.order || 'recent'; // 'recent' (chronological) | 'account' (alphabetical)
  cfg.history_scan_limit = cfg.history_scan_limit != null ? cfg.history_scan_limit : 100000;

  // CLI overrides for ordering
  if (args.includes('--recent')) cfg.order = 'recent';

  if (!cfg.pay_account) {
    console.error('config.pay_account is required');
    process.exit(1);
  }
  if (!cfg.dry_run && (!cfg.pay_account_posting_key || cfg.pay_account_posting_key.indexOf('PUT_') === 0)) {
    console.error('config.pay_account_posting_key is required for a live run. Set it in rc_delegations_config.json.');
    process.exit(1);
  }
  return cfg;
}

const config = loadConfig();

// ---- hive node setup ------------------------------------------------------
if (config.alt_hive_nodes) {
  hive.config.set('alternative_api_endpoints', config.alt_hive_nodes);
}
hive.api.setOptions({ url: config.active_hive_node || 'https://api.hive.blog' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- fetch ALL outgoing RC direct delegations (paginated) -----------------
async function fetchAllRCDelegations(fromAccount) {
  const pageSize = 1000;
  let all = [];
  let start = [fromAccount, ''];

  while (true) {
    const res = await hive.api.callAsync('rc_api.list_rc_direct_delegations', { start, limit: pageSize });
    const page = (res && res.rc_direct_delegations) || [];
    if (page.length === 0) break;

    // rc_api pagination returns the `start` row again as the first element of
    // the next page; drop it to avoid double-processing.
    const fresh = all.length > 0 ? page.slice(1) : page;
    // only keep rows that actually belong to our delegator
    const mine = fresh.filter((d) => d.from === fromAccount);
    all = all.concat(mine);

    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    start = [last.from, last.to];
  }
  return all;
}

// ---- recency ordering via account history ---------------------------------
// rc_api.list_rc_direct_delegations only sorts by account name and carries no
// timestamp. To order by recency we scan the delegator's account history
// (newest -> oldest) for `custom_json` id=rc / delegate_rc ops and record when
// each currently-active delegatee was last set. First time we see a delegatee
// walking backwards == its most recent delegation.
async function fetchRecencyMap(delegator, activeToSet, maxOps) {
  const pageSize = 1000;
  const recency = new Map(); // delegatee -> { idx, ts }
  const remaining = new Set(activeToSet);
  let start = -1;
  let scanned = 0;

  while (scanned < maxOps && remaining.size > 0) {
    const lim = start === -1 ? pageSize : Math.min(pageSize, start);
    if (lim <= 0) break;

    const txs = await hive.api.getAccountHistoryAsync(delegator, start, lim);
    if (!txs || txs.length === 0) break;

    // txs are ascending by index; walk newest -> oldest
    for (let i = txs.length - 1; i >= 0; i--) {
      const entry = txs[i][1];
      scanned++;
      const op = entry.op;
      if (op[0] !== 'custom_json' || op[1].id !== 'rc') continue;
      let parsed;
      try { parsed = JSON.parse(op[1].json); } catch (e) { continue; }
      if (parsed[0] !== 'delegate_rc' || !Array.isArray(parsed[1].delegatees)) continue;
      for (const d of parsed[1].delegatees) {
        if (remaining.has(d) && !recency.has(d)) {
          recency.set(d, { idx: txs[i][0], ts: entry.timestamp });
          remaining.delete(d);
        }
      }
    }

    const oldestIdx = txs[0][0];
    if (oldestIdx <= 0) break; // reached the beginning of history
    start = oldestIdx - 1;
  }

  if (remaining.size > 0) {
    console.log('note: ' + remaining.size + ' active delegatee(s) not found within ' +
      maxOps + ' history ops (scanned ' + scanned + '); treated as oldest.');
  }
  return recency;
}

// ---- cancel a single delegation (max_rc: 0) -------------------------------
async function cancelDelegation(delegator, postingKey, targetUser) {
  const json_data = JSON.stringify(['delegate_rc', {
    from: delegator,
    delegatees: [targetUser],
    max_rc: 0,
  }]);

  return hive.broadcast.customJsonAsync(
    postingKey,        // active/posting key string
    [],                // required_auths
    [delegator],       // required_posting_auths
    'rc',              // custom_json id
    json_data
  );
}

// ---- main -----------------------------------------------------------------
async function mainLooper() {
  const delegator = config.pay_account;
  console.log('--- RC delegation cancellation ---');
  console.log('delegator      : ' + delegator);
  console.log('node           : ' + (config.active_hive_node || 'https://api.hive.blog'));
  console.log('dry_run        : ' + config.dry_run);

  const activeRCDelegations = await fetchAllRCDelegations(delegator);
  console.log('total active RC delegations: ' + activeRCDelegations.length);

  if (activeRCDelegations.length <= config.min_total_to_run) {
    console.log('Below min_total_to_run (' + config.min_total_to_run + '). Nothing to do.');
    return;
  }

  // ordering: 'account' (default, alphabetical by delegatee) or 'recent'
  // (chronological via account history — oldest first, so keep_recent keeps the newest)
  if (config.order === 'recent') {
    console.log('ordering by recency (scanning up to ' + config.history_scan_limit + ' history ops)...');
    const activeSet = new Set(activeRCDelegations.map((d) => d.to));
    const recency = await fetchRecencyMap(delegator, activeSet, config.history_scan_limit);
    // ascending: oldest (or unknown) first, newest last
    activeRCDelegations.sort((a, b) => {
      const ra = recency.get(a.to);
      const rb = recency.get(b.to);
      const ia = ra ? ra.idx : -1;
      const ib = rb ? rb.idx : -1;
      return ia - ib;
    });
  }

  // keep the last `keep_recent` entries untouched (throttle: drain over multiple runs)
  const cutoff = activeRCDelegations.length - config.keep_recent;
  const targets = [];
  for (let j = 0; j < cutoff; j++) {
    const to = activeRCDelegations[j].to;
    if (config.excludeList.includes(to)) continue;
    targets.push(to);
  }

  console.log('will cancel ' + targets.length + ' delegations (keeping last ' +
    config.keep_recent + ', excluding ' + config.excludeList.length + ' accounts)');

  let done = 0;
  let failed = 0;
  for (const to of targets) {
    if (config.dry_run) {
      console.log('[dry-run] would cancel RC delegation to ' + to);
      done++;
      continue;
    }
    try {
      await cancelDelegation(delegator, config.pay_account_posting_key, to);
      done++;
      console.log('cancelled (' + done + '/' + targets.length + ') -> ' + to);
    } catch (err) {
      failed++;
      console.log('FAILED -> ' + to + ' : ' + (err && err.message ? err.message : err));
    }
    await sleep(config.delay_ms);
  }

  console.log('--- done. cancelled: ' + done + ', failed: ' + failed + ' ---');
}

mainLooper()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
