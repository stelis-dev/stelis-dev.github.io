/**
 * SuiRpcFailoverTransport — RpcTransport with multi-endpoint failover.
 *
 * Wraps N GrpcWebFetchTransport instances and routes calls:
 *   - Read (idempotent): select best healthy endpoint, passive cooldown on failure
 *   - Write (ExecuteTransaction): primary endpoint only, no retry
 *   - Streaming: primary endpoint delegate, no failover
 *
 * Health model: passive cooldown.
 *   - Failed read → mark endpoint cooldown, next call selects different endpoint
 *   - After cooldown window → endpoint re-enters rotation
 *   - All endpoints in cooldown → try cooldown endpoints as last resort
 *   - No background timer/daemon
 *
 * Retryable error classification (narrow):
 *   - gRPC UNAVAILABLE, DEADLINE_EXCEEDED
 *   - gRPC INTERNAL only if message matches network error patterns
 *   - NOT retryable: application errors (Move abort, invalid args, etc.)
 */
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport';
import { logStructuredEvent } from '@stelis/core-api/observability';
import { UnaryCall } from '@protobuf-ts/runtime-rpc';
import { redactEndpointUrl, redactSensitiveText } from '@stelis/core-api/observability';
import type {
  RpcTransport,
  MethodInfo,
  RpcOptions,
  RpcMetadata,
  ServerStreamingCall,
  ClientStreamingCall,
  DuplexStreamingCall,
} from '@protobuf-ts/runtime-rpc';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default cooldown duration for failed endpoints. See docs/parameters.md#runtime-timing-constants. */
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * gRPC status codes that indicate endpoint-level failures (retryable).
 *
 * INTERNAL requires additional message inspection: Sui gRPC servers wrap
 * both network failures AND application errors (Move abort, balance
 * insufficient, etc.) as RpcError code INTERNAL. Only network-level
 * INTERNAL errors should trigger failover.
 */
const RETRYABLE_GRPC_CODES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED']);

/** Name of the write method — never retried. */
const WRITE_METHOD_NAME = 'ExecuteTransaction';

/**
 * Message patterns that indicate network/transport failures.
 * Used to distinguish retryable INTERNAL errors from application errors.
 */
const NETWORK_ERROR_PATTERNS =
  /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Service Unavailable|503|502|504|connection refused|protocol error.*compression/i;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Endpoint descriptor — supports plain URLs and authenticated providers.
 *
 * `meta` is applied as default RPC metadata (HTTP headers) for this endpoint.
 * Use it for per-endpoint auth headers (e.g. `x-token`, `Authorization`).
 */
export interface SuiRpcEndpointConfig {
  url: string;
  /** Default RPC metadata for this endpoint (e.g. auth headers). */
  meta?: RpcMetadata;
  /** Extra fetch options (credentials, etc.). Cannot carry custom headers. */
  fetchInit?: Omit<RequestInit, 'body' | 'headers' | 'method' | 'signal'>;
}

interface EndpointState {
  transport: GrpcWebFetchTransport;
  url: string;
  /** Per-endpoint default metadata (auth headers). Applied on each delegate attempt. */
  defaultMeta: RpcMetadata;
  cooldownUntil: number; // 0 = healthy
}

export interface FailoverTransportOptions {
  /** Cooldown duration in ms. Default: DEFAULT_COOLDOWN_MS. */
  cooldownMs?: number;
  /** Optional logger for failover events. Default: console. */
  onFailover?: (event: FailoverEvent) => void;
}

