#!/usr/bin/env node
/**
 * Empty execution benchmark for local testnet use.
 *
 * This script intentionally sends no user commands in the Transaction.
 * In the sponsored phase, the Host appends Stelis settlement and submits
 * the sponsored transaction. In the direct phase, the wallet submits a
 * plain empty SUI transaction.
 */
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { queryUserCredit, StelisApiException, StelisSDK, StelisSponsoredError } from '@stelis/sdk';

const SUI_TYPE = '0x2::sui::SUI';
const DEFAULT_DIRECT_GAS_BUDGET_MIST = 3_000_000n;
const RATE_LIMIT_RETRY_FALLBACK_MS = 10_000;
const RATE_LIMIT_RETRY_PADDING_MS = 250;
const DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS = 1_000;
const DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT = 10;
const PHASE = Object.freeze({
  SPONSORED: 'sponsored',
  DIRECT: 'direct',
  BOTH: 'both',
});
const RUN_PHASES = new Set(Object.values(PHASE));
const EXECUTION_KIND = Object.freeze({
  VAULT_CREATE: 'vault_create',
  VAULT_TOP_UP: 'vault_top_up',
  VAULT_CREDIT_USE: 'vault_credit_use',
  DIRECT: 'direct',
});
const SPONSORED_FLOW_ORDER = [
  EXECUTION_KIND.VAULT_CREATE,
  EXECUTION_KIND.VAULT_TOP_UP,
  EXECUTION_KIND.VAULT_CREDIT_USE,
];
const SPONSORED_FLOW_BY_PROFILE = {
  new_user: {
    key: EXECUTION_KIND.VAULT_CREATE,
    label: 'User Vault create + token-funded settlement',
    reportNote:
      'Creates the User Vault and settles through the configured settlement swap path. Treat as setup cost, not direct empty-transaction overhead.',
  },
  with_vault: {
    key: EXECUTION_KIND.VAULT_TOP_UP,
    label: 'User Vault top-up + token-funded settlement',
    reportNote:
      'Uses an existing User Vault but still settles through the configured settlement swap path. Report separately from direct empty-transaction overhead.',
  },
  credit_general: {
    key: EXECUTION_KIND.VAULT_CREDIT_USE,
    label: 'User Vault credit use',
    reportNote:
      'Uses existing User Vault credit without a settlement-token swap. This is the sponsored path compared against direct empty SUI transactions.',
  },
};
const SPONSORED_FLOW_BY_KIND = Object.fromEntries(
  Object.values(SPONSORED_FLOW_BY_PROFILE).map((flow) => [flow.key, flow]),
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const envPath = path.join(__dirname, '.env');

function usage() {
  return [
    'Usage:',
    '  node scripts/onchain-tests/empty-execution-benchmark.mjs          # balance check only',
    '  node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase sponsored',
    '  node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase direct',
    '',
    'Options:',
    '  --execute                         Actually submit transactions. Omit for dry config check.',
    '  --phase <sponsored|direct|both>    Phase to run.',
    '  --api-url <url>                    Relay API base URL.',
    '  --settlement-token-symbol <sym>    Settlement token symbol from /relay/config.',
    '  --settlement-token-type <type>     Full settlement token type from /relay/config.',
    '  --max-runs <n>                     Run cap for each selected phase.',
    '  --direct-gas-budget-mist <mist>    Direct empty transaction gas budget.',
    '  --min-sui-reserve-mist <mist>      Direct phase stop reserve.',
    '  --raw-dir <path>                   Directory for timestamped raw JSONL files.',
    '  --report-dir <path>                Directory for fixed cumulative Markdown reports.',
    '  --allow-mainnet                    Permit mainnet. Default is testnet-only.',
  ].join('\n');
}

async function parseEnvFile(filePath) {
  try {
    await access(filePath);
  } catch {
    return {};
  }
  const raw = await readFile(filePath, 'utf8');
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    parsed[trimmed.slice(0, idx).trim()] = stripOptionalQuotes(trimmed.slice(idx + 1).trim());
  }
  return parsed;
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--execute') {
      out.execute = true;
    } else if (arg === '--allow-mainnet') {
      out.allowMainnet = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      out[toCamelCase(key)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function toCamelCase(kebab) {
  return kebab.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function envValue(env, cli, cliName, envName, fallback = undefined) {
  return cli[cliName] ?? process.env[envName] ?? env[envName] ?? fallback;
}

function requireValue(value, name) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`Missing ${name}. Set it in scripts/onchain-tests/.env or pass a CLI option.`);
  }
  return trimmed;
}

function normalizeRelayApiUrl(raw) {
  const value = raw.trim().replace(/\/+$/, '');
  return value.endsWith('/relay') ? value : `${value}/relay`;
}

function includesPhase(selectedPhase, phase) {
  return selectedPhase === phase || selectedPhase === PHASE.BOTH;
}

function parseNonNegativeSafeInteger(raw, label) {
  const value = String(raw).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a non-negative safe integer, got ${raw}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be within Number.MAX_SAFE_INTEGER, got ${raw}`);
  }
  return parsed;
}

function parsePositiveSafeInteger(raw, label) {
  const value = parseNonNegativeSafeInteger(raw, label);
  if (value <= 0) throw new Error(`${label} must be > 0`);
  return value;
}

function parseNonNegativeBigInt(raw, label) {
  const value = String(raw).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string, got ${raw}`);
  }
  return BigInt(value);
}

function defaultGrpcBaseUrl(network) {
  if (network === 'testnet') return 'https://fullnode.testnet.sui.io:443';
  if (network === 'mainnet') return 'https://fullnode.mainnet.sui.io:443';
  throw new Error(`Unsupported network: ${network}`);
}

