# Pricing and Validation

This document summarizes current relay pricing and validation behavior.

## Non-Loss Pricing Model

The relay computes:

```text
simGas = max(0, computationCost + storageCost - storageRebate)
executionCostClaim = simGas + gasVarianceFixedMist + slippageBufferMist
```

Current `gasVarianceFixedMist` is `100000`.
`executionCostClaim` is the gas-recovery claim in the settlement arguments. The full settlement payout is `executionCostClaim + quotedHostFeeMist`, paid to the configured settlement payout recipient address during Move settlement.

## Sponsor Approval Flow

<a id="sponsor-approval-flow"></a>

Before signing, the sponsor checks:

1. the prepared transaction can still be found and consumed once;
2. the submitted transaction bytes match the prepared record;
3. settlement arguments still match current config and Host policy;
4. preflight simulation succeeds;
5. non-loss math passes;
6. the sponsor slot can sign and submit.

## Sponsor Failure Classification

<a id="sponsor-failure-classification"></a>

Sponsor failures are mapped by `packages/app-api/src/errorMap.ts` and failure classification code in `@stelis/core-api`.

Client guidance:

- `LEASE_EXPIRED`: prepare again.
- `REPREPARE_REQUIRED`: prepare again because server-side binding or config changed.
- `ABUSE_BLOCKED`: back off until the server-provided retry time.
- validation errors: fix the transaction or settlement swap path choice before retrying.

## Validation Layers

| Layer                   | Checks                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| User-command validation | command count, forbidden command kinds, `GasCoin` references, direct Stelis calls                                       |
| Settlement validation   | config object, vault registry object, settlement payout recipient address, settlement swap path authorization, fee caps |
| Non-loss validation     | execution cost claim, gas budget, simulated gas cap                                                                     |
| Move validation         | vault ownership, settlement minimums, pause state, admin-only config                                                    |

## PTB Validation Layer Contract

Programmable Transaction Block (PTB) validation is split by ownership boundary. The
same primitive checks can appear in more than one layer, but each layer answers a
different question.

| Layer                                           | Owner                                                        | Current role                                                                                                                                                                                                                                                                              | Shared primitives                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Generic user `TransactionKind` gate             | SDK prepare pre-check and generic `/relay/prepare`           | Rejects a user-supplied `TransactionKind` before the Host appends settlement. It requires zero settlement calls, allows at most 11 user commands, rejects `GasCoin`, rejects `FundsWithdrawal(Sponsor)`, and rejects unaccountable same-token `FundsWithdrawal(Sender)`.                     | `validateGenericUserTransactionKind`                                                                        |
| Generic final settlement transaction validation | Generic prepare self-check and `/relay/sponsor` revalidation | Validates the Host-built final transaction after settlement is appended. It requires exactly one allowed settlement call and at most 16 total commands. It does not repeat user-prefix address-balance accounting because final funding may add `FundsWithdrawal(Sender)` inputs.        | `validatePtbStructure`, `containsGasCoinReference`                                                          |
| Promotion-sponsored policy                      | Promotion prepare and sponsor paths                          | Keeps promotion-specific rules separate from the generic validator. Promotion transactions contain 1 to 16 MoveCall-only commands, must not reference `GasCoin`, and use promotion-owned target and entitlement checks. The Host adds no commands; prepare also rejects `FundsWithdrawal(Sponsor)`. | `containsGasCoinReference`, `containsSponsorWithdrawal`, `isMoveCall`                                    |
| SDK returned-transaction integrity verification | `@stelis/sdk` after the Host returns transaction bytes       | Verifies that returned transaction bytes preserve the user's prefix and append only the expected settlement suffix. This is a client-side integrity layer, not the user `TransactionKind` gate and not the server final-transaction validator.                                            | `convertSdkCommands`, `containsGasCoinReference`, `isMoveCall`, `integrityCompare`                          |
| Prefix value and funding resolution             | Generic prepare build                                        | Traces direct coin identity and command-ordered split/merge value, then accounts for same-token `FundsWithdrawal(Sender)` use before selecting the exact funding objects and redeem amount. This is not an admissibility gate replacement.                                                | `traceUserPrefixValue`, `resolvePaymentSource`                                                              |

The phrase "source of truth" must name the layer. For example,
`validateGenericUserTransactionKind` is the shared SDK/server source for the
generic user `TransactionKind` gate. It is not the source for SDK
returned-transaction integrity verification, promotion policy, or prefix value
and funding resolution.

The SDK returned-transaction integrity layer deliberately reuses core-relay
primitives while keeping its own rule assembly. Its job is to check the bytes
returned by the Host before the SDK asks the user to sign them. Refactoring this
layer into a shared validator is a separate refactor task, not current behavior;
the current behavior is documented here without adding a compatibility path or
alternate validation name.
