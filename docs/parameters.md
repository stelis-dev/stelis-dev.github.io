# Parameters

This document lists current public configuration values that are referenced by package docs and architecture docs.

If a value here conflicts with code, treat the code as current and update this document.

<a id="package-constants"></a>

## Package Constants

| Name                        |       Value | Source                                        |
| --------------------------- | ----------: | --------------------------------------------- |
| `MAX_CLAIM_MIST`            | `100000000` | `packages/contracts/move/sources/config.move` |
| `INITIAL_MAX_CLAIM_MIST`    |  `75000000` | `packages/contracts/move/sources/config.move` |
| `MIN_SETTLE_MIST`           |      `1000` | `packages/contracts/move/sources/config.move` |
| `ADMIN_UPDATE_DELAY_EPOCHS` |         `2` | `packages/contracts/move/sources/config.move` |
| `SLIPPAGE_CAP_BPS`          |       `500` | `packages/contracts/src/constants.ts`         |
| `GAS_MARGIN_CAP_BPS`        |     `10000` | `packages/contracts/src/constants.ts`         |
| `GAS_VARIANCE_FIXED_MIST`   |    `100000` | `packages/core-relay/src/gasEstimate.ts`      |
| `DEFAULT_GAS_MARGIN_BPS`    |      `1000` | `packages/core-relay/src/gasEstimate.ts`      |

## Initial On-Chain Config Values

These values are written by `packages/contracts/move/sources/config.move` at package initialization. The on-chain admin can queue selected field changes through `update_config`. Matured queued values are applied by `apply_config_update` at or after `queued_epoch + ADMIN_UPDATE_DELAY_EPOCHS`.

| Field                    | Initial value | Notes                                                                                                                                              |
| ------------------------ | ------------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_host_fee_mist`      |           `0` | Admin can queue an update, bounded by fee-cap checks.                                                                                              |
| `protocol_flat_fee_mist` |           `0` | Admin can queue an update.                                                                                                                         |
| `max_claim_mist`         |    `75000000` | Starts from `INITIAL_MAX_CLAIM_MIST`; cannot exceed `MAX_CLAIM_MIST`.                                                                              |
| `min_settle_mist`        |      `100000` | Cannot be set below `MIN_SETTLE_MIST`.                                                                                                             |
| `max_spread_bps`         |         `500` | Admin can queue an update within `1..10000`.                                                                                                       |
| `config_version`         |           `0` | Incremented when a queued admin change is applied, when emergency pause changes protocol state, or when emergency pause cancels a pending unpause. |

<a id="off-chain-constants"></a>

## Off-Chain Constants

| Name                                                                |         Value | Source                                                   |
| ------------------------------------------------------------------- | ------------: | -------------------------------------------------------- |
| `PREPARE_TTL_MS`                                                    |       `60000` | `packages/core-api/src/preparePolicy.ts`                 |
| `MAX_CONCURRENT_PREPARED_PER_IP`                                    |           `2` | `packages/core-api/src/store/sponsoredExecutionStore.ts` |
| `MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER`                          |           `3` | `packages/core-api/src/store/sponsoredExecutionStore.ts` |
| `MAX_OUTSTANDING_PREPARED_PER_SENDER`                               |           `3` | `packages/core-api/src/store/sponsoredExecutionStore.ts` |
| `PREPARE_AUTHORIZATION_TTL_MS`                                      |      `300000` | `packages/core-api/src/prepare/prepareAuthorization.ts`  |
| `PREPARE_AUTHORIZATION_CLOCK_SKEW_MS`                               |       `30000` | `packages/core-api/src/prepare/prepareAuthorization.ts`  |
| `MAX_PREPARE_REQUEST_NONCE_BYTES`                                   |         `128` | `packages/core-api/src/prepare/prepareAuthorization.ts`  |
| Sponsor balance warning default                                     |  `5000000000` | `packages/app-api/src/sponsor-operations/defaults.ts`    |
| Sponsor refill target and refill-disabled withdrawal-runway default | `10000000000` | `packages/app-api/src/sponsor-operations/defaults.ts`    |

<a id="ttl-constants"></a>

## TTL Constants

| Name                                                    |    Value | Source                                                  | Meaning                                                          |
| ------------------------------------------------------- | -------: | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `PREPARE_TTL_MS`                                        |  `60000` | `packages/core-api/src/preparePolicy.ts`                | How long a prepare receipt is valid.                             |
| `PREPARE_AUTHORIZATION_TTL_MS`                          | `300000` | `packages/core-api/src/prepare/prepareAuthorization.ts` | Maximum age for a signed prepare authorization message.          |
| `PREPARE_AUTHORIZATION_CLOCK_SKEW_MS`                   |  `30000` | `packages/core-api/src/prepare/prepareAuthorization.ts` | Accepted client clock lead for prepare authorization timestamps. |
| `PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS` |  `60000` | `packages/core-api/src/studio/executionLedger.ts`       | Default Studio promotion reservation TTL.                        |
| `PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS` |  `15000` | `packages/core-api/src/studio/executionLedger.ts`       | Default Studio ledger expired-reservation sweep interval.        |

Prepare records are temporary. Clients must prepare again when a receipt expires or when a sponsor returns `LEASE_EXPIRED`.

Prepare authorization request nonces are temporary replay guards for signed prepare requests. They are separate from the on-chain settlement nonce returned in the prepare response.

<a id="runtime-timing-constants"></a>

## Runtime Timing Constants

| Name                               |    Value | Source                                                    | Meaning                                                                                                                                                                                                                                   |
| ---------------------------------- | -------: | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_API_RATE_LIMIT_WINDOW_MS`     |  `60000` | `packages/app-api/src/context.ts`                         | Fixed-window request rate-limit window for app-api route groups using the shared limiter.                                                                                                                                                 |
| `APP_API_RATE_LIMIT_MAX_REQUESTS`  |     `20` | `packages/app-api/src/context.ts`                         | Maximum requests allowed in each app-api fixed window for route groups using the shared limiter.                                                                                                                                          |
| Admin auth rate limit window       | `900000` | `packages/core-api/src/admin/adminRateLimit.ts`           | Fixed-window duration for admin auth attempts.                                                                                                                                                                                            |
| `RATE_LIMIT_MAX`                   |      `5` | `packages/core-api/src/admin/adminRateLimit.ts`           | Maximum admin auth attempts per IP in each fixed window.                                                                                                                                                                                  |
| Admin operation rate limit window  | `900000` | `packages/core-api/src/admin/adminOperationsRateLimit.ts` | Fixed-window duration for mutating admin operation attempts.                                                                                                                                                                              |
| `ADMIN_OPERATIONS_RATE_LIMIT_MAX`  |      `5` | `packages/core-api/src/admin/adminOperationsRateLimit.ts` | Maximum mutating admin operation attempts per IP in each fixed window.                                                                                                                                                                    |
| `DEVELOPER_VERIFY_TIMEOUT_MS`      |   `5000` | `packages/app-api/src/developerJwtVerifyCallback.ts`      | Timeout for optional developer JWT verification callback.                                                                                                                                                                                 |
| `SUI_OPERATION_ATTEMPT_TIMEOUT_MS` |  `30000` | `packages/core-relay/src/sui/suiOperation.ts`             | Maximum duration `U` for one Sui RPC attempt. A validated read tries each endpoint in the immutable qualified snapshot at most once, with a total deadline of `endpointCount * U`; signed execution submits to the primary endpoint once. |

