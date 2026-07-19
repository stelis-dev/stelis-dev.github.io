import { describe, expect, test, vi } from 'vitest';
import {
  storeSponsorResult,
  type FinalSponsoredExecutionRecord,
} from '../src/store/sponsoredExecutionRecords.js';
import { attemptSponsorResultDelivery } from '../src/store/sponsorResultDelivery.js';

function finalRecord(callbackDelivery: 'pending' | 'delivered'): FinalSponsoredExecutionRecord {
  return {
    state: 'final',
    receiptId: `0x${'11'.repeat(32)}`,
    sponsorAddress: `0x${'22'.repeat(32)}`,
    transactionDigest: null,
    finalizedAtMs: 1,
    callbackDelivery,
    result: storeSponsorResult({
      sponsorAddress: `0x${'22'.repeat(32)}`,
      outcome: 'validation_failure',
      executionStage: 'before_sponsor_signature',
      route: 'generic',
      receiptId: `0x${'11'.repeat(32)}`,
      senderAddress: `0x${'33'.repeat(32)}`,
      executionPathKey: 'generic:test',
      orderIdHash: null,
      promotionId: null,
      userId: null,
      economics: { economicsStatus: 'unknown', failureReason: 'validation failure' },
    }),
  };
}

describe('sponsor result delivery owner', () => {
  test('delivers and acknowledges a pending record, while an acknowledged record is terminal', async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const markCallbackDelivered = vi.fn().mockResolvedValue(true);

    await expect(
      attemptSponsorResultDelivery({
        record: finalRecord('pending'),
        callback,
        store: { markCallbackDelivered },
      }),
    ).resolves.toBe('delivered');
    await expect(
      attemptSponsorResultDelivery({
        record: finalRecord('delivered'),
        callback,
        store: { markCallbackDelivered },
      }),
    ).resolves.toBe('delivered');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(markCallbackDelivered).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: 'callback failure',
      callback: vi.fn().mockRejectedValue(new Error('callback failed')),
      marker: vi.fn().mockResolvedValue(true),
      markerCalls: 0,
    },
    {
      name: 'compare-and-set rejection',
      callback: vi.fn().mockResolvedValue(undefined),
      marker: vi.fn().mockResolvedValue(false),
      markerCalls: 1,
    },
    {
      name: 'marker failure',
      callback: vi.fn().mockResolvedValue(undefined),
      marker: vi.fn().mockRejectedValue(new Error('store failed')),
      markerCalls: 1,
    },
  ])('keeps delivery pending after $name', async ({ callback, marker, markerCalls }) => {
    await expect(
      attemptSponsorResultDelivery({
        record: finalRecord('pending'),
        callback,
        store: { markCallbackDelivered: marker },
      }),
    ).resolves.toBe('still_pending');
    expect(marker).toHaveBeenCalledTimes(markerCalls);
  });

  test('does not acknowledge delivery after lifecycle cancellation', async () => {
    const controller = new AbortController();
    const markCallbackDelivered = vi.fn().mockResolvedValue(true);
    const callback = vi.fn(async () => {
      controller.abort(new Error('stopping'));
    });

    await expect(
      attemptSponsorResultDelivery({
        record: finalRecord('pending'),
        callback,
        store: { markCallbackDelivered },
        signal: controller.signal,
      }),
    ).rejects.toThrow('stopping');
    expect(markCallbackDelivered).not.toHaveBeenCalled();
  });
});
