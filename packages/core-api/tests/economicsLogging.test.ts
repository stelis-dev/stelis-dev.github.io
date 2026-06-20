import { describe, expect, it } from 'vitest';
import { buildSettlementEconomicsSnapshot } from '../src/economicsLogging.js';

describe('economics logging snapshot', () => {
  it('computes gross_gas, net_gas, payout, and payout_net consistently', () => {
    const snapshot = buildSettlementEconomicsSnapshot({
      gasUsed: {
        computationCost: '800000',
        storageCost: '200000',
        storageRebate: '300000',
      },
      executionCostClaim: 1_200_000n,
      feeCharged: 100_000n,
      protocolFee: 20_000n,
    });

    expect(snapshot.grossGas).toBe(1_000_000n);
    expect(snapshot.storageRebate).toBe(300_000n);
    expect(snapshot.netGas).toBe(700_000n);
    expect(snapshot.payout).toBe(1_300_000n);
    expect(snapshot.payoutNet).toBe(600_000n);
    expect(snapshot.protocolFee).toBe(20_000n);
  });

  it('preserves raw storageRebate verbatim even when storageRebate >= grossGas (netGas clamps to 0; rebate does NOT)', () => {
    // Regression: a delete-objects-only TX produces rebate-heavy
    // effects. The canonical 0-clamp at `gasEstimate.ts:119-122`
    // applies to `netGas` (the host-paid amount); the raw
    // `storageRebate` is on-chain truth and must be preserved
    // verbatim on the snapshot so observability outputs (recorder
    // row, structured event log) keep the actual rebate even when
    // `netGas` reads 0.
    const snapshot = buildSettlementEconomicsSnapshot({
      gasUsed: {
        computationCost: '500000',
        storageCost: '300000',
        storageRebate: '2000000',
      },
      executionCostClaim: 1_200_000n,
      feeCharged: 100_000n,
      protocolFee: 20_000n,
    });

    expect(snapshot.grossGas).toBe(800_000n);
    // Raw rebate verbatim — NOT min(rebate, grossGas).
    expect(snapshot.storageRebate).toBe(2_000_000n);
    // netGas clamped to 0 (raw would be -1_200_000n).
    expect(snapshot.netGas).toBe(0n);
    expect(snapshot.payout).toBe(1_300_000n);
    // payoutNet = payout - clamped netGas = 1_300_000n - 0n.
    expect(snapshot.payoutNet).toBe(1_300_000n);
  });

  it('rejects non-canonical gas amount strings', () => {
    expect(() =>
      buildSettlementEconomicsSnapshot({
        gasUsed: {
          computationCost: '1000',
          storageCost: '0x10',
          storageRebate: '0',
        },
        executionCostClaim: 1_200_000n,
        feeCharged: 100_000n,
        protocolFee: 20_000n,
      }),
    ).toThrow('gasUsed.storageCost must be a non-negative decimal integer string');
  });
});
