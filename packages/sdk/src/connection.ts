/**
 * Relayer configuration loading and parsing.
 *
 * Standalone helpers used by StelisSDK.connect().
 * No StelisSDK state required — pure I/O and validation.
 */
import {
  SETTLEMENT_SWAP_DIRECTION_VECTORS,
  VALID_SETTLEMENT_SWAP_DIRECTIONS,
} from '@stelis/contracts';
import type { RelayerConfig, SingleHopSettlementSwapPath, StelisRequestTimeouts } from './types.js';

const DEFAULT_RELAY_CONFIG_TIMEOUT_MS = 5_000;
const MIST_STRING_RE = /^(?:0|[1-9]\d*)$/;

export async function fetchRelayConfig(
  endpoint: string,
  requestTimeouts?: StelisRequestTimeouts,
): Promise<unknown> {
  const configUrl = endpoint.replace(/\/relay\/?$/, '') + '/relay/config';
  const timeoutMs = resolveConfigTimeoutMs(requestTimeouts?.configMs);
  const res = await fetch(configUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET /relay/config failed: ${res.status}`);
  return res.json();
}

function resolveConfigTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_RELAY_CONFIG_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[StelisSDK] requestTimeouts.configMs must be a positive integer within Number.MAX_SAFE_INTEGER, got ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

/**
 * Validate /relay/config response shape and narrow to `RelayerConfig`.
 * Throws a descriptive error if required fields are missing.
 */
export function parseRelayerConfig(data: unknown): RelayerConfig {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Invalid /relay/config response: expected object, got ${JSON.stringify(data)}`);
  }
  const raw = data as Record<string, unknown>;

  const network = raw.network;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(
      `Invalid /relay/config response: network must be 'testnet' | 'mainnet', got ${JSON.stringify(network)}`,
    );
  }

  const packageId = raw.packageId;
  if (typeof packageId !== 'string' || packageId.length === 0) {
    throw new Error('Invalid /relay/config response: packageId must be a non-empty string');
  }

  const settlementPayoutRecipient = raw.settlementPayoutRecipient;
  if (typeof settlementPayoutRecipient !== 'string' || settlementPayoutRecipient.length === 0) {
    throw new Error('Invalid /relay/config response: settlementPayoutRecipient must be a non-empty string');
  }

  const supportedSettlementSwapPaths = raw.supportedSettlementSwapPaths;
  if (!Array.isArray(supportedSettlementSwapPaths)) {
    throw new Error(
      'Invalid /relay/config response: supportedSettlementSwapPaths must be an array',
    );
  }

  const quotedHostFeeMist = raw.quotedHostFeeMist;
  if (typeof quotedHostFeeMist !== 'string' || !MIST_STRING_RE.test(quotedHostFeeMist)) {
    throw new Error(
      'Invalid /relay/config response: quotedHostFeeMist must be a non-negative integer string',
    );
  }
  const protocolFlatFeeMist = raw.protocolFlatFeeMist;
  if (typeof protocolFlatFeeMist !== 'string' || !MIST_STRING_RE.test(protocolFlatFeeMist)) {
    throw new Error(
      'Invalid /relay/config response: protocolFlatFeeMist must be a non-negative integer string',
    );
  }

  const integrityPolicyVersion = raw.integrityPolicyVersion;
  if (
    typeof integrityPolicyVersion !== 'number' ||
    !Number.isSafeInteger(integrityPolicyVersion) ||
    integrityPolicyVersion < 1
  ) {
    throw new Error(
      `Invalid /relay/config response: integrityPolicyVersion must be an integer >= 1 within Number.MAX_SAFE_INTEGER, got ${JSON.stringify(integrityPolicyVersion)}`,
    );
  }

  // Convert lotSize/minSize from JSON number to bigint (JSON format is number,
  // but SingleHopSettlementSwapPath declares them as bigint for internal precision safety).
  // Fail-closed: missing lotSize/minSize is a malformed config, not a "use default" scenario.
  const parsedSettlementSwapPaths = (
    supportedSettlementSwapPaths as Array<Record<string, unknown>>
  ).map((p, i) => {
    if (typeof p.lotSize !== 'number' || typeof p.minSize !== 'number') {
      throw new Error(
        `Invalid /relay/config response: supportedSettlementSwapPaths[${i}] missing lotSize or minSize`,
      );
    }
    if (
      !Number.isSafeInteger(p.lotSize) ||
      !Number.isSafeInteger(p.minSize) ||
      p.lotSize < 0 ||
      p.minSize < 0
    ) {
      throw new Error(
        `Invalid /relay/config response: supportedSettlementSwapPaths[${i}] lotSize or minSize must be non-negative safe integers`,
      );
    }
    // Fail-closed: settlementSwapDirection <-> hops <-> swapDirection integrity.
    validateSettlementSwapPathIntegrity(p, i);
    validatePoolFeeIntegrity(p, i);
    return {
      ...p,
      lotSize: BigInt(p.lotSize),
      minSize: BigInt(p.minSize),
    };
  }) as SingleHopSettlementSwapPath[];
  validateUniquePaymentTokenTypes(parsedSettlementSwapPaths);

  return {
    network,
    packageId,
    settlementPayoutRecipient,
    supportedSettlementSwapPaths: parsedSettlementSwapPaths,
    quotedHostFeeMist,
    protocolFlatFeeMist,
    integrityPolicyVersion,
  };
}

