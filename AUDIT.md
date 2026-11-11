# Security Review — LegacyPayouts.sol

Scope: `contracts/src/audit/LegacyPayouts.sol` as if deployed behind an ERC1967 UUPS proxy with arbitrary ERC-20 brand tokens. Findings ordered by severity. PoCs for High/Critical live in `contracts/test/audit/LegacyPayouts.t.sol`.

---

## Critical

### C-01 — Missing initializer protection on UUPS implementation

**Severity:** Critical — uninitialized implementation / re-initialization can seize upgrade authority.  
**Lines:** `initialize` (54–63), `_authorizeUpgrade` (83).  
**Scenario:** `initialize` has no `initializer` / `reinitializer` modifier and does not disable initializers in the implementation constructor. An attacker calls `initialize` on the naked implementation **or re-initializes the live proxy**, sets themselves as `owner`, upgrades to a drain implementation, and empties proxy-held funds.  
**Fix:** Use OpenZeppelin `Initializable`, call `_disableInitializers()` in the implementation constructor, and mark `initialize` with `initializer`.  
**PoC:** `test_C01_uninitializedImplementation_takeover`, `test_C01_proxyReinitialize_takeoverFunds`

### C-02 — Revoked zero-operator + `ecrecover(address(0))` voucher drain

**Severity:** Critical — after `revokeOperator`, `operator == address(0)`. `_recover` can return `address(0)` for a malformed 65-byte signature; `require(recovered == operator)` then passes. Attacker redeems arbitrary vouchers and drains uncommitted budget.  
**Lines:** `revokeOperator` 72–75; `redeemVoucher` 177–198; `_recover` 207–218.  
**Fix:** Reject `operator == address(0)` in `redeemVoucher`; reject `ecrecover == address(0)`; prefer digest-keyed vouchers + low-s.  
**PoC:** `test_E3_zeroOperator_malformedSigVoucherDrain`

---

## High

### H-01 — `proposeRoot` commits immediately; `vetoRoot` does not roll back commitment

**Severity:** High — guardian veto fails to restore budget; refunds and solvency break.  
**Lines:** `proposeRoot` 123–133; `vetoRoot` 144–151; `refund` 110–119.  
**Scenario:** Operator proposes `newCommitted = budget`. Commitment is written immediately. Guardian vetoes the pending root (clears `pendingRoot` only). `committed` stays inflated, so `refund` computes `budget - (committed - claimed) = 0` and creators cannot be paid against a never-activated root while brand funds are stranded. Combined with a malicious operator this is a permanent grief / lock.  
**Fix:** Keep proposed commitment in pending storage; apply to `committed` only on `activateRoot`; restore on veto.  
**PoC:** `test_H01_vetoLeavesInflatedCommitment`

### H-02 — Claim accounting stores net-after-fee against gross Merkle cumulative

**Severity:** High — repeated claims drain escrow beyond intended cumulative.  
**Lines:** `claim` 154–166; `_chargeFee` 201–205.  
**Scenario:** Leaf encodes gross `cumulativeAmount`. Payout = `cumulative - claimed[id][user]`. After fee, code does `claimed += amount` (net). The fee gap remains claimable: second `claim` with the same leaf pays the fee remainder (and accrues more fees).  
**Fix:** Always advance `claimed[id][user]` by the **gross** payout (`cumulativeAmount`), not the net transfer.  
**PoC:** `test_H02_claimFeeAccountingDoublePay`

### H-03 — `migrateCreator` zeroes source claim allowing full re-claim

**Severity:** High — double payout for the same earnings.  
**Lines:** `migrateCreator` 169–174.  
**Scenario:** After claiming, creator migrates to a new address (moves claim record). Source `claimed` is set to 0, so the same Merkle leaf can be claimed again from the original address.  
**Fix:** Make migration owner/operator-gated with signature proofs, or burn the old identity permanently (e.g. map creator → alias without clearing earned entitlement on the leaf identity).  
**PoC:** `test_H03_migrateCreatorDoubleClaim`

### H-04 — `topUp` credits `amount` instead of tokens received

**Severity:** High — fee-on-transfer tokens inflate `budget` beyond balance.  
**Lines:** `topUp` 102–108 (contrast `fund` 86–99 which uses balance delta).  
**Scenario:** Brand tops up with FOTX. Escrow receives `amount - 1%` but `budget += amount`. Later commitments/refunds assume solvency that does not exist.  
**Fix:** Use the same balance-delta accounting as `fund`.  
**PoC:** `test_H04_topUpIgnoresFeeOnTransfer`

### H-05 — Voucher replay via ECDSA signature malleability