function timestampForFileName(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function resolveOutputPaths({ fileEnv, cli, runId }) {
  const rawDir = path.resolve(
    repoRoot,
    envValue(fileEnv, cli, 'rawDir', 'STELIS_ONCHAIN_RAW_DIR', '.WORK/onchain-tests/raw'),
  );
  const reportDir = path.resolve(
    repoRoot,
    envValue(fileEnv, cli, 'reportDir', 'STELIS_ONCHAIN_REPORT_DIR', 'docs/onchain-tests/reports'),
  );
  return {
    rawPath: path.join(rawDir, `${runId}-empty-execution-benchmark.jsonl`),
    reportPath: path.join(reportDir, 'empty-execution-benchmark.md'),
  };
}

function resolveSettlementSwapPath(sdk, tokenType, tokenSymbol) {
  const paths = sdk.supportedSettlementSwapPaths;
  if (tokenType) {
    const match = paths.find((p) => p.settlementTokenType === tokenType);
    if (!match) {
      throw new Error(`No settlement swap path for settlement token type: ${tokenType}`);
    }
    return match;
  }
  const symbol = tokenSymbol.toUpperCase();
  const matches = paths.filter((p) => p.settlementTokenSymbol.toUpperCase() === symbol);
  if (matches.length === 0) {
    const supported = paths
      .map((p) => `${p.settlementTokenSymbol} (${p.settlementTokenType})`)
      .join(', ');
    throw new Error(`No settlement swap path for symbol ${tokenSymbol}. Supported: ${supported}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple settlement swap paths match symbol ${tokenSymbol}. Use --settlement-token-type.`,
    );
  }
  return matches[0];
}

async function getBalanceMist(client, owner, coinType) {
  const res = await client.getBalance({ owner, coinType });
  const raw = res?.balance?.balance ?? res?.totalBalance ?? '0';
  return parseNonNegativeBigInt(raw, `${coinType} balance`);
}

function formatDecimal(raw, decimals, fractionDigits = Math.min(decimals, 6)) {
  if (!Number.isSafeInteger(decimals) || decimals < 0)
    throw new Error(`Invalid decimals ${decimals}`);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, fractionDigits);
  const formatted = fractionDigits > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

function formatMist(mist) {
  return `${formatDecimal(mist, 9, 9)} SUI`;
}

async function getUserVaultStatus(client, vaultRegistryId, address) {
  const credit = await queryUserCredit(client, vaultRegistryId, address);
  return {
    vaultObjectId: credit.vaultObjectId,
    needsCreate: credit.needsCreate,
    creditMist: parseNonNegativeBigInt(credit.credit, 'User Vault credit'),
  };
}

function formatUserVaultStatus(status) {
  if (status.needsCreate || !status.vaultObjectId) return 'none';
  return status.vaultObjectId;
}

function gasNetMist(gasUsed) {
  const computation = parseNonNegativeBigInt(gasUsed.computationCost, 'gasUsed.computationCost');
  const storage = parseNonNegativeBigInt(gasUsed.storageCost, 'gasUsed.storageCost');
  const rebate = parseNonNegativeBigInt(gasUsed.storageRebate, 'gasUsed.storageRebate');
  const net = computation + storage - rebate;
  return net < 0n ? 0n : net;
}

function extractTransactionGasUsed(result) {
  const tx = result?.Transaction ?? result?.FailedTransaction ?? result;
  return tx?.effects?.gasUsed ?? result?.effects?.gasUsed ?? tx?.gasUsed ?? result?.gasUsed ?? null;
}

function extractTransactionEffects(result) {
  const tx = result?.Transaction ?? result?.FailedTransaction ?? result;
  return tx?.effects ?? result?.effects ?? null;
}

function extractTransactionEvents(result) {
  const tx = result?.Transaction ?? result?.FailedTransaction ?? result;
  const events = tx?.events ?? result?.events;
  return Array.isArray(events) ? events : [];
}

function eventTypeOf(event) {
  return typeof event?.eventType === 'string' ? event.eventType : null;
}

function transactionEventFields(ctx, events) {
  const eventTypes = events.map(eventTypeOf).filter((eventType) => eventType !== null);
  return {
    eventsAvailable: true,
    eventTypes,
    stelisEventTypes: eventTypes.filter((eventType) => eventType.startsWith(`${ctx.packageId}::`)),
  };
}

function emptyTransactionEventFields() {
  return {
    eventsAvailable: false,
    eventTypes: [],
    stelisEventTypes: [],
  };
}

function extractTransactionDigest(result) {
  const tx = result?.Transaction ?? result?.FailedTransaction ?? result;
  return tx?.digest ?? result?.digest ?? null;
}

function extractTransactionStatus(result) {
  const tx = result?.Transaction ?? result?.FailedTransaction ?? result;
  return tx?.status ?? result?.status ?? null;
}

function isFailedTransactionResult(result) {
  if (result?.$kind === 'FailedTransaction') return true;
  const status = extractTransactionStatus(result);
  return status?.success === false;
}

function isExhaustionError(err) {
  if (err instanceof StelisSponsoredError && err.code === 'INSUFFICIENT_FUNDS') return true;
  const code = err?.code;
  const subcode = err?.meta?.subcode;
  if (code === 'INSUFFICIENT_FUNDS' || subcode === 'INSUFFICIENT_FUNDS') return true;
  if (subcode === 'INSUFFICIENT_SETTLE_INPUT') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /insufficient|exceeds available balance|no valid gas coins|coin balance/i.test(msg);
}

function normalizeErrorMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      normalized[key] = value;
    } else if (typeof value === 'bigint') {
      normalized[key] = value.toString();
    } else {
      normalized[key] = JSON.stringify(value);
    }
  }
  return normalized;
}

