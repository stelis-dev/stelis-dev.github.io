import { describe, expect, it } from 'vitest';
import type { SponsorSlotLeaseSummary } from '@stelis/contracts';
import {
  calculateSponsorAvailability,
  evaluateSponsorAvailability,
  type SponsorAvailabilityView,
} from '../../src/sponsor-operations/gate.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

const SLOT = `0x${'11'.repeat(32)}`;
const SETTINGS = createTestSponsorOperationsSettings({
  sponsorAddresses: [SLOT],
  warnMist: 5_000_000_000n,
  refillTargetMist: 10_000_000_000n,
  runwayTargetMist: 10_000_000_000n,
});

function view(overrides: Partial<SponsorAvailabilityView> = {}): SponsorAvailabilityView {
  return {
    settings: SETTINGS,
    slots: [
      {
        address: SLOT,
        state: 'healthy',
        addressBalanceMist: '10000000000',
        lastObservedAtMs: 1_700_000_000_000,
        lastError: null,
        writeSeq: 1,
        refillOperationId: null,
        refillOperationSequence: null,
        refillOperationState: null,
        refillRequiredSourceBalanceMist: null,
        observationFresh: true,
      },
    ],
    sponsorRefillAccount: {
      totalBalanceMist: '20000000000',
      healthy: true,
      lastObservedAtMs: 1_700_000_000_000,
      lastError: null,
      writeSeq: 1,
      observationFresh: true,
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
  it('uses the same current state and lease snapshot for public status and admission', () => {
    const current = calculateSponsorAvailability(view(), leases([{ address: SLOT, leased: true }]));
    expect(current).toMatchObject({
      healthySlots: 1,
      degradedSlots: 0,
      gateErrorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
      slots: [{ state: 'healthy' }],
      sponsorRefillAccount: { healthy: true },
    });
  });

  it('blocks prepare admission when every healthy sponsor slot is already leased', () => {
    expect(evaluateSponsorAvailability(view(), leases([{ address: SLOT, leased: true }]))).toEqual({
      allowed: false,
      errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
    });
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
    expect(evaluateSponsorAvailability(active, leases([{ address: SLOT, leased: false }]))).toEqual(
      {
        allowed: false,
        errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
      },
    );
  });

  it('admits prepare admission when a healthy sponsor slot is free', () => {
    expect(evaluateSponsorAvailability(view(), leases([{ address: SLOT, leased: false }]))).toEqual(
      { allowed: true },
    );
  });

  it('keeps sponsor refill account unhealthy precedence when no slot is healthy', () => {
    expect(
      evaluateSponsorAvailability(
        view({
          slots: [
            {
              address: SLOT,
              state: 'rpc_unreachable',
              addressBalanceMist: null,
              lastObservedAtMs: 1_700_000_000_000,
              lastError: 'rpc down',
              writeSeq: 1,
              refillOperationId: null,
              refillOperationSequence: null,
              refillOperationState: null,
              refillRequiredSourceBalanceMist: null,
              observationFresh: false,
            },
          ],
          sponsorRefillAccount: {
            totalBalanceMist: null,
            healthy: false,
            lastObservedAtMs: 1_700_000_000_000,
            lastError: 'sponsor refill account rpc down',
            writeSeq: 1,
            observationFresh: false,
          },
        }),
        leases([{ address: SLOT, leased: false }]),
      ),
    ).toEqual({ allowed: false, errorCode: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY' });
  });

  it('rejects a healthy stored slot after its Redis-time observation expires', () => {
    const base = view();
    const current = calculateSponsorAvailability(
      {
        ...base,
        slots: [{ ...base.slots[0]!, observationFresh: false }],
      },
      leases([{ address: SLOT, leased: false }]),
    );
    expect(current.slots[0]?.state).toBe('rpc_unreachable');
    expect(current.healthySlots).toBe(0);
    expect(
      evaluateSponsorAvailability(
        {
          ...base,
          slots: [{ ...base.slots[0]!, observationFresh: false }],
        },
        leases([{ address: SLOT, leased: false }]),
      ),
    ).toEqual({ allowed: false, errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' });
  });
});
