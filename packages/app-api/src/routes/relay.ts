/**
 * [app-api] Relay routes — /relay/status, /relay/config, /relay/prepare, /relay/sponsor
 *
 * Delegates to core-api handlers.
 *
 * Uses handleStatus, handlePrepare, and handleSponsor from @stelis/core-api.
 */
import { Hono } from 'hono';
import {
  handleStatus,
  handlePrepare,
  handleSponsor,
  MAX_PREPARE_REQUEST_BODY_BYTES,
  MAX_SPONSOR_REQUEST_BODY_BYTES,
  SponsorBlockedError,
  validateBps,
} from '@stelis/core-api';
import {
  GAS_MARGIN_CAP_BPS,
  HostWireParseError,
  RELAY_CONFIG_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  RELAY_STATUS_ERROR_CODES,
  SLIPPAGE_CAP_BPS,
  parseRelayPrepareRequest,
  parseRelaySponsorRequest,
  type RelayConfigResponse,
  type RelayPrepareResponse,
  type RelaySponsorResponse,
} from '@stelis/contracts';

import type { AppApiContext } from '../context.js';
import { beginRequestAdmission, type RequestAdmissionDependencies } from '../requestAdmission.js';
import { buildSponsorUnavailableResponse } from '../sponsor-operations/gateResponse.js';
import { canonicalizeAddress } from '@stelis/core-api';
import { codedHostError, mapError, respondMapped } from '../errorMap.js';
import { safeBigintToNumber } from '../wireNumbers.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

class RelayPrepareAdmissionError extends Error {
  constructor(
    readonly errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' | 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(errorCode);
    this.name = 'RelayPrepareAdmissionError';
  }
}