function describeError(err) {
  if (err instanceof StelisSponsoredError) {
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      meta: normalizeErrorMeta(err.meta),
    };
  }
  if (err instanceof StelisApiException) {
    return {
      name: err.name,
      code: err.code,
      status: err.status,
      message: err.message,
      meta: normalizeErrorMeta(err.meta),
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
    };
  }
  return {
    name: 'UnknownError',
    message: String(err),
  };
}

function summarizeError(err) {
  const detail = describeError(err);
  const code = detail.code ? ` code=${detail.code};` : '';
  return `${detail.name}:${code} ${detail.message}`;
}

function parseRetryAfterMs(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function rateLimitRetryAfterMs(err) {
  if (!(err instanceof StelisApiException) || err.status !== 429) return null;
  return parseRetryAfterMs(err.meta?.retryAfterMs) ?? RATE_LIMIT_RETRY_FALLBACK_MS;
}

function formatDurationMs(ms) {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry(label, fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryAfterMs = rateLimitRetryAfterMs(err);
      if (retryAfterMs === null) throw err;
      const waitMs = retryAfterMs + RATE_LIMIT_RETRY_PADDING_MS;
      console.log(`${label}: rate limited; waiting ${formatDurationMs(waitMs)} before retry`);
      await sleep(waitMs);
    }
  }
}