export interface FailoverEvent {
  type: 'FAILOVER' | 'ENDPOINT_COOLDOWN' | 'ALL_EXHAUSTED';
  fromUrl?: string;
  toUrl?: string;
  error?: string;
  method?: string;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export class SuiRpcFailoverTransport implements RpcTransport {
  private readonly _endpoints: EndpointState[];
  private readonly _cooldownMs: number;
  private readonly _onFailover: (event: FailoverEvent) => void;

  /**
   * @param endpoints  Endpoint descriptors (at least 1). First = primary (write target).
   *                   Each endpoint may carry per-endpoint `meta` for auth headers.
   * @param options    Failover behavior options.
   */
  constructor(endpoints: SuiRpcEndpointConfig[], options: FailoverTransportOptions = {}) {
    if (endpoints.length === 0) {
      throw new Error('SuiRpcFailoverTransport: at least one endpoint required');
    }
    this._cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this._onFailover = options.onFailover ?? defaultLogger;
    this._endpoints = endpoints.map((ep) => ({
      transport: new GrpcWebFetchTransport({
        baseUrl: ep.url,
        fetchInit: ep.fetchInit,
      }),
      url: ep.url,
      defaultMeta: ep.meta ?? {},
      cooldownUntil: 0,
    }));
  }

  /** Number of configured endpoints. */
  get size(): number {
    return this._endpoints.length;
  }

  /** Primary endpoint URL (first configured). */
  get primaryUrl(): string {
    return this._endpoints[0].url;
  }

  /**
   * Admin-safe snapshot of endpoint fleet state.
   *
   * Excludes: auth metadata, resolved secrets, raw config.
   * Includes: URL, role (primary/secondary), health status, cooldown remaining.
   */
  getAdminSnapshot(): {
    endpoints: Array<{
      url: string;
      role: 'primary' | 'secondary';
      status: 'healthy' | 'cooldown';
      cooldownRemainingMs: number;
    }>;
    totalEndpoints: number;
    healthyEndpoints: number;
  } {
    const now = Date.now();
    const endpoints = this._endpoints.map((ep, idx) => {
      const inCooldown = ep.cooldownUntil > now;
      return {
        url: redactEndpointUrl(ep.url),
        role: (idx === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
        status: (inCooldown ? 'cooldown' : 'healthy') as 'healthy' | 'cooldown',
        cooldownRemainingMs: inCooldown ? ep.cooldownUntil - now : 0,
      };
    });
    return {
      endpoints,
      totalEndpoints: endpoints.length,
      healthyEndpoints: endpoints.filter((e) => e.status === 'healthy').length,
    };
  }

  // ── RpcTransport interface ──────────────────────────────────────

  mergeOptions(options?: Partial<RpcOptions>): RpcOptions {
    return this._endpoints[0].transport.mergeOptions(options);
  }

  unary<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): UnaryCall<I, O> {
    const isWrite = method.name === WRITE_METHOD_NAME;

    if (isWrite) {
      // Write: primary only, no retry. Apply primary's per-endpoint meta.
      const primary = this._endpoints[0];
      const writeOptions = this._applyEndpointMeta(options, primary.defaultMeta);
      return primary.transport.unary(method, input, writeOptions);
    }

    // Read: select the best healthy endpoint and delegate directly.
    // No deferred UnaryCall — protobuf toBinary may mutate internal input state,
    // making same-input retry on a different transport unreliable.
    // Passive cooldown: failed endpoints are skipped in subsequent calls.
    //
    // Re-merge options through the selected endpoint's transport to get the
    // correct baseUrl. stackIntercept calls our mergeOptions() which returns
    // primary's defaults (including primary's baseUrl); we must re-merge
    // through the selected endpoint so makeUrl() uses the correct URL.
    const now = Date.now();
    const candidates = this._selectCandidates(now);
    const selected = candidates[0];
    // Strip primary's baseUrl from options before re-merging through
    // the selected endpoint's transport. stackIntercept already called
    // our mergeOptions() which baked in primary's baseUrl — the selected
    // endpoint's transport.mergeOptions() must replace it with its own.
    const { baseUrl: _, ...stripped } = options as Record<string, unknown>;
    const remerged = selected.transport.mergeOptions(stripped as Partial<RpcOptions>);
    const epOptions = this._applyEndpointMeta(remerged, selected.defaultMeta);
    const call = selected.transport.unary(method, input, epOptions);

    // Mark endpoint unhealthy on retryable failure (passive cooldown)
    call.response.catch((err: unknown) => {
      if (this._isRetryable(err)) {
        selected.cooldownUntil = Date.now() + this._cooldownMs;
        this._onFailover({
          type: 'ENDPOINT_COOLDOWN',
          fromUrl: redactEndpointUrl(selected.url),
          error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
          method: method.name,
        });
      }
    });

    return call;
  }

  serverStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    input: I,
    options: RpcOptions,
  ): ServerStreamingCall<I, O> {
    const primary = this._endpoints[0];
    const epOptions = this._applyEndpointMeta(options, primary.defaultMeta);
    return primary.transport.serverStreaming(method, input, epOptions);
  }

