# AGENTS.md

This file defines the package-policy rules agents must preserve while working in this repository.

## Package Policy

Workspace packages are allowed for development optimization, but product publishing and deployment are constrained by final artifacts.

Agents must distinguish these categories:

- Product artifact packages: packages that are published, deployed, or installed as a product surface.
- Internal source-of-truth packages: private workspace packages that exist to reduce duplication and enforce implementation boundaries.

Current product artifact packages:

- `@stelis/sdk` — dApp and service-maker SDK.
- `@stelis/mcp-server` — agent-facing MCP server.
- `@stelis/app-api` — deployable API host.
- `@stelis/app-web` — public static web app.
- `@stelis/app-admin` — admin static web app.
- `packages/contracts/move` — on-chain Move artifact.

Current internal source-of-truth packages:

- `@stelis/contracts` — contract IDs, settlement swap directions, wire primitives, and Move-adjacent shared data.
- `@stelis/core-relay` — transaction validation, pricing, quote, and PTB/integrity primitives.
- `@stelis/core-api` — server-side domain lifecycle and store/abuse/admin/studio logic.

## Agent Rules

- Do not create a new top-level package unless it is a product artifact or a durable internal source-of-truth boundary.
- Prefer internal modules inside an existing package over new packages when the code is not a final artifact boundary.
- Keep `@stelis/sdk` and `@stelis/mcp-server` independent. They are sibling product surfaces and must not import each other.
- Do not make `@stelis/mcp-server` depend on `@stelis/core-api` or `@stelis/app-api` without explicit approval; those packages own server execution, not agent transaction proposal UX.
- Keep internal packages `private: true`.
- When changing package dependencies, update the package-boundary allowlist and documentation in the same change.
- Do not widen public `exports` for symmetry or speculative reuse. Add exports only for verified consumers.
- Treat the publish/deploy allowlist as stricter than the workspace list.
- This repository has no public release contract. Use the clearest current API, type, field, and tool names directly.
- Do not keep alternate public names, deprecated wrappers, compatibility exports, or compatibility readers for names and data shapes that current code no longer uses.

## Boundary Naming Rules

- Use the same domain noun for the same concept across package boundaries.
- Use plain industry terms that a new reader can understand without project history. Do not introduce coined product terms, private shorthand, or broad labels unless the term is already a protocol term, a package name, or a public API field with a clear definition.
- Define a product term before using it as a label in public docs. If a term needs a local explanation every time it appears, choose a clearer name instead.
- Split ambiguous words into precise names. If one word can mean an HTTP route, swap path, swap direction, liquidity pool, sponsor account pool, settlement token, gas coin, server role, or account role, use different names for those concepts.
- Apply the same naming standard to public docs, API fields, exported types, function names, variable names, config files, tests, and examples. Code names and docs must not describe the same concept with different nouns.
- Keep action verbs tied to the owning boundary: HTTP routes use route actions, core-api handlers use `handle*`, SDK APIs use app-developer goals, MCP tools use snake_case agent actions, and Move entry functions use Move snake_case names.
- Keep promotion-sponsored flow names aligned as `PromotionSponsored` / `promotion_sponsored` across SDK, MCP, HTTP, and core-api.
- Use `SponsorOperations` for refill, probe, and state upkeep. Use `SponsorAvailability` for request admission checks.
- Use `Status` for read snapshots, `Result` for operation outputs, `Params` for handler inputs, `Request` and `Response` for transport bodies, and `Trace` for extracted Programmable Transaction Block paths.
- Avoid public boundary names that use `Data`, `Payload`, `Info`, `Ops`, `Terminal`, `Evidence`, `Bundle`, or `Checkpoint` unless the word is a current protocol term in code.
- Keep only current names in public docs, package exports, tests, and examples.
