import type { StelisMcpServerConfig } from './config.js';
import { requestJson } from './http.js';
import type {
  JsonObject,
  PrepareRequest,
  PromotionPrepareRequest,
  PromotionSponsorRequest,
  SponsorRequest,
} from './types.js';

interface RelayApiScopedInput {
  relayApiUrl?: string;
  timeoutMs?: number;
}

export async function getRelayApiConfig(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    path: '/config',
  });
}

export async function prepareSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & PrepareRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    path: '/prepare',
    body: omitRelayApiFields(input),
  });
}

export async function submitSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & SponsorRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    path: '/sponsor',
    body: omitRelayApiFields(input),
  });
}

export async function listPromotions(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    path: '/studio/promotions',
    headers: bearerHeader(input.developerJwt),
  });
}

export async function getPromotionDetail(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}`,
    headers: bearerHeader(input.developerJwt),
  });
}

export async function claimPromotion(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string },
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/claim`,
    headers: bearerHeader(input.developerJwt),
    body: {},
  });
}

export async function preparePromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string } & PromotionPrepareRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/prepare`,
    headers: bearerHeader(input.developerJwt),
    body: {
      senderAddress: input.senderAddress,
      txKindBytes: input.txKindBytes,
    },
  });
}

export async function submitPromotionSponsoredTransaction(
  config: StelisMcpServerConfig,
  input: RelayApiScopedInput & { developerJwt: string; promotionId: string } & PromotionSponsorRequest,
): Promise<JsonObject> {
  return requestJson<JsonObject>(config, {
    relayApiUrl: input.relayApiUrl,
    timeoutMs: input.timeoutMs,
    base: 'studio',
    method: 'POST',
    path: `/studio/promotions/${encodeURIComponent(input.promotionId)}/sponsor`,
    headers: bearerHeader(input.developerJwt),
    body: {
      receiptId: input.receiptId,
      txBytes: input.txBytes,
      userSignature: input.userSignature,
    },
  });
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
