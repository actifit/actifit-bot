# Test Coverage Gaps Report

**Generated:** 2026-04-25
**Branch:** security/update-deprecated-modules
**Total Current Tests:** 117 (11 test suites)
**Estimated Coverage:** ~12-15% of application code

---

## Executive Summary

The current test suite consists of:
- **Library smoke tests** (moment, lodash, jwt, web3, nodemailer) — verifying npm packages load
- **External HTTP ping tests** — verifying httpbin.org is reachable
- **Security regression tests** — verifying vulnerability fixes (eval removal, ObjectId validation, JSON.parse handling)
- **Authentication middleware tests** — verifying `checkHdrs` token validation and error responses
- **Utils unit tests** — verifying pure functions from `utils.js` (currency parsing, scoring, time formatting, vesting shares, beneficiary checks, vote calculation)
- **Mail unit tests** — verifying `sendPlainMail` and `sendWithTemplate` with mocked nodemailer
- **Integration tests** — 11 endpoints tested with seeded mock MongoDB data (users, settings, bans, transactions, notifications, news, surveys, products, moderators)

**Recently added tests:**
- 16 integration tests covering `userSettings`, `is_banned`, `user`, `userFullBal`, `transactions`, `activeNotifications`, `news`, `surveys`, `products`, `moderators`, `banned_users`
- 6 mail.js tests for `sendPlainMail` and `sendWithTemplate`
- 8 additional utils unit tests for `getVestingShares`, `checkBeneficiary` (bug found & fixed), `calculateVotes`

**Recent code fixes:**
- Background `node-schedule` timers in `app.js` now skipped when `NODE_ENV=test` — eliminates Jest force-exit warnings
- `generatePassword` replaced `Math.random()` with `crypto.randomBytes()` for cryptographically secure token generation

**Still untested:** Most endpoints (~215 of 235), many `utils.js` functions (~66 of 87), `delegations.js`.

---

## 1. Express API Endpoints (235 total)

| Status | Count | Percentage |
|--------|-------|------------|
| Tested | 17 | 7.2% |
| Exercised (middleware only) | 3 | 1.3% |
| Untested | 215 | 91.5% |

### Tested Endpoints (behavioral tests — request/response verified)
1. `GET /appendVerifiedPost` — security regression (eval removal, JSON.parse handling)
2. `GET /gadgetBought` — security regression (ObjectId validation)
3. `GET /sendNotification` — security regression (eval replacement)
4. `GET /voteSurvey` — ObjectId validation + middleware auth
5. `GET /updateProdStatus` — ObjectId validation
6. `GET /confirmProdReceipt` — ObjectId validation
7. `GET /userSettings/:user` — integration test with mock DB
8. `GET /is_banned/:user` — integration test with mock DB
9. `GET /user/:user` — integration test with mock DB
10. `GET /userFullBal/:user` — integration test with mock DB
11. `GET /transactions/:user` — integration test with mock DB
12. `GET /activeNotifications/:user` — integration test with mock DB
13. `GET /news` — integration test with mock DB
14. `GET /surveys` — integration test with mock DB
15. `GET /moderators` — integration test with mock DB
16. `GET /banned_users` — integration test with mock DB
17. `GET /products` — integration test with mock DB

### Exercised Endpoints (middleware/auth only)
- `GET /markRead/:notif_id` — tested via `checkHdrs` middleware
- `GET /markUnread/:notif_id` — tested via `checkHdrs` middleware
- `GET /performTrx` — tested via JSON.parse error handling

### Critical Untested Endpoints (by category)

#### Authentication & User Management (8 endpoints)
- `POST /loginKeychain/`
- `POST /loginAuth`
- `GET /deleteAccount/`
- `GET /deleteAccountKeychain/:trxID`
- `GET /resetLogin`
- `GET /resetFundsPass`
- `GET /updateSettings/`
- `GET /updateSettingsKeychain/:trxID`

**Risk:** No verification that authentication flows, password resets, or account deletion work correctly.

