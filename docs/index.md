# Stelis Documentation Map

This page shows where to start in the current repository documentation.

The docs are kept small on purpose. A document is added only when its content has been checked against the current code.

## Start Here

| Reader | Start with | Then |
| --- | --- | --- |
| App or service developer | [`@stelis/sdk`](../packages/sdk/README.md) | [`@stelis/app-web`](../packages/app-web/README.md) for the public web app |
| Agent runtime integrator | [`@stelis/mcp-server`](../packages/mcp-server/README.md) | [`@stelis/sdk`](../packages/sdk/README.md) only if you are also building an app integration |
| Host operator | [`@stelis/app-api`](../packages/app-api/README.md) | [`@stelis/app-admin`](../packages/app-admin/README.md) |
| Contract reviewer | [`packages/contracts/move`](../packages/contracts/move/README.md) | [`@stelis/contracts`](../packages/contracts/README.md) |
| Repository maintainer | [`repository-structure.md`](./repository-structure.md) | Package README files under `packages/` |

## Product Packages

| Product package | Purpose |
| --- | --- |
| [`@stelis/sdk`](../packages/sdk/README.md) | TypeScript SDK for app and service developers |
| [`@stelis/mcp-server`](../packages/mcp-server/README.md) | Model Context Protocol (MCP) server for agent clients |
| [`@stelis/app-api`](../packages/app-api/README.md) | Host runtime for Relay API, auth, admin, and promotion HTTP APIs |
| [`@stelis/app-web`](../packages/app-web/README.md) | Public static web app |
| [`@stelis/app-admin`](../packages/app-admin/README.md) | Admin static web app |
| [`packages/contracts/move`](../packages/contracts/move/README.md) | On-chain Move package |

## Internal Packages

These packages are private workspace packages. They exist to keep shared code in one place.

| Internal package | Purpose |
| --- | --- |
| [`@stelis/contracts`](../packages/contracts/README.md) | Contract IDs, shared request and response types, settlement swap direction data, and data shared with Move contracts |
| [`@stelis/core-relay`](../packages/core-relay/README.md) | Transaction validation, pricing, settlement swap path checks, and transaction-building helpers |
| [`@stelis/core-api`](../packages/core-api/README.md) | Server-side domain logic for prepare, sponsor, admin, promotion, stores, and abuse controls |

## Main Documents

| Topic | Document |
| --- | --- |
| Package layout and dependency rules | [`repository-structure.md`](./repository-structure.md) |
| HTTP routes | [`api.md`](./api.md) |
| User TransactionKind constraints | [`api.md → User TransactionKind rules`](./api.md#user-transactionkind-rules) and [`invariants.md → Relay Policy`](./invariants.md#relay-policy) |
| SDK, MCP, and promotion integration | [`integration.md`](./integration.md) |
| Product terms and payment flows | [`payment-platform.md`](./payment-platform.md) |
| Contract and relay rules | [`invariants.md`](./invariants.md) |
| Security boundaries | [`security.md`](./security.md) |
| Public parameters and environment variables | [`parameters.md`](./parameters.md) |
| Cost formulas | [`economics-formal.md`](./economics-formal.md) |
| Host operation | [`operations.md`](./operations.md) |
| Architecture map | [`architecture.md`](./architecture.md) |

## Architecture Detail

- [`architecture/onchain-settlement.md`](./architecture/onchain-settlement.md)
- [`architecture/pricing-and-validation.md`](./architecture/pricing-and-validation.md)
- [`architecture/settlement-swap-path-boundaries.md`](./architecture/settlement-swap-path-boundaries.md)
- [`architecture/sponsor-pools.md`](./architecture/sponsor-pools.md)
- [`architecture/prepare-sponsor-session.md`](./architecture/prepare-sponsor-session.md)

## Documentation Rules

- Use clear words that a new reader can understand.
- Define product terms before using them as labels.
- Do not use internal shorthand in public docs unless the shorthand is also a code field or package name.
- If docs and code disagree, treat the code as the current behavior until the mismatch is reviewed.
- Do not publish docs for examples, scripts, or audit workflows before the matching files exist in this repository.
