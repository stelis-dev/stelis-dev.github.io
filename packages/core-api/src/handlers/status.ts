/**
 * GET /status — Host health check.
 *
 * Intentionally minimal: only confirms the Host is reachable.
 * Package IDs, network info, and settlement swap path config are served as static JSON
 * via GET /relay/config, which the SDK fetches separately.
 */

export interface StatusResponse {
  ok: boolean;
}

export async function handleStatus(): Promise<StatusResponse> {
  return { ok: true };
}
