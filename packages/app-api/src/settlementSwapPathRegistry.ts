/**
 * [app-api] Settlement swap path registry.
 *
 * Parses `packages/app-api/settlement-swap-paths.json`,
 * resolves full SingleHopSettlementSwapPath from on-chain data at boot time,
 * and validates integrity before the server starts.
 *
 * Constraints:
 *   - 1 active settlement swap path per settlementTokenType
 *   - Boot-time validation (fail-closed: missing file, empty registry,
 *     bad pool ID, duplicate token, nested path-array shape)
 *   - All fields except poolId are derived from on-chain data
 *     (Pool type params, pool_book_params, pool_trade_params, whitelisted, CoinMetadata,
 *      DeepBook fee scaling constants)
 *
 * File format (`settlement-swap-paths.json`):
 *   {
 *     "testnet": ["0xPoolA", "0xPoolB"],
 *     "mainnet": ["0xPoolC"]
 *   }
 *   - each network section contains DeepBook pool IDs
 *   - each pool ID resolves to exactly one supported 1-hop settlement swap path
 *
 * Shared references:
 *   - SingleHopSettlementSwapPath, DeepBookPoolHop: @stelis/contracts
 *   - Pool view functions: deepbook::pool (pool_book_params, pool_trade_params, whitelisted)
 *   - CoinMetadata: core-relay current Sui operation gateway
 */
import { Transaction } from '@mysten/sui/transactions';
import {
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from '@mysten/sui/utils';
import type { SingleHopSettlementSwapPath, DeepBookPoolHop, SuiNetwork } from '@stelis/contracts';
import {
  DEEPBOOK_RUNTIME_PACKAGE_ID,
  SUI_TYPE,
  settlementSwapDirectionFromSwapDirections,
} from '@stelis/contracts';
import {
  decodeExactU64Bytes,
  getSuiCoinMetadata,
  getSuiObject,
  simulateSuiMoveView,
  suiExecutionErrorMessage,
  type SuiCommandResult,
  type SuiEndpointSnapshot,
  type SuiMoveViewResult,
} from '@stelis/core-relay';

const CONFIG_NETWORKS: readonly SuiNetwork[] = ['testnet', 'mainnet'];

/** Host settlement swap path file used by runtime policy. */
export function getSettlementSwapPathRegistryPath(): string {
  return new URL('../settlement-swap-paths.json', import.meta.url).pathname;
}

// ─────────────────────────────────────────────
// Registry parsing
// ─────────────────────────────────────────────

/** Parsed entry from the settlement swap path registry. */
export interface ParsedSettlementSwapPathRegistryEntry {
  /** DeepBook pool ID for a single supported settlement swap path. */
  readonly poolId: string;
}

/**
 * Parse settlement swap path registry JSON into registry entries.
 *
 * Format: network-keyed object. The selected network section contains pool IDs.
 *   { "testnet": ["0xPoolA"], "mainnet": ["0xPoolB"] }
 *   -> one 1-hop settlement swap path on testnet
 *
 * @param json - Parsed JSON value
 * @param network - Active app-api NETWORK value
 * @throws Error on invalid structure, empty registry, or bad pool ID
 */
export function parseSettlementSwapPathRegistryJson(
  json: unknown,
  network: SuiNetwork,
): ParsedSettlementSwapPathRegistryEntry[] {
  const poolIds = selectNetworkPoolIdSection(json, network);

  const entries: ParsedSettlementSwapPathRegistryEntry[] = [];

  for (let i = 0; i < poolIds.length; i++) {
    const poolId = poolIds[i];
    if (Array.isArray(poolId)) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] Entry [${i}] must be a pool ID string, not a path array. ` +
          'settlement-swap-paths.json expects each network section to be a flat array of DeepBook pool IDs.',
      );
    }
    if (typeof poolId !== 'string' || !isValidSuiAddress(poolId)) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] Entry [${i}]: invalid pool ID "${String(poolId)}".`,
      );
    }
    entries.push({ poolId: normalizeSuiAddress(poolId) });
  }

  return entries;
}

