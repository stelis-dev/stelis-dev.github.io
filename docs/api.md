# API Reference

This document lists the public relay and Studio routes, plus the mounted auth and admin route groups currently exposed by `@stelis/app-api`.

The runtime parsers exported by `@stelis/contracts` are the executable schema
for Relay API, Studio, Auth, and Admin request and response bodies. Host
producers and current clients consume those parsers; there is no parallel
hand-maintained JSON Schema.

## Route Groups

| Prefix      | Purpose                      |
| ----------- | ---------------------------- |
| `/health`   | Host health probe            |
| `/relay/*`  | Public Relay API flow        |
| `/studio/*` | Developer-JWT promotion flow |
| `/auth/*`   | Admin session authentication |
| `/api/*`    | Operator admin routes        |

## GET /health

Returns Host health:

```json
{ "status": "ok", "mode": "generic" }
```

`mode` is `generic` or `dual`.

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

Funding resolution considers both coin object provenance and `FundsWithdrawal(Sender)` address-balance accounting. The current funding source outcomes are `coin_object`, `address_balance`, and `mixed_topup`. The current funding failure codes are `INSUFFICIENT_BALANCE` and `PAYMENT_COIN_CONFLICT`.

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
  "receiptId": "0x..."
}
```

The route validates the prepared record, checks the transaction again, adds the sponsor signature, and submits.

The submitted `txBytes` must match the prepared record bound to `receiptId`. The route verifies the user's transaction signature, checks that `tx.sender` matches the sender proven at prepare time, consumes the prepared record once, and then re-parses settlement fields from the stored-hash-verified transaction bytes.
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

Promotion prepare uses `senderAddress` and `txKindBytes`. The Promotion `TransactionKind` must contain 1 to 16 commands, all of them `MoveCall`. Promotion sponsor uses `receiptId`, `txBytes`, and `userSignature`; the Host adds gas metadata but no commands and revalidates the same range before consume.

Promotion IDs and list cursors are canonical lowercase UUID-v4 strings. List
queries default to 50 records and return at most 100. Results are ordered by
ascending Promotion ID and the response is `{ promotions, nextCursor }`.
`nextCursor` is the final returned ID only when another page exists; pass it as
the next request's exclusive cursor. The cursor remains valid as a position
even if that Promotion is later deleted or changes status.

## Auth Routes

`/auth/*` routes create and maintain admin sessions for `@stelis/app-admin`.

Mounted auth routes:

- `POST /auth/nonce`
- `POST /auth/verify`
- `POST /auth/renew`
- `POST /auth/logout`
- `GET /auth/session`

## Admin Routes

`/api/*` routes are operator routes. SDK and MCP clients must not depend on them.
Auth and Admin request and response bodies use the current parsers exported by
`@stelis/contracts`; `@stelis/app-admin` rejects uncoded errors and malformed
success responses. `/api/logs` returns structured audit entries with `ts`,
`event`, and `ip`, plus the current optional `address`, `reason`, `error`, and
`detail` fields.

Mounted admin routes:

- `GET /api/blocklist`
- `DELETE /api/blocklist`
- `GET /api/logs`
- `GET /api/sponsored-logs/summary`
- `GET /api/sponsored-logs`
- `GET /api/sponsor-operations`
- `POST /api/sponsor-refill-account/withdrawal-challenge`
- `POST /api/sponsor-refill-account/withdraw`
- `GET /api/settlement-swap-paths`
- `GET /api/studio`
- `GET /api/promotions?status=<status>&cursor=<promotionId>&limit=<1..100>`
- `POST /api/promotions`
- `GET /api/promotions/:id`
- `PUT /api/promotions/:id`
- `POST /api/promotions/:id/status`
- `DELETE /api/promotions/:id`
- `GET /api/promotions/:id/users`
- `GET /api/promotions/:id/summary`

The Admin Promotion list uses the same bounded cursor contract as the Studio
list. `status` is optional and accepts the current Promotion status values.

## MCP Boundary

Agent-facing tools are provided by `@stelis/mcp-server`, not by a separate `/agent/*` HTTP route group.

The MCP server calls the relay and promotion routes over HTTP.