function validateBpsField(value: unknown, field: string, prefix: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${prefix} ${field} must be a safe integer in [0, 10000]`);
  }
  return value;
}

function validatePoolFeeIntegrity(p: Record<string, unknown>, idx: number): void {
  const prefix = `Invalid /relay/config response: supportedSettlementSwapPaths[${idx}]`;
  const effectiveFeeRateBps = validateBpsField(
    p.effectiveFeeRateBps,
    'effectiveFeeRateBps',
    prefix,
  );
  const hops = p.hops as Array<Record<string, unknown>>;
  for (let h = 0; h < hops.length; h++) {
    const feeBps = validateBpsField(hops[h].feeBps, `hops[${h}].feeBps`, prefix);
    if (hops.length === 1 && feeBps !== effectiveFeeRateBps) {
      throw new Error(
        `${prefix} hops[${h}].feeBps (${feeBps}) must equal effectiveFeeRateBps (${effectiveFeeRateBps}) for a 1-hop settlement swap path`,
      );
    }
  }
}

/**
 * Fail-closed client-side parse guard: settlementSwapDirection ↔ hops.length ↔ ordered swapDirection vector.
 *
 * Consumes the shared `SETTLEMENT_SWAP_DIRECTION_VECTORS` / `VALID_SETTLEMENT_SWAP_DIRECTIONS`
 * from @stelis/contracts with no local duplicate settlement swap path table.
 *
 * Rejects malformed settlement swap paths at parse time so that downstream consumers
 * (getExchangeRate, estimateGas, checkSettlementSwapPathLiquidity) never see inconsistent data.
 */
function validateSettlementSwapPathIntegrity(p: Record<string, unknown>, idx: number): void {
  const prefix = `Invalid /relay/config response: supportedSettlementSwapPaths[${idx}]`;

  // settlementSwapDirection must be a known shared value.
  const direction = p.settlementSwapDirection;
  if (
    typeof direction !== 'string' ||
    !(VALID_SETTLEMENT_SWAP_DIRECTIONS as ReadonlySet<string>).has(direction)
  ) {
    throw new Error(
      `${prefix} settlementSwapDirection must be one of ${[...VALID_SETTLEMENT_SWAP_DIRECTIONS].join(', ')}, got ${JSON.stringify(direction)}`,
    );
  }

  // hops must be a non-empty array
  const hops = p.hops;
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new Error(`${prefix} hops must be a non-empty array`);
  }

  // hops.length ↔ settlementSwapDirection ↔ ordered swapDirection vector consistency.
  const expectedDeepBookSwapDirections =
    SETTLEMENT_SWAP_DIRECTION_VECTORS[direction as keyof typeof SETTLEMENT_SWAP_DIRECTION_VECTORS];
  if (hops.length !== expectedDeepBookSwapDirections.length) {
    throw new Error(
      `${prefix} settlementSwapDirection '${direction}' requires ${expectedDeepBookSwapDirections.length} hop(s), got ${hops.length}`,
    );
  }
  for (let h = 0; h < hops.length; h++) {
    const hop = hops[h] as Record<string, unknown> | undefined;
    if (typeof hop !== 'object' || hop === null) {
      throw new Error(`${prefix} hops[${h}] must be an object`);
    }
    const sf = hop.swapDirection;
    if (sf !== 'baseForQuote' && sf !== 'quoteForBase') {
      throw new Error(
        `${prefix} hops[${h}].swapDirection must be 'baseForQuote' | 'quoteForBase', got ${JSON.stringify(sf)}`,
      );
    }
    if (sf !== expectedDeepBookSwapDirections[h]) {
      throw new Error(
        `${prefix} hops[${h}].swapDirection '${sf}' inconsistent with settlementSwapDirection '${direction}' (expected '${expectedDeepBookSwapDirections[h]}')`,
      );
    }
  }
}

function validateUniquePaymentTokenTypes(paths: readonly SingleHopSettlementSwapPath[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path.paymentTokenType)) {
      throw new Error(
        `Invalid /relay/config response: duplicate paymentTokenType in supportedSettlementSwapPaths: ${path.paymentTokenType}`,
      );
    }
    seen.add(path.paymentTokenType);
  }
}