function selectNetworkPoolIdSection(json: unknown, network: SuiNetwork): unknown[] {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(
      '[SETTLEMENT_SWAP_PATHS_JSON] JSON must be an object with "testnet" and "mainnet" pool ID arrays.',
    );
  }

  const registry = json as Record<string, unknown>;
  for (const key of Object.keys(registry)) {
    if (!CONFIG_NETWORKS.includes(key as SuiNetwork)) {
      throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] Unsupported network section "${key}".`);
    }
  }

  for (const key of CONFIG_NETWORKS) {
    if (!Array.isArray(registry[key])) {
      throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] ${key} must be an array of pool IDs.`);
    }
  }

  const selected = registry[network] as unknown[];
  if (selected.length === 0) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] ${network} registry is empty. At least one pool ID is required.`,
    );
  }
  return selected;
}

// ─────────────────────────────────────────────
// On-chain derivation
// ─────────────────────────────────────────────

function requireExactViewReturnValues(
  result: SuiMoveViewResult,
  viewFn: string,
  returnCount: number,
): SuiCommandResult['returnValues'] {
  if (result.outcome === 'failure') {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook ${viewFn} failed: ${suiExecutionErrorMessage(result.error)}`,
    );
  }
  if (result.commandResults.length !== 1) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook ${viewFn} returned ${result.commandResults.length} command results (expected 1)`,
    );
  }
  const command = result.commandResults[0]!;
  if (command.returnValues.length !== returnCount) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook ${viewFn} returned ${command.returnValues.length} values (expected ${returnCount})`,
    );
  }
  if (command.mutatedReferences.length !== 0) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook ${viewFn} unexpectedly returned mutated references`,
    );
  }
  return command.returnValues;
}

/**
 * Simulate a single-argument DeepBook pool view call.
 *
 * Returns the exact single command's return values after validating the fixed ABI.
 *
 * The current Move-view gateway owns zero-sender, gasless request construction.
 *
 * @throws via simulateTransaction on RPC failure
 */
async function runPoolViewCall(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  viewFn: string,
  returnCount: number,
  signal?: AbortSignal,
): Promise<SuiCommandResult['returnValues']> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::${viewFn}`,
    typeArguments: [baseType, quoteType],
    arguments: [tx.object(poolId)],
  });
  const result = await simulateSuiMoveView(snapshot, {
    transaction: tx,
    signal,
  });
  return requireExactViewReturnValues(result, viewFn, returnCount);
}

/**
 * Simulate a no-argument DeepBook constants view call.
 *
 * DeepBook fee-rate metadata depends on constants owned by the deployed
 * DeepBook package, so app-api reads them at boot instead of hardcoding them.
 */
async function runConstantsViewCall(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  viewFn: string,
  returnCount: number,
  signal?: AbortSignal,
): Promise<SuiCommandResult['returnValues']> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::constants::${viewFn}`,
    arguments: [],
  });
  const result = await simulateSuiMoveView(snapshot, {
    transaction: tx,
    signal,
  });
  return requireExactViewReturnValues(result, viewFn, returnCount);
}

/** Result of reading a Pool object's type parameters. */
interface PoolTypeInfo {
  baseType: string;
  quoteType: string;
}

/** Result of calling pool_book_params view function. */
interface PoolBookParams {
  tickSize: bigint;
  lotSize: bigint;
  minSize: bigint;
}

/** Result of calling pool_trade_params view function. */
interface PoolTradeParams {
  takerFee: bigint;
  makerFee: bigint;
  stakeRequired: bigint;
}

interface DeepbookFeeParameters {
  feeScaling: bigint;
  inputFeePenaltyMultiplier: bigint;
}

function scaledFeeRateToBpsCeil(rate: bigint, feeScaling: bigint): number {
  if (feeScaling <= 0n) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook fee scaling must be positive, got ${feeScaling}`,
    );
  }
  if (rate <= 0n) return 0;
  const bps = (rate * 10000n + feeScaling - 1n) / feeScaling;
  const value = Number(bps);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] Fee rate exceeds safe integer range: ${bps} bps`);
  }
  if (value > 10_000) {
    throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] Fee rate exceeds 100%: ${bps} bps`);
  }
  return value;
}

