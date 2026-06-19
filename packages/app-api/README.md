# @stelis/app-api

Stelis API host - Hono server for relay, auth, admin, and promotion endpoints.

- Built for: host operators deploying the provided HTTP host, plus maintainers changing it.
- Use for: running the relay API, admin API, auth routes, and promotion routes.
- Not for: SDK integration guidance, full route field definitions, or contract deployment.

## Start Here

Use this package when you operate the HTTP host itself.
External host operators deploy this package as shipped.
Changing `app-api`, `core-*`, `sdk`, or contract source code is a maintainer-only workflow.
This host runtime does not publish or upgrade contracts. After contracts are deployed or updated, the host only uses the package, config, and vault IDs provided by the shipped code and docs.

- Host Operator: start with [docs/getting-started.md](../../docs/getting-started.md), then [docs/operations.md](../../docs/operations.md).
- Promotion operator: start with [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations).
- API route and field reference: [docs/api.md](../../docs/api.md).
- User transaction constraints: [docs/api.md → User TransactionKind rules](../../docs/api.md#user-transactionkind-rules).

This README is an entry point for the package. It does not replace the route and field reference in `docs/api.md`.

## Mounted Endpoints

| Prefix      | Purpose                                                                                           | Primary audience                              |
| ----------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `/health`   | Root health probe returning `{ status: 'ok', mode }`                                              | Container/runtime health checks               |
| `/relay/*`  | Public relay endpoints: status, config, prepare, sponsor                                          | SDK consumers, Host Operators                 |
| `/studio/*` | Studio endpoints: developer JWT verification, promotion discovery/claim, promotion prepare/sponsor | Studio Operators, trusted backend integrators |
| `/auth/*`   | Admin session authentication (nonce, verify, renew, logout, session)                              | Operators using `app-admin`                   |
| `/api/*`    | Admin dashboard, sponsor pool operations, blocklist, auth audit, studio status, promotions        | Operators using `app-admin`                   |

## Runtime Role

`@stelis/app-api` wires together:

- `@stelis/core-api` domain handlers
- host-level env validation and boot flow
- Redis-backed runtime state for prepare records, rate limiting, admin sessions, and studio budget state
- CORS and route mounting for public relay traffic and admin/studio endpoints

## Quick Start

From the repository root:

```bash
cp packages/app-api/.env.local.example packages/app-api/.env.local
cp packages/app-api/settlement-swap-paths.json.example packages/app-api/settlement-swap-paths.json
cp packages/app-api/rpc.json.example packages/app-api/rpc.json
```

Start this package:

```bash
npm run dev:app-api
```

The root `dev:app-api` command loads `packages/app-api/.env.local`, starts an isolated Redis
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

The package `start` command runs `node dist/index.js`. It does not load `.env.local` and does not start Redis. The runtime environment must provide a real Redis `REDIS_URL` and the other required environment variables.

This repository currently has no Vercel, Cloud Run, Dockerfile, or other platform deployment entrypoint. Platform deployment commands belong in the platform configuration that deploys this package.

For a full local self-hosted bring-up, follow [docs/getting-started.md](../../docs/getting-started.md).
For operator policy, sponsor management, Studio mode, and incident handling, use [docs/operations.md](../../docs/operations.md).

## Related Documents

- [docs/api.md](../../docs/api.md) - current relay and studio route reference
- [docs/api.md → User TransactionKind rules](../../docs/api.md#user-transactionkind-rules) - generic prepare transaction constraints
- [docs/getting-started.md](../../docs/getting-started.md) - self-hosted entry path
- [docs/operations.md](../../docs/operations.md) - baseline Host Operator runbook
- [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations) - Studio Operator runbook section
- [docs/repository-structure.md](../../docs/repository-structure.md) - package dependency map
