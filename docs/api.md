# API Reference

This document lists the public relay and Studio routes, plus the mounted auth and admin route groups currently exposed by `@stelis/app-api`.

The schema file [`schemas/relay-api.schema.json`](./schemas/relay-api.schema.json) covers the relay and promotion request/response shapes that are locked by tests.

## Route Groups

| Prefix | Purpose |
| --- | --- |
| `/health` | Host health probe |
| `/relay/*` | Public relay flow |
| `/studio/*` | Developer-JWT promotion flow |
| `/auth/*` | Admin session authentication |
| `/api/*` | Operator admin routes |

## GET /health

Returns Host health:

```json
{ "status": "ok", "mode": "generic" }
```

`mode` is `generic` or `dual`.

## GET /relay/status

Returns relay status from `@stelis/core-api`.

## GET /relay/config

Returns runtime capability:

- `network`
- `packageId`
- `settlementPayoutRecipient`: settlement payout recipient address for `executionCostClaim` plus `quotedHostFeeMist`
- `supportedSettlementSwapPaths`
- `quotedHostFeeMist`
- `protocolFlatFeeMist`
- `integrityPolicyVersion`

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
- It contains at most `MAX_COMMANDS = 16` commands.
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

The route validates the prepared record, checks the transaction again, sponsor-signs, and submits.

The submitted `txBytes` must match the prepared record bound to `receiptId`. The route verifies the user's transaction signature, checks that `tx.sender` matches the sender proven at prepare time, consumes the prepared record once, and then re-parses settlement fields from the hash-bound transaction bytes.
The submitted `txBytes` is the final Host-built transaction. It must contain exactly one allowed settlement call. This final transaction validation is separate from the user-supplied `User TransactionKind` validation performed during `POST /relay/prepare`.
The `executionCostClaim` returned by this route is the transaction-derived gas-recovery claim from the settlement arguments.

## Studio Promotion Routes

Studio promotion routes require:

```text
Authorization: Bearer <developerJwt>
```

Mounted routes:

- `GET /studio/promotions`
- `GET /studio/promotions/:id`
- `POST /studio/promotions/:id/claim`
- `POST /studio/promotions/:id/prepare`
- `POST /studio/promotions/:id/sponsor`

Promotion prepare uses `senderAddress` and `txKindBytes`. Promotion sponsor uses `receiptId`, `txBytes`, and `userSignature`.

## Auth Routes

`/auth/*` routes create and maintain admin sessions for `@stelis/app-admin`.

Mounted auth routes:

- `GET /auth/nonce`
- `POST /auth/verify`
- `POST /auth/renew`
- `POST /auth/logout`
- `GET /auth/session`

## Admin Routes

`/api/*` routes are operator routes. SDK and MCP clients must not depend on them.

Mounted admin routes:

- `GET /api/blocklist`
- `DELETE /api/blocklist`
- `GET /api/logs`
- `GET /api/sponsored-logs/summary`
- `GET /api/sponsored-logs`
- `GET /api/pool`
- `GET /api/sponsor-refill-account/withdraw`
- `POST /api/sponsor-refill-account/withdraw`
- `GET /api/settlement-swap-paths`
- `GET /api/studio`
- `GET /api/promotions`
- `POST /api/promotions`
- `GET /api/promotions/:id`
- `PUT /api/promotions/:id`
- `POST /api/promotions/:id/status`
- `DELETE /api/promotions/:id`
- `GET /api/promotions/:id/users`
- `GET /api/promotions/:id/summary`

## MCP Boundary

Agent-facing tools are provided by `@stelis/mcp-server`, not by a separate `/agent/*` HTTP route group.

The MCP server calls the relay and promotion routes over HTTP.
