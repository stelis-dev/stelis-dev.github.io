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
STELIS_RELAY_URL=https://your-host.example.com/relay stelis-mcp-server
```

Tools also accept `relayUrl`, which overrides `STELIS_RELAY_URL` for that call.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `STELIS_RELAY_URL` | optional | Default Relay API endpoint, ending in `/relay`. |
| `STELIS_REQUEST_TIMEOUT_MS` | optional | Default HTTP timeout in milliseconds. Defaults to `20000`. |

## Tool Model

The server follows the Stelis API agent tier model:

- capability discovery requires no credential
- generic prepare requires caller-provided `txKindBytes`, `senderAddress`, `settlementTokenType`, and prepare authorization fields signed by the sender wallet
- generic sponsor requires `receiptId`, exact prepared `txBytes`, and `userSignature`
- Studio promotion tools require a developer JWT and keep that credential request-local

Agents read `supportedSettlementSwapPaths` from `stelis_get_relay_config` and choose a `settlementTokenType` from that list. The Host has one active settlement swap path per `settlementTokenType`; MCP tools do not accept a pool ID or path ID.

The server never stores developer JWTs, user signatures, transaction bytes, or private keys.

## Generic Tool Flow

1. Call `stelis_get_relay_config` and choose a `settlementTokenType` from `supportedSettlementSwapPaths`.
2. Build serialized `TransactionKind` bytes outside this MCP server. The bytes must satisfy the [User TransactionKind rules](../../docs/api.md#user-transactionkind-rules).
3. Ask the user wallet to sign the prepare authorization message described in [docs/api.md](../../docs/api.md#post-relayprepare).
4. Call `stelis_prepare_sponsored_transaction` with `txKindBytes`, `senderAddress`, `settlementTokenType`, `txKindBytesHash`, `prepareAuthorizationTimestampMs`, `prepareAuthorizationRequestNonce`, and `prepareAuthorizationSignature`.
5. Ask the user wallet to sign the returned `txBytes`.
6. Call `stelis_submit_signed_transaction` with the exact returned `txBytes`, `receiptId`, and `userSignature`.

## Host Errors

Host failures are returned to the tool caller with the Host-provided `code`, HTTP `status`, and response `body`.

The MCP server does not retry Host errors. Agent retry and backoff policy belongs to the caller. Capacity codes include `SPONSOR_CAPACITY_UNAVAILABLE`, `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`, `PREPARE_OVERLOADED`, `NO_SPONSOR_SLOT`, and `LEASE_EXPIRED`.