function parseJsonIfPossible(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function summarizeHttpBody(raw) {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}

async function postRelaySponsor(apiUrl, body) {
  const res = await fetch(`${apiUrl}/sponsor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  const data = parseJsonIfPossible(raw);
  if (!res.ok) {
    const isApiError = data && typeof data === 'object' && typeof data.code === 'string';
    const code = isApiError ? data.code : 'UNKNOWN';
    const message = isApiError
      ? String(data.error ?? `HTTP ${res.status}`)
      : (summarizeHttpBody(raw) ?? res.statusText ?? `HTTP ${res.status}`);
    const extra =
      data && typeof data === 'object'
        ? Object.fromEntries(
            Object.entries(data).filter(([key]) => key !== 'code' && key !== 'error'),
          )
        : undefined;
    throw new StelisApiException(
      code,
      message,
      res.status,
      extra && Object.keys(extra).length > 0 ? extra : undefined,
    );
  }
  if (!data || typeof data !== 'object') {
    const hint = summarizeHttpBody(raw);
    throw new Error(
      hint
        ? `Invalid non-JSON response from Relay API /sponsor: ${hint}`
        : `Invalid empty response from Relay API /sponsor (HTTP ${res.status})`,
    );
  }
  return data;
}

async function appendJsonl(rawPath, record) {
  await mkdir(path.dirname(rawPath), { recursive: true });
  await appendFile(rawPath, `${JSON.stringify(record)}\n`);
}

async function ensureRawWritable(rawPath) {
  await mkdir(path.dirname(rawPath), { recursive: true });
  await appendFile(rawPath, '');
}

async function ensureReportDirectory(reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
}

function stringifyRecord(record) {
  return JSON.parse(
    JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
}

async function appendBenchmarkRecord(ctx, fields) {
  const { network: _network, stelisPackageId: _stelisPackageId, ...recordFields } = fields;
  await appendJsonl(
    ctx.rawPath,
    stringifyRecord({
      network: ctx.network,
      stelisPackageId: ctx.packageId,
      ...recordFields,
    }),
  );
}

async function executeSponsoredEmpty({
  sdk,
  apiUrl,
  client,
  keypair,
  address,
  settlementTokenType,
  slippageBps,
  runLabel,
}) {
  const tx = new Transaction();
  const prepared = await withRateLimitRetry(`${runLabel} prepare`, () =>
    sdk.prepareSponsored(tx, {
      client,
      addr: address,
      settlementToken: { type: settlementTokenType },
      slippageBps,
      prepareAuthorizationSigner: async (messageBytes) => {
        const { signature } = await keypair.signPersonalMessage(messageBytes);
        return signature;
      },
    }),
  );
  const { signature: userSignature } = await keypair.signTransaction(fromBase64(prepared.txBytes));
  const sponsorRes = await withRateLimitRetry(`${runLabel} sponsor`, () =>
    postRelaySponsor(apiUrl, {
      txBytes: prepared.txBytes,
      userSignature,
      receiptId: prepared.receiptId,
    }),
  );
  const submittedTransaction = await resolveSubmittedTransaction({
    client,
    digest: sponsorRes.digest,
    effects: sponsorRes.effects,
  });
  return {
    digest: sponsorRes.digest,
    effects: submittedTransaction.effects,
    events: submittedTransaction.events,
    eventsAvailable: submittedTransaction.eventsAvailable,
    cost: prepared.cost,
    profile: prepared.profile,
    vaultId: prepared.vaultId,
    totalCostMist: prepared.totalCostMist,
    totalCostSui: prepared.totalCostSui,
    orderId: sponsorRes.orderId ?? prepared.orderId,
  };
}

async function waitForTransactionByDigest(client, digest) {
  return client.waitForTransaction({
    digest,
    include: { effects: true, events: true },
  });
}

async function resolveSubmittedTransaction({ client, digest, effects }) {
  if (!digest) {
    return { effects, events: [], eventsAvailable: false };
  }
  let loaded;
  try {
    loaded = await waitForTransactionByDigest(client, digest);
  } catch (err) {
    if (extractTransactionGasUsed(effects)) {
      return { effects, events: [], eventsAvailable: false };
    }
    throw err;
  }
  return {
    effects: extractTransactionEffects(loaded) ?? effects,
    events: extractTransactionEvents(loaded),
    eventsAvailable: true,
  };
}

async function submitDirectEmptyTransaction({ client, keypair, address, directGasBudgetMist }) {
  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(directGasBudgetMist.toString());
  const txBytes = await tx.build({ client });
  const { signature } = await keypair.signTransaction(txBytes);
  return client.executeTransaction({
    transaction: txBytes,
    signatures: [signature],
    include: { effects: true },
  });
}

async function waitForSubmittedTransaction(client, submitted) {
  const digest = extractTransactionDigest(submitted);
  if (!digest) return submitted;
  return waitForTransactionByDigest(client, digest);
}

async function executeDirectEmpty(ctx) {
  const submitted = await submitDirectEmptyTransaction(ctx);
  return waitForSubmittedTransaction(ctx.client, submitted);
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length);
}

function emptySponsoredFlowStats() {
  return {
    runs: 0,
    tokenSpentRaw: [],
    totalCostMist: [],
    executionCostClaimMist: [],
    actualGasMist: [],
    hostMarginMist: [],
  };
}

function createSponsoredStats() {
  return {
    runs: 0,
    tokenSpentRaw: [],
    totalCostMist: [],
    executionCostClaimMist: [],
    actualGasMist: [],
    hostMarginMist: [],
    stopReason: null,
    byFlow: Object.fromEntries(SPONSORED_FLOW_ORDER.map((key) => [key, emptySponsoredFlowStats()])),
  };
}

function classifySponsoredProfile(profile) {
  const flow = SPONSORED_FLOW_BY_PROFILE[profile];
  if (!flow) throw new Error(`Unknown sponsored profile from /prepare: ${profile}`);
  return flow;
}

function recordSponsoredMetrics(stats, flowKey, metrics) {
  stats.runs++;
  stats.tokenSpentRaw.push(metrics.tokenSpentRaw);
  stats.totalCostMist.push(metrics.totalCostMist);
  stats.executionCostClaimMist.push(metrics.executionCostClaimMist);
  stats.actualGasMist.push(metrics.actualGasMist);
  stats.hostMarginMist.push(metrics.hostMarginMist);

  const flowStats = stats.byFlow[flowKey];
  if (!flowStats) throw new Error(`Unknown sponsored flow: ${flowKey}`);
  flowStats.runs++;
  flowStats.tokenSpentRaw.push(metrics.tokenSpentRaw);
  flowStats.totalCostMist.push(metrics.totalCostMist);
  flowStats.executionCostClaimMist.push(metrics.executionCostClaimMist);
  flowStats.actualGasMist.push(metrics.actualGasMist);
  flowStats.hostMarginMist.push(metrics.hostMarginMist);
}

function assertExecutableBalances({
  phase,
  initialSui,
  initialToken,
  settlementSwapPath,
  minSettlementTokenRaw,
  minSuiReserveMist,
  directGasBudgetMist,
  requireZeroSuiForSponsored,
}) {
  const needsSponsored = includesPhase(phase, PHASE.SPONSORED);
  const needsDirect = includesPhase(phase, PHASE.DIRECT);

  if (needsSponsored && initialToken <= minSettlementTokenRaw) {
    throw new Error(
      `Cannot start sponsored phase: ${settlementSwapPath.settlementTokenSymbol} balance is ${initialToken.toString()} raw, which is at or below the minimum ${minSettlementTokenRaw.toString()}.`,
    );
  }
  if (needsSponsored && requireZeroSuiForSponsored && initialSui !== 0n) {
    throw new Error(
      `Cannot start sponsored phase: wallet has ${initialSui.toString()} MIST (${formatMist(initialSui)}), but STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED=true.`,
    );
  }
  if (needsDirect && initialSui <= minSuiReserveMist) {
    throw new Error(
      `Cannot start direct phase: SUI balance ${initialSui.toString()} is at or below reserve ${minSuiReserveMist.toString()}.`,
    );
  }
  if (needsDirect && initialSui < directGasBudgetMist) {
    throw new Error(
      `Cannot start direct phase: SUI balance ${initialSui.toString()} is below direct gas budget ${directGasBudgetMist.toString()}.`,
    );
  }
}

async function runSponsoredPhase(ctx) {
  const stats = createSponsoredStats();

  for (let i = 1; i <= ctx.sponsoredMaxRuns; i++) {
    const beforeToken = await getBalanceMist(
      ctx.client,
      ctx.address,
      ctx.settlementSwapPath.settlementTokenType,
    );
    const beforeSui = await getBalanceMist(ctx.client, ctx.address, SUI_TYPE);
    if (beforeToken <= ctx.minSettlementTokenRaw) {
      console.log('Sponsored stop: settlement token balance is at or below minimum.');
      break;
    }

    if (ctx.requireZeroSuiForSponsored && beforeSui !== 0n) {
      throw new Error(
        `Sponsored phase requires zero SUI, but wallet has ${beforeSui} MIST (${formatMist(beforeSui)}).`,
      );
    }

    try {
      console.log(`Sponsored #${i}: preparing empty user PTB`);
      const result = await executeSponsoredEmpty({ ...ctx, runLabel: `Sponsored #${i}` });
      const sponsoredFlow = classifySponsoredProfile(result.profile);
      const afterToken = await getBalanceMist(
        ctx.client,
        ctx.address,
        ctx.settlementSwapPath.settlementTokenType,
      );
      const tokenSpentRaw = beforeToken > afterToken ? beforeToken - afterToken : 0n;
      const gasUsed = extractTransactionGasUsed(result.effects);
      const eventFields = result.eventsAvailable
        ? transactionEventFields(ctx, result.events)
        : emptyTransactionEventFields();
      if (!gasUsed) {
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.SPONSORED,
          executionKind: sponsoredFlow.key,
          sponsoredFlow: sponsoredFlow.key,
          sponsoredFlowLabel: sponsoredFlow.label,
          profile: result.profile,
          run: i,
          executedContractPackageId: ctx.packageId,
          digest: result.digest,
          vaultId: result.vaultId,
          gasMist: null,
          ...eventFields,
          error: 'Sponsored transaction returned no gasUsed.',
        });
        throw new Error('Sponsored transaction returned no gasUsed.');
      }
      const actualGasMist = gasNetMist(gasUsed);
      const executionCostClaimMist = parseNonNegativeBigInt(
        result.cost.executionCostClaim,
        'executionCostClaim',
      );
      const hostFeeMist = parseNonNegativeBigInt(result.cost.quotedHostFee, 'quotedHostFee');
      const protocolFeeMist = parseNonNegativeBigInt(result.cost.protocolFee, 'protocolFee');
      const hostRecoveryMist = executionCostClaimMist + hostFeeMist;
      const hostMarginMist = hostRecoveryMist - actualGasMist;

      recordSponsoredMetrics(stats, sponsoredFlow.key, {
        tokenSpentRaw,
        totalCostMist: result.totalCostMist,
        executionCostClaimMist,
        actualGasMist,
        hostMarginMist,
      });

      await appendBenchmarkRecord(ctx, {
        mode: PHASE.SPONSORED,
        executionKind: sponsoredFlow.key,
        sponsoredFlow: sponsoredFlow.key,
        sponsoredFlowLabel: sponsoredFlow.label,
        profile: result.profile,
        run: i,
        executedContractPackageId: ctx.packageId,
        digest: result.digest,
        vaultId: result.vaultId,
        gasMist: actualGasMist,
        ...eventFields,
        executionCostClaimMist,
        hostFeeMist,
        protocolFeeMist,
        userTotalCostMist: result.totalCostMist,
        hostRecoveryMist,
        hostMarginMist,
        settlementTokenSpentRaw: tokenSpentRaw,
      });

      console.log(
        `Sponsored #${i} [${sponsoredFlow.label}]: ${result.digest} gas=${formatMist(actualGasMist)} hostMargin=${formatMist(hostMarginMist)} tokenSpentRaw=${tokenSpentRaw.toString()}`,
      );
    } catch (err) {
      if (isExhaustionError(err)) {
        const stopReason = describeError(err);
        stats.stopReason = stopReason;
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.SPONSORED,
          run: i,
          stoppedBeforeSubmit: true,
          executedContractPackageId: null,
          digest: null,
          gasMist: null,
          error: stopReason,
        });
        console.log(`Sponsored stop: ${summarizeError(err)}`);
        break;
      }
      throw err;
    }
  }
  return stats;
}

