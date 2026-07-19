import { GrpcWebFetchTransport, SuiGrpcClient, type GrpcWebOptions } from '@mysten/sui/grpc';
import {
  canonicalizeSuiRpcOrigin,
  type SuiNetwork,
  type SuiRpcFleetStatus,
} from '@stelis/contracts';
import { SUI_OPERATION_ATTEMPT_TIMEOUT_MS } from '@stelis/core-relay';

/** Resolved configuration for one Sui RPC endpoint. */
export type SuiRpcMetadata = NonNullable<GrpcWebOptions['meta']>;

export interface SuiRpcEndpointConfig {
  readonly baseUrl: string;
  readonly meta?: SuiRpcMetadata;
}

export interface SuiRpcEndpointClient {
  readonly endpoint: Readonly<SuiRpcEndpointConfig>;
  readonly client: SuiGrpcClient;
}

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonical private base URL consumed by the exact installed gRPC-web transport.
 *
 * A provider path is part of the transport address. Query and fragment
 * components are not: the transport appends `/service/method` to this value,
 * so either component would prevent that path from reaching the provider.
 */
export function canonicalizeSuiRpcBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    containsAsciiControl(value)
  ) {
    throw new TypeError('Sui RPC base URL must be a non-empty HTTP(S) URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Sui RPC base URL must be a valid HTTP(S) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Sui RPC base URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Sui RPC base URL must not contain embedded credentials');
  }
  if (parsed.search !== '') {
    throw new TypeError('Sui RPC base URL must not contain a query');
  }
  if (parsed.hash !== '') {
    throw new TypeError('Sui RPC base URL must not contain a fragment');
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/** HTTP field names are case-insensitive; keep one lowercase authority. */
export function normalizeSuiRpcHeaderName(value: string): string {
  const name = value.trim();
  if (!HTTP_FIELD_NAME.test(name)) {
    throw new TypeError('Sui RPC metadata header name is invalid');
  }
  return name.toLowerCase();
}

/** Copy, validate, case-normalize, and freeze transport metadata. */
export function normalizeSuiRpcMetadata(
  meta: SuiRpcMetadata | undefined,
): SuiRpcMetadata | undefined {
  if (meta === undefined) return undefined;
  const result = Object.create(null) as SuiRpcMetadata;
  for (const [rawName, rawValue] of Object.entries(meta)) {
    const name = normalizeSuiRpcHeaderName(rawName);
    if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new TypeError(`Sui RPC metadata defines header "${name}" more than once`);
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (
      values.length === 0 ||
      values.some((value) => typeof value !== 'string' || containsAsciiControl(value))
    ) {
      throw new TypeError(`Sui RPC metadata header "${name}" has an invalid value`);
    }
    if (Array.isArray(rawValue)) {
      const copiedValues = [...values];
      Object.freeze(copiedValues);
      result[name] = copiedValues;
    } else {
      result[name] = values[0]!;
    }
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

/**
 * Create one endpoint-pinned client.
 *
 * The transport consumes the core-relay attempt budget as its default gRPC
 * timeout. Operation-wide retry/deadline policy remains in the core-relay
 * gateways; this client never selects or retries another endpoint.
 */
export function createSuiRpcEndpointClient(
  network: SuiNetwork,
  endpoint: SuiRpcEndpointConfig,
): SuiRpcEndpointClient {
  const immutableEndpoint = Object.freeze({
    baseUrl: canonicalizeSuiRpcBaseUrl(endpoint.baseUrl),
    meta: normalizeSuiRpcMetadata(endpoint.meta),
  });
  const transport = new GrpcWebFetchTransport({
    baseUrl: immutableEndpoint.baseUrl,
    meta: immutableEndpoint.meta,
    timeout: SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
    fetchInit: { redirect: 'error' },
  });
  return Object.freeze({
    endpoint: immutableEndpoint,
    client: new SuiGrpcClient({ network, transport }),
  });
}

/** Build the immutable Admin view of the accepted endpoint fleet. */
export function createQualifiedSuiRpcAdminSnapshot(
  endpoints: readonly Pick<SuiRpcEndpointClient, 'endpoint'>[],
): Readonly<SuiRpcFleetStatus> {
  if (endpoints.length === 0) {
    throw new TypeError('Qualified Sui RPC Admin snapshot requires at least one endpoint');
  }
  const publicEndpoints = Object.freeze(
    endpoints.map((endpoint, index) => {
      const origin = canonicalizeSuiRpcOrigin(new URL(endpoint.endpoint.baseUrl).origin);
      return Object.freeze({
        origin,
        role: index === 0 ? ('primary' as const) : ('secondary' as const),
      });
    }),
  );
  return Object.freeze({
    endpoints: publicEndpoints,
  });
}