function inputFeeRateBpsFromDeepbookTakerFee(
  takerFee: bigint,
  feeParams: DeepbookFeeParameters,
): number {
  const inputFeeRate = (takerFee * feeParams.inputFeePenaltyMultiplier) / feeParams.feeScaling;
  return scaledFeeRateToBpsCeil(inputFeeRate, feeParams.feeScaling);
}

async function queryDeepbookConstantU64(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  viewFn: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const rv = await runConstantsViewCall(snapshot, deepbookPackageId, viewFn, 1, signal);
  return decodeExactU64Bytes(rv[0].bcs);
}

async function queryDeepbookFeeParameters(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  signal?: AbortSignal,
): Promise<DeepbookFeeParameters> {
  const [feeScaling, inputFeePenaltyMultiplier] = await Promise.all([
    queryDeepbookConstantU64(snapshot, deepbookPackageId, 'float_scaling', signal),
    queryDeepbookConstantU64(snapshot, deepbookPackageId, 'fee_penalty_multiplier', signal),
  ]);

  if (feeScaling <= 0n) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook constants::float_scaling() must be positive`,
    );
  }
  if (inputFeePenaltyMultiplier <= 0n) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook constants::fee_penalty_multiplier() must be positive`,
    );
  }

  return { feeScaling, inputFeePenaltyMultiplier };
}

/**
 * Read Pool object type parameters from getObject().
 *
 * Parses the Move type string: `0x...::pool::Pool<BaseType, QuoteType>`
 * to extract BaseType and QuoteType.
 *
 * @throws Error if pool object is not found or type string cannot be parsed
 */
async function getPoolTypeInfo(
  snapshot: SuiEndpointSnapshot,
  deepbookRuntimePackageId: string,
  poolId: string,
  signal?: AbortSignal,
): Promise<PoolTypeInfo> {
  const pool = await getSuiObject(snapshot, { objectId: poolId, signal });
  const typeStr = pool.type;
  let poolType: ReturnType<typeof parseStructTag>;
  try {
    poolType = parseStructTag(typeStr);
  } catch {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: cannot parse type params from "${typeStr}"`,
    );
  }

  if (
    !isValidSuiAddress(deepbookRuntimePackageId) ||
    normalizeSuiAddress(poolType.address) !== normalizeSuiAddress(deepbookRuntimePackageId) ||
    poolType.module !== 'pool' ||
    poolType.name !== 'Pool' ||
    poolType.typeParams.length !== 2 ||
    typeof poolType.typeParams[0] === 'string' ||
    typeof poolType.typeParams[1] === 'string'
  ) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: object is not the current DeepBook Pool type`,
    );
  }

  return {
    baseType: normalizeStructTag(poolType.typeParams[0]),
    quoteType: normalizeStructTag(poolType.typeParams[1]),
  };
}

/**
 * Query pool_book_params via simulateTransaction.
 *
 * pool_book_params returns (tick_size: u64, lot_size: u64, min_size: u64).
 *
 * @throws Error on RPC failure or unexpected response shape
 */
async function queryPoolBookParams(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  signal?: AbortSignal,
): Promise<PoolBookParams> {
  const rv = await runPoolViewCall(
    snapshot,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'pool_book_params',
    3,
    signal,
  );
  return {
    tickSize: decodeExactU64Bytes(rv[0].bcs),
    lotSize: decodeExactU64Bytes(rv[1].bcs),
    minSize: decodeExactU64Bytes(rv[2].bcs),
  };
}

