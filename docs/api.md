# API Reference

This document lists the public relay and Studio routes, plus the mounted auth and admin route groups currently exposed by `@stelis/app-api`.

The runtime parsers exported by `@stelis/contracts` are the executable schema
for Relay API, Studio, Auth, and Admin request and response bodies. Host
producers and current clients consume those parsers; there is no parallel
hand-maintained JSON Schema.

## Route Groups

| Prefix          | Purpose                                    | Available modes                                   |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| `/health`       | Host health probe                          | All modes                                         |
| `/relay/*`      | Public Relay API flow                      | All modes                                         |
| `/studio/*`     | Developer-JWT promotion flow               | `relay_with_admin_and_studio`                     |
| `/admin/auth/*` | Admin authentication inside management API | `relay_with_admin`, `relay_with_admin_and_studio` |
| `/admin/*`      | Complete Host management API               | `relay_with_admin`, `relay_with_admin_and_studio` |

## GET /health

Returns Host health:

```json
{ "status": "ok", "mode": "relay_only" }
```

`mode` is exactly `relay_only`, `relay_with_admin`, or
`relay_with_admin_and_studio`.

## Request admission

Host composition first selects the route implementation for the booted mode.
Each mounted Relay, Studio, Auth, or Admin route then applies its relevant
checks in this order: client-IP admission, Origin and Content-Type admission,
bounded body reading, credential verification, authenticated-subject
admission, then route-specific work. A failed earlier check does not start a
later check. On an Admin-only Host, `/admin/promotions*` completes Admin admission
before returning `STUDIO_UNAVAILABLE`; it performs no Promotion-domain I/O.

Requests with a JSON body require `Content-Type: application/json`; valid
media-type parameters such as `charset=utf-8` are accepted. Missing, different,
or malformed media types are rejected. Every Admin request carrying `Origin`
must match `ADMIN_APP_ORIGIN`. When that setting is absent, every supplied
Origin is rejected. Origin-less clients continue to Admin authentication.

In `relay_only` mode, Studio routes return `STUDIO_UNAVAILABLE` and Auth/Admin
routes return `ADMIN_UNAVAILABLE` without performing credential or domain
work. In `relay_with_admin` mode, Auth/Admin routes are available and Studio
routes return `STUDIO_UNAVAILABLE`. `relay_with_admin_and_studio` exposes all
three route groups. `/relay/*` and `/studio/*` use the same public browser
policy and accept every origin without credentials. CORS preflight for Studio is the
transport-level exception: it succeeds in all modes so a browser can issue the
actual request and read the typed `STUDIO_UNAVAILABLE` response.

## GET /relay/status

Returns the exact Relay API reachability response:

```json
{ "ok": true }
```

## GET /relay/config

Returns runtime capability:

- `network`
- `packageId`
- `settlementPayoutRecipient`: settlement payout recipient address for `executionCostClaim` plus `quotedHostFeeMist`
- `supportedSettlementSwapPaths`
- `quotedHostFeeMist`
- `protocolFlatFeeMist`

Clients treat `supportedSettlementSwapPaths` as the Host's supported settlement token list and settlement swap path list.
Each `settlementTokenType` appears once and maps to one Host-configured SUI-adjacent DeepBook one-hop settlement swap path. `POST /relay/prepare` selects that token's active settlement swap path with `settlementTokenType`; clients do not send a pool ID or path ID.
The settlement swap path includes the DeepBook pool and `swapDirection` used by the Host. `settlementPayoutRecipient` is an address, not the Host role or a sponsor signing account.

## POST /relay/settlement-funding-check

Returns a read-only advisory about current User Vault credit and settlement-token
funding for one transaction kind and exact estimated execution-cost claim. The
route is public and credential-free. It uses normal Relay IP admission, bounded
JSON body reading, and the same aggregate in-flight chain-work capacity as
`POST /relay/prepare`.

The request contains exactly:

```json
{
  "txKindBytes": "<base64 TransactionKind bytes>",
  "senderAddress": "0x...",
  "settlementTokenType": "0x...::coin::COIN",
  "estimatedExecutionCostClaimMist": "5100000"
}
```

