import { describe, expect, it } from 'vitest';
import type { SponsorSlotLeaseSummary } from '@stelis/contracts';
import {
  deriveSponsorAvailabilitySummary,
  evaluateSponsorAvailability,
  type SponsorAvailabilityView,
} from '../../src/sponsor-operations/gate.js';

function view(overrides: Partial<SponsorAvailabilityView> = {}): SponsorAvailabilityView {
  return {
    slots: [
      {
        address: '0xslot1',
        state: 'healthy',
        balanceMist: '10000000000',
        lastObservedAtMs: 1_700_000_000_000,
        lastError: null,
        writeSeq: 1,
        pendingRefillDigest: null,
        refillAttemptedAmountMist: null,
        refillObservedBalanceMist: null,
        refillReconciliationResult: null,
        refillOperationId: null,
        refillOperationSequence: null,
        refillOperationState: null,
        refillRequiredSourceBalanceMist: null,
      },
    ],
    sponsorRefillAccount: {
      balanceMist: '20000000000',
      healthy: true,
      refillsRemaining: 2,
      lastObservedAtMs: 1_700_000_000_000,
      lastError: null,
      writeSeq: 1,
    },
    ...overrides,
  };
}

function leases(slots: SponsorSlotLeaseSummary['slots']): SponsorSlotLeaseSummary {
  const leasedSlots = slots.filter((slot) => slot.leased).length;
  return {
    leasedSlots,
    freeSlots: slots.length - leasedSlots,
    slots,
  };
}

describe('sponsor operations gate', () => {
  it('keeps the summary health-based for admin status', () => {
    expect(deriveSponsorAvailabilitySummary(view())).toEqual({
      availableSlots: 1,
      degradedSlots: 0,
      gateErrorCode: null,
    });
  });

  it('admits sponsor-path health checks even when the healthy slot is leased', () => {
    expect(
      evaluateSponsorAvailability(view(), {
        slotLeases: leases([{ address: '0xslot1', leased: true }]),
      }),
    ).toEqual({ allowed: true });
  });

  it('blocks prepare admission when every healthy sponsor slot is already leased', () => {
    expect(
      evaluateSponsorAvailability(view(), {
        requireFreeSponsorSlot: true,
        slotLeases: leases([{ address: '0xslot1', leased: true }]),
      }),
    ).toEqual({ allowed: false, errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' });
  });

  it('does not admit a slot whose durable refill operation is active even if its balance projection says healthy', () => {
    const base = view();
    const active = view({
      slots: [
        {
          ...base.slots[0]!,
          refillOperationId: 'refill-a',
          refillOperationSequence: 3,
          refillOperationState: 'ready',
        },
      ],
    });
    expect(evaluateSponsorAvailability(active)).toEqual({
      allowed: false,
      errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
    });
  });

  it('admits prepare admission when a healthy sponsor slot is free', () => {
    expect(
      evaluateSponsorAvailability(view(), {
        requireFreeSponsorSlot: true,
        slotLeases: leases([{ address: '0xslot1', leased: false }]),
      }),
    ).toEqual({ allowed: true });
  });

  it('blocks prepare admission when lease data is required but absent', () => {
    expect(
      evaluateSponsorAvailability(view(), {
        requireFreeSponsorSlot: true,
      }),
    ).toEqual({ allowed: false, errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' });
  });

  it('keeps sponsor refill account unhealthy precedence when no slot is healthy', () => {
    expect(
      evaluateSponsorAvailability(
        view({
          slots: [
            {
              address: '0xslot1',
              state: 'rpc_unreachable',
              balanceMist: null,
              lastObservedAtMs: 1_700_000_000_000,
              lastError: 'rpc down',
              writeSeq: 1,
              pendingRefillDigest: null,
              refillAttemptedAmountMist: null,
              refillObservedBalanceMist: null,
              refillReconciliationResult: null,
              refillOperationId: null,
              refillOperationSequence: null,
              refillOperationState: null,
              refillRequiredSourceBalanceMist: null,
            },
          ],
          sponsorRefillAccount: {
            balanceMist: null,
            healthy: false,
            refillsRemaining: null,
            lastObservedAtMs: 1_700_000_000_000,
            lastError: 'sponsor refill account rpc down',
            writeSeq: 1,
          },
        }),
        {
          requireFreeSponsorSlot: true,
          slotLeases: leases([{ address: '0xslot1', leased: false }]),
        },
      ),
    ).toEqual({ allowed: false, errorCode: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY' });
  });
});
