# Security Model

This document summarizes the current security boundaries that are visible in the code.

## Main Boundaries

| Boundary                     | Current rule                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User assets                  | User vault assets are owned on-chain by the user.                                                                                                                    |
| Sponsor gas                  | User commands must not reference `GasCoin` or use `FundsWithdrawal(Sponsor)`.                                                                                        |
| User TransactionKind         | Generic `/relay/prepare` accepts only a user-supplied `User TransactionKind` with zero settlement calls and at most 11 commands.                                     |
| Final Host-built transaction | The Host-built generic transaction must contain exactly one allowed settlement call and at most 16 commands.                                                         |
| Settlement-token funding     | The Host combines coin object provenance with `FundsWithdrawal(Sender)` address-balance accounting.                                                                  |
| Prepare authorization        | Generic prepare requires a sender personal-message signature over the transaction-kind hash and request fields.                                                      |
| Settlement swap path         | Relay validation accepts only configured settlement swap paths. Each supported `settlementTokenType` maps to one SUI-adjacent DeepBook one-hop settlement swap path. |
| Prepare records              | Prepare records are single-use and time-limited.                                                                                                                     |
| Promotion calls              | Promotion-sponsored transactions contain 1 to 16 `MoveCall` commands, all matching `STUDIO_ALLOWED_TARGETS`; the Host adds no commands.                              |
| Admin routes                 | `/admin/*` routes require an admin session; a supplied browser Origin must match `ADMIN_APP_ORIGIN`.                                                                 |

## Web3 Security Policy

Move contracts enforce vault ownership, settlement input checks, execution cost claim caps, pause behavior, and admin-only config changes.

Relay validation adds off-chain checks before the sponsor signs:

- user-supplied `User TransactionKind` checks
- final Host-built transaction shape checks
- settlement argument checks
- settlement swap path authorization
- settlement-token funding checks using coin object provenance and `FundsWithdrawal(Sender)` address-balance accounting
- non-loss math
- policy-hash binding
- gas-owner and sponsor checks

## Sponsor SUI Security

Sponsor SUI state and transitions are defined in [`Sponsor Pools`](./architecture/sponsor-pools.md#sponsor-sui-state).

The sponsor slot is the `gasOwner` for sponsored transactions. User-supplied commands cannot use sponsor SUI through `GasCoin` or `FundsWithdrawal(Sponsor)`. This protects both sponsor gas coin objects and sponsor address-balance gas.

Final settlement validation rejects a `settlement_payout_recipient` that does not match the configured settlement payout recipient. This prevents a user-supplied transaction from redirecting settlement payout, including deployments where the settlement payout recipient is also the Sponsor Refill Account.

Failed sponsored execution can spend sponsor gas without producing settlement payout. The Host uses preflight simulation, sponsor failure abuse recording, and blocked request checks to limit failed-execution gas griefing.

Sponsor Refill Account withdrawal is privileged. The withdrawal route requires admin session validation, a network-bound signed single-use withdrawal nonce, admin-operation rate limiting, operation logging, simulation, and the shared durable account-spend runway checks. Pending outcomes retain and retry the exact signed request on that network; a new nonce is not a recovery mechanism.

## Web2 Security Policy (API and Infrastructure)

The Host runtime adds request and operations controls:

- Redis-backed sponsored execution store
- rate limiting
- abuse blocking
- sponsor slot leasing
- aggregate sponsor capacity checks before prepare and a fresh receipt-assigned sponsor balance check before execution
- admin session validation

Host composition first selects the route implementation for the booted mode.
Each mounted Relay, Studio, Auth, or Admin route then applies its relevant
checks in a fail-closed order beginning with client-IP admission. In
particular, SponsorOperations and sponsor-lease reads for Relay prepare do not
occur until wallet authorization and sender admission succeed. Admin Promotion
routes complete bounded-body, Admin-session, and authenticated-subject
admission before checking Studio capability; an Admin-only Host returns
`STUDIO_UNAVAILABLE` without Promotion-domain I/O.
The exact HTTP header and mode contract is in
[`API Reference → Request admission`](./api.md#request-admission).

Generic `/relay/prepare` requires signed prepare authorization before the prepare state machine performs sponsor slot checkout, nonce reservation, on-chain reads, or transaction building. The Host recomputes `txKindBytesHash`, verifies the sender personal-message signature, enforces the prepare authorization timestamp window, and rejects reused prepare authorization nonces.

Production deployments still place the API behind upstream traffic controls such as a WAF, CDN, or gateway rate limiter. The signed prepare boundary proves sender control, but it is not a perimeter replacement for traffic shaping.

## Studio Promotion Security

Studio promotion routes use developer JWTs. The Host verifies JWTs against `STUDIO_DEVELOPER_JWT_TRUST_JSON`. It validates the complete local Admin and Studio configuration before Sui endpoint qualification begins.

An optional developer-verification callback must use HTTPS, apart from exact
loopback HTTP hostnames, and cannot contain embedded credentials or a URL
fragment. The callback POST omits ambient credentials and refuses redirects so
the developer JWT is sent only to the URL accepted at boot.

Promotion prepare and sponsor routes also check:

- 1 to 16 `MoveCall` commands
- promotion status and user entitlement
- sender address from the verified identity
- allowed Move call targets
- promotion budget and gas allowance
- prepared transaction binding

## Code References

- Relay routes: [`packages/app-api/src/routes/relay.ts`](../packages/app-api/src/routes/relay.ts)
- Promotion routes: [`packages/app-api/src/routes/studio.ts`](../packages/app-api/src/routes/studio.ts)
- Studio auth middleware: [`packages/app-api/src/middleware/studioAuth.ts`](../packages/app-api/src/middleware/studioAuth.ts)
- Relay validation: [`packages/core-relay/src/validate`](../packages/core-relay/src/validate)
