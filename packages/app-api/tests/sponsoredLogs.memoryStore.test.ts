import { describe, it, expect } from 'vitest';
import { MemorySponsoredLogsStore } from '../src/sponsoredLogs/memoryStore.js';
import type {
  SponsoredExecutionLogEntry,
  SponsoredExecutionMode,
} from '../src/sponsoredLogs/types.js';

function makeKnownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> & {
    receiptId: string;
    mode: SponsoredExecutionMode;
  },
): SponsoredExecutionLogEntry {
  const promotion = overrides.mode === 'promotion';
  return {
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode: overrides.mode,
    outcome: overrides.outcome ?? 'success',
    receiptId: overrides.receiptId,
    digest: overrides.digest ?? '0xdigest',
    senderAddress: overrides.senderAddress ?? '0xsender',
    sponsorAddress: overrides.sponsorAddress ?? '0xsponsor',
    executionPathKey: overrides.executionPathKey ?? 'generic-execution-path',
    orderIdHash: promotion ? null : (overrides.orderIdHash ?? null),
    promotionId: promotion ? (overrides.promotionId ?? 'promo-1') : null,
    userId: promotion ? (overrides.userId ?? 'user-1') : null,
    recoveredGasMist: overrides.recoveredGasMist ?? '12000',
    hostPaidGasMist: overrides.hostPaidGasMist ?? '8000',
    hostNetMist: overrides.hostNetMist ?? '5000',
    hostFeeMist: overrides.hostFeeMist ?? '1000',
    protocolFeeMist: overrides.protocolFeeMist ?? '50',
    grossGasMist: overrides.grossGasMist ?? '9500',
    storageRebateMist: overrides.storageRebateMist ?? '1500',
    economicsStatus: 'known',
    failureReason: overrides.failureReason ?? null,
  };
}

function makeUnknownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> & {
    receiptId: string;
    mode: SponsoredExecutionMode;
  },
): SponsoredExecutionLogEntry {
  const promotion = overrides.mode === 'promotion';
  return {
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode: overrides.mode,
    outcome: overrides.outcome ?? 'success',
    receiptId: overrides.receiptId,
    digest: overrides.digest ?? null,
    senderAddress: overrides.senderAddress ?? '0xsender',
    sponsorAddress: overrides.sponsorAddress ?? '0xsponsor',
    executionPathKey: overrides.executionPathKey ?? 'generic-execution-path',
    orderIdHash: promotion ? null : (overrides.orderIdHash ?? null),
    promotionId: promotion ? (overrides.promotionId ?? 'promo-1') : null,
    userId: promotion ? (overrides.userId ?? 'user-1') : null,
    recoveredGasMist: null,
    hostPaidGasMist: null,
    hostNetMist: null,
    hostFeeMist: null,
    protocolFeeMist: null,
    grossGasMist: null,
    storageRebateMist: null,
    economicsStatus: 'unknown',
    failureReason: overrides.failureReason ?? 'SPONSOR_EXEC_GAS_USED_MISSING',
  };
}

