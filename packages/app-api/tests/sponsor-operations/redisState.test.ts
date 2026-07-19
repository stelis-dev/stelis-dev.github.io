import { beforeEach, describe, expect, it } from 'vitest';
import type { RedisClientLike } from '@stelis/core-api';
import {
  createRedisSponsorOperationsState,
  decodeSponsorRefillAccountRecord,
  decodeSponsorRefillAccountSpendRecord,
  decodeSponsorSlotRecord,
  READ_ALL_LUA,
  READ_SLOT_LUA,
  serializeSponsorRefillAccountRecord,
  serializeSponsorRefillAccountSpendRecord,
  serializeSponsorSlotRecord,
  slotKey,
  SPONSOR_REFILL_ACCOUNT_KEY,
  SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
  SPONSOR_OPERATIONS_MAX_SEQUENCE,
  SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT,
  SPONSOR_SLOT_HASH_FIELDS,
  UPDATE_ENTITY_IF_SEQUENCE_LUA,
  type ReservedSponsorRefillAccountSpend,
} from '../../src/sponsor-operations/redisState.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

type RedisSetOptions = Parameters<RedisClientLike['set']>[2];

const SLOT_A = `0x${'11'.repeat(32)}`;
const SLOT_B = `0x${'22'.repeat(32)}`;
const REFILL_ACCOUNT = `0x${'55'.repeat(32)}`;
const SETTINGS = createTestSponsorOperationsSettings({
  sponsorAddresses: [SLOT_A, SLOT_B],
  sponsorRefillAccountAddress: REFILL_ACCOUNT,
  warnMist: 100n,
  refillTargetMist: 1_000n,
  runwayTargetMist: 1_000n,
  reconciliationIntervalMs: 100,
  slotBalanceTimeoutMs: 50,
  sponsorRefillAccountBalanceTimeoutMs: 50,
});

class StubRedis implements RedisClientLike {
  readonly hashes = new Map<string, Map<string, string>>();
  clock = 1_700_000_000_000;

  private getHash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  seedHash(key: string, fields: Readonly<Record<string, string>>): void {
    this.hashes.set(key, new Map(Object.entries(fields)));
  }

  row(key: string): string[] {
    return [...(this.hashes.get(key)?.entries() ?? [])].flat();
  }

  async get(): Promise<string | null> {
    return null;
  }
  async set(_key: string, _value: string, _options?: RedisSetOptions): Promise<'OK'> {
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    return keys.reduce((count, key) => count + Number(this.hashes.delete(key)), 0);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key)?.entries() ?? []);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script === UPDATE_ENTITY_IF_SEQUENCE_LUA) {
      const exists = this.hashes.has(keys[0]!);
      const hash = this.getHash(keys[0]!);
      if (
        exists &&
        (hash.size !== SPONSOR_SLOT_HASH_FIELDS.length ||
          SPONSOR_SLOT_HASH_FIELDS.some((field) => !hash.has(field)))
      )
        return ['CORRUPT'];
      if ((hash.get('writeSeq') ?? '0') !== args[0]) return ['STALE'];
      if ((hash.get('writeSeq') ?? '0') === String(SPONSOR_OPERATIONS_MAX_SEQUENCE)) {
        return [SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT];
      }
      if (!exists) {
        this.seedHash(keys[0]!, {
          addressBalanceMist: '',
          lastError: '',
          lastObservedAtMs: '',
          writeSeq: '0',
        });
      }
      const current = this.getHash(keys[0]!);
      const next = String(Number(current.get('writeSeq') ?? '0') + 1);
      current.set('writeSeq', next);
      current.set('addressBalanceMist', args[1]!);
      current.set('lastError', args[2]!);
      if (args[1] !== '') current.set('lastObservedAtMs', String(this.clock));
      return ['UPDATED', next];
    }
    if (script === READ_SLOT_LUA) {
      return [this.row(keys[0]!), this.row(keys[1]!), String(this.clock)];
    }
    if (script === READ_ALL_LUA) {
      const rows = args.map((address, index) => [address, this.row(keys[index]!)]);
      return [
        rows,
        this.row(keys[keys.length - 2]!),
        this.row(keys[keys.length - 1]!),
        String(this.clock),
      ];
    }
    throw new Error('unsupported script');
  }
}

function slotObservation(address: string, balance: string, observedAt: number, writeSeq = 1) {
  return serializeSponsorSlotRecord({
    address,
    addressBalanceMist: balance,
    lastError: null,
    lastObservedAtMs: observedAt,
    writeSeq,
  });
}

function reservedRefill(): ReservedSponsorRefillAccountSpend {
  return {
    network: SETTINGS.network,
    operationId: '11111111-1111-4111-8111-111111111111',
    kind: 'refill',
    sourceAddress: REFILL_ACCOUNT,
    destinationAddress: SLOT_A,
    slotAddress: SLOT_A,
    nonceKey: null,
    amountMist: '900',
    sequence: 1,
    state: 'reserved',
  };
}

