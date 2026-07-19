/**
 * PTB input object ID extraction utilities.
 *
 * Shared helper for extracting objectId from Transaction input arguments.
 * Supports every current SDK object input, including Object.Receiving.
 *
 * Used internally by core-relay payment-input and prefix-value validation.
 */
import { parseSuiCallArg, projectSuiCallArgObjectId } from './sui/suiTransactionShape.js';

/**
 * Extract objectId from a PTB input, supporting all Object variants.
 * Returns null for current non-object kinds. Malformed or unknown shapes throw.
 */
export function extractObjectIdFromInput(input: Record<string, unknown>): string | null {
  return projectSuiCallArgObjectId(parseSuiCallArg(input));
}
