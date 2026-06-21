# Payment and Promotion Flows

This document defines the product terms used by SDK, web app, and API package docs.

## Product Family Terms

| Term | Meaning |
| --- | --- |
| Host | A deployed `@stelis/app-api` execution environment that exposes the Relay API |
| Relay API | The `/relay/*` HTTP interface exposed by a Host |
| Host operator | The party that deploys and operates a Host and its Admin app |
| Admin app | The operator tool used to manage Host settings, sponsor state, settlement swap paths, and operating policy |
| Studio | Promotion and policy-controlled flows layered on the same Host |
| settlement token | A token accepted by a Host as the source for execution-cost settlement. API fields may use `settlementTokenType` for the token's Sui coin type. |
| User Vault | A user-owned Move object that stores reusable settlement credit. User Vault credit remains user-owned, is not Host-owned balance, and cannot be treated as Host liquidity. |
| Host execution role | The internal Host role for execution, sponsorship, and settlement fields such as `settlementPayoutRecipient`, `executionCostClaim`, and `hostFee` |

## Sponsored Execution Operating Model

A Host pays SUI gas for sponsored execution, but generic settlement is not modeled as a pure subsidy. When a generic sponsored transaction succeeds, settlement can recover the execution cost and configured host fee from the user's settlement source.

This makes settlement swap path liquidity part of Host operations. A Host should only advertise settlement tokens and paths it is prepared to price, admit, and operate.

## Generic Settlement Flow

The generic flow uses:

- `POST /relay/prepare`
- `POST /relay/sponsor`

It can include `orderId` tracking. Backends that track `receiptId` can verify the resulting on-chain `SettleEvent` with `verifySettleEventAgainstExpected` from `@stelis/sdk/server` by passing application-owned expected fields: `receiptId`, `user`, and `orderId` or `orderIdHash`. Amount-sensitive integrations also pass expected host and protocol fee values.

A `SettleEvent` is settlement evidence. Application payment completion is decided by comparing the event with the application's expected fields.

## Promotion-Sponsored Flow

Promotion-sponsored flow uses:

- `GET /studio/promotions`
- `GET /studio/promotions/:id`
- `POST /studio/promotions/:id/claim`
- `POST /studio/promotions/:id/prepare`
- `POST /studio/promotions/:id/sponsor`

These routes require a developer JWT. The promotion budget pays gas directly. Promotion-sponsored flows do not use the generic settlement Programmable Transaction Block (PTB) and do not emit a Stelis `SettleEvent`.

## Responsibility Split

| Party | Owns |
| --- | --- |
| App or service developer | wallet UX, user signing, backend identity, and fulfillment |
| Agent runtime | tool orchestration and user approval policy |
| Host operator | deployed Host runtime, sponsor funding, settlement swap path config, and operations |
| Stelis packages | SDK, MCP server, Host runtime, web apps, internal validation packages, and Move package |