describe('SponsorOperations Redis records', () => {
  let redis: StubRedis;
  beforeEach(() => {
    redis = new StubRedis();
  });

  it('stores only raw slot observations and derives status from the current spend', () => {
    const serialized = slotObservation(SLOT_A, '500', redis.clock);
    expect(Object.keys(serialized).sort()).toEqual([...SPONSOR_SLOT_HASH_FIELDS].sort());
    expect(decodeSponsorSlotRecord(serialized, SLOT_A, SETTINGS)).toMatchObject({
      state: 'healthy',
      refillOperationState: null,
    });
    const spend = reservedRefill();
    expect(decodeSponsorSlotRecord(serialized, SLOT_A, SETTINGS, spend)).toMatchObject({
      state: 'refilling',
      refillOperationId: spend.operationId,
    });
    expect(() =>
      decodeSponsorSlotRecord({ ...serialized, state: 'healthy' }, SLOT_A, SETTINGS),
    ).toThrow('unexpected field set');
  });

  it('uses exact independent account-observation and spend decoders', () => {
    const account = serializeSponsorRefillAccountRecord(
      {
        totalBalanceMist: '9000',
        lastError: null,
        lastObservedAtMs: redis.clock,
        writeSeq: 1,
      },
      SETTINGS,
    );
    expect(decodeSponsorRefillAccountRecord(account, SETTINGS)).toMatchObject({
      totalBalanceMist: '9000',
      healthy: true,
      writeSeq: 1,
    });
    const spendHash = serializeSponsorRefillAccountSpendRecord(reservedRefill(), SETTINGS);
    expect(decodeSponsorRefillAccountSpendRecord(spendHash, SETTINGS)).toEqual(reservedRefill());
    expect(() =>
      decodeSponsorRefillAccountSpendRecord({ ...spendHash, sequence: '2' }, SETTINGS),
    ).toThrow('reserved state is inconsistent');
    expect(() => decodeSponsorRefillAccountRecord({ ...account, healthy: '1' }, SETTINGS)).toThrow(
      'unexpected field set',
    );
    expect(() =>
      decodeSponsorRefillAccountSpendRecord({ ...spendHash, unexpectedField: '1' }, SETTINGS),
    ).toThrow('unexpected field set');
  });

  it('creates and updates raw slot observations using Redis-authored sequence and time', async () => {
    const state = createRedisSponsorOperationsState({ client: redis, settings: SETTINGS });
    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 0, {
        addressBalanceMist: '500',
        lastError: '',
      }),
    ).resolves.toBe(true);
    await expect(state.readSlot(SLOT_A)).resolves.toMatchObject({
      state: 'healthy',
      addressBalanceMist: '500',
      lastObservedAtMs: redis.clock,
      writeSeq: 1,
    });
    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 0, {
        addressBalanceMist: '600',
        lastError: '',
      }),
    ).resolves.toBe(false);
  });

  it('rejects missing configured records and corrupt current shapes', async () => {
    const state = createRedisSponsorOperationsState({ client: redis, settings: SETTINGS });
    await expect(state.readSlot(SLOT_A)).resolves.toBeNull();
    redis.seedHash(slotKey(SLOT_A), { unexpected: 'value' });
    await expect(state.readSlot(SLOT_A)).rejects.toThrow('addressBalanceMist is missing');
    await expect(state.readSlot(`0x${'99'.repeat(32)}`)).rejects.toThrow('Unknown sponsor address');
  });

  it('reads observations and spend in one snapshot and derives freshness', async () => {
    const state = createRedisSponsorOperationsState({ client: redis, settings: SETTINGS });
    redis.seedHash(slotKey(SLOT_A), slotObservation(SLOT_A, '500', redis.clock));
    redis.seedHash(slotKey(SLOT_B), slotObservation(SLOT_B, '10', redis.clock - 201));
    redis.seedHash(
      SPONSOR_REFILL_ACCOUNT_KEY,
      serializeSponsorRefillAccountRecord(
        {
          totalBalanceMist: '9000',
          lastError: null,
          lastObservedAtMs: redis.clock,
          writeSeq: 1,
        },
        SETTINGS,
      ),
    );
    redis.seedHash(
      SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
      serializeSponsorRefillAccountSpendRecord(reservedRefill(), SETTINGS),
    );
    const result = await state.readAll();
    expect(result.slots.map((slot) => [slot.state, slot.observationFresh])).toEqual([
      ['refilling', true],
      ['low_balance', false],
    ]);
    expect(result.sponsorRefillAccount).toMatchObject({ healthy: true, observationFresh: true });
  });

  it('reads one assigned slot with Redis-time freshness and the current spend projection', async () => {
    const state = createRedisSponsorOperationsState({ client: redis, settings: SETTINGS });
    redis.seedHash(slotKey(SLOT_A), slotObservation(SLOT_A, '500', redis.clock));
    redis.seedHash(
      SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
      serializeSponsorRefillAccountSpendRecord(reservedRefill(), SETTINGS),
    );

    await expect(state.readSlotAvailability(SLOT_A)).resolves.toMatchObject({
      address: SLOT_A,
      state: 'refilling',
      refillOperationId: reservedRefill().operationId,
      observationFresh: true,
    });

    redis.seedHash(slotKey(SLOT_A), slotObservation(SLOT_A, '500', redis.clock - 201));
    await expect(state.readSlotAvailability(SLOT_A)).resolves.toMatchObject({
      observationFresh: false,
    });
  });

  it('rejects future Redis observation time', async () => {
    const state = createRedisSponsorOperationsState({ client: redis, settings: SETTINGS });
    redis.seedHash(slotKey(SLOT_A), slotObservation(SLOT_A, '500', redis.clock + 1));
    redis.seedHash(slotKey(SLOT_B), slotObservation(SLOT_B, '500', redis.clock));
    redis.seedHash(
      SPONSOR_REFILL_ACCOUNT_KEY,
      serializeSponsorRefillAccountRecord(
        { totalBalanceMist: '1', lastError: null, lastObservedAtMs: redis.clock, writeSeq: 1 },
        SETTINGS,
      ),
    );
    await expect(state.readAll()).rejects.toThrow('later than Redis TIME');
  });

  it('uses independent current key names', () => {
    expect(slotKey(SLOT_A)).toBe(`stelis:app-api:sponsor-operations:slot:${SLOT_A}`);
    expect(SPONSOR_REFILL_ACCOUNT_KEY).not.toBe(SPONSOR_REFILL_ACCOUNT_SPEND_KEY);
  });
});
