/**
 * StelisSDK — sponsored transaction client for Sui dApps.
 *
 * Connects to a Relay API endpoint:
 *   1. GET /relay/status → health check
 *   2. GET /relay/config → current Relay API config parsed by StelisClient
 *
 * Contract addresses (configId, vaultRegistryId, deepbookPackageId, deepType) are resolved
 * from SDK built-in constants in @stelis/contracts — not from the Relay API response.
 */
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase64, toHex } from '@mysten/sui/utils';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { buildWithdrawPtb } from './ptb.js';
import { StelisClient, StelisApiException } from './client.js';
import {
  queryUserCredit as queryUserCreditThroughGateway,
  type CreditResult,
} from '@stelis/core-relay/browser';
import { verifyPtbIntegrity, verifyPromotionPtbIntegrity } from './integrity.js';
import { assertNoGasPreset } from '@stelis/core-relay/browser';
import {
  assertSuiNetwork,
  buildSuiTransaction,
  computeExecutionCostClaim,
  createSuiEndpointSnapshot,
  DEFAULT_GAS_MARGIN_BPS,
  encodePrepareAuthorizationMessage,
  extractSettleTransactionFieldsFromTxBytes,
  sha256Bytes,
  validateSettleTransactionFields,
  validateGenericUserTransactionKind,
  type SuiEndpointSnapshot,
  SuiOperationError,
  executeSuiTransaction,
  getSuiBalance,
  simulateSuiTransaction,
  suiExecutionErrorMessage,
} from '@stelis/core-relay/browser';
import {
  STELIS_CONTRACT_IDS,
  DEEPBOOK_IDS,
  SUI_CHAIN_IDENTIFIERS,
  requireContractId,
  type PrepareAuthorizationFields,
} from '@stelis/contracts';
import { parseRelayConfig } from './connection.js';
import { normalizeApiError, StelisSponsoredError } from './errors.js';
import {
  bigintToSafeNumberOrNull,
  formatRatioDecimal,
  formatSmallestUnitDecimal,
  parseDecimalBigInt,
} from './numberFormat.js';
import type {
  RelayConfig,
  SingleHopSettlementSwapPath,
  StelisConnectOptions,
  PrepareSponsoredOptions,
  ExecuteSponsoredOptions,
  ExecuteSponsoredResult,
  PrepareSponsoredResult,
  GasEstimateResult,
  ExecuteSuiFirstResult,
  ExecutePromotionSponsoredOptions,
  ExecutePromotionSponsoredResult,
  PromotionPrepareResponse,
  PromotionSponsorResponse,
} from './types.js';
import { batchGetHopMidPrices } from '@stelis/core-relay/browser';
import {
  composeSettlementTokenToSuiMidPrice,
  DEEPBOOK_MID_PRICE_SCALING,
  readSettlementSwapPathLiquidity,
  type SettlementSwapPathLiquidityStatus,
} from './swap.js';

const SUI_DECIMALS = 9;
const DEFAULT_ESTIMATE_GAS_INTENT_BUDGET_MIST = 5_000_000;
const PREPARE_REQUEST_NONCE_BYTES = 16;

type OptionalPrepareFields = Pick<
  PrepareAuthorizationFields,
  'slippageBps' | 'gasMarginBps' | 'orderId'
>;

function createOptionalPrepareFields(
  opts: Pick<PrepareSponsoredOptions, 'slippageBps' | 'gasMarginBps' | 'orderId'>,
): OptionalPrepareFields {
  return {
    ...(opts.slippageBps === undefined ? {} : { slippageBps: opts.slippageBps }),
    ...(opts.gasMarginBps === undefined ? {} : { gasMarginBps: opts.gasMarginBps }),
    ...(opts.orderId === undefined ? {} : { orderId: opts.orderId }),
  };
}

