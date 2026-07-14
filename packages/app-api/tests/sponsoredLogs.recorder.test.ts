import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SponsorResultMetadata } from '@stelis/core-api';
import { createSponsoredLogsRecorder, fanOutSponsorResult } from '../src/sponsoredLogs/recorder.js';
import type { SponsoredLogsStoreAdapter } from '../src/sponsoredLogs/store.js';
import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
} from '../src/sponsoredLogs/types.js';

class CapturingStore implements SponsoredLogsStoreAdapter {
  readonly appended: SponsoredExecutionLogEntry[] = [];
  shouldThrow = false;

  async append(entry: SponsoredExecutionLogEntry): Promise<void> {
    if (this.shouldThrow) throw new Error('store boom');
    this.appended.push(entry);
  }

  async getSummary(mode: SponsoredExecutionAggregateMode): Promise<SponsoredExecutionAggregate> {
    return {
      mode,
      sponsoredExecutions: '0',
      lossCount: '0',
      cumulativeHostNetMist: '0',
      cumulativeLossMist: '0',
    };
  }

  async getRecent(): Promise<readonly SponsoredExecutionLogEntry[]> {
    return [];
  }
}

const FROZEN_TS = '2026-04-26T16:00:00.000Z';
const fixedClock = () => new Date(FROZEN_TS);

function makeMetadata(overrides: Partial<SponsorResultMetadata> = {}): SponsorResultMetadata {
  const base: SponsorResultMetadata = {
    sponsorAddress: '0xsponsor',
    outcome: 'success',
    executionStage: 'on_chain',
    route: 'generic',
    digest: '0xdigest',
    receiptId: 'r1',
    senderAddress: '0xsender',
    executionPathKey: 'rk',
    orderIdHash: 'abcdef',
    promotionId: null,
    userId: null,
    economics: {
      economicsStatus: 'known',
      recoveredGasMist: '12000',
      hostPaidGasMist: '8000',
      hostFeeMist: '1000',
      protocolFeeMist: '50',
      hostNetMist: '5000',
      grossGasMist: '9500',
      storageRebateMist: '1500',
      failureReason: null,
    },
  };
  return { ...base, ...overrides } as SponsorResultMetadata;
}

function withoutDigest(metadata: SponsorResultMetadata): SponsorResultMetadata {
  const { digest: _digest, ...without } = metadata;
  return without;
}

describe('createSponsoredLogsRecorder — outcome filter', () => {
  it('records success outcome', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(makeMetadata({ outcome: 'success' }));
    expect(store.appended).toHaveLength(1);
  });

  it('records onchain_revert outcome', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'onchain_revert',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '7000',
          hostFeeMist: '0',
          hostNetMist: '-7000',
          grossGasMist: '8000',
          storageRebateMist: '1000',
          protocolFeeMist: '0',
          failureReason: 'on-chain revert',
        },
      }),
    );
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].outcome).toBe('onchain_revert');
    expect(store.appended[0].hostNetMist).toBe('-7000');
  });

  it('skips congestion / preflight / validation', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    for (const [outcome, executionStage] of [
      ['congestion', 'after_sponsor_signature'],
      ['preflight_failure', 'before_sponsor_signature'],
      ['preflight_failure', 'on_chain'],
      ['validation_failure', 'before_sponsor_signature'],
    ] as const) {
      await cb(
        makeMetadata({
          outcome,
          executionStage,
          economics: { economicsStatus: 'unknown', failureReason: outcome },
        }),
      );
    }
    expect(store.appended).toHaveLength(0);
  });

  it('skips an internal error before the sponsor signature regardless of diagnostic text', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        executionStage: 'before_sponsor_signature',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'unrelated diagnostic text',
        },
      }),
    );
    expect(store.appended).toHaveLength(0);
  });

  it('records post-signature internal uncertainty without parsing failureReason', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        executionStage: 'after_sponsor_signature',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'rpc transport error',
        },
      }),
    );
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].outcome).toBe('internal_error');
    expect(store.appended[0].economicsStatus).toBe('unknown');
    expect(store.appended[0].failureReason).toBe('rpc transport error');
    // Numeric honesty: every monetary field must be null on the
    // unknown-economics row — recorder must not coerce an unknown
    // amount.
    expect(store.appended[0].hostPaidGasMist).toBeNull();
    expect(store.appended[0].recoveredGasMist).toBeNull();
    expect(store.appended[0].hostNetMist).toBeNull();
  });

  it('never persists numeric certainty for an after-signature uncertain row', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        executionStage: 'after_sponsor_signature',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '999',
          hostPaidGasMist: '999',
          hostFeeMist: '0',
          hostNetMist: '0',
          grossGasMist: '999',
          storageRebateMist: '0',
          protocolFeeMist: null,
          failureReason: 'malformed producer economics',
        },
      }),
    );

    expect(store.appended[0]).toMatchObject({
      economicsStatus: 'unknown',
      recoveredGasMist: null,
      hostPaidGasMist: null,
      hostFeeMist: null,
      hostNetMist: null,
    });
  });

  it('skips confirmed congestion even though it is after the sponsor signature', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'congestion',
        executionStage: 'after_sponsor_signature',
        route: 'generic',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'confirmed shared-object congestion',
        },
      }),
    );
    expect(store.appended).toHaveLength(0);
  });
});