**Note:** `userSettings`, `user`, and `userFullBal` are now tested.

#### Token & Wallet Operations (16 endpoints)
- `GET /transactions/:user?`
- `GET /transactionsByType/`
- `GET /topAFITHolders`
- `GET /topAFITHEHolders`
- `GET /topAFITXHolders`
- `GET /afitxData/:user`
- `GET /getUserWalletAddress`
- `GET /storeUserWalletAddress`
- `GET /deleteUserWalletAddress`
- `GET /userBridgeEligible`
- `GET /userBridgeTransactions`
- `GET /appendBridgeTransaction`
- `GET /tipAccount`
- `GET /totalTipped`
- `GET /tippedToday/:user`
- `GET /processTipRequest`

**Risk:** Financial transaction endpoints mostly untested.

**Note:** `/transactions/:user` is now tested.

#### Gadget/Product Purchases (20 endpoints)
- `GET /buyGadgetHive/:user/:gadget/:blockNo/:trxID/:bchain`
- `GET /buyGadgetHiveKeychain/:user/:gadget/:trxID/:bchain`
- `GET /buyMultiGadgetHive/:user/:gadgets/:blockNo/:trxID/:bchain`
- `GET /buyMultiGadgetHiveKeychain/:user/:gadgets/:trxID/:bchain`
- `GET /activateGadget/:user/:gadget/:blockNo/:trxID/:bchain/:benefic?`
- `GET /activateMultiGadget/:user/:gadgets/:blockNo/:trxID/:bchain/:benefic?`
- `GET /deactivateGadget/:user/:gadget/:blockNo/:trxID/:bchain`
- `POST /purchaseRealProduct/`
- `GET /confirmProdReceipt`
- `GET /refundPurchase`
- `GET /updateProdStatus`
- `GET /products`
- `GET /productBought`
- `GET /productBoughtToken`

**Risk:** E-commerce flow completely untested.

#### Social Features (13 endpoints)
- `GET /addFriend/:userA/:userB/:blockNo/:trxID/:bchain`
- `GET /acceptFriend/:userA/:userB/:blockNo/:trxID/:bchain`
- `GET /dropFriendship/:userA/:userB/:blockNo/:trxID/:bchain`
- `GET /cancelFriendRequest/:userA/:userB/:blockNo/:trxID/:bchain`
- `GET /userFriends/:user`
- `GET /userFriendRequests/:user`
- `GET /friendships`
- `GET /pendingFriendships`
- `GET /sendNotification`
- `GET /markRead/:notif_id`
- `GET /markUnread/:notif_id`
- `GET /markAllRead/`
- `GET /readNotifications/:user`

**Risk:** Social graph and notification system mostly untested.

**Note:** `activeNotifications` and `sendNotification` are now tested.

#### Admin/Moderator (5 endpoints)
- `GET /modAction`
- `GET /moderatorActivity`
- `GET /moderatorWeeklyStats`
- `GET /getUnverifiedFundsAccountList/`
- `GET /getFullFundsAccountList/`

**Risk:** Admin activity reporting untested.

**Note:** `moderators`, `banned_users`, and `is_banned` are now tested.

#### Workout API (5 endpoints)
- `POST /saveworkout`
- `GET /workouts`
- `GET /workouts/:workoutId`
- `PUT /workouts/:workoutId`
- `DELETE /workouts/:workoutId`

**Risk:** CRUD operations for user workouts untested.

#### Blockchain Info (8 endpoints)
- `GET /getChainInfo`
- `GET /getAccountData`
- `GET /pendingRewards`
- `GET /claimRewards`
- `GET /availableHiveNodes`
- `GET /delegateRC`
- `GET /getRC`
- `GET /getRank/:user`

**Risk:** Blockchain integration endpoints untested.

#### Content (8 endpoints)
- `GET /userVotedSurvey`
- `GET /votingStatus`
- `GET /queryPost`
- `GET /postsbytag/:tag`
- `GET /recentVerifiedPosts`
- `GET /trackedActivity/:user`
- `GET /trackedMeasurements/:user`