**Severity:** High — same logical voucher redeemable twice.  
**Lines:** `redeemVoucher` 177–198; `_recover` 207–218.  
**Scenario:** `usedVouchers` is keyed by `keccak256(signature)`, not by the voucher digest / nonce. Secp256k1 allows `(r,s,v)` and `(r,n-s,v')` to recover the same signer. Attacker malleates after first redeem and drains again. No low-s check.  
**Fix:** Mark `usedVouchers[digest]` (or `(creator,nonce)`), reject high-s signatures.  
**PoC:** `test_H05_voucherSignatureMalleability`

---

## Medium

### M-01 — Unchecked `transferFrom` in `topUp`

**Severity:** High (economic) / Medium (report class) — tokens that return `false` leave `budget` increased with no tokens pulled, inventing liabilities against shared escrow balances.  
**Lines:** 106.  
**Scenario:** After a successful `fund`, `topUp` with a false-returning token credits `budget += amount` while the balance is unchanged.  
**Fix:** `SafeERC20.safeTransferFrom`; credit balance delta only.  
**PoC:** `test_M01_topUpFalseReturn_inflatesBudget`

### H-06 — Claim does not reduce `budget`; refund steals cross-campaign liquidity

**Severity:** High — `claim` moves tokens but leaves `budget` unchanged. `refund` uses `budget - (committed - claimedTotal)`, so after large claims the brand can refund nearly the full budget and consume other campaigns' deposits in the shared token pool.  
**Lines:** `claim` 154–166; `refund` 110–119.  
**Fix:** Decrease `budget` (or track `netDeposited`/`spent`) on payouts; isolate per-campaign balances.  
**PoC:** `test_S1_crossCampaignRefundTheft`

### H-07 — No aggregate claim vs commitment ceiling

**Severity:** High — `claim` never checks `claimedTotal + payout <= committed`, so a malicious root with oversized leaves drains shared liquidity beyond the campaign's commitment.  
**Lines:** `claim` 154–166.  
**Fix:** Enforce `claimedTotal + payout <= committed` (AndxEscrow `ClaimedExceedsCommitted`).  
**PoC:** `test_F2_claimAboveCommitment_drainsSharedLiquidity`

### H-08 — `fund` reentrancy doubles budget via balance-delta

**Severity:** High — a malicious ERC-20 reenters `fund` inside `transferFrom`. The outer `received = balanceAfter - before` includes the inner deposit, so the outer campaign's `budget` is inflated beyond tokens attributable to that call.  
**Lines:** `fund` 86–99.  
**Fix:** ReentrancyGuard; CEI; or non-reentrant token assumptions + checks.  
**PoC:** `test_F1_fundReentrancy_doubleCredit`

### M-02 — Refund formula ignores pending commitment semantics / can underflow conceptually

**Severity:** Medium — `budget - (committed - claimedTotal)` with pending-committed-already-applied (H-01) strands funds; also unsafe with fee-on-transfer shortfalls.  
**Lines:** 115–117.  
**Fix:** Track `netDeposited`, `refunded`, and reserved = max(active, pending) explicitly.

### M-03 — Operator can be set instantly with no delay / no event discipline

**Severity:** Medium — compromised owner rotates operator without timelock; limited monitoring surface.  
**Lines:** `setOperator` 66–69.  
**Fix:** Timelocked rotation with events (as in AndxEscrow).

### M-04 — `redeemVoucher` reduces `budget` while bypassing Merkle commitment controls

**Severity:** Medium — operator-signed vouchers spend brand budget outside root delay / veto path.  
**Lines:** 177–198.  
**Scenario:** Compromised operator drains residual uncommitted budget via vouchers immediately.  
**Fix:** Cap vouchers, delay them, or remove in favor of Merkle-only payouts.

---

## Low / Informational

### L-01 — `ecrecover` without low-s / address(0) checks on vouchers

Covered under H-05 for malleability; also reject `address(0)`.

### L-02 — No reentrancy guard on token transfers

HOOK-like tokens can reenter `claim` / `redeemVoucher` before state settles (CEI partially present but events after external calls). Prefer checks-effects-interactions + `ReentrancyGuard`.

### I-01 — `feeBps` mutable only at init — OK

Not an issue by itself.

### I-02 — Patterns that look scary but are not (alone) exploitable

- Using `abi.encodePacked` for Merkle leaves is brittle with dynamic types but here types are fixed-width — not a collision bug by itself.
- Anyone can call `activateRoot` after delay — intentional.

---

## Combined attacks

**H-01 + M-04:** Operator proposes max commitment (locks refunds even if vetoed) and drains remaining perceived budget via vouchers before veto.  
**H-02 + H-03:** Fee-gap re-claim plus migration multiplies payouts per leaf.  
**C-01 + owner powers:** Proxy re-init → upgrade → drain held funds.  
**C-02:** Guardian/owner revoke operator “for safety” then anyone drains via zero-signer vouchers.  
**H-06 + H-07:** Overclaim one campaign and/or refund after claims to empty shared pool used by other brands.