describe('createSponsoredLogsRecorder — entry fields', () => {
  it('maps known economics 1:1 from sponsor result metadata to log entry', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(makeMetadata());
    const e = store.appended[0];
    expect(e).toMatchObject({
      createdAt: FROZEN_TS,
      mode: 'generic',
      outcome: 'success',
      receiptId: 'r1',
      digest: '0xdigest',
      senderAddress: '0xsender',
      sponsorAddress: '0xsponsor',
      executionPathKey: 'rk',
      orderIdHash: 'abcdef',
      promotionId: null,
      userId: null,
      recoveredGasMist: '12000',
      hostPaidGasMist: '8000',
      hostNetMist: '5000',
      hostFeeMist: '1000',
      protocolFeeMist: '50',
      grossGasMist: '9500',
      storageRebateMist: '1500',
      economicsStatus: 'known',
    });
  });

  it('maps unknown economics — every numeric field including hostFeeMist is null', async () => {
    // Numeric honesty lock: an unknown-economics row MUST NOT coerce
    // hostFeeMist to "0". The recorder did not see a proven fee, so
    // it stays null alongside the other unknown numeric fields.
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'SPONSOR_EXEC_GAS_USED_MISSING',
        },
      }),
    );
    const e = store.appended[0];
    expect(e.economicsStatus).toBe('unknown');
    expect(e.recoveredGasMist).toBeNull();
    expect(e.hostPaidGasMist).toBeNull();
    expect(e.hostNetMist).toBeNull();
    expect(e.grossGasMist).toBeNull();
    expect(e.storageRebateMist).toBeNull();
    expect(e.hostFeeMist).toBeNull();
    expect(e.protocolFeeMist).toBeNull();
    expect(e.failureReason).toBe('SPONSOR_EXEC_GAS_USED_MISSING');
  });

  it('promotion mode carries promotionId / userId; orderIdHash null', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        route: 'promotion',
        orderIdHash: null,
        promotionId: 'promo-1',
        userId: 'user-1',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '5000',
          hostFeeMist: '0',
          hostNetMist: '-5000',
          grossGasMist: '6000',
          storageRebateMist: '1000',
          protocolFeeMist: '0',
          failureReason: null,
        },
      }),
    );
    const e = store.appended[0];
    expect(e.mode).toBe('promotion');
    expect(e.promotionId).toBe('promo-1');
    expect(e.userId).toBe('user-1');
    expect(e.orderIdHash).toBeNull();
    expect(e.hostNetMist).toBe('-5000');
  });
});

