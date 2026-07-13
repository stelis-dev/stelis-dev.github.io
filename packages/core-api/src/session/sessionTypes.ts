/**
 * Session types — shared type definitions for prepare/sponsor session lifecycle.
 *
 * Internal to core-api. Not exported from the package barrel.
 * Persisted boundary type remains `PreparedTxEntry` in store/prepareTypes.ts.
 */
import type { PreparedTxEntry } from '../store/prepareTypes.js';

// ─────────────────────────────────────────────
// Preflight simulation result
// ─────────────────────────────────────────────

/** Parsed gas usage from a Sui transaction simulation or execution. */
export interface GasUsedFields {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

/**
 * Normalized result from preflight simulation.
 * Callers inspect `success` to branch on simulation outcome.
 */
export type PreflightResult =
  | { success: true; gasUsed: GasUsedFields }
  | { success: false; reason: string };

// ─────────────────────────────────────────────
// TX execution result
// ─────────────────────────────────────────────

/**
 * Normalized result from sponsor-signed transaction execution.
 *
 * Congestion is a terminal cancellation observed after the sponsor signature
 * but before on-chain execution. Every other returned result is an on-chain
 * terminal result. Post-signature responses whose terminal status cannot be
 * proven are thrown as `SponsorPostSignatureUncertaintyError` instead.
 */
export type ExecResult =
  | {
      success: true;
      executionStage: 'on_chain';
      digest: string;
      effects: unknown;
      gasUsed: GasUsedFields | null;
    }
  | {
      success: false;
      executionStage: 'after_sponsor_signature';
      digest: string;
      reason: string;
      isCongestion: true;
      gasUsed: null;
    }
  | {
      success: false;
      executionStage: 'on_chain';
      digest: string;
      reason: string;
      isCongestion: false;
      /**
       * Gas paid for the on-chain attempt (extracted from FailedTransaction
       * effects or status-based failure effects when available). Sponsored
       * execution recorder uses this to mark `economicsStatus = "known"`
       * for onchain reverts that consumed gas. `null` when a validated
       * on-chain terminal result has no canonical gas summary. Transport
       * errors do not produce this variant, and confirmed congestion uses
       * the separate `isCongestion: true` variant above.
       */
      gasUsed: GasUsedFields | null;
    };

// ─────────────────────────────────────────────
// Consume result
// ─────────────────────────────────────────────

/** Normalized result from prepareStore.consume(). */
export type ConsumeOutcome =
  | { status: 'ok'; entry: PreparedTxEntry; txHash: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'hash_mismatch' };
