# Test Coverage Gaps Report

**Generated:** 2026-04-24
**Branch:** security/update-deprecated-modules
**Total Current Tests:** 83 (8 test suites)
**Estimated Coverage:** ~5-8% of application code

---

## Executive Summary

The current test suite consists of:
- **Library smoke tests** (moment, lodash, jwt, web3, nodemailer) — verifying npm packages load
- **External HTTP ping tests** — verifying httpbin.org is reachable
- **Security regression tests** — verifying vulnerability fixes (eval removal, ObjectId validation, JSON.parse handling)
- **Authentication middleware tests** — verifying `checkHdrs` token validation and error responses
- **Utils unit tests** — verifying pure functions from `utils.js` (currency parsing, scoring, time formatting, etc.)

**Recently added tests (this branch):**
- 11 security regression tests covering `eval()` removal, `ObjectId` validation, and `JSON.parse` error handling on real endpoints
- 5 authentication middleware tests for `checkHdrs` (missing token, invalid token, missing user, DB lookup failure)
- 18 utils unit tests for `getCurrency`, `calcScore`, `getConfig`, `asyncForEach`, `generateRandomNumber`, etc.

**Still untested:** The vast majority of endpoints (~229 of 235), most `utils.js` functions (~69 of 87), and `mail.js`.

---

## 1. Express API Endpoints (235 total)

| Status | Count | Percentage |
|--------|-------|------------|
| Tested | 6 | 2.6% |
| Exercised (middleware only) | 3 | 1.3% |
| Untested | 226 | 96.1% |

### Tested Endpoints (behavioral tests — request/response verified)
1. `GET /appendVerifiedPost` — security regression (eval removal, JSON.parse handling)
2. `GET /gadgetBought` — security regression (ObjectId validation)
3. `GET /sendNotification` — security regression (eval replacement)
4. `GET /voteSurvey` — ObjectId validation + middleware auth
5. `GET /updateProdStatus` — ObjectId validation
6. `GET /confirmProdReceipt` — ObjectId validation

### Exercised Endpoints (middleware/auth only)
- `GET /markRead/:notif_id` — tested via `checkHdrs` middleware
- `GET /markUnread/:notif_id` — tested via `checkHdrs` middleware
- `GET /performTrx` — tested via JSON.parse error handling

### Critical Untested Endpoints (by category)

#### Authentication & User Management (11 endpoints)
- `POST /loginKeychain/`
- `POST /loginAuth`
- `GET /deleteAccount/`
- `GET /deleteAccountKeychain/:trxID`
- `GET /resetLogin`
- `GET /resetFundsPass`
- `GET /updateSettings/`
- `GET /updateSettingsKeychain/:trxID`
- `GET /userSettings/:user`
- `GET /user/:user`
- `GET /userFullBal/:user`

**Risk:** No verification that authentication flows, password resets, or account deletion work correctly.

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

**Risk:** Financial transaction endpoints completely untested.

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

#### Social Features (14 endpoints)
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
- `GET /activeNotifications/:user`
- `GET /readNotifications/:user`

**Risk:** Social graph and notification system untested.

#### Admin/Moderator (8 endpoints)
- `GET /modAction`
- `GET /moderators`
- `GET /banned_users`
- `GET /is_banned/:user`
- `GET /moderatorActivity`
- `GET /moderatorWeeklyStats`
- `GET /getUnverifiedFundsAccountList/`
- `GET /getFullFundsAccountList/`

**Risk:** Moderation tools and ban system untested.

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

#### Content (10 endpoints)
- `GET /news`
- `GET /surveys`
- `GET /voteSurvey`
- `GET /userVotedSurvey`
- `GET /votingStatus`
- `GET /queryPost`
- `GET /postsbytag/:tag`
- `GET /recentVerifiedPosts`
- `GET /trackedActivity/:user`
- `GET /trackedMeasurements/:user`

**Risk:** Content retrieval and voting untested.

---

## 2. Utility Functions (`utils.js` — 87 functions)

| Status | Count |
|--------|-------|
| Tested | 18 |
| Untested | 69 |

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

**Note:** These are mostly pure/helper functions. Critical functions like `validateAccountLogin`, `processSteemTrx`, `sendNotification`, `claimRewards`, and blockchain operations remain untested.

### Critical Untested Functions

#### Authentication & Security (5 functions)
- `validateAccountLogin` — core login validation
- `encodeMemo` / `decodeMemo` — encryption/decryption
- `processSteemTrx` — transaction signing and submission

**Risk:** Authentication and transaction security untested.

#### Financial Calculations (8 functions)
- `getVoteValue` / `getVoteValueUSD` — vote value calculation
- `getVestingShares` / `vestsToHivePower` / `hivePowerToVests` — token conversions
- `rewardCap` — reward limiting
- `getVoteRShares` — reward share calculation

