# Invariants

This document lists the rules that Stelis code and contracts are expected to preserve.

The IDs are used in code comments, tests, and package README files. They are short labels for review and audit work; the code remains the current reference.

## Ownership

| ID | Rule | Enforced by |
| --- | --- | --- |
| O-1 | A `UserVault` is an owned Sui object. | Move |
| O-2 | Only the owner can withdraw from a `UserVault`. | Move |
| O-3 | Settlement surplus is credited to the user's vault balance, not transferred to another owner. | Move |
| O-4 | Settlement entry points do not change vault ownership. | Move |
| O-5 | Users can withdraw directly even when relay infrastructure is unavailable. | Move |

## Settlement

| ID | Rule | Enforced by |
| --- | --- | --- |
| S-2 | `execution_cost_claim_mist` must not exceed `max_claim_mist`. | Move and relay validation |
| S-3 | Token-funded swap settlement input must be at least `min_settle_mist`. Credit-only settlement is exempt from `min_settle_mist` and must satisfy exact sufficiency, fee cap, config version, and nonce checks. | Move |
| S-4 | Settlement input must cover execution cost claim, quoted host fee, and protocol fee. | Move |
| S-9 | Surplus is joined into vault balance; no extra surplus coin is created. | Move |
| S-10 | `receipt_id` is empty or 32 bytes. | Move |
| S-11 | `policy_hash` is empty or 32 bytes. | Move |
| S-14 | Prepare records are one-time use, and on-chain settlement uses a monotonic vault nonce. | Move and relay store |
| S-15 | Sponsored transactions must not reference `GasCoin` in user commands. | Relay validation |
| S-16 | The transaction policy hash must match the server-computed hash. | Relay validation |

## Vault Registry

| ID | Rule | Enforced by |
| --- | --- | --- |
| V-1 | Each user has one registered vault in `VaultRegistry`. | Move |
| V-2 | New-user settlement registers the user vault. | Move |
| V-3 | With-vault settlement validates the user's registered vault. | Move |

## Economics

| ID | Rule | Enforced by |
| --- | --- | --- |
| E-1 | `executionCostClaim >= simGas + gasVarianceFixedMist + slippageBufferMist`. | Relay validation |
| E-2 | Simulated gas must not exceed `max_claim_mist`. | Relay validation |
| E-4 | execution cost claim must not exceed `max_claim_mist`. | Move and relay validation |
| E-7 | `max_claim_mist` must be greater than zero. | Move |
| E-8 | `min_settle_mist` must be within the allowed range and no greater than `max_claim_mist`. | Move |
| E-9 | The sponsor approval gate must preserve the non-loss condition for successful transactions. | Relay validation |

## Pause

| ID | Rule | Enforced by |
| --- | --- | --- |
| P-1 | When paused, settlement entry points are blocked. | Move |
| P-2 | Withdrawals remain available while paused. | Move |
| P-3 | Internal credit use is available only through settlement paths. | Move |

## Admin Safety

| ID | Rule | Enforced by |
| --- | --- | --- |
| A-1 | Admin transfer proposals, admin transfers, and applied protocol state changes emit events. | Move |
| A-2 | Only admin can propose or cancel protocol treasury changes. A queued treasury change applies only at or after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`. | Move |
| A-3 | Only admin can propose or cancel protocol flat fee changes. Queued economic changes apply only at or after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`. | Move |
| A-4 | Only admin can propose or cancel host fee cap and spread cap changes. Queued economic changes apply only at or after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`. | Move |
| A-5 | Emergency pause to `true` is immediate and admin-only. Unpause is a delayed pending change. | Move |
| A-6 | Applying a matured pending config, treasury, or pause change is permissionless and can only execute exact queued values. `config_version` increments when the pending change is applied. | Move |

## Relay Policy

| ID | Rule | Enforced by |
| --- | --- | --- |
| R-1 | A final Host-built transaction must contain exactly one allowed settlement call. | Relay validation |
| R-2 | Sponsored transactions must not contain publish or upgrade commands. | Relay validation |
| R-3 | The settlement payout recipient address in settlement arguments must match Host configuration. | Relay validation |
| R-7 | Settlement swap path identity must be present in the Host's allowed settlement swap path list. | Relay validation |
| R-8 | Settlement swap path hop order must match the allowed settlement swap path exactly. | Relay validation |
| R-9 | Payment-token funding must combine coin object provenance with `FundsWithdrawal(Sender)` address-balance accounting. It must not double-count the same funds inside one transaction. | Relay validation |
| R-10 | Promotion-sponsored Move calls must match `STUDIO_ALLOWED_TARGETS`. | Promotion validation |
| R-11 | A user-supplied generic `User TransactionKind` must contain zero settlement calls. | Relay validation |
| R-12 | A user-supplied generic `User TransactionKind` must contain at most `MAX_COMMANDS = 16` commands. | Relay validation |
| R-13 | A user-supplied generic `User TransactionKind` must not reference `GasCoin` in command arguments. | Relay validation |
| R-14 | A user-supplied generic `User TransactionKind` must not include `FundsWithdrawal(Sponsor)`. | Relay validation |
| R-15 | A malformed same-token `FundsWithdrawal(Sender)` in a user-supplied generic `User TransactionKind` is rejected with `UNACCOUNTABLE_WITHDRAWAL`. | Relay validation |
| R-16 | A bounded same-token `FundsWithdrawal(Sender)` in a user-supplied generic `User TransactionKind` is allowed and subtracted from address-balance funding. | Relay validation |
| R-17 | Each supported `settlementTokenType` maps to one Host-configured SUI-adjacent DeepBook one-hop settlement swap path. | Relay configuration and validation |

## Code References

- Move modules: [`packages/contracts/move/sources`](../packages/contracts/move/sources)
- Relay validation: [`packages/core-relay/src/validate`](../packages/core-relay/src/validate)
- Prepare and sponsor flow: [`packages/core-api/src/session`](../packages/core-api/src/session)
