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
  ADMIN_BLOCKLIST_DELETE_ERROR_CODES,
  ADMIN_PROMOTION_CREATE_ERROR_CODES,
  ADMIN_PROMOTION_DELETE_ERROR_CODES,
  ADMIN_PROMOTION_LIST_ERROR_CODES,
  ADMIN_PROMOTION_READ_ERROR_CODES,
  ADMIN_PROMOTION_STATUS_ERROR_CODES,
  ADMIN_PROMOTION_UPDATE_ERROR_CODES,
  ADMIN_READ_ERROR_CODES,
  ADMIN_SESSION_ERROR_CODES,
  ADMIN_SPONSORED_LOGS_ERROR_CODES,
  ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES,
  ADMIN_WITHDRAWAL_ERROR_CODES,
  buildSponsorRefillAccountWithdrawMessage,
  HostWireParseError,
  parseAdminAuditLogsResponse,
  parseAdminBlocklistDeleteRequest,
  parseAdminBlocklistDeleteResponse,
  parseAdminBlocklistResponse,
  parseAdminPromotionCreateRequest,
  parseAdminPromotionDeleteResponse,
  parseAdminPromotionDetailResponse,
  parseAdminPromotionListQuery,
  parseAdminPromotionListResponse,
  parseAdminPromotionResponse,
  parseAdminPromotionStatusRequest,
  parseAdminPromotionSummaryResponse,
  parseAdminPromotionUpdateRequest,
  parseAdminPromotionUsersResponse,
  parseAdminSettlementSwapPathsResponse,
  parseAdminSponsoredLogsQuery,
  parseAdminSponsoredLogsResponse,
  parseAdminSponsoredLogsSummaryResponse,
  parseSponsorRefillAccountWithdrawalRequest,
  parseSponsorRefillAccountWithdrawalChallengeResponse,
  parseSponsorRefillAccountWithdrawalResponse,
  parseAdminStudioResponse,
  parseAdminSponsorOperationsResponse,
  type AdminSponsorOperationsResponse,
  type DeepBookPoolHop,
  type HostErrorCode,
  type SponsorOperationsStatus,
  type SuiNetwork,
} from '@stelis/contracts';
import {
  checkAndIncrementAdminOperationAttempt,
  verifySignedMessage,
  type AdminJwtConfig,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import { readJsonBodyWithLimit, MAX_SMALL_REQUEST_BODY_BYTES } from '@stelis/core-api';
import {
  computeTotalRequiredBudgetMist,
  InvalidStatusTransitionError,
  PromotionCurrentConflictError,
  PromotionFieldImmutableError,
  PromotionLedgerValueError,
  type Promotion,
} from '@stelis/core-api/studio';
import { createAdminRedisAdapter } from '../adminRedis.js';
import {
  ADMIN_AUDIT_LOG_KEY,
  ADMIN_AUDIT_LOG_MAX_ENTRIES,
  writeAdminAuditLog,
} from '../adminAuditLog.js';
import { redactSensitiveText, safeErrorSummary } from '@stelis/core-api/observability';
import { deriveSponsorAvailabilitySummary } from '../sponsor-operations/gate.js';
import { encodeSponsorRefillAccountWithdrawalIssuedReceipt } from '../sponsor-operations/accountSpendState.js';
import type { AppApiContext } from '../context.js';
import { requireAdminSessionFromContext } from '../requireAdminSession.js';
import type { ResolveClientIp } from '../clientIp.js';
import { codedHostError, mapError, respondMapped } from '../errorMap.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';
import { safeBigintToNumber } from '../wireNumbers.js';

/**
 * Enrich a Promotion with derived totalRequiredBudgetMist.
 * This keeps the computation in core-api and avoids storing derived data.
 * The store has already accepted the complete ledger budget before this
 * current projection is created.
 */
function withDerivedBudget<T extends Promotion>(
  record: T,
): T & { totalRequiredBudgetMist: string } {
  return {
    ...record,
    totalRequiredBudgetMist: computeTotalRequiredBudgetMist(record),
  };
}

/** Compute the current promotion summary from the authoritative store projections. */
async function computeAdminSummary(
  ctx: AppApiContext,
  promotionId: string,
  promotion: Promotion,
): Promise<import('@stelis/core-api/studio').PromotionAdminSummary | null> {
  if (!ctx.executionLedger) return null;
  const { computePromotionAdminSummary } = await import('@stelis/core-api/studio');
  const [claimedCount, budgetSummary] = await Promise.all([
    ctx.executionLedger.getClaimedCount(promotionId),
    ctx.executionLedger.getBudgetSummary(promotionId),
  ]);
  return computePromotionAdminSummary(promotion, claimedCount, budgetSummary);
}

class AdminRequestContractError extends Error {
  constructor() {
    super('Admin request does not match the current Host wire contract');
    this.name = 'AdminRequestContractError';
  }
}

function parseAdminRequest<T>(value: unknown, parse: (input: unknown) => T): T {
  try {
    return parse(value);
  } catch (err) {
    if (err instanceof HostWireParseError) throw new AdminRequestContractError();
    throw err;
  }
}

function respondAdminFailure(
  c: Parameters<typeof respondMapped>[0],
  err: unknown,
  allowedCodes: readonly HostErrorCode[],
): Response {
  if (err instanceof AdminRequestContractError && allowedCodes.includes('BAD_REQUEST')) {
    return respondMapped(c, codedHostError('BAD_REQUEST', allowedCodes));
  }
  if (
    err instanceof PromotionCurrentConflictError &&
    allowedCodes.includes('PROMOTION_CURRENT_CONFLICT')
  ) {
    return respondMapped(c, codedHostError('PROMOTION_CURRENT_CONFLICT', allowedCodes));
  }
  if (
    (err instanceof InvalidStatusTransitionError || err instanceof PromotionFieldImmutableError) &&
    allowedCodes.includes('ADMIN_CONFLICT')
  ) {
    return respondMapped(c, codedHostError('ADMIN_CONFLICT', allowedCodes));
  }
  if (err instanceof PromotionLedgerValueError && allowedCodes.includes('ADMIN_UNPROCESSABLE')) {
    return respondMapped(c, codedHostError('ADMIN_UNPROCESSABLE', allowedCodes));
  }
  const mapped = mapError(err, allowedCodes, 'INTERNAL_ERROR');
  if (mapped) return respondMapped(c, mapped);
  return respondMapped(c, codedHostError('INTERNAL_ERROR', allowedCodes));
}

const IP_PREFIX = 'stelis:abuse:block:ip:';
const ADDR_PREFIX = 'stelis:abuse:block:address:';
const WITHDRAW_NONCE_PREFIX = 'stelis:admin:withdraw_nonce:';
const WITHDRAW_NONCE_TTL_MS = 60_000;

function withdrawalNonceKey(network: SuiNetwork, nonce: string): string {
  return `${WITHDRAW_NONCE_PREFIX}${network}:${nonce}`;
}

async function getAdminRedis(contextPromise: Promise<AppApiContext>): Promise<AdminRedisClient> {
  return createAdminRedisAdapter((await contextPromise).redis);
}

export interface AdminRoutesRuntimeInput {
  readonly resolveClientIp: ResolveClientIp;
  readonly network: SuiNetwork;
  readonly adminAddress: string | null;
  readonly adminJwt: AdminJwtConfig | null;
  readonly refillEnabled: boolean;
  readonly warnMist: bigint;
  readonly refillTargetMist: bigint;
}

export function createAdminRoutes(
  contextPromise: Promise<AppApiContext>,
  runtime: AdminRoutesRuntimeInput,
) {
  const app = new Hono();

  // ── Auth guard middleware — all admin routes require session ───────
  app.use('*', async (c, next) => {
    const session = await requireAdminSessionFromContext(c, contextPromise, runtime.adminJwt);
    if (!session) {
      return respondMapped(c, codedHostError('ADMIN_UNAUTHORIZED', ADMIN_SESSION_ERROR_CODES));
    }
    c.set('adminSession' as never, session as never);
    await next();
  });

  // ── GET /api/blocklist ────────────────────────────────────────────
  app.get('/blocklist', async (c) => {
    try {
      const redis = await getAdminRedis(contextPromise);
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

      return c.json(parseAdminBlocklistResponse({ blocklist: entries }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });

  // ── DELETE /api/blocklist ─────────────────────────────────────────
  app.delete('/blocklist', async (c) => {
    try {
      const body = parseAdminRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
        parseAdminBlocklistDeleteRequest,
      );

      const allowed = [IP_PREFIX, ADDR_PREFIX];
      if (!allowed.some((prefix) => body.key.startsWith(prefix))) {
        return respondMapped(
          c,
          codedHostError('ADMIN_FORBIDDEN', ADMIN_BLOCKLIST_DELETE_ERROR_CODES),
        );
      }

      const redis = await getAdminRedis(contextPromise);
      await redis.del(body.key);
      return c.json(parseAdminBlocklistDeleteResponse({ ok: true, deleted: body.key }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_BLOCKLIST_DELETE_ERROR_CODES);
    }
  });

  // ── GET /api/logs ─────────────────────────────────────────────────
  app.get('/logs', async (c) => {
    try {
      const redis = await getAdminRedis(contextPromise);
      const entries = await redis.lrange(ADMIN_AUDIT_LOG_KEY, 0, ADMIN_AUDIT_LOG_MAX_ENTRIES - 1);
      return c.json(
        parseAdminAuditLogsResponse({
          logs: entries.map((entry) => JSON.parse(entry) as unknown),
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });

  // ── GET /api/sponsored-logs/summary ─────────────────────────────────
  // Lifetime aggregate KPI for the Dashboard (mode=all by default) and
  // Sponsored Logs filter dropdown. Reads exact MIST decimal strings
  // from the durable aggregate; never derives lifetime totals from
  // bounded recent rows.
  app.get('/sponsored-logs/summary', async (c) => {
    try {
      const { mode } = parseAdminRequest(
        { mode: c.req.query('mode') },
        parseAdminSponsoredLogsQuery,
      );
      const ctx = await contextPromise;
      const summary = await ctx.sponsoredLogsStore.getSummary(mode);
      return c.json(parseAdminSponsoredLogsSummaryResponse({ summary }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_SPONSORED_LOGS_ERROR_CODES);
    }
  });

  // ── GET /api/sponsored-logs ─────────────────────────────────────────
  // Combined summary + bounded recent entries for the Sponsored Logs
  // page. Numeric fields are exact MIST decimal strings (signed where
  // applicable) or `null` for unknown economics.
  app.get('/sponsored-logs', async (c) => {
    try {
      const { mode, limit } = parseAdminRequest(
        { mode: c.req.query('mode'), limit: c.req.query('limit') },
        parseAdminSponsoredLogsQuery,
      );
      const ctx = await contextPromise;
      const [summary, entries] = await Promise.all([
        ctx.sponsoredLogsStore.getSummary(mode),
        ctx.sponsoredLogsStore.getRecent(mode, limit),
      ]);
      return c.json(parseAdminSponsoredLogsResponse({ summary, entries }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_SPONSORED_LOGS_ERROR_CODES);
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
      const ctx = await contextPromise;
      const host = ctx.host;

      // Await the bounded sponsor refill account probe here. Admin is not a hot path,
      // and awaiting keeps the returned sponsor refill account fields honest.
      await ctx.sponsorOperations.probeSponsorRefillAccount();

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
          lastError: s.lastError === null ? null : redactSensitiveText(s.lastError),
        })),
        sponsorRefillAccount: {
          address: ctx.sponsorOperations.sponsorRefillAccountAddress,
          balanceMist: stateView.sponsorRefillAccount.balanceMist,
          healthy: stateView.sponsorRefillAccount.healthy ?? false,
          refillsRemaining: stateView.sponsorRefillAccount.refillsRemaining,
          lastObservedAtMs: stateView.sponsorRefillAccount.lastObservedAtMs,
          lastError:
            stateView.sponsorRefillAccount.lastError === null
              ? null
              : redactSensitiveText(stateView.sponsorRefillAccount.lastError),
        },
        availableSlots: aggregates.availableSlots,
        degradedSlots: aggregates.degradedSlots,
        slotLeases,
        gateErrorCode: aggregates.gateErrorCode,
      };

      // On-chain fee config (core-api TTL cache; see getConfig() in
      // packages/core-api/src/context.ts).
      let feeConfig: AdminSponsorOperationsResponse['feeConfig'] = null;
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

      const response: AdminSponsorOperationsResponse = {
        sponsorOperations,
        primaryAddress: host.sponsorPool.primaryAddress,
        settlementPayoutRecipientAddress: host.settlementPayoutRecipientAddress,
        network: host.network,
        sponsorBalanceWarnMist: runtime.warnMist.toString(),
        sponsorBalanceRefillTargetMist: runtime.refillTargetMist.toString(),
        refillEnabled: runtime.refillEnabled,
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
        rpcFleet: {
          endpoints: ctx.rpcFleet.endpoints.map((endpoint) => ({ ...endpoint })),
        },
      };
      return c.json(parseAdminSponsorOperationsResponse(response));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });

  // ── POST /api/sponsor-refill-account/withdrawal-challenge ────────────────────────────
  app.post('/sponsor-refill-account/withdrawal-challenge', async (c) => {
    let ip: string | null = null;
    try {
      ip = runtime.resolveClientIp(c);
      const redis = await getAdminRedis(contextPromise);
      const nonce = `stelis-withdraw:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(
        withdrawalNonceKey(runtime.network, nonce),
        encodeSponsorRefillAccountWithdrawalIssuedReceipt(runtime.network),
        { px: WITHDRAW_NONCE_TTL_MS },
      );
      const expiresAt = new Date(Date.now() + WITHDRAW_NONCE_TTL_MS).toISOString();
      return c.json(parseSponsorRefillAccountWithdrawalChallengeResponse({ nonce, expiresAt }));
    } catch (err) {
      if (ip !== null) {
        await writeAdminAuditLog(await getAdminRedis(contextPromise), {
          event: 'WITHDRAW_NONCE_ERROR',
          ts: new Date().toISOString(),
          ip,
          detail: safeErrorSummary(err),
        }).catch(() => undefined);
      }
      return respondAdminFailure(c, err, ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES);
    }
  });

  // ── POST /api/sponsor-refill-account/withdraw — execute withdrawal ──────────────────
  app.post('/sponsor-refill-account/withdraw', async (c) => {
    let ip: string | null = null;
    try {
      ip = runtime.resolveClientIp(c);
      const ts = () => new Date().toISOString();
      const redis = await getAdminRedis(contextPromise);
      // Atomic ops rate-limit check at entry
      const rateCheck = await checkAndIncrementAdminOperationAttempt(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_RATE_LIMITED',
          ts: ts(),
          ip,
          detail: `429: ${rateCheck.current} attempts`,
        });
        return respondMapped(
          c,
          codedHostError(
            'RATE_LIMITED',
            ADMIN_WITHDRAWAL_ERROR_CODES,
            {
              retryAfterMs: rateCheck.retryAfterMs,
            },
            {
              'Retry-After': formatRetryAfterSeconds(rateCheck.retryAfterMs),
            },
          ),
        );
      }

      // Parse body
      const body = parseAdminRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
        parseSponsorRefillAccountWithdrawalRequest,
      );
      const { amountMist, nonce, signature } = body;

      // Signature verification uses the shared browser/server helper.
      if (runtime.adminAddress === null) {
        throw new Error('ADMIN_ADDRESS is not configured');
      }
      const adminAddress = runtime.adminAddress;
      const message = buildSponsorRefillAccountWithdrawMessage(runtime.network, amountMist, nonce);
      const sigValid = await verifySignedMessage({ message, signature, adminAddress });
      if (!sigValid) {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: '401: bad signature',
        });
        return respondMapped(
          c,
          codedHostError('WITHDRAWAL_SIGNATURE_INVALID', ADMIN_WITHDRAWAL_ERROR_CODES),
        );
      }

      // Signature validation precedes the atomic nonce-consume + durable
      // operation reservation owned by the shared account spend coordinator.
      const ctx = await contextPromise;
      const recipientAddress = adminAddress;
      const result = await ctx.sponsorOperations.withdraw({
        destinationAddress: recipientAddress,
        amountMist,
        nonceKey: withdrawalNonceKey(runtime.network, nonce),
      });
      if (result.status === 'nonce_missing') {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: '401: invalid nonce',
        });
        return respondMapped(
          c,
          codedHostError('WITHDRAWAL_NONCE_MISSING', ADMIN_WITHDRAWAL_ERROR_CODES),
        );
      }
      if (result.status === 'runway_blocked') {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_BLOCKED',
          ts: ts(),
          ip,
          detail: redactSensitiveText(result.error),
        });
        return respondMapped(
          c,
          codedHostError('WITHDRAWAL_RUNWAY_BLOCKED', ADMIN_WITHDRAWAL_ERROR_CODES),
        );
      }
      if (result.status === 'busy') {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_NOT_ACCEPTED',
          ts: ts(),
          ip,
          detail: `${result.operationId}: ${redactSensitiveText(result.error)}`,
        });
        return respondMapped(
          c,
          codedHostError('WITHDRAWAL_NOT_ACCEPTED', ADMIN_WITHDRAWAL_ERROR_CODES, {
            operationId: result.operationId,
            ...(result.digest === null ? {} : { digest: result.digest }),
          }),
        );
      }
      if (result.status === 'pending') {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_PENDING',
          ts: ts(),
          ip,
          detail: `${result.operationId}: ${redactSensitiveText(result.error)}`,
        });
        return respondMapped(
          c,
          codedHostError('WITHDRAWAL_PENDING', ADMIN_WITHDRAWAL_ERROR_CODES, {
            operationId: result.operationId,
            ...(result.digest === null ? {} : { digest: result.digest }),
          }),
        );
      }
      if (result.status === 'failed') {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_FAILED',
          ts: ts(),
          ip,
          detail: redactSensitiveText(result.error),
        });
        return respondMapped(c, codedHostError('WITHDRAWAL_FAILED', ADMIN_WITHDRAWAL_ERROR_CODES));
      }
      if (result.status === 'not_needed') {
        throw new Error('Withdrawal returned a refill-only result');
      }

      const {
        digest,
        amountMist: completedAmountMist,
        destinationAddress: completedDestinationAddress,
      } = result;

      try {
        await writeAdminAuditLog(redis, {
          event: 'WITHDRAWAL_SUCCESS',
          ts: ts(),
          ip,
          detail: `${completedAmountMist} MIST → ${completedDestinationAddress} (${digest})`,
        });
      } catch (auditError) {
        // The durable terminal result is already authoritative. Audit storage
        // failure must not turn a confirmed withdrawal into an HTTP failure.
        // eslint-disable-next-line no-console
        console.error(
          '[sponsor-refill-account/withdraw] Success audit write failed:',
          safeErrorSummary(auditError),
        );
      }

      return c.json(
        parseSponsorRefillAccountWithdrawalResponse({
          digest,
          amountMist: completedAmountMist,
          recipient: completedDestinationAddress,
        }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sponsor-refill-account/withdraw] Unexpected error:', safeErrorSummary(err));
      try {
        if (ip !== null) {
          const r = await getAdminRedis(contextPromise);
          await writeAdminAuditLog(r, {
            event: 'WITHDRAWAL_ERROR',
            ts: new Date().toISOString(),
            ip,
            detail: safeErrorSummary(err),
          });
        }
      } catch {
        /* Redis unavailable — audit log best-effort */
      }
      return respondAdminFailure(c, err, ADMIN_WITHDRAWAL_ERROR_CODES);
    }
  });

  // ── GET /api/settlement-swap-paths ────────────────────────────────
  // Operational inspection: returns the active registry loaded at boot.
  app.get('/settlement-swap-paths', async (c) => {
    try {
      const ctx = await contextPromise;
      const settlementSwapPaths = ctx.prepareConfig.supportedSettlementSwapPaths;
      return c.json(
        parseAdminSettlementSwapPathsResponse({
          count: settlementSwapPaths.length,
          settlementSwapPaths: settlementSwapPaths.map((path) => ({
            settlementTokenType: path.settlementTokenType,
            settlementTokenSymbol: path.settlementTokenSymbol,
            settlementTokenDecimals: path.settlementTokenDecimals,
            lotSize: safeBigintToNumber(path.lotSize, 'lotSize'),
            minSize: safeBigintToNumber(path.minSize, 'minSize'),
            effectiveFeeRateBps: path.effectiveFeeRateBps,
            settlementSwapDirection: path.settlementSwapDirection,
            hopCount: path.hops.length,
            hops: path.hops.map((hop: DeepBookPoolHop) => ({
              poolId: hop.poolId,
              baseType: hop.baseType,
              quoteType: hop.quoteType,
              swapDirection: hop.swapDirection,
              feeBps: hop.feeBps,
            })),
          })),
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });

  // ── GET /api/studio ──────────────────────────────────────────────
  // Studio operational status.
  // Returns { enabled: false } if studio mode is not active.
  app.get('/studio', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.studio) {
        return c.json(parseAdminStudioResponse({ enabled: false }), 200);
      }

      return c.json(
        parseAdminStudioResponse({
          enabled: true,
          config: {
            developerJwtTrustConfigured: !!ctx.developerJwtTrustConfig,
            developerJwtVerifyUrlConfigured: !!ctx.developerJwtVerifyUrl,
          },
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });
  // ── GET /api/promotions ──────────────────────────────────────────
  app.get('/promotions', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_LIST_ERROR_CODES),
        );
      }
      const { status, ...pageParams } = parseAdminRequest(
        c.req.query(),
        parseAdminPromotionListQuery,
      );
      const page = await ctx.promotionStore.listPage(
        pageParams,
        status === undefined ? undefined : { status },
      );
      const enriched = page.promotions.map(withDerivedBudget);
      return c.json(
        parseAdminPromotionListResponse({
          promotions: enriched,
          nextCursor: page.nextCursor,
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_LIST_ERROR_CODES);
    }
  });

  // ── POST /api/promotions ─────────────────────────────────────────
  app.post('/promotions', async (c) => {
    let ip: string | null = null;
    try {
      ip = runtime.resolveClientIp(c);
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_CREATE_ERROR_CODES),
        );
      }
      const body = parseAdminRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
        parseAdminPromotionCreateRequest,
      );
      const record = await ctx.promotionStore.create(body);
      // Durable admin audit trail: emit the same operation-log event shape used by
      // every other admin write path so `/api/logs` and `app-admin` can
      // attribute promotion creation without bespoke sink wiring.
      await writeAdminAuditLog(await getAdminRedis(contextPromise), {
        event: 'PROMOTION_CREATE',
        ts: new Date().toISOString(),
        ip,
        detail: `201: promotionId=${record.promotionId}, maxParticipants=${record.maxParticipants}, perUserGasAllowanceMist=${record.perUserGasAllowanceMist}`,
      }).catch(() => undefined);
      return c.json(parseAdminPromotionResponse({ promotion: withDerivedBudget(record) }), 201);
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_CREATE_ERROR_CODES);
    }
  });

  // ── GET /api/promotions/:id ──────────────────────────────────────
  app.get('/promotions/:id', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const record = await ctx.promotionStore.get(id);
      if (!record) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const summary = await computeAdminSummary(ctx, id, record);
      return c.json(
        parseAdminPromotionDetailResponse({
          promotion: withDerivedBudget(record),
          summary,
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_READ_ERROR_CODES);
    }
  });

  // ── PUT /api/promotions/:id ──────────────────────────────────────
  app.put('/promotions/:id', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_UPDATE_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const input = parseAdminRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
        parseAdminPromotionUpdateRequest,
      );

      const record = await ctx.promotionStore.update(id, input);
      if (!record) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_UPDATE_ERROR_CODES),
        );
      }
      return c.json(parseAdminPromotionResponse({ promotion: withDerivedBudget(record) }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_UPDATE_ERROR_CODES);
    }
  });

  // ── POST /api/promotions/:id/status ──────────────────────────────
  app.post('/promotions/:id/status', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_STATUS_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const body = parseAdminRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
        parseAdminPromotionStatusRequest,
      );
      const record = await ctx.promotionStore.transitionStatus(id, body.status, body.reason);
      if (!record) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_STATUS_ERROR_CODES),
        );
      }
      return c.json(parseAdminPromotionResponse({ promotion: withDerivedBudget(record) }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_STATUS_ERROR_CODES);
    }
  });

  // ── DELETE /api/promotions/:id ───────────────────────────────────
  app.delete('/promotions/:id', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_DELETE_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const result = await ctx.promotionStore.delete(id);
      if (result.status === 'not_found') {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_DELETE_ERROR_CODES),
        );
      }
      if (result.status === 'not_deletable') {
        return respondMapped(
          c,
          codedHostError('ADMIN_CONFLICT', ADMIN_PROMOTION_DELETE_ERROR_CODES),
        );
      }
      return c.json(parseAdminPromotionDeleteResponse({ ok: true }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_DELETE_ERROR_CODES);
    }
  });

  // ── GET /api/promotions/:id/users ────────────────────────────────
  app.get('/promotions/:id/users', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const promotion = await ctx.promotionStore.get(id);
      if (!promotion) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const users = await ctx.executionLedger.listClaimedUsers(id);
      return c.json(
        parseAdminPromotionUsersResponse({ promotionId: id, users, total: users.length }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_READ_ERROR_CODES);
    }
  });

  // ── GET /api/promotions/:id/summary ──────────────────────────────
  app.get('/promotions/:id/summary', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const id = c.req.param('id');
      const promotion = await ctx.promotionStore.get(id);
      if (!promotion) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const summary = await computeAdminSummary(ctx, id, promotion);
      if (!summary) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAVAILABLE', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      return c.json(parseAdminPromotionSummaryResponse({ promotionId: id, summary }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_READ_ERROR_CODES);
    }
  });

  return app;
}
