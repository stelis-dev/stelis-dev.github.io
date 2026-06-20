/**
 * [app-api] Admin routes — /api/blocklist, /api/logs, /api/sponsor-operations,
 * /api/sponsor-refill-account/withdraw, /api/settlement-swap-paths, /api/studio, /api/promotions*
 *
 * All routes are protected by requireAdminSession (JWT + not_before).
 *
 * Boundary: binds app-api host concerns with core-api admin helpers
 * and the shared admin contracts in @stelis/contracts.
 */
import { Hono } from 'hono';
import {
  buildSponsorRefillAccountWithdrawMessage,
  type DeepBookPoolHop,
  type SponsorOperationsStatus,
} from '@stelis/contracts';
import {
  getRedisForAdmin,
  pushAdminOperationLog,
  checkAndIncrementAdminOperationAttempt,
  verifySignedMessage,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import {
  parseSponsorKey,
  readJsonBodyWithLimit,
  MAX_SMALL_REQUEST_BODY_BYTES,
} from '@stelis/core-api';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/core-api/studio';
import {
  SPONSOR_BALANCE_WARN_MIST,
  SPONSOR_BALANCE_REFILL_TARGET_MIST,
} from '../sponsor-operations/defaults.js';
import { deriveSponsorAvailabilitySummary } from '../sponsor-operations/gate.js';
import type { AppApiContext } from '../context.js';
import { requireAdminSession } from '../requireAdminSession.js';
import { getClientIp } from '../clientIp.js';
import { requireEnv, parseOptionalBooleanEnv, parseOptionalPositiveBigIntEnv } from '../env.js';
import { parseChainBalanceMist } from '../sponsor-operations/balanceParsing.js';
import { safeBigintToNumber } from '../wireNumbers.js';

/**
 * Enrich a Promotion with derived totalRequiredBudgetMist.
 * This keeps the computation in core-api and avoids storing derived data.
 * The derived value is display-only: over-bound draft products are still
 * rendered exactly here and rejected later by the activation gate.
 */
async function withDerivedBudget<T extends import('@stelis/core-api/studio').Promotion>(
  record: T,
): Promise<T & { totalRequiredBudgetMist: string }> {
  const { computeTotalRequiredBudgetMist } = await import('@stelis/core-api/studio');
  return {
    ...record,
    totalRequiredBudgetMist: computeTotalRequiredBudgetMist(record),
  };
}

/**
 * Compute admin summary for a promotion using context stores.
 * Returns null if required stores are not available.
 */
async function computeAdminSummary(
  ctx: AppApiContext,
  promotionId: string,
  promotion: import('@stelis/core-api/studio').Promotion,
): Promise<import('@stelis/core-api/studio').PromotionAdminSummary | null> {
  if (!ctx.executionLedger) return null;
  const { computePromotionAdminSummary } = await import('@stelis/core-api/studio');
  const [claimedCount, budgetSummary] = await Promise.all([
    ctx.executionLedger.getClaimedCount(promotionId),
    ctx.executionLedger.getBudgetSummary(promotionId),
  ]);
  return computePromotionAdminSummary(promotion, claimedCount, budgetSummary);
}
import { tryBodyErrorResponse } from '../bodyError.js';

/**
 * Thrown by the promotion body parse guards in this file.
 * Caught in the route handler and mapped to 400 BAD_REQUEST.
 * Keeps request-body parse errors distinct from store-level semantic errors
 * (`PromotionFieldImmutableError`, `InvalidStatusTransitionError`, …).
 */
class PromotionBodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionBodyParseError';
  }
}

function parseRequiredString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new PromotionBodyParseError(`Invalid ${field}: must be a non-empty string`);
  }
  return v;
}

function parseOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new PromotionBodyParseError(`Invalid ${field}: must be a string`);
  }
  return v;
}

function parseRequiredPositiveInteger(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new PromotionBodyParseError(
      `Invalid ${field}: must be a positive safe integer (≤ 2^53 − 1)`,
    );
  }
  return v;
}

function parseOptionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new PromotionBodyParseError(
      `Invalid ${field}: must be a positive safe integer (≤ 2^53 − 1)`,
    );
  }
  return v;
}