async function runDirectPhase(ctx) {
  const stats = {
    runs: 0,
    actualGasMist: [],
    stopReason: null,
    duplicateDigestRetries: 0,
    seenDigests: new Set(),
  };

  let i = 1;
  let duplicateRetriesForRun = 0;
  while (i <= ctx.directMaxRuns) {
    const beforeSui = await getBalanceMist(ctx.client, ctx.address, SUI_TYPE);
    if (beforeSui <= ctx.minSuiReserveMist) {
      console.log('Direct stop: SUI balance is at or below reserve.');
      break;
    }
    if (beforeSui < ctx.directGasBudgetMist) {
      console.log(
        `Direct stop: SUI balance ${beforeSui.toString()} is below gas budget ${ctx.directGasBudgetMist.toString()}.`,
      );
      break;
    }

    try {
      console.log(`Direct #${i}: submitting empty SUI PTB`);
      const result = await executeDirectEmpty(ctx);
      const digest = extractTransactionDigest(result);
      const status = extractTransactionStatus(result);
      const gasUsed = extractTransactionGasUsed(result);
      const eventFields = digest
        ? transactionEventFields(ctx, extractTransactionEvents(result))
        : emptyTransactionEventFields();
      if (!digest) {
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.DIRECT,
          executionKind: EXECUTION_KIND.DIRECT,
          run: i,
          executedContractPackageId: null,
          digest: null,
          gasMist: null,
          ...eventFields,
          error: 'Direct transaction returned no digest.',
        });
        throw new Error('Direct transaction returned no digest.');
      }
      if (isFailedTransactionResult(result)) {
        const actualGasMist = gasUsed ? gasNetMist(gasUsed) : null;
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.DIRECT,
          executionKind: EXECUTION_KIND.DIRECT,
          run: i,
          failed: true,
          executedContractPackageId: null,
          digest,
          gasMist: actualGasMist,
          ...eventFields,
          error: status?.error ?? 'Transaction failed',
        });
        throw new Error(`Direct transaction failed: ${JSON.stringify(status)}`);
      }
      if (stats.seenDigests.has(digest)) {
        stats.duplicateDigestRetries++;
        duplicateRetriesForRun++;
        if (duplicateRetriesForRun > DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT) {
          throw new Error(
            `Direct #${i} kept returning duplicate digest ${digest} after ${DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT} retries.`,
          );
        }
        console.log(
          `Direct #${i}: duplicate digest ${digest}; waiting ${formatDurationMs(DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS)} before retry`,
        );
        await sleep(DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS);
        continue;
      }

      if (!gasUsed) {
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.DIRECT,
          executionKind: EXECUTION_KIND.DIRECT,
          run: i,
          executedContractPackageId: null,
          digest,
          gasMist: null,
          ...eventFields,
          error: 'Direct transaction returned no gasUsed.',
        });
        throw new Error('Direct transaction returned no gasUsed.');
      }
      const actualGasMist = gasNetMist(gasUsed);
      stats.runs++;
      stats.seenDigests.add(digest);
      duplicateRetriesForRun = 0;
      stats.actualGasMist.push(actualGasMist);

      await appendBenchmarkRecord(ctx, {
        mode: PHASE.DIRECT,
        executionKind: EXECUTION_KIND.DIRECT,
        run: i,
        executedContractPackageId: null,
        digest,
        gasMist: actualGasMist,
        ...eventFields,
      });

      console.log(`Direct #${i}: ${digest} gas=${formatMist(actualGasMist)}`);
      i++;
    } catch (err) {
      if (isExhaustionError(err)) {
        const stopReason = describeError(err);
        stats.stopReason = stopReason;
        await appendBenchmarkRecord(ctx, {
          mode: PHASE.DIRECT,
          executionKind: EXECUTION_KIND.DIRECT,
          run: i,
          stoppedBeforeSubmit: true,
          executedContractPackageId: null,
          digest: null,
          gasMist: null,
          error: stopReason,
        });
        console.log(`Direct stop: ${summarizeError(err)}`);
        break;
      }
      throw err;
    }
  }
  return stats;
}

