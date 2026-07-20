import type { SingleHopSettlementSwapPath, SettleProfile, SuiNetwork } from '@stelis/contracts';
import type {
  AllowedSettlementSwapPath,
  ChainBoundSuiEndpointSnapshot,
  ValidationResult,
} from '@stelis/core-relay';
import type {
  AddressBalanceGasTransaction,
  PaymentInputSource,
  StaticSettlementSwapPathDescriptor,
} from '@stelis/core-relay/server';
import type { Bps, Mist } from '../internal/brand.js';
import type { ExtractedSettleArgs } from './extractSettleArgs.js';

/** Context needed for the build phase. */
export interface BuildContext {
  sui: ChainBoundSuiEndpointSnapshot;
  network: SuiNetwork;
  allowedSettlementSwapPaths: readonly AllowedSettlementSwapPath[];
  packageId: string;
  configId: string;
  vaultRegistryId: string;
  deepbookPackageId: string;
  settlementPayoutRecipientAddress: string;
  maxClaimMist: bigint;
  /** On-chain min_settle_mist. Used for INSUFFICIENT_SETTLE_INPUT meta. */
  minSettleMist: bigint;
  /**
   * Host-quoted fee (MIST) per TX, set from HOST_FEE_MIST.
   * Embedded in settle PTB as `quoted_host_fee_mist`.
   */
  quotedHostFeeMist: bigint;
  /** Protocol flat fee in MIST. Used for requiredTotalIn calculation. */
  protocolFlatFeeMist: bigint;
  /**
   * On-chain config_version. Embedded as expected_config_version in settle PTB.
   * On-chain validates equality to detect config drift.
   */
  configVersion: bigint;
}

/** Current read-only inputs needed by the settlement-funding process. */
export type SettlementFundingContext = Pick<
  BuildContext,
  'sui' | 'deepbookPackageId' | 'minSettleMist' | 'quotedHostFeeMist' | 'protocolFlatFeeMist'
>;

/** Request-local facts consumed by the shared settlement-funding process. */
export interface SettlementFundingRequest {
  userTxKindBytes: string;
  senderAddress: string;
  settlementSwapPath: SingleHopSettlementSwapPath;
  descriptor: StaticSettlementSwapPathDescriptor;
  profile: SettleProfile;
  vaultObjectId: string | null;
  credit: string;
}

/** Input for the generic prepare build pipeline. */
export interface GenericPrepareBuildRequest extends SettlementFundingRequest {
  sponsorAddress: string;
  slippageBps: Bps;
  gasMarginBps: Bps;
  /** Receipt ID (32 bytes). */
  receiptId: Uint8Array;
  /** S-14 monotonic nonce for on-chain replay prevention. */
  nonce: bigint;
  /** Policy hash (32 bytes). */
  policyHash: Uint8Array;
  /** Quote timestamp in milliseconds since epoch. */
  quoteTimestampMs: number;
  /** Order ID hash (sha256 of orderId). Empty Uint8Array when no orderId is present. */
  orderIdHash?: Uint8Array;
}

/** Output from the generic prepare build pipeline. */
export interface GenericPrepareBuildOutput {
  addressBalanceGasTransaction: AddressBalanceGasTransaction;
  l1Validation: ValidationResult;
  /** Present only when the final transaction passed the level-1 structure check. */
  settleArgs: ExtractedSettleArgs | null;
  /**
   * Branded `Mist`. Consumers inside `core-api` can read this as a
   * bigint subtype without unwrapping; the brand prevents raw bigints
   * from being written into this field from outside
   * `core-api/src/internal/brand.ts`.
   */
  executionCostClaim: Mist;
  /** Branded `Mist`. */
  simGas: Mist;
  /** Gas variance fixed component for on-chain embed. */
  gasVarianceFixedMist: bigint;
  /** Slippage buffer MIST, 0 for credit-only settlement. */
  slippageBufferMist: bigint;
  grossGas: bigint;
  profile: SettleProfile;
  /** How the settlement token was sourced for this build. */
  paymentInputSource: PaymentInputSource;
  /** Final pass2 swap input amount. 0 for credit-only settlement. */
  swapAmountSmallest: bigint;
}