describe('MemorySponsoredLogsStore — append and aggregate', () => {
  it('updates per-mode and all-mode aggregates on a single known entry', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(
      makeKnownEntry({
        receiptId: 'r1',
        mode: 'generic',
        hostNetMist: '5000',
      }),
    );

    const generic = await store.getSummary('generic');
    expect(generic.sponsoredExecutions).toBe('1');
    expect(generic.lossCount).toBe('0');
    expect(generic.cumulativeHostNetMist).toBe('5000');
    expect(generic.cumulativeLossMist).toBe('0');

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('1');
    expect(all.lossCount).toBe('0');
    expect(all.cumulativeHostNetMist).toBe('5000');
    expect(all.cumulativeLossMist).toBe('0');

    const promotion = await store.getSummary('promotion');
    expect(promotion.sponsoredExecutions).toBe('0');
  });

  it('counts a loss only when known economics has hostNet < 0', async () => {
    const store = new MemorySponsoredLogsStore();
    // Loss entry: recovered=0, paid=7000 → net -7000
    await store.append(
      makeKnownEntry({
        receiptId: 'r-loss',
        mode: 'generic',
        outcome: 'onchain_revert',
        hostNetMist: '-7000',
        recoveredGasMist: '0',
        hostPaidGasMist: '7000',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      }),
    );
    // Boundary zero: recovered === paid → net 0, NOT a loss
    await store.append(
      makeKnownEntry({
        receiptId: 'r-zero',
        mode: 'promotion',
        hostNetMist: '0',
        recoveredGasMist: '5000',
        hostPaidGasMist: '5000',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      }),
    );

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('2');
    expect(all.lossCount).toBe('1');
    expect(all.cumulativeHostNetMist).toBe('-7000');
    expect(all.cumulativeLossMist).toBe('-7000');

    const generic = await store.getSummary('generic');
    expect(generic.lossCount).toBe('1');
    const promotion = await store.getSummary('promotion');
    expect(promotion.lossCount).toBe('0');
  });

  it('unknown economics is recorded but does NOT affect net/loss aggregates', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(
      makeUnknownEntry({
        receiptId: 'r-unk',
        mode: 'generic',
        outcome: 'success',
      }),
    );

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('1');
    expect(all.lossCount).toBe('0');
    expect(all.cumulativeHostNetMist).toBe('0');
    expect(all.cumulativeLossMist).toBe('0');
  });

  it('accepts an exact receipt replay even when recorder time changes', async () => {
    const store = new MemorySponsoredLogsStore();
    const e = makeKnownEntry({ receiptId: 'r-dup', mode: 'generic' });
    await store.append(e);
    await store.append(e);
    await store.append({ ...e, createdAt: '2026-04-26T16:00:01.000Z' });

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('1');
    const recent = await store.getRecent('all', 10);
    expect(recent).toHaveLength(1);
  });

  it('receipt replay protection persists past the recent cap', async () => {
    // Lock for store-contract replay lifetime: receipt fingerprints MUST
    // persist for the adapter's full lifetime. After the recent list
    // rolls past its cap, re-appending an early tuple must still be
    // dropped without double-counting the aggregate.
    const store = new MemorySponsoredLogsStore({ recentCap: 3 });
    const early = makeKnownEntry({
      receiptId: 'r-early',
      mode: 'generic',
      hostNetMist: '1',
    });
    await store.append(early);
    // Roll the recent list well past the cap so the early row is
    // dropped from the recent projection.
    for (let i = 0; i < 10; i++) {
      await store.append(
        makeKnownEntry({
          receiptId: `r-fill-${i}`,
          mode: 'generic',
          hostNetMist: '1',
        }),
      );
    }
    // Replay the early result. The receipt fingerprint must still drop it.
    await store.append(early);
    await store.append({ ...early, createdAt: '2099-01-01T00:00:00.000Z' });

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('11'); // 1 + 10, no double-count
    expect(all.cumulativeHostNetMist).toBe('11');
  });

  it('rejects a different outcome for one receipt without changing projections', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(makeKnownEntry({ receiptId: 'r-mix', mode: 'generic', outcome: 'success' }));
    await expect(
      store.append(
        makeKnownEntry({
          receiptId: 'r-mix',
          mode: 'generic',
          outcome: 'onchain_revert',
          hostNetMist: '-100',
        }),
      ),
    ).rejects.toThrow(/conflicting result for receiptId r-mix/);
    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('1');
    expect(all.lossCount).toBe('0');
    expect(all.cumulativeHostNetMist).toBe('5000');
    expect(await store.getRecent('all', 10)).toHaveLength(1);
  });

  it('rejects changed economics under the same receipt and outcome', async () => {
    const store = new MemorySponsoredLogsStore();
    const entry = makeKnownEntry({ receiptId: 'r-economics', mode: 'generic' });
    await store.append(entry);
    await expect(store.append({ ...entry, hostNetMist: '4999' })).rejects.toThrow(
      /conflicting result for receiptId r-economics/,
    );
    expect(await store.getSummary('all')).toMatchObject({
      sponsoredExecutions: '1',
      cumulativeHostNetMist: '5000',
    });
  });

  it('all-mode aggregate equals sum of per-mode aggregates', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(makeKnownEntry({ receiptId: 'r-g', mode: 'generic' }));
    await store.append(
      makeKnownEntry({
        receiptId: 'r-p',
        mode: 'promotion',
        hostNetMist: '0',
        recoveredGasMist: '3000',
        hostPaidGasMist: '3000',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      }),
    );

    const all = await store.getSummary('all');
    const generic = await store.getSummary('generic');
    const promotion = await store.getSummary('promotion');

    expect(BigInt(all.sponsoredExecutions)).toBe(
      BigInt(generic.sponsoredExecutions) + BigInt(promotion.sponsoredExecutions),
    );
    expect(BigInt(all.cumulativeHostNetMist)).toBe(
      BigInt(generic.cumulativeHostNetMist) + BigInt(promotion.cumulativeHostNetMist),
    );
    expect(BigInt(all.cumulativeLossMist)).toBe(
      BigInt(generic.cumulativeLossMist) + BigInt(promotion.cumulativeLossMist),
    );
    expect(BigInt(all.lossCount)).toBe(BigInt(generic.lossCount) + BigInt(promotion.lossCount));
  });

  it('preserves exact signed MIST arithmetic (no precision loss)', async () => {
    // Two large opposing values that would lose precision via JS number
    const big = '9223372036854775000'; // close to int64 max
    const store = new MemorySponsoredLogsStore();
    await store.append(
      makeKnownEntry({
        receiptId: 'r-big-pos',
        mode: 'generic',
        hostNetMist: big,
        recoveredGasMist: big,
        hostPaidGasMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      }),
    );
    await store.append(
      makeKnownEntry({
        receiptId: 'r-big-neg',
        mode: 'generic',
        outcome: 'onchain_revert',
        hostNetMist: `-${big}`,
        recoveredGasMist: '0',
        hostPaidGasMist: big,
        hostFeeMist: '0',
        protocolFeeMist: '0',
      }),
    );

    const generic = await store.getSummary('generic');
    expect(generic.cumulativeHostNetMist).toBe('0');
    expect(generic.cumulativeLossMist).toBe(`-${big}`);
    expect(generic.lossCount).toBe('1');
  });

  it('throws when known economics entry is missing required signed fields', async () => {
    const store = new MemorySponsoredLogsStore();
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad', mode: 'generic' }),
      hostNetMist: null,
    };
    await expect(store.append(bad)).rejects.toThrow(/hostNetMist/);
  });

  it('throws on malformed signed-mist string (no silent coercion)', async () => {
    const store = new MemorySponsoredLogsStore();
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad-str', mode: 'generic' }),
      hostNetMist: 'not-a-number',
    };
    await expect(store.append(bad)).rejects.toThrow();
  });

  it('rejected append does NOT claim a receipt — a well-formed retry still records', async () => {
    // Receipt contract: validation must run before the receipt
    // fingerprint is recorded.
    // Otherwise a malformed entry would silently swallow the
    // legitimate retry.
    const store = new MemorySponsoredLogsStore();
    const malformed: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({
        receiptId: 'r-retry',
        mode: 'generic',
        hostNetMist: '4000',
      }),
      hostNetMist: 'not-a-number',
    };
    await expect(store.append(malformed)).rejects.toThrow();

    // Aggregate must be untouched by the rejected append.
    const beforeRetry = await store.getSummary('all');
    expect(beforeRetry.sponsoredExecutions).toBe('0');
    expect(beforeRetry.cumulativeHostNetMist).toBe('0');

    // Same receipt, well-formed payload —
    // must record into aggregate AND recent.
    const wellFormed = makeKnownEntry({
      receiptId: 'r-retry',
      mode: 'generic',
      hostNetMist: '4000',
    });
    await store.append(wellFormed);

    const after = await store.getSummary('all');
    expect(after.sponsoredExecutions).toBe('1');
    expect(after.cumulativeHostNetMist).toBe('4000');

    const recent = await store.getRecent('all', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].receiptId).toBe('r-retry');

    // And a *third* exact append should now be deduped
    // (well-formed has claimed the receipt).
    await store.append(wellFormed);
    const final = await store.getSummary('all');
    expect(final.sponsoredExecutions).toBe('1');
  });

  it('rejects extra, cross-mode, wrong-outcome, and non-canonical current shapes before persistence', async () => {
    const mutations: unknown[] = [
      { ...makeKnownEntry({ receiptId: 'extra-field', mode: 'generic' }), unexpected: 1 },
      {
        ...makeKnownEntry({ receiptId: 'cross-mode', mode: 'generic' }),
        promotionId: 'promo-1',
        userId: 'user-1',
      },
      {
        ...makeKnownEntry({ receiptId: 'promotion-id-missing', mode: 'promotion' }),
        promotionId: null,
      },
      {
        ...makeKnownEntry({ receiptId: 'promotion-user-missing', mode: 'promotion' }),
        userId: null,
      },
      {
        ...makeKnownEntry({ receiptId: 'promotion-order-id', mode: 'promotion' }),
        orderIdHash: 'order-hash',
      },
      { ...makeKnownEntry({ receiptId: 'wrong-outcome', mode: 'generic' }), outcome: 'congestion' },
      { ...makeKnownEntry({ receiptId: 'leading-zero', mode: 'generic' }), hostFeeMist: '01' },
      { ...makeKnownEntry({ receiptId: 'number-money', mode: 'generic' }), hostPaidGasMist: 1 },
      {
        ...makeKnownEntry({ receiptId: 'negative-recovered', mode: 'generic' }),
        recoveredGasMist: '-1',
      },
      { ...makeKnownEntry({ receiptId: 'negative-paid', mode: 'generic' }), hostPaidGasMist: '-1' },
      ...[
        'recoveredGasMist',
        'hostPaidGasMist',
        'hostNetMist',
        'hostFeeMist',
        'protocolFeeMist',
        'grossGasMist',
        'storageRebateMist',
      ].map((field) => ({
        ...makeUnknownEntry({ receiptId: `unknown-${field}`, mode: 'generic' }),
        [field]: '0',
      })),
    ];
    const store = new MemorySponsoredLogsStore();
    for (const mutation of mutations) {
      await expect(store.append(mutation as SponsoredExecutionLogEntry)).rejects.toThrow();
    }
    expect((await store.getSummary('all')).sponsoredExecutions).toBe('0');
  });

  it('stores and returns current-shape clones instead of caller-owned objects', async () => {
    const store = new MemorySponsoredLogsStore();
    const entry = makeKnownEntry({ receiptId: 'clone', mode: 'generic', hostNetMist: '5' });
    await store.append(entry);
    (entry as { hostNetMist: string | null }).hostNetMist = '999';

    const first = await store.getRecent('all', 1);
    expect(first[0].hostNetMist).toBe('5');
    (first[0] as { hostNetMist: string | null }).hostNetMist = '888';
    expect((await store.getRecent('all', 1))[0].hostNetMist).toBe('5');
  });
});

