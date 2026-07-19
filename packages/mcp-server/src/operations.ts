import type { StelisMcpServerConfig } from './config.js';
import { requestJson } from './http.js';
import {
  parsePromotionClaimResponse,
  parsePromotionClaimRequest,
  parsePromotionDetailResponse,
  parsePromotionId,
  parsePromotionListResponse,
  parsePromotionPageQuery,
  parsePromotionPrepareResponse,
  parsePromotionPrepareRequest,
  parsePromotionSponsorResponse,
  parsePromotionSponsorRequest,
  parseRelayConfigResponse,
  parseRelayPrepareResponse,
  parseRelayPrepareRequest,
  parseRelaySponsorResponse,
  parseRelaySponsorRequest,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  RELAY_CONFIG_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  STUDIO_CLAIM_ERROR_CODES,
  STUDIO_DETAIL_ERROR_CODES,
  STUDIO_LIST_ERROR_CODES,
  type PromotionPrepareRequest,
  type PromotionPageQuery,
  type PromotionSponsorRequest,
  type RelayPrepareRequest,
  type RelaySponsorRequest,
} from '@stelis/contracts';

interface RelayApiScopedInput {
  relayApiUrl?: string;
  timeoutMs?: number;
}

export async function getRelayApiConfig(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput,
): Promise<ReturnType<typeof parseRelayConfigResponse>> {
  return parseRelayConfigResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      path: '/config',
      allowedErrorCodes: RELAY_CONFIG_ERROR_CODES,
    }),
  );
}

export async function prepareSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & RelayPrepareRequest,
): Promise<ReturnType<typeof parseRelayPrepareResponse>> {
  const body = parseRelayPrepareRequest(omitRelayApiFields(input));
  return parseRelayPrepareResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      method: 'POST',
      path: '/prepare',
      allowedErrorCodes: RELAY_PREPARE_ERROR_CODES,
      body,
    }),
  );
}

export async function submitSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & RelaySponsorRequest,
): Promise<ReturnType<typeof parseRelaySponsorResponse>> {
  const body = parseRelaySponsorRequest(omitRelayApiFields(input));
  return parseRelaySponsorResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      method: 'POST',
      path: '/sponsor',
      allowedErrorCodes: RELAY_SPONSOR_ERROR_CODES,
      body,
    }),
  );
}

export async function listPromotions(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string } & PromotionPageQuery,
): Promise<ReturnType<typeof parsePromotionListResponse>> {
  const query: PromotionPageQuery = {
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
  const page = parsePromotionPageQuery(query);
  const search = new URLSearchParams();
  if (page.cursor !== null) search.set('cursor', page.cursor);
  if (query.limit !== undefined) search.set('limit', String(page.limit));
  const serializedQuery = search.toString();
  return parsePromotionListResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      base: 'studio',
      path: `/studio/promotions${serializedQuery === '' ? '' : `?${serializedQuery}`}`,
      allowedErrorCodes: STUDIO_LIST_ERROR_CODES,
      headers: bearerHeader(input.developerJwt),
    }),
  );
}

export async function getPromotionDetail(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string },
): Promise<ReturnType<typeof parsePromotionDetailResponse>> {
  const promotionId = parsePromotionId(input.promotionId);
  return parsePromotionDetailResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      base: 'studio',
      path: `/studio/promotions/${encodeURIComponent(promotionId)}`,
      allowedErrorCodes: STUDIO_DETAIL_ERROR_CODES,
      headers: bearerHeader(input.developerJwt),
    }),
  );
}

export async function claimPromotion(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string },
): Promise<ReturnType<typeof parsePromotionClaimResponse>> {
  const promotionId = parsePromotionId(input.promotionId);
  const body = parsePromotionClaimRequest({});
  return parsePromotionClaimResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      base: 'studio',
      method: 'POST',
      path: `/studio/promotions/${encodeURIComponent(promotionId)}/claim`,
      allowedErrorCodes: STUDIO_CLAIM_ERROR_CODES,
      headers: bearerHeader(input.developerJwt),
      body,
    }),
  );
}

export async function preparePromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & {
    developerJwt: string;
    promotionId: string;
  } & PromotionPrepareRequest,
): Promise<ReturnType<typeof parsePromotionPrepareResponse>> {
  const promotionId = parsePromotionId(input.promotionId);
  const body = parsePromotionPrepareRequest({
    senderAddress: input.senderAddress,
    txKindBytes: input.txKindBytes,
  });
  return parsePromotionPrepareResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      base: 'studio',
      method: 'POST',
      path: `/studio/promotions/${encodeURIComponent(promotionId)}/prepare`,
      allowedErrorCodes: PROMOTION_PREPARE_ERROR_CODES,
      headers: bearerHeader(input.developerJwt),
      body,
    }),
  );
}

export async function submitPromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & {
    developerJwt: string;
    promotionId: string;
  } & PromotionSponsorRequest,
): Promise<ReturnType<typeof parsePromotionSponsorResponse>> {
  const promotionId = parsePromotionId(input.promotionId);
  const body = parsePromotionSponsorRequest({
    receiptId: input.receiptId,
    txBytes: input.txBytes,
    userSignature: input.userSignature,
  });
  return parsePromotionSponsorResponse(
    await requestJson(config, {
      relayApiUrl: input.relayApiUrl,
      timeoutMs: input.timeoutMs,
      base: 'studio',
      method: 'POST',
      path: `/studio/promotions/${encodeURIComponent(promotionId)}/sponsor`,
      allowedErrorCodes: PROMOTION_SPONSOR_ERROR_CODES,
      headers: bearerHeader(input.developerJwt),
      body,
    }),
  );
}

function bearerHeader(developerJwt: string): Record<string, string> {
  return { Authorization: `Bearer ${developerJwt}` };
}

function omitRelayApiFields<T extends RelayApiScopedInput>(
  input: T,
): Omit<T, keyof RelayApiScopedInput> {
  const { relayApiUrl: _relayApiUrl, timeoutMs: _timeoutMs, ...rest } = input;
  return rest;
}
