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
 *   - CoinMetadata: SuiGrpcClient.getCoinMetadata()
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import type { SingleHopSettlementSwapPath, DeepBookPoolHop, SuiNetwork } from '@stelis/contracts';
import { SUI_TYPE, settlementSwapDirectionFromSwapDirections } from '@stelis/contracts';

const CONFIG_NETWORKS: readonly SuiNetwork[] = ['testnet', 'mainnet'];

/** Zero-sender address for zero-gas simulate calls. */
const ZERO_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Host settlement swap path file used by runtime policy. */
export function getSettlementSwapPathRegistryPath(): string {
  return new URL('../settlement-swap-paths.json', import.meta.url).pathname;
}

// ─────────────────────────────────────────────
// Registry parsing
// ─────────────────────────────────────────────

/** Parsed entry from the settlement swap path registry. */
interface ParsedSettlementSwapPathRegistryEntry {
  /** DeepBook pool ID for a single supported settlement swap path. */
  poolId: string;
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
    if (typeof poolId !== 'string' || !poolId.startsWith('0x') || poolId.length < 3) {
      throw new Error(
        `[SETTLEMENT_SWAP_PATHS_JSON] Entry [${i}]: invalid pool ID "${String(poolId)}".`,
      );
    }
    entries.push({ poolId });
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

/**
 * Build and simulate a single-argument DeepBook pool view call (zero-sender, no gas).
 *
 * Returns the first command's returnValues, or undefined if unavailable.
 * This is a pure transport helper — all semantic validation (length, decode) is
 * performed by the calling query function.
 *
 * @throws via tx.build / simulateTransaction on RPC failure
 */
async function runPoolViewCall(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
  viewFn: string,
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::${viewFn}`,
    typeArguments: [baseType, quoteType],
    arguments: [tx.object(poolId)],
  });
  tx.setSender(ZERO_SENDER);
  const txBytes = await tx.build({ client });
  const result = await client.simulateTransaction({
    transaction: txBytes,
    include: { commandResults: true },
  });
  const cmdResults =
    'Transaction' in result && result.Transaction
      ? result.commandResults
      : 'FailedTransaction' in result && result.FailedTransaction
        ? result.commandResults
        : undefined;
  return cmdResults?.[0]?.returnValues;
}

/**
 * Build and simulate a no-argument DeepBook constants view call.
 *
 * DeepBook fee-rate metadata depends on constants owned by the deployed
 * DeepBook package, so app-api reads them at boot instead of hardcoding them.
 */
async function runConstantsViewCall(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  viewFn: string,
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::constants::${viewFn}`,
    arguments: [],
  });
  tx.setSender(ZERO_SENDER);
  const txBytes = await tx.build({ client });
  const result = await client.simulateTransaction({
    transaction: txBytes,
    include: { commandResults: true },
  });
  const cmdResults =
    'Transaction' in result && result.Transaction
      ? result.commandResults
      : 'FailedTransaction' in result && result.FailedTransaction
        ? result.commandResults
        : undefined;
  return cmdResults?.[0]?.returnValues;
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
  client: SuiGrpcClient,
  deepbookPackageId: string,
  viewFn: string,
): Promise<bigint> {
  const rv = await runConstantsViewCall(client, deepbookPackageId, viewFn);
  if (!rv || rv.length < 1) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] DeepBook constants::${viewFn}() returned no value`,
    );
  }
  return decodeBcsU64(rv[0].bcs);
}

async function queryDeepbookFeeParameters(
  client: SuiGrpcClient,
  deepbookPackageId: string,
): Promise<DeepbookFeeParameters> {
  const [feeScaling, inputFeePenaltyMultiplier] = await Promise.all([
    queryDeepbookConstantU64(client, deepbookPackageId, 'float_scaling'),
    queryDeepbookConstantU64(client, deepbookPackageId, 'fee_penalty_multiplier'),
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
async function getPoolTypeInfo(client: SuiGrpcClient, poolId: string): Promise<PoolTypeInfo> {
  const resp = await client.getObject({ objectId: poolId });
  const typeStr = resp.object.type;

  if (!typeStr) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: object not found or type unavailable.`,
    );
  }

  // Parse: 0x...::pool::Pool<BaseType, QuoteType>
  const match = typeStr.match(/::pool::Pool<(.+),\s*(.+)>$/);
  if (!match || match.length < 3) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: cannot parse type params from "${typeStr}"`,
    );
  }

  return {
    baseType: match[1].trim(),
    quoteType: match[2].trim(),
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
  client: SuiGrpcClient,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
): Promise<PoolBookParams> {
  const rv = await runPoolViewCall(
    client,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'pool_book_params',
  );
  if (!rv || rv.length < 3) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: pool_book_params returned ${rv?.length ?? 0} values (expected 3)`,
    );
  }
  return {
    tickSize: decodeBcsU64(rv[0].bcs),
    lotSize: decodeBcsU64(rv[1].bcs),
    minSize: decodeBcsU64(rv[2].bcs),
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
  client: SuiGrpcClient,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
): Promise<PoolTradeParams> {
  const rv = await runPoolViewCall(
    client,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'pool_trade_params',
  );
  if (!rv || rv.length < 3) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: pool_trade_params returned ${rv?.length ?? 0} values (expected 3)`,
    );
  }
  return {
    takerFee: decodeBcsU64(rv[0].bcs),
    makerFee: decodeBcsU64(rv[1].bcs),
    stakeRequired: decodeBcsU64(rv[2].bcs),
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
  client: SuiGrpcClient,
  deepbookPackageId: string,
  poolId: string,
  baseType: string,
  quoteType: string,
): Promise<boolean> {
  const rv = await runPoolViewCall(
    client,
    deepbookPackageId,
    poolId,
    baseType,
    quoteType,
    'whitelisted',
  );
  if (!rv || rv.length < 1) {
    throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] Pool ${poolId}: whitelisted() returned no value`);
  }
  return decodeBcsBool(rv[0].bcs);
}

