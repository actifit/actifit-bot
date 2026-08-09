## Why this is needed

Adam's in-app signup wizard (`actifit/actifit` PR #85) has to call `confirmPayment`, but that endpoint is gated by `config.confirmPaymentToken` (`app.js:8496`). The obvious move — ship the token in the Android app — is the wrong one:

**Anything inside an APK is extractable.** Unzip, `strings`, done. And once someone has that token they can call `confirmPayment` directly, which matters because the endpoint currently trusts two client-supplied values:

- **`afit_reward`** — passed straight into the ledger at `app.js:6981`, `:7054` and `:7093` (the referrer bonus is a multiple of it). A caller can ask for any number of AFIT they like.
- **`promo_code`** — validated against the DB, but callable in a loop to burn entries.

The website never had this problem: it POSTs to its own `/api/proxy/confirmPayment` and injects the secret **server-side**, so the browser never sees it — and it sits behind reCAPTCHA. The app has no equivalent. This PR gives the app the same protection.

## What it does

**1. Extracts the handler and adds an app-facing route.**
`handleConfirmPayment` is now a named function shared by two registrations:

| Route | Caller | Token |
|---|---|---|
| `POST /confirmPayment` | server-to-server (the website's proxy) | supplied by caller — **unchanged** |
| `POST /app/confirmPayment` | the mobile app | **injected server-side**; the app sends none |

The app route is rate limited to 20 requests / 15 min per IP, reusing the existing `rateLimit` pattern already used for `/loginKeychain` and `/modAction`.

**2. Caps `afit_reward` server-side.**
`capSignupAfitReward()` mirrors the web client's `getMatchingAFIT()`: one "lot" per \$5 (minimum one), each lot worth up to 100 AFIT, never more than the USD paid converts to at the current AFIT price (`exchangeAfitPrice.afitHiveLastUsdPrice`, already maintained in-process for `/curAFITPrice`).

Deliberately conservative:
- it **only ever caps, never raises** the requested figure;
- it **leaves the value untouched when no ceiling can be derived** — promo signups pay \$0, and the AFIT price is unset until the first exchange poll completes.

So promo behaviour is byte-for-byte unchanged, and a legitimate paid signup sending the correct figure is unaffected. Only an inflated request gets clamped (and logged).

**3. Documents `/app/confirmPayment` in `swagger.yaml`.**

## What it helps with

- **The token stops being a shipped secret.** The app can complete signups without carrying anything extractable.
- **Closes an AFIT-minting vector that exists today** — note this applies to `/confirmPayment` too, so the website path is hardened by the same change, independent of the app.
- **Unblocks `actifit/actifit` #85.** Adam's side becomes a URL swap plus dropping one field; the request body he already builds is correct.

## Behaviour change to be aware of

The `afit_reward` cap applies to **both** routes, so it does change the existing endpoint. If any current caller legitimately sends more than the paid amount converts to, it will now be clamped and you'll see `capping signup afit_reward from X to Y` in the logs. I believe that's exactly what we want, but it's the one thing worth a second opinion before merge — if there's a promotion that intentionally over-rewards a *paid* signup, it should move to the promo path or the cap needs a carve-out.

## Verification

- `node --check app.js` clean; `npx eslint app.js` → 0 errors, 119 warnings (**unchanged from `develop`**).
- `npx jest` → 2 failures, both pre-existing network-dependent tests (`axios.test.js` hitting `httpbin.org`); `develop` itself fails 4 in the same suites, so nothing here regresses.
- `swagger.yaml` parses via `yamljs` and the new path resolves.

Not tested against a live MongoDB or a real signup — worth a staging run before merge, particularly the promo path, since that's the one where the cap deliberately no-ops.

## Still open (not in this PR)

- **How the app authenticates to `/app/confirmPayment`.** Right now it's rate-limit-only. That's a deliberate trade: the real protections are that account creation still requires a matching **on-chain payment**, promo codes are DB-validated with decrementing entries, and the reward is now capped. But it's weaker than the web's reCAPTCHA and worth a follow-up decision.
- **`confirmPaymentReceived()` (`utils.js:730`) never rejects** and the handler keep-alives every 6s, so clients can't time out — this is why the app's poll/timeout logic is unreachable. Fixing it would let the app behave sensibly on a payment that never arrives.
