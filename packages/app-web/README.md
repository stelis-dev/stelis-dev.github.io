# @stelis/app-web

Public demo web app for checking a deployed Stelis Host, trying direct Relay API calls, and running sandbox transaction flows.

- Built for: app developers, service developers, and agent clients checking a live Host before integration.
- Use for: `/docs`, `/playground`, `/sandbox`, `/status`, and the static demo frontend bundle.
- Not for: full HTTP field definitions, SDK integration guidance, Host runtime, admin dashboard, or Host operations policy.

> `Host`, `Relay API`, `Admin app`, `Studio`, and `Host operator` are defined in [docs/payment-platform.md → Product Family Terms](../../docs/payment-platform.md#product-family-terms).

## Problem fit

Use this package when you need a browser demo for a deployed Host:

- evaluate whether a Host supports the settlement tokens and network your integration needs
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
# Required: Relay API endpoint for the SDK (must end with /relay)
# Network is auto-detected from the Host via GET /relay/config.
VITE_STELIS_RELAY_API_URL=https://your-host.example.com/relay

# Optional: repository docs base URL used by /docs deep links (GitHub links hidden if omitted)
VITE_REPO_DOCS_BASE_URL=https://github.com/stelis-dev/stelis/blob/main

# Optional: UI mode (relay | studio). Default: relay
# 'studio' enables the /promotion route for studio JWT and promotion testing.
# VITE_STELIS_UI_MODE=relay
```

`VITE_STELIS_RELAY_API_URL` is required. The app fails fast at runtime if it is missing.
Network is auto-detected from the Relay API, and the sample page selects the matching public Sui RPC endpoint internally.

## Pages

| Route         | Description                                               |
| ------------- | --------------------------------------------------------- |
| `/`           | Home — project overview                                   |
| `/status`     | Live Host status                                          |
| `/docs`       | Public API and capability reference UI for deployed Hosts |
| `/playground` | Interactive request runner for direct Host calls          |
| `/sandbox`    | Full transaction sandbox with wallet integration          |
| `/promotion`  | Studio-mode promotion and developer-JWT test page (`VITE_STELIS_UI_MODE=studio`) |

## Handoff

- Need the current HTTP route and field reference: [`../../docs/api.md`](../../docs/api.md)
- Need package-level integration guidance: [`../sdk/README.md`](../sdk/README.md)
- Need prepare-sign-sponsor flow guidance: [`../../docs/integration.md`](../../docs/integration.md)
- Need Host deployment or operations: [`../../docs/getting-started.md`](../../docs/getting-started.md), [`../../docs/operations.md`](../../docs/operations.md)

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
The static bundle uses relative asset URLs, so it can run from either a domain root or a GitHub Pages project path.

## Environment Setup

Copy the example file and fill in values:

```bash
cp .env.example .env
```

See [`.env.example`](./.env.example) for all available variables.

## Static Deployment

This package is the public sample-page deployment target. Do not publish `@stelis/app-admin` to GitHub Pages.

Build this app from the workspace root with the dependency order shown above so npm can resolve workspace packages.

Required build-time variables:

| Variable                  | Required | Example                                          |
| ------------------------- | -------- | ------------------------------------------------ |
| `VITE_STELIS_RELAY_API_URL` | ✅       | `https://your-app-api.vercel.app/relay`          |
| `VITE_REPO_DOCS_BASE_URL` | optional | `https://github.com/stelis-dev/stelis/blob/main` |

> **Important**: `VITE_STELIS_RELAY_API_URL` must point to your `app-api` deployment URL with the `/relay` suffix.

The sample page selects the matching public Sui RPC endpoint from the network
returned by `GET /relay/config`.

> **CORS**: The `/relay/*` API is open to all origins (`Access-Control-Allow-Origin: *`). No additional CORS configuration is needed on `app-api`.
