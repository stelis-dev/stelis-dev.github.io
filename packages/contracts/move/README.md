# Stelis Move Smart Contracts

Move smart contracts for sponsored Sui transaction settlement.

- Built for: maintainers, reviewers, and auditors inspecting or changing on-chain settlement behavior.
- Use for: on-chain modules, contract entry functions, and links into Move implementation details.
- Not for: Host operation runbooks, package integration guidance, or off-chain Host policy.

> Users can start with zero SUI. Host operators must not lose money on successful sponsored transactions. Protocol fees are collected during settlement.

> [!NOTE]
> Codes like `S-2`, `E-4` are invariant IDs defined in [invariants.md](../../../docs/invariants.md)

---

## Purpose

This package contains the on-chain settlement primitives for Stelis.
External developer companies and agents do not modify or republish this package in the normal product path.
They consume the deployed contracts through the SDK or the provided Host packages.
Contract changes and package publishing are maintainer-only workflows.

The current Stelis deployment is testnet-only. Testnet contract changes are
published as fresh packages and replace the current testnet IDs. Consumers use
only the current interface and IDs; this repository does not keep aliases or
compatibility readers for superseded testnet packages.

Use it when you need to inspect or modify:

- fee and pause behavior
- registered vault enforcement
- settlement entry points
- on-chain event schema

## When to Use

Open this package when:

- you are auditing the Move implementation
- you are changing settlement behavior or admin controls
- you need the authoritative on-chain function set

Prefer the docs first when you only need system-level context:

- formulas → `docs/economics-formal.md`
- operational values → `docs/parameters.md`
- architecture map → `docs/architecture.md`

---

## Module Structure

```
sources/
├── config.move     Config (Shared Object) — global settings + delayed admin updates
├── vault.move      UserVault (Owned Object) + VaultRegistry (Shared Object) — per-user credit vault + registered vault enforcement
├── settle.move     Settlement entry points — 1-hop swap_and_settle_* + settle_with_credit() + spread guard
└── events.move     All on-chain event definitions
```

---

## Core Concepts

### Settlement Entry Points

| Function                           | Target                                      | Description                                                                            |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `swap_and_settle_new_user_bfq()`   | **New users** (no Vault), 1-hop bfq         | DeepBook 1-hop base-for-quote swap → create vault → settle → transfer vault to sender  |
| `swap_and_settle_with_vault_bfq()` | **Existing users** (has Vault), 1-hop bfq   | DeepBook 1-hop base-for-quote swap → optionally use credit → settle → surplus to vault |
| `swap_and_settle_new_user_qfb()`   | **New users** (no Vault), 1-hop qfb         | DeepBook 1-hop quote-for-base swap → create vault → settle → transfer vault to sender  |
| `swap_and_settle_with_vault_qfb()` | **Existing users** (has Vault), 1-hop qfb   | DeepBook 1-hop quote-for-base swap → optionally use credit → settle → surplus to vault |
| `settle_with_credit()`             | **Existing users** (has Vault), credit-only | No swap. Uses vault credit only, then settles                                          |

