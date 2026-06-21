# Operations

This document describes current Host operation facts that are supported by the code in this repository.

## Baseline Host Operation

The Host package is `@stelis/app-api`.

Required local files:

- `packages/app-api/.env`
- `packages/app-api/settlement-swap-paths.json`
- `packages/app-api/rpc.json`

Ignored local runtime files must not be committed.

## RPC Fleet Configuration

RPC endpoints are configured in `packages/app-api/rpc.json`, not in environment variables.

The file is a network-keyed object with `testnet` and `mainnet` endpoint arrays. At boot, the Host reads only the section selected by `NETWORK`, validates those endpoints against the selected network, checks required object and coin metadata reads, and probes transaction simulation support. Endpoints that fail verification are excluded. If the selected section is empty or no usable endpoint remains, boot fails.

## Reverse Proxy and CORS

`TRUSTED_PROXY_HOPS` controls how the Host reads `X-Forwarded-For` for rate limiting and abuse checks.

In deployed runtimes, `TRUSTED_PROXY_HOPS` must be set explicitly before the Host starts. Use `TRUSTED_PROXY_HOPS=0` only when the API is directly exposed, or set it to the actual reverse-proxy hop count.

The temporary Vercel demo adapter is an exception to the proxy-hop model. Vercel overwrites `x-forwarded-for` with the client public IP, and `packages/app-api/src/vercel.ts` installs an adapter-local source provider before the Host app is created. For that temporary Vercel path, set `TRUSTED_PROXY_HOPS=0`; do not set a guessed proxy-hop count.

In `development` and `test`, an unset `TRUSTED_PROXY_HOPS` defaults to `0` and uses the socket remote address.

`/relay/*` and `/studio/*` allow all origins. `/auth/*` and `/api/*` allow only origins listed in `CORS_ORIGINS`.

## On-Chain Admin Updates

On-chain admin updates use a queue and apply flow.

