# ANDX Web3 Assessment — Campaign Escrow & Payout Rail

Production-oriented submission: solvent `AndxEscrow`, Foundry invariants, reorg/crash-safe indexer, exactly-once claim relayer, and a security review of `LegacyPayouts`.

## Quick start (clean checkout)

```bash
git clone https://github.com/strangerhash/ANDX-Assessment.git
cd ANDX-Assessment
git submodule update --init --recursive

# Prerequisites: Docker, Node 20+, Foundry (forge/cast/anvil on PATH)
cd app && npm install && cd ..

make up
make deploy
make seed
make publish
make claim-all
make test
make down
```

Host ports: anvil `8545`, chaos-primary `9545`, chaos-replica `9546`, Postgres `5432`.

After `claim-all`, expected escrow balances: **USDX = 0**, **FOTX = 15_000_000**, **NRT = 0**.

## Architecture

See [docs/HLD.md](docs/HLD.md) and [docs/LLD.md](docs/LLD.md). Decision records in [docs/adr/](docs/adr/).

```
brands / operator / guardian / creators / relayer
                    ↓
              AndxEscrow ← anvil :8545
                    ↑
         chaos :9545 / :9546  →  app (indexer + relayer) → Postgres
```

The `app` service is a single long-running process (SIGKILL-tested). Deploy/seed/publish talk to anvil directly; the app uses only `RPC_URLS`.

## Operator rotation (4.5)

**Pending roots survive** `applyOperator` / `revokeOperator`. Only the operator address changes. After revoke, `operator = address(0)` (no new proposals); anyone may still `activateRoot` after delay; guardian may still `vetoRoot`. See [docs/adr/0001-pending-root-on-operator-change.md](docs/adr/0001-pending-root-on-operator-change.md).

## Invariants

Configured in [`contracts/foundry.toml`](contracts/foundry.toml): `runs = 256`, `depth = 100`, `show_metrics = true`.

Handlers: `createCampaign` (USDX/FOTX/NRT), honest + adversarial `proposeRoot`, `activate`, `veto`, direct claim, `claimWithSig` + replay, `refund`, `warpTime`.

| Id | Check |
|---|---|
| I1 | Per-token solvency |
| I2 | claimed ≤ active ≤ net−refunded; pending ≤ net−refunded |
| I3 | No double-pay vs max activated cumulative |
| I4 | Isolation / per-campaign independence |
| exactGhost | Exact-equality ghost accounting vs contract |
| I5 | Refunds never strand active/pending commitments |
| I6 | Nonce single-use (replay must not succeed) |

### Latest metrics (local run)

```
EscrowInvariants invariants (runs: 256, calls: 25600, reverts: 0)

Handler | Calls
--------|------
activate           | 2913
claimDirect        | 2786
claimWithSigReplay | 2777
createCampaign     | 2839
proposeAdversarial | 2919
proposeHonest      | 2893
refund             | 2850
veto               | 2768
warpTime           | 2855
```

All listed selectors are exercised every run (claims / activations / refunds / adversarial proposes included).

### Mutation demo

Temporarily comment out both `ClaimedExceedsCommitted` checks in `AndxEscrow` claim paths, then:

```bash
cd contracts && forge test --match-test test_claimedTotalCannotExceedActiveCommitted -vv
```

Observed failure (then restore the checks before submitting):

```
[FAIL: next call did not revert as expected] test_claimedTotalCannotExceedActiveCommitted()
Suite result: FAILED. 0 passed; 1 failed
```

With the mutation present, the suite no longer enforces the commitment ceiling — proving the test is not vacuously green. **Restore the reverts before shipping.**

## Assumptions

- Anvil default mnemonic; accounts per Appendix A.
- Kit files under `contracts/src/interfaces|tokens|audit`, `chaos/`, `fixtures/` are unmodified.
- `pendingCommitted` view equals pending proposal commitment if listed, else `activeCommitted`.
- Relayer uses acct4; jobs are `done` only on receipt `status = 1`.
- Deep reorgs beyond `CONFIRMATIONS = 6` are out of scope (per brief).
- Foundry libs are git submodules under `lib/` (`forge-std`, `openzeppelin-contracts`).

## Known limitations / more time

- Indexer campaign aggregation is event-sourced; would add property tests vs `eth_call` at finalized block in CI.
- Relayer fee-bump could use EIP-1559 tips explicitly; currently legacy `gasPrice` on anvil.
- Broader multi-leaf Merkle trees in invariant claim handlers beyond single-leaf honest claims.
- Formal verification of commitment monotonicity.

## Remediation branch notes (`fix/assessment-remediation`)

Follow-up to review findings (not yet merged to score baseline):
- Accounts derived from Anvil mnemonic; Appendix A preflight; Dave = index 10.
- Relayer persists signed `raw_tx` / nonce / hash **before** broadcast.
- `fetchRange` rejects stale header/log snapshots (head retreat after headers).
- DESIGN loss bound includes entitlement **reassignment** (`A − Q`) + `Δ`; two-chain allocator reserves pending.

## Deliverables

| Doc | Purpose |
|---|---|
| [AUDIT.md](AUDIT.md) | LegacyPayouts review + PoCs |
| [DESIGN.md](DESIGN.md) | Operator leak + dual-chain budget |
| [AI_USAGE.md](AI_USAGE.md) | AI tooling disclosure |
| [docs/](docs/) | HLD, LLD, ADRs |

## Layout

Matches assessment §3.2: `contracts/`, `app/`, `fixtures/`, `chaos/`, `docker-compose.yml`, `Makefile`, `deployments.json`.
