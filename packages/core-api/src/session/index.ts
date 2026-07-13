/**
 * Session module — shared prepare/sponsor session lifecycle helpers.
 *
 * Internal to core-api. Not exported from the package barrel.
 * Used by sponsored-execution runners and sponsored execution policies for slot lifecycle.
 */

// Helpers
export {
  decodeTxBytes,
  SessionDecodeError,
  extractTxSender,
  verifySenderSignature,
  SenderSignatureError,
  verifyGasOwner,
  GasOwnerMismatchError,
  runPreflight,
  signAndSubmit,
  SponsorPostSignatureUncertaintyError,
  safeSlotCheckin,
} from './sessionPrimitives.js';

// Types
export type { ExecResult, GasUsedFields, PreflightResult, ConsumeOutcome } from './sessionTypes.js';
