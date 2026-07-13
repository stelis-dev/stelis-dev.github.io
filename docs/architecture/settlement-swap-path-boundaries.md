# Settlement Swap Path Boundaries

This document describes current settlement swap path configuration and package boundaries.

## Settlement Swap Path Configuration

`@stelis/app-api` reads `packages/app-api/settlement-swap-paths.json` at boot.

The file is a network-keyed object with `testnet` and `mainnet` sections. At boot, the Host reads only the section selected by `NETWORK`. For each pool ID in that section, the Host derives settlement swap path details from on-chain data. The server fails to start if the selected section is empty, malformed, nested, duplicated by settlement token, not SUI-adjacent, or cannot be verified.

The shipped Stelis contract IDs currently exist only for testnet. Selecting
`mainnet` therefore fails closed before the Host starts, even though the
registry retains a mainnet section for the network-shaped configuration. A
mainnet Host requires a fresh Stelis Move package deployment and current
mainnet package, config, and vault IDs.

The product contract is one active one-hop settlement swap path per `settlementTokenType`. Clients choose `settlementTokenType`; they do not send a pool ID, path ID, or multi-hop path. The Host registry is the source of truth for the selected pool ID and swap direction.

## Runtime Capability

Clients use `GET /relay/config` to discover:

- network
- package ID
- settlement payout recipient
- supported settlement swap paths
- quoted host fee
- protocol flat fee

## Package Boundaries

The SDK and MCP server are separate product packages. They do not import each other.

Internal packages are private workspace packages:

- `@stelis/contracts`
- `@stelis/core-relay`
- `@stelis/core-api`

See [`repository-structure.md`](../repository-structure.md) for the full dependency direction.
