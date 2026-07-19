# @stelis/app-admin

Stelis admin single-page app - Vite + React dashboard for Host operators.

- Built for: Host operators and promotion operators using the dashboard of a running Host.
- Use for: viewing runtime status, managing admin actions, and operating promotion records.
- Not for: public relay integration, SDK usage, API field definitions, or deployment policy.

## Start Here

Use this package when you need the operator-facing dashboard for a running
`@stelis/app-api` Host in `relay_with_admin` or
`relay_with_admin_and_studio` mode. A `relay_only` Host does not provide Admin
authentication or operator routes. Studio promotion operations require
`relay_with_admin_and_studio`.
External Host operators use this dashboard as part of the provided Stelis Host release.
Changing dashboard, Host, SDK, or contract source code is a maintainer-only workflow.
This dashboard does not publish or upgrade contracts; it only displays and operates against the configured IDs and runtime state exposed by the backing Host.

- Promotion operation path: [docs/operations.md → `relay_with_admin_and_studio` Operations](../../docs/operations.md#relay_with_admin_and_studio-operations)
- Baseline runbook: [docs/operations.md](../../docs/operations.md)
- Backing Host package: [packages/app-api/README.md](../app-api/README.md)

## Pages

| Route             | Purpose                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `/login`          | Wallet-based admin login                                                           |
| `/dashboard`      | Runtime summary, pool state, withdrawal actions, and sponsored-execution KPI cards |
| `/promotions`     | Studio promotion inventory, detail, and operator actions                           |
| `/sponsored-logs` | Generic + promotion sponsored execution KPI cards, mode filter, recent log table   |
| `/security`       | Abuse blocklist management and auth audit review                                   |
| `/config`         | On-chain IDs, supported settlement swap paths, and fee/config views                |

## Host Dependencies

`@stelis/app-admin` depends on a live `@stelis/app-api` Host for:

- `/admin/auth/*` admin session flows
- `/admin/*` operator data and controls

Configure the UI with a `relay_with_admin` or
`relay_with_admin_and_studio` Host when deploying the operator dashboard.
The dashboard does not require Studio configuration; a `relay_with_admin` Host
uses only the complete Admin environment group.
The dashboard reads `GET /admin/studio` as the Studio availability authority and
does not enable Promotion operations when that response is disabled.
For browser deployment, the Host's `ADMIN_APP_ORIGIN` must equal this app's
exact origin and the Admin cookie domain must be compatible with the Host and
app sites.

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

- `VITE_STELIS_API_URL` (exact HTTP(S) app-api Host origin; no credentials,
  path, query, or fragment)

Unknown `VITE_*` settings fail the build instead of being ignored.

Network is auto-detected from `GET /relay/config`. The dashboard selects the
matching public Sui RPC endpoint internally.

## Related Documents

- [docs/operations.md → `relay_with_admin_and_studio` Operations](../../docs/operations.md#relay_with_admin_and_studio-operations) - Studio Operator runbook section
- [docs/operations.md](../../docs/operations.md) - baseline Host Operator procedures
- [packages/app-api/README.md](../app-api/README.md) - backing Host entry
- [docs/repository-structure.md](../../docs/repository-structure.md) - package and dependency map
