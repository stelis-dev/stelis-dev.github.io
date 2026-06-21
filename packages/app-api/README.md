# @stelis/app-api

Deployable Host API for sponsoring Sui transactions and enforcing settlement policy. It runs as a Hono server with Relay API, auth, admin, and promotion endpoints.

- Built for: Host operators deploying the provided Host runtime, plus maintainers changing it.
- Use for: running the Relay API, admin API, auth routes, and promotion routes.
- Not for: SDK integration guidance, full route field definitions, or contract deployment.

## Start Here

Use this package when you operate the Host itself.
External Host operators deploy this package as shipped.
Changing `app-api`, `core-*`, `sdk`, or contract source code is a maintainer-only workflow.
This Host runtime does not publish or upgrade contracts. After contracts are deployed or updated, the Host only uses the package, config, and vault IDs provided by the shipped code and docs.

- Host Operator: start with [docs/getting-started.md](../../docs/getting-started.md), then [docs/operations.md](../../docs/operations.md).
- Promotion operator: start with [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations).
- API route and field reference: [docs/api.md](../../docs/api.md).
- User transaction constraints: [docs/api.md → User TransactionKind rules](../../docs/api.md#user-transactionkind-rules).

This README is an entry point for the package. It does not replace the route and field reference in `docs/api.md`.

## Mounted Endpoints

| Prefix      | Purpose                                                                                           | Primary audience                              |
| ----------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `/health`   | Root health probe returning `{ status: 'ok', mode }`                                              | Container/runtime health checks               |
| `/relay/*`  | Public Relay API endpoints: status, config, prepare, sponsor                                      | SDK consumers, Host Operators                 |
| `/studio/*` | Studio endpoints: developer JWT verification, promotion discovery/claim, promotion prepare/sponsor | Studio Operators, trusted backend integrators |
| `/auth/*`   | Admin session authentication (nonce, verify, renew, logout, session)                              | Operators using `app-admin`                   |
| `/api/*`    | Admin dashboard, sponsor pool operations, blocklist, auth audit, studio status, promotions        | Operators using `app-admin`                   |

## Runtime Role

`@stelis/app-api` wires together:

- `@stelis/core-api` domain handlers
- Host-level env validation and boot flow
- Redis-backed runtime state for prepare records, rate limiting, admin sessions, and studio budget state
- CORS and route mounting for public relay traffic and admin/studio endpoints

## Quick Start

From the repository root:

```bash
cp packages/app-api/.env.example packages/app-api/.env
```

`settlement-swap-paths.json` and `rpc.json` are tracked config files keyed by `testnet` and `mainnet`.
The Host reads only the section selected by `NETWORK`.

Start this package:

```bash
npm run dev:app-api
```

The root `dev:app-api` command loads `packages/app-api/.env`, starts an isolated Redis
memory server through `redis-memory-server`, sets `REDIS_URL` for the child process, and then
starts this package. Local development does not use Docker Redis or an external Redis service.

## Runtime Scripts

Local development uses repository-root helper commands:

```bash
npm run dev:app-api
```

Those root `dev:*` commands are local development helpers. They are not deployment commands.

Compiled Node execution uses package commands:

```bash
npm run build -w @stelis/app-api
npm run start -w @stelis/app-api
```

The package `start` command runs `node dist/index.js`. It does not load `.env` and does not start Redis. The runtime environment must provide a real Redis `REDIS_URL` and the other required environment variables.

For deployed Node Hosts, build this package and its internal package dependencies from the repository root:

```bash
npm run build:app-api:deploy
npm run start -w @stelis/app-api
```

The standard deployment model is a long-running Node process or OCI container that runs the package `start` command. Use that model for stable deployments.

## Temporary Vercel Demo Adapter

This repository also includes a temporary root `index.js` entry point for Vercel testnet demos. It re-exports the compiled Hono app from `packages/app-api/dist/vercel.js`.

Vercel runs that entry point as a function, not as the long-running Node server used by `npm run start -w @stelis/app-api`. Background behavior such as sponsor refill work is not guaranteed to stay active between requests.

This is not a serverless-native Host runtime. It still uses the normal Host boot path, Redis dependency, and Sui RPC validation when a function instance starts.

For this temporary Vercel path, set `TRUSTED_PROXY_HOPS=0`. The Vercel adapter supplies the client public IP from Vercel's overwritten `x-forwarded-for` header as the Host's direct client-IP source. Do not use a guessed proxy-hop count for Vercel.

Use Vercel only as a temporary demo path. Move stable API hosting to Cloud Run or another long-running Node/OCI host, then remove the root `index.js` file, `packages/app-api/src/vercel.ts`, and `packages/app-api/src/vercelClientIp.ts`.

For a full local Host bring-up, follow [docs/getting-started.md](../../docs/getting-started.md).
For operator policy, sponsor management, Studio mode, and incident handling, use [docs/operations.md](../../docs/operations.md).

## Related Documents

- [docs/api.md](../../docs/api.md) - current relay and studio route reference
- [docs/api.md → User TransactionKind rules](../../docs/api.md#user-transactionkind-rules) - generic prepare transaction constraints
- [docs/getting-started.md](../../docs/getting-started.md) - Host entry path
- [docs/operations.md](../../docs/operations.md) - baseline Host Operator runbook
- [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations) - Studio Operator runbook section
- [docs/repository-structure.md](../../docs/repository-structure.md) - package dependency map
