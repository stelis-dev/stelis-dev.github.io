import { redactSensitiveText } from '@stelis/core-api/observability';

const MAX_SPONSOR_OPERATIONS_LAST_ERROR_BYTES = 512;

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize sponsor operations `lastError` payloads before they reach Redis.
 *
 * Contract:
 * - caller-owned "none" remains the empty string `''`
 * - other values become strings
 * - stored payload is capped to `MAX_SPONSOR_OPERATIONS_LAST_ERROR_BYTES`
 *   without cutting a code point
 */
export function normalizeSponsorOperationsLastError(error: unknown): string {
  const message = redactSensitiveText(stringifyError(error));
  if (message === '') return '';

  const encoder = new TextEncoder();
  if (encoder.encode(message).length <= MAX_SPONSOR_OPERATIONS_LAST_ERROR_BYTES) {
    return message;
  }

  let bytes = 0;
  let normalized = '';
  for (const char of message) {
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > MAX_SPONSOR_OPERATIONS_LAST_ERROR_BYTES) break;
    normalized += char;
    bytes += charBytes;
  }
  return normalized;
}
