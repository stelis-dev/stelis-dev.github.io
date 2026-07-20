import type { SponsorResultCallback } from '../handlers/sponsorResult.js';
import type { FinalSponsoredExecutionRecord } from './sponsoredExecutionRecords.js';
import { sponsorResultMetadata } from './sponsoredExecutionRecords.js';
import type { SponsoredExecutionStoreAdapter } from './sponsoredExecutionStore.js';

export type SponsorResultDeliveryResult = 'delivered' | 'still_pending';

/**
 * Attempt delivery of one durable final result.
 *
 * The durable final record remains the primary result. Callback or marker
 * failures keep delivery pending; cancellation is never converted into a
 * successful acknowledgement.
 */
export async function attemptSponsorResultDelivery(input: {
  readonly record: FinalSponsoredExecutionRecord;
  readonly callback: SponsorResultCallback;
  readonly store: Pick<SponsoredExecutionStoreAdapter, 'markCallbackDelivered'>;
  readonly signal?: AbortSignal;
}): Promise<SponsorResultDeliveryResult> {
  if (input.record.callbackDelivery === 'delivered') return 'delivered';

  input.signal?.throwIfAborted();
  try {
    await input.callback(sponsorResultMetadata(input.record.result), input.signal);
  } catch {
    input.signal?.throwIfAborted();
    return 'still_pending';
  }

  input.signal?.throwIfAborted();
  try {
    const marked = await input.store.markCallbackDelivered(input.record);
    return marked ? 'delivered' : 'still_pending';
  } catch {
    input.signal?.throwIfAborted();
    return 'still_pending';
  }
}
