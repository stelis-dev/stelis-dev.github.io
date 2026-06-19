# Stelis

Stelis is a settlement layer for token-funded transaction execution on Sui.

SUI remains the execution fuel; the user's held value becomes the settlement source.

Across blockchains, the long-running UX problem is not that users lack value. It is that value and execution are often coupled through a native gas token. A wallet, app, service, or agent may hold stablecoins, protocol tokens, or vault credit, but still be unable to act until the required gas asset is available.

Stelis separates those concerns. On Sui, transactions still execute with SUI gas, while their cost can be settled from a supported payment token or from user-owned vault credit.

This matches how payment systems normally feel: processing costs are part of settlement, not a second currency the payer must acquire before every action. Sui already points in this direction with gasless stablecoin transfers. Stelis extends the same settlement framing beyond transfers to app actions, service actions, and agent actions that need programmable execution.

Payment-token support is explicit. A host configures settlement-ready assets with viable SUI settlement swap paths, live liquidity, and host policy. That keeps the model broad across token assets while preserving operational control.

Stelis uses Sui primitives to make the model concrete. Programmable Transaction Blocks compose the user action and settlement path in one execution flow. Sponsored gas separates the sender from the gas payer. Object ownership keeps vault credit user-owned.

A Stelis relay is an execution host for the settlement model. It sponsors only transactions bound to settlement expectations, submits them with SUI gas, and verifies settlement after execution.

User vaults are user-owned settlement sources, not relayer balances. They preserve the user's asset boundary while giving wallets, apps, services, and agents a reusable way to turn held value into execution capacity.

The product surfaces are a TypeScript SDK for apps and services, an MCP server for agent clients, a deployable relay API host for operators, public and admin web apps, and the on-chain Move package.

## Product Entry Points

| Need | Start here | What it is |
| --- | --- | --- |
| Build a dApp or service integration | [`@stelis/sdk`](./packages/sdk/README.md) | Published TypeScript SDK for app and service developers |
| Connect an agent runtime | [`@stelis/mcp-server`](./packages/mcp-server/README.md) | Published Model Context Protocol (MCP) server for agent clients |
| Run the relay and admin API | [`@stelis/app-api`](./packages/app-api/README.md) | Deployable API host for relay, auth, admin, and promotion routes |
| Run the demo web app | [`@stelis/app-web`](./packages/app-web/README.md) | Deployable static demo app for docs, status, playground, and sandbox flows |
| Run the admin web app | [`@stelis/app-admin`](./packages/app-admin/README.md) | Deployable static admin app for host operators |
| Review or build the Move package | [`packages/contracts/move`](./packages/contracts/move/README.md) | On-chain Move package |

## Documentation

Start with the [documentation map](./docs/index.md).

For user transaction constraints, see [User TransactionKind rules](./docs/api.md#user-transactionkind-rules) and [relay invariants](./docs/invariants.md#relay-policy).

For the package layout, product package policy, and dependency rules, see [repository structure](./docs/repository-structure.md).

## Script Responsibility

Repository-root scripts are for local development, repository checks, and local verification builds.
They are not deployment entrypoints.

Package scripts define each package's own runtime contract:

- `npm run dev:app-api`, `npm run dev:app-web`, and `npm run dev:app-admin`
  are root-level local development helpers. `dev:app-api` always starts an isolated Redis
  memory server for the API host.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run release:check`, and `npm run build`
  are repository verification commands.
- Package `build` scripts create package artifacts.
- Package `start` scripts, where present, run compiled package artifacts and expect environment values
  from the shell, container, or deployment platform.

Platform deployment commands belong in the platform configuration that deploys a product package.
Do not treat root `dev:*` scripts as deployment commands.

## Package Policy

Workspace packages are allowed when they make development safer and clearer. They are not automatically public products.

Published or deployed product packages are limited to one package per product entry point:

- `@stelis/sdk`
- `@stelis/mcp-server`
- `@stelis/app-api`
- `@stelis/app-web`
- `@stelis/app-admin`
- `packages/contracts/move`

Internal packages stay private and hold shared implementation rules:

- `@stelis/contracts`
- `@stelis/core-relay`
- `@stelis/core-api`

The SDK and MCP server are separate products. They must not import or wrap each other.
