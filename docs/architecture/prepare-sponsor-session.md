# Stelis Architecture — Prepare and Sponsor Execution

> Current type ownership, receipt lifecycle, and transaction-byte authority for
> generic and Promotion-sponsored execution.
>
> - Parent document: [`../architecture.md`](../architecture.md)
> - Full sponsor checks: [`pricing-and-validation.md`](./pricing-and-validation.md#sponsor-approval-flow)
> - Security controls: [`security.md`](../security.md#web2-security-policy-api-and-infrastructure)

---

## 1. Ownership Boundaries

The prepare runner owns execution order and receipt identity. Policies own
route-specific validation and transaction construction. The receipt lifecycle
store owns every durable transition for one receipt.

```text
prepare request
  │
  ├─ route validation and transaction construction
  │
  ├─ runPrepareStateMachine()
  │    ├─ creates receiptId once
  │    ├─ acquires in-flight, sponsor-slot, nonce, and Promotion reservations
  │    ├─ obtains the final transaction bytes and SHA-256 hash once
  │    ├─ projects the client response before durable commit
  │    └─ commitPreparedReceipt(draft)
  │
  ▼
PreparedTxEntry (state: prepared)
  │
  ├─ read and validate the submitted receipt, bytes, and user signature
  ├─ route-specific policy checks and preflight
  ├─ beginSponsoredExecution(...)
  │
  ▼
ExecutingSponsoredExecutionRecord (state: executing)
  │
  ├─ sign and submit the same validated Uint8Array once
  ├─ finalizeSponsoredExecution(...), or leave executing for recovery
  │
  ▼
FinalSponsoredExecutionRecord (state: final)
  └─ deliver the Host callback and mark delivery
```

The current store contract is `SponsoredExecutionStoreAdapter` in
`store/sponsoredExecutionStore.ts`. Memory and Redis implementations consume
the same record encoders from `prepareTypes.ts` and
`sponsoredExecutionRecords.ts`. One store owns the complete receipt lifecycle.

### Prepared record

`PreparedTxEntry` is a coordination record. Common fields bind the receipt,
sender, sponsor address, client address, execution-path key, optional order ID,
and transaction hash. Generic entries additionally carry the reserved on-chain
nonce. Promotion entries carry `promotionId`, `userId`, and
`reservedGasMist`. The store adds `issuedAt` from its own clock when it commits
the draft.

Generic settlement amounts, fees, profile, policy hash, and quote time are not
copied into the prepared record. Sponsor checks parse those values from the
hash-matched transaction bytes. Keeping a second stored copy would create a
second authority that could drift from the transaction the user signed.

### Executing record

Immediately before the sponsor signature, the store replaces the prepared
record with one executing record. It contains the receipt and sponsor identity,
the prepared transaction hash, the Sui transaction digest derived from those
bytes, a bounded lookup deadline, and the route-specific fields required to
recover accounting. It never stores either signature and recovery never
submits the transaction again.

### Final record

The final record stores one current result and whether the Host callback still
needs delivery. An exact replay is idempotent. A different result for the same
receipt is a state conflict.

---

## 2. Durable Lifecycle

```text
              validation failure or expiry
             ┌───────────────────────────────┐
             │                               ▼
prepared ────┴── beginSponsoredExecution ── executing ── finalize ── final
   │                    (atomic)                  │          (atomic)     │
   └──── discardPreparedReceipt ─────────────────┘                       │
                    (atomic)                                             │
                                                                         ▼
                                                         callback pending → delivered
```

The store performs these receipt transitions:

| Transition | Store operation | Required effects |
| --- | --- | --- |
| reservations → `prepared` | `commitPreparedReceipt` | commit the prepared record, sponsor lease proof, deadline, and indexes |
| `prepared` → `executing` | `beginSponsoredExecution` | compare the exact prepared record and hash; advance the sponsor lease and Promotion reservation; write the digest and lookup deadline |
| `prepared` → `final` | `discardPreparedReceipt` | release the sponsor lease and Promotion reservation, remove prepared indexes, and store the failure result |
| `executing` → `final` | `finalizeSponsoredExecution` | finalize Promotion accounting when applicable, release the sponsor lease, remove the execution deadline, and store the result |
| callback pending → delivered | `markCallbackDelivered` | compare the exact final record and mark delivery |

Redis performs each row as one Lua mutation over the current serialized
records. The memory implementation applies the same transition plans and
record encoders. Callers cannot reproduce part of a transition by mutating the
sponsor pool, Promotion ledger, and receipt records separately.

Prepare-time reservations release in reverse acquisition order if the durable
commit fails. After a successful commit, ownership of the sponsor slot, generic
nonce, and Promotion reservation moves to the durable receipt. The in-process
prepare admission handle always releases because it is only a concurrency
limit, not durable receipt state.

### Recovery

`SponsoredExecutionRecovery` runs one immediate pass at Host startup and then
runs on a fixed interval. Each pass reads bounded batches and:

1. discards expired prepared receipts;
2. looks up due executing receipts by their already-derived Sui digest;
3. finalizes a known Sui result or records an unresolved result after the
   bounded lookup deadline;
4. retries pending Host callbacks and marks successful delivery.

Only one recovery pass runs at a time. Concurrent requests coalesce, full
batches yield to the event loop, and a full batch that made no state change
waits for the next scheduled pass instead of looping forever. Disposal aborts
and awaits the active pass.

---

## 3. Transaction Byte Authority

The final transaction is built once during prepare. The prepare runner reads
the bytes and SHA-256 hash from the opaque address-balance gas transaction,
returns the bytes to the client, and stores only the hash.

At sponsor time the handler decodes the request's base64 value once. Validation
may parse that `Uint8Array`, but it does not rebuild or replace it. The runner:

1. compares its SHA-256 hash with the prepared record;
2. passes that same `Uint8Array` to `beginSponsoredExecution`;
3. derives and stores the Sui digest from those bytes;
4. passes the same `Uint8Array` object to the only signing and submission port.

There is no automatic resubmission. If submission may have reached Sui but the
response is uncertain, the executing record remains durable and recovery looks
up the stored digest. It never constructs another transaction and never submits
the original transaction again.

For generic settlement, `parseSettleArgs(txBytes)` is the execution authority
for every settlement value embedded in the transaction. `PreparedTxEntry`
provides receipt and resource identity only.

---

## 4. Sponsor Trust Order

The sponsor runner preserves the prepared record while it performs checks that
must not destroy a legitimate user's receipt. In order, it:

1. reads the current prepared record and verifies its route-specific shape;
2. decodes the submitted transaction and verifies the user signature and
   sender binding;
3. compares the submitted byte hash with `PreparedTxEntry.txBytesHash`;
4. performs abuse, transaction-shape, settlement, gas-owner, current-chain,
   preflight, and policy checks required by the route;
5. atomically changes `prepared` to `executing` immediately before signing;
6. signs and submits once;
7. atomically stores the final result and accounting, then attempts callback
   delivery.

A validation failure before step 5 uses `discardPreparedReceipt` when the
receipt itself is no longer safe to retain. A mismatch that does not prove the
legitimate prepared receipt is invalid is rejected without allowing an
untrusted caller to remove that receipt. Route-specific classification is owned
by the generic and Promotion execution policies; the runner owns the durable
transition order.

Full failure classification and abuse-counter behavior are documented in
[`pricing-and-validation.md`](./pricing-and-validation.md#sponsor-failure-classification).

---

## 5. Generic Prepare Authorization

Generic `/relay/prepare` requires sender ownership proof before sponsor-slot
checkout, nonce reservation, on-chain reads, or transaction construction. The
Host recomputes the transaction-kind hash, checks the signed timestamp, verifies
the Sui personal-message signature against `senderAddress`, and claims the
request nonce in `PrepareRequestNonceStore`.

This signature authorizes the prepare request; it is not the final transaction
signature. The user separately signs the returned final transaction bytes, and
`/relay/sponsor` verifies that signature before the durable execution starts.

Generic outstanding-receipt limits use the verified sender. Promotion limits
use the verified developer `userId`. Client-address limits and the in-flight
prepare limiter apply independently. Current numeric limits are listed in
[`parameters.md`](../parameters.md#off-chain-constants).

---

## 6. `profile` Field

`profile` selects the generic settlement path during prepare. The planner
derives the forward `SettlementPlan.variant`, and the compiler consumes that
variant without deriving it again.

`profile` is not persisted in `PreparedTxEntry`. Sponsor checks derive the
effective settlement path from the hash-matched transaction bytes. The
`/prepare` response and structured logs expose `profile` for client display and
operations only; they do not control sponsor execution.

---

## 7. `PREPARE_BUILD_STAGE` Log Contract

`PREPARE_BUILD_STAGE` is emitted by `prepare/build.ts`. Request-level
`PREPARE_STAGE` events are emitted by the generic and Promotion prepare
policies. The current failure stage names are:

| Stage | Boundary |
| --- | --- |
| `quote_rpc_failed` | quote solve request |
| `pass_aborted_post_solve` | work after a completed solve |
| `mid_price_rpc_failed` | mid-price request |
| `dryrun_safebuild_failed` | dry-run transaction construction |
| `dryrun_simulate_failed` | dry-run simulation |
| `dryrun_extract_failed` | dry-run result classification |
| `pass2_safebuild_failed` | final transaction construction |

`quote_rpc_stats_complete`, `mid_price_stats_complete`, and `phase_complete`
describe different scopes. Consumers must not infer one from another. For
example, `pass2_safebuild_failed` carries `phase_complete: false` and can carry
`quote_rpc_stats_complete: true` because quote work finished before final
construction failed.

Quote count and timing fields are projected by `prepare/buildRpcStats.ts`.
Logical quote counts include cache hits; RPC counts include only dispatched
requests. The `baseForQuote` diagnostic fields are:

- `bfq_floor_raised`: whether the market-executable floor raised the original
  economic target on the `baseForQuote` branch;
- `target_output_mist`: original economic target;
- `effective_target_output_mist`: target after the executable floor.

`quote_rpc_failed` has no returned quote and therefore includes only
`target_output_mist`. Credit-only paths emit zero targets and
`bfq_floor_raised: false`.

`dryRunForGas` emits its simulated-stage event as soon as simulation returns.
If result extraction then fails, it also emits `dryrun_extract_failed` with
`completed_stage_emitted: true`.

---

## Cross-References

- Sponsor approval flow: [`pricing-and-validation.md`](./pricing-and-validation.md#sponsor-approval-flow)
- Security policy: [`security.md`](../security.md#web2-security-policy-api-and-infrastructure)
- Runtime operations: [`operations.md`](../operations.md#observability)