**Risk:** Content retrieval and voting mostly untested.

**Note:** `news`, `surveys`, and `voteSurvey` are now tested.

---

## 2. Utility Functions (`utils.js` — 87 functions)

| Status | Count |
|--------|-------|
| Tested | 21 |
| Untested | 66 |

### Tested Functions
- `getCurrency` — token symbol extraction from amount strings
- `format` — number formatting with thousand separators
- `toTimer` — seconds to HH:MM:SS formatting
- `toHrMn` — minutes to Hr:Mn formatting
- `sortArrLodash` — array sorting by balance descending
- `asyncForEach` — async array iteration
- `generateRandomNumber` — random integer generation within range
- `getConfig` — configuration loader and caching
- `timeTilFullPower` — voting power regeneration timing
- `timeTilKickOffVoting` — voting kickoff timing
- `calcScore` — rule-based score calculation
- `calcScoreExtended` — extended score calculation with max_val
- `loadUserList` — null/empty location handling
- `log` — logging function existence
- `getVestingShares` — effective vesting shares calculation
- `checkBeneficiary` — beneficiary validation (bug found & fixed: partial matches no longer pass)
- `calculateVotes` — vote power per post calculation

**Note:** These are mostly pure/helper functions. Critical functions like `validateAccountLogin`, `processSteemTrx`, `sendNotification`, `claimRewards`, and blockchain operations remain untested.

### Critical Untested Functions

#### Authentication & Security (5 functions)
- `validateAccountLogin` — core login validation
- `encodeMemo` / `decodeMemo` — encryption/decryption
- `processSteemTrx` — transaction signing and submission

**Risk:** Authentication and transaction security untested.

#### Financial Calculations (5 functions)
- `getVoteValue` / `getVoteValueUSD` — vote value calculation
- `rewardCap` — reward limiting
- `getVoteRShares` — reward share calculation

**Risk:** Financial math errors could affect user rewards.

**Note:** `getVestingShares`, `timeTilFullPower`, and `timeTilKickOffVoting` are now tested.

#### Blockchain Operations (15 functions)
- `getChainInfo` / `getAccountData` — chain data retrieval
- `processSteemTrx` — transaction processing
- `claimRewards` — reward claiming
- `commentToChain` — posting comments
- `fetchChainRewards` / `fetchPendingRewards` — reward fetching
- `proceedSendToken` — token transfers
- `delegateRC` / `fetchRCDelegations` — RC delegation
- `createAccount` / `claimDiscountedAccount` — account creation
- `delegateToAccount` — HP delegation

**Risk:** Blockchain interaction completely untested.

#### Notification System (3 functions)
- `sendNotification` — main notification dispatcher
- `sendFirebaseNotification` — FCM mobile notifications
- `sendFirebaseWebNotification` — FCM web notifications

**Risk:** Notification delivery untested.

#### Data Processing (2 functions)
- `filterPosts` — post filtering
- `updateSteemVariables` — global variable updates

**Risk:** Core business logic (post filtering) untested.

**Note:** `calcScore`, `calcScoreExtended`, `calculateVotes`, `checkBeneficiary`, `format`, `toTimer`, `toHrMn`, and `loadUserList` (null cases) are now tested.

#### Account & Payment Verification (8 functions)
- `findVerifyTrx` — transaction verification
- `storeVerifiedTrx` — verified transaction storage
- `confirmPaymentReceived` — payment confirmation
- `confirmPaymentReceivedPassword` — password-protected payment confirmation
- `confirmPaymentReceivedBuy` — purchase payment confirmation
- `verifyGadgetPayTransaction` — gadget payment verification
- `verifyAFITBuyTransaction` — AFIT purchase verification
- `verifyWorkoutTransaction` — workout payment verification

**Risk:** Payment verification logic untested.

