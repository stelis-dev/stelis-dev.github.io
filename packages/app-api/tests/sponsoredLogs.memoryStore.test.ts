import { describe, it, expect } from 'vitest';
import { MemorySponsoredLogsStore } from '../src/sponsoredLogs/memoryStore.js';
import { sponsoredLogIdempotencyKey } from '../src/sponsoredLogs/store.js';
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
  return {
    schemaVersion: 1,
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode: overrides.mode,
    outcome: overrides.outcome ?? 'success',
    receiptId: overrides.receiptId,
    digest: overrides.digest ?? '0xdigest',
    senderAddress: overrides.senderAddress ?? '0xsender',
    sponsorAddress: overrides.sponsorAddress ?? '0xsponsor',
    slotId: overrides.slotId ?? '0xslot',
    executionPathKey: overrides.executionPathKey ?? 'generic-execution-path',
    orderIdHash: overrides.orderIdHash ?? null,
    promotionId: overrides.promotionId ?? null,
    userId: overrides.userId ?? null,
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
  return {
    schemaVersion: 1,
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode: overrides.mode,
    outcome: overrides.outcome ?? 'success',
    receiptId: overrides.receiptId,
    digest: overrides.digest ?? null,
    senderAddress: overrides.senderAddress ?? null,
    sponsorAddress: overrides.sponsorAddress ?? null,
    slotId: overrides.slotId ?? null,
    executionPathKey: overrides.executionPathKey ?? null,
    orderIdHash: overrides.orderIdHash ?? null,
    promotionId: overrides.promotionId ?? null,
    userId: overrides.userId ?? null,
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

describe('sponsoredLogIdempotencyKey', () => {
  it('builds a stable key from mode|receiptId|outcome', () => {
    const entry = makeKnownEntry({ receiptId: 'r1', mode: 'generic', outcome: 'success' });
    expect(sponsoredLogIdempotencyKey(entry)).toBe('generic|r1|success');
  });
});

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

  it('append is idempotent on (mode, receiptId, outcome)', async () => {
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

  it('idempotency persists past the recent cap (no seenKeys drop)', async () => {
    // Lock for store-contract idempotency lifetime: dedup tuples MUST
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
    // Replay the early tuple. Idempotency must still drop it.
    await store.append(early);
    await store.append({ ...early, createdAt: '2099-01-01T00:00:00.000Z' });

    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('11'); // 1 + 10, no double-count
    expect(all.cumulativeHostNetMist).toBe('11');
  });

  it('different outcomes for same receiptId are NOT deduped', async () => {
    const store = new MemorySponsoredLogsStore();
    await store.append(makeKnownEntry({ receiptId: 'r-mix', mode: 'generic', outcome: 'success' }));
    await store.append(
      makeKnownEntry({
        receiptId: 'r-mix',
        mode: 'generic',
        outcome: 'onchain_revert',
        hostNetMist: '-100',
      }),
    );
    const all = await store.getSummary('all');
    expect(all.sponsoredExecutions).toBe('2');
    expect(all.lossCount).toBe('1');
    expect(all.cumulativeHostNetMist).toBe('4900');
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
    await expect(store.append(bad)).rejects.toThrow(/known economics entry missing/);
  });

  it('throws on malformed signed-mist string (no silent coercion)', async () => {
    const store = new MemorySponsoredLogsStore();
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad-str', mode: 'generic' }),
      hostNetMist: 'not-a-number',
    };
    await expect(store.append(bad)).rejects.toThrow();
  });

  it('rejected append does NOT poison idempotency — well-formed retry of same key still records', async () => {
    // Idempotency contract: validation must run before the
    // (mode, receiptId, outcome) tuple is claimed in seenKeys.
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

    // Same (mode, receiptId, outcome) tuple, well-formed payload —
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

    // And a *third* append with the same key should now be deduped
    // (well-formed has claimed the idempotency slot).
    await store.append(wellFormed);
    const final = await store.getSummary('all');
    expect(final.sponsoredExecutions).toBe('1');
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