## Studio Ledger Limits

| Name                              |              Value | Source                                | Meaning                                                            |
| --------------------------------- | -----------------: | ------------------------------------- | ------------------------------------------------------------------ |
| `MAX_PROMOTION_LEDGER_VALUE_MIST` | `9007199254740991` | `packages/contracts/src/constants.ts` | Maximum MIST value accepted by Studio promotion ledger accounting. |

## Required Host Environment

`@stelis/app-api` requires the following baseline configuration:

- `REDIS_URL`
- `SPONSOR_SECRET_KEY`
- `SPONSOR_REFILL_ACCOUNT_SECRET_KEY`
- `NETWORK`
- `SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS`
- `SPONSOR_LEASE_HMAC_SECRET`
- `packages/app-api/settlement-swap-paths.json`, with a non-empty section for the selected `NETWORK`
- `packages/app-api/rpc.json`, with a non-empty endpoint section for the selected `NETWORK`

The shipped Stelis contract ID table currently supports testnet only. Although
the network-shaped configuration and wire type also represent `mainnet`, a Host
with `NETWORK=mainnet` fails closed until a fresh mainnet Move package is
deployed and its current package, config, and vault IDs are added.

`SPONSOR_SECRET_KEY` configures sponsor slots. Each sponsor slot key signs sponsored transactions as `gasOwner`. The value accepts 1..256 comma-separated sponsor keys.

`SPONSOR_REFILL_ACCOUNT_SECRET_KEY` configures the Sponsor Refill Account. That key signs sponsor slot refill transactions and Sponsor Refill Account admin withdrawal transactions. It is separate from sponsor slot keys.

The Sponsor Refill Account and sponsor slot SUI policy is defined in [`Sponsor Pools`](./architecture/sponsor-pools.md#sponsor-sui-state).

Sponsor operation timeouts are also required:

- `SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS`
- `SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS`

Optional Host configuration:

- `PORT`
- `TRUSTED_PROXY_HOPS`
- `NODE_ENV`
- `HOST_FEE_MIST`
- `PREPARE_INFLIGHT_CAPACITY`
- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

When `SPONSOR_OPERATIONS_REFILL_ENABLED=true`,
`SPONSOR_BALANCE_REFILL_TARGET_MIST` is required and must be greater than
`SPONSOR_BALANCE_WARN_MIST`.

The Host has two operating modes. `relay_only` requires every setting in the
following two lists to be unset. `relay_and_studio` requires all of these:

- `ADMIN_ADDRESS`
- `ADMIN_JWT_SECRET`
- `CORS_ORIGINS`
- `STUDIO_ALLOWED_TARGETS`
- `STUDIO_DEVELOPER_JWT_TRUST_JSON`

These settings are optional only in `relay_and_studio` mode:

- `ADMIN_SESSION_EXPIRY`
- `COOKIE_DOMAIN`
- `STUDIO_DEVELOPER_JWT_VERIFY_URL`

Setting any required or optional mode setting selects `relay_and_studio`; boot
fails when any of its five required settings is then missing. The developer JWT
verification URL must use HTTPS, except that HTTP is accepted for the exact
parsed hostnames `localhost`, `127.0.0.1`, and `[::1]`. It must not contain
embedded username or password credentials or a URL fragment. Callback requests
omit ambient credentials and reject redirects instead of following them. All
local `relay_and_studio` settings are validated before Sui endpoint
qualification starts.

## Static App Environment

`@stelis/app-web` requires:

- `VITE_STELIS_RELAY_API_URL`

Optional `@stelis/app-web` configuration:

- `VITE_STELIS_UI_MODE`
- `VITE_REPO_DOCS_BASE_URL`

`@stelis/app-admin` requires:

- `VITE_STELIS_API_URL`

Both static apps select the public Sui RPC endpoint from the network returned by `GET /relay/config`.

## MCP Server Environment

`@stelis/mcp-server` accepts optional default configuration:

- `STELIS_RELAY_API_URL`
- `STELIS_REQUEST_TIMEOUT_MS`
