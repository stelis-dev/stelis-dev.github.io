/**
 * [app-api] Admin routes — /api/blocklist, /api/logs, /api/sponsor-operations,
 * /api/sponsor-refill-account/withdraw, /api/settlement-swap-paths, /api/studio, /api/promotions*
 *
 * All routes are protected by requireAdminSession (JWT + not_before).
 *
 * Boundary: binds app-api host concerns with core-api admin helpers
 * and the shared admin contracts in @stelis/contracts.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import {
  ADMIN_BLOCKLIST_READ_ERROR_CODES,
  ADMIN_BLOCKLIST_DELETE_ERROR_CODES,
  ADMIN_REQUEST_ADMISSION_ERROR_CODES,
  ADMIN_PROMOTION_CREATE_ERROR_CODES,
  ADMIN_PROMOTION_DELETE_ERROR_CODES,
  ADMIN_PROMOTION_LIST_ERROR_CODES,
  ADMIN_PROMOTION_READ_ERROR_CODES,
  ADMIN_PROMOTION_STATUS_ERROR_CODES,
  ADMIN_PROMOTION_UPDATE_ERROR_CODES,
  ADMIN_READ_ERROR_CODES,
  ADMIN_SPONSORED_LOGS_ERROR_CODES,
  ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES,
  ADMIN_WITHDRAWAL_ERROR_CODES,
  buildSponsorRefillAccountWithdrawMessage,
  HostWireParseError,
  parseAdminAuditLogsResponse,
  parseAdminBlocklistDeleteRequest,
  parseAdminBlocklistDeleteResponse,
  parseAdminBlocklistQuery,
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
  parsePromotionId,
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
import {
  AbuseBlockCurrentConflictError,
  AbuseBlockInputError,
  MAX_SMALL_REQUEST_BODY_BYTES,
  readAdmittedClientIp,
} from '@stelis/core-api';
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
import { calculateSponsorAvailability } from '../sponsor-operations/gate.js';
import { encodeSponsorRefillAccountWithdrawalIssuedReceipt } from '../sponsor-operations/accountSpendState.js';
import type { RelayAndStudioAppApiContext } from '../context.js';
import { requireAdminSessionFromContext } from '../requireAdminSession.js';
import {
  beginRequestAdmission,
  finishAuthenticatedRequestAdmission,
  type InitialRequestAdmission,
  type RequestAdmissionDependencies,
} from '../requestAdmission.js';
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
  ctx: RelayAndStudioAppApiContext,
  promotionId: string,
  promotion: Promotion,
): Promise<import('@stelis/core-api/studio').PromotionAdminSummary> {
  const { computePromotionAdminSummary } = await import('@stelis/core-api/studio');
  const ledgerStatus = await ctx.executionLedger.getPromotionLedgerStatus(promotionId, null);
  return computePromotionAdminSummary(promotion, ledgerStatus.claimedCount, ledgerStatus.budget);
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
  if (err instanceof AbuseBlockInputError && allowedCodes.includes('BAD_REQUEST')) {
    return respondMapped(c, codedHostError('BAD_REQUEST', allowedCodes));
  }
  if (err instanceof AbuseBlockCurrentConflictError && allowedCodes.includes('ADMIN_CONFLICT')) {
    return respondMapped(c, codedHostError('ADMIN_CONFLICT', allowedCodes));
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

const WITHDRAW_NONCE_PREFIX = 'stelis:admin:withdraw_nonce:';
const WITHDRAW_NONCE_TTL_MS = 60_000;

function withdrawalNonceKey(network: SuiNetwork, nonce: string): string {
  return `${WITHDRAW_NONCE_PREFIX}${network}:${nonce}`;
}

function getAdminRedis(context: RelayAndStudioAppApiContext): AdminRedisClient {
  return createAdminRedisAdapter(context.redis);
}

export interface AdminRoutesRuntimeInput {
  readonly admission: RequestAdmissionDependencies;
  readonly network: SuiNetwork;
  readonly allowedOrigins: readonly string[];
  readonly admin: {
    readonly address: string;
    readonly jwt: AdminJwtConfig;
  };
}

interface AdminRouteVariables {
  readonly requestAdmission: InitialRequestAdmission;
}

export function createAdminRoutes(
  context: RelayAndStudioAppApiContext,
  runtime: AdminRoutesRuntimeInput,
) {
  const app = new Hono<{ Variables: AdminRouteVariables }>();

  /**
   * Route-local Admin admission. The body policy is supplied next to the
   * method, path, and handler below; there is no parallel path registry that
   * can drift from Hono's route table.
   */
  const admitAdminRequest =
    (jsonBodyLimitBytes?: number): MiddlewareHandler =>
    async (c, next) => {
      const admitted = await beginRequestAdmission(c, runtime.admission, {
        allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
          ? { requiredOrigins: runtime.allowedOrigins }
          : {}),
        ...(jsonBodyLimitBytes === undefined ? {} : { jsonBodyLimitBytes }),
      });
      if (!admitted.ok) return admitted.response;
      const session = await requireAdminSessionFromContext(c, context, runtime.admin.jwt);
      if (!session) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_REQUEST_ADMISSION_ERROR_CODES),
        );
      }
      const subjectAdmission = await finishAuthenticatedRequestAdmission(
        c,
        runtime.admission,
        admitted.value,
        {
          allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
          subject: { kind: 'address', address: session.address },
        },
      );
      if (!subjectAdmission.ok) return subjectAdmission.response;
      c.set('requestAdmission', subjectAdmission.value);
      await next();
    };

  // ── GET /api/blocklist ────────────────────────────────────────────
  app.get('/blocklist', admitAdminRequest(), async (c) => {
    try {
      const params = parseAdminRequest(c.req.query(), parseAdminBlocklistQuery);
      const ctx = context;
      const page = await ctx.abuseStore.listBlocks(params);
      return c.json(
        parseAdminBlocklistResponse({
          blocklist: page.blocks.map((block) => ({
            scope: block.identity.scope,
            subject: block.identity.subject,
            reason: block.reason,
            blockedUntilMs: block.blockedUntilMs,
          })),
          nextCursor: page.nextCursor,
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_BLOCKLIST_READ_ERROR_CODES);
    }
  });

  // ── DELETE /api/blocklist ─────────────────────────────────────────
  app.delete('/blocklist', admitAdminRequest(MAX_SMALL_REQUEST_BODY_BYTES), async (c) => {
    try {
      const body = parseAdminRequest(
        c.get('requestAdmission').body,
        parseAdminBlocklistDeleteRequest,
      );

      const ctx = context;
      const removed = await ctx.abuseStore.removeBlock({
        scope: body.scope,
        subject: body.subject,
      });
      return c.json(parseAdminBlocklistDeleteResponse({ removed }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_BLOCKLIST_DELETE_ERROR_CODES);
    }
  });

  // ── GET /api/logs ─────────────────────────────────────────────────
  app.get('/logs', admitAdminRequest(), async (c) => {
    try {
      const redis = getAdminRedis(context);
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
  app.get('/sponsored-logs/summary', admitAdminRequest(), async (c) => {
    try {
      const { mode } = parseAdminRequest(
        { mode: c.req.query('mode') },
        parseAdminSponsoredLogsQuery,
      );
      const ctx = context;
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
  app.get('/sponsored-logs', admitAdminRequest(), async (c) => {
    try {
      const { mode, limit } = parseAdminRequest(
        { mode: c.req.query('mode'), limit: c.req.query('limit') },
        parseAdminSponsoredLogsQuery,
      );
      const ctx = context;
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
  // store. The route requests one retained, bounded balance observation before
  // the read. An active account spend owns the source-account observation and
  // can skip it; current health is always derived from Redis-time freshness.
  // `feeConfig` uses `host.getConfig()` which is already TTL-cached in
  // core-api. Other fields are boot-derived constants.
  app.get('/sponsor-operations', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
      const host = ctx.host;

      // Admin is not a hot path, so await the bounded observation before
      // calculating the current public status.
      await ctx.sponsorOperations.observeBalances();

      const [stateView, slotLeases] = await Promise.all([
        ctx.sponsorOperations.readState(),
        host.sponsorPool.leaseStatus(),
      ]);
      const availability = calculateSponsorAvailability(stateView, slotLeases);
      const sponsorOperations: SponsorOperationsStatus = {
        slots: availability.slots.map((s) => ({
          address: s.address,
          state: s.state,
          addressBalanceMist: s.addressBalanceMist,
          lastObservedAtMs: s.lastObservedAtMs,
          lastError: s.lastError === null ? null : redactSensitiveText(s.lastError),
        })),
        sponsorRefillAccount: {
          address: ctx.sponsorOperations.settings.sponsorRefillAccountAddress,
          totalBalanceMist: availability.sponsorRefillAccount.totalBalanceMist,
          healthy: availability.sponsorRefillAccount.healthy,
          lastObservedAtMs: availability.sponsorRefillAccount.lastObservedAtMs,
          lastError:
            availability.sponsorRefillAccount.lastError === null
              ? null
              : redactSensitiveText(availability.sponsorRefillAccount.lastError),
        },
        healthySlots: availability.healthySlots,
        degradedSlots: availability.degradedSlots,
        slotLeases,
        gateErrorCode: availability.gateErrorCode,
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
        sponsorBalanceWarnMist: ctx.sponsorOperations.settings.warnMist.toString(),
        sponsorBalanceRefillTargetMist:
          ctx.sponsorOperations.settings.refillTargetMist?.toString() ?? null,
        sponsorRefillAccountRunwayTargetMist:
          ctx.sponsorOperations.settings.runwayTargetMist.toString(),
        refillEnabled: ctx.sponsorOperations.settings.refillEnabled,
        quotedHostFeeMist: ctx.prepareConfig.quotedHostFeeMist.toString(),
        feeConfig,
        supportedSettlementSwapPaths,
        onChainIds: {
          packageId: host.packageId,
          configId: host.configId,
          vaultRegistryId: host.vaultRegistryId,
          deepbookPackageId: ctx.prepareConfig.deepbookPackageId,
        },
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
  app.post('/sponsor-refill-account/withdrawal-challenge', admitAdminRequest(), async (c) => {
    let ip: string | null = null;
    try {
      ip = readAdmittedClientIp(c.get('requestAdmission').clientIp);
      const redis = getAdminRedis(context);
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
        await writeAdminAuditLog(getAdminRedis(context), {
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
  app.post(
    '/sponsor-refill-account/withdraw',
    admitAdminRequest(MAX_SMALL_REQUEST_BODY_BYTES),
    async (c) => {
      let ip: string | null = null;
      try {
        ip = readAdmittedClientIp(c.get('requestAdmission').clientIp);
        const ts = () => new Date().toISOString();
        const redis = getAdminRedis(context);
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
          c.get('requestAdmission').body,
          parseSponsorRefillAccountWithdrawalRequest,
        );
        const { amountMist, nonce, signature } = body;

        // Signature verification uses the shared browser/server helper.
        const adminAddress = runtime.admin.address;
        const message = buildSponsorRefillAccountWithdrawMessage(
          runtime.network,
          amountMist,
          nonce,
        );
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
        const ctx = context;
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
          return respondMapped(
            c,
            codedHostError('WITHDRAWAL_FAILED', ADMIN_WITHDRAWAL_ERROR_CODES),
          );
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
            const r = getAdminRedis(context);
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
    },
  );

  // ── GET /api/settlement-swap-paths ────────────────────────────────
  // Operational inspection: returns the active registry loaded at boot.
  app.get('/settlement-swap-paths', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
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
  // Studio authentication configuration for this `relay_and_studio` Host.
  app.get('/studio', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
      return c.json(
        parseAdminStudioResponse({
          config: {
            developerJwtVerifyUrlConfigured: !!ctx.developerJwtVerifyUrl,
          },
        }),
      );
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_READ_ERROR_CODES);
    }
  });
  // ── GET /api/promotions ──────────────────────────────────────────
  app.get('/promotions', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
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
  app.post('/promotions', admitAdminRequest(MAX_SMALL_REQUEST_BODY_BYTES), async (c) => {
    let ip: string | null = null;
    try {
      ip = readAdmittedClientIp(c.get('requestAdmission').clientIp);
      const ctx = context;
      const body = parseAdminRequest(
        c.get('requestAdmission').body,
        parseAdminPromotionCreateRequest,
      );
      const record = await ctx.promotionStore.create(body);
      // Durable admin audit trail: emit the same operation-log event shape used by
      // every other admin write path so `/api/logs` and `app-admin` can
      // attribute promotion creation without bespoke sink wiring.
      await writeAdminAuditLog(getAdminRedis(context), {
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
  app.get('/promotions/:id', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
      const id = parseAdminRequest(c.req.param('id'), parsePromotionId);
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
  app.put('/promotions/:id', admitAdminRequest(MAX_SMALL_REQUEST_BODY_BYTES), async (c) => {
    try {
      const ctx = context;
      const id = parseAdminRequest(c.req.param('id'), parsePromotionId);
      const input = parseAdminRequest(
        c.get('requestAdmission').body,
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
  app.post('/promotions/:id/status', admitAdminRequest(MAX_SMALL_REQUEST_BODY_BYTES), async (c) => {
    try {
      const ctx = context;
      const id = parseAdminRequest(c.req.param('id'), parsePromotionId);
      const body = parseAdminRequest(
        c.get('requestAdmission').body,
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
  app.delete('/promotions/:id', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
      const id = parseAdminRequest(c.req.param('id'), parsePromotionId);
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

  // ── GET /api/promotions/:id/summary ──────────────────────────────
  app.get('/promotions/:id/summary', admitAdminRequest(), async (c) => {
    try {
      const ctx = context;
      const id = parseAdminRequest(c.req.param('id'), parsePromotionId);
      const promotion = await ctx.promotionStore.get(id);
      if (!promotion) {
        return respondMapped(
          c,
          codedHostError('ADMIN_NOT_FOUND', ADMIN_PROMOTION_READ_ERROR_CODES),
        );
      }
      const summary = await computeAdminSummary(ctx, id, promotion);
      return c.json(parseAdminPromotionSummaryResponse({ promotionId: id, summary }));
    } catch (err) {
      return respondAdminFailure(c, err, ADMIN_PROMOTION_READ_ERROR_CODES);
    }
  });

  return app;
}