`estimatedExecutionCostClaimMist` is a canonical non-negative decimal string
in the Sui `u64` range and must not exceed the Host's current on-chain
`maxClaimMist`. The Host validates the transaction kind and uses the same
ordered funding process as generic prepare: credit-only eligibility, required
SUI output, current executable market quote including min/lot rules, and
prefix-aware settlement-token funding.

The response is one closed result:

- `likely_sufficient` with `source: "vault_credit"` or
  `source: "settlement_token"`;
- `likely_insufficient` with the quoted required settlement-token amount and
  `availableSettlementTokenAmount`, the complete amount still available after
  applying the supplied transaction prefix; or
- `indeterminate` with `reason: "bounded_coin_discovery"` or
  `reason: "market_unavailable"`.

Every result echoes the exact estimated claim. A quoted required token amount
is present only when current market evidence proved it. Bounded-incomplete coin
discovery never becomes an insufficient result. The route reserves no sponsor,
nonce, or receipt and writes no domain record; its in-flight capacity lease is
released after success, failure, or cancellation.

This response is advisory. `POST /relay/prepare` remains authoritative because
it measures the final transaction claim and uses current reservations and
state. A client may warn on `likely_insufficient`; it must not treat
`likely_sufficient` as execution authorization or `indeterminate` as rejection.

## POST /relay/prepare

Prepares a sponsored transaction.

Required fields:

- `txKindBytes`: serialized transaction-kind bytes in base64
- `senderAddress`: Sui address
- `settlementTokenType`: settlement token coin type from `GET /relay/config.supportedSettlementSwapPaths`
- `txKindBytesHash`: SHA-256 hash of `txKindBytes`, encoded as hex
- `prepareAuthorizationTimestampMs`: Unix timestamp in milliseconds included in the prepare authorization message
- `prepareAuthorizationRequestNonce`: client-generated nonce included in the prepare authorization message
- `prepareAuthorizationSignature`: Sui personal-message signature over the canonical prepare authorization message

Optional fields:

- `slippageBps`
- `gasMarginBps`
- `orderId`

Minimal JSON body:

```json
{
  "txKindBytes": "<base64 TransactionKind bytes>",
  "senderAddress": "0x...",
  "settlementTokenType": "0x...::coin::COIN",
  "txKindBytesHash": "<64 lowercase hex chars>",
  "prepareAuthorizationTimestampMs": 1760000000000,
  "prepareAuthorizationRequestNonce": "<client nonce>",
  "prepareAuthorizationSignature": "<personal-message signature>"
}
```

### User TransactionKind rules

`txKindBytes` is a user-supplied `User TransactionKind`, not the final Host-built transaction. The Host validates it before sponsor slot checkout, nonce reservation, on-chain reads, or transaction building.

The user-supplied `User TransactionKind` must satisfy these rules:

- It contains zero Stelis settlement calls. The Host appends exactly one settlement call later.
- It contains at most `MAX_GENERIC_USER_COMMANDS = 11` commands. The Host reserves five commands for the current generic settlement suffix so the final transaction remains within `MAX_FINAL_COMMANDS = 16`.
- It does not reference `GasCoin` in command arguments.
- It does not include `Publish` or `Upgrade`.
- It does not call unauthorized Stelis package functions. `vault::withdraw` is allowed.
- It does not include `FundsWithdrawal(Sponsor)`.
- A malformed same-token `FundsWithdrawal(Sender)` is rejected with `UNACCOUNTABLE_WITHDRAWAL`.
- A bounded same-token `FundsWithdrawal(Sender)` is allowed and is subtracted from address-balance funding.

Funding resolution considers both Coin object provenance and `FundsWithdrawal(Sender)` address-balance accounting. The Host reads at most 50 settlement-token Coin objects for one prepare operation and never treats a partial read as wallet exhaustion. The current funding source outcomes are `coin_object`, `address_balance`, and `mixed_topup`. The current funding failure codes are `INSUFFICIENT_BALANCE`, `PAYMENT_COIN_CONFLICT`, and `PAYMENT_COIN_LIMIT_EXCEEDED`. `PAYMENT_COIN_CONFLICT` means the transaction's settlement-token payment could not be resolved safely; it is not proof of insufficient balance. `PAYMENT_COIN_LIMIT_EXCEEDED` is an HTTP 422 response that instructs the caller to consolidate settlement-token Coin objects and retry; it is also not an insufficient-balance result.