/**
 * Query pool_trade_params via simulateTransaction.
 *
 * pool_trade_params returns (taker_fee: u64, maker_fee: u64, stake_required: u64).
 *
 * @throws Error on RPC failure or unexpected response shape
 */
async function queryPoolTradeParams(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  signal?: AbortSignal,
): Promise<PoolTradeParams> {
  const rv = await runPoolViewCall(
    snapshot,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'pool_trade_params',
    3,
    signal,
  );
  return {
    takerFee: decodeExactU64Bytes(rv[0].bcs),
    makerFee: decodeExactU64Bytes(rv[1].bcs),
    stakeRequired: decodeExactU64Bytes(rv[2].bcs),
  };
}

/**
 * Query whitelisted status via simulateTransaction.
 *
 * whitelisted() returns bool.
 *
 * @throws Error on RPC failure or unexpected response shape
 */
async function queryPoolWhitelisted(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const rv = await runPoolViewCall(
    snapshot,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'whitelisted',
    1,
    signal,
  );
  return decodeBcsBool(rv[0].bcs);
}

/**
 * Query CoinMetadata for symbol and decimals.
 *
 * @throws Error if CoinMetadata is not found
 */
async function queryCoinMetadata(
  snapshot: SuiEndpointSnapshot,
  coinType: string,
  signal?: AbortSignal,
): Promise<{ symbol: string; decimals: number }> {
  const meta = await getSuiCoinMetadata(snapshot, { coinType, signal });

  if (typeof meta.symbol !== 'string' || meta.symbol.length === 0) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] CoinMetadata for ${coinType}: symbol is missing or empty`,
    );
  }
  if (typeof meta.decimals !== 'number' || !Number.isInteger(meta.decimals) || meta.decimals < 0) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] CoinMetadata for ${coinType}: decimals is invalid (${String(meta.decimals)})`,
    );
  }

  return { symbol: meta.symbol, decimals: meta.decimals };
}

/**
 * Determine the settlement token and swap direction from one pool's type parameters.
 *
 * 1-hop baseForQuote: Pool<Token, SUI> → swap_exact_base_for_quote → settlementToken = Token
 * 1-hop quoteForBase: Pool<SUI, Token> → swap_exact_quote_for_base → settlementToken = Token
 *
 * @throws Error if pool type params do not match any supported 1-hop settlement swap path
 */
export function determineSettlementToken(pool: { baseType: string; quoteType: string }): {
  settlementTokenType: string;
  swapDirection: 'baseForQuote' | 'quoteForBase';
} {
  // Pool<Token, SUI> → baseForQuote
  if (pool.quoteType === SUI_TYPE) {
    return { settlementTokenType: pool.baseType, swapDirection: 'baseForQuote' };
  }
  // Pool<SUI, Token> → quoteForBase, settlementToken = Token (quote)
  if (pool.baseType === SUI_TYPE) {
    return { settlementTokenType: pool.quoteType, swapDirection: 'quoteForBase' };
  }
  throw new Error(
    `[SETTLEMENT_SWAP_PATHS_JSON] 1-hop settlement swap path requires ` +
      `Pool<Token, SUI> or Pool<SUI, Token>. ` +
      `Got Pool<${pool.baseType}, ${pool.quoteType}>. ` +
      `Neither base nor quote is SUI.`,
  );
}

/**
 * Resolve a single parsed registry entry into a full SingleHopSettlementSwapPath.
 *
 * Makes on-chain queries to derive all fields from pool IDs.
 *
 * @param snapshot     Qualified current Sui operation boundary
 * @param deepbookCallPackageId  Published DeepBook package ID used for Move calls
 * @param entry        Parsed registry entry with one pool ID
 *
 * @throws Error on any derivation failure (fail-closed)
 */