#### Helper Functions (15 functions, 10 tested)
- `getCurrency` / `extractCurrency` — currency parsing ✅ tested
- `getConfig` — configuration loader ✅ tested
- `log` — logging utility ✅ tested
- `asyncForEach` — async array iteration ✅ tested
- `generateRandomNumber` — random number generation ✅ tested
- `sortArrLodash` / `removeArrMatchLodash` — lodash wrappers ✅ tested (sortArrLodash)
- `getVestingShares` — vesting share calculation ✅ tested
- `calculateVotes` — vote weight distribution ✅ tested
- `checkBeneficiary` — beneficiary validation ✅ tested
- `setProperNode` / `setProperDNode` — node selection ❌ untested
- `customArraysEqual` / `arraysEqual` — array comparison ❌ untested
- `padLeft` — string padding ❌ untested
- `resetVals` — value reset utility ❌ untested

**Risk:** Untested helper bugs could cascade into larger issues.

---

## 3. Email Functions (`mail.js` — 2 functions)

| Status | Count |
|--------|-------|
| Tested | 2 |
| Untested | 0 |

- `sendPlainMail` — plain text email sending ✅ tested (single recipient, array recipients, error rejection)
- `sendWithTemplate` — templated email with attachments ✅ tested (template data, attachment inclusion, array recipients)

**Risk:** Low — wrapper is thin, nodemailer is battle-tested.

---

## 4. Middleware (`app.js` — 1 function)

| Status | Count |
|--------|-------|
| Tested | 1 |
| Untested | 0 |

- `checkHdrs` — JWT token validation and user authentication middleware

**Tested scenarios:**
- Missing token → returns "Auth token is not provided"
- Invalid token → returns "Token is not valid"
- Missing user parameter → returns "user not supplied"
- Valid token but no DB entry → returns "Authentication failed. Key not found"
- `x-acti-token` header support verified

---

## 6. Security-Sensitive Patterns

| Pattern | Count | Tested |
|---------|-------|--------|
| `crypto.createCipher` / `createDecipher` | 10 | 0 |
| `jwt.sign` / `jwt.verify` | 2 | 1 (`jwt.verify` in `checkHdrs` middleware) |
| `db.collection(...)` operations | 315 | ~20 (integration tests with mock DB verify query shape and filtering) |
| `axios.get` / `axios.post` | 3 | 0 (external calls mocked) |
| `hive.api.*` calls | 10 | 0 |
| `blurt.api.*` calls | 3 | 0 |
| `new ObjectId(...)` with user input | 18 | 6 (now tested) |
| `JSON.parse(...)` with user input | 6 | 6 (now tested) |
| `eval(...)` | 0 | 0 (removed) |
| `Math.random()` for passwords/tokens | 1 | 0 (replaced with `crypto.randomBytes`) |

---

## 7. Delegation Script (`delegations.js`)

This file (~1,500 lines) handles HP delegation rewards and has **zero tests**.

Key untested functionality:
- Delegator list fetching
- Reward calculation based on delegation amount
- Weekly reward distribution
- RC delegation management
- Steem/Hive/Blurt multi-chain delegation tracking

**Risk:** Financial reward distribution logic untested.

---

## Priority Matrix

### Critical (Test Immediately)
| Area | Impact | Effort | Files | Status |
|------|--------|--------|-------|--------|
| `checkHdrs` middleware | All authenticated endpoints | Low | `app.js` | ✅ Tested |
| `validateAccountLogin` | User authentication | Low | `utils.js` | ❌ Untested |
| `sendNotification` | User notifications | Low | `utils.js` | ✅ Endpoint tested |
| `processSteemTrx` | Transaction security | Medium | `utils.js` | ❌ Untested |
| `confirmPaymentReceived*` | Payment verification | Medium | `utils.js` | ❌ Untested |