  clientStreaming<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    _options: RpcOptions,
  ): ClientStreamingCall<I, O> {
    // GrpcWebFetchTransport does not support client streaming — throws immediately.
    return this._endpoints[0].transport.clientStreaming(method);
  }

  duplex<I extends object, O extends object>(
    method: MethodInfo<I, O>,
    _options: RpcOptions,
  ): DuplexStreamingCall<I, O> {
    // GrpcWebFetchTransport does not support duplex — throws immediately.
    return this._endpoints[0].transport.duplex(method);
  }

  // ── Internal ────────────────────────────────────────────────────

  /**
   * Select the best endpoint for this call.
   *
   * Priority-ordered (not round-robin): always prefer the first healthy
   * endpoint. Secondary endpoints are only used when primary is in cooldown.
   * This ensures consistent behavior — primary handles all traffic unless down.
   */
  private _selectCandidates(now: number): EndpointState[] {
    const healthy: EndpointState[] = [];
    const coolingDown: EndpointState[] = [];

    for (const ep of this._endpoints) {
      if (ep.cooldownUntil <= now) {
        healthy.push(ep);
      } else {
        coolingDown.push(ep);
      }
    }

    return healthy.length > 0 ? healthy : coolingDown;
  }

  /**
   * Apply per-endpoint default metadata to call options.
   * Endpoint defaults are fallbacks — call-site meta takes precedence.
   */
  private _applyEndpointMeta(options: RpcOptions, endpointMeta: RpcMetadata): RpcOptions {
    if (Object.keys(endpointMeta).length === 0) return options;
    return {
      ...options,
      meta: { ...endpointMeta, ...(options.meta ?? {}) },
    };
  }

  /**
   * Determine if an error is retryable (endpoint-level, not application-level).
   *
   * Retryable: network/transport failures that indicate the endpoint is down.
   * Not retryable: application errors (Move abort, balance insufficient, etc.)
   *
   * Sui gRPC wraps BOTH network failures AND application errors as
   * RpcError code INTERNAL. For INTERNAL, we check the message to
   * distinguish network failures from application errors.
   */
  private _isRetryable(err: unknown): boolean {
    // Network/fetch errors (no response received)
    if (err instanceof TypeError) return true;

    // RpcError with gRPC status code
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
    ) {
      const code = (err as { code: string }).code;

      // UNAVAILABLE / DEADLINE_EXCEEDED — always retryable (endpoint down)
      if (RETRYABLE_GRPC_CODES.has(code)) return true;

      // INTERNAL — only retryable if it looks like a network/transport error,
      // not an application error. Sui gRPC returns INTERNAL for both.
      // Messages may be URL-encoded by the gRPC-web transport, so decode first.
      if (code === 'INTERNAL') {
        const raw = err instanceof Error ? err.message : '';
        const msg = safeDecodeUri(raw);
        return NETWORK_ERROR_PATTERNS.test(msg);
      }

      return false;
    }

    // Plain Error with network-like message
    if (err instanceof Error) {
      return NETWORK_ERROR_PATTERNS.test(safeDecodeUri(err.message));
    }

    return false;
  }
}

// ─────────────────────────────────────────────
// Default logger
// ─────────────────────────────────────────────

/** Safely decode URI-encoded strings (gRPC-web transport may URL-encode error messages). */
function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function defaultLogger(event: FailoverEvent): void {
  const level = event.type === 'ALL_EXHAUSTED' ? 'error' : 'warn';
  // Name is bounded by the FailoverEvent.type literal union. The public
  // operations summary lists the resulting three names.
  logStructuredEvent(`SUI_RPC_${event.type}`, { ...event }, level);
}
