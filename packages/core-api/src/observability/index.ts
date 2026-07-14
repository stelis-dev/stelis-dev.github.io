/**
 * @stelis/core-api/observability — public observability API.
 *
 * Exposes only the logging, event-name, and redaction symbols used by
 * cross-package consumers (app-api). Those consumers import from this
 * subpath; core-api-interior callers use the same sink implementation
 * through relative imports.
 */

export { logStructuredEvent } from '../structuredEventLog.js';
export {
  PREPARE_STORE_EVICT_CLEANUP_FAILED,
  PREPARE_STORE_EVICT_CLEANUP_THREW,
  SPONSORED_LOGS_RECORDER_FAILED,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
  SPONSOR_RESULT_CALLBACK_FAILED,
} from './events.js';
export { redactEndpointUrl, redactSensitiveText, safeErrorSummary } from './redaction.js';
