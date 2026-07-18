# @stelis/core-api

Framework-independent domain logic for Stelis relay, admin, and promotion features.

- Built for: maintainers and internal developers working on relay, admin, or promotion domain logic.
- Use for: framework-independent handlers, store adapters, rate limits, abuse checks, admin auth, and promotion logic.
- Not for: server startup, HTTP route mounting, API field reference text, or operator runbooks.

This package contains **pure business logic** with no HTTP framework dependencies.
Runtime Host wiring (Hono routes, env parsing, server boot) belongs in `app-api`.

## Subpath exports

| Path                      | Description                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `@stelis/core-api`        | Relay domain: handlers, context, stores, rate limiting, abuse blocking                    |
| `@stelis/core-api/admin`  | Admin auth (DI), Redis session, rate limiting, audit logging                              |
| `@stelis/core-api/studio` | Studio developer JWT verification, budget ledger, local store, allowed targets validation |

The table lists the primary entrypoints. The complete subpath export map is the `exports` field in [`packages/core-api/package.json`](./package.json).

## Usage

```ts
import { createHostContext, handlePrepare, handleSponsor } from '@stelis/core-api';
import { type AdminJwtConfig, signAdminJwt } from '@stelis/core-api/admin';
import { extractBearerToken, verifyDeveloperJwt } from '@stelis/core-api/studio';
```

## Framework-agnostic boundary policy

This package **must not** contain:

- `next` / `next/*` imports
- `process.env` reads (use DI parameters instead)
- HTTP framework code (Hono, Express, etc.)
- Server boot / port binding logic

All configuration is injected by the Host layer (app-api).

## Coordination adapters — Host-injected only

The `HostRuntimeConfig` type in [`src/context.ts`](./src/context.ts) is the
implementation authority. `createHostContext()` currently requires every
coordination adapter (`sponsorPool`, `sponsoredExecutionStore`,
`prepareRequestNonceStore`, `prepareInflightLimiter`, `rateLimiter`,
`abuseBlocker`) to be injected by the caller. There is
no in-memory runtime default: missing inputs fail closed at context
construction time. Production Hosts (`app-api`) inject the
Redis-backed adapters described in [`docs/operations.md → Sponsor Operations`](../../docs/operations.md#sponsor-operations). Memory
adapters (`MemorySponsoredExecutionStore`, `MemoryPrepareRequestNonceStore`,
`MemoryPrepareInflight`, `MemoryRateLimiter`, `MemoryAbuseBlocker`, in-memory `SponsorPool`)
remain in the source tree as test-only fixtures and are not exported
from this package's main barrel.

## Dependencies

- `@stelis/contracts` — shared request and response types, settlement swap direction tables, and contract IDs
- `@stelis/core-relay` — formulas, validation, PTB helpers, and server-side market policy helpers
- `jose` — JWT operations (admin auth)
- `redis` — Redis client (admin session/rate limiting stores)
- `@mysten/sui` (peer) — Sui SDK

Studio developer JWT base64url decoding is a private core-api implementation
detail in `src/studio/base64url.ts`. It is not exported from a package entrypoint.