function printSummary(sponsoredStats, directStats, settlementSwapPath) {
  console.log('');
  console.log('Summary');
  let avgVaultCreditUseGas = null;
  let avgDirectGas = null;
  if (sponsoredStats) {
    const avgTokenRaw = average(sponsoredStats.tokenSpentRaw);
    const avgTotalCost = average(sponsoredStats.totalCostMist);
    const avgExecutionClaim = average(sponsoredStats.executionCostClaimMist);
    const avgSponsoredGas = average(sponsoredStats.actualGasMist);
    avgVaultCreditUseGas = average(
      sponsoredStats.byFlow[EXECUTION_KIND.VAULT_CREDIT_USE].actualGasMist,
    );
    const avgHostMargin = average(sponsoredStats.hostMarginMist);
    console.log(`  sponsored runs: ${sponsoredStats.runs}`);
    for (const key of SPONSORED_FLOW_ORDER) {
      const flow = SPONSORED_FLOW_BY_KIND[key];
      const flowStats = sponsoredStats.byFlow[key];
      const flowAvgGas = average(flowStats.actualGasMist);
      console.log(
        `  ${key}: ${flowStats.runs} run(s)${
          flowAvgGas === null ? '' : `, avg gas=${formatMist(flowAvgGas)}`
        } — ${flow.label}`,
      );
    }
    if (avgTotalCost !== null)
      console.log(`  avg sponsored total cost: ${formatMist(avgTotalCost)}`);
    if (avgExecutionClaim !== null)
      console.log(`  avg sponsored execution claim: ${formatMist(avgExecutionClaim)}`);
    if (avgSponsoredGas !== null)
      console.log(`  avg sponsored actual gas (all flows): ${formatMist(avgSponsoredGas)}`);
    if (avgVaultCreditUseGas !== null)
      console.log(
        `  avg sponsored actual gas (vault credit use only): ${formatMist(avgVaultCreditUseGas)}`,
      );
    if (avgHostMargin !== null) console.log(`  avg Host margin: ${formatMist(avgHostMargin)}`);
    if (avgTokenRaw !== null) {
      console.log(
        `  avg settlement token spent: ${formatDecimal(avgTokenRaw, settlementSwapPath.settlementTokenDecimals)} ${settlementSwapPath.settlementTokenSymbol}`,
      );
    }
  }
  if (directStats) {
    avgDirectGas = average(directStats.actualGasMist);
    console.log(`  direct runs: ${directStats.runs}`);
    if (directStats.duplicateDigestRetries > 0) {
      console.log(`  direct duplicate digest retries: ${directStats.duplicateDigestRetries}`);
    }
    if (avgDirectGas !== null) console.log(`  avg direct actual gas: ${formatMist(avgDirectGas)}`);
  }
  if (avgVaultCreditUseGas !== null && avgDirectGas !== null) {
    console.log(
      `  avg extra gas vs direct (vault credit use only): ${formatMist(avgVaultCreditUseGas - avgDirectGas)}`,
    );
  }
}

function formatOptionalMist(value) {
  return value === null ? 'n/a' : formatMist(value);
}

function formatStopSummary(error) {
  return error ? 'before submission' : 'n/a';
}

