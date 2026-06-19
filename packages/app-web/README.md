# @stelis/app-web

Demo Vite + React SPA for evaluating a deployed Stelis relay host.

- Built for: app developers, service developers, and agent clients checking a live host before integration.
- Use for: `/docs`, `/playground`, `/sandbox`, `/status`, and the static demo frontend bundle.
- Not for: full HTTP field definitions, SDK integration guidance, relay server runtime, admin dashboard, or host operations policy.

> `Hosted relay`, `Studio`, `Host`, `relay host`, and `host operator` are defined in [docs/payment-platform.md → Product Family Terms](../../docs/payment-platform.md#product-family-terms).

## Problem fit

Use this package when you need a browser demo for a deployed relay host:

- evaluate whether a host supports the payment tokens and network your integration needs
- check whether USDC or another token is currently listed in `supportedSettlementSwapPaths` before writing integration code
- test direct requests and error handling from `/playground`
- run end-to-end sponsored transaction flows from `/sandbox`
- hand off from public evaluation to shared docs and SDK integration

## Quick start

```bash
# From workspace root
npm install
npm run dev:app-web
```

## Environment variables

Create a `.env` file in this package directory:

```env
# Required: relayer endpoint for the SDK (must end with /relay)
# Network (testnet/mainnet) is auto-detected from the API via GET /relay/config.
VITE_STELIS_RELAYER_URL=https://your-relayer.example.com/relay

# Required: Sui RPC URL for the target network
VITE_SUI_RPC_URL=https://fullnode.testnet.sui.io:443

# Optional: repository docs base URL used by /docs deep links (GitHub links hidden if omitted)
VITE_REPO_DOCS_BASE_URL=https://github.com/stelis-dev/stelis/blob/main

# Optional: UI mode (relay | studio). Default: relay
# 'studio' enables the /promotion route for studio JWT and promotion testing.
# VITE_STELIS_UI_MODE=relay
```

`VITE_STELIS_RELAYER_URL` and `VITE_SUI_RPC_URL` are required.
The app fails fast at runtime if either is missing. Network is auto-detected from the relayer API.

## Pages

| Route         | Description                                               |
| ------------- | --------------------------------------------------------- |
| `/`           | Home — project overview                                   |
| `/status`     | Live relayer status                                       |
| `/docs`       | Public API and capability reference UI for deployed hosts |
| `/playground` | Interactive request runner for direct host calls          |
| `/sandbox`    | Full transaction sandbox with wallet integration          |
| `/promotion`  | Studio-mode promotion and developer-JWT test page (`VITE_STELIS_UI_MODE=studio`) |

## Handoff

- Need the current HTTP route and field reference: [`../../docs/api.md`](../../docs/api.md)
- Need package-level integration guidance: [`../sdk/README.md`](../sdk/README.md)
- Need prepare-sign-sponsor flow guidance: [`../../docs/integration.md`](../../docs/integration.md)
- Need host deployment or operations: [`../../docs/getting-started.md`](../../docs/getting-started.md), [`../../docs/operations.md`](../../docs/operations.md)

## Build

For a clean workspace checkout, build the package dependency chain from the repository root:

```bash
npm run build --workspace=@stelis/contracts
npm run build --workspace=@stelis/core-relay
npm run build --workspace=@stelis/sdk
npm run build --workspace=@stelis/app-web
```

The output is written to `packages/app-web/dist/`.
Run `npm run preview --workspace=@stelis/app-web` to preview the production bundle locally.
The output is a static SPA suitable for static hosting such as GitHub Pages or a CDN.

## Environment Setup

Copy the example file and fill in values:

```bash
cp .env.example .env
```

See [`.env.example`](./.env.example) for all available variables.

## Static Deployment

Build this app from the workspace root with the dependency order shown above so npm can resolve workspace packages.

Required build-time variables:

| Variable                  | Required | Example                                          |
| ------------------------- | -------- | ------------------------------------------------ |
| `VITE_STELIS_RELAYER_URL` | ✅       | `https://your-app-api.vercel.app/relay`          |
| `VITE_SUI_RPC_URL`        | ✅       | `https://fullnode.testnet.sui.io:443`            |
| `VITE_REPO_DOCS_BASE_URL` | optional | `https://github.com/stelis-dev/stelis/blob/main` |

> **Important**: `VITE_STELIS_RELAYER_URL` must point to your `app-api` deployment URL with the `/relay` suffix.

> **CORS**: The `/relay/*` API is open to all origins (`Access-Control-Allow-Origin: *`). No additional CORS configuration is needed on `app-api`.
