# @stelis/app-admin

Stelis admin single-page app - Vite + React dashboard for operators.

- Built for: host operators and promotion operators using the dashboard of a running host.
- Use for: viewing runtime status, managing admin actions, and operating promotion records.
- Not for: public relay integration, SDK usage, API field definitions, or deployment policy.

## Start Here

Use this package when you need the operator-facing dashboard for a running `@stelis/app-api` host.
External host operators use this dashboard as part of the provided Stelis host release.
Changing dashboard, host, SDK, or contract source code is a maintainer-only workflow.
This dashboard does not publish or upgrade contracts; it only displays and operates against the configured IDs and runtime state exposed by the backing host.

- Promotion operation path: [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations)
- Baseline runbook: [docs/operations.md](../../docs/operations.md)
- Backing host package: [packages/app-api/README.md](../app-api/README.md)

## Pages

| Route             | Purpose                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `/login`          | Wallet-based admin login                                                           |
| `/dashboard`      | Runtime summary, pool state, withdrawal actions, and sponsored-execution KPI cards |
| `/promotions`     | Promotion inventory, detail, and operator actions                                  |
| `/sponsored-logs` | Generic + promotion sponsored execution KPI cards, mode filter, recent log table   |
| `/security`       | Abuse blocklist management and auth audit review                                   |
| `/config`         | On-chain IDs, supported settlement swap paths, and fee/config views                |

## Host Dependencies

`@stelis/app-admin` depends on a live `@stelis/app-api` host for:

- `/auth/*` admin session flows
- `/api/*` operator data and controls

Configure the UI and host together when deploying the operator dashboard.

## Quick Start

From the repository root:

```bash
npm run dev:app-admin
```

Build a production bundle with:

```bash
npm run build --workspace=@stelis/app-admin
```

## Environment

Copy the example file:

```bash
cp .env.example .env
```

Required:

- `VITE_STELIS_API_URL` (app-api base URL)
- `VITE_SUI_RPC_URL` (Sui RPC endpoint)

Network (`testnet` / `mainnet`) is auto-detected from `GET /relay/config`.

## Related Documents

- [docs/operations.md → Studio Mode Operations](../../docs/operations.md#studio-mode-operations) - Studio Operator runbook section
- [docs/operations.md](../../docs/operations.md) - baseline Host Operator procedures
- [packages/app-api/README.md](../app-api/README.md) - backing HTTP host entry
- [docs/repository-structure.md](../../docs/repository-structure.md) - package and dependency map
