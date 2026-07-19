# AGENTS.md

This file defines the package-policy and naming rules agents must preserve while working in this repository.

## Project Context

Stelis lets apps run programmable Sui transactions without asking users to manage SUI gas first. A deployed Host pays SUI gas for sponsored execution, and generic settlement can recover the execution cost from supported user-held value.

Use these terms consistently:

- `Host`: the deployed `@stelis/app-api` service. It exposes HTTP APIs, sponsors transactions, and enforces settlement policy.
- `Relay API`: the public `/relay/*` HTTP API exposed by a Host.
- `SDK`: `@stelis/sdk`, the app and service developer package for building integrations against a Host.
- `MCP server`: `@stelis/mcp-server`, the agent-facing tool package. It calls a Host over HTTP. It does not build arbitrary transactions, hold keys, sign for users, or run Host server logic.
- `Move package`: `packages/contracts/move`, the on-chain settlement and vault artifact.

If a rule below mentions an unfamiliar package, first decide whether the package is a deployed/published product surface or an internal source-of-truth package. That distinction controls dependency, export, and naming decisions.

## General Agent Discipline

- Do not work from imagination, memory, previous answers, or progress notes alone. Read the relevant files from disk before making claims or edits.
- Inspect the current repository state before editing and before the final response. At minimum, check `git status --short` when your answer depends on pending files or completion state.
- Do not say a command, test, build, lint, deployment, or verification passed unless you actually ran it and observed success in this turn or explicitly state the earlier run you are relying on.
- If a check is not run, say exactly what was skipped and what risk remains.
- Treat a commit, note, or plan as evidence, not proof of completion. Completion requires the requested behavior, affected docs/code/interfaces, and relevant verification to line up.
- For non-trivial work, keep the accepted task name stable. Do not rename, split, or reframe work to make incomplete work look complete.
- Every changed line should trace to the user request, an accepted plan, or an affected shared invariant. Avoid drive-by cleanup.

## Review and Verification Discipline

### Verification Order

Review the affected boundary in this order:

1. Define the correctness model first: responsibilities, invariants, allowed
   state transitions, points at which changes become durable or externally
   visible, terminal outcomes, rollback behavior where rollback is possible,
   failure outcomes, recovery, and cleanup.
2. Derive boundary and adversarial checks from that model. Inspect malformed
   input, parameter combinations, individual and aggregate size limits, numeric
   limits, stale state, concurrency, cancellation, deadlines, ambiguous
   outcomes such as lost responses, storage and memory limits, and error
   precedence where they apply.
3. Audit the tests independently. Do not accept a test as proof of the complete
   boundary when it uses test-only production behavior, derives its oracle from
   the implementation under test, bypasses production composition, manipulates
   the outcome, or verifies only isolated components.

Every layer is required. Boundary checks do not replace structural reasoning,
and structural reasoning does not replace boundary checks. A counterexample
that exposes an incomplete or incorrect correctness model must update that
model and its checks.

Test quantity, branch quantity, and exhaustive parameter enumeration are not
proof of correctness. Prefer a small number of checks that can falsify distinct
invariants over many overlapping or low-value examples.

## Completion Reporting Rule

- When reporting the result of an accepted user request, the outcome is binary: success or failure. Do not report an intermediate completion state for the task itself.
- Judge success against the accepted user request, including reasonably expected verification, not against effort, partial progress, or honest disclosure.
- If any required part is blocked, partial, missing, or unverified, report failure to complete unless the user explicitly narrowed the request to that smaller result.
- State the outcome first, then the cause. For example: `Failed to complete: blocked by X` or `Failed to complete: implemented but not verified`.
- Use `blocked` only as a cause of failure, not as a neutral final state.
- Do not soften failure with phrases such as `mostly done`, `should be fine`, `completed except tests`, or `partial complete`.
- Caveats are supporting details, not substitutes for a clear success/failure statement.

## Stelis-Specific Safety Rules

- Treat MIST, SUI, gas, token amounts, balances, quotes, fees, nonces, object IDs, transaction bytes, and settlement values as safety-critical data.
- Keep raw amounts as integer strings or `BigInt` values when precision matters. Do not use floating point arithmetic for settlement, fee, gas, quote, or signable quantities.
- Keep display values presentation-only. Do not feed formatted UI strings back into transaction building, settlement, signing, validation, or persistence without an explicit raw conversion step.
- Do not infer token decimals, token identity, network identity, settlement eligibility, path support, or liquidity readiness from symbols, labels, memory, or convenience defaults.
- Apply Move deployment policy by network: testnet contract changes use a fresh
  package deployment under the anti-legacy policy; after a mainnet package is
  deployed, mainnet contract evolution uses Sui package upgrades. In both cases,
  code and docs expose only the current interface and IDs—do not retain legacy
  aliases, compatibility readers, or parallel old-package paths.
- Preserve current boundary terms: `Host`, `Relay API`, `settlement token`, `settlement swap path`, `SponsorOperations`, `SponsorAvailability`, and `User Vault`.
- Keep `@stelis/sdk`, `@stelis/mcp-server`, and `@stelis/app-api` responsibilities separate. The MCP server does not hold keys, sign for users, build arbitrary transaction content, or run Host server logic.
- Public docs, examples, schemas, package exports, tests, and user-facing strings describe current behavior only. Put future work, unsupported behavior, and discovered gaps in planning or debt notes, not public current-state docs.

## Do Not Import Rules From Other Projects

Rules from other repositories may be useful as inspiration, but do not copy project-specific boundaries into Stelis. In particular, do not add rules about firmware state models, hardware approval flows, device flashing, tax/P&L/fiat cash-out, peg guarantees, unrelated protocol-adapter roadmaps, or another repository's command list unless Stelis explicitly adopts that product surface.

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

## Shared Process Ownership

- When more than one code path performs the same ordered operation with the same
  responsibilities, invariants, lifecycle, points at which changes become
  durable or externally visible, terminal outcomes, failure behavior, and
  cleanup requirements, implement that operation through one owner.
- Sharing utility functions is not sufficient when each caller still controls
  the order, validation, state changes, commit or rollback, error handling,
  recovery, or cleanup.
- Pass caller-specific data and external dependencies through a narrow,
  validated input. Do not make callers configure, bypass, reorder, or reproduce
  the shared operation's internal rules.
- Repeated syntax alone is not evidence of a shared process. Keep operations
  separate when they have different responsibilities, state lifecycles,
  durable or externally visible effects, terminal outcomes, failure meanings,
  trust boundaries, or independent verification purposes.
- Do not create a generic wrapper merely to remove repeated code. A wrapper that
  only forwards calls or delegates its internal decisions back to callbacks
  does not provide shared process ownership.

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