All `swap_and_settle_*` variants atomically swap a settlement token (e.g. DEEP) to SUI via DeepBook, then run settlement in a single transaction.
Before each swap, the on-chain spread guard rejects the transaction (abort 110: `ESpreadTooWide`) when the DeepBook order book is empty, one-sided, crossed, or has bid/ask spread exceeding `max_spread_bps`.
`settle_with_credit()` skips the swap and settles using vault credit only.
`settle_with_credit()` is credit-only settlement, so it does not enforce `min_settle_mist`; it still checks exact sufficiency, fee cap, config version, and nonce.
Leftover payment coin is returned to the sender automatically in swap variants. No separate DEEP coin is returned from settlement. See [`docs/architecture/onchain-settlement.md → DeepBook Fee Model`](../../../docs/architecture/onchain-settlement.md#deepbook-fee-model).

### Owned Object Protection

`UserVault` is a Sui **Owned Object** with `key` ability only (soulbound) — it cannot be transferred externally to another address.
Only the owner can include it in transactions. No third party, including the Host operator, can access it. Even during Host downtime, users can call `withdraw()` directly.

---

## Product Interface Functions

This table lists the current product operations. It is not an exhaustive dump
of public bytecode helpers, read-only accessors, or testing-only functions.

### `public` — Host-Built Settlement, Owner, and Administration Operations

| Function                         | Module   | Signature                                                                                                                                                                                                                                                                                             | Description                                                                                                                   |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `swap_and_settle_new_user_bfq`   | `settle` | `(config, registry, clock, pool, payment_coin, swap_amount, min_sui_out, ...)`                                                                                                                                                                                                                        | New user: 1-hop bfq swap → create vault → settle                                                                              |
| `swap_and_settle_with_vault_bfq` | `settle` | `(config, registry, clock, vault, pool, payment_coin, swap_amount, min_sui_out, ..., use_credit_amount, ctx)`                                                                                                                                                                                         | Existing user: 1-hop bfq swap → use credit → settle                                                                           |
| `swap_and_settle_new_user_qfb`   | `settle` | `(config, registry, clock, pool, payment_coin, swap_amount, min_sui_out, ...)`                                                                                                                                                                                                                        | New user: 1-hop qfb swap → create vault → settle                                                                              |
| `swap_and_settle_with_vault_qfb` | `settle` | `(config, registry, clock, vault, pool, payment_coin, swap_amount, min_sui_out, ..., use_credit_amount, ctx)`                                                                                                                                                                                         | Existing user: 1-hop qfb swap → use credit → settle                                                                           |
| `settle_with_credit`             | `settle` | `(config, registry, clock, vault, use_credit_amount, execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce, sim_gas, gas_variance_fixed_mist, slippage_buffer_mist, quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version, quote_timestamp_ms, policy_hash, order_id_hash, ctx)` | Existing user: vault credit only, no swap                                                                                     |
| `withdraw`                       | `vault`  | `(vault, ctx)`                                                                                                                                                                                                                                                                                        | Withdraw entire vault balance                                                                                                 |
| `balance`                        | `vault`  | `(vault): u64`                                                                                                                                                                                                                                                                                        | Query vault credit balance                                                                                                    |
| `set_paused`                     | `config` | `(config, paused, ctx)`                                                                                                                                                                                                                                                                               | Emergency pause to `true` immediately; queue unpause when `paused=false` (admin only)                                         |
| `apply_paused_update`            | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Apply a matured pending pause update (permissionless)                                                                         |
| `cancel_paused_update`           | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Cancel a pending pause update (admin only)                                                                                    |
| `update_config`                  | `config` | `(config, max_host_fee_mist, protocol_flat_fee_mist, max_claim, min_settle, max_spread_bps, ctx)`                                                                                                                                                                                                  | Queue settings update including spread cap (admin only)                                                                       |
| `apply_config_update`            | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Apply a matured pending config update (permissionless)                                                                        |
| `cancel_config_update`           | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Cancel a pending config update (admin only)                                                                                   |
| `propose_admin`                  | `config` | `(config, new_admin, ctx)`                                                                                                                                                                                                                                                                            | Propose new admin (admin only). Aborts if a pending proposal already exists; call `cancel_admin_proposal` first                |
| `cancel_admin_proposal`          | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Cancel pending admin proposal (admin only)                                                                                    |
| `accept_admin`                   | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Accept admin role (pending admin only)                                                                                        |
| `update_protocol_treasury`       | `config` | `(config, new_treasury, ctx)`                                                                                                                                                                                                                                                                         | Queue fee recipient change (admin only)                                                                                       |
| `apply_protocol_treasury_update` | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                       | Apply a matured pending treasury update (permissionless)                                                                      |
| `cancel_protocol_treasury_update` | `config` | `(config, ctx)`                                                                                                                                                                                                                                                                                      | Cancel a pending treasury update (admin only)                                                                                 |

> **Withdrawal policy**: `vault::withdraw_amount()` exists on-chain as an owner-only helper, but it is intentionally not part of the sponsored execution allowlist or SDK API.
> Supported sponsored PTBs only expose full withdrawal through `withdraw()`.

### Selected `public(package)` Settlement Internals

| Function                  | Module   | Description                                                                                                                        |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `settle_core`             | `settle` | Vault-independent distribution core: validations, fee splits, event, returns surplus `Coin<SUI>`                                   |
| `create_vault`            | `vault`  | Creates new UserVault (called by all `swap_and_settle_new_user_*` variants)                                                        |
| `use_credit`              | `vault`  | Withdraws `Coin<SUI>` from vault (called by all `swap_and_settle_with_vault_*` variants / `settle_with_credit()`)                  |
| `join_surplus`            | `vault`  | Deposits `Balance<SUI>` to vault (called by settle internally)                                                                     |
| `check_and_advance_nonce` | `vault`  | S-14: Monotonic nonce replay prevention (called by settle internally)                                                              |
| `create_registry`         | `vault`  | V-1: Creates VaultRegistry (called by `config::init()`)                                                                            |
| `register_vault`          | `vault`  | V-2: Registers a vault for a user (called by all `swap_and_settle_new_user_*` variants)                                            |
| `validate_vault`          | `vault`  | V-3: Validates vault matches the registered vault (called by all `swap_and_settle_with_vault_*` variants / `settle_with_credit()`) |
| `transfer_vault`          | `vault`  | Transfers soulbound vault to owner (called by all `swap_and_settle_new_user_*` variants)                                           |

> **Security implication**: Vault helpers (`create_vault`, `use_credit`, `join_surplus`) can only be called from the `settle` module.
> Any attempt to call them from external packages or PTBs results in a compile error or runtime rejection.

---

## Package Constants

| Constant          | Value source                         | Unit | Invariant Ref   |
| ----------------- | ------------------------------------ | ---- | --------------- |
| `MAX_CLAIM_MIST`  | `docs/parameters.md` package constants | MIST | S-2, E-4        |
| `MIN_SETTLE_MIST` | `docs/parameters.md` package constants | MIST | dust prevention |
| `ADMIN_UPDATE_DELAY_EPOCHS` | `docs/parameters.md` package constants | epochs | delayed admin updates |

`Config.max_claim_mist` initializes from `INITIAL_MAX_CLAIM_MIST` at package init and remains admin-adjustable up to `MAX_CLAIM_MIST` through delayed config updates.

---

## Settlement Math

The core math inside `settle_core()` (called by all settlement paths via `settle_internal()`):

```
total_in = sui_received_from_swap [+ use_credit_amount]
enforce_min_settle_mist = true for swap settlement paths
enforce_min_settle_mist = false for settle_with_credit

quoted_host_fee = quoted_host_fee_mist     // Host quoted fee, capped by max_host_fee_mist
protocol_fee       = config.protocol_flat_fee_mist
payout             = execution_cost_claim_mist + quoted_host_fee

assert!(config.config_version == expected_config_version) // drift detection
assert!(config.protocol_flat_fee_mist == expected_protocol_fee_mist) // exact match
assert!(quoted_host_fee_mist <= config.max_host_fee_mist)       // fee cap
assert!(execution_cost_claim_mist <= max_claim_mist)         // S-2
if enforce_min_settle_mist:
  assert!(total_in >= min_settle_mist)           // S-3
assert!(total_in >= total_deduction)             // S-4
assert!(nonce > vault.last_nonce)                // S-14: on-chain monotonic nonce replay prevention
surplus = total_in − payout − protocol_fee       // S-9: deposited to vault
```

> `max_host_fee_mist` caps the Host's quoted fee per TX and is mutable by admin only (A-4).
> `Config` is read only during settlement as `&Config`.

---

## Admin Update Flow

Admin updates use a queue and apply flow.

- `set_paused(config, true, ctx)` applies emergency pause immediately and is admin-only.
- `set_paused(config, false, ctx)` queues unpause. The queued unpause can be applied at or after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`.
- `update_config(...)` queues economic config changes. `apply_config_update(...)` applies the matured values.
- `update_protocol_treasury(...)` queues the treasury change. `apply_protocol_treasury_update(...)` applies the matured value.
- Admin can cancel pending config, treasury, and pause updates before they are applied.
- Matured queued protocol updates are permissionless to apply and can only execute the exact queued values.
- `ADMIN_UPDATE_DELAY_EPOCHS` is `2`.
- `config_version` increments when protocol state changes through an applied update, when emergency pause changes the pause state, or when emergency pause cancels a pending unpause.

---

## Events

Applied state changes and admin transfer flows emit events for audit traceability.

| Event                         | Trigger                          | Key Fields                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettleEvent`                 | Settlement entry succeeded       | receipt_id, policy_hash, quote_timestamp_ms, exec_timestamp_ms, sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist, execution_cost_claim_mist, quoted_host_fee_mist, protocol_fee, protocol_treasury, payout, total_in, surplus_credited, config_version, user, settlement_payout_recipient, order_id_hash |
| `CreditUsedEvent`             | Credit used from vault           | user, amount, remaining                                                                                                                                                                                                                                                                              |
| `WithdrawEvent`               | Vault withdrawal                 | user, amount                                                                                                                                                                                                                                                                                         |
| `ConfigUpdatedEvent`          | Matured settings update applied  | old/new value pairs (including max_spread_bps), by, epoch                                                                                                                                                                                                                                            |
| `TreasuryUpdatedEvent`        | Matured treasury update applied  | old/new treasury, by, epoch                                                                                                                                                                                                                                                                          |
| `PausedEvent`                 | Emergency pause or matured pause update applied | is_paused, by, epoch                                                                                                                                                                                                                                                                    |
| `AdminProposedEvent`          | Admin transfer proposed          | current_admin, proposed_admin, epoch                                                                                                                                                                                                                                                                 |
| `AdminProposalCancelledEvent` | Pending admin transfer cancelled | admin, cancelled_proposed, epoch                                                                                                                                                                                                                                                                     |
| `AdminTransferredEvent`       | Admin transferred                | old/new admin, by, epoch                                                                                                                                                                                                                                                                             |

`SettleEvent` records the successful on-chain settlement entry point and its emitted values. Off-chain application fulfillment should compare the event with expected `receiptId`, `user`, `orderIdHash`, and amount values before treating it as payment completion.

---

## Pause Behavior

| Function                         | paused=true             | paused=false |
| -------------------------------- | ----------------------- | ------------ |
| All `swap_and_settle_*` variants | ❌ Rejected (P-1)       | ✅           |
| `settle_with_credit()`           | ❌ Rejected (P-1)       | ✅           |
| `withdraw()`                     | ✅ Always allowed (P-2) | ✅           |
| Admin functions                  | ✅ Always allowed       | ✅           |

> **P-2**: User funds must always be withdrawable, even when the protocol is paused.

---

## Build & Test

```bash
# Requires Sui CLI (https://docs.sui.io/guides/developer/getting-started/sui-install)

# Build
sui move build --path packages/contracts/move

# Test
sui move test --path packages/contracts/move

# Run specific tests (positional filter)
sui move test --path packages/contracts/move settle
```

---

## Directory Structure

```
packages/contracts/move/
├── Move.toml                Package manifest (edition 2024)
├── sources/
│   ├── config.move          Config + delayed admin updates + VaultRegistry init
│   ├── events.move          9 event definitions
│   ├── settle.move          Settlement logic — 1-hop swap_and_settle_* + settle_with_credit()
│   └── vault.move           UserVault CRUD + monotonic nonce replay prevention + VaultRegistry
├── tests/
│   └── settle_tests.move    Settlement unit tests
└── README.md                This file
```

---

## Invariant Reference

Full invariant list: [invariants.md](../../../docs/invariants.md)

That document owns the current category membership and entries. This README
does not mirror category counts because a second count would drift without
adding implementation authority.

## When Not to Start Here

This package is not the best first read if you only need:

- Relay API contract → see `docs/api.md`
- transaction validation flow → see `packages/core-relay/README.md`
- architecture overview → see `docs/architecture.md`