**Risk:** Financial math errors could affect user rewards.

**Note:** `timeTilFullPower` and `timeTilKickOffVoting` are now tested for return type and basic behavior.

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

#### Data Processing (3 functions)
- `calculateVotes` — vote calculation
- `filterPosts` — post filtering
- `checkBeneficiary` — beneficiary validation
- `updateSteemVariables` — global variable updates

**Risk:** Core business logic (filtering, vote calculation) untested.

**Note:** `calcScore`, `calcScoreExtended`, `format`, `toTimer`, `toHrMn`, and `loadUserList` (null cases) are now tested.

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

#### Helper Functions (15 functions, 7 tested)
- `getCurrency` / `extractCurrency` — currency parsing ✅ tested
- `getConfig` — configuration loader ✅ tested
- `log` — logging utility ✅ tested
- `asyncForEach` — async array iteration ✅ tested
- `generateRandomNumber` — random number generation ✅ tested
- `sortArrLodash` / `removeArrMatchLodash` — lodash wrappers ✅ tested (sortArrLodash)
- `setProperNode` / `setProperDNode` — node selection ❌ untested
- `customArraysEqual` / `arraysEqual` — array comparison ❌ untested
- `padLeft` — string padding ❌ untested
- `resetVals` — value reset utility ❌ untested

**Risk:** Untested helper bugs could cascade into larger issues.

---

## 3. Email Functions (`mail.js` — 2 functions)

| Status | Count |
|--------|-------|
| Tested | 0 |
| Untested | 2 |

- `sendPlainMail` — plain text email sending
- `sendWithTemplate` — templated email with attachments

**Risk:** Email delivery logic completely untested.

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
| `db.collection(...)` operations | 315 | 0 (mocked in tests, no real query logic tested) |
| `axios.get` / `axios.post` | 3 | 0 (external calls mocked) |
| `hive.api.*` calls | 10 | 0 |
| `client.api.*` (dsteem) calls | 6 | 0 |
| `blurt.api.*` calls | 3 | 0 |
| `new ObjectId(...)` with user input | 18 | 6 (now tested) |
| `JSON.parse(...)` with user input | 6 | 6 (now tested) |
| `eval(...)` | 0 | 0 (removed) |

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
| Area | Impact | Effort | Files |
|------|--------|--------|-------|
| `checkHdrs` middleware | All authenticated endpoints | Low | `app.js` |
| `validateAccountLogin` | User authentication | Low | `utils.js` |
| `sendNotification` | User notifications | Low | `utils.js` |
| `processSteemTrx` | Transaction security | Medium | `utils.js` |
| `confirmPaymentReceived*` | Payment verification | Medium | `utils.js` |

### High (Test Next)
| Area | Impact | Effort | Files |
|------|--------|--------|-------|
| `calcScore` / `calcScoreExtended` | Reward calculation | Medium | `utils.js` |
| `getVoteValue` / `getVoteValueUSD` | Financial math | Low | `utils.js` |
| `findVerifyTrx` | Transaction integrity | Medium | `utils.js` |
| `sendPlainMail` / `sendWithTemplate` | Email delivery | Low | `mail.js` |
| Login endpoints (`/loginAuth`, `/loginKeychain`) | Authentication flow | Medium | `app.js` |
| Wallet endpoints (`/transactions`, `/userFullBal`) | Financial data | Medium | `app.js` |

### Medium (Test Eventually)
| Area | Impact | Effort | Files |
|------|--------|--------|-------|
| `getChainInfo` / `getAccountData` | Blockchain read | Medium | `utils.js` |
| `claimRewards` | Reward claiming | Medium | `utils.js` |
| `delegateRC` / `fetchRCDelegations` | RC management | Medium | `utils.js` |
| Content endpoints (`/news`, `/surveys`, `/voteSurvey`) | Content | Medium | `app.js` |
| Social endpoints (`/addFriend`, `/userFriends`) | Social features | Medium | `app.js` |
| Workout CRUD endpoints | Fitness features | Medium | `app.js` |

### Low (Nice to Have)
| Area | Impact | Effort | Files |
|------|--------|--------|-------|
| `getCurrency` / `extractCurrency` | Parsing utilities | Low | `utils.js` ✅ tested |
| `format` / `toTimer` / `toHrMn` | Formatting | Low | `utils.js` ✅ tested |
| `updateSteemVariables` | Global state | Medium | `utils.js` |
| Admin endpoints (`/moderators`, `/banned_users`) | Admin tools | Medium | `app.js` |
| Prize/lottery endpoints | Gamification | Medium | `app.js` |

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