async function resolveSettlementSwapPathConfig(
  snapshot: SuiEndpointSnapshot,
  deepbookCallPackageId: string,
  entry: ParsedSettlementSwapPathRegistryEntry,
  feeParams: DeepbookFeeParameters,
  signal?: AbortSignal,
): Promise<SingleHopSettlementSwapPath> {
  // Step 1: Read type params for the configured pool
  const typeInfo = await getPoolTypeInfo(
    snapshot,
    DEEPBOOK_RUNTIME_PACKAGE_ID,
    entry.poolId,
    signal,
  );

  // Step 2: Determine settlement token and swap direction
  const { settlementTokenType, swapDirection } = determineSettlementToken(typeInfo);

  // Step 3: Query on-chain params for the single hop
  const [bookParams, coinMeta, whitelisted] = await Promise.all([
    queryPoolBookParams(
      snapshot,
      deepbookCallPackageId,
      entry.poolId,
      typeInfo.baseType,
      typeInfo.quoteType,
      signal,
    ),
    queryCoinMetadata(snapshot, settlementTokenType, signal),
    queryPoolWhitelisted(
      snapshot,
      deepbookCallPackageId,
      entry.poolId,
      typeInfo.baseType,
      typeInfo.quoteType,
      signal,
    ),
  ]);

  // Step 4: Query trade params only when the pool is not whitelisted.
  let effectiveFeeRateBps = 0;
  if (!whitelisted) {
    const trade = await queryPoolTradeParams(
      snapshot,
      deepbookCallPackageId,
      entry.poolId,
      typeInfo.baseType,
      typeInfo.quoteType,
      signal,
    );
    // Stelis always settles DeepBook swaps with coin::zero<DEEP>(), so public
    // fee metadata must reflect DeepBook input-fee execution. The scaling and
    // penalty constants are read from the deployed DeepBook package at boot.
    effectiveFeeRateBps = inputFeeRateBpsFromDeepbookTakerFee(trade.takerFee, feeParams);
  }

  // Step 5: Build the canonical single-hop config shape.
  const hops: DeepBookPoolHop[] = [
    {
      poolId: entry.poolId,
      baseType: typeInfo.baseType,
      quoteType: typeInfo.quoteType,
      swapDirection,
      feeBps: effectiveFeeRateBps,
    },
  ];

  // Step 6: Derive settlementSwapDirection from the canonical single-hop swapDirection vector.
  const settlementSwapDirection = settlementSwapDirectionFromSwapDirections([swapDirection]);
  if (!settlementSwapDirection) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Unable to derive SettlementSwapDirection from swapDirections=[${swapDirection}]. ` +
        `No matching entry in SETTLEMENT_SWAP_DIRECTION_VECTORS.`,
    );
  }

  return {
    settlementTokenType,
    settlementTokenSymbol: coinMeta.symbol,
    settlementTokenDecimals: coinMeta.decimals,
    lotSize: bookParams.lotSize,
    minSize: bookParams.minSize,
    effectiveFeeRateBps,
    settlementSwapDirection,
    hops,
  };
}

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

/**
 * Validate the resolved settlement swap path registry.
 *
 * @throws Error on validation failure:
 *   - Empty registry
 *   - Duplicate settlementTokenType
 */
export function validateSettlementSwapPathRegistry(
  settlementSwapPaths: SingleHopSettlementSwapPath[],
): void {
  if (settlementSwapPaths.length === 0) {
    throw new Error(
      '[SETTLEMENT_SWAP_PATHS_JSON] Resolved registry is empty. At least one path is required.',
    );
  }

  // Reject duplicate settlementTokenType
  const seen = new Set<string>();
  for (const settlementSwapPath of settlementSwapPaths) {
    if (seen.has(settlementSwapPath.settlementTokenType)) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] Duplicate settlementTokenType detected: ${settlementSwapPath.settlementTokenType} ` +
          `(${settlementSwapPath.settlementTokenSymbol}). Only 1 settlement swap path per settlement token is allowed.`,
      );
    }
    if (
      !Number.isSafeInteger(settlementSwapPath.effectiveFeeRateBps) ||
      settlementSwapPath.effectiveFeeRateBps < 0 ||
      settlementSwapPath.effectiveFeeRateBps > 10_000
    ) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] ${settlementSwapPath.settlementTokenSymbol}: effectiveFeeRateBps must be a safe integer in [0, 10000].`,
      );
    }
    if (settlementSwapPath.hops.length !== 1) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] ${settlementSwapPath.settlementTokenSymbol}: resolved settlement swap path must have exactly 1 hop.`,
      );
    }
    for (let i = 0; i < settlementSwapPath.hops.length; i++) {
      const hop = settlementSwapPath.hops[i];
      if (!Number.isSafeInteger(hop.feeBps) || hop.feeBps < 0 || hop.feeBps > 10_000) {
        throw new Error(
          `[SETTLEMENT_SWAP_PATHS_JSON] ${settlementSwapPath.settlementTokenSymbol}: hops[${i}].feeBps must be a safe integer in [0, 10000].`,
        );
      }
      if (hop.feeBps !== settlementSwapPath.effectiveFeeRateBps) {
        throw new Error(
          `[SETTLEMENT_SWAP_PATHS_JSON] ${settlementSwapPath.settlementTokenSymbol}: hops[${i}].feeBps must equal effectiveFeeRateBps for a 1-hop settlement swap path.`,
        );
      }
    }
    seen.add(settlementSwapPath.settlementTokenType);
  }
}

