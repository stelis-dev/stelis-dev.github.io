# Sponsor Pools

The Host uses sponsor keys to pay gas for sponsored transactions.

## Current Model

`SPONSOR_SECRET_KEY` can contain one or more sponsor keys. The Host uses a Redis-backed sponsor pool to lease a sponsor slot during prepare and sign during sponsor.

`SPONSOR_REFILL_ACCOUNT_SECRET_KEY` is separate from sponsor keys. It is used for operational refill flows when refill is enabled.

## Sponsor SUI State

Stelis uses these names for sponsor-related SUI state:

- `Sponsor Refill Account`: the dedicated key from `SPONSOR_REFILL_ACCOUNT_SECRET_KEY`. It funds sponsor slots and signs refill and admin withdrawal transactions.
- `Sponsor slot`: one sponsor key from `SPONSOR_SECRET_KEY`. A sponsor slot is leased during prepare and signs the sponsored transaction during sponsor.
- `settlement payout recipient`: the settlement payout address from `SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS`. It receives `executionCostClaim + quotedHostFeeMist` from on-chain settlement.
- `SUI coin object`: an owned `Coin<SUI>` object.
- `Address balance`: the Sui account balance that can be used by Sui address-balance gas payment or `FundsWithdrawal`.
- `GasCoin`: the PTB argument that refers to the transaction gas payment during execution.
- `FundsWithdrawal`: a PTB input that withdraws a token amount from an address balance.

The Sponsor Refill Account can receive SUI from external deposits. It also receives settlement payout when `SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS` equals the Sponsor Refill Account address. Stelis does not control whether external SUI arrives as SUI coin objects or address balance, and it does not keep a coin-object inventory for the Sponsor Refill Account.

Stelis observes the Sponsor Refill Account through total SUI balance reads for health, refill runway, and admin display. It uses this account for sponsor slot refill and admin withdrawal.

Sponsor slot SUI is gas inventory for sponsored transactions. Stelis sets the sponsor slot as `gasOwner` and sets the gas budget. Stelis does not keep a sponsor-slot gas coin inventory, track sponsor-slot gas coin count, run a merge worker, or select sponsor-slot gas coin objects directly in production.

The Host's server-only gas builder resolves sponsor-slot transactions through a boot-qualified Sui RPC endpoint. Before resolution it sets the sponsor slot as gas owner and sets the exact gas budget and that endpoint's reference gas price, while leaving gas payment and expiration unset. It accepts the returned transaction only when the gas payment list is empty and the endpoint returned the expected address-balance `ValidDuring` expiration. If the resolver selects any SUI coin object, prepare fails before signing. The sponsor slot address balance must therefore cover the exact gas budget.

Sponsor slot SUI is only for sponsored transaction gas. It is not used for user settlement-token funding, settlement swap payment funding, or host fee settlement. User-supplied transactions cannot use sponsor SUI through `GasCoin` or `FundsWithdrawal(Sponsor)`.

## SUI Transitions

Settlement transfers `executionCostClaim + quotedHostFeeMist` to the settlement payout recipient. Protocol fees are paid to the protocol treasury, not to the settlement payout recipient. Final settlement validation rejects a `settlement_payout_recipient` that does not match the configured settlement payout recipient.

If the settlement payout recipient is the Sponsor Refill Account, a successful settlement payout becomes SUI held by the Sponsor Refill Account and can fund later sponsor slot refill. If the settlement payout recipient is a separate address, settlement payout does not enter SponsorOperations refill state.

External SUI deposits into the Sponsor Refill Account are outside Stelis transaction construction. Stelis does not add receive logic for those deposits.

Sponsor slot refill moves SUI from the Sponsor Refill Account to a sponsor slot. SponsorOperations computes `max(0, sponsorBalanceRefillTargetMist - currentSponsorSlotAddressBalanceMist)`, splits that amount from `tx.gas`, and passes the split coin to `0x2::coin::send_funds<SUI>`. That call credits the sponsor address balance instead of leaving a new `Coin<SUI>` object at the sponsor address.

Sponsored execution uses the leased sponsor slot as `gasOwner` and pays gas from that slot's address balance. The Host rejects resolved transaction bytes that contain a SUI coin-object gas payment before returning a prepare response.

Admin withdrawal uses the Sponsor Refill Account signer and transfers one exact positive u64 MIST amount. Admin withdrawal is protected by admin session validation, a network-bound signed single-use withdrawal nonce, admin-operation rate limiting, operation logging, simulation, and the same account-scoped spend flow used by refill. If that withdrawal's HTTP outcome is pending, app-admin retains its exact network, nonce, signature, and amount for the browser session and retries it instead of signing a new request. A request rejected because another account spend was recovered is not classified or retried as its own pending withdrawal.

Refill and withdrawal resolve the final transaction bytes and exact gas budget while holding the Sponsor Refill Account dispatch lock. The Host atomically records the operation, then stores the signed bytes, signature, gas budget, and digest in Redis before network submission. Signed submission uses the primary endpoint exactly once. Recovery and balance observations use the immutable boot-qualified endpoint snapshot in configured order and accept only results validated against the stored digest or requested account. Recovery queries that digest first and resubmits only the stored bytes when every attempted lookup reports it absent. The durable operation and sequence CAS, rather than lock TTL or endpoint affinity, prevent a late result from authoring a different transaction or overwriting newer state.

A transaction result closes a refill only after a validated effects lookup finds its stored digest. The following bounded slot observation classifies the mutable current balance as `healthy`, `low_balance`, or `rpc_unreachable`; target attainment is not a second proof of the already confirmed transfer. A low current balance can trigger a later refill, while digest identity and account serialization prevent it from being mistaken for recovery of the prior transaction.

Every spend uses a fresh Sponsor Refill Account balance and the gas budget encoded in the submitted transaction. The remaining balance must retain `Sponsor Refill Account runway target * sponsor slot count` after the transfer and gas budget. The configured refill target is the per-slot runway target when present; otherwise the current refill-target constant remains the withdrawal runway even when automatic refill is disabled.

## Health Gate

Prepare routes require at least one healthy sponsor address that is not currently leased. A sponsor route already has a receipt-bound lease, so it checks the fresh observation for that exact sponsor address immediately before the atomic transition into execution. Admin `/api/sponsor-operations` reports lease occupancy as `sponsorOperations.slotLeases`, including current leased and free sponsor address counts.

## Refill Settings

The Host supports these refill-related settings:

- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

The five `SPONSOR_OPERATIONS_*_MS` values are required at boot, including the
durable-spend reconciliation interval.

## Code References

- Sponsor operations: [`packages/app-api/src/sponsor-operations`](../../packages/app-api/src/sponsor-operations)
- Redis sponsor pool: [`packages/core-api/src/store/redisSponsorPool.ts`](../../packages/core-api/src/store/redisSponsorPool.ts)