### High (Test Next)
| Area | Impact | Effort | Files | Status |
|------|--------|--------|-------|--------|
| `calcScore` / `calcScoreExtended` | Reward calculation | Medium | `utils.js` | ✅ Tested |
| `getVoteValue` / `getVoteValueUSD` | Financial math | Low | `utils.js` | ❌ Untested |
| `findVerifyTrx` | Transaction integrity | Medium | `utils.js` | ❌ Untested |
| `sendPlainMail` / `sendWithTemplate` | Email delivery | Low | `mail.js` | ✅ Tested |
| Login endpoints (`/loginAuth`, `/loginKeychain`) | Authentication flow | Medium | `app.js` | ❌ Untested |
| Wallet endpoints (`/transactions`, `/userFullBal`) | Financial data | Medium | `app.js` | ✅ Tested |

### Medium (Test Eventually)
| Area | Impact | Effort | Files | Status |
|------|--------|--------|-------|--------|
| `getChainInfo` / `getAccountData` | Blockchain read | Medium | `utils.js` | ❌ Untested |
| `claimRewards` | Reward claiming | Medium | `utils.js` | ❌ Untested |
| `delegateRC` / `fetchRCDelegations` | RC management | Medium | `utils.js` | ❌ Untested |
| Content endpoints (`/news`, `/surveys`, `/voteSurvey`) | Content | Medium | `app.js` | ✅ Tested |
| Social endpoints (`/addFriend`, `/userFriends`) | Social features | Medium | `app.js` | ❌ Untested |
| Workout CRUD endpoints | Fitness features | Medium | `app.js` | ❌ Untested |

### Low (Nice to Have)
| Area | Impact | Effort | Files | Status |
|------|--------|--------|-------|--------|
| `getCurrency` / `extractCurrency` | Parsing utilities | Low | `utils.js` | ✅ Tested |
| `format` / `toTimer` / `toHrMn` | Formatting | Low | `utils.js` | ✅ Tested |
| `getVestingShares` / `calculateVotes` / `checkBeneficiary` | Core math/logic | Low | `utils.js` | ✅ Tested |
| `updateSteemVariables` | Global state | Medium | `utils.js` | ❌ Untested |
| Admin endpoints (`/moderators`, `/banned_users`) | Admin tools | Medium | `app.js` | ✅ Tested |
| Prize/lottery endpoints | Gamification | Medium | `app.js` | ❌ Untested |

---

## Recommended Testing Strategy

### Phase 1: Security & Auth (1-2 days) ✅ Partially Complete
- ✅ Test `checkHdrs` middleware with valid/invalid/expired tokens
- ✅ Test `eval()` removal on endpoints
- ✅ Test `ObjectId` validation error handling
- ✅ Test `JSON.parse` error handling
- ❌ Test `validateAccountLogin` with valid/invalid credentials
- ❌ Test login endpoints (`/loginAuth`, `/loginKeychain`)
- ❌ Test `processSteemTrx` with mocked blockchain

### Phase 2: Financial Core (2-3 days) ✅ Partially Complete
- ✅ Test `calcScore` / `calcScoreExtended` with sample posts
- ❌ Test `getVoteValue` / `getVoteValueUSD` with known values
- ❌ Test `confirmPaymentReceived*` with mocked transactions
- ❌ Test wallet endpoints with mocked database

### Phase 3: Data Pipeline (3-5 days)
1. Test `runPostsProcess` with sample posts
2. Test `filterPosts` with various post types
3. Test `updateUserTokens` with sample transactions
4. Test `processTransactions` with sample data

### Phase 4: Integration (5-7 days)
1. Test full login → fetch data → perform action flow
2. Test gadget purchase flow end-to-end
3. Test notification flow (trigger → send → mark read)
4. Test friend request flow end-to-end

---

## Testing Infrastructure Needed

To achieve meaningful coverage, the following test infrastructure is recommended:

1. **MongoDB Memory Server** — For testing database queries without a real MongoDB instance
2. **Nock** — For mocking external HTTP calls (axios, blockchain APIs)
3. **Sinon** — For spies, stubs, and mocks on functions
4. **Test fixtures** — Sample JSON data for posts, transactions, users, votes
5. **Test config** — Already created (`tests/test-config.json`)

---

*This report was generated by analyzing the codebase for untested functions, endpoints, and security-sensitive patterns. The counts are approximate and based on static analysis.*