function renderMarkdownReport({
  runStartedAt,
  completedAt,
  phase,
  network,
  packageId,
  settlementSwapPath,
  sponsoredMaxRuns,
  directMaxRuns,
  initialSui,
  initialToken,
  initialVaultStatus,
  sponsoredStats,
  directStats,
}) {
  const avgSponsoredGas = sponsoredStats ? average(sponsoredStats.actualGasMist) : null;
  const avgVaultCreditUseGas = sponsoredStats
    ? average(sponsoredStats.byFlow[EXECUTION_KIND.VAULT_CREDIT_USE].actualGasMist)
    : null;
  const avgDirectGas = directStats ? average(directStats.actualGasMist) : null;
  const avgExtraGas =
    avgVaultCreditUseGas !== null && avgDirectGas !== null
      ? avgVaultCreditUseGas - avgDirectGas
      : null;
  const avgHostMargin = sponsoredStats ? average(sponsoredStats.hostMarginMist) : null;
  const avgTotalCost = sponsoredStats ? average(sponsoredStats.totalCostMist) : null;
  const avgTokenRaw = sponsoredStats ? average(sponsoredStats.tokenSpentRaw) : null;
  const sponsoredFlowLines = sponsoredStats
    ? SPONSORED_FLOW_ORDER.flatMap((key) => {
        const flow = SPONSORED_FLOW_BY_KIND[key];
        const flowStats = sponsoredStats.byFlow[key];
        const flowAvgGas = average(flowStats.actualGasMist);
        const flowAvgHostMargin = average(flowStats.hostMarginMist);
        return [
          `### ${flow.label}`,
          '',
          `- Flow key: \`${key}\``,
          `- Submitted: ${flowStats.runs}`,
          `- Average gas: ${formatOptionalMist(flowAvgGas)}`,
          `- Average Host margin: ${formatOptionalMist(flowAvgHostMargin)}`,
          `- Interpretation: ${flow.reportNote}`,
          '',
        ];
      })
    : ['- Sponsored phase was not run.', ''];

  return [
    `## Run ${runStartedAt.toISOString()}`,
    '',
    `- Test date: ${runStartedAt.toISOString()}`,
    `- Completed at: ${completedAt.toISOString()}`,
    `- Network: ${network}`,
    `- Stelis package ID: \`${packageId}\``,
    `- Mode: ${phase}`,
    `- Settlement token: ${settlementSwapPath.settlementTokenSymbol}`,
    `- Settlement token type: \`${settlementSwapPath.settlementTokenType}\``,
    '',
    '## Test Counts',
    '',
    `- Sponsored submitted: ${sponsoredStats?.runs ?? 0} / ${sponsoredMaxRuns}`,
    `- Direct submitted: ${directStats?.runs ?? 0} / ${directMaxRuns}`,
    `- Direct duplicate digest retries: ${directStats?.duplicateDigestRetries ?? 0}`,
    '',
    '## Sponsored Flow Breakdown',
    '',
    ...sponsoredFlowLines,
    '',
    '## Starting Balances',
    '',
    `- SUI: ${formatMist(initialSui)}`,
    `- ${settlementSwapPath.settlementTokenSymbol}: ${formatDecimal(initialToken, settlementSwapPath.settlementTokenDecimals)} (${initialToken.toString()} raw)`,
    `- User Vault: ${initialVaultStatus.needsCreate ? 'none' : 'present'}`,
    `- User Vault credit: ${formatMist(initialVaultStatus.creditMist)} (${initialVaultStatus.creditMist.toString()} MIST)`,
    '',
    '## Summary',
    '',
    `- Average sponsored gas (all flows): ${formatOptionalMist(avgSponsoredGas)}`,
    `- Average sponsored gas (User Vault credit use only): ${formatOptionalMist(avgVaultCreditUseGas)}`,
    `- Average direct gas: ${formatOptionalMist(avgDirectGas)}`,
    `- Average extra gas vs direct: ${formatOptionalMist(avgExtraGas)}`,
    '- Direct comparison basis: User Vault credit use only',
    `- Average Host margin: ${formatOptionalMist(avgHostMargin)}`,
    `- Average sponsored user total cost: ${formatOptionalMist(avgTotalCost)}`,
    `- Average settlement token spent: ${
      avgTokenRaw === null
        ? 'n/a'
        : `${formatDecimal(avgTokenRaw, settlementSwapPath.settlementTokenDecimals)} ${settlementSwapPath.settlementTokenSymbol}`
    }`,
    `- Sponsored stop: ${formatStopSummary(sponsoredStats?.stopReason)}`,
    `- Direct stop: ${formatStopSummary(directStats?.stopReason)}`,
    '',
    '## Interpretation Fields',
    '',
    '- `gasMist`: actual on-chain gas paid for the submitted transaction.',
    '- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.',
    '- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.',
    '- Direct gas overhead is compared only against `vault_credit_use` runs. `vault_create` and `vault_top_up` include User Vault setup or settlement-token swap work and are reported separately.',
    '',
  ].join('\n');
}

