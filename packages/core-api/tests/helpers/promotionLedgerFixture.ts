import { vi } from 'vitest';
import type { AdminPromotionCreateRequest } from '@stelis/contracts';
import type { RedisClientLike } from '../../src/store/redisClient.js';
import { MemoryPromotionStore, RedisPromotionStore } from '../../src/studio/promotionStore.js';

export const PROMO_ID = '00000000-0000-4000-8000-000000000101';
export const PROMO_X = '00000000-0000-4000-8000-000000000102';
export const PROMO_Y = '00000000-0000-4000-8000-000000000103';
export const CAPACITY_PROMO = '00000000-0000-4000-8000-000000000104';
export const CLAMP_PROMO = '00000000-0000-4000-8000-000000000105';
export const EXHAUST_PROMO = '00000000-0000-4000-8000-000000000106';
export const PAGE_PROMO_A = '00000000-0000-4000-8000-000000000001';
export const PAGE_PROMO_B = '00000000-0000-4000-8000-000000000002';

interface PromotionFixture {
  readonly promotionId: string;
  readonly maxParticipants: number;
  readonly perUserGasAllowanceMist: string;
}

export const PROMOTION_LEDGER_FIXTURES: readonly PromotionFixture[] = [
  { promotionId: PROMO_ID, maxParticipants: 10, perUserGasAllowanceMist: '5000000' },
  { promotionId: PROMO_X, maxParticipants: 10, perUserGasAllowanceMist: '5000000' },
  { promotionId: PROMO_Y, maxParticipants: 10, perUserGasAllowanceMist: '5000000' },
  { promotionId: CAPACITY_PROMO, maxParticipants: 2, perUserGasAllowanceMist: '5000000' },
  { promotionId: CLAMP_PROMO, maxParticipants: 1, perUserGasAllowanceMist: '2000000' },
  { promotionId: EXHAUST_PROMO, maxParticipants: 1, perUserGasAllowanceMist: '1000' },
  { promotionId: PAGE_PROMO_A, maxParticipants: 10, perUserGasAllowanceMist: '5000000' },
  { promotionId: PAGE_PROMO_B, maxParticipants: 10, perUserGasAllowanceMist: '5000000' },
] as const;

function createInput(fixture: PromotionFixture): AdminPromotionCreateRequest {
  return {
    type: 'gas_sponsorship',
    displayName: `Promotion ${fixture.promotionId}`,
    description: '',
    maxParticipants: fixture.maxParticipants,
    perUserGasAllowanceMist: fixture.perUserGasAllowanceMist,
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
  };
}

class FixedPromotionStore extends MemoryPromotionStore {
  private index = 0;

  protected override generateId(): string {
    const fixture = PROMOTION_LEDGER_FIXTURES[this.index++];
    if (!fixture) throw new Error('Promotion fixture IDs exhausted');
    return fixture.promotionId;
  }
}

export async function createMemoryPromotionLedgerStore(): Promise<MemoryPromotionStore> {
  const store = new FixedPromotionStore();
  for (const fixture of PROMOTION_LEDGER_FIXTURES) {
    const record = await store.create(createInput(fixture));
    await store.transitionStatus(record.promotionId, 'active');
  }
  return store;
}

export async function createRedisPromotionLedgerStore(
  redis: RedisClientLike,
): Promise<RedisPromotionStore> {
  let index = 0;
  const store = new RedisPromotionStore(redis);
  const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    const fixture = PROMOTION_LEDGER_FIXTURES[index++];
    if (!fixture) throw new Error('Promotion fixture IDs exhausted');
    return fixture.promotionId as ReturnType<typeof globalThis.crypto.randomUUID>;
  });
  try {
    for (const fixture of PROMOTION_LEDGER_FIXTURES) {
      const record = await store.create(createInput(fixture));
      await store.transitionStatus(record.promotionId, 'active');
    }
  } finally {
    randomUuid.mockRestore();
  }
  return store;
}
