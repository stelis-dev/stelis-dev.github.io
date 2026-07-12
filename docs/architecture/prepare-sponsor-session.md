# Stelis Architecture — Prepare/Sponsor Session

> Type ownership, lifecycle, and trust-boundary reference for the generic prepare → sponsor pipeline.
> Parent document: [`../architecture.md`](../architecture.md)
>
> - Audience: maintainer, reviewer, and internal developer working on prepare/sponsor code
> - Owns: type dependency graph, lifecycle state model, `profile` field classification, sponsor authority summary, perimeter assumption, `PREPARE_BUILD_STAGE` log contract
> - Does not own: non-loss math formulas (→ [`economics-formal.md`](../economics-formal.md)), full sponsor approval flow steps (→ [`pricing-and-validation.md → Sponsor Approval Flow`](./pricing-and-validation.md#sponsor-approval-flow)), security defenses table (→ [`security.md`](../security.md#web2-security-policy-api-and-infrastructure))

---

## 1. Type Ownership Graph

The prepare→sponsor pipeline passes data through four owned boundaries.

```text
Request (handlePrepare — handlers/prepare.ts)
  ├─ verify:   verifyPrepareAuthorization()
  ├─ validate: validateGenericUserTransactionKind()
  │             (command policy + Sponsor/Sender withdrawal policy)
  └─ query:    queryUserCredit(), getConfig()
        │
        ▼
SettlementPlan                         prepare/settlePlanTypes.ts
  (profile, settlementSwapPath, funding, swap, audit)
        │
        │  runGenericPrepareBuildPipeline()  prepare/build.ts
        │  (optional pre-swap credit probe → cost envelope for the selected settlement swap path
        │   → Pass 2 final PTB)
        ▼
GenericPrepareBuildOutput              prepare/build.ts
  (txBytes, txBytesHash, executionCostClaim, simGas,
   gasVarianceFixedMist, slippageBufferMist,
   grossGas, profile, paymentInputSource)
        │
        │  runPrepareStateMachine()          session/sponsoredExecution/runner.ts
        │  (runner combines request identity, acquired resources, build hash,
        │   and route-owned path/order fields into the exact store draft)
        ▼
PreparedTxDraft                        store/prepareTypes.ts
  (exact coordination-only shape; no caller-supplied issuedAt)
        │
        │  PrepareStoreAdapter.store(draft)
        │  (Memory clock or Redis TIME stamps issuedAt exactly once)
        ▼
PreparedTxEntry                        store/prepareTypes.ts
  committed by PrepareStoreAdapter — coordination-only shape
  ├─ txBytesHash           SHA-256 of txBytes; verified in consume() before /sponsor proceeds
  ├─ sponsorAddress       sponsor lease identity + gasOwner coordination
  ├─ receiptId, senderAddress, nonce  lease + nonce-reservation keys (generic outstanding-prepare quota is keyed by verified sender; promotion quota is keyed by verified `userId`)
  └─ orderId, executionPathKey, clientIp, issuedAt  echo + observability
  (no settle-value copies; sponsor reads every settle field from txBytes)

/sponsor receives: txBytes + userSignature + receiptId
  │
  ├─ Transaction.from(txBytes) → extractTxSender      [pre-consume, unbound]
  ├─ peek(receiptId)  → sponsor address + echo metadata [read-only, coordination]
  ├─ verifySenderSignature(txBytes, sig, txSender)     [explicit sender binding]
  ├─ checkBlockedRequest(ip)                           [pre-consume IP-only]
  ├─ consume(receiptId, txBytesHash)                   [atomic single-use delete]
  │                                                     ↑ txSender becomes stored-hash-verified
  │
  │  extractSettleArgsFromBuiltTx()    prepare/extractSettleArgs.ts
  │  (returns all 13 settle-block fields; single parser)
        ▼
ExtractedSettleArgs                    prepare/extractSettleArgs.ts
  └─ authoritative for every sponsor-side settle field:
     executionCostClaim, nonce, quotedHostFeeMist, receiptId,
     simGasReported, gasVarianceFixedMist, slippageBufferMist,
     expectedProtocolFeeMist, expectedConfigVersion, quoteTimestampMs,
     policyHash, orderIdHash, extractedSettlementSwapPath
```

**Core invariant**: every settle field the sponsor decides on is derived from the
submitted `txBytes` via `parseSettleArgs`. The stored entry is not the authority for
those fields — the `txBytesHash` single-use binding in `consume()` guarantees the
submitted bytes are the same ones committed at /prepare time, so the parsed values
are authoritative.

**Pre/post-consume boundary** (address-level attribution):

- _Prepare_: generic `/relay/prepare` proves control of `senderAddress` with a
  Sui personal-message signature over the canonical prepare authorization
  message. That message binds `network`, `packageId`, `senderAddress`,
  `txKindBytesHash`, `settlementTokenType`, optional BPS fields, optional `orderId`,
  timestamp, and request nonce.
- _Pre-consume sponsor_: the submitted sponsor `txBytes` is still unbound until
  the route verifies the user's transaction signature and checks that
  `tx.sender` matches the prepared `senderAddress`. Failures before this match
  are recorded IP-only.
- _Post-consume_: once `consume(receiptId, txBytesHash)` succeeds, `txSender`
  matches the sender proven at prepare time and the submitted bytes match the
  prepare commit. Address-level abuse attribution and blocking are authoritative
  from this point on.

**Stored entry during /sponsor (coordination-only)**:

| Field                                      | Role                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `txBytesHash`                              | single-use hash binding — `consume()` verifies it                                                                                                                          |
| `sponsorAddress`                           | sponsor lease identity + gasOwner coordination                                                                                                                             |
| `receiptId`                                | HMAC-protected receipt identity (paired with committed `txBytesHash` in the pool)                                                                                          |
| `senderAddress`                            | Verified prepare sender, nonce reservation key, generic outstanding-prepare quota key, and observability echo. Promotion outstanding-prepare quota uses verified `userId`. |
| `nonce`                                    | sender-local live/pending reservation compaction key                                                                                                                       |
| `orderId`                                  | echo target for `expectedOrderIdHash` reconstruction                                                                                                                       |
| `executionPathKey`, `clientIp`, `issuedAt` | structured log / TTL observability                                                                                                                                         |

The store entry carries no settle-value copies. Every settle-execution
field (executionCostClaim, fee components, profile, policyHash, quoteTimestampMs)
is read at sponsor time from `parseSettleArgs(txBytes)` exclusively;
`consume()` proves byte-equality between the submitted bytes and the
/prepare commit, so the parsed values are authoritative without any
store mirror. Persisting copies invite drift bugs without adding
authority and is therefore disallowed.

After consume() succeeds the submitted bytes have matched the stored prepare
hash, so all post-consume structure, settlement-argument, and extraction
failures are server-side drift, not user manipulation. The
generic SponsoredExecutionPolicy additionally re-queries on-chain User Vault state for stored-hash-verified
`swap_and_settle_new_user_*` PTBs **between gas-owner verification and preflight** (not
after preflight), so an on-chain `EVaultAlreadyRegistered` abort never reaches preflight
as `SPONSOR_PREFLIGHT_FAILED` + IP-counter pressure. A vault-now-exists drift returns
`REPREPARE_REQUIRED`; a transient or inconsistent vault-state response returns
`SPONSOR_FAILED 500` (fail-closed before preflight + signing). All four shapes
(structure, settlement-argument, extraction, payment-integrity, and gas-owner drift,
plus the three new-user User Vault
stages) emit a structured `SPONSOR_DRIFT_OBSERVED` log for operator triage. The payload
contract (`stage`, `subcode`, `route`, `receipt_id`, `sender`, `client_ip`, and — on
`route: 'promotion'` — `promotion_id`) is owned by
[`pricing-and-validation.md → Sponsor Failure Classification`](./pricing-and-validation.md#sponsor-failure-classification);
this document uses the event name as shared vocabulary only. The current design does
not use a `validationFingerprint` field.

---

## 2. Lifecycle States

```text
/prepare:
  ENTRY ──► reserved ──► stored
            (nonce + slot held)

/sponsor:
  stored ──► consumed ──► submitted ──► executed
                                     ╲► reverted

any state before consumed:
  ──► expired  (TTL eviction, background or on-demand)
      └─ slot released internally on expiry

after consumed (always):
  ──► released  (safeSlotCheckin in finally block)
```

State transitions:

| Transition                             | Trigger                                                                                      | Source location                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| entry → `reserved`                     | `runPrepareStateMachine()` acquires sponsor slot + nonce reservation                         | `session/sponsoredExecution/runner.ts`                                   |
| `reserved` → `stored`                  | compose draft + response, commit lease, `prepareStore.store(draft)`, then ownership transfer | `session/sponsoredExecution/runner.ts`                                   |
| `stored` → `consumed`                  | `prepareStore.consume(receiptId, txBytesHash)` — atomic delete                               | `session/sessionPrimitives.ts` (`consumeEntry`)                          |
| `consumed` → `submitted`               | `signAndSubmit()` call                                                                       | `session/sessionPrimitives.ts`                                           |
| `submitted` → `executed` \| `reverted` | `execResult.success` branch                                                                  | `session/sponsoredExecution/sponsorRunner.ts` + SponsoredExecutionPolicy |
| any → `expired`                        | background `_evictExpired()` or TTL check inside `consume()`                                 | `store/memoryPrepareStore.ts`, `store/redisPrepareStore.ts`              |
| `consumed` → `released`                | `safeSlotCheckin()` in `finally` — runs on every post-consume path                           | `session/sponsoredExecution/sponsorRunner.ts`                            |

The lifecycle states above are enforced by the shared sponsor execution
runners. Prepare-side cleanup is owned by
`session/sponsoredExecution/runner.ts`: the final client response is projected
before the lease/store boundary, acquired reservations release in reverse order
on failure, and transferable resources move to the durable prepared entry
immediately after `prepareStore.store(draft)` returns. Nothing fallible remains
after that ownership transfer. Sponsor-side slot
checkin is owned by `session/sponsoredExecution/sponsorRunner.ts` and runs in
`finally` only after consume succeeds.

---

## 3. `profile` Field Classification

`profile: SettleProfile` (`'credit_general' | 'with_vault' | 'new_user'`) appears in multiple
contexts with different roles. The field must not be read as a control-flow authority at
`/sponsor` — that role belongs to the submitted `txBytes`.

### At /prepare — branch-essential

`profile` drives execution path selection in the planner and compiler:

| Use site                             | File                                                    | Role                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `checkCreditOnlyEligibility()` guard | `prepare/settlementPlanner.ts`                          | Selects eligible `credit_general` requests for the credit-only PTB path; swap build is skipped only after measured credit is selected |
| Credit amount calculation            | `prepare/settlementPlanner.ts`                          | `creditMist` applied only when `!== 'new_user'`                                                                                     |
| On-chain variant selection           | `prepare/settlementPlanner.ts`                          | Inlined: `profile === 'new_user' \|\| !vaultObjectId` → `'new_user'`; else `'with_vault'`                                           |
| Forward discriminant                 | `prepare/settlePlanTypes.ts` (`SettlementPlan.variant`) | Set by `assembleSwapSettlementPlan`; undefined for credit path. Compiler reads `plan.variant` without re-deriving.                  |
| Planner output                       | `prepare/settlePlanTypes.ts` (`SettlementPlan.profile`) | Passed to compiler, then carried into `GenericPrepareBuildOutput.profile`                                                           |

`SettlementPlan.variant` is the forward discriminant: the planner derives it once from
`profile + vaultObjectId` and sets it on the plan; the compiler reads `plan.variant`
directly. A `credit_general` request on a swap path resolves to `'with_vault'` because
the `vaultObjectId` guard is authoritative — `profile` alone is not sufficient.

### At store boundary — not persisted

`profile` is not part of `PreparedTxEntry`. The store carries only
the coordination fields the sponsor lifecycle needs; settle-execution
values (including `profile`) are read at sponsor time from
`parseSettleArgs(txBytes)` exclusively. The prepare runner constructs the exact
coordination-only store draft, and the selected store adds the authoritative
`issuedAt`; the
effective profile the Host used is returned in the `/prepare` response
and is the source of the "profile" value the client UX shows.

### At /sponsor — re-derived from txBytes

Sponsor-side re-validation re-derives all settle paths from the submitted
`txBytes` via `extractSettleArgsFromBuiltTx()`. There is no stored `profile`
at `/sponsor` to consult — the parsed PTB is the only source.

### In API response and logs — observability

| Location                                             | File                  | Purpose                                                     |
| ---------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| `requested_profile` / `effective_profile` log fields | `prepare/build.ts`    | Structured event — credit probe, pass 1, and pass 2 logging |
| `effective_profile` log field                        | `handlers/prepare.ts` | Structured log at response time                             |
| `/prepare` response `profile` field                  | `handlers/prepare.ts` | Client UX — tells caller which execution path ran           |

The response `profile` is informational. It does not constrain what `/sponsor` executes —
that is determined by the PTB bytes the user signs.

---

## 4. Sponsor Trust Order Summary

Full sponsor flow steps: → [`pricing-and-validation.md #sponsor-approval-flow`](./pricing-and-validation.md#sponsor-approval-flow)

**Ownership** (source: `session/sponsoredExecution/genericExecutionPolicy.ts` +
`session/sponsoredExecution/sponsorRunner.ts`):

The sponsor runner checks `txBytes` before consume, then
atomically `consume()`s the stored entry to compare submitted bytes with the stored hash, and
only after that lets the generic SponsoredExecutionPolicy consult the parsed `SettleArgs`
and runtime chain state for the execution verdict.

Pre-consume (IP-only attribution — `tx.sender` is still unbound):

1. Decode `txBytes` and parse the `Transaction`; extract normalized `txSender`.
2. `peek(receiptId)` — read stored coordination metadata.
3. `verifySenderSignature(txBytes, userSignature, txSender)` — explicit sender binding.
4. Session-ownership gate: if `txSender !== peeked.senderAddress`, reject with
   `RECEIPT_SESSION_MISMATCH` (422) and record IP-only abuse. The prepared
   entry and its slot lease are **preserved** so the legitimate owner can
   still retry `/sponsor`. `SPONSOR_SENDER_STORE_DIVERGENCE` is emitted with
   `outcome: 'rejected'`. This blocks the leaked-`receiptId` session-destroy
   vector: without this gate, a caller who knows only the receiptId can
   push their own self-signed bytes into `consume()` and trigger a
   `hash_mismatch`-driven deletion of the legitimate entry.
5. `checkBlockedRequest(ip)` — IP-only. No address check here.
6. `consume(receiptId, txBytesHash)` — atomic single-use hash binding.

Post-consume (address-level attribution is authoritative, with the
abuse blocker's address-level carve-out subcodes — `PAUSED`,
`VAULT_ALREADY_REGISTERED`, `REPLAY_NONCE` — skipping every per-address
temporary-block counter (on-chain revert and simulation-tier
preflight/dry-run) while the IP counter still applies):

7. `checkBlockedRequest(ip, txSender)` — post-consume address block check.
8. `revalidateGenericSponsorPolicy()`:
   - Invalidate config cache; read fresh on-chain config.
   - `validatePtbStructure`.
   - `extractSettleArgsFromBuiltTx` (all 13 settle-block fields).
   - `validateSettleArgs` + `validatePaymentInputIntegrity`.
   - Any failure here → `REPREPARE_REQUIRED` + `SPONSOR_DRIFT_OBSERVED` log
     (payload contract: [`pricing-and-validation.md → Sponsor Failure Classification`](./pricing-and-validation.md#sponsor-failure-classification)).
     No abuse counter: the stored hash match proves failures are server-side drift.
9. `verifyGasOwner` against `prepared.sponsorAddress` (slot coordination).
   New-user User Vault drift re-query runs here, before preflight, only when the
   stored-hash-verified PTB calls `swap_and_settle_new_user_*` on the trusted Stelis
   package (predicate `isNewUserSettleMoveCall(builtCommands, packageId)`).
   Calls `queryUserCredit(ctx.sui, ctx.vaultRegistryId, senderAddress,
ctx.vaultsTableId ?? undefined)`. If the vault now exists →
   `REPREPARE_REQUIRED` + `SPONSOR_DRIFT_OBSERVED { stage:
'new_user_vault_exists', subcode: 'NEW_USER_VAULT_EXISTS' }`, no abuse
   counter (neither IP nor address); slot checkin via existing finally.
   Transient RPC error or `CreditQueryInconsistentStateError` →
   `SPONSOR_FAILED 500` (fail-closed before preflight + signing) +
   `SPONSOR_DRIFT_OBSERVED` with stage `new_user_vault_query_failed` or
   `new_user_vault_state_inconsistent`, no abuse counter. With-vault and
   credit profiles short-circuit the predicate (no extra RPC).
   **Ordering rationale**: if the vault check runs after preflight, preflight
   reports the on-chain `EVaultAlreadyRegistered` abort as
   `SPONSOR_PREFLIGHT_FAILED` - IP-counter pressure (the address carve-out
   skips only the non-IP counter), and the flow emits no
   `SPONSOR_DRIFT_OBSERVED` — both violate the
   vault-drift contract. **Residual TOCTOU**: in the brief window between
   this pre-sign re-query and on-chain submit a vault can still be created;
   the resulting on-chain `VAULT_ALREADY_REGISTERED` revert is handled by
   the standard non-IP carve-out in `ADDRESS_CARVE_OUT_SUBCODES` (address
   counter skipped) and the IP counter still increments — same rule as
   every other carve-out subcode.
10. Preflight simulation → `validateGenericSponsorNonloss` — fed
    `settleArgs.gasVarianceFixedMist`, `settleArgs.slippageBufferMist`, and
    `settleArgs.executionCostClaim`; no store copies participate in the non-loss decision.
11. `signAndSubmit` via sponsor pool.
12. Economics log built from `settleArgs.executionCostClaim` and
    `settleArgs.quotedHostFeeMist` (tx-derived); `protocolFee` from fresh
    on-chain config.

Stored fields still read at `/sponsor` (coordination-only, never execution authority):

| Field                      | Purpose                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `txBytesHash`              | Single-use stored hash verified in `consume()`                                    |
| `orderId`                  | Echo target for `expectedOrderIdHash` reconstruction during settlement validation |
| `sponsorAddress`           | Sponsor lease identity + gasOwner coordination                                   |
| `receiptId`                | HMAC-protected receipt identity (paired with committed `txBytesHash` in the pool) |
| `executionPathKey`         | `ONCHAIN_REVERT` log key                                                          |

Settle observability fields **not persisted** in the store:
`executionCostClaim`, `quotedHostFeeMist`, `gasVarianceFixedMist`,
`slippageBufferMist`, `simGas`, `grossGas`, `policyHash`,
`quoteTimestampMs`, `profile`. Sponsor obtains each value from
`ExtractedSettleArgs` (parsed from the stored-hash-verified PTB).

`nonce` is persisted as a base coordination field (used by
`reserveNonce` / sender-metadata compaction at the store layer); it is
not read as authority during `/sponsor` execution and is therefore not
part of the `/sponsor`-time read set above.

Config drift vs. tampering distinction and full abuse-recording rules:
→ [`pricing-and-validation.md #sponsor-approval-flow`](./pricing-and-validation.md#sponsor-approval-flow)

---

## 5. Prepare Authorization Boundary

Generic `/relay/prepare` requires sender ownership proof before the prepare
state machine enters sponsor slot checkout, nonce reservation, on-chain reads,
or PTB build work.

The request carries:

- `txKindBytes`
- `senderAddress`
- `settlementTokenType`
- `txKindBytesHash`
- `prepareAuthorizationTimestampMs`
- `prepareAuthorizationRequestNonce`
- `prepareAuthorizationSignature`

The Host recomputes `txKindBytesHash`, checks timestamp TTL and clock skew,
verifies the Sui personal-message signature against `senderAddress`, and claims
the request nonce in `PrepareRequestNonceStore`. A reused request nonce or a
signature from another address fails before prepare admission.

The prepare authorization signature is not the final transaction signature. It
authorizes the request to prepare a transaction-kind hash and route fields. The
user still signs the returned `txBytes`, and `/relay/sponsor` verifies that
transaction signature before consume.

**Outstanding-prepare quotas**:

- Generic prepare enforces a sender-local live-or-pending quota at nonce
  reservation. This is safe because prepare authorization has already proven
  control of `senderAddress`.
- Studio promotion prepare enforces a user quota keyed by the verified
  developer JWT `userId`.
- IP concurrency and the in-flight limiter still apply before and during
  prepare work.

Current numeric values for these gates are owned by
[`parameters.md → Off-Chain Constants`](../parameters.md#off-chain-constants) and
[`parameters.md → TTL Constants`](../parameters.md#ttl-constants).

**Production requirement**: generic `/relay/prepare` still sits behind WAF/CDN
or equivalent upstream rate shaping. Prepare authorization proves sender
control, but application-layer controls are defense-in-depth, not a traffic
perimeter replacement.

Full defense table and store strategy:
→ [`security.md`](../security.md#web2-security-policy-api-and-infrastructure)

---

## 6. `PREPARE_BUILD_STAGE` Log Contract

`PREPARE_BUILD_STAGE` is the build-pipeline phase-local structured log emitted
from [`prepare/build.ts`](../../packages/core-api/src/prepare/build.ts) via
`logPrepareBuildStage(stage, payload)`. It is layered with the request-level
`PREPARE_STAGE` log emitted from the prepare SponsoredExecutionPolicys
([`genericExecutionPolicy.ts`](../../packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts),
[`studioExecutionPolicy.ts`](../../packages/core-api/src/session/sponsoredExecution/studioExecutionPolicy.ts));
the high-level operations note lives at
[`operations.md`](../operations.md#observability). This subsection owns the
prepare build stage names and required marker fields that the operations note
intentionally does not list.

The contract below freezes the current baseline. Stage strings are
grep-friendly: each name corresponds 1:1 with the throw point that emits it,
so an operator can locate failure sites by exact string match. There is no
`prepare_phase_failed` umbrella stage in the current contract.

### Failure stages

| Stage                     | Emit site (file)                                     | Axis                  | Pass labels                     |
| ------------------------- | ---------------------------------------------------- | --------------------- | ------------------------------- |
| `quote_rpc_failed`        | `prepare/build.ts` `solveSwapForClaim` catch         | quote-RPC solve       | `pass1` \| `pass1_5` \| `pass2` |
| `pass_aborted_post_solve` | `prepare/build.ts` `runPreparePass` post-solve catch | post-solve            | `pass1` \| `pass2`              |
| `mid_price_rpc_failed`    | `prepare/build.ts` `runPreparePass` mid-price catch  | mid-price RPC         | `pass1` \| `pass2`              |
| `dryrun_safebuild_failed` | `prepare/build.ts` `dryRunForGas` safeBuild catch    | dry-run lifecycle     | `credit_preswap` \| `pass1`     |
| `dryrun_simulate_failed`  | `prepare/build.ts` `dryRunForGas` simulate catch     | dry-run lifecycle     | `credit_preswap` \| `pass1`     |
| `dryrun_extract_failed`   | `prepare/build.ts` `dryRunForGas` extract catch      | dry-run lifecycle     | `credit_preswap` \| `pass1`     |
| `pass2_safebuild_failed`  | `prepare/build.ts` final pass2 build catch           | final-build lifecycle | `pass2`                         |

`dryRunForGas` services `credit_preswap` and `pass1` only. `pass2_safebuild_failed`
is emitted from a separate final-build catch site, not via `dryRunForGas`. This
split is intentional so dry-run lifecycle and final-build lifecycle each retain
their own catch boundary.

### Completeness markers

Completeness markers are payload sub-contract markers, not one-per-stage
classifiers. A lifecycle failure can carry both `phase_complete:false` and a
complete quote-stats payload when quote work already finished before the
lifecycle failure.

The quote-stats schema has two layers:

| Layer                                 | Fields                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| RPC dispatch counts and timing        | `quote_quantity_in_rpc_calls`, `quote_quantity_out_verify_rpc_calls`, `quote_total_rpc_calls`, `quote_rpc_total_ms`, `quote_rpc_max_ms` |
| Logical solve counts and cache effect | `quote_quantity_in_logical_calls`, `quote_quantity_out_verify_logical_calls`, `quote_cache_hits`                                        |

Logical counts equal RPC counts when no cache fires; the request-local quote
cache makes `logical >= rpc` and reports the difference as `quote_cache_hits`.

| Stage                     | `quote_rpc_stats_complete` | Reason                                                                                                                                                                                                                |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `two_pass_complete`       | `true`                     | success aggregate; all request-level quote work is complete                                                                                                                                                           |
| `quote_rpc_failed`        | `false`                    | solve-time failure; only quote work performed before the throw is known                                                                                                                                               |
| `pass_aborted_post_solve` | `false`                    | post-solve failure; the current pass quote stats are known but request-level quote work did not complete                                                                                                              |
| `pass2_safebuild_failed`  | `true`                     | final-build lifecycle failure after pass1 / pass1.5 / pass2 quote work already completed                                                                                                                              |
| `dryrun_safebuild_failed` | `false`                    | dry-run safe-build failure; carries pass1 quote stats (already accumulated) on the pass1 path or zero stats on the credit_preswap path (upstream of any solve). Request-level quote work is incomplete in either case |
| `dryrun_simulate_failed`  | `false`                    | dry-run simulate failure; same pass1 / credit_preswap stats source as `dryrun_safebuild_failed`. Request-level quote work is incomplete                                                                               |
| `dryrun_extract_failed`   | `false`                    | dry-run extract failure (simulate returned but classification rejected); same pass1 / credit_preswap stats source. Request-level quote work is incomplete                                                             |

The marker spans quote-RPC failures, post-solve failures, success, and final-build
failures because each can carry the quote-stats payload shape. The marker
boundary is "quote-stats payload completeness", not "quote-RPC axis only".

- `mid_price_stats_complete: false` — paired with the single
  `mid_price_total_ms` field. Set on `mid_price_rpc_failed`. Mid-price failures
  do not aggregate quote-RPC stats; the marker scope is the mid-price axis only.
- `phase_complete: false` — paired with lifecycle phase failures:
  `dryrun_safebuild_failed`, `dryrun_simulate_failed`, `dryrun_extract_failed`,
  and `pass2_safebuild_failed`. The marker scope is **lifecycle phase only**:
  it signals that the overall prepare phase did not complete, not that the
  emit carries no stat fields. Whether quote stats are present and complete
  is signalled by `quote_rpc_stats_complete` independently. In particular,
  `pass2_safebuild_failed` carries `phase_complete: false` together with
  `quote_rpc_stats_complete: true` because final build happens after all
  quote solves; consumers and operators MUST NOT infer "ignore stats" from
  `phase_complete: false`.

### `baseForQuote` Market-Executable Floor Diagnostic

`run_prepare_pass_swap_amount_computed`, `pass1_5_slippage_measured`,
`pass_aborted_post_solve`, and `two_pass_complete` carry the same three-field
diagnostic so an operator can correlate downstream
`INSUFFICIENT_BALANCE` (raised swap input vs. user settlement-token funding)
or settlement surplus with the floor that triggered a target raise:

- `bfq_floor_raised: bool` — `true` only on the `baseForQuote` (`_bfq`) settlement branch and only when the
  solver's `effectiveTargetOutputMist` exceeds the request `targetOutputMist`.
  The `quoteForBase` (`_qfb`) `descriptor.minSize` bump is intentionally outside this flag
  so the diagnostic stays scoped to the `baseForQuote` branch.
- `target_output_mist: string` — the original economic SUI target supplied to
  the solver (planner-owned; reflects credit subtraction).
- `effective_target_output_mist: string` — the market-executable target after
  the solver lifts to `ceil(descriptor.minSize × midPrice / 1e9)` on the
  `baseForQuote` branch or to `descriptor.minSize` on the `quoteForBase` branch. Equal to
  `target_output_mist` when no bump fires.

Emitted on credit-only paths as `bfq_floor_raised: false`,
`target_output_mist: '0'`, `effective_target_output_mist: '0'` to keep the
shape stable across the credit/swap branch split.

`quote_rpc_failed` carries `target_output_mist` only — the solver throws
before any `ExecutableSwapQuote` is returned to `build.ts`, so the bump
result (`effectiveTargetOutputMist`) and the derived `bfq_floor_raised`
flag are intentionally absent on that stage even when the bump itself
already ran inside the solver. The economic target is still emitted so an
operator can recover what the failed solve was attempting; success-path
stages carry both fields via the returned quote.

### `dryrun_extract_failed` dual emit

`dryRunForGas` emits the simulated-stage marker
(`credit_preswap_dryrun_simulated` or `pass1_dryrun_simulated`) as soon as
`simulateTransaction` returns, before `extractSuccessfulDryRunGas` runs.
If extract then throws, the same call also emits `dryrun_extract_failed`
with `completed_stage_emitted: true`. The dual emit is intentional so the
log stream records both that simulate returned and that classification
failed.

### Current Taxonomy Boundary

The current contract uses distinct stage names such as `quote_rpc_failed`,
`pass_aborted_post_solve`, and `pass2_safebuild_failed`. There is no unified
`prepare_phase_failed` event in the current runtime emit sites or tests.

---

## Cross-References

- Full sponsor approval flow: [`pricing-and-validation.md #sponsor-approval-flow`](./pricing-and-validation.md#sponsor-approval-flow)
- Security defenses and WAF requirement: [`security.md`](../security.md#web2-security-policy-api-and-infrastructure)
- Non-loss math and profile budgets: [`pricing-and-validation.md`](./pricing-and-validation.md)
- On-chain objects and settlement entry points: [`onchain-settlement.md`](./onchain-settlement.md)
- Settlement swap path policy and multi-token expansion: [`settlement-swap-path-boundaries.md`](./settlement-swap-path-boundaries.md)
