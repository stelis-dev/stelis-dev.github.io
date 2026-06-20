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
    slotId: '0xslot',
    sponsorAddress: '0xsponsor',
    outcome: 'success',
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
    for (const outcome of ['congestion', 'preflight_failure', 'validation_failure'] as const) {
      await cb(
        makeMetadata({
          outcome,
          economics: { economicsStatus: 'unknown', failureReason: outcome },
        }),
      );
    }
    expect(store.appended).toHaveLength(0);
  });

  it('skips internal_error fall-through (no submit_infra_unknown marker — never burned gas)', async () => {
    // Generic catch-all `internal_error` whose `failureReason` does NOT
    // start with `submit_infra_unknown` — these are crashes that throw
    // before sponsor signature, so the relayer never paid gas onchain.
    // They belong to other audit views, not Sponsored Executions.
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'unexpected error: foo',
        },
      }),
    );
    expect(store.appended).toHaveLength(0);
  });

  it('records internal_error when failureReason starts with submit_infra_unknown (post-signature uncertainty: TX may have landed)', async () => {
    // Submit-infra branch in the promotion handler stamps
    // `submit_infra_unknown: <rpcMsg>` (or `submit_infra_unknown
    // (ledger consume <kind>): <rpcMsg>`) onto economics before
    // re-throwing the raw RPC error. The sponsor signature was already
    // issued before `executeTransaction()` threw, so the TX may have
    // reached the network and burned gas. Record it so operators see
    // these incidents in the same Sponsored Executions view they
    // already use to reconcile success / on-chain-revert rows.
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'submit_infra_unknown (ledger consume failed): rpc transport error',
        },
      }),
    );
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].outcome).toBe('internal_error');
    expect(store.appended[0].economicsStatus).toBe('unknown');
    expect(store.appended[0].failureReason).toBe(
      'submit_infra_unknown (ledger consume failed): rpc transport error',
    );
    // Numeric honesty: every monetary field must be null on the
    // unknown-economics row — recorder must not coerce an unknown
    // amount.
    expect(store.appended[0].hostPaidGasMist).toBeNull();
    expect(store.appended[0].recoveredGasMist).toBeNull();
    expect(store.appended[0].hostNetMist).toBeNull();
  });

  it('records the generic-execution-path submit-infra shape (no ledger consume kind suffix) — `submit_infra_unknown: <rpcMsg>`', async () => {
    // Generic route has no per-receipt ledger reservation, so the
    // submit-infra stamp is the consume()-succeeded shape only:
    // `submit_infra_unknown: <rpcMsg>`. Both routes share the same
    // marker prefix and both must opt in.
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(
      makeMetadata({
        outcome: 'internal_error',
        route: 'generic',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'submit_infra_unknown: rpc transport error',
        },
      }),
    );
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].outcome).toBe('internal_error');
    expect(store.appended[0].mode).toBe('generic');
    expect(store.appended[0].failureReason).toBe('submit_infra_unknown: rpc transport error');
  });
});

describe('createSponsoredLogsRecorder — entry fields', () => {
  it('maps known economics 1:1 from sponsor result metadata to log entry', async () => {
    const store = new CapturingStore();
    const cb = createSponsoredLogsRecorder({ store, clock: fixedClock });
    await cb(makeMetadata());
    const e = store.appended[0];
    expect(e).toMatchObject({
      schemaVersion: 1,
      createdAt: FROZEN_TS,
      mode: 'generic',
      outcome: 'success',
      receiptId: 'r1',
      digest: '0xdigest',
      senderAddress: '0xsender',
      sponsorAddress: '0xsponsor',
      slotId: '0xslot',
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
          recoveredGasMist: '5000',
          hostPaidGasMist: '5000',
          hostFeeMist: '0',
          hostNetMist: '0',
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
    expect(e.hostNetMist).toBe('0');
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
      .map((c) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const recorderFailed = events.find((e) => e.event === 'SPONSORED_LOGS_RECORDER_FAILED');
    expect(recorderFailed).toBeDefined();
    expect(recorderFailed?.stage).toBe('store_append');
    expect(recorderFailed?.error).toBe('store boom');
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
        slotId: '0xslot_x',
      }),
    );
    const events = warnSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const fanFailed = events.find((e) => e.event === 'SPONSOR_RESULT_CALLBACK_FAILED');
    expect(fanFailed).toBeDefined();
    expect(fanFailed?.source).toBe('sponsored_logs_fanout');
    expect(fanFailed?.callback_index).toBe(0);
    expect(fanFailed?.route).toBe('generic');
    expect(fanFailed?.error).toBe('child boom');
    // digest is the cross-reference key in `docs/operations.md`:
    // operators correlate fanOut failures with `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`
    // / `SPONSORED_LOGS_RECORDER_FAILED` on the same digest/slot.
    expect(fanFailed?.digest).toBe('0xfanout_digest');
    expect(fanFailed?.slot_id).toBe('0xslot_x');
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
    await fanned(makeMetadata({ outcome: 'preflight_failure', digest: null }));
    const events = warnSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter(Boolean) as Record<string, unknown>[];
    const fanFailed = events.find((e) => e.event === 'SPONSOR_RESULT_CALLBACK_FAILED');
    expect(fanFailed).toBeDefined();
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
