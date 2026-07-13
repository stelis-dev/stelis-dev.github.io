# @stelis/contracts

Shared TypeScript data used across packages.

- Built for: maintainers, reviewers, and internal developers working on shared TypeScript data.
- Use for: request and response types, settlement swap direction tables, contract IDs, and admin sponsor operation payloads.
- Not for: runtime host setup, browser or server framework behavior, or product runbooks.

## Purpose

Use `@stelis/contracts` when a value or type must be shared across workspace boundaries without duplicating literals or type definitions.

This package is intentionally narrow:

- request and response types
- runtime constants and lookup tables
- side-effect-free cross-package helpers only when exact byte-for-byte values
  must be shared across browser/server boundaries
- no framework code
- no Node-only or browser-only side effects

## Exports

Primary source files:

- `src/types.ts` — shared request and response types such as `SingleHopSettlementSwapPath`, `SettlementSwapDirection`, and PTB/admin/studio contracts
- `src/settlementContract.ts` — generated compiled settlement entry descriptors, SettleEvent schema, and Stelis/DeepBook runtime abort identities
- `src/constants.ts` — settlement swap direction vectors, published contract IDs, `SLIPPAGE_CAP_BPS`, `GAS_MARGIN_CAP_BPS`
- `src/hostWire.ts` — current Host HTTP request/response types and pure boundary parsers
- `src/admin.ts` — sponsor operation gate/status/admin payload types plus the shared pool-withdraw message builder used by `app-api` and `app-admin`
- `src/index.ts` — package entrypoint

## Consumers

- `@stelis/core-relay` — shared settlement swap direction data, contract IDs, and caps
- `@stelis/core-api` — shared request and response data used by handlers and stores
- `@stelis/app-api` — contract IDs and admin/studio request and response types
- `@stelis/sdk` — bundled contract IDs, settlement swap direction tables, and request and response types
- `@stelis/app-admin` — admin payload types plus the shared pool-withdraw message builder

## Boundary Rules

- Add exports only when there is a verified current consumer or trust-boundary requirement.
- Keep runtime behavior in interior packages (`core-relay`, `core-api`, `app-api`) rather than growing this package.
- When a constant/type here changes, update dependent docs and lock tests together.

## Verify

From the repository root:

```bash
npm run build --workspace=@stelis/contracts
npm run typecheck --workspace=@stelis/contracts
```
