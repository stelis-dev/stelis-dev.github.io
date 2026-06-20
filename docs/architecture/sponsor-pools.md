# Sponsor Pools

The Host uses sponsor keys to pay gas for sponsored transactions.

## Current Model

`SPONSOR_SECRET_KEY` can contain one or more sponsor keys. The Host uses a Redis-backed sponsor pool to lease a sponsor slot during prepare and sign during sponsor.

`SPONSOR_REFILL_ACCOUNT_SECRET_KEY` is separate from sponsor keys. It is used for operational refill flows when refill is enabled.

## Sponsor SUI State

Stelis uses these names for sponsor-related SUI state:

- `Sponsor Refill Account`: the dedicated key from `SPONSOR_REFILL_ACCOUNT_SECRET_KEY`. It funds sponsor slots and signs refill and admin withdrawal transactions.
- `Sponsor slot`: one sponsor key from `SPONSOR_SECRET_KEY`. A sponsor slot is leased during prepare and signs the sponsored transaction during sponsor.
- `relayer recipient`: the settlement payout address from `RELAYER_RECIPIENT_ADDRESS`. It receives `relayerClaim + quotedRelayerFeeMist` from on-chain settlement.
- `SUI coin object`: an owned `Coin<SUI>` object.
- `Address balance`: the Sui account balance that can be used by Sui address-balance gas payment or `FundsWithdrawal`.
- `GasCoin`: the PTB argument that refers to the transaction gas payment during execution.
- `FundsWithdrawal`: a PTB input that withdraws a token amount from an address balance.

The Sponsor Refill Account can receive SUI from external deposits. It also receives settlement payout when `RELAYER_RECIPIENT_ADDRESS` equals the Sponsor Refill Account address. Stelis does not control whether external SUI arrives as SUI coin objects or address balance, and it does not keep a coin-object inventory for the Sponsor Refill Account.

Stelis observes the Sponsor Refill Account through total SUI balance reads for health, refill runway, and admin display. It uses this account for sponsor slot refill and admin withdrawal.

Sponsor slot SUI is gas inventory for sponsored transactions. Stelis sets the sponsor slot as `gasOwner` and sets the gas budget. Stelis does not keep a sponsor-slot gas coin inventory, track sponsor-slot gas coin count, run a merge worker, or select sponsor-slot gas coin objects directly in production.

Sui SDK transaction build resolves gas payment for sponsor-slot transactions. For sponsor-slot transactions that do not reference `GasCoin`, the current Sui SDK resolver uses address-balance gas payment when the sponsor slot address balance covers the gas budget. The resolver selects valid SUI coin objects when address balance alone does not cover the gas budget. Sui execution applies gas payment rules, including gas smashing when multiple gas coin objects are selected.

Sponsor slot SUI is only for sponsored transaction gas. It is not used for user settlement-token funding, settlement swap payment funding, or relayer fee settlement. User-supplied transactions cannot use sponsor SUI through `GasCoin` or `FundsWithdrawal(Sponsor)`.

## SUI Transitions

Settlement transfers `relayerClaim + quotedRelayerFeeMist` to the relayer recipient. Protocol fees are paid to the protocol treasury, not to the relayer recipient. Final settlement validation rejects a `relayer_recipient` that does not match the configured relayer recipient.

If the relayer recipient is the Sponsor Refill Account, a successful settlement payout becomes SUI held by the Sponsor Refill Account and can fund later sponsor slot refill. If the relayer recipient is a separate address, settlement payout does not enter SponsorOperations refill state.

External SUI deposits into the Sponsor Refill Account are outside Stelis transaction construction. Stelis does not add receive logic for those deposits.

Sponsor slot refill moves SUI from the Sponsor Refill Account to a sponsor slot. The refill worker computes `max(0, sponsorBalanceRefillTargetMist - currentSponsorSlotBalanceMist)`, splits that amount from `tx.gas`, and transfers the resulting SUI coin object to the sponsor slot.

Sponsored execution uses the leased sponsor slot as `gasOwner`. The Sui SDK resolves the gas payment during transaction build, and Sui execution deducts gas from the selected gas payment.

Admin withdrawal uses the Sponsor Refill Account signer. It transfers either the whole `tx.gas` value for max withdrawal or a split `tx.gas` coin for an exact amount. Admin withdrawal is protected by admin session validation, signed single-use withdrawal nonce, admin-operation rate limiting, operation logging, dry-run, and runway guard.

## Health Gate

Before prepare and sponsor routes continue, `@stelis/app-api` checks sponsor operation state. If no usable sponsor slot is available, the route can return a sponsor-operations `503` response.

Prepare routes require at least one healthy sponsor slot that is not currently leased. Sponsor routes use the health gate only, because they complete an existing leased prepare receipt. Admin `/api/pool` reports lease occupancy as `sponsorOperations.slotLeases`, including current leased and free sponsor slot counts.

## Refill Settings

The Host supports these refill-related settings:

- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

The four `SPONSOR_OPERATIONS_*_MS` timeout values are required at boot.

## Code References

- Sponsor operations: [`packages/app-api/src/sponsor-operations`](../../packages/app-api/src/sponsor-operations)
- Redis sponsor pool: [`packages/core-api/src/store/redisSponsorPool.ts`](../../packages/core-api/src/store/redisSponsorPool.ts)
