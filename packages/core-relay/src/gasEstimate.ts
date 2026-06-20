/**
 * Shared gas estimation helper for relayer cost formulas.
 *
 * Used by:
 *   - core-api/prepare/build.ts  (server-side, actual dry-run)
 *   - sdk/sdk.ts                    (client-side, preview estimate)
 *
 * Formula:
 *   simGas              = max(0, computationCost + storageCost − storageRebate)
 *   grossGas            = computationCost + storageCost
 *   gasVarianceFixedMist = GAS_VARIANCE_FIXED_MIST (fixed constant)
 *   slippageBufferMist  = DEX slippage buffer (swap paths only; 0 for credit paths)
 *   executionCostClaim        = simGas + gasVarianceFixedMist + slippageBufferMist
 *
 * GAS_VARIANCE_FIXED_MIST covers gas price variance between dry-run and execution.
 * slippageBufferMist covers DEX price movement (swap paths only; 0 for credit paths).
 *
 * ⚠️ Epoch boundary: if gas price rises between dry-run and execution,
 *    simGas may underestimate actual gas → relayer absorbs micro-loss.
 *    This is intentional — revenue comes from quotedHostFeeMist / protocol_fee.
 *
 * See docs/economics-formal.md for details.
 */

// ─────────────────────────────────────────────
// Constants used by gas estimation
// ─────────────────────────────────────────────

/**
 * Fixed gas variance margin (MIST).
 * Covers gas price variance between dry-run and execution.
 *
 * The exact value is `GAS_VARIANCE_FIXED_MIST`.
 */
export const GAS_VARIANCE_FIXED_MIST = 100_000n;

// Shared economic-policy caps live in @stelis/contracts. Import
// SLIPPAGE_CAP_BPS from that package directly when needed.

/**
 * Pass 2 re-verification tolerance (BPS).
 * If residualSlippage exceeds slippageBuffer₀ by more than this tolerance,
 * the transaction is rejected (SLIPPAGE_CONVERGENCE_FAILED).
 */
export const CONVERGENCE_TOLERANCE_BPS = 500;

/**
 * Default gas margin BPS for gasBudget over grossGas.
 * gasBudget = grossGas × (1 + DEFAULT_GAS_MARGIN_BPS / 10_000).
 */
export const DEFAULT_GAS_MARGIN_BPS = 1000;

// Shared economic-policy caps live in @stelis/contracts. Import
// GAS_MARGIN_CAP_BPS from that package directly when needed.

const DEFAULT_SLIPPAGE_BUFFER_MIST = 0n;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Gas usage fields from a dry-run / simulation response. */
export interface SimulationGasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

/** Options for computeExecutionCostClaim. */
export interface ComputeExecutionCostClaimOpts {
  /** Slippage buffer in MIST (swap paths only). Default: `DEFAULT_SLIPPAGE_BUFFER_MIST`. */
  slippageBufferMist?: bigint;
}

/** Result of gas estimation — all amounts in MIST. */
export interface ExecutionCostClaimEstimate {
  /** Net gas: max(0, computation + storage − rebate) */
  simGas: bigint;
  /** Gross gas: computation + storage (no rebate) */
  grossGas: bigint;
  /** Fixed gas variance margin (GAS_VARIANCE_FIXED_MIST) */
  gasVarianceFixedMist: bigint;
  /** DEX slippage buffer (0 for credit paths) */
  slippageBufferMist: bigint;
  /** Execution cost claim: simGas + gasVarianceFixedMist + slippageBufferMist */
  executionCostClaim: bigint;
}

const DECIMAL_U64_RE = /^(?:0|[1-9]\d*)$/;

function parseGasUsedAmount(value: string, field: keyof SimulationGasUsed): bigint {
  if (!DECIMAL_U64_RE.test(value)) {
    throw new Error(`gasUsed.${field} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

// ─────────────────────────────────────────────
// Core function
// ─────────────────────────────────────────────

/**
 * Compute relayer cost estimate from dry-run gas usage.
 *
 * Pure function — no I/O, no state, deterministic.
 * Both SDK and core-api import this to guarantee identical cost math.
 *
 * @param gasUsed - Gas usage fields from simulateTransaction response
 * @param opts    - Optional: slippageBufferMist for swap paths
 */
export function computeExecutionCostClaim(
  gasUsed: SimulationGasUsed,
  opts?: ComputeExecutionCostClaimOpts,
): ExecutionCostClaimEstimate {
  const computationCost = parseGasUsedAmount(gasUsed.computationCost, 'computationCost');
  const storageCost = parseGasUsedAmount(gasUsed.storageCost, 'storageCost');
  const storageRebate = parseGasUsedAmount(gasUsed.storageRebate, 'storageRebate');

  // Net gas can be negative when storageRebate exceeds computation + storage
  // (e.g. TX that deletes objects). Clamp to 0 — relayer never pays the user.
  const rawSimGas = computationCost + storageCost - storageRebate;
  const simGas = rawSimGas > 0n ? rawSimGas : 0n;
  const grossGas = computationCost + storageCost;

  const gasVarianceFixedMist = GAS_VARIANCE_FIXED_MIST;
  const slippageBufferMist = opts?.slippageBufferMist ?? DEFAULT_SLIPPAGE_BUFFER_MIST;
  const effectiveSlippage = slippageBufferMist > 0n ? slippageBufferMist : 0n;

  const executionCostClaim = simGas + gasVarianceFixedMist + effectiveSlippage;

  return {
    simGas,
    grossGas,
    gasVarianceFixedMist,
    slippageBufferMist: effectiveSlippage,
    executionCostClaim,
  };
}
