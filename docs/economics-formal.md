# Economics Reference

This document records the current formulas used by relay cost calculation and sponsor approval.

The implementation is in [`packages/core-relay/src/gasEstimate.ts`](../packages/core-relay/src/gasEstimate.ts) and [`packages/core-relay/src/validate/nonloss.ts`](../packages/core-relay/src/validate/nonloss.ts).

## Gas Recovery Cost Calculation

All values are in MIST.

```text
simGas = max(0, computationCost + storageCost - storageRebate)
grossGas = computationCost + storageCost
gasVarianceFixedMist = 100000
executionCostClaim = simGas + gasVarianceFixedMist + slippageBufferMist
```

`slippageBufferMist` is used for swap paths. Credit-only paths use zero.

`executionCostClaim` is the gas-recovery component embedded in the settlement arguments. It is not the full settlement payout.
The settlement payout sent to the configured settlement payout recipient is:

```text
settlementPayout = executionCostClaim + quotedHostFeeMist
```

## Sponsor Approval Gate

The sponsor must reject a transaction when the execution cost claim is lower than the required claim:

```text
requiredClaim = simGas + gasVarianceFixedMist + slippageBufferMist
executionCostClaim >= requiredClaim
```

The sponsor also rejects when:

- `gasBudget > maxClaimMist`
- `simGas > maxClaimMist`

## On-Chain Settlement

Move settlement checks that:

- `execution_cost_claim_mist <= max_claim_mist`
- token-funded swap settlement input is at least `min_settle_mist`
- credit-only settlement is exempt from `min_settle_mist`
- settlement input covers execution cost claim, quoted host fee, and protocol fee
- quoted host fee is not above the on-chain host fee cap
- the expected config version matches the current on-chain config version
- the vault nonce advances monotonically

Move transfers `execution_cost_claim_mist + quoted_host_fee_mist` to `settlement_payout_recipient`.
The protocol flat fee is transferred separately to the protocol treasury.

## Recorder Economics

Runtime logs and sponsored-execution summaries use a non-negative paid-gas value:

```text
paidGas = max(0, computationCost + storageCost - storageRebate)
hostNetMist = recoveredGasMist + hostFeeMist - paidGas
```

`protocolFeeMist` is recorded as context, but it is not included in `hostNetMist`.

## Related Parameters

See [`parameters.md`](./parameters.md) for current constants and environment variables.