export function createRelayRoutes(context: AppApiContext, admission: RequestAdmissionDependencies) {
  const app = new Hono();

  // ── GET /relay/status ─────────────────────────────────────────────
  app.get('/status', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: RELAY_STATUS_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
      });
      if (!admitted.ok) return admitted.response;
      const result = await handleStatus();
      return c.json(result);
    } catch {
      return respondMapped(c, codedHostError('INTERNAL_ERROR', RELAY_STATUS_ERROR_CODES));
    }
  });

  // ── GET /relay/config ─────────────────────────────────────────────
  app.get('/config', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: RELAY_CONFIG_ERROR_CODES,
        unexpectedFailureCode: 'CONFIG_UNAVAILABLE',
      });
      if (!admitted.ok) return admitted.response;
      const ctx = context;
      const host = ctx.host;
      const config = await host.getConfig();

      // Convert bigint pool metadata to JSON-safe numbers for HTTP JSON transport.
      // lotSize/minSize are on-chain u64 stored as bigint internally;
      // JSON.stringify cannot serialize BigInt, so we convert at the API boundary.
      // Fail-closed: reject values that exceed Number.MAX_SAFE_INTEGER.
      const jsonSafePools = ctx.prepareConfig.supportedSettlementSwapPaths.map((p) => {
        const lot = safeBigintToNumber(p.lotSize, 'lotSize');
        const min = safeBigintToNumber(p.minSize, 'minSize');
        return { ...p, lotSize: lot, minSize: min };
      });

      const response: RelayConfigResponse = {
        network: host.network,
        packageId: host.packageId,
        settlementPayoutRecipient: host.settlementPayoutRecipientAddress,
        supportedSettlementSwapPaths: jsonSafePools,
        quotedHostFeeMist: ctx.prepareConfig.quotedHostFeeMist.toString(),
        protocolFlatFeeMist: config.protocolFlatFeeMist.toString(),
      };
      return c.json(response);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[/relay/config] getConfig() failed:', safeErrorSummary(err));
      return respondMapped(c, codedHostError('CONFIG_UNAVAILABLE', RELAY_CONFIG_ERROR_CODES));
    }
  });

  // ── POST /relay/prepare ───────────────────────────────────────────
  app.post('/prepare', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: RELAY_PREPARE_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `prepare:client-ip:${ip}`,
        jsonBodyLimitBytes: MAX_PREPARE_REQUEST_BODY_BYTES,
      });
      if (!admitted.ok) return admitted.response;
      const body = parseRelayPrepareRequest(admitted.value.body);
      const ctx = context;
      const host = ctx.host;

      // Canonical sender boundary — normalize once, use everywhere downstream.
      let canonicalSender: string;
      try {
        canonicalSender = canonicalizeAddress(body.senderAddress, 'senderAddress');
      } catch {
        return respondMapped(c, codedHostError('BAD_REQUEST', RELAY_PREPARE_ERROR_CODES));
      }

      // ── HTTP body BPS validation ──────────────────────────
      // Omitted fields → undefined (defaults apply downstream).
      // Present but invalid → 422 fail-closed. No string coercion.
      // Validation helper: validateBps() in core-api/validateBps.ts.
      let slippageBps: number | undefined;
      if (body.slippageBps !== undefined) {
        const v = validateBps(
          'slippageBps',
          body.slippageBps,
          SLIPPAGE_CAP_BPS,
          'INVALID_SLIPPAGE_BPS',
        );
        if (!v.ok) {
          return respondMapped(c, codedHostError(v.code, RELAY_PREPARE_ERROR_CODES));
        }
        slippageBps = v.value;
      }
      let gasMarginBps: number | undefined;
      if (body.gasMarginBps !== undefined) {
        const v = validateBps(
          'gasMarginBps',
          body.gasMarginBps,
          GAS_MARGIN_CAP_BPS,
          'INVALID_GAS_MARGIN_BPS',
        );
        if (!v.ok) {
          return respondMapped(c, codedHostError(v.code, RELAY_PREPARE_ERROR_CODES));
        }
        gasMarginBps = v.value;
      }

      // ── Generic path ─────────────────────────────────────
      const result: RelayPrepareResponse = await handlePrepare(
        host,
        {
          txKindBytes: body.txKindBytes,
          senderAddress: canonicalSender,
          settlementTokenType: body.settlementTokenType,
          slippageBps,
          gasMarginBps,
          orderId: body.orderId,
          txKindBytesHash: body.txKindBytesHash,
          prepareAuthorizationTimestampMs: body.prepareAuthorizationTimestampMs,
          prepareAuthorizationRequestNonce: body.prepareAuthorizationRequestNonce,
          prepareAuthorizationSignature: body.prepareAuthorizationSignature,
          clientIp: admitted.value.clientIp,
        },
        ctx.prepareConfig,
        {
          async assertSponsorAvailable() {
            const [sponsorOperationsState, slotLeases] = await Promise.all([
              ctx.sponsorAvailability.readState(),
              host.sponsorPool.leaseStatus(),
            ]);
            const blocked = buildSponsorUnavailableResponse(sponsorOperationsState, slotLeases);
            if (blocked) throw new RelayPrepareAdmissionError(blocked.errorCode, blocked.headers);
          },
        },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof RelayPrepareAdmissionError) {
        for (const [key, value] of Object.entries(err.headers)) c.header(key, value);
        return respondMapped(
          c,
          codedHostError(err.errorCode, RELAY_PREPARE_ERROR_CODES, {}, err.headers),
        );
      }
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', RELAY_PREPARE_ERROR_CODES));
      }
      const mapped = mapError(err, RELAY_PREPARE_ERROR_CODES, 'INTERNAL_ERROR');
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[prepare] 500 error:', safeErrorSummary(err));
      return respondMapped(c, codedHostError('INTERNAL_ERROR', RELAY_PREPARE_ERROR_CODES));
    }
  });

  // ── POST /relay/sponsor ───────────────────────────────────────────
  app.post('/sponsor', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: RELAY_SPONSOR_ERROR_CODES,
        unexpectedFailureCode: 'SPONSOR_FAILED',
        ipRateLimitKey: (ip) => `sponsor:client-ip:${ip}`,
        jsonBodyLimitBytes: MAX_SPONSOR_REQUEST_BODY_BYTES,
      });
      if (!admitted.ok) return admitted.response;
      const { txBytes, userSignature, receiptId } = parseRelaySponsorRequest(admitted.value.body);
      const ctx = context;
      const host = ctx.host;

      // handleSponsor routes through the sponsor runner:
      // validate prepared receipt and submitted bytes → atomically enter executing
      // → sign/submit once → atomically finalize → deliver the result callback.
      // The post-terminal host callback writes slot and sponsor refill account state through that
      // runner path, so no separate wake signal is required here.
      const sponsorResult: RelaySponsorResponse = await handleSponsor(
        host,
        { txBytes, userSignature, receiptId },
        admitted.value.clientIp,
      );

      return c.json(sponsorResult);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', RELAY_SPONSOR_ERROR_CODES));
      }
      // SponsorBlockedError carries a dynamic retryAfterMs that must be
      // projected into both the typed body metadata and the Retry-After
      // header; the contracts authority supplies the public message.
      if (err instanceof SponsorBlockedError) {
        return respondMapped(
          c,
          codedHostError(
            'ABUSE_BLOCKED',
            RELAY_SPONSOR_ERROR_CODES,
            { retryAfterMs: err.retryAfterMs },
            { 'Retry-After': formatRetryAfterSeconds(err.retryAfterMs) },
          ),
        );
      }
      const mapped = mapError(err, RELAY_SPONSOR_ERROR_CODES, 'SPONSOR_FAILED');
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api /relay/sponsor] 500 error:', safeErrorSummary(err));
      return respondMapped(c, codedHostError('SPONSOR_FAILED', RELAY_SPONSOR_ERROR_CODES));
    }
  });

  return app;
}