The response includes transaction bytes for user signing and a `receiptId` for sponsor submission.
The response cost fields include `executionCostClaim`, which is the gas-recovery claim embedded in the settlement arguments. It is not the full settlement payout; on-chain settlement pays `executionCostClaim + quotedHostFeeMist` to `settlementPayoutRecipient`.

The prepare authorization message binds the sender to the transaction-kind hash, selected settlement token type, optional cost fields, optional `orderId`, timestamp, and request nonce. The Host recomputes `txKindBytesHash`, verifies the personal-message signature against `senderAddress`, rejects expired timestamps, and rejects reused prepare authorization nonces before entering the prepare state machine.

`prepareAuthorizationRequestNonce` is a request replay guard. It is separate from the on-chain settlement nonce returned in the prepare response.

The signed prepare authorization message is a UTF-8 JSON string with these fields in this order:

```json
{
  "version": 1,
  "network": "testnet",
  "packageId": "0x...",
  "senderAddress": "0x...",
  "txKindBytesHash": "<64 lowercase hex chars>",
  "settlementTokenType": "0x...::coin::COIN",
  "slippageBps": null,
  "gasMarginBps": null,
  "orderId": null,
  "timestampMs": 1760000000000,
  "requestNonce": "<client nonce>"
}
```

`packageId` and `senderAddress` are normalized Sui addresses. `txKindBytesHash` is lower-case hex without a `0x` prefix. Omitted optional fields are serialized as `null`.

## POST /relay/sponsor

Submits a prepared transaction after the user signs it.

Required fields:

- `txBytes`
- `userSignature`
- `receiptId`

Minimal JSON body:

