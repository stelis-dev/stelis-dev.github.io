export interface GasUsedLike {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

export interface SettlementEconomicsSnapshot {
  grossGas: bigint;
  // Storage rebate verbatim from the Sui effects, NOT clamped against
  // `grossGas`. A delete-objects-only TX can produce
  // `storageRebate > grossGas`; the snapshot preserves that raw value
  // so observability and recorder rows can keep the on-chain truth
  // separate from the derived clamped `netGas` (which IS clamped to 0
  // because the relayer never pays the user — see canonical helper at
  // `packages/core-relay/src/gasEstimate.ts:119-122`).
  storageRebate: bigint;
  netGas: bigint;
  executionCostClaim: bigint;
  feeCharged: bigint;
  protocolFee: bigint;
  payout: bigint;
  payoutNet: bigint;
}

const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;

function parseGasUsedMist(value: string, field: keyof GasUsedLike): bigint {
  if (!DECIMAL_MIST_RE.test(value)) {
    throw new Error(`gasUsed.${field} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

export function buildSettlementEconomicsSnapshot(input: {
  gasUsed: GasUsedLike;
  executionCostClaim: bigint;
  feeCharged: bigint;
  protocolFee: bigint;
}): SettlementEconomicsSnapshot {
  const grossGas =
    parseGasUsedMist(input.gasUsed.computationCost, 'computationCost') +
    parseGasUsedMist(input.gasUsed.storageCost, 'storageCost');
  const storageRebate = parseGasUsedMist(input.gasUsed.storageRebate, 'storageRebate');
  // Canonical 0-clamp: net gas can be negative when storageRebate
  // exceeds computation + storage (e.g. a TX that deletes objects).
  // The relayer never pays the user, so clamp to 0 — same semantics as
  // `computeExecutionCostClaim(...).simGas` in
  // `packages/core-relay/src/gasEstimate.ts:119-122` and the recorder
  // formula in `docs/economics-formal.md#recorder-economics`. Without this clamp
  // `hostNetMist = executionCostClaim + feeCharged - netGas` would
  // inflate by the rebate-overshoot amount on rebate-heavy TXs. The
  // raw `storageRebate` is preserved verbatim on the snapshot so
  // observability outputs (recorder row, structured event log) can
  // record the on-chain truth without losing it to the clamp.
  const rawNet = grossGas - storageRebate;
  const netGas = rawNet > 0n ? rawNet : 0n;
  const payout = input.executionCostClaim + input.feeCharged;
  const payoutNet = payout - netGas;

  return {
    grossGas,
    storageRebate,
    netGas,
    executionCostClaim: input.executionCostClaim,
    feeCharged: input.feeCharged,
    protocolFee: input.protocolFee,
    payout,
    payoutNet,
  };
}
