# Getting Started

This document gives the current local starting path for running the repository.

It describes only commands and files currently present in this repository.

## Choose Your Starting Path

| Reader | Start here |
| --- | --- |
| App or service developer | [`packages/sdk/README.md`](../packages/sdk/README.md) |
| Agent runtime integrator | [`packages/mcp-server/README.md`](../packages/mcp-server/README.md), then [`api.md → User TransactionKind rules`](./api.md#user-transactionkind-rules) |
| Host operator | [`packages/app-api/README.md`](../packages/app-api/README.md), [`operations.md`](./operations.md), and [`parameters.md`](./parameters.md) |
| Web app operator | [`packages/app-web/README.md`](../packages/app-web/README.md) or [`packages/app-admin/README.md`](../packages/app-admin/README.md) |
| Contract reviewer | [`packages/contracts/move/README.md`](../packages/contracts/move/README.md), then [`invariants.md`](./invariants.md) |

For the full documentation map, use [`index.md`](./index.md).

## Script Responsibility

Use repository-root scripts for local development and repository checks. Do not use root `dev:*`
scripts as deployment commands.

Use package `build` and `start` scripts, or platform-specific deployment configuration, for deployed
product packages.

## Install

```bash
npm install
```

## Build

```bash
VITE_STELIS_RELAY_API_URL=http://localhost:3200/relay \
VITE_STELIS_API_URL=http://localhost:3200 \
npm run build
```

## Run Tests

```bash
npm test
```

## Run Repository Checks

```bash
npm run lint
npm run typecheck
npm run check:prepare-stage-schema
```

## Run the API Host

Create the local env file:

```bash
cp packages/app-api/.env.example packages/app-api/.env
```

Fill in real values in `.env`. `packages/app-api/settlement-swap-paths.json` and `packages/app-api/rpc.json` are tracked config files; confirm the section selected by `NETWORK` has the pool IDs and RPC endpoints for that network.

Start the Host:

```bash
npm run dev:app-api
```

The root `dev:app-api` command loads `packages/app-api/.env`, starts an isolated Redis
memory server through `redis-memory-server`, sets `REDIS_URL` for the child process, and then
starts the Host. Local development does not use Docker Redis or an external Redis service.

## Run Web Apps

Create local config files:

```bash
cp packages/app-web/.env.example packages/app-web/.env
cp packages/app-admin/.env.example packages/app-admin/.env
```

Use values that point at the local Host.

```bash
npm run dev:app-web
npm run dev:app-admin
```

## Next Documents

- [`api.md`](./api.md)
- [`operations.md`](./operations.md)
- [`repository-structure.md`](./repository-structure.md)