function parseRequiredPositiveBigintString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string') {
    throw new PromotionBodyParseError(`Invalid ${field}: must be a bigint string`);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(v)) {
    throw new PromotionBodyParseError(`Invalid ${field}: must be a decimal bigint string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(v);
  } catch {
    throw new PromotionBodyParseError(`Invalid ${field}: not a valid bigint string`);
  }
  if (parsed <= 0n) {
    throw new PromotionBodyParseError(`Invalid ${field}: must be a positive bigint`);
  }
  return v;
}

function parseOptionalPositiveBigintString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  return parseRequiredPositiveBigintString(body, field);
}

/**
 * Fail-fast cap on a `perUserGasAllowanceMist` value at the API
 * boundary so over-bound promotions are rejected before they reach the
 * promotion store. The activation gate
 * (`validateActivationPrerequisites`) is the main validation point and
 * also enforces the same bound; this helper is the operator-friendly
 * 400 response on the admin write path.
 *
 * Bound: `MAX_PROMOTION_LEDGER_VALUE_MIST` (= `Number.MAX_SAFE_INTEGER`),
 * see `packages/core-api/src/studio/executionLedger.ts` for the
 * Redis-Lua int64 arithmetic rationale.
 */
function assertPerUserAllowanceWithinBound(value: string): void {
  const parsed = BigInt(value);
  if (parsed > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionBodyParseError(
      `Invalid perUserGasAllowanceMist (${parsed.toString()}): must be ≤ ${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()} (Number.MAX_SAFE_INTEGER) so the promotion ledger Redis-Lua int64 arithmetic stays exact`,
    );
  }
}

function parseOptionalNonNegativeInteger(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new PromotionBodyParseError(
      `Invalid ${field}: must be a non-negative safe integer (≤ 2^53 − 1)`,
    );
  }
  return v;
}

function parseOptionalNullableIsoString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
    throw new PromotionBodyParseError(`Invalid ${field}: must be null or a valid ISO 8601 string`);
  }
  return v;
}

/**
 * Shared error mapper for promotion admin routes.
 * Returns a Response when the error matches a known promotion contract.
 */
function tryPromotionErrorResponse(c: Parameters<typeof tryBodyErrorResponse>[0], err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'PromotionBodyParseError') {
      return c.json({ error: err.message }, 400);
    }
    if (
      err.name === 'InvalidStatusTransitionError' ||
      err.name === 'ConcurrentStatusTransitionError' ||
      err.name === 'PromotionFieldImmutableError'
    ) {
      return c.json({ error: err.message }, 409);
    }
    if (err.name === 'PromotionActivationError') {
      return c.json({ error: err.message }, 422);
    }
  }
  return null;
}

const IP_PREFIX = 'stelis:abuse:block:ip:';
const ADDR_PREFIX = 'stelis:abuse:block:address:';
const ADMIN_LOGS_KEY = 'stelis:admin:logs';
const ADMIN_LOGS_MAX = 200;
const WITHDRAW_NONCE_PREFIX = 'stelis:admin:withdraw_nonce:';
const WITHDRAW_NONCE_TTL_SECONDS = 60;
const WITHDRAW_GAS_BUFFER_MIST = 50_000_000n;
const AMOUNT_MIST_REGEX = /^(?:0|[1-9]\d*)$/;

function isValidAmountMist(s: string): boolean {
  return AMOUNT_MIST_REGEX.test(s) && s !== '0';
}

const SPONSORED_LOGS_DEFAULT_LIMIT = 50;
const SPONSORED_LOGS_MAX_LIMIT = 200;

function parseSponsoredLogsMode(
  raw: string | undefined,
): import('../sponsoredLogs/types.js').SponsoredExecutionAggregateMode | null {
  if (raw === undefined || raw === '') return 'all';
  if (raw === 'all' || raw === 'generic' || raw === 'promotion') return raw;
  return null;
}

function parseSponsoredLogsLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return SPONSORED_LOGS_DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (n > SPONSORED_LOGS_MAX_LIMIT) return null;
  return n;
}

async function getAdminRedis(): Promise<AdminRedisClient> {
  return getRedisForAdmin(requireEnv('REDIS_URL'));
}

export function createAdminRoutes(getCtx: () => Promise<AppApiContext>) {
  const app = new Hono();

  // ── Auth guard middleware — all admin routes require session ───────
  app.use('*', async (c, next) => {
    const session = await requireAdminSession(c);
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('adminSession' as never, session as never);
    await next();
  });

  // ── GET /api/blocklist ────────────────────────────────────────────
  app.get('/blocklist', async (c) => {
    try {
      const redis = await getAdminRedis();
      const [ipKeys, addrKeys] = await Promise.all([
        redis.scan(`${IP_PREFIX}*`),
        redis.scan(`${ADDR_PREFIX}*`),
      ]);

      const entries = await Promise.all(
        [...ipKeys, ...addrKeys].map(async (key) => {
          const ttl = await redis.ttl(key);
          return { key, ttl };
        }),
      );

      return c.json({ blocklist: entries });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── DELETE /api/blocklist ─────────────────────────────────────────
  app.delete('/blocklist', async (c) => {
    try {
      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as {
        key?: string;
      };
      if (!body.key || typeof body.key !== 'string') {
        return c.json({ error: 'Missing field: key' }, 400);
      }

      const allowed = [IP_PREFIX, ADDR_PREFIX];
      if (!allowed.some((p) => body.key!.startsWith(p))) {
        return c.json({ error: 'Unauthorized key prefix' }, 403);
      }

      const redis = await getAdminRedis();
      await redis.del(body.key);
      return c.json({ ok: true, deleted: body.key });
    } catch (err) {
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/logs ─────────────────────────────────────────────────
  app.get('/logs', async (c) => {
    try {
      const redis = await getAdminRedis();
      const entries = await redis.lrange(ADMIN_LOGS_KEY, 0, ADMIN_LOGS_MAX - 1);
      return c.json({ logs: entries });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/sponsored-logs/summary ─────────────────────────────────
  // Lifetime aggregate KPI for the Dashboard (mode=all by default) and
  // Sponsored Logs filter dropdown. Reads exact MIST decimal strings
  // from the durable aggregate; never derives lifetime totals from
  // bounded recent rows.
  app.get('/sponsored-logs/summary', async (c) => {
    const mode = parseSponsoredLogsMode(c.req.query('mode'));
    if (mode === null) {
      return c.json({ error: 'Invalid mode (expected all|generic|promotion)' }, 400);
    }
    try {
      const ctx = await getCtx();
      const summary = await ctx.sponsoredLogsStore.getSummary(mode);
      return c.json({ summary });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/sponsored-logs ─────────────────────────────────────────
  // Combined summary + bounded recent entries for the Sponsored Logs
  // page. Numeric fields are exact MIST decimal strings (signed where
  // applicable) or `null` for unknown economics.
  app.get('/sponsored-logs', async (c) => {
    const mode = parseSponsoredLogsMode(c.req.query('mode'));
    if (mode === null) {
      return c.json({ error: 'Invalid mode (expected all|generic|promotion)' }, 400);
    }
    const limit = parseSponsoredLogsLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: 'Invalid limit (expected positive integer ≤ 200)' }, 400);
    }
    try {
      const ctx = await getCtx();
      const [summary, entries] = await Promise.all([
        ctx.sponsoredLogsStore.getSummary(mode),
        ctx.sponsoredLogsStore.getRecent(mode, limit),
      ]);
      return c.json({ summary, entries });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/sponsor-operations ─────────────────────────────────────────────────
  // Admin view. Sponsor operations fields are read from the shared Redis state
  // store. An awaited bounded sponsor refill account probe runs before the read so the
  // returned sponsor refill account balance is "fresh at return time" rather than
  // last-known-cache.
  // If that awaited sponsor refill account update cannot be committed, this route fails
  // closed instead of serialising stale sponsor refill account data as if it were fresh.
  // `feeConfig` uses `host.getConfig()` which is already TTL-cached in
  // core-api. Other fields are boot-derived constants.
  app.get('/sponsor-operations', async (c) => {
    try {
      const ctx = await getCtx();
      const host = ctx.host;

      // Await the bounded sponsor refill account probe here. Admin is not a hot path,
      // and awaiting keeps the returned sponsor refill account fields honest.
      await ctx.sponsorOperations.probeSponsorRefillAccount('admin_sponsor_operations');

      const [stateView, slotLeases] = await Promise.all([
        ctx.sponsorOperations.readState(),
        host.sponsorPool.leaseStatus(),
      ]);
      const aggregates = deriveSponsorAvailabilitySummary(stateView);
      const sponsorOperations: SponsorOperationsStatus = {
        slots: stateView.slots.map((s) => ({
          address: s.address,
          state: s.state,
          balanceMist: s.balanceMist,
          lastObservedAtMs: s.lastObservedAtMs,
          lastError: s.lastError,
        })),
        sponsorRefillAccount: {
          address: ctx.sponsorOperations.sponsorRefillAccountAddress,
          balanceMist: stateView.sponsorRefillAccount.balanceMist,
          healthy: stateView.sponsorRefillAccount.healthy ?? false,
          refillsRemaining: stateView.sponsorRefillAccount.refillsRemaining,
          lastObservedAtMs: stateView.sponsorRefillAccount.lastObservedAtMs,
          lastError: stateView.sponsorRefillAccount.lastError,
        },
        availableSlots: aggregates.availableSlots,
        degradedSlots: aggregates.degradedSlots,
        slotLeases,
        gateErrorCode: aggregates.gateErrorCode,
      };

      // Operational thresholds (env overrides, else internalized defaults)
      const warnMist =
        parseOptionalPositiveBigIntEnv(
          'SPONSOR_BALANCE_WARN_MIST',
          process.env.SPONSOR_BALANCE_WARN_MIST,
        ) ?? SPONSOR_BALANCE_WARN_MIST;
      const refillTargetMist =
        parseOptionalPositiveBigIntEnv(
          'SPONSOR_BALANCE_REFILL_TARGET_MIST',
          process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST,
        ) ?? SPONSOR_BALANCE_REFILL_TARGET_MIST;

      // On-chain fee config (core-api TTL cache; see getConfig() in
      // packages/core-api/src/context.ts).
      let feeConfig: Record<string, string> | null = null;
      try {
        const cfg = await host.getConfig();
        feeConfig = {
          maxHostFeeMist: cfg.maxHostFeeMist.toString(),
          protocolFlatFeeMist: cfg.protocolFlatFeeMist.toString(),
          maxClaimMist: cfg.maxClaimMist.toString(),
          minSettleMist: cfg.minSettleMist.toString(),
          configVersion: cfg.configVersion.toString(),
        };
      } catch {
        /* ignore */
      }

      // Supported settlement swap paths — convert bigint pool metadata for JSON transport.
      const supportedSettlementSwapPaths = ctx.prepareConfig.supportedSettlementSwapPaths.map(
        (p) => ({
          ...p,
          lotSize: safeBigintToNumber(p.lotSize, 'lotSize'),
          minSize: safeBigintToNumber(p.minSize, 'minSize'),
        }),
      );

      return c.json({
        sponsorOperations,
        primaryAddress: host.sponsorPool.primaryAddress,
        settlementPayoutRecipientAddress: host.settlementPayoutRecipientAddress,
        network: host.network,
        sponsorBalanceWarnMist: warnMist.toString(),
        sponsorBalanceRefillTargetMist: refillTargetMist.toString(),
        refillEnabled: process.env.SPONSOR_OPERATIONS_REFILL_ENABLED === 'true',
        quotedHostFeeMist: ctx.prepareConfig.quotedHostFeeMist.toString(),
        feeConfig,
        supportedSettlementSwapPaths,
        onChainIds: {
          packageId: host.packageId,
          configId: host.configId,
          vaultRegistryId: host.vaultRegistryId,
          deepbookPackageId: ctx.prepareConfig.deepbookPackageId,
        },
        studioEnabled: ctx.studio !== null,
        rpcFleet: ctx.failoverTransport.getAdminSnapshot(),
      });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/sponsor-refill-account/withdraw — issue withdraw nonce ─────────────────
  app.get('/sponsor-refill-account/withdraw', async (c) => {
    const ip = getClientIp(c);
    try {
      const redis = await getAdminRedis();
      const nonce = `stelis-withdraw:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(`${WITHDRAW_NONCE_PREFIX}${nonce}`, '1', { ex: WITHDRAW_NONCE_TTL_SECONDS });
      const expiresAt = new Date(Date.now() + WITHDRAW_NONCE_TTL_SECONDS * 1000).toISOString();
      return c.json({ nonce, expiresAt });
    } catch (err) {
      await pushAdminOperationLog(await getAdminRedis(), {
        event: 'WITHDRAW_NONCE_ERROR',
        ts: new Date().toISOString(),
        ip,
        detail: String(err),
      }).catch(() => undefined);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /api/sponsor-refill-account/withdraw — execute withdrawal ──────────────────
  app.post('/sponsor-refill-account/withdraw', async (c) => {
    try {
      const ip = getClientIp(c);
      const ts = () => new Date().toISOString();
      const redis = await getAdminRedis();
      // Atomic ops rate-limit check at entry
      const rateCheck = await checkAndIncrementAdminOperationAttempt(redis, ip);
      if (!rateCheck.allowed) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_RATE_LIMITED',
          ts: ts(),
          ip,
          detail: `429: ${rateCheck.current} attempts`,
        });
        return c.json({ error: 'Too many withdrawal attempts. Try again in 15 minutes.' }, 429);
      }

      // Parse body
      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as {
        amountMist?: string;
        nonce?: string;
        signature?: string;
      };
      const { amountMist, nonce, signature } = body;
      if (!amountMist || !nonce || !signature) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: '400: missing fields',
        });
        return c.json({ error: 'amountMist, nonce, and signature are required' }, 400);
      }

      // amountMist validation
      const isMax = amountMist === 'max';
      if (!isMax && !isValidAmountMist(amountMist)) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: `400: invalid amountMist: "${amountMist}"`,
        });
        return c.json(
          { error: 'amountMist must be a positive decimal integer string or "max"' },
          400,
        );
      }

      // Nonce validation — atomic DEL-as-consume (single-use guarantee under concurrency)
      const nonceKey = `${WITHDRAW_NONCE_PREFIX}${nonce}`;
      const nonceDeleted = await redis.del(nonceKey);
      if (nonceDeleted === 0) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: '401: invalid nonce',
        });
        return c.json({ error: 'Invalid or expired nonce' }, 401);
      }

      // Signature verification uses the shared browser/server helper.
      const adminAddress = requireEnv('ADMIN_ADDRESS');
      const message = buildSponsorRefillAccountWithdrawMessage(amountMist, nonce);
      const sigValid = await verifySignedMessage({ message, signature, adminAddress });
      if (!sigValid) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: '401: bad signature',
        });
        return c.json({ error: 'Invalid signature' }, 401);
      }

      // Execute withdrawal
      const ctx = await getCtx();
      const sponsorRefillAccountKeypair = parseSponsorKey(
        requireEnv('SPONSOR_REFILL_ACCOUNT_SECRET_KEY'),
        'SPONSOR_REFILL_ACCOUNT_SECRET_KEY',
      );
      const recipientAddress = requireEnv('ADMIN_ADDRESS');
      const sponsorRefillAccountAddress = sponsorRefillAccountKeypair.toSuiAddress();

      // Runway guard
      const refillEnabled =
        parseOptionalBooleanEnv(
          'SPONSOR_OPERATIONS_REFILL_ENABLED',
          process.env.SPONSOR_OPERATIONS_REFILL_ENABLED,
        ) ?? false;

      if (refillEnabled && !isMax) {
        const refillTargetMist =
          parseOptionalPositiveBigIntEnv(
            'SPONSOR_BALANCE_REFILL_TARGET_MIST',
            process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST,
          ) ?? SPONSOR_BALANCE_REFILL_TARGET_MIST;
        if (refillTargetMist > 0n) {
          const poolSize = BigInt(ctx.host.sponsorPool.size);
          const minRunwayMist = refillTargetMist * poolSize;
          const sponsorRefillAccountBalance = await ctx.host.sui.getBalance({
            owner: sponsorRefillAccountAddress,
          });
          const sponsorRefillAccountBalanceMist = parseChainBalanceMist(
            sponsorRefillAccountBalance.balance.balance,
            'Sponsor refill account balance',
          );
          const postWithdrawBalance =
            sponsorRefillAccountBalanceMist - BigInt(amountMist) - WITHDRAW_GAS_BUFFER_MIST;
          if (postWithdrawBalance < minRunwayMist) {
            await pushAdminOperationLog(redis, {
              event: 'WITHDRAWAL_BLOCKED',
              ts: ts(),
              ip,
              detail: `runway guard: post-withdraw ${postWithdrawBalance} < minRunway ${minRunwayMist}`,
            });
            return c.json(
              {
                error: 'Withdrawal would leave sponsor refill account below minimum refill runway.',
              },
              400,
            );
          }
        }
      } else if (refillEnabled && isMax) {
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_RUNWAY_BYPASS',
          ts: ts(),
          ip,
          detail: 'isMax withdrawal bypasses runway guard',
        });
      }

      // Build and execute TX
      const { Transaction } = await import('@mysten/sui/transactions');
      const ptb = new Transaction();
      if (isMax) {
        ptb.transferObjects([ptb.gas], recipientAddress);
      } else {
        const amountBigInt = BigInt(amountMist);
        const [coin] = ptb.splitCoins(ptb.gas, [ptb.pure.u64(amountBigInt)]);
        ptb.transferObjects([coin], recipientAddress);
      }

      ptb.setSender(sponsorRefillAccountAddress);
      const dryRunBytes = await ptb.build({ client: ctx.host.sui });
      const simResult = await ctx.host.sui.simulateTransaction({
        transaction: dryRunBytes,
        include: { effects: true },
      });

      const simTx = simResult.Transaction;
      if (!simTx || !simTx.status?.success) {
        const errMsg = simTx?.status?.error ?? 'dry-run failed';
        await pushAdminOperationLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: `dry-run: ${errMsg}`,
        });
        return c.json({ error: `Dry-run failed: ${errMsg}` }, 422);
      }

      const result = await sponsorRefillAccountKeypair.signAndExecuteTransaction({
        transaction: ptb,
        client: ctx.host.sui,
      });

      const txResult = result.Transaction;
      if (!txResult) {
        throw new Error('Withdrawal execution returned no result');
      }

      const digest = txResult.digest ?? 'unknown';

      // Fetch remaining sponsor refill account balance
      let remainingBalanceMist: string | null = null;
      try {
        const bal = await ctx.host.sui.getBalance({ owner: sponsorRefillAccountAddress });
        remainingBalanceMist = parseChainBalanceMist(
          bal.balance.balance,
          'Sponsor refill account balance',
        ).toString();
      } catch {
        /* non-critical */
      }

      await pushAdminOperationLog(redis, {
        event: 'WITHDRAWAL_SUCCESS',
        ts: ts(),
        ip,
        detail: `${amountMist} MIST → ${recipientAddress} (${digest})`,
      });

      // Refresh sponsor refill account shared state after a successful withdraw. Awaited
      // before the response returns so the next admin read sees the
      // post-withdraw sponsor refill account state without inventing a route-local write
      // contract. The helper logs and resolves if the shared-state
      // write cannot be committed.
      await ctx.sponsorOperations.probeSponsorRefillAccount('admin_withdraw');

      return c.json({
        digest,
        amountMist,
        recipient: recipientAddress,
        remainingBalanceMist,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sponsor-refill-account/withdraw] Unexpected error:', err);
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      try {
        const r = await getAdminRedis();
        await pushAdminOperationLog(r, {
          event: 'WITHDRAWAL_ERROR',
          ts: new Date().toISOString(),
          ip: getClientIp(c),
          detail: String(err),
        });
      } catch {
        /* Redis unavailable — audit log best-effort */
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/settlement-swap-paths ────────────────────────────────
  // Operational inspection: returns the active settlement swap path registry loaded at boot.
  app.get('/settlement-swap-paths', async (c) => {
    try {
      const ctx = await getCtx();
      const settlementSwapPaths = ctx.prepareConfig.supportedSettlementSwapPaths;
      return c.json({
        count: settlementSwapPaths.length,
        settlementSwapPaths: settlementSwapPaths.map((p) => ({
          settlementTokenType: p.settlementTokenType,
          settlementTokenSymbol: p.settlementTokenSymbol,
          settlementTokenDecimals: p.settlementTokenDecimals,
          lotSize: safeBigintToNumber(p.lotSize, 'lotSize'),
          minSize: safeBigintToNumber(p.minSize, 'minSize'),
          effectiveFeeRateBps: p.effectiveFeeRateBps,
          settlementSwapDirection: p.settlementSwapDirection,
          hopCount: p.hops.length,
          hops: p.hops.map((h: DeepBookPoolHop) => ({
            poolId: h.poolId,
            baseType: h.baseType,
            quoteType: h.quoteType,
            swapDirection: h.swapDirection,
            feeBps: h.feeBps,
          })),
        })),
      });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/studio ──────────────────────────────────────────────
  // Studio operational status.
  // Returns { enabled: false } if studio mode is not active.
  // Budget is per-promotion — use GET /api/promotions/:id for per-promotion KPIs.
  app.get('/studio', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.studio) {
        return c.json({ enabled: false }, 200);
      }

      return c.json({
        enabled: true,
        config: {
          developerJwtTrustConfigured: !!ctx.developerJwtTrustConfig,
          developerJwtVerifyUrlConfigured: !!ctx.developerJwtVerifyUrl,
        },
      });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
  // ── GET /api/promotions ──────────────────────────────────────────
  app.get('/promotions', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const statusFilter = c.req.query('status') as
        | import('@stelis/core-api/studio').PromotionStatus
        | undefined;
      const promotions = await ctx.promotionStore.list(
        statusFilter ? { status: statusFilter } : undefined,
      );
      const enriched = await Promise.all(promotions.map(withDerivedBudget));
      return c.json({ promotions: enriched });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /api/promotions ─────────────────────────────────────────
  app.post('/promotions', async (c) => {
    const ip = getClientIp(c);
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as Record<
        string,
        unknown
      >;

      // Only gas_sponsorship is creatable.
      if (body.type !== 'gas_sponsorship') {
        return c.json(
          { error: 'Only gas_sponsorship promotions can be created in this version' },
          400,
        );
      }

      const perUserGasAllowanceMistParsed = parseRequiredPositiveBigintString(
        body,
        'perUserGasAllowanceMist',
      );
      assertPerUserAllowanceWithinBound(perUserGasAllowanceMistParsed);
      const input: import('@stelis/core-api/studio').CreatePromotionInput = {
        type: 'gas_sponsorship',
        displayName: parseRequiredString(body, 'displayName'),
        description: parseOptionalString(body, 'description') ?? '',
        maxParticipants: parseRequiredPositiveInteger(body, 'maxParticipants'),
        perUserGasAllowanceMist: perUserGasAllowanceMistParsed,
        claimDeadlineAt: parseOptionalNullableIsoString(body, 'claimDeadlineAt') ?? null,
        postClaimUseWindowMs: parseOptionalNonNegativeInteger(body, 'postClaimUseWindowMs') ?? 0,
        startAt: parseOptionalNullableIsoString(body, 'startAt') ?? null,
      };

      const record = await ctx.promotionStore.create(input);
      // Durable admin audit trail: emit the same operation-log event shape used by
      // every other admin write path so `/api/logs` and `app-admin` can
      // attribute promotion creation without bespoke sink wiring.
      await pushAdminOperationLog(await getAdminRedis(), {
        event: 'PROMOTION_CREATE',
        ts: new Date().toISOString(),
        ip,
        detail: `201: promotionId=${record.promotionId}, maxParticipants=${record.maxParticipants}, perUserGasAllowanceMist=${record.perUserGasAllowanceMist}`,
      }).catch(() => undefined);
      return c.json({ promotion: await withDerivedBudget(record) }, 201);
    } catch (err) {
      const mapped = tryPromotionErrorResponse(c, err);
      if (mapped) return mapped;
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/promotions/:id ──────────────────────────────────────
  // Returns the promotion plus derived admin summary data.
  app.get('/promotions/:id', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const record = await ctx.promotionStore.get(id);
      if (!record) {
        return c.json({ error: 'Promotion not found' }, 404);
      }
      const enriched = await withDerivedBudget(record);
      const summary = await computeAdminSummary(ctx, id, record);
      return c.json({ promotion: enriched, summary });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── PUT /api/promotions/:id ──────────────────────────────────────
  app.put('/promotions/:id', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as Record<
        string,
        unknown
      >;

      const input: import('@stelis/core-api/studio').UpdatePromotionInput = {};

      const displayName = parseOptionalString(body, 'displayName');
      if (displayName !== undefined) {
        if (displayName.length === 0) {
          return c.json({ error: 'Invalid displayName: must be a non-empty string' }, 400);
        }
        input.displayName = displayName;
      }
      const description = parseOptionalString(body, 'description');
      if (description !== undefined) input.description = description;

      const maxParticipants = parseOptionalPositiveInteger(body, 'maxParticipants');
      if (maxParticipants !== undefined) input.maxParticipants = maxParticipants;

      const perUserGasAllowanceMist = parseOptionalPositiveBigintString(
        body,
        'perUserGasAllowanceMist',
      );
      if (perUserGasAllowanceMist !== undefined) {
        assertPerUserAllowanceWithinBound(perUserGasAllowanceMist);
        input.perUserGasAllowanceMist = perUserGasAllowanceMist;
      }

      const claimDeadlineAt = parseOptionalNullableIsoString(body, 'claimDeadlineAt');
      if (claimDeadlineAt !== undefined) input.claimDeadlineAt = claimDeadlineAt;

      const postClaimUseWindowMs = parseOptionalNonNegativeInteger(body, 'postClaimUseWindowMs');
      if (postClaimUseWindowMs !== undefined) input.postClaimUseWindowMs = postClaimUseWindowMs;

      const startAt = parseOptionalNullableIsoString(body, 'startAt');
      if (startAt !== undefined) input.startAt = startAt;

      const record = await ctx.promotionStore.update(id, input);
      if (!record) {
        return c.json({ error: 'Promotion not found' }, 404);
      }
      return c.json({ promotion: await withDerivedBudget(record) });
    } catch (err) {
      const mapped = tryPromotionErrorResponse(c, err);
      if (mapped) return mapped;
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /api/promotions/:id/status ──────────────────────────────
  app.post('/promotions/:id/status', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as {
        status?: string;
        reason?: string;
      };
      if (!body.status || typeof body.status !== 'string') {
        return c.json({ error: 'Missing required field: status' }, 400);
      }
      const validStatuses = ['draft', 'active', 'paused', 'archived'];
      if (!validStatuses.includes(body.status)) {
        return c.json({ error: `Invalid status: ${body.status}` }, 400);
      }

      const record = await ctx.promotionStore.transitionStatus(
        id,
        body.status as import('@stelis/core-api/studio').PromotionStatus,
        body.reason,
      );
      if (!record) {
        return c.json({ error: 'Promotion not found' }, 404);
      }
      return c.json({ promotion: await withDerivedBudget(record) });
    } catch (err) {
      const mapped = tryPromotionErrorResponse(c, err);
      if (mapped) return mapped;
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── DELETE /api/promotions/:id ───────────────────────────────────
  app.delete('/promotions/:id', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const deleted = await ctx.promotionStore.delete(id);
      if (!deleted) {
        return c.json(
          { error: 'Promotion not found or not deletable (only draft promotions can be deleted)' },
          404,
        );
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/promotions/:id/users ── claimed-user list ───────────
  // Returns all claimed users for a promotion with per-user gas state.
  // No pagination; maxParticipants bounds the result size.
  app.get('/promotions/:id/users', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const promotion = await ctx.promotionStore.get(id);
      if (!promotion) {
        return c.json({ error: 'Promotion not found' }, 404);
      }

      // Enriched projection from ExecutionLedger (no N+1 join)
      const users = await ctx.executionLedger.listClaimedUsers(id);

      return c.json({ promotionId: id, users, total: users.length });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /api/promotions/:id/summary ── budget KPIs ──────────────
  app.get('/promotions/:id/summary', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore) {
        return c.json({ error: 'Promotion store not available (studio not enabled)' }, 503);
      }
      const id = c.req.param('id');
      const promotion = await ctx.promotionStore.get(id);
      if (!promotion) {
        return c.json({ error: 'Promotion not found' }, 404);
      }
      const summary = await computeAdminSummary(ctx, id, promotion);
      if (!summary) {
        return c.json({ error: 'Budget stores not available' }, 503);
      }
      return c.json({ promotionId: id, summary });
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
