# @stelis/mcp-server

MCP server for agent clients using Stelis sponsored-transaction workflows.

This package exposes Stelis Host endpoints as Model Context Protocol tools. It is a sibling published product to `@stelis/sdk`; it does not import or wrap the SDK.

- Built for: agent runtimes and MCP clients that call a deployed Stelis Host.
- Use for: MCP tool schemas, request validation, Host endpoint calls, and the CLI entry.
- Not for: building user transactions, wallet custody, SDK APIs, Host runtime, or Host operations policy.

## Scope

Use this package when an agent runtime needs to:

- discover a deployed Stelis Host's Relay API capabilities
- prepare a sponsored transaction from caller-provided serialized `TransactionKind` bytes
- submit a wallet-signed transaction returned by prepare
- inspect and use promotion endpoints when a developer JWT is available

Stelis does not custody keys, sign for users, or build arbitrary Sui transactions in this MCP server. The caller must provide `txKindBytes` before prepare and a user signature before sponsor.
The caller-provided `txKindBytes` must satisfy the [User TransactionKind rules](../../docs/api.md#user-transactionkind-rules).
Generic `txKindBytes` may contain at most 11 commands. Promotion `txKindBytes` must contain 1 to 16 commands, all of them `MoveCall`; the MCP server forwards these opaque bytes and the Host enforces the policy.

## Install

```bash
npm install @stelis/mcp-server
```

## Run

```bash
stelis-mcp-server
```

Set a default Relay API endpoint with:

```bash
STELIS_RELAY_API_URL=https://your-host.example.com/relay stelis-mcp-server
```

Tools also accept `relayApiUrl`, which overrides `STELIS_RELAY_API_URL` for that call.

## Environment

| Variable                    | Required | Description                                                |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `STELIS_RELAY_API_URL`      | optional | Default Relay API endpoint, ending in `/relay`.            |
| `STELIS_REQUEST_TIMEOUT_MS` | optional | Default HTTP timeout in milliseconds. Defaults to `20000`. |

## Tool Model

The server uses this credential and signing model:

- capability discovery requires no credential
- generic prepare requires caller-provided `txKindBytes`, `senderAddress`, `settlementTokenType`, and prepare authorization fields signed by the sender wallet
- generic sponsor requires `receiptId`, exact prepared `txBytes`, and `userSignature`
- Studio promotion tools require a developer JWT and keep that credential request-local

Agents read `supportedSettlementSwapPaths` from `stelis_get_relay_api_config` and choose a `settlementTokenType` from that list. The Host has one active settlement swap path per `settlementTokenType`; MCP tools do not accept a pool ID or path ID.

The server never stores developer JWTs, user signatures, transaction bytes, or private keys.

## Studio Promotion Pages

`stelis_list_promotions` returns one deterministic page of active Promotions. It accepts an
optional `limit` from 1 through 100 and an optional canonical lowercase UUID-v4 `cursor`, such as
`00000000-0000-4000-8000-000000000001`. A non-null response `nextCursor` is the exclusive cursor
for the next call; `nextCursor: null` means the final page has been reached. The developer JWT
remains request-local and is sent only in the Host authorization header.

## Generic Tool Flow

1. Call `stelis_get_relay_api_config` and choose a `settlementTokenType` from `supportedSettlementSwapPaths`.
2. Build serialized `TransactionKind` bytes outside this MCP server. The bytes must satisfy the [User TransactionKind rules](../../docs/api.md#user-transactionkind-rules).
3. Ask the user wallet to sign the prepare authorization message described in [docs/api.md](../../docs/api.md#post-relayprepare).
4. Call `stelis_prepare_sponsored_transaction` with `txKindBytes`, `senderAddress`, `settlementTokenType`, `txKindBytesHash`, `prepareAuthorizationTimestampMs`, `prepareAuthorizationRequestNonce`, and `prepareAuthorizationSignature`.
5. Ask the user wallet to sign the returned `txBytes`.
6. Call `stelis_submit_signed_transaction` with the exact returned `txBytes`, `receiptId`, and `userSignature`.

## Host Errors

Current closed Host failures are returned to the tool caller with the
Host-provided `code`, HTTP `status`, and validated metadata. A malformed,
extended, or non-JSON remote error is a local `MCP_SERVER_ERROR`; its raw body
and arbitrary fields are not copied into MCP tool output.

The MCP server does not retry Host errors. Agent retry and backoff policy belongs to the caller. Capacity codes include `SPONSOR_CAPACITY_UNAVAILABLE`, `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`, `PREPARE_OVERLOADED`, `NO_SPONSOR_SLOT`, and `LEASE_EXPIRED`.