async function writeMarkdownReport(reportPath, input) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  try {
    await access(reportPath);
  } catch {
    await writeFile(reportPath, '# Empty Execution Benchmark Report\n\n');
  }
  await appendFile(reportPath, `${renderMarkdownReport(input)}\n`);
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(usage());
    return;
  }

  const fileEnv = await parseEnvFile(envPath);
  const apiUrl = normalizeRelayApiUrl(
    requireValue(
      envValue(fileEnv, cli, 'apiUrl', 'STELIS_ONCHAIN_RELAY_API_URL'),
      'STELIS_ONCHAIN_RELAY_API_URL',
    ),
  );
  const secretKey = requireValue(
    envValue(fileEnv, cli, 'secretKey', 'STELIS_ONCHAIN_USER_SECRET_KEY'),
    'STELIS_ONCHAIN_USER_SECRET_KEY',
  );
  const phase = requireValue(
    envValue(fileEnv, cli, 'phase', 'STELIS_ONCHAIN_PHASE', PHASE.SPONSORED),
    'STELIS_ONCHAIN_PHASE',
  );
  if (!RUN_PHASES.has(phase)) {
    throw new Error(`STELIS_ONCHAIN_PHASE must be sponsored, direct, or both; got ${phase}`);
  }

  const maxRuns = parsePositiveSafeInteger(
    envValue(fileEnv, cli, 'maxRuns', 'STELIS_ONCHAIN_MAX_RUNS', '20'),
    'STELIS_ONCHAIN_MAX_RUNS',
  );
  const directGasBudgetMist = parseNonNegativeBigInt(
    envValue(
      fileEnv,
      cli,
      'directGasBudgetMist',
      'STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST',
      DEFAULT_DIRECT_GAS_BUDGET_MIST.toString(),
    ),
    'STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST',
  );
  if (directGasBudgetMist <= 0n) {
    throw new Error('STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST must be > 0');
  }
  const minSuiReserveMist = parseNonNegativeBigInt(
    envValue(fileEnv, cli, 'minSuiReserveMist', 'STELIS_ONCHAIN_MIN_SUI_RESERVE_MIST', '0'),
    'STELIS_ONCHAIN_MIN_SUI_RESERVE_MIST',
  );
  const minSettlementTokenRaw = parseNonNegativeBigInt(
    envValue(fileEnv, cli, 'minSettlementTokenRaw', 'STELIS_ONCHAIN_MIN_SETTLEMENT_TOKEN_RAW', '0'),
    'STELIS_ONCHAIN_MIN_SETTLEMENT_TOKEN_RAW',
  );
  const slippageBps = parseNonNegativeSafeInteger(
    envValue(fileEnv, cli, 'slippageBps', 'STELIS_ONCHAIN_SLIPPAGE_BPS', '200'),
    'STELIS_ONCHAIN_SLIPPAGE_BPS',
  );
  if (slippageBps > 500) throw new Error('STELIS_ONCHAIN_SLIPPAGE_BPS must be <= 500');

  const runStartedAt = new Date();
  const runId = timestampForFileName(runStartedAt);
  const { rawPath, reportPath } = resolveOutputPaths({ fileEnv, cli, runId });
  const requireZeroSuiForSponsored =
    envValue(
      fileEnv,
      cli,
      'requireZeroSuiForSponsored',
      'STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED',
      'false',
    ) === 'true';

  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  const sdk = await StelisSDK.connect(apiUrl);
  if (sdk.network === 'mainnet' && !cli.allowMainnet) {
    throw new Error(
      'Refusing to run on mainnet. Pass --allow-mainnet only if this is intentional.',
    );
  }
  const grpcBaseUrl =
    envValue(fileEnv, cli, 'grpcUrl', 'STELIS_ONCHAIN_GRPC_URL') ?? defaultGrpcBaseUrl(sdk.network);
  const client = new SuiGrpcClient({ network: sdk.network, baseUrl: grpcBaseUrl });

  const settlementSwapPath = resolveSettlementSwapPath(
    sdk,
    envValue(fileEnv, cli, 'settlementTokenType', 'STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE'),
    envValue(
      fileEnv,
      cli,
      'settlementTokenSymbol',
      'STELIS_ONCHAIN_SETTLEMENT_TOKEN_SYMBOL',
      'DEEP',
    ),
  );

  console.log(`Wallet: ${address}`);
  console.log(`Network: ${sdk.network}`);
  console.log(`Relay API: ${apiUrl}`);
  console.log(`Sui gRPC: ${grpcBaseUrl}`);
  console.log(
    `Settlement token: ${settlementSwapPath.settlementTokenSymbol} (${settlementSwapPath.settlementTokenType})`,
  );
  console.log(`Phase: ${phase}`);

  const initialSui = await getBalanceMist(client, address, SUI_TYPE);
  const initialToken = await getBalanceMist(
    client,
    address,
    settlementSwapPath.settlementTokenType,
  );
  const initialVaultStatus = await getUserVaultStatus(client, sdk.config.vaultRegistryId, address);
  console.log(`Pre-execution SUI balance: ${formatMist(initialSui)}`);
  console.log(
    `Pre-execution ${settlementSwapPath.settlementTokenSymbol} balance: ${formatDecimal(initialToken, settlementSwapPath.settlementTokenDecimals)} (${initialToken.toString()} raw)`,
  );
  console.log(`User Vault: ${formatUserVaultStatus(initialVaultStatus)}`);
  console.log(
    `User Vault credit: ${formatMist(initialVaultStatus.creditMist)} (${initialVaultStatus.creditMist.toString()} MIST)`,
  );

  if (!cli.execute) {
    console.log('');
    console.log('Balance check only. No transaction was submitted.');
    console.log('Pass --execute to submit on-chain transactions.');
    return;
  }

  assertExecutableBalances({
    phase,
    initialSui,
    initialToken,
    settlementSwapPath,
    minSettlementTokenRaw,
    minSuiReserveMist,
    directGasBudgetMist,
    requireZeroSuiForSponsored,
  });

  await ensureRawWritable(rawPath);
  await ensureReportDirectory(reportPath);

  const ctx = {
    sdk,
    apiUrl,
    client,
    keypair,
    address,
    network: sdk.network,
    packageId: sdk.config.packageId,
    settlementSwapPath,
    settlementTokenType: settlementSwapPath.settlementTokenType,
    sponsoredMaxRuns: maxRuns,
    directMaxRuns: maxRuns,
    directGasBudgetMist,
    minSuiReserveMist,
    minSettlementTokenRaw,
    slippageBps,
    rawPath,
    requireZeroSuiForSponsored,
  };

  const sponsoredStats = includesPhase(phase, PHASE.SPONSORED)
    ? await runSponsoredPhase(ctx)
    : null;
  const directStats = includesPhase(phase, PHASE.DIRECT) ? await runDirectPhase(ctx) : null;
  printSummary(sponsoredStats, directStats, settlementSwapPath);
  await writeMarkdownReport(reportPath, {
    runStartedAt,
    completedAt: new Date(),
    phase,
    network: sdk.network,
    packageId: sdk.config.packageId,
    settlementSwapPath,
    sponsoredMaxRuns: maxRuns,
    directMaxRuns: maxRuns,
    initialSui,
    initialToken,
    initialVaultStatus,
    sponsoredStats,
    directStats,
  });
  console.log(`Raw data written: ${rawPath}`);
  console.log(`Report written: ${reportPath}`);
}

main().catch((err) => {
  console.error(`Failed: ${summarizeError(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