describe('createSponsoredLogsRecorder — failure semantics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('store rejection emits SPONSORED_LOGS_RECORDER_FAILED and does not throw', async () => {
    const store = new CapturingStore();
    store.shouldThrow = true;
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await expect(cb(makeMetadata())).resolves.toBeUndefined();
    const events = warnSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const recorderFailed = events.find((e) => e.event === 'SPONSORED_LOGS_RECORDER_FAILED');
    expect(recorderFailed).toBeDefined();
    expect(recorderFailed?.stage).toBe('store_append');
    expect(recorderFailed?.receipt_id).toBe('r1');
    expect(recorderFailed?.error).toBe('store boom');
  });

  it('entry-build rejection carries receipt identity even without a usable digest', async () => {
    const cb = createSponsoredLogsRecorder({
      store: new CapturingStore(),
      clock: () => new Date(Number.NaN),
    });
    await expect(
      cb(withoutDigest(makeMetadata({ receiptId: 'r-build' }))),
    ).resolves.toBeUndefined();
    const events = warnSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const recorderFailed = events.find((e) => e.event === 'SPONSORED_LOGS_RECORDER_FAILED');
    expect(recorderFailed).toMatchObject({
      stage: 'build_entry',
      receipt_id: 'r-build',
      digest: null,
    });
  });
});

describe('fanOutSponsorResult', () => {
  it('runs all callbacks in sequence', async () => {
    const order: number[] = [];
    const cb1 = async () => {
      order.push(1);
    };
    const cb2 = async () => {
      order.push(2);
    };
    const cb3 = async () => {
      order.push(3);
    };
    const fanned = fanOutSponsorResult(cb1, cb2, cb3);
    await fanned(makeMetadata());
    expect(order).toEqual([1, 2, 3]);
  });

  it('one callback throwing does not suppress the others', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: number[] = [];
    const fanned = fanOutSponsorResult(
      async () => {
        order.push(1);
      },
      async () => {
        throw new Error('cb2 boom');
      },
      async () => {
        order.push(3);
      },
    );
    await expect(fanned(makeMetadata())).resolves.toBeUndefined();
    expect(order).toEqual([1, 3]);
    warnSpy.mockRestore();
  });

  it('child throw emits SPONSOR_RESULT_CALLBACK_FAILED with source=sponsored_logs_fanout', async () => {
    // Lock for fan-out observability contract: a child callback's
    // never-throws contract violation must remain visible to operators
    // even though the fan-out keeps the outer never-throws boundary.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fanned = fanOutSponsorResult(
      async () => {
        throw new Error('child boom');
      },
      async () => {
        // ok — fan-out continues after a preceding throw
      },
    );
    await fanned(
      makeMetadata({
        outcome: 'success',
        route: 'generic',
        digest: '0xfanout_digest',
        sponsorAddress: '0xsponsor_x',
      }),
    );
    const events = warnSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const fanFailed = events.find((e) => e.event === 'SPONSOR_RESULT_CALLBACK_FAILED');
    expect(fanFailed).toBeDefined();
    expect(fanFailed?.source).toBe('sponsored_logs_fanout');
    expect(fanFailed?.callback_index).toBe(0);
    expect(fanFailed?.route).toBe('generic');
    expect(fanFailed?.receipt_id).toBe('r1');
    expect(fanFailed?.error).toBe('child boom');
    // digest is the cross-reference key in `docs/operations.md`:
    // operators correlate fanOut failures with `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`
    // / `SPONSORED_LOGS_RECORDER_FAILED` on the same digest/sponsor address.
    expect(fanFailed?.digest).toBe('0xfanout_digest');
    expect(fanFailed?.sponsor_address).toBe('0xsponsor_x');
    warnSpy.mockRestore();
  });

  it('child throw with null digest before submit emits digest=null', async () => {
    // Preflight failures never produce a digest; the cross-reference
    // shape must still be present (digest=null) so consumers do not
    // need a missing-key fallback path.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fanned = fanOutSponsorResult(async () => {
      throw new Error('preflight throw');
    });
    await fanned(withoutDigest(makeMetadata({ outcome: 'preflight_failure' })));
    const events = warnSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const fanFailed = events.find((e) => e.event === 'SPONSOR_RESULT_CALLBACK_FAILED');
    expect(fanFailed).toBeDefined();
    expect(fanFailed?.receipt_id).toBe('r1');
    expect(fanFailed?.digest).toBeNull();
    warnSpy.mockRestore();
  });
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