function isSuiInfrastructureFailure(error: unknown): boolean {
  return (
    error instanceof SuiOperationError &&
    (error.kind === 'deadline_exceeded' || error.kind === 'transport_unavailable')
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string, field: string): Uint8Array {
  const withoutPrefix = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(withoutPrefix) || withoutPrefix.length % 2 !== 0) {
    throw new StelisSponsoredError('INVALID_PREPARE_RESPONSE', `${field} is not valid hex`);
  }
  const bytes = new Uint8Array(withoutPrefix.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(withoutPrefix.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function generatePrepareRequestNonce(): string {
  const bytes = new Uint8Array(PREPARE_REQUEST_NONCE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// Internal params
interface WithdrawParams {
  vaultId: string;
  recipientAddress: string;
}

// ─────────────────────────────────────────────
// SDK Class
// ─────────────────────────────────────────────

export class StelisSDK {
  private _client: StelisClient;
  private _relayConfig: RelayConfig;
  // Contract IDs from shared @stelis/contracts constants.
  private _packageId: string;
  private _configId: string;
  private _vaultRegistryId: string;
  private _deepbookPackageId: string;
  private _deepType: string;
  private readonly _suiEndpointProofs = new WeakMap<SuiGrpcClient, Promise<SuiEndpointSnapshot>>();

  /** Deployment network */
  get network(): RelayConfig['network'] {
    return this._relayConfig.network;
  }
  /** Network config (contract addresses from @stelis/contracts constants) */
  get config() {
    return {
      packageId: this._packageId,
      configId: this._configId,
      vaultRegistryId: this._vaultRegistryId,
      deepbookPackageId: this._deepbookPackageId,
      deepType: this._deepType,
    };
  }
  /** DeepBook package ID (from @stelis/contracts constants) */
  get deepbookPackageId() {
    return this._deepbookPackageId;
  }
  /** DEEP token type (from @stelis/contracts constants) */
  get deepType() {
    return this._deepType;
  }
  /** Settlement payout recipient address for executionCostClaim plus quoted host fee. */
  get settlementPayoutRecipient() {
    return this._relayConfig.settlementPayoutRecipient;
  }
  /** Supported settlement swap paths (from /relay/config) */
  get supportedSettlementSwapPaths(): SingleHopSettlementSwapPath[] {
    return this._relayConfig.supportedSettlementSwapPaths;
  }
  private constructor(client: StelisClient, relayConfig: RelayConfig) {
    this._client = client;
    this._relayConfig = relayConfig;
    // Resolve contract IDs from shared @stelis/contracts constants.
    const network = relayConfig.network;
    const ids = STELIS_CONTRACT_IDS[network];
    this._packageId = requireContractId(ids?.packageId, 'STELIS_PACKAGE_ID');
    this._configId = requireContractId(ids?.configId, 'STELIS_CONFIG_ID');
    this._vaultRegistryId = requireContractId(ids?.vaultRegistryId, 'STELIS_VAULT_REGISTRY_ID');
    this._deepbookPackageId = requireContractId(
      DEEPBOOK_IDS[network]?.packageId,
      'DEEPBOOK_PACKAGE_ID',
    );
    this._deepType = requireContractId(DEEPBOOK_IDS[network]?.deepType, 'DEEP_TYPE');
  }

  /** Prove one caller-supplied client against the connected Host network once. */
  private async _suiEndpoints(client: SuiGrpcClient): Promise<SuiEndpointSnapshot> {
    const cached = this._suiEndpointProofs.get(client);
    if (cached) return cached;

    const snapshot = createSuiEndpointSnapshot([client]);
    const proof = assertSuiNetwork(snapshot, {
      network: this._relayConfig.network,
      chainIdentifier: SUI_CHAIN_IDENTIFIERS[this._relayConfig.network],
    }).then(() => snapshot);
    this._suiEndpointProofs.set(client, proof);
    try {
      return await proof;
    } catch (error) {
      if (this._suiEndpointProofs.get(client) === proof) {
        this._suiEndpointProofs.delete(client);
      }
      throw error;
    }
  }

  /** Query current User Vault credit after proving the supplied client network. */
  async queryUserCredit(client: SuiGrpcClient, userAddress: string): Promise<CreditResult> {
    const endpoints = await this._suiEndpoints(client);
    return queryUserCreditThroughGateway(
      endpoints,
      this._packageId,
      this._vaultRegistryId,
      userAddress,
    );
  }

  /**
   * Connect to a Host and auto-configure the SDK.
   * 1. GET /relay/status → { ok: true }
   * 2. GET /relay/config → Relay config response
   * 3. Contract addresses from SDK built-in constants
   *
   * @param endpoint - Relay API URL (required).
   * @param options  - Connection options (pinnedPackageId, requestTimeouts)
   */
  static async connect(endpoint: string, options?: StelisConnectOptions): Promise<StelisSDK> {
    const opts = options ?? {};
    const client = new StelisClient({
      endpoint,
      requestTimeouts: opts.requestTimeouts,
    });

    // Health check
    await client.getStatus();

    // Fetch dynamic config from /relay/config.
    const relayConfig = parseRelayConfig(await client.getConfig());

    // S-16: 2-step packageId verification
    const expectedPackageId = STELIS_CONTRACT_IDS[relayConfig.network]?.packageId;

    // Step 1: Verify Host's advertised packageId matches the SDK constant.
    // Catches Hosts advertising a forked/wrong package.
    if (expectedPackageId && relayConfig.packageId) {
      if (normalizeSuiAddress(relayConfig.packageId) !== normalizeSuiAddress(expectedPackageId)) {
        throw new Error(
          `Relay config packageId mismatch: Host advertises ${relayConfig.packageId}, expected ${expectedPackageId}`,
        );
      }
    }

    // Step 2: Verify caller's pin matches the SDK constant.
    // Catches stale pinnedPackageId values.
    if (opts.pinnedPackageId && expectedPackageId) {
      if (normalizeSuiAddress(expectedPackageId) !== normalizeSuiAddress(opts.pinnedPackageId)) {
        throw new Error(
          `pinnedPackageId mismatch: expected ${expectedPackageId}, pinned ${opts.pinnedPackageId}`,
        );
      }
    }

    return new StelisSDK(client, relayConfig);
  }

  // ─────────────────────────────────────────
  // Settlement swap path utilities
  // ─────────────────────────────────────────

  /**
   * Find the settlement swap path for a given settlement token type.
   * @throws if no settlement swap path is found for the given token type.
   */
  getSettlementSwapPathForSettlementToken(
    settlementTokenType: string,
  ): SingleHopSettlementSwapPath {
    const settlementSwapPath = this._relayConfig.supportedSettlementSwapPaths.find(
      (p) => p.settlementTokenType === settlementTokenType,
    );
    if (!settlementSwapPath) {
      const supported = this._relayConfig.supportedSettlementSwapPaths
        .map((p) => p.settlementTokenSymbol)
        .join(', ');
      throw new Error(
        `No settlement swap path found for settlement token ${settlementTokenType}. Supported: ${supported}`,
      );
    }
    return settlementSwapPath;
  }

  /**
   * Read current liquidity for one Host-advertised settlement swap path.
   * The SDK proves the supplied client against the connected Host network and
   * supplies the fixed DeepBook package identity itself.
   */
  async checkSettlementSwapPathLiquidity(
    client: SuiGrpcClient,
    settlementSwapPath: SingleHopSettlementSwapPath,
  ): Promise<SettlementSwapPathLiquidityStatus> {
    const endpoints = await this._suiEndpoints(client);
    return readSettlementSwapPathLiquidity(endpoints, this._deepbookPackageId, settlementSwapPath);
  }

  /**
   * Query exchange rate for a settlement token.
   *
   * DeepBook mid_price is scaled by 1e9 and represents
   * quote_smallest_units / base_smallest_units. To get human-readable price:
   *   price_human = mid_price * base_scalar / (1e9 * quote_scalar)
   *
   * For DEEP(6dec)/SUI(9dec) pool:
   *   price = mid_price * 1e6 / (1e9 * 1e9) = mid_price / 1e12
   */
  async getExchangeRate(
    client: SuiGrpcClient,
    settlementTokenType: string,
  ): Promise<{
    rate: number | null;
    rateRaw: bigint | null;
    hasLiquidity: boolean;
    rateDisplay: string;
    hopMidPrices: bigint[];
  }> {
    const endpoints = await this._suiEndpoints(client);
    const settlementSwapPath = this.getSettlementSwapPathForSettlementToken(settlementTokenType);

    // Query all hop mid-prices in a single batch
    const hopPrices = await batchGetHopMidPrices(
      endpoints,
      this.deepbookPackageId,
      settlementSwapPath.hops,
    );
    const hasLiquidity = hopPrices.length > 0 && hopPrices.every((p) => p > 0n);

    if (!hasLiquidity) {
      return {
        rate: null,
        rateRaw: null,
        hasLiquidity: false,
        rateDisplay: 'unavailable',
        hopMidPrices: hopPrices,
      };
    }

    // Compose path-wide ideal output: direction-aware per-hop composition.
    // Each hop converts input → output based on its swapDirection:
    //   baseForQuote: output = input × midPrice / 1e9
    //   quoteForBase: output = input × 1e9 / midPrice
    // We chain using a reference input of 1e18 (high precision bigint).
    const composedMidPriceRaw = composeSettlementTokenToSuiMidPrice(settlementSwapPath, hopPrices);
    const rate = bigintToSafeNumberOrNull(composedMidPriceRaw);
    const numerator =
      composedMidPriceRaw * 10n ** BigInt(settlementSwapPath.settlementTokenDecimals);
    const denominator = DEEPBOOK_MID_PRICE_SCALING * 10n ** BigInt(SUI_DECIMALS);
    const suiPerTokenHuman = formatRatioDecimal(numerator, denominator, 4);
    const rateDisplay = `1 ${settlementSwapPath.settlementTokenSymbol} ≈ ${suiPerTokenHuman} SUI`;
    return {
      rate,
      rateRaw: composedMidPriceRaw,
      hasLiquidity: true,
      rateDisplay,
      hopMidPrices: hopPrices,
    };
  }

  /**
   * Estimate gas cost for a sponsored transaction before signing.
   *
   * **Non-authoritative UX hint.** This estimate does not include the settle TX
   * that `/prepare` appends. Server `/prepare` dry-runs the full TX and is authoritative.
   *
   * Uses `computeExecutionCostClaim` from `@stelis/core-relay` for consistency with
   * the server-side calculation, plus on-chain fees from `/relay/config`.
   *
   * Profile logic (UX classification — not authoritative eligibility check):
   * - No vault → `new_user` → display in settlement token (e.g. DEEP)
   * - Vault + credit ≥ totalCost → `credit_general` → display in SUI
   * - Vault + credit < totalCost → `with_vault` → display in settlement token
   *
   * @example
   * ```ts
   * const est = await sdk.estimateGas(suiClient, {
   *   addr: userAddress,
   *   settlementToken: { type: DEEPBOOK_IDS['testnet']!.deepType },
   * });
   * console.log(`~${est.amountHuman} ${est.displayUnit} (~${est.suiAmountHuman} SUI)`);
   * ```
   */
  async estimateGas(
    client: SuiGrpcClient,
    opts: {
      addr: string;
      settlementToken: { type: string };
      intentGasBudget?: number;
      gasMarginBps?: number;
    },
  ): Promise<GasEstimateResult> {
    const endpoints = await this._suiEndpoints(client);
    const intentGasBudget = opts.intentGasBudget ?? DEFAULT_ESTIMATE_GAS_INTENT_BUDGET_MIST;
    const gasMarginBps = opts.gasMarginBps ?? DEFAULT_GAS_MARGIN_BPS;

    // 1. Compute gas costs using the browser-safe core-relay subset.
    const costs = computeExecutionCostClaim({
      computationCost: intentGasBudget.toString(),
      storageCost: '0',
      storageRebate: '0',
    });

    // 2. Add fees from /relay/config (strict required fields)
    const quotedHostFee = parseDecimalBigInt(
      this._relayConfig.quotedHostFeeMist,
      'quotedHostFeeMist',
    );
    const protocolFee = parseDecimalBigInt(
      this._relayConfig.protocolFlatFeeMist,
      'protocolFlatFeeMist',
    );
    const totalCostMist = costs.executionCostClaim + quotedHostFee + protocolFee;
    const suiAmountHuman = formatSmallestUnitDecimal(totalCostMist, SUI_DECIMALS, 4);

    if (!opts.settlementToken) {
      throw new Error('[StelisSDK] settlementToken is required.');
    }

    const settlementSwapPath = this.getSettlementSwapPathForSettlementToken(
      opts.settlementToken.type,
    );

    // 3. Vault/credit check for profile determination
    const credit = await queryUserCreditThroughGateway(
      endpoints,
      this._packageId,
      this._vaultRegistryId,
      opts.addr,
    );
    const hasVault = !!(credit.vaultObjectId && !credit.needsCreate);
    const vaultCredit = parseDecimalBigInt(credit.credit, 'vault credit');
    const profile = !hasVault
      ? ('new_user' as const)
      : vaultCredit >= totalCostMist
        ? ('credit_general' as const)
        : ('with_vault' as const);

    // 4. Exchange rate for settlement token display
    const rateResult = await this.getExchangeRate(client, opts.settlementToken.type);
    const hasLiquidity = rateResult.hasLiquidity && !!rateResult.rate;

    // canSkipLiquidity: credit_general only.
    const canSkipLiquidity = profile === 'credit_general';

    if (profile === 'credit_general') {
      // SUI display — vault credit covers everything
      return {
        displayUnit: 'SUI',
        amountHuman: suiAmountHuman,
        suiAmountHuman,
        profile,
        hasLiquidity,
        canSkipLiquidity,
      };
    }

    // Settlement token display (DEEP etc.)
    if (!hasLiquidity || !rateResult.rate) {
      return {
        displayUnit: settlementSwapPath.settlementTokenSymbol,
        amountHuman: '0',
        suiAmountHuman,
        profile,
        hasLiquidity: false,
        canSkipLiquidity: false,
      };
    }

    const midPrice = composeSettlementTokenToSuiMidPrice(
      settlementSwapPath,
      rateResult.hopMidPrices,
    );
    if (midPrice <= 0n) {
      return {
        displayUnit: settlementSwapPath.settlementTokenSymbol,
        amountHuman: '0',
        suiAmountHuman,
        profile,
        hasLiquidity: false,
        canSkipLiquidity: false,
      };
    }
    const marginNumerator = BigInt(10_000 + gasMarginBps);

    // composedMidPrice is settlementToken→SUI; reverse estimate in smallest units.
    // DeepBook executable min/lot policy is enforced server-side by /prepare;
    // this SDK path remains a non-authoritative UX preview.
    const amountSmallest =
      (totalCostMist * DEEPBOOK_MID_PRICE_SCALING * marginNumerator + (midPrice * 10_000n - 1n)) /
      (midPrice * 10_000n);

    const scale = 10n ** BigInt(settlementSwapPath.settlementTokenDecimals);
    const whole = amountSmallest / scale;
    const frac = (amountSmallest % scale)
      .toString()
      .padStart(settlementSwapPath.settlementTokenDecimals, '0');
    const amountHuman = `${whole.toString()}.${frac}`;

    return {
      displayUnit: settlementSwapPath.settlementTokenSymbol,
      amountHuman,
      suiAmountHuman,
      profile,
      hasLiquidity: true,
      canSkipLiquidity: false,
    };
  }

  // ─────────────────────────────────────────
  // prepareSponsored — build PTB, stop before signing
  // ─────────────────────────────────────────

  /**
   * Build a sponsored Transaction up to the point of user signing.
   * Sends txKindBytes to /prepare, which handles all PTB assembly
   * (coin selection, swap, settle) server-side.
   *
   * Performs S-16b client-side integrity verification and cost cross-validation.
   *
   * Returns txBytes (ready for user signing), receiptId, cost breakdown,
   * policyHash, and profile.
   *
   * Used internally by executeSponsored and executeSuiFirst.
   * Also available for advanced 2-step flows (prepare → sign → sponsor)
   * where direct sponsor API access is needed (e.g. studio debug tooling).
   *
   * ⚠️ WARNING: Do NOT modify the returned txBytes. The PTB already includes
   * swap + settle commands. Any modification breaks receiptId binding.
   */
  async prepareSponsored(
    tx: Transaction,
    opts: PrepareSponsoredOptions,
  ): Promise<PrepareSponsoredResult> {
    const endpoints = await this._suiEndpoints(opts.client);
    this.getSettlementSwapPathForSettlementToken(opts.settlementToken.type);

    // Build TransactionKind bytes from user commands
    tx.setSender(opts.addr);
    const kindBytes = await buildSuiTransaction(endpoints, {
      transaction: tx,
      onlyTransactionKind: true,
    });
    const txKindBytes = toBase64(kindBytes);
    const userTx = Transaction.fromKind(kindBytes);
    const userCommandValidation = validateGenericUserTransactionKind(
      userTx,
      {
        network: this._relayConfig.network,
        settlementPayoutRecipientAddress: this._relayConfig.settlementPayoutRecipient,
        configId: this._configId,
        vaultRegistryId: this._vaultRegistryId,
        packageId: this._packageId,
      },
      opts.settlementToken.type,
    );
    if (!userCommandValidation.ok) {
      throw new StelisSponsoredError(userCommandValidation.code, userCommandValidation.message);
    }
    const txKindBytesHash = bytesToHex(await sha256Bytes(kindBytes));
    const prepareAuthorizationTimestampMs = Date.now();
    const prepareAuthorizationRequestNonce = generatePrepareRequestNonce();
    const optionalPrepareFields = createOptionalPrepareFields(opts);
    const prepareAuthorizationFields = {
      network: this._relayConfig.network,
      packageId: this._packageId,
      senderAddress: opts.addr,
      txKindBytesHash,
      settlementTokenType: opts.settlementToken.type,
      ...optionalPrepareFields,
      timestampMs: prepareAuthorizationTimestampMs,
      requestNonce: prepareAuthorizationRequestNonce,
    } as const;
    const prepareAuthorizationSignature = await opts.prepareAuthorizationSigner(
      encodePrepareAuthorizationMessage(prepareAuthorizationFields),
    );

    // Call /prepare — Host handles settle build, dry-run, slot checkout
    const prepareRes = await this._client.prepare({
      txKindBytes,
      senderAddress: opts.addr,
      settlementTokenType: opts.settlementToken.type,
      ...optionalPrepareFields,
      txKindBytesHash,
      prepareAuthorizationTimestampMs,
      prepareAuthorizationRequestNonce,
      prepareAuthorizationSignature,
    });

    // S-16: Client-side defense-in-depth — verify Host preserved user commands
    this._verifyIntegrity(kindBytes, prepareRes.txBytes, opts);

    // S-16 companion: fail-closed settle field validation against prepare response.
    let settleFields: ReturnType<typeof extractSettleTransactionFieldsFromTxBytes>;
    try {
      settleFields = extractSettleTransactionFieldsFromTxBytes(prepareRes.txBytes, this._packageId);
    } catch (err) {
      throw new StelisSponsoredError(
        'SETTLE_TX_PARSE_FAILED',
        err instanceof Error ? err.message : 'Unable to parse settle fields from txBytes',
      );
    }
    const orderIdHash = opts.orderId
      ? await sha256Bytes(new TextEncoder().encode(opts.orderId))
      : new Uint8Array(0);
    const settleFieldValidation = validateSettleTransactionFields(settleFields, {
      executionCostClaimMist: parseDecimalBigInt(
        prepareRes.cost.executionCostClaim,
        'executionCostClaim',
      ),
      quotedHostFeeMist: parseDecimalBigInt(prepareRes.cost.quotedHostFee, 'quotedHostFee'),
      expectedProtocolFeeMist: parseDecimalBigInt(prepareRes.cost.protocolFee, 'protocolFee'),
      policyHash: hexToBytes(prepareRes.policyHash, 'policyHash'),
      orderIdHash,
    });
    if (!settleFieldValidation.ok) {
      throw new StelisSponsoredError(settleFieldValidation.code, settleFieldValidation.message);
    }

    // Notify gas estimate callback — totalCost in MIST + 'SUI'
    const totalCost =
      parseDecimalBigInt(prepareRes.cost.executionCostClaim, 'executionCostClaim') +
      parseDecimalBigInt(prepareRes.cost.quotedHostFee, 'quotedHostFee') +
      parseDecimalBigInt(prepareRes.cost.protocolFee, 'protocolFee');
    const totalCostSui = formatSmallestUnitDecimal(totalCost, SUI_DECIMALS, 9);
    opts.onGasEstimate?.(totalCost, totalCostSui, 'SUI');

    return {
      txBytes: prepareRes.txBytes,
      receiptId: prepareRes.receiptId,
      cost: prepareRes.cost,
      profile: prepareRes.profile,
      totalCostMist: totalCost,
      totalCostSui,
      orderId: prepareRes.orderId,
      policyHash: prepareRes.policyHash,
    };
  }

  // ─────────────────────────────────────────
  // executeSponsored — one-line sponsored execution with error normalization
  // ─────────────────────────────────────────

  /**
   * Execute any Transaction through the sponsored Relay API flow with automatic error normalization.
   *
   * Orchestrates: prepare → sign → sponsor → submit.
   * Server API errors are translated into user-friendly
   * `StelisSponsoredError` codes:
   *
   * - `INSUFFICIENT_FUNDS` — insufficient balance or settle input too low.
   * - `PAYMENT_COIN_CONFLICT` — settlement-token payment could not be resolved safely.
   * - `PAYMENT_COIN_LIMIT_EXCEEDED` — consolidate settlement-token Coin objects and retry.
   * - `TRANSACTION_FAILED` — dry-run simulation failure.
   * - `EXECUTION_FAILED` — sponsor preflight / on-chain revert.
   *
   * @example
   * ```ts
   * const suiClient = new SuiGrpcClient({
   *   network: 'testnet',
   *   baseUrl: 'https://fullnode.testnet.sui.io:443',
   * });
   * const sdk = await StelisSDK.connect(endpoint);
   * try {
   *   const result = await sdk.executeSponsored(tx, {
   *     client: suiClient,
   *     prepareAuthorizationSigner: async (messageBytes) => {
   *       const { signature } = await wallet.signPersonalMessage({ message: messageBytes });
   *       return signature;
   *     },
   *     signer: wallet.signTransaction,
   *     addr: userAddress,
   *     settlementToken: { type: DEEP },
   *   });
   * } catch (err) {
   *   if (err instanceof StelisSponsoredError) {
   *     if (err.code === 'INSUFFICIENT_FUNDS') showToast(err.message);
   *   }
   * }
   * ```
   */
  async executeSponsored(
    tx: Transaction,
    opts: ExecuteSponsoredOptions,
  ): Promise<ExecuteSponsoredResult> {
    try {
      // ── Step 1: Prepare (Host builds full TX with settle) ──
      const prepared = await this.prepareSponsored(tx, opts);

      // ── Step 2: User sign ────────────────────────────────────
      const userSignature = await opts.signer(prepared.txBytes);

      // ── Step 3: Sponsor (Host verifies, adds sponsor signature, submits) ──
      const sponsorRes = await this._client.sponsor({
        txBytes: prepared.txBytes,
        userSignature,
        receiptId: prepared.receiptId,
      });

      return {
        digest: sponsorRes.digest,
        effects: sponsorRes.effects,
        cost: prepared.cost,
        totalCostMist: prepared.totalCostMist,
        totalCostSui: prepared.totalCostSui,
        orderId: sponsorRes.orderId,
      };
    } catch (err) {
      if (!(err instanceof StelisApiException)) throw err;
      throw normalizeApiError(err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // executeSuiFirst
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a transaction using the user's own SUI if balance is sufficient,
   * otherwise fall back to executeSponsored (Stelis Host-sponsored path).
   *
   * Flow:
   *   1. assertNoGasPreset(tx) — UX guard, throws if gas fields are preset
   *   2. getBalance → current SUI balance
   *   3. simulateTransaction → dry-run gasBudget (with margin, no gas consumed)
   *   4a. SUI >= gasBudget → sign + executeTransaction directly
   *   4b. SUI <  gasBudget → executeSponsored fallback
   *
   * Infra failures (network/timeout/grpc) on steps 2-3 trigger best-effort
   * sponsored fallback. Note: fallback may also fail if the same client node is down.
   *
   * @param tx  Transaction to execute. Must not have gas fields preset.
   * @param opts Same options as executeSponsored.
   */
  async executeSuiFirst(
    tx: Transaction,
    opts: ExecuteSponsoredOptions,
  ): Promise<ExecuteSuiFirstResult> {
    // ── UX Guard ──────────────────────────────────────────────────────────
    assertNoGasPreset(tx);
    const endpoints = await this._suiEndpoints(opts.client);

    // ── Step 1: SUI balance (infra failure → best-effort sponsored) ─────────
    let suiBalance: bigint;
    try {
      const balRes = await getSuiBalance(endpoints, {
        owner: opts.addr,
        coinType: '0x2::sui::SUI',
      });
      suiBalance = parseDecimalBigInt(balRes.balance, 'SUI balance');
    } catch (err) {
      if (isSuiInfrastructureFailure(err)) {
        // best-effort: executeSponsored shares the same opts.client — may also fail
        const r = await this.executeSponsored(tx, opts);
        return { path: 'sponsored', digest: r.digest, effects: r.effects, orderId: r.orderId };
      }
      throw err;
    }

    // ── Step 2: dry-run gasBudget (RPC only in try; deterministic failures outside) ──
    tx.setSender(opts.addr);
    let sim: Awaited<ReturnType<typeof simulateSuiTransaction>>;
    let simBytes: Uint8Array;
    try {
      simBytes = await buildSuiTransaction(endpoints, { transaction: tx });
      sim = await simulateSuiTransaction(endpoints, {
        transaction: simBytes,
      });
    } catch (err) {
      if (isSuiInfrastructureFailure(err)) {
        const r = await this.executeSponsored(tx, opts);
        return { path: 'sponsored', digest: r.digest, effects: r.effects, orderId: r.orderId };
      }
      throw err;
    }
    // Deterministic failures — outside catch so message strings can't be misclassified.
    if (sim.outcome === 'failure') {
      throw new Error(`[StelisSDK] Simulation failed: ${suiExecutionErrorMessage(sim.error)}`);
    }
    const { grossGas } = computeExecutionCostClaim(sim.effects.gasUsed);
    const gasBudget = (grossGas * BigInt(10000 + DEFAULT_GAS_MARGIN_BPS)) / 10000n;

    // ── Step 3a: SUI sufficient — execute directly ────────────────────────
    if (suiBalance >= gasBudget) {
      const directTx = Transaction.from(tx); // clone — do not mutate original
      directTx.setGasBudget(gasBudget);
      const builtBytes = await buildSuiTransaction(endpoints, { transaction: directTx });
      const expectedDigest = TransactionDataBuilder.getDigestFromBytes(builtBytes);
      const signature = await opts.signer(toBase64(builtBytes));
      const res = await executeSuiTransaction(endpoints, {
        transaction: builtBytes, // Uint8Array
        expectedDigest,
        signatures: [signature],
      });
      if (res.outcome === 'failure') {
        throw new Error(`[StelisSDK] Transaction failed: ${suiExecutionErrorMessage(res.error)}`);
      }
      return {
        path: 'sui',
        digest: res.digest,
        effects: res.effects,
      };
    }

    // ── Step 3b: SUI insufficient — sponsored fallback ──────────────────────
    const r = await this.executeSponsored(tx, opts);
    return { path: 'sponsored', digest: r.digest, effects: r.effects, orderId: r.orderId };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Promotion-specific sponsored execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Prepare a promotion-sponsored transaction (low-level).
   *
   * Sends txKindBytes to POST /studio/promotions/:id/prepare.
   * The server handles sponsor key selection, dry-run, budget reservation.
   *
   * Unlike prepareSponsored(), this does NOT include:
   * - settlement token or settlement swap path selection (promotion budget covers gas)
   * - Settle-specific S-16 suffix verification (no settle TX)
   * - Cost cross-validation (simple estimatedGasMist)
   * - Preflight coin checks
   *
   * Defense-in-depth: verifies that server-returned txBytes preserve user
   * commands exactly (promotion integrity check). Throws StelisIntegrityError
   * if the server modified user commands at prepare time.
   *
   * @returns txBytes (user-signable), receiptId, estimatedGasMist
   */
  async preparePromotionSponsored(
    tx: Transaction,
    opts: {
      client: ExecutePromotionSponsoredOptions['client'];
      promotionId: string;
      addr: string;
      developerJwt: string;
    },
  ): Promise<PromotionPrepareResponse> {
    const endpoints = await this._suiEndpoints(opts.client);

    // Build TransactionKind bytes
    tx.setSender(opts.addr);
    const kindBytes = await buildSuiTransaction(endpoints, {
      transaction: tx,
      onlyTransactionKind: true,
    });
    const txKindBytes = toBase64(kindBytes);

    const result = await this._client.promotionPrepare(
      opts.promotionId,
      { senderAddress: opts.addr, txKindBytes },
      opts.developerJwt,
    );

    // Defense-in-depth: verify server did not modify user commands.
    // Server may only add gas metadata (sender, gasOwner, gasBudget).
    verifyPromotionPtbIntegrity(kindBytes, result.txBytes);

    return result;
  }

  /**
   * Submit a signed promotion-sponsored transaction (low-level).
   *
   * Sends the signed txBytes + receiptId to POST /studio/promotions/:id/sponsor.
   * The server re-verifies developer JWT, consumes the reservation, adds the sponsor signature, and submits.
   *
   * @returns digest, effects, actualGasMist
   */
  async sponsorPromotionSponsored(opts: {
    promotionId: string;
    receiptId: string;
    txBytes: string;
    userSignature: string;
    developerJwt: string;
  }): Promise<PromotionSponsorResponse> {
    return this._client.promotionSponsor(
      opts.promotionId,
      {
        receiptId: opts.receiptId,
        txBytes: opts.txBytes,
        userSignature: opts.userSignature,
      },
      opts.developerJwt,
    );
  }

  /**
   * Execute a promotion-sponsored transaction (single-call).
   *
   * Orchestrates: prepare → sign → sponsor.
   * Uses promotion-specific endpoints (not generic relay).
   *
   * @example
   * ```ts
   * const suiClient = new SuiGrpcClient({
   *   network: 'testnet',
   *   baseUrl: 'https://fullnode.testnet.sui.io:443',
   * });
   * const sdk = await StelisSDK.connect(endpoint);
   * // Use a Promotion ID returned by the Host's promotion list.
   * const result = await sdk.executePromotionSponsored(tx, {
   *   client: suiClient,
   *   promotionId,
   *   signer: wallet.signTransaction,
   *   addr: userAddress,
   *   developerJwt: token,
   * });
   * console.log(result.digest, result.actualGasMist);
   * ```
   */
  async executePromotionSponsored(
    tx: Transaction,
    opts: ExecutePromotionSponsoredOptions,
  ): Promise<ExecutePromotionSponsoredResult> {
    // Step 1: Prepare
    const prepared = await this.preparePromotionSponsored(tx, opts);

    // Step 2: User sign
    const userSignature = await opts.signer(prepared.txBytes);

    // Step 3: Sponsor
    const sponsored = await this.sponsorPromotionSponsored({
      promotionId: opts.promotionId,
      receiptId: prepared.receiptId,
      txBytes: prepared.txBytes,
      userSignature,
      developerJwt: opts.developerJwt,
    });

    return {
      digest: sponsored.digest,
      effects: sponsored.effects,
      txBytes: prepared.txBytes,
      receiptId: prepared.receiptId,
      estimatedGasMist: prepared.estimatedGasMist,
      actualGasMist: sponsored.actualGasMist,
    };
  }

  // ─────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────

  /** Build withdraw PTB — for advanced users needing vault withdrawal. */
  buildWithdrawPtb(tx: Transaction, params: WithdrawParams): void {
    buildWithdrawPtb(tx, {
      packageId: this.config.packageId,
      vaultId: params.vaultId,
      recipientAddress: params.recipientAddress,
    });
  }

  // ─────────────────────────────────────────────
  // S-16: Integrity verification
  // ─────────────────────────────────────────────

  /** Verify that the Host preserved the user-authored PTB prefix. */
  private _verifyIntegrity(
    kindBytes: Uint8Array,
    txBytesBase64: string,
    _opts: PrepareSponsoredOptions,
  ): void {
    verifyPtbIntegrity(kindBytes, txBytesBase64, this._packageId);
  }
}
