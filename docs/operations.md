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

The file is a network-keyed object with `testnet` and `mainnet` endpoint arrays. At boot, the Host reads only the section selected by `NETWORK`. Each endpoint must report the exact configured chain identifier and independently complete the actual Config, VaultRegistry, settlement swap-path object, coin-metadata, and Move-view reads used to construct the Host. Endpoints that fail qualification are excluded without changing their configured order. If the selected section is empty or no endpoint qualifies, boot fails.

Each endpoint accepts `baseUrl` plus optional `auth` header configuration.
`baseUrl` is the private HTTP(S) gRPC-web base URL. Provider paths are
preserved; credentials, queries, and fragments are rejected. Endpoint secrets
therefore live only in the boot environment named by `auth.valueEnv`, not in
the tracked JSON file.
`auth` contains `header`, `valueEnv`, and optional `prefix`; the secret value is
read from the boot environment snapshot. `localDevelopmentEndpoint: true` is
accepted only for unauthenticated loopback HTTP endpoints. Unknown fields and
header values containing ASCII control characters fail boot. Literal metadata
headers are not part of the tracked configuration language.

Admin status exposes only each accepted endpoint's origin and configured role.
It never exposes the private provider path or authentication metadata.

The accepted clients form one immutable ordered snapshot. Validated reads and simulations try each accepted endpoint at most once. Every attempt is capped at 30 seconds and the whole operation is capped at `accepted endpoint count * 30 seconds`. Signed transaction execution uses the primary accepted endpoint exactly once and is never automatically resubmitted; subsequent effects, event, object, coin, and balance reads use the validated read policy.

The shipped Stelis contract ID table currently supports testnet only. The
mainnet RPC and settlement swap path sections do not by themselves make a
mainnet Host deployable: `NETWORK=mainnet` fails closed until a fresh Stelis
Move package and its current mainnet object IDs are shipped.

## Reverse Proxy and CORS

`TRUSTED_PROXY_HOPS` controls how the Host reads `X-Forwarded-For` for rate limiting and abuse checks.

In deployed runtimes, `TRUSTED_PROXY_HOPS` must be set explicitly before the Host starts. Use `TRUSTED_PROXY_HOPS=0` only when the API is directly exposed, or set it to the actual reverse-proxy hop count.

The temporary Vercel demo adapter is an exception to the proxy-hop model. Vercel overwrites `x-forwarded-for` with the client public IP, and `packages/app-api/src/vercel.ts` installs an adapter-local source provider before the Host app is created. For that temporary Vercel path, set `TRUSTED_PROXY_HOPS=0`; do not set a guessed proxy-hop count.

In `development` and `test`, an unset `TRUSTED_PROXY_HOPS` defaults to `0` and uses the socket remote address.