Emergency pause to `true` is immediate and admin-only. Unpause is queued through `set_paused(config, false, ctx)` and applies only after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`.

Config and treasury changes are also queued first:

- `update_config(...)` queues economic config changes.
- `update_protocol_treasury(...)` queues the protocol treasury change.
- `set_paused(config, false, ctx)` queues unpause.

Queued updates become eligible at `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`. `ADMIN_UPDATE_DELAY_EPOCHS` is `2`.

Only admin can propose or cancel queued config, treasury, and pause updates. After maturity, any caller can apply the exact queued values with the matching `apply_*` function.

`config_version` increments when protocol state changes through an applied queued update, when emergency pause changes the pause state, or when emergency pause cancels a pending unpause.

## Production Store Adapters

`@stelis/app-api` wires Redis-backed adapters for prepare records, prepare in-flight limits, rate limits, abuse blocking, sponsor pool leasing, admin sessions, and Studio state.

Memory adapters remain test fixtures. They are not runtime defaults for the deployable Host.

Default Redis namespaces are owned by their adapter modules:

| Namespace | Runtime state |
| --- | --- |
| `stelis:prepare:` | Prepared transaction records and prepare indexes. |
| `stelis:inflight:slots` | Shared prepare in-flight limiter. |
| `stelis:rate_limit:` | Fixed-window request counters. |
| `stelis:abuse:` | Abuse counters and temporary blocks. |
| `stelis:sponsor_lease:` | Sponsor slot leases. |
| `stelis:app-api:sponsor-operations:` | Sponsor slot health, sponsor refill account health, and sponsor operations locks. |
| `stelis:sponsored_logs:` | Sponsored execution aggregate and recent entries read by admin routes. |
| `stelis:promo:` | Promotion records and promotion indexes. |
| `stelis:promo:usage` | Promotion usage-event records. |
| `stelis:promotion_execution_ledger:` | Promotion claims, entitlements, budgets, and reservations. |
| `stelis:app-api:admin:not_before` | Admin session invalidation timestamp. |

## Redis Deployment Topology

Every `@stelis/app-api` instance in one deployment must use the same logical Redis write authority. Redis is the coordination store for prepare records, prepare in-flight admission, rate limits, abuse blocks, sponsor slot leases, sponsor operation state, refill locks, admin sessions, and Studio state.

Required Redis topology:

- `REDIS_URL` points to one writable Redis data endpoint that reports `redis_mode:standalone` from `INFO server`.
- Managed failover support requires a provider endpoint that keeps one write authority and reports `redis_mode:standalone`.
- All `app-api` instances in the deployment use that same endpoint.

Rejected Redis topology:

- Direct Redis Cluster endpoints.
- Direct Redis Sentinel endpoints.
- Instance-specific Redis databases, region-specific Redis databases, or split keyspaces for one sponsor account set.
- Replica reads for admission, signing, refill dispatch, abuse decisions, admin sessions, or Studio budget decisions.

At boot, `@stelis/app-api` probes `INFO server` through `REDIS_URL`. If Redis does not report `redis_mode:standalone`, or if the topology cannot be probed, the Host fails closed before it accepts requests. The boot flow also writes the admin `not_before` key, so a read-only endpoint fails before startup completes.

This policy matches current Redis key usage. Prepare store consumption uses Lua dynamic key access. Sponsor slot leasing, sponsor operation reads, refill locks, and Studio ledgers rely on one authoritative write path for their keys.

## Sponsor Operations

Sponsor operation state is checked before prepare and sponsor routes continue.

Sponsor SUI ownership, refill transitions, sponsor slot gas use, and Sponsor Refill Account withdrawal are defined in [`Sponsor Pools`](./architecture/sponsor-pools.md#sponsor-sui-state).

The prepare in-flight limiter is Redis-backed and shared across all `app-api` instances that use the same Redis write authority. It limits concurrent expensive
prepare work after cheap request validation and before build/simulation work completes.
When `PREPARE_INFLIGHT_CAPACITY` is not set, the Host uses `sponsor slot count * 2`.
`SPONSOR_SECRET_KEY` supports 1..256 comma-separated sponsor keys. Boot rejects deployments outside that range.

### Sponsor Capacity Policy

Prepare capacity is enforced by the shared Redis write authority.

Prepare admission uses these gates in order:

1. Sponsor operation state and sponsor slot leases are read from Redis.
2. The request is rejected with `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` when no healthy sponsor slot remains and the sponsor refill account is unhealthy.
3. The request is rejected with `SPONSOR_CAPACITY_UNAVAILABLE` when no healthy sponsor slot remains or every healthy sponsor slot is already leased.
4. IP abuse and rate-limit checks run after the sponsor capacity gate.
5. `RedisPrepareInflight` reserves one in-flight prepare slot before chain reads, build, and simulation.
6. A full in-flight limiter rejects prepare with `PREPARE_OVERLOADED` and `Retry-After: 2`.
7. Sponsor slot checkout failure after in-flight admission rejects prepare with `NO_SPONSOR_SLOT`.

Sponsor submission does not require a free sponsor slot. Sponsor submission completes an existing prepared receipt and uses the sponsor operation health gate only.

Capacity-related retry contract:

| Code | HTTP status | Retry guidance |
| --- | ---: | --- |
| `SPONSOR_CAPACITY_UNAVAILABLE` | 503 | Retry after sponsor capacity recovers. |
| `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` | 503 | Retry after sponsor capacity recovers; operators inspect refill account health. |
| `PREPARE_OVERLOADED` | 503 | Retry after the `Retry-After` header. |
| `NO_SPONSOR_SLOT` | 422 | Retry prepare. |

Capacity alert thresholds:

| Signal | Alert condition |
| --- | --- |
| Free healthy sponsor slots | `0` for `60s`. |
| Prepare in-flight utilization | `>= 90%` of `PREPARE_INFLIGHT_CAPACITY` or the default capacity for `60s`. |
| `SPONSOR_CAPACITY_UNAVAILABLE` responses | Greater than `0` for `60s`. |
| `PREPARE_OVERLOADED` responses | Greater than `0` for `60s`. |

Sponsor slot scan policy:

- The current Redis implementation keeps O(sponsor slot count) Lua scans for sponsor slot checkout, sponsor slot lease status, and sponsor operation state reads.
- The supported sponsor slot count is capped at 256 so those scans stay inside the current capacity target.
- Checkout, lease status, and sponsor operation state reads stay within one Redis `EVAL` over at most 256 sponsor slots.
- `/api/sponsor-operations` returns a per-slot admin snapshot and reads every configured sponsor slot.
- Deployments with more than 256 sponsor slots are rejected at boot instead of running outside the supported scan bound.

Required timeout variables:

- `SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS`

Optional refill variables:

- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

`HOST_FEE_MIST` is optional. When unset, the quoted host fee defaults to zero.
`PREPARE_INFLIGHT_CAPACITY` is optional. When set, it must be a positive integer and becomes the shared prepare in-flight capacity for one Redis write authority.

Sponsor operation state is shared through Redis. Slot state is keyed as `stelis:app-api:sponsor-operations:slot:<address>` and sponsor refill account state is keyed as `stelis:app-api:sponsor-operations:sponsor-refill-account`.

Refill workers use Redis locks for cross-instance coordination. `stelis:app-api:sponsor-operations:refill-lock:<slotAddress>` protects one sponsor slot refill lifecycle. `stelis:app-api:sponsor-operations:sponsor-refill-account-dispatch-lock:<address>` protects refill transaction dispatch for one Sponsor Refill Account, so multiple API instances do not use the same Sponsor Refill Account signer concurrently.

State writers use Redis server time for `lastObservedAtMs` and a per-entity `writeSeq`. This keeps cross-instance ordering independent of local host clock skew.

## Studio Mode Operations

Studio promotion routes are available when the Host boots with all required Studio configuration:

- `ADMIN_JWT_SECRET`
- `ADMIN_ADDRESS`
- `STUDIO_ALLOWED_TARGETS`
- `STUDIO_DEVELOPER_JWT_TRUST_JSON`

`STUDIO_DEVELOPER_JWT_VERIFY_URL` is optional.

When these variables are present, the Host runs in dual mode: generic relay routes and Studio promotion routes are both active. Without the complete Studio configuration, the Host runs the generic relay routes only.

`STUDIO_ALLOWED_TARGETS` is a comma-separated list of `package::module::function` entries. Boot validation rejects an empty list, malformed entries, and duplicates after canonicalization. The Host precomputes target hashes and promotion prepare/sponsor requests must match those targets.

`STUDIO_DEVELOPER_JWT_TRUST_JSON` is a single trusted issuer definition. The verifier supports `RS256` and `ES256`, checks issuer, audience, signature, expiry, optional `iat`/`nbf`, and extracts `userId` plus `senderAddress` from configured claim paths. If `STUDIO_DEVELOPER_JWT_VERIFY_URL` is set, the Host calls it after local JWT verification succeeds.

Promotion execution uses Redis-backed promotion records, usage-event records, and the promotion execution ledger. The ledger reserves gas allowance at promotion prepare time, then consumes or releases the reservation at promotion sponsor time. Ledger settings are listed in [`TTL Constants`](./parameters.md#ttl-constants) and [`Studio Ledger Limits`](./parameters.md#studio-ledger-limits).

## Admin Operations

`@stelis/app-admin` uses `/auth/*` for admin sessions and `/api/*` for operator actions.

Admin dashboard operation requires `ADMIN_ADDRESS` and `ADMIN_JWT_SECRET`.

Optional admin settings:

- `ADMIN_SESSION_EXPIRY`
- `COOKIE_DOMAIN`

Boot validation requires `ADMIN_JWT_SECRET` to be at least 32 characters when it is configured. If `ADMIN_ADDRESS` is configured, the sponsor refill account address must be different from the admin address.

<a id="settlement-token-onboarding-procedure"></a>

## Settlement Token Onboarding Procedure

Settlement swap path support is controlled by `packages/app-api/settlement-swap-paths.json`.

The file is a network-keyed object with `testnet` and `mainnet` sections. The Host reads only the section selected by `NETWORK`:

```json
{
  "testnet": [
    "0x..."
  ],
  "mainnet": [
    "0x..."
  ]
}
```

At boot, the Host reads each pool ID in the active network section and derives settlement swap path metadata from on-chain data. Each pool must be `Pool<Token, SUI>` or `Pool<SUI, Token>`, so every configured entry resolves to one settlement-token-to-SUI settlement swap path.

The product contract is one active 1-hop settlement swap path per `settlementTokenType`. `POST /relay/prepare` receives `settlementTokenType` and the Host selects that token's registered path. Clients do not send a pool ID, path ID, or multi-hop path.

If the file is missing, the selected network section is empty, or an entry is malformed, nested, duplicated by settlement token, not SUI-adjacent, or cannot be verified, the Host fails to start.

## Observability

The prepare build pipeline emits structured stage logs from `packages/core-api/src/prepare/build.ts`.

The current detailed prepare stage list is documented in [`architecture/prepare-sponsor-session.md`](./architecture/prepare-sponsor-session.md).

The runtime event-name list is owned by [`packages/core-api/src/observability/events.ts`](../packages/core-api/src/observability/events.ts).

Current structured event families:

| Family | Representative events |
| --- | --- |
| Prepare pipeline | `PREPARE_STAGE`, `PREPARE_BUILD_STAGE`, `PREPARE_INFLIGHT_REJECTED`, `PREPARE_ENTRY_CORRUPT`, `PREPARE_SLOT_EXHAUSTED` |
| Sponsor runtime | `SPONSOR_FAILURE_RECORDED`, `SPONSOR_DRIFT_OBSERVED`, `SETTLEMENT_ECONOMICS_EXECUTION` |
| Sponsor pool and sponsor operations | `SPONSOR_POOL_LEASE_CHECKOUT`, `SPONSOR_POOL_LEASE_COMMITTED`, `SPONSOR_POOL_LEASE_RELEASE_FAILED`, `SPONSOR_RESULT_CALLBACK_FAILED`, `SPONSOR_OPERATIONS_STATE_WRITE_FAILED` |
| Sponsored execution logs | `SPONSORED_LOGS_RECORDER_FAILED` |
| Studio promotion | `PROMOTION_ABUSE_RECORDED`, `PROMOTION_SPONSOR_EXECUTION`, `PROMOTION_LEDGER_CONSUME_FAILED`, `PROMOTION_SPONSOR_SUBMIT_INFRA_EXCEPTION` |
| Promotion execution ledger | `LEDGER_RELEASE_FAILED_IN_HANDLER`, `LEDGER_CONSUME_FAILED_IN_HANDLER`, `PROMOTION_EXECUTION_LEDGER_REAPER_ERROR` |
| Redis and RPC infrastructure | `REDIS_SCAN_UNAVAILABLE`, `SUI_RPC_FAILOVER`, `SUI_RPC_ENDPOINT_COOLDOWN`, `SUI_RPC_ALL_EXHAUSTED` |

Admin audit logs are separate from these stdout-path structured events. Auth and admin routes write Redis-backed audit entries that are read through `/api/logs`.

Admin endpoints are not part of the SDK or MCP public transaction flow.
