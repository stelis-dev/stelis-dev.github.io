/**
 * handlePromotionClaim — unit tests.
 *
 * Tests claim admission logic using Memory implementations.
 * Uses MemoryPromotionStore (wired as the handler's `catalog` dep via
 * structural `{ get(id) }`) + MemoryPromotionExecutionLedger.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AdminPromotionCreateRequest } from '@stelis/contracts';
import { handlePromotionClaim } from '../src/studio/promotionClaimHandler.js';
import type { ClaimHandlerDeps } from '../src/studio/promotionClaimHandler.js';
import { MemoryPromotionStore } from '../src/studio/promotionStore.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const NOW = new Date('2026-06-01T12:00:00Z');

const BASE_PROMO: AdminPromotionCreateRequest = {
  type: 'gas_sponsorship',
  displayName: 'Test Gas Promo',
  description: 'Test',
  maxParticipants: 10,
  perUserGasAllowanceMist: '5000000',
  claimDeadlineAt: null,
  postClaimUseWindowMs: 0,
  startAt: null,
};

async function createActivatedPromo(
  store: MemoryPromotionStore,
  overrides: Partial<AdminPromotionCreateRequest> = {},
): Promise<string> {
  const record = await store.create({ ...BASE_PROMO, ...overrides });
  await store.transitionStatus(record.promotionId, 'active');
  return record.promotionId;
}

function makeDeps(): ClaimHandlerDeps & {
  store: MemoryPromotionStore;
} {
  const store = new MemoryPromotionStore();
  // ClaimHandlerDeps.catalog is structural `{ get(id) }` — MemoryPromotionStore
  // satisfies it directly, no adapter needed.
  return {
    store,
    catalog: store,
    ledger: new MemoryPromotionExecutionLedger(store),
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handlePromotionClaim', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('successfully claims an active promotion', async () => {
    const promoId = await createActivatedPromo(deps.store);

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entitlement.promotionId).toBe(promoId);
      expect(result.entitlement.userId).toBe('user-1');
      expect(result.entitlement.remainingGasAllowanceMist).toBe('5000000');
      expect(result.entitlement.status).toBe('active');
      expect(result.entitlement.useUntilAt).toBeNull(); // postClaimUseWindowMs=0
    }
  });

  it('rejects when promotion not found', async () => {
    const result = await handlePromotionClaim(
      { promotionId: 'nonexistent', userId: 'user-1' },
      deps,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'promotion_not_found' });
  });

  it('rejects when promotion is not active (draft)', async () => {
    const record = await deps.store.create(BASE_PROMO);
    // Stay in draft — do not activate

    const result = await handlePromotionClaim(
      { promotionId: record.promotionId, userId: 'user-1' },
      deps,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'promotion_not_active' });
  });

  it('rejects when promotion is paused', async () => {
    const promoId = await createActivatedPromo(deps.store);
    await deps.store.transitionStatus(promoId, 'paused', 'maintenance');

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'promotion_not_active' });
  });

  it('rejects when claim deadline has passed', async () => {
    const promoId = await createActivatedPromo(deps.store, {
      claimDeadlineAt: '2026-01-01T00:00:00Z',
    });

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW, // 2026-06-01 > 2026-01-01
    );
    expect(result).toEqual({ ok: false, reason: 'claim_deadline_passed' });
  });

  it('rejects with promotion_not_started when startAt is in the future', async () => {
    const promoId = await createActivatedPromo(deps.store, {
      startAt: '2027-01-01T00:00:00Z',
    });

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW, // 2026-06-01 < 2027-01-01
    );
    expect(result).toEqual({ ok: false, reason: 'promotion_not_started' });
  });

  it('accepts claim when startAt is in the past', async () => {
    const promoId = await createActivatedPromo(deps.store, {
      startAt: '2026-01-01T00:00:00Z',
    });

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW, // 2026-06-01 > 2026-01-01
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when max participants reached', async () => {
    const promoId = await createActivatedPromo(deps.store, {
      maxParticipants: 2,
    });

    await handlePromotionClaim({ promotionId: promoId, userId: 'user-1' }, deps, NOW);
    await handlePromotionClaim({ promotionId: promoId, userId: 'user-2' }, deps, NOW);

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-3' },
      deps,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'max_participants_reached' });
  });

  it('rejects duplicate claim (same user + promotion)', async () => {
    const promoId = await createActivatedPromo(deps.store);
    await handlePromotionClaim({ promotionId: promoId, userId: 'user-1' }, deps, NOW);

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'already_claimed' });
  });

  it('sets useUntilAt when postClaimUseWindowMs > 0', async () => {
    const oneHourMs = 3_600_000;
    const promoId = await createActivatedPromo(deps.store, {
      postClaimUseWindowMs: oneHourMs,
    });

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-1' },
      deps,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = new Date(NOW.getTime() + oneHourMs).toISOString();
      expect(result.entitlement.useUntilAt).toBe(expected);
    }
  });

  it('verifies entitlement exists in ledger after claim', async () => {
    const promoId = await createActivatedPromo(deps.store);
    await handlePromotionClaim({ promotionId: promoId, userId: 'user-1' }, deps, NOW);

    const ent = await deps.ledger.getEntitlement(promoId, 'user-1');
    expect(ent).not.toBeNull();
    expect(ent!.remainingGasAllowanceMist).toBe('5000000');
  });

  it('verifies claimed count in ledger after claim', async () => {
    const promoId = await createActivatedPromo(deps.store);
    await handlePromotionClaim({ promotionId: promoId, userId: 'user-1' }, deps, NOW);

    const count = (await deps.ledger.getPromotionLedgerStatus(promoId, null)).claimedCount;
    expect(count).toBe(1);
  });

  // ── Atomicity guarantee ────────────────────────────────────
  // ExecutionLedger.claim() is atomic.
  // If claim() fails, nothing was committed.
  // If claim() succeeds, both dedupe and entitlement are committed atomically.

  // ── Atomic ledger reason mapping ────────────────────────────
  it('maps internal ledger promotion_not_active to public promotion_not_active', async () => {
    const promoId = await createActivatedPromo(deps.store);

    const stubLedger: ClaimHandlerDeps['ledger'] = {
      ...deps.ledger,
      claim: async () => ({ ok: false, reason: 'promotion_not_active' }),
    };

    const result = await handlePromotionClaim(
      { promotionId: promoId, userId: 'user-race' },
      { ...deps, ledger: stubLedger },
      NOW,
    );

    expect(result).toEqual({ ok: false, reason: 'promotion_not_active' });
  });
});
