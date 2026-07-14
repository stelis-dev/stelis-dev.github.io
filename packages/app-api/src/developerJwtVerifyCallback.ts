/**
 * Developer JWT verify URL callback — host/runtime concern.
 *
 * After local JWT verification succeeds (in core-api), this module
 * calls the developer-owned verification API to confirm the token
 * is still valid (e.g., not revoked, session still active).
 *
 * This is intentionally in app-api, not core-api, because:
 * - core-api is framework-agnostic domain logic (no HTTP calls)
 * - app-api is the host/runtime layer (HTTP, env, Redis)
 *
 * Optional, fail-closed.
 *
 * @module developerJwtVerifyCallback
 */

/**
 * Timeout for developer verify API call.
 * Documented in docs/parameters.md#runtime-timing-constants.
 * Fail-closed: if the callback does not respond within this window,
 * the developer JWT is rejected.
 */
export const DEVELOPER_VERIFY_TIMEOUT_MS = 5_000;

export class DeveloperVerifyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeveloperVerifyRejectedError';
  }
}

export class DeveloperVerifyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeveloperVerifyUnavailableError';
  }
}

function parseDeveloperVerifyResponse(value: unknown): { valid: boolean; reason?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeveloperVerifyUnavailableError(
      'developer verify API returned a non-object response',
    );
  }
  const raw = value as Record<string, unknown>;
  const unexpectedKey = Object.keys(raw).find((key) => key !== 'valid' && key !== 'reason');
  if (unexpectedKey !== undefined) {
    throw new DeveloperVerifyUnavailableError(
      'developer verify API returned a non-current response shape',
    );
  }
  if (typeof raw.valid !== 'boolean') {
    throw new DeveloperVerifyUnavailableError(
      'developer verify API response.valid must be a boolean',
    );
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    throw new DeveloperVerifyUnavailableError(
      'developer verify API response.reason must be a string when present',
    );
  }
  return raw.reason === undefined
    ? { valid: raw.valid }
    : { valid: raw.valid, reason: raw.reason as string };
}

/**
 * Call the developer-owned JWT verification API.
 *
 * Request: POST JSON `{ "jwt": "<developerJwt>" }`
 * Expected success: `{ "valid": true }`
 * Expected deny: `{ "valid": false, "reason"?: string }`
 *
 * Fail-closed on:
 * - Network error
 * - Non-2xx response
 * - Invalid response body
 * - Timeout (`DEVELOPER_VERIFY_TIMEOUT_MS`)
 * - `{ "valid": false }`
 *
 * @param jwt - The developer JWT to verify
 * @param verifyUrl - The developer-owned verification URL
 * @throws DeveloperVerifyRejectedError when the developer supplies an explicit
 *   negative verdict.
 * @throws DeveloperVerifyUnavailableError when no trustworthy verdict can be
 *   established because the callback transport or response is unavailable.
 */
export async function callDeveloperVerifyApi(jwt: string, verifyUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEVELOPER_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new DeveloperVerifyUnavailableError(
        `developer verify API returned HTTP ${response.status}`,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch {
      throw new DeveloperVerifyUnavailableError('developer verify API returned invalid JSON');
    }
    const body = parseDeveloperVerifyResponse(rawBody);

    if (!body.valid) {
      throw new DeveloperVerifyRejectedError(
        `developer verify API denied: ${body.reason ?? 'no reason given'}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeveloperVerifyUnavailableError(
        `developer verify API timed out after ${DEVELOPER_VERIFY_TIMEOUT_MS}ms`,
      );
    }
    if (err instanceof DeveloperVerifyRejectedError) throw err;
    if (err instanceof DeveloperVerifyUnavailableError) throw err;
    throw new DeveloperVerifyUnavailableError(
      `developer verify API request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