describe('MemorySponsoredLogsStore — recent list', () => {
  it('returns newest-first up to limit', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(
      makeKnownEntry({ receiptId: 'r2', mode: 'promotion', createdAt: '2026-04-26T15:00:01Z' }),
    );
    await store.append(
      makeKnownEntry({ receiptId: 'r1', mode: 'generic', createdAt: '2026-04-26T15:00:00Z' }),
    );
    await store.append(
      makeKnownEntry({ receiptId: 'r3', mode: 'generic', createdAt: '2026-04-26T15:00:02Z' }),
    );

    const recent = await store.getRecent('all', 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].receiptId).toBe('r3');
    expect(recent[1].receiptId).toBe('r2');
  });

  it('filters by mode', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(
      makeKnownEntry({ receiptId: 'r3', mode: 'generic', createdAt: '2026-04-26T15:00:03Z' }),
    );
    await store.append(
      makeKnownEntry({ receiptId: 'r1', mode: 'generic', createdAt: '2026-04-26T15:00:01Z' }),
    );
    await store.append(
      makeKnownEntry({ receiptId: 'r2', mode: 'promotion', createdAt: '2026-04-26T15:00:02Z' }),
    );

    const generic = await store.getRecent('generic', 10);
    expect(generic.map((e) => e.receiptId)).toEqual(['r3', 'r1']);
    const promotion = await store.getRecent('promotion', 10);
    expect(promotion.map((e) => e.receiptId)).toEqual(['r2']);
  });

  it('caps recent list at recentCap and drops oldest', async () => {
    const store = new MemorySponsoredLogsStore({ recentCap: 3 });
    for (const [receiptId, createdAt] of [
      ['r0', '2026-04-26T15:00:00Z'],
      ['r4', '2026-04-26T15:00:04Z'],
      ['r1', '2026-04-26T15:00:01Z'],
      ['r3', '2026-04-26T15:00:03Z'],
      ['r2', '2026-04-26T15:00:02Z'],
    ] as const) {
      await store.append(makeKnownEntry({ receiptId, mode: 'generic', createdAt }));
    }
    const recent = await store.getRecent('all', 10);
    expect(recent.map((e) => e.receiptId)).toEqual(['r4', 'r3', 'r2']);

    // Aggregate still reflects all 5 appends (lifetime != bounded recent).
    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('5');
  });

  it('limit <= 0 returns empty', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(makeKnownEntry({ receiptId: 'r', mode: 'generic' }));
    expect(await store.getRecent('all', 0)).toEqual([]);
    expect(await store.getRecent('all', -1)).toEqual([]);
  });
});