// ─────────────────────────────────────────────
// Top-level resolver
// ─────────────────────────────────────────────

/**
 * Resolve an already parsed settlement swap path registry from on-chain data.
 * File ownership stays at the boot boundary so context creation cannot reread
 * or reinterpret a mutable runtime file.
 *
 * @param snapshot     Qualified current Sui operation boundary
 * @param deepbookCallPackageId  Published DeepBook package ID from DEEPBOOK_IDS
 * @param entries      Entries parsed once by boot
 *
 * @returns Fully resolved SingleHopSettlementSwapPath[]
 * @throws Error on any failure (fail-closed at boot)
 */
export async function resolveSettlementSwapPathRegistry(
  snapshot: SuiEndpointSnapshot,
  deepbookCallPackageId: string,
  entries: readonly ParsedSettlementSwapPathRegistryEntry[],
  signal?: AbortSignal,
): Promise<SingleHopSettlementSwapPath[]> {
  if (!isValidSuiAddress(deepbookCallPackageId)) {
    throw new TypeError('DeepBook call package ID must be a Sui address');
  }
  const deepbookPackageId = normalizeSuiAddress(deepbookCallPackageId);
  const feeParams = await queryDeepbookFeeParameters(snapshot, deepbookPackageId, signal);

  // 1. Resolve each settlement swap path from on-chain data
  const settlementSwapPaths: SingleHopSettlementSwapPath[] = [];
  for (const entry of entries) {
    const config = await resolveSettlementSwapPathConfig(
      snapshot,
      deepbookPackageId,
      entry,
      feeParams,
      signal,
    );
    settlementSwapPaths.push(config);
  }

  // 2. Validate the resolved set
  validateSettlementSwapPathRegistry(settlementSwapPaths);

  return settlementSwapPaths;
}

// ─────────────────────────────────────────────
// BCS helpers
// ─────────────────────────────────────────────

/** Decode a BCS bool (1 byte: 0=false, 1=true). */
function decodeBcsBool(bcs: unknown): boolean {
  const buf = bcs instanceof Uint8Array ? bcs : new Uint8Array(bcs as ArrayBuffer);
  if (buf.length !== 1) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] BCS bool decode: expected 1 byte, got ${buf.length}`,
    );
  }
  if (buf[0] !== 0 && buf[0] !== 1) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] BCS bool decode: expected 0 or 1, got ${String(buf[0])}`,
    );
  }
  return buf[0] === 1;
}
