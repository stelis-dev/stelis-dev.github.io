# Settlement Swap Path Boundaries

This document describes current settlement swap path configuration and package boundaries.

## Settlement Swap Path Configuration

`@stelis/app-api` reads `packages/app-api/settlement-swap-paths.json` at boot.

The file is a network-keyed object with `testnet` and `mainnet` sections. At boot, the host reads only the section selected by `NETWORK`. For each pool ID in that section, the host derives settlement swap path details from on-chain data. The server fails to start if the selected section is empty, malformed, nested, duplicated by payment token, not SUI-adjacent, or cannot be verified.

The product contract is one active one-hop settlement swap path per `paymentTokenType`. Clients choose `paymentTokenType`; they do not send a pool ID, path ID, or multi-hop path. The host registry is the source of truth for the selected pool ID and swap direction.

## Runtime Capability

Clients use `GET /relay/config` to discover:

- network
- package ID
- relayer settlement payout recipient
- supported settlement swap paths
- quoted relayer fee
- protocol flat fee
- integrity policy version

## Package Boundaries

The SDK and MCP server are separate product packages. They do not import each other.

Internal packages are private workspace packages:

- `@stelis/contracts`
- `@stelis/core-relay`
- `@stelis/core-api`

See [`repository-structure.md`](../repository-structure.md) for the full dependency direction.
