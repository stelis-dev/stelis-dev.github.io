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
  checkBlockedRequest,
  toBlockedError,
  readJsonBodyWithLimit,
  MAX_PREPARE_REQUEST_BODY_BYTES,
  MAX_SPONSOR_REQUEST_BODY_BYTES,
  SponsorBlockedError,
  validateBps,
} from '@stelis/core-api';
import {
  GAS_MARGIN_CAP_BPS,
  HostWireParseError,
  SLIPPAGE_CAP_BPS,
  parseRelayPrepareRequest,
  parseRelaySponsorRequest,
  type RelayConfigResponse,
  type RelayPrepareResponse,
  type RelaySponsorResponse,
} from '@stelis/contracts';

import type { AppApiContext } from '../context.js';
import type { ResolveClientIp } from '../clientIp.js';
import { buildSponsorUnavailableResponse } from '../sponsor-operations/gateResponse.js';
import { canonicalizeAddress } from '@stelis/core-api';
import { mapError, respondMapped } from '../errorMap.js';
import { safeBigintToNumber } from '../wireNumbers.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';

export function createRelayRoutes(
  contextPromise: Promise<AppApiContext>,
  resolveClientIp: ResolveClientIp,
) {
  const app = new Hono();

  // ── GET /relay/status ─────────────────────────────────────────────
  app.get('/status', async (c) => {
    try {
      const result = await handleStatus();
      return c.json(result);
    } catch {
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /relay/config ─────────────────────────────────────────────
  app.get('/config', async (c) => {
    const ctx = await contextPromise;
    const host = ctx.host;
    try {
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
      console.error('[/relay/config] getConfig() failed:', err);
      return c.json(
        {
          error: 'Relay config unavailable',
          code: 'CONFIG_UNAVAILABLE',
        },
        503,
      );
    }
  });

  // ── POST /relay/prepare ───────────────────────────────────────────
  app.post('/prepare', async (c) => {
    try {
      const ip = resolveClientIp(c);
      const ctx = await contextPromise;
      const host = ctx.host;

      // Sponsor operations gate check — shared-state read + pure derivation.
      // Bootstrap has already populated the state before HTTP listen, so
      // the decision is synchronous after bounded Redis reads. Prepare
      // admission also requires one healthy sponsor slot that is not
      // currently leased; sponsor submission does not, because it completes
      // an existing lease.
      const [sponsorOperationsState, slotLeases] = await Promise.all([
        ctx.sponsorOperations.readState(),
        host.sponsorPool.leaseStatus(),
      ]);
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState, {
        requireFreeSponsorSlot: true,
        slotLeases,
      });
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return c.json(blocked.body, blocked.status);
      }

      // IP-level block check
      const blockedByIp = await checkBlockedRequest(host.abuseBlocker, ip);
      if (blockedByIp.blocked) {
        return c.json(toBlockedError(blockedByIp), {
          status: 429,
          headers: { 'Retry-After': formatRetryAfterSeconds(blockedByIp.retryAfterMs) },
        });
      }

      // Rate limit
      const rl = await host.rateLimiter.check(`prepare:client-ip:${ip}`);
      if (!rl.allowed) {
        return c.json(
          { error: 'Rate limit exceeded', retryAfterMs: rl.retryAfterMs },
          {
            status: 429,
            headers: { 'Retry-After': formatRetryAfterSeconds(rl.retryAfterMs) },
          },
        );
      }

      const body = parseRelayPrepareRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_PREPARE_REQUEST_BODY_BYTES),
      );

      // Canonical sender boundary — normalize once, use everywhere downstream.
      let canonicalSender: string;
      try {
        canonicalSender = canonicalizeAddress(body.senderAddress, 'senderAddress');
      } catch {
        return c.json(
          { error: `Invalid senderAddress: ${body.senderAddress}`, code: 'BAD_REQUEST' },
          400,
        );
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
        if (!v.ok) return c.json({ error: v.message, code: v.code }, 422);
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
        if (!v.ok) return c.json({ error: v.message, code: v.code }, 422);
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
          clientIp: ip,
        },
        ctx.prepareConfig,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return c.json({ error: err.message, code: 'BAD_REQUEST' }, 400);
      }
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[prepare] 500 error:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.stack) console.error(err.stack); // eslint-disable-line no-console
      return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
    }
  });

  // ── POST /relay/sponsor ───────────────────────────────────────────
  app.post('/sponsor', async (c) => {
    try {
      const ip = resolveClientIp(c);
      const ctx = await contextPromise;
      const host = ctx.host;

      // Sponsor operations gate check — shared-state read + pure derivation.
      // Bootstrap has already populated the state before HTTP listen, so
      // the decision is synchronous after a single Redis round-trip.
      const sponsorOperationsState = await ctx.sponsorOperations.readState();
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState);
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return c.json(blocked.body, blocked.status);
      }

      // IP-level block check
      const blockedByIp = await checkBlockedRequest(host.abuseBlocker, ip);
      if (blockedByIp.blocked) {
        return c.json(toBlockedError(blockedByIp), {
          status: 429,
          headers: { 'Retry-After': formatRetryAfterSeconds(blockedByIp.retryAfterMs) },
        });
      }

      // Rate limit
      const rl = await host.rateLimiter.check(`sponsor:client-ip:${ip}`);
      if (!rl.allowed) {
        return c.json(
          { error: 'Rate limit exceeded', retryAfterMs: rl.retryAfterMs },
          {
            status: 429,
            headers: { 'Retry-After': formatRetryAfterSeconds(rl.retryAfterMs) },
          },
        );
      }

      const { txBytes, userSignature, receiptId } = parseRelaySponsorRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SPONSOR_REQUEST_BODY_BYTES),
      );

      // handleSponsor routes through the sponsor runner:
      // pre-consume validation → consume stored hash → post-consume checks
      // → sign/submit → sponsor result policy → finally slot checkin/release hook.
      // The post-terminal host callback writes slot and sponsor refill account state through that
      // runner path, so no separate wake signal is required here.
      const sponsorResult: RelaySponsorResponse = await handleSponsor(
        host,
        { txBytes, userSignature, receiptId },
        ip,
      );

      return c.json(sponsorResult);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return c.json({ error: err.message, code: 'BAD_REQUEST' }, 400);
      }
      // SponsorBlockedError carries a dynamic retryAfterMs that must be
      // projected into both the body (via toBlockedError) and the
      // Retry-After header; stays route-local.
      if (err instanceof SponsorBlockedError) {
        return c.json(toBlockedError({ blocked: true, retryAfterMs: err.retryAfterMs }), {
          status: 429,
          headers: { 'Retry-After': formatRetryAfterSeconds(err.retryAfterMs) },
        });
      }
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error(
        '[app-api /relay/sponsor] 500 error:',
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: 'Internal server error', code: 'SPONSOR_FAILED' }, 500);
    }
  });

  return app;
}