/**
 * Query CoinMetadata for symbol and decimals.
 *
 * @throws Error if CoinMetadata is not found
 */
async function queryCoinMetadata(
  client: SuiGrpcClient,
  coinType: string,
): Promise<{ symbol: string; decimals: number }> {
  const resp = await client.getCoinMetadata({ coinType });
  const meta = resp.coinMetadata;
  if (!meta) {
    throw new Error(`[SETTLEMENT_SWAP_PATHS_JSON] CoinMetadata not found for type: ${coinType}`);
  }

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
 * @param client       Sui gRPC client
 * @param deepbookPkg  DeepBook v3 package ID
 * @param entry        Parsed registry entry with one pool ID
 *
 * @throws Error on any derivation failure (fail-closed)
 */
async function resolveSettlementSwapPathConfig(
  client: SuiGrpcClient,
  deepbookPkg: string,
  entry: ParsedSettlementSwapPathRegistryEntry,
  feeParams: DeepbookFeeParameters,
): Promise<SingleHopSettlementSwapPath> {
  // Step 1: Read type params for the configured pool
  const typeInfo = await getPoolTypeInfo(client, entry.poolId);

  // Step 2: Determine settlement token and swap direction
  const { settlementTokenType, swapDirection } = determineSettlementToken(typeInfo);

  // Step 3: Query on-chain params for the single hop
  const [bookParams, coinMeta, whitelisted] = await Promise.all([
    queryPoolBookParams(client, deepbookPkg, entry.poolId, typeInfo.baseType, typeInfo.quoteType),
    queryCoinMetadata(client, settlementTokenType),
    queryPoolWhitelisted(client, deepbookPkg, entry.poolId, typeInfo.baseType, typeInfo.quoteType),
  ]);

  // Step 4: Query trade params only when the pool is not whitelisted.
  let effectiveFeeRateBps = 0;
  if (!whitelisted) {
    const trade = await queryPoolTradeParams(
      client,
      deepbookPkg,
      entry.poolId,
      typeInfo.baseType,
      typeInfo.quoteType,
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
// Top-level loader
// ─────────────────────────────────────────────

/**
 * Load and resolve the settlement swap path registry from a JSON file.
 *
 * Called from context.ts during initialization.
 *
 * @param client       Sui gRPC client (already connected)
 * @param deepbookPkg  DeepBook package ID from DEEPBOOK_IDS
 * @param jsonFilePath Path to settlement-swap-paths.json
 *
 * @returns Fully resolved SingleHopSettlementSwapPath[]
 * @throws Error on any failure (fail-closed at boot)
 */
export async function loadSettlementSwapPathRegistry(
  client: SuiGrpcClient,
  deepbookPkg: string,
  jsonFilePath: string,
  network: SuiNetwork,
): Promise<SingleHopSettlementSwapPath[]> {
  // 1. Read and parse JSON file
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(jsonFilePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Cannot read "${jsonFilePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] Invalid JSON in "${jsonFilePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entries = parseSettlementSwapPathRegistryJson(json, network);
  const feeParams = await queryDeepbookFeeParameters(client, deepbookPkg);

  // 2. Resolve each settlement swap path from on-chain data
  const settlementSwapPaths: SingleHopSettlementSwapPath[] = [];
  for (const entry of entries) {
    const config = await resolveSettlementSwapPathConfig(client, deepbookPkg, entry, feeParams);
    settlementSwapPaths.push(config);
  }

  // 3. Validate the resolved set
  validateSettlementSwapPathRegistry(settlementSwapPaths);

  return settlementSwapPaths;
}

// ─────────────────────────────────────────────
// BCS helpers
// ─────────────────────────────────────────────

/** Decode a little-endian u64 from BCS bytes. */
function decodeBcsU64(bcs: unknown): bigint {
  const buf = bcs instanceof Uint8Array ? bcs : new Uint8Array(bcs as ArrayBuffer);
  if (buf.length !== 8) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] BCS u64 decode: expected 8 bytes, got ${buf.length}`,
    );
  }
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(buf[i]) << BigInt(i * 8);
  }
  return value;
}

/** Decode a BCS bool (1 byte: 0=false, 1=true). */
function decodeBcsBool(bcs: unknown): boolean {
  const buf = bcs instanceof Uint8Array ? bcs : new Uint8Array(bcs as ArrayBuffer);
  if (buf.length !== 1) {
    throw new Error(
      `[SETTLEMENT_SWAP_PATHS_JSON] BCS bool decode: expected 1 byte, got ${buf.length}`,
    );
  }
  return buf[0] !== 0;
}
