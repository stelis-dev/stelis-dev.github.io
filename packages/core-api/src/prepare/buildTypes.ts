import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SingleHopSettlementSwapPath, SettleProfile } from '@stelis/contracts';
import type {
  PaymentInputSource,
  StaticSettlementSwapPathDescriptor,
} from '@stelis/core-relay/server';
import type { Bps, Mist } from '../internal/brand.js';

/** Context needed for the build phase. */
export interface BuildContext {
  sui: SuiGrpcClient;
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

/** Input for the generic prepare build pipeline. */
export interface GenericPrepareBuildRequest {
  /** Deserialized user transaction (from replay.ts). */
  userTxKindBytes: string;
  senderAddress: string;
  /** Settlement swap path config. Required for all settle paths. */
  settlementSwapPath: SingleHopSettlementSwapPath;
  /** Server-only static settlement swap path descriptor used by market policy. */
  descriptor: StaticSettlementSwapPathDescriptor;
  sponsorAddress: string;
  slippageBps: Bps;
  gasMarginBps: Bps;
  /** Profile determined by vault query. */
  profile: SettleProfile;
  /** Vault object ID, null for new_user. */
  vaultObjectId: string | null;
  /** User credit amount in MIST, "0" for new_user. */
  credit: string;
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
  txBytes: Uint8Array;
  txBytesHash: string;
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
  /** How the payment token was sourced for this build. */
  paymentInputSource: PaymentInputSource;
  /** Final pass2 swap input amount. 0 for credit-only settlement. */
  swapAmountSmallest: bigint;
}