`/relay/*` and `/studio/*` allow all origins. `/auth/*` and `/api/*` send
credentialed CORS responses only to origins listed in `CORS_ORIGINS`. CORS is
not the mutation authorization check: Admin mutations and the Auth mutations
that establish, renew, or end an Admin session also require the request's
`Origin` to exactly match one of those configured origins. The complete HTTP
request contract is in [`API Reference → Request admission`](./api.md#request-admission).

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

`@stelis/app-api` wires Redis-backed adapters for sponsored execution receipts, prepare in-flight limits, rate limits, abuse blocking, sponsor pool leasing, admin sessions, and Promotion state.

Memory adapters remain test fixtures. They are not runtime defaults for the deployable Host.

Default Redis namespaces are owned by their adapter modules:

| Namespace                            | Runtime state                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `stelis:{sponsored-execution}:`      | Prepared, executing, and final receipt records; deadlines; pending callbacks; prepare indexes; generic nonce reservations. |
| `stelis:inflight:slots`              | Shared prepare in-flight limiter.                                                                                          |
| `stelis:rate_limit:`                 | Fixed-window request counters.                                                                                             |
| `stelis:abuse:`                      | Abuse counters and temporary blocks.                                                                                       |
| `stelis:sponsor_lease:`              | Sponsor slot leases.                                                                                                       |
| `stelis:app-api:sponsor-operations:` | Sponsor-address and Sponsor Refill Account balance observations, account-spend records, and operation locks.               |
| `stelis:sponsored_logs:`             | Sponsored execution aggregate and recent entries read by admin routes.                                                     |
| `stelis:promo:`                      | Promotion records and promotion indexes.                                                                                   |
| `stelis:promotion_execution_ledger:` | Promotion accounting, entitlements, reservations, final operation results, and reservation deadlines.                      |
| `stelis:app-api:admin:not_before`    | Admin session invalidation timestamp.                                                                                      |

## Redis Deployment Topology

Every `@stelis/app-api` instance in one deployment must use the same logical Redis write authority. Redis is the coordination store for sponsored execution receipts, prepare in-flight admission, rate limits, abuse blocks, sponsor slot leases, sponsor operation state, refill locks, admin sessions, and Promotion state.

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

This policy matches current Redis key usage. Sponsored execution transitions update receipt, lease, deadline, and Promotion records in multi-key Lua scripts. Sponsor operation reads, refill locks, abuse decisions, and Promotion ledgers also rely on one authoritative write path for their keys.

## Sponsor Operations

Prepare routes use aggregate SponsorOperations state and current lease occupancy
before beginning expensive transaction construction. Sponsor routes already
carry a receipt and therefore check the fresh observation for that receipt's
assigned sponsor address immediately before execution begins.

Sponsor SUI ownership, refill transitions, sponsor slot gas use, and Sponsor Refill Account withdrawal are defined in [`Sponsor Pools`](./architecture/sponsor-pools.md#sponsor-sui-state).

The prepare in-flight limiter is Redis-backed and shared across all `app-api` instances that use the same Redis write authority. It limits concurrent expensive
prepare work after cheap request validation and before build/simulation work completes.
When `PREPARE_INFLIGHT_CAPACITY` is not set, the Host uses `sponsor slot count * 2`.
`SPONSOR_SECRET_KEY` supports 1..256 comma-separated sponsor keys. Boot rejects deployments outside that range.

### Sponsor Capacity Policy

Prepare capacity is enforced by the shared Redis write authority.

Prepare admission uses these gates in order:

1. The Host applies client-IP abuse and rate-limit checks.
2. It validates `Content-Type`, reads the bounded JSON body, and validates the
   request fields.
3. It verifies the wallet-signed prepare authorization and applies the
   authenticated sender block check.
4. Only then does it read SponsorOperations state and sponsor slot leases from
   Redis. It returns `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` when no healthy sponsor
   slot remains and the Sponsor Refill Account is unhealthy, or
   `SPONSOR_CAPACITY_UNAVAILABLE` when no healthy sponsor slot remains or every
   healthy sponsor slot is already leased.
5. `RedisPrepareInflight` reserves one in-flight prepare slot before chain
   reads, build, and simulation. A full limiter returns `PREPARE_OVERLOADED`
   with `Retry-After: 2`.
6. Sponsor slot checkout failure after in-flight admission returns
   `NO_SPONSOR_SLOT`.

Sponsor submission does not require a free sponsor address. It completes an existing prepared receipt and checks the fresh balance observation for the sponsor address bound to that receipt.

Capacity-related retry contract:

| Code                               | HTTP status | Retry guidance                                                                  |
| ---------------------------------- | ----------: | ------------------------------------------------------------------------------- |
| `SPONSOR_CAPACITY_UNAVAILABLE`     |         503 | Retry after sponsor capacity recovers.                                          |
| `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` |         503 | Retry after sponsor capacity recovers; operators inspect refill account health. |
| `PREPARE_OVERLOADED`               |         503 | Retry after the `Retry-After` header.                                           |
| `NO_SPONSOR_SLOT`                  |         503 | Retry prepare after sponsor capacity recovers.                                  |

Capacity alert thresholds:

| Signal                                   | Alert condition                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Free healthy sponsor slots               | `0` for `60s`.                                                             |
| Prepare in-flight utilization            | `>= 90%` of `PREPARE_INFLIGHT_CAPACITY` or the default capacity for `60s`. |
| `SPONSOR_CAPACITY_UNAVAILABLE` responses | Greater than `0` for `60s`.                                                |
| `PREPARE_OVERLOADED` responses           | Greater than `0` for `60s`.                                                |

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
- `SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS`

Optional refill variables:

- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

When `SPONSOR_OPERATIONS_REFILL_ENABLED=true`,
`SPONSOR_BALANCE_REFILL_TARGET_MIST` is required and must be greater than
`SPONSOR_BALANCE_WARN_MIST`.

`HOST_FEE_MIST` is optional. When unset, the quoted host fee defaults to zero.
`PREPARE_INFLIGHT_CAPACITY` is optional. When set, it must be a positive integer and becomes the shared prepare in-flight capacity for one Redis write authority.

SponsorOperations observations and account-spend records are shared through Redis. A sponsor-address observation is keyed as `stelis:app-api:sponsor-operations:slot:<address>`, the Sponsor Refill Account observation is keyed as `stelis:app-api:sponsor-operations:sponsor-refill-account`, and the current account spend uses the separate `stelis:app-api:sponsor-operations:sponsor-refill-account-spend` key. Public status is calculated from these current records rather than stored as another status record.

Refill and withdrawal share `stelis:app-api:sponsor-operations:sponsor-refill-account-dispatch-lock:<address>` while preparing one Sponsor Refill Account spend. The `sponsor-refill-account` HASH stores only the latest total-balance observation. The separate `sponsor-refill-account-spend` HASH stores the current operation intent and, before submission, its exact signed transaction bytes, signature, gas budget, and digest. Signed submission uses the primary endpoint exactly once. Recovery, terminal-digest lookup, and balance observation use the immutable boot-qualified endpoint snapshot in configured order and accept only responses bound to the stored digest or requested account. Once that transaction result is confirmed, the mutable slot balance classifies current health but does not keep the global spend active until a target is observed. Boot recovery does not wait for a dead process's remaining efficiency-lock TTL; durable operation identity and CAS keep every recovery driver on the same signed transaction. The lock TTL only releases abandoned mutex ownership and is not a transaction-safety boundary.

An admin withdrawal `503` with code `WITHDRAWAL_PENDING` is an uncertain outcome, not permission to create another withdrawal intent. The signed message, nonce key, durable spend, and browser retry record are bound to the boot-selected network. app-admin stores the exact signed request in session storage before submission and retries those same fields after a pending response or page reload. Redis retains the accepted request's terminal outcome for the configured admin-session duration after acceptance, so an exact retry remains stable after a later account spend replaces the active account record. A request that encounters a different active spend only recovers that spend; it never chains the incoming withdrawal or refill into the same call. Such an incoming withdrawal receives `409 WITHDRAWAL_NOT_ACCEPTED`, and app-admin discards that unaccepted signed request instead of treating it as recovery work.

State writers use Redis server time for `lastObservedAtMs`. Sponsor Refill Account observations compare the sampled operation ID, spend sequence, and account write sequence. General slot observations compare the sampled slot write sequence and cannot write while a refill operation is active. Spend transitions compare operation ID and spend sequence; their account-balance projection is applied only when its sampled account write sequence is still current, so ordinary observations cannot starve the transaction state machine or be overwritten by an older sample. Terminal refill slot projection also compares the owning operation and slot write sequence. Each accepted observation advances its sequence, so a late RPC or submit result cannot overwrite a newer operation or observation.

## `relay_and_studio` Operations

Studio promotion routes are available when the Host boots with all required Studio configuration:

- `ADMIN_JWT_SECRET`
- `ADMIN_ADDRESS`
- `CORS_ORIGINS`
- `STUDIO_ALLOWED_TARGETS`
- `STUDIO_DEVELOPER_JWT_TRUST_JSON`

`STUDIO_DEVELOPER_JWT_VERIFY_URL` is optional.

The Host has exactly two operating modes. With all required Studio configuration it runs in `relay_and_studio` mode and exposes both Relay API and Studio routes. With none of the Studio or Admin configuration it runs in `relay_only` mode and exposes only the Relay API. A partial Studio or Admin configuration fails boot. Every local `relay_and_studio` setting is parsed and validated before the Host starts Sui endpoint qualification.

`STUDIO_ALLOWED_TARGETS` is a comma-separated list of `package::module::function` entries. Boot validation canonicalizes package addresses and rejects an empty list, malformed entries, and canonical duplicates. Promotion prepare and sponsor requests compare every MoveCall with that same boot-time set.

`STUDIO_DEVELOPER_JWT_TRUST_JSON` is a single trusted issuer definition. The verifier supports `RS256` and `ES256`, checks issuer, audience, signature, expiry, optional `iat`/`nbf`, and extracts `userId` plus `senderAddress` from configured claim paths. If `STUDIO_DEVELOPER_JWT_VERIFY_URL` is set, the Host calls it after local JWT verification succeeds. The callback URL must use HTTPS. HTTP is accepted only when its parsed hostname is exactly `localhost`, `127.0.0.1`, or `[::1]`; subdomains, other `127/8` addresses, and IPv4-mapped IPv6 addresses are rejected. Embedded username or password credentials and URL fragments are rejected. The Host sends the JWT only to that validated URL, omits ambient credentials, and never follows a redirect response. The callback response is the closed current shape `{ "valid": boolean, "reason"?: string }`: an explicit `false` is `AUTH_JWT_INVALID`, while a redirect, transport failure, or malformed/non-current response is `AUTH_UNAVAILABLE`. Both fail closed.

Promotion execution uses Redis-backed promotion records and one promotion execution ledger. The ledger owns Promotion accounting, entitlements, reservations, permanent final operation results, and the reservation deadline index. It reserves gas allowance at promotion prepare time, then consumes or releases the reservation at promotion sponsor time. Ledger settings are listed in [`TTL Constants`](./parameters.md#ttl-constants) and [`Studio Ledger Limits`](./parameters.md#studio-ledger-limits).

## Admin Operations

`@stelis/app-admin` uses `/auth/*` for admin sessions and `/api/*` for operator actions.

Admin dashboard operation requires a `relay_and_studio` Host, including the
five required settings listed above.

Optional admin settings:

- `ADMIN_SESSION_EXPIRY`
- `COOKIE_DOMAIN`

Boot validation requires `ADMIN_JWT_SECRET` to be at least 32 characters when it is configured. If `ADMIN_ADDRESS` is configured, the sponsor refill account address must be different from the admin address.

## Host process shutdown

The standard Node entry point uses one `ApplicationRuntime` for boot,
readiness, request intake, and shutdown. `SIGINT` and `SIGTERM` invoke the same
awaited stop operation. Shutdown stops HTTP intake and drains in-flight HTTP
requests, stops and awaits SponsorOperations, stops and awaits sponsored
execution recovery and expiration-cleanup tasks, disposes the Host context,
then closes Redis. A partial boot cleans up every resource acquired before the
failure in the same ownership order.

The temporary Vercel adapter is not a long-running process runtime and does not
provide this process-signal lifecycle. Its deployment limitation is described
in the [`@stelis/app-api` README](../packages/app-api/README.md#temporary-vercel-demo-adapter).

<a id="settlement-token-onboarding-procedure"></a>

## Settlement Token Onboarding Procedure

Settlement swap path support is controlled by `packages/app-api/settlement-swap-paths.json`.

The file is a network-keyed object with `testnet` and `mainnet` sections. The Host reads only the section selected by `NETWORK`:

```json
{
  "testnet": ["0x..."],
  "mainnet": ["0x..."]
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

| Family                              | Representative events                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare pipeline                    | `PREPARE_STAGE`, `PREPARE_BUILD_STAGE`, `PREPARE_INFLIGHT_REJECTED`, `PREPARE_ENTRY_CORRUPT`, `PREPARE_SLOT_EXHAUSTED`                                                                                                       |
| Sponsor runtime                     | `SPONSOR_FAILURE_RECORDED`, `SPONSOR_DRIFT_OBSERVED`, `SETTLEMENT_ECONOMICS_EXECUTION`                                                                                                                                       |
| Sponsor pool and sponsor operations | `SPONSOR_POOL_LEASE_CHECKOUT`, `SPONSOR_POOL_LEASE_CHECKIN`, `SPONSOR_POOL_SIGN`, `SPONSOR_POOL_CHECKIN_FAILED`, `SPONSOR_RESULT_CALLBACK_FAILED`, `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`, `SPONSOR_OPERATIONS_TASK_FAILED` |
| Sponsored execution logs            | `SPONSORED_LOGS_RECORDER_FAILED`                                                                                                                                                                                             |
| Studio promotion                    | `PROMOTION_ABUSE_RECORDED`, `PROMOTION_SPONSOR_EXECUTION`, `PROMOTION_GAS_OVERRUN_WARNING`                                                                                                                                   |
| Promotion execution ledger          | `LEDGER_RELEASE_FAILED_IN_HANDLER`, `PROMOTION_EXECUTION_LEDGER_REAPER_ERROR`                                                                                                                                                |
| Abuse blocking                      | `ABUSE_BLOCK_EXPIRY_TASK_FAILED`                                                                                                                                                                                             |

Admin audit logs are separate from these stdout-path structured events. Auth and admin routes write Redis-backed audit entries that are read through `/api/logs`.

Admin endpoints are not part of the SDK or MCP public transaction flow.
