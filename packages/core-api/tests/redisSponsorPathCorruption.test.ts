/**
 * redisSponsorPathCorruption.test.ts — end-to-end Redis-backed sponsor
 * recovery proof.
 *
 * Covered contract:
 *   - `redisPrepareStore.test.ts` proves the store unit handles corrupt
 *     entries (`peek` throws, `evictPreparedEntry` releases the slot).
 *   - `handleSponsor.test.ts` proves the handler calls `evictPreparedEntry()`
 *     when peek/consume throw, BUT it does so against a `vi.fn()` mock
 *     store.
 *
 * This file covers the real-store/real-handler contract using:
 *   - Real `RedisPrepareStore` (backed by `FakeRedisClient`, no real
 *     daemon needed — runs uniformly in local and isolated test environments).
 *   - Real `handleSponsor()` (no mock).
 *   - Real `SponsorPool` from `context.ts` (single in-memory pool).
 *
 * The test adds a field outside the exact current stored shape, then
 * drives `handleSponsor()` end-to-end and asserts:
 *   1. The sponsor path rejects with `PREPARED_TX_NOT_FOUND`.
 *   2. The slot held by the corrupt entry is checked in (released).
 *   3. The corrupt entry is gone from the underlying Redis store.
 *
 * Promotion-side end-to-end coverage lives in
 * `sponsorPromotionSponsored.test.ts`, which exercises the same pattern
 * through real `MemoryPrepareStore` + real handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64, toBase58 } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import { GAS_VARIANCE_FIXED_MIST, sha256Bytes as _sha256Bytes } from '@stelis/core-relay';
import { SETTLE_WITH_CREDIT_FUNCTION, SLIPPAGE_CAP_BPS } from '@stelis/contracts';
import { computePolicyHash } from '../src/policyHash.js';
import { handleSponsor, SponsorValidationError } from '../src/handlers/sponsor.js';
import type { HostContext } from '../src/context.js';
import { SponsorPool } from '../src/context.js';
import { RedisPrepareStore } from '../src/store/redisPrepareStore.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import type { GenericPreparedTxDraft } from '../src/store/prepareTypes.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import { suiEndpointSnapshotFixture } from './helpers/suiGatewayResultFixtures.js';

// ─── Test constants ─────────────────────────────────────────────────────

const CLIENT_IP = '203.0.113.42';
const senderKp = Ed25519Keypair.generate();
const SENDER = senderKp.toSuiAddress();
const sponsorKp = Ed25519Keypair.generate();
// 32+ char HMAC secret for the sponsor pool lease proofs.
const TEST_HMAC_SECRET = 'redis-corruption-test-hmac-secret-00000';
const SPONSOR_ADDRESS = sponsorKp.toSuiAddress();
const PAYMENT_ID = '0x' + 'cd'.repeat(32);

const MOCK_CONFIG = {
  packageId: '0x' + '11'.repeat(32),
  configId: '0x' + '22'.repeat(32),
  vaultRegistryId: '0x' + '33'.repeat(32),
  settlementPayoutRecipientAddress: '0x' + 'ff'.repeat(32),
  maxClaimMist: 50_000_000n,
  minSettleMist: 1_000_000n,
  maxHostFeeMist: 100_000n,
  protocolFlatFeeMist: 50_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────

async function buildValidTx(): Promise<{
  txBytes: Uint8Array;
  encodedTxBytes: string;
  txHash: string;
}> {
  // Minimal credit-only settlement PTB so handleSponsor's L1 validation would
  // succeed if execution reached it. The corrupt-entry path rejects much
  // earlier — at peek() — so the PTB body is not exercised, but it must
  // still be a real signed transaction so decode/peek can run.
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.setGasOwner(SPONSOR_ADDRESS);
  tx.setGasBudget(5_000_000);
  tx.setGasPrice(1000);
  const digest = new Uint8Array(32);
  digest.fill(1);
  tx.setGasPayment([{ objectId: '0x' + '01'.repeat(32), version: '1', digest: toBase58(digest) }]);
  const objRef = (id: string) =>
    tx.objectRef({ objectId: id, version: '1', digest: toBase58(digest) });

  const policyHashHex = computePolicyHash({
    maxClaimMist: MOCK_CONFIG.maxClaimMist,
    maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
    protocolFeeMist: MOCK_CONFIG.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  });
  const policyHashBytes = Buffer.from(policyHashHex.replace('0x', ''), 'hex');

  tx.moveCall({
    target: `${MOCK_CONFIG.packageId}::settle::${SETTLE_WITH_CREDIT_FUNCTION}`,
    arguments: [
      objRef(MOCK_CONFIG.configId),
      objRef(MOCK_CONFIG.vaultRegistryId),
      objRef('0x6'),
      objRef('0x' + '04'.repeat(32)),
      tx.pure(bcs.u64().serialize(1_000n)),
      tx.pure(bcs.u64().serialize(5_250_000n)),
      tx.pure(bcs.Address.serialize(MOCK_CONFIG.settlementPayoutRecipientAddress)),
      tx.pure(bcs.vector(bcs.u8()).serialize([])),
      tx.pure(bcs.u64().serialize(1n)),
      tx.pure(bcs.u64().serialize(5_000_000n)),
      tx.pure(bcs.u64().serialize(GAS_VARIANCE_FIXED_MIST)),
      tx.pure(bcs.u64().serialize(0n)),
      tx.pure(bcs.u64().serialize(MOCK_CONFIG.maxHostFeeMist)),
      tx.pure(bcs.u64().serialize(MOCK_CONFIG.protocolFlatFeeMist)),
      tx.pure(bcs.u64().serialize(MOCK_CONFIG.configVersion)),
      tx.pure(bcs.u64().serialize(BigInt(Date.now()))),
      tx.pure(bcs.vector(bcs.u8()).serialize([...policyHashBytes])),
      tx.pure(bcs.vector(bcs.u8()).serialize([])),
    ],
    typeArguments: [],
  });

  const bytes = await tx.build({ onlyTransactionKind: false });
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { txBytes: bytes, encodedTxBytes: toBase64(bytes), txHash: hash };
}

function makePreparedDraft(txHash: string): GenericPreparedTxDraft {
  return {
    receiptId: PAYMENT_ID,
    senderAddress: SENDER,
    nonce: 1n,
    txBytesHash: txHash,
    // sponsorAddress is filled in after slot checkout in the test body.
    // No raw lease token is persisted with the entry. The sponsor pool stores
    // its committed lease proof separately, keyed by slot and bound to the
    // receipt id plus commit digest.
    sponsorAddress: SPONSOR_ADDRESS,
    clientIp: CLIENT_IP,
    executionPathKey: 'credit',
    orderId: null,
    mode: 'generic',
  };
}

async function buildValidSignature(data: Uint8Array): Promise<string> {
  const { signature } = await senderKp.signTransaction(data);
  return signature;
}

interface E2EHarness {
  redis: FakeRedisClient;
  prepareStore: RedisPrepareStore;
  sponsorPool: SponsorPool;
  ctx: HostContext;
  releaseSpy: ReturnType<typeof vi.fn>;
}

async function buildHarness(): Promise<E2EHarness> {
  const redis = new FakeRedisClient();
  // Real SponsorPool with a single in-memory key.
  const sponsorPool = new SponsorPool([sponsorKp], { hmacSecret: TEST_HMAC_SECRET });
  // Spy on checkin so we can prove the slot was released without poking
  // at SponsorPool internals.
  const checkinSpy = vi.spyOn(sponsorPool, 'checkin');

  // Track release calls separately for the assertion message.
  // onRelease passes `(sponsorAddress, receiptId, txBytesHash | null)`. The third
  // argument is the commit digest the lease was promoted to in the prepare flow.
  const releaseSpy = vi.fn(
    async (sponsorAddress: string, receiptId: string, txBytesHash: string | null) => {
      await sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash);
    },
  );

  const prepareStore = new RedisPrepareStore(redis, releaseSpy);

  const ctx: HostContext = {
    network: 'testnet',
    // Corruption is rejected before any chain operation. Keep this fixture at
    // the current snapshot boundary instead of advertising unused raw RPC
    // methods from an obsolete client shape.
    sui: suiEndpointSnapshotFixture(),
    sponsorPool: sponsorPool as unknown as HostContext['sponsorPool'],
    packageId: MOCK_CONFIG.packageId,
    deepbookPackageId: MOCK_CONFIG.packageId,
    configId: MOCK_CONFIG.configId,
    vaultRegistryId: MOCK_CONFIG.vaultRegistryId,
    vaultsTableId: `0x${'44'.repeat(32)}`,
    rateLimiter: {} as HostContext['rateLimiter'],
    abuseBlocker: new MemoryAbuseBlocker() as unknown as HostContext['abuseBlocker'],
    prepareStore,
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue('ok' as const),
    },
    prepareInflightLimiter: {
      inflight: 0,
      capacity: 1,
      tryAcquire: vi.fn().mockResolvedValue(null),
    },
    settlementPayoutRecipientAddress: MOCK_CONFIG.settlementPayoutRecipientAddress,
    allowedSettlementSwapPaths: [],
    getConfig: vi.fn().mockResolvedValue({
      packageId: MOCK_CONFIG.packageId,
      configId: MOCK_CONFIG.configId,
      maxClaimMist: MOCK_CONFIG.maxClaimMist,
      minSettleMist: MOCK_CONFIG.minSettleMist,
      maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
      protocolFlatFeeMist: MOCK_CONFIG.protocolFlatFeeMist,
      configVersion: MOCK_CONFIG.configVersion,
      maxSpreadBps: MOCK_CONFIG.maxSpreadBps,
    }),
    invalidateConfigCache: vi.fn(),
    dispose: vi.fn(),
  };

  // Silence the structured event log for clean test output
  void checkinSpy;
  return { redis, prepareStore, sponsorPool, ctx, releaseSpy };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Redis-backed sponsor path: corrupt entry recovery (end-to-end)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects PREPARED_TX_NOT_FOUND, releases slot, and removes the entry from Redis', async () => {
    const harness = await buildHarness();
    const { redis, prepareStore, sponsorPool, ctx, releaseSpy } = harness;

    // 1. Check out a real sponsor slot — this is the slot that will be
    //    held until evictPreparedEntry() releases it. receiptId reserves the
    //    lease and commit() pins it to the final txBytesHash before store().
    const slot = await sponsorPool.checkout(PAYMENT_ID);
    expect(slot).not.toBeNull();
    if (!slot) throw new Error('expected slot');

    // 2. Build a real transaction + signature so handleSponsor can decode
    //    and verify before reaching peek().
    const { txBytes, encodedTxBytes, txHash } = await buildValidTx();
    const userSig = await buildValidSignature(txBytes);

    // 3. Store a valid prepared entry through the real RedisPrepareStore.
    const draft = makePreparedDraft(txHash);
    draft.sponsorAddress = slot.sponsorAddress;
    // Commit the lease to the prepared txBytesHash before store().
    // A post-store corruption path then
    // exercises the evictPreparedEntry → pool.checkin chain with the
    // committed txBytesHash.
    await sponsorPool.commit(slot.sponsorAddress, PAYMENT_ID, txHash);
    await prepareStore.store(draft);

    // 4. Forge corruption by adding a field outside the exact current shape.
    const entryKey = `stelis:prepare:${PAYMENT_ID}`;
    const rawJson = await redis.get(entryKey);
    expect(rawJson).not.toBeNull();
    const parsed = JSON.parse(rawJson!);
    parsed.unexpected = true;
    await redis.set(entryKey, JSON.stringify(parsed), { px: 65_000 });

    // 5. Drive handleSponsor end-to-end. It must reject AND clean up.
    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);

    // 6a. Slot release: handleSponsor's peek-catch must have called
    //     evictPreparedEntry(), which calls _onRelease (the releaseSpy here),
    //     which calls SponsorPool.checkin(). The raw-entry extractor
    //     recovers the committed hash from the forged JSON, and the
    //     pool CAS matches because the Redis lease is already committed
    //     to that same hash above.
    expect(releaseSpy).toHaveBeenCalledWith(slot.sponsorAddress, PAYMENT_ID, txHash);
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // 6b. Entry must be gone from the underlying store. evictPreparedEntry
    //     issues a DEL after attempting slot recovery.
    const afterRaw = await redis.get(entryKey);
    expect(afterRaw).toBeNull();
  });

  it('covers the consume() success-branch deserialize failure path (real corruption between peek and consume)', async () => {
    // This case targets the SECOND throw site inside RedisPrepareStore:
    // `consume()` returns the success branch from Lua, but
    // `deserializeEntry()` then throws. The store-internal code path is:
    //
    //   consume() success branch → try { return deserializeEntry(str) }
    //                              catch (err) {
    //                                releaseSponsorFromRawEntry(str, ...);
    //                                throw err;
    //                              }
    //
    // For the handler to reach `consume()` at all, `peek()` must succeed
    // first. So we cannot just forge corruption before calling
    // handleSponsor — that hits the peek-throw path covered above.
    //
    // Spy on `prepareStore.peek` so it (1) calls the REAL peek
    // implementation, (2) returns a valid entry, and (3) immediately
    // afterward adds a field outside the current shape to the same raw
    // JSON. By the time the handler reaches `consume()` a few async ticks
    // later, the entry is corrupt and `consume()`'s success-branch
    // deserialize fails. The store releases the slot best-effort and
    // re-throws; the handler then catches the throw, calls
    // `evictPreparedEntry()` (idempotent — entry is already DELed by
    // Lua at this point), and rejects with PREPARED_TX_NOT_FOUND.
    //
    // The peek itself stays REAL — we are not faking its return value,
    // only adding a side effect after it returns.
    const harness = await buildHarness();
    const { redis, prepareStore, sponsorPool, ctx, releaseSpy } = harness;

    // receiptId reserves the lease, then commit() pins it to the final
    // txBytesHash before store().
    const slot = await sponsorPool.checkout(PAYMENT_ID);
    if (!slot) throw new Error('expected slot');

    const { txBytes, encodedTxBytes, txHash } = await buildValidTx();
    const userSig = await buildValidSignature(txBytes);
    const draft = makePreparedDraft(txHash);
    draft.sponsorAddress = slot.sponsorAddress;
    // Commit the lease to the prepared txBytesHash before store(). A
    // post-store corruption path then
    // exercises the evictPreparedEntry → pool.checkin chain with the
    // committed txBytesHash.
    await sponsorPool.commit(slot.sponsorAddress, PAYMENT_ID, txHash);
    await prepareStore.store(draft);

    const entryKey = `stelis:prepare:${PAYMENT_ID}`;

    // Spy on peek with the real method passthrough + post-return side effect.
    // bind() preserves `this` binding to the real RedisPrepareStore instance.
    const realPeek = prepareStore.peek.bind(prepareStore);
    const peekSpy = vi.spyOn(prepareStore, 'peek').mockImplementation(async (rid: string) => {
      // 1. Run the real peek end-to-end (real GET, real deserialize).
      const result = await realPeek(rid);
      // 2. Forge current-shape corruption AFTER peek returns. The Redis
      //    write is observed by the next operation (consume's Lua GET).
      if (rid === PAYMENT_ID) {
        const rawJson = await redis.get(entryKey);
        if (rawJson) {
          const parsed = JSON.parse(rawJson);
          parsed.unexpected = true;
          await redis.set(entryKey, JSON.stringify(parsed), { px: 65_000 });
        }
      }
      // 3. Return the (still-valid) entry the real peek produced. The
      //    handler will use peeked.senderAddress and proceed normally
      //    until it reaches consume().
      return result;
    });

    // Also spy on consume so we can prove it was actually invoked.
    const consumeSpy = vi.spyOn(prepareStore, 'consume');

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);

    // peek must have run (and our spy must have forged corruption).
    expect(peekSpy).toHaveBeenCalledWith(PAYMENT_ID);
    // consume must have been reached — this is the whole point of this test.
    expect(consumeSpy).toHaveBeenCalled();
    // consume must have actually thrown (success-branch deserialize failure).
    // We assert it by checking that consume's promise rejected.
    const consumeResult = consumeSpy.mock.results.at(-1);
    expect(consumeResult?.type).toBe('return');
    if (consumeResult?.type === 'return') {
      await expect(consumeResult.value).rejects.toThrow(/unexpected field/);
    }

    // The store-internal raw recovery releases before rethrow. The handler's
    // following idempotent eviction sees an absent entry and must not release
    // the same lease a second time.
    // onRelease is invoked with `(sponsorAddress, receiptId, txBytesHash)`.
    // The raw-entry extractor recovers the committed hash from the
    // forged JSON, and the pool CAS matches because the Redis lease
    // is already committed to that same hash above.
    expect(releaseSpy).toHaveBeenCalledWith(slot.sponsorAddress, PAYMENT_ID, txHash);
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // Entry must be gone from Redis after the failure handling.
    const afterRaw = await redis.get(entryKey);
    expect(afterRaw).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // Core acceptance:
  // a live committed lease must still refuse attacker bytes even if a
  // Redis attacker overwrites the prepare entry's `txBytesHash` under
  // the same receiptId.
  // ─────────────────────────────────────────────────────────────

  // The SponsorPool signing gate is bound to the prepare commit via the
  // two-stage HMAC proof, so a Redis-only attacker who overwrites the
  // prepare entry's `txBytesHash` under the same receiptId cannot reach
  // the signer with their own PTB — the committed proof in Redis still
  // references the original hash.
  //
  // We exercise this at the SponsorPool layer directly (without
  // building a full handleSponsor flow) so the test is not fragile
  // to upstream validation paths. The pool-unit contract is the
  // tight closure: if pool.sign() refuses the attacker bytes under
  // a live committed lease, no caller can reach a successful
  // signature for them.
  it('Redis prepare entry tampering does not pass sponsor slot HMAC verification', async () => {
    const harness = await buildHarness();
    const { redis, prepareStore, sponsorPool } = harness;

    // 1. Legitimate prepare: checkout, commit to legit hash, store.
    const slot = await sponsorPool.checkout(PAYMENT_ID);
    if (!slot) throw new Error('expected slot');
    const legit = await buildValidTx();
    const legitDraft = makePreparedDraft(legit.txHash);
    legitDraft.sponsorAddress = slot.sponsorAddress;
    await sponsorPool.commit(slot.sponsorAddress, PAYMENT_ID, legit.txHash);
    await prepareStore.store(legitDraft);

    // 2. Attacker overwrites entry[PAYMENT_ID].txBytesHash to a
    //    hash of their choice, simulating Redis-write compromise.
    const attackerBytes = new Uint8Array([0xba, 0xad, 0xf0, 0x0d]);
    const attackerHash = createHash('sha256').update(attackerBytes).digest('hex');
    expect(attackerHash).not.toBe(legit.txHash);

    const entryKey = `stelis:prepare:${PAYMENT_ID}`;
    const rawJson = await redis.get(entryKey);
    expect(rawJson).not.toBeNull();
    const parsed = JSON.parse(rawJson!);
    parsed.txBytesHash = attackerHash;
    await redis.set(entryKey, JSON.stringify(parsed), { px: 65_000 });

    // 3. Sanity: the store-level consume() accepts the forged entry
    //    because its txBytesHash matches hash(attackerBytes). The
    //    attack SHOULD pass consume() — that's exactly why a pool-
    //    layer commit-bound proof is needed.
    const peeked = await prepareStore.peek(PAYMENT_ID);
    expect(peeked?.txBytesHash).toBe(attackerHash);

    // 4. Pool.sign() for the attacker's bytes must fail. The Redis
    //    lease value is still HMAC(secret, PAYMENT_ID || slot || legit.txHash).
    //    pool.sign() computes HMAC(secret, PAYMENT_ID || slot || hash(attackerBytes))
    //    which is a different hex digest — the comparison fails.
    await expect(
      sponsorPool.sign(slot.sponsorAddress, PAYMENT_ID, attackerBytes),
    ).rejects.toThrow();

    // 5. Positive control: the legitimate bytes still succeed
    //    because the commit digest was hash(legit.txBytes).
    const ok = await sponsorPool.sign(slot.sponsorAddress, PAYMENT_ID, legit.txBytes);
    expect(ok.signature).toBeDefined();
  });
});