```json
{
  "txBytes": "<base64 transaction bytes returned by prepare>",
  "userSignature": "<transaction signature>",
  "receiptId": "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The route validates the prepared record, checks the transaction again, adds the sponsor signature, and submits.

The submitted `txBytes` SHA-256 must match the prepared hash bound to `receiptId`. The route verifies the user's transaction signature, checks that `tx.sender` matches the sender proven at prepare time, re-parses settlement fields from the hash-matched transaction bytes, and atomically changes the receipt from `prepared` to `executing` immediately before the sponsor signature.
The submitted `txBytes` is the final Host-built transaction. It must contain exactly one allowed settlement call and at most `MAX_FINAL_COMMANDS = 16` commands. This final transaction validation is separate from the user-supplied `User TransactionKind` validation performed during `POST /relay/prepare`.
The `executionCostClaim` returned by this route is the transaction-derived gas-recovery claim from the settlement arguments.

## Error Responses

Every current Relay, Studio, Auth, and Admin error response contains an `error`
string and a `code` from the current route error vocabulary. Rate limiting uses
`RATE_LIMITED` together with `retryAfterMs` and a `Retry-After` header. The
current error body is closed: the only optional metadata fields are
`retryAfterMs`, `subcode`, `digest`, `operationId`, `minSettleMist`,
`requiredTotalIn`, and `isEstimate`. Clients must reject a response with
another field or a value outside the documented type instead of preserving an
arbitrary server diagnostic dictionary. Treat `code` and the typed optional
fields as the machine-readable contract. The `error` summary comes from the
same contracts-owned authority and does not carry internal or upstream text.

Each current `code` has one HTTP status and one metadata policy owned by
`@stelis/contracts`. Producers do not override status per call, and consumers
reject a code/status or code/message mismatch. Known submitted transactions retain `digest` on
on-chain revert, congestion, and post-submit terminal-processing failures so a
caller can reconcile the exact transaction. If the Host issued the sponsor
signature but cannot prove a current terminal Sui result, it returns
`SPONSOR_SUBMISSION_UNCERTAIN` with HTTP 503 and the pre-derived `digest`.
Callers reconcile that digest instead of assuming the transaction was never
submitted or blindly rebuilding it. Every one of these codes requires
`digest`.
Use `parseHostErrorResponse` with the route-specific code list exported by
`@stelis/contracts` when validating a response body. The parser closes metadata
relationships and binds the body code to the HTTP status.

`CLIENT_IP_UNRESOLVED` is a current shared route-boundary error code. Relay
prepare/sponsor and Studio routes can return it before admission state is
touched when the Host cannot establish a trusted client IP.

## Studio Promotion Routes

Studio promotion routes require:

```text
Authorization: Bearer <developerJwt>
```

Mounted routes:

- `GET /studio/promotions?cursor=<promotionId>&limit=<1..100>`
- `GET /studio/promotions/:id`
- `POST /studio/promotions/:id/claim`
- `POST /studio/promotions/:id/prepare`
- `POST /studio/promotions/:id/sponsor`

Promotion claim requires `Content-Type: application/json` and the exact request
body `{}`. Promotion prepare uses `senderAddress` and `txKindBytes`. The
Promotion `TransactionKind` must contain 1 to 16 commands, all of them
`MoveCall`. Promotion sponsor uses `receiptId`, `txBytes`, and `userSignature`;
the Host adds gas metadata but no commands and revalidates the same range
before the atomic `prepared` to `executing` transition.

Promotion IDs and list cursors are canonical lowercase UUID-v4 strings. List
queries default to 50 records and return at most 100. Results are ordered by
ascending Promotion ID and the response is `{ promotions, nextCursor }`.
`nextCursor` is the final returned ID only when another page exists; pass it as
the next request's exclusive cursor. The cursor remains valid as a position
even if that Promotion is later deleted or changes status.

## Auth Routes

`/admin/auth/*` routes create and maintain admin sessions for `@stelis/app-admin`.

Mounted auth routes:

- `POST /admin/auth/nonce`
- `POST /admin/auth/verify`
- `POST /admin/auth/renew`
- `POST /admin/auth/logout`
- `GET /admin/auth/session`

## Admin Routes

`/admin/*` routes are operator routes. SDK and MCP clients must not depend on them.
Auth and Admin request and response bodies use the current parsers exported by
`@stelis/contracts`; `@stelis/app-admin` rejects uncoded errors and malformed
success responses. `/admin/logs` returns structured audit entries with `ts`,
`event`, and `ip`, plus the current optional `address`, `reason`, `error`, and
`detail` fields.

Mounted admin routes:

- `GET /admin/blocklist?cursor=<opaqueCursor>&limit=<1..100>`
- `DELETE /admin/blocklist`
- `GET /admin/logs`
- `GET /admin/sponsored-logs/summary`
- `GET /admin/sponsored-logs`
- `GET /admin/sponsor-operations`
- `POST /admin/sponsor-refill-account/withdrawal-challenge`
- `POST /admin/sponsor-refill-account/withdraw`
- `GET /admin/settlement-swap-paths`
- `GET /admin/studio`
- `GET /admin/promotions?status=<status>&cursor=<promotionId>&limit=<1..100>`
- `POST /admin/promotions`
- `GET /admin/promotions/:id`
- `PUT /admin/promotions/:id`
- `POST /admin/promotions/:id/status`
- `DELETE /admin/promotions/:id`
- `GET /admin/promotions/:id/summary`

`GET /admin/studio` is the Admin app's Studio-availability authority. A
`relay_with_admin` Host returns `{ "enabled": false }`. A
`relay_with_admin_and_studio` Host returns an enabled response whose `config`
reports `developerJwtVerifyUrlConfigured`. Admin Promotion routes return
`STUDIO_UNAVAILABLE` in `relay_with_admin` mode.

The Admin Promotion list uses the same bounded cursor contract as the Studio
list. `status` is optional and accepts the current Promotion status values.

The blocklist route returns a bounded page of typed `ip`, `address`, and
`studio_user` identities with their reason and expiry time. Its cursor is
opaque. Deletion accepts the same typed identity and does not expose Redis
keys or TTL sentinel values.

## MCP Boundary

Agent-facing tools are provided by `@stelis/mcp-server`, not by a separate `/agent/*` HTTP route group.

The MCP server calls the relay and promotion routes over HTTP.
