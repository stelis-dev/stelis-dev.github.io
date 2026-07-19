#!/usr/bin/env node
/**
 * Empty execution benchmark for local testnet use.
 *
 * This script intentionally sends no user commands in the Transaction.
 * In the sponsored phase, the Host appends Stelis settlement and submits
 * the sponsored transaction. In the direct phase, the wallet submits a
 * plain empty SUI transaction.
 */
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, isValidTransactionDigest, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { redactEndpointUrl, redactSensitiveText } from '@stelis/core-api/observability';
import {
  parseRelaySponsorResponse,
  parseHostErrorResponse,
  HOST_ERROR_HTTP_STATUS,
  RELAY_SPONSOR_ERROR_CODES,
  SLIPPAGE_CAP_BPS,
  SUI_CHAIN_IDENTIFIERS,
} from '@stelis/contracts';
import {
  assertSuiNetwork,
  buildSuiTransaction,
  computeExecutionCostClaim,
  createSuiEndpointSnapshot,
  DEFAULT_SLIPPAGE_BPS,
  executeSuiTransaction,
  getSuiBalance,
  getSuiTransactionBalanceChanges,
  getSuiTransactionEffects,
  getSuiTransactionEvents,
} from '@stelis/core-relay';
import { StelisApiException, StelisSDK } from '@stelis/sdk';
import { verifySettleEventResultAgainstExpected } from '@stelis/sdk/server';
import {
  classifyVaultSnapshots,
  classifySponsorPostOutcome,
  composeBenchmarkRecord,
  measureSettlementTokenBalanceChanges,
  parseSpendableBalanceRaw,
  projectBenchmarkErrorMeta,
  resolveSettlementSwapPathByType,
  summarizeTokenMeasurements,
} from './empty-execution-benchmark-model.mjs';
import {
  appendDurableJsonl,
  createDurableJsonl,
  defaultBenchmarkJournalRoot,
  EmptyExecutionBenchmarkJournal,
  recoverBenchmarkAttempt,
  writeExclusiveText,
} from './empty-execution-benchmark-journal.mjs';

const DEFAULT_DIRECT_GAS_BUDGET_MIST = 3_000_000n;
const RATE_LIMIT_RETRY_PADDING_MS = 250;
const DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS = 1_000;
const DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT = 10;
const BENCHMARK_EVIDENCE_SCHEMA = 'stelis_empty_execution_benchmark_v1';
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
const VALUE_CLI_OPTIONS = Object.freeze({
  '--phase': 'phase',
  '--api-url': 'apiUrl',
  '--grpc-url': 'grpcUrl',
  '--settlement-token-type': 'settlementTokenType',
  '--sponsored-max-runs': 'sponsoredMaxRuns',
  '--direct-max-runs': 'directMaxRuns',
  '--slippage-bps': 'slippageBps',
  '--direct-gas-budget-mist': 'directGasBudgetMist',
  '--min-sui-reserve-mist': 'minSuiReserveMist',
  '--require-zero-sui-for-sponsored': 'requireZeroSuiForSponsored',
  '--raw-dir': 'rawDir',
  '--report-dir': 'reportDir',
});
const SUPPORTED_ENV_KEYS = new Set([
  'STELIS_ONCHAIN_RELAY_API_URL',
  'STELIS_ONCHAIN_USER_SECRET_KEY',
  'STELIS_ONCHAIN_GRPC_URL',
  'STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE',
  'STELIS_ONCHAIN_PHASE',
  'STELIS_ONCHAIN_SPONSORED_MAX_RUNS',
  'STELIS_ONCHAIN_DIRECT_MAX_RUNS',
  'STELIS_ONCHAIN_SLIPPAGE_BPS',
  'STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED',
  'STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST',
  'STELIS_ONCHAIN_MIN_SUI_RESERVE_MIST',
  'STELIS_ONCHAIN_RAW_DIR',
  'STELIS_ONCHAIN_REPORT_DIR',
]);
const EXHAUSTION_CODES = new Set(['INSUFFICIENT_BALANCE', 'INSUFFICIENT_SETTLE_INPUT']);
const EXHAUSTION_SUBCODES = new Set(['INSUFFICIENT_FUNDS', 'INSUFFICIENT_SETTLE_INPUT']);

class SponsorResponseContractError extends Error {
  constructor(message, candidateDigest, cause) {
    super(message, { cause });
    this.name = 'SponsorResponseContractError';
    this.candidateDigest = candidateDigest;
  }
}

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
    '  --settlement-token-type <type>     Exact settlement token type from /relay/config.',
    '  --sponsored-max-runs <n>           Sponsored verified-success cap.',
    '  --direct-max-runs <n>              Direct verified-success cap.',
    '  --slippage-bps <bps>                Sponsored prepare slippage tolerance.',
    '  --direct-gas-budget-mist <mist>    Direct empty transaction gas budget.',
    '  --min-sui-reserve-mist <mist>      Direct phase stop reserve.',
    '  --require-zero-sui-for-sponsored <true|false>',
    '                                     Require an isolated zero-SUI sponsored wallet.',
    '  --grpc-url <url>                   Testnet Sui gRPC endpoint.',
    '  --raw-dir <path>                   Directory for timestamped raw JSONL files.',
    '  --report-dir <path>                Directory for generated Markdown reports.',
  ].join('\n');
}

async function parseEnvFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
  const parsed = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      throw new Error(`${filePath}:${index + 1} must be KEY=VALUE`);
    }
    const key = trimmed.slice(0, idx).trim();
    if (!SUPPORTED_ENV_KEYS.has(key)) {
      throw new Error(`${filePath}:${index + 1} contains unsupported setting ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error(`${filePath}:${index + 1} repeats ${key}`);
    }
    parsed[key] = stripOptionalQuotes(trimmed.slice(idx + 1).trim());
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

function assertSupportedProcessEnv(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('STELIS_ONCHAIN_') && !SUPPORTED_ENV_KEYS.has(key)) {
      throw new Error(`Process environment contains unsupported setting ${key}`);
    }
  }
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--execute') {
      out.execute = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const option = eq === -1 ? arg : arg.slice(0, eq);
      const key = VALUE_CLI_OPTIONS[option];
      if (!key) throw new Error(`Unknown option: ${option}`);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${option}`);
      }
      out[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
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
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Relay API URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Relay API URL must not contain embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Relay API URL must not contain a query string or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/relay')) parsed.pathname = `${parsed.pathname}/relay`;
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeGrpcUrl(raw) {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Sui gRPC URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Sui gRPC URL must not contain embedded credentials');
  }
  if (parsed.hash) throw new Error('Sui gRPC URL must not contain a fragment');
  return parsed.toString().replace(/\/+$/, '');
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

function parseBoolean(raw, label) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${label} must be true or false, got ${raw}`);
}

function timestampForFileName(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveOutputPaths({ fileEnv, cli, runId }) {
  const rawDir = path.resolve(
    repoRoot,
    envValue(fileEnv, cli, 'rawDir', 'STELIS_ONCHAIN_RAW_DIR', '.WORK/onchain-tests/raw'),
  );
  const reportDir = path.resolve(
    repoRoot,
    envValue(fileEnv, cli, 'reportDir', 'STELIS_ONCHAIN_REPORT_DIR', '.WORK/onchain-tests/reports'),
  );
  return {
    rawPath: path.join(rawDir, `${runId}-empty-execution-benchmark.jsonl`),
    reportPath: path.join(reportDir, `${runId}-empty-execution-benchmark.md`),
  };
}

async function getSpendableBalanceRaw(endpoints, owner, coinType) {
  const balance = await getSuiBalance(endpoints, { owner, coinType });
  return parseSpendableBalanceRaw(balance, coinType);
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

async function getUserVaultStatus(sdk, client, address) {
  const credit = await sdk.queryUserCredit(client, address);
  return {
    vaultObjectId: credit.vaultObjectId,
    needsCreate: credit.needsCreate,
    creditMist: parseNonNegativeBigInt(credit.credit, 'User Vault credit'),
    lastNonce: parseNonNegativeBigInt(credit.lastNonce, 'User Vault last nonce'),
  };
}

function gasNetMist(gasUsed) {
  return computeExecutionCostClaim(gasUsed).simGas;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurrentFailure(err, code) {
  return (
    err instanceof StelisApiException &&
    err.code === code &&
    err.status === HOST_ERROR_HTTP_STATUS[code]
  );
}

function isExhaustionError(err, expectedDigest) {
  if (!(err instanceof StelisApiException)) return false;
  if (EXHAUSTION_CODES.has(err.code)) return isCurrentFailure(err, err.code);
  if (typeof err.meta?.subcode !== 'string' || !EXHAUSTION_SUBCODES.has(err.meta.subcode)) {
    return false;
  }
  if (isCurrentFailure(err, 'SPONSOR_PREFLIGHT_FAILED')) return true;
  return (
    expectedDigest !== null &&
    isCurrentFailure(err, 'SPONSOR_ONCHAIN_FAILED') &&
    sponsorErrorDigest(err) === expectedDigest
  );
}

function normalizeErrorMeta(meta) {
  return projectBenchmarkErrorMeta(meta);
}

function describeError(err) {
  if (err instanceof StelisApiException) {
    return {
      name: err.name,
      code: err.code,
      status: err.status,
      message: redactSensitiveText(err.message),
      meta: normalizeErrorMeta(err.meta),
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: redactSensitiveText(err.message),
    };
  }
  return {
    name: 'UnknownError',
    message: redactSensitiveText(String(err)),
  };
}

async function observe(read) {
  try {
    return { status: 'observed', value: await read() };
  } catch (error) {
    return { status: 'unavailable', error: describeError(error) };
  }
}

function summarizeError(err) {
  const detail = describeError(err);
  const code = detail.code ? ` code=${detail.code};` : '';
  return `${detail.name}:${code} ${detail.message}`;
}

function parseRetryAfterMs(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

function rateLimitRetryAfterMs(err) {
  if (!(err instanceof StelisApiException) || err.status !== 429 || err.code !== 'RATE_LIMITED') {
    return null;
  }
  return parseRetryAfterMs(err.meta?.retryAfterMs);
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
  const bytes = new TextEncoder().encode(raw);
  return `bodyBytes=${bytes.length}; bodySha256=${createHash('sha256').update(bytes).digest('hex')}`;
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
    let apiError;
    try {
      apiError = parseHostErrorResponse(data, RELAY_SPONSOR_ERROR_CODES, res.status);
    } catch (error) {
      throw new Error(
        `Relay API /sponsor returned a non-current error response (HTTP ${res.status}; ${summarizeHttpBody(raw)})`,
        { cause: error },
      );
    }
    const code = apiError.code;
    const message = apiError.error;
    const extra = projectBenchmarkErrorMeta(apiError);
    throw new StelisApiException(
      code,
      message,
      res.status,
      extra && Object.keys(extra).length > 0 ? extra : undefined,
    );
  }
  if (data === undefined) {
    throw new Error(
      `Relay API /sponsor returned a non-JSON success response (HTTP ${res.status}; ${summarizeHttpBody(raw)})`,
    );
  }
  try {
    return parseRelaySponsorResponse(data);
  } catch (err) {
    const candidateDigest = isRecord(data) && typeof data.digest === 'string' ? data.digest : null;
    throw new SponsorResponseContractError(
      `Relay API /sponsor returned a response outside the current Host wire contract (HTTP ${res.status}; ${summarizeHttpBody(raw)})`,
      candidateDigest,
      err,
    );
  }
}

function stringifyRecord(record) {
  return JSON.parse(
    JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
}

function projectBenchmarkRecord(ctx, fields) {
  const {
    evidenceSchema: _evidenceSchema,
    network: _network,
    chainIdentifier: _chainIdentifier,
    relayApiUrl: _relayApiUrl,
    relayEndpointHash: _relayEndpointHash,
    suiGrpcUrl: _suiGrpcUrl,
    suiGrpcEndpointHash: _suiGrpcEndpointHash,
    stelisPackageId: _stelisPackageId,
    address: _address,
    settlementTokenType: _settlementTokenType,
    ...recordFields
  } = fields;
  const provenance = benchmarkProvenance(ctx);
  return stringifyRecord(composeBenchmarkRecord(provenance, recordFields));
}

async function createBenchmarkEvidence(ctx, fields) {
  await createDurableJsonl(ctx.rawPath, projectBenchmarkRecord(ctx, fields));
}

async function appendBenchmarkRecord(ctx, fields) {
  await appendDurableJsonl(ctx.rawPath, projectBenchmarkRecord(ctx, fields));
}

function benchmarkProvenance(ctx) {
  return {
    evidenceSchema: BENCHMARK_EVIDENCE_SCHEMA,
    network: ctx.network,
    chainIdentifier: ctx.chainIdentifier,
    relayApiUrl: ctx.relayApiEvidenceUrl,
    relayEndpointHash: ctx.relayEndpointHash,
    suiGrpcUrl: ctx.suiGrpcEvidenceUrl,
    suiGrpcEndpointHash: ctx.suiGrpcEndpointHash,
    stelisPackageId: ctx.packageId,
    address: ctx.address,
    settlementTokenType: ctx.settlementSwapPath.settlementTokenType,
  };
}

async function recoverActiveAttempt(journal, endpoints) {
  const resolved = await recoverBenchmarkAttempt(journal, async (digest) => {
    return getSuiTransactionEffects(endpoints, { digest });
  });
  if (resolved === null) return false;

  console.log(
    `Recovered prior ${resolved.mode} attempt ${resolved.attemptId}; no new transaction work was started. Rerun deliberately if another benchmark is required.`,
  );
  return true;
}

async function requestSponsoredPreparation({
  sdk,
  client,
  keypair,
  address,
  settlementTokenType,
  slippageBps,
  runLabel,
  orderId,
}) {
  const tx = new Transaction();
  const prepared = await withRateLimitRetry(`${runLabel} prepare`, () =>
    sdk.prepareSponsored(tx, {
      client,
      addr: address,
      settlementToken: { type: settlementTokenType },
      slippageBps,
      orderId,
      prepareAuthorizationSigner: async (messageBytes) => {
        const { signature } = await keypair.signPersonalMessage(messageBytes);
        return signature;
      },
    }),
  );
  if (prepared.orderId !== orderId) {
    throw new Error(`${runLabel} prepare response did not echo the requested orderId`);
  }
  return prepared;
}

async function signSponsoredPreparation(prepared, keypair) {
  const { signature: userSignature } = await keypair.signTransaction(fromBase64(prepared.txBytes));
  const expectedDigest = await Transaction.from(prepared.txBytes).getDigest();
  return {
    expectedDigest,
    sponsorRequest: {
      txBytes: prepared.txBytes,
      userSignature,
      receiptId: prepared.receiptId,
    },
  };
}

async function waitForTransactionWithEvents(client, endpoints, digest) {
  await client.waitForTransaction({
    digest,
    include: { effects: true, events: true },
  });
  return getSuiTransactionEvents(endpoints, { digest });
}

async function prepareDirectEmptyTransaction({ endpoints, keypair, address, directGasBudgetMist }) {
  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(directGasBudgetMist.toString());
  const txBytes = await buildSuiTransaction(endpoints, { transaction: tx });
  const expectedDigest = await Transaction.from(txBytes).getDigest();
  const { signature } = await keypair.signTransaction(txBytes);
  return { txBytes, signature, expectedDigest };
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length);
}

function emptySponsoredFlowStats() {
  return {
    runs: 0,
    tokenMeasurements: [],
    totalCostMist: [],
    executionCostClaimMist: [],
    actualGasMist: [],
    hostMarginMist: [],
  };
}

function createSponsoredStats() {
  return {
    runs: 0,
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
  stats.totalCostMist.push(metrics.totalCostMist);
  stats.executionCostClaimMist.push(metrics.executionCostClaimMist);
  stats.actualGasMist.push(metrics.actualGasMist);
  stats.hostMarginMist.push(metrics.hostMarginMist);

  const flowStats = stats.byFlow[flowKey];
  if (!flowStats) throw new Error(`Unknown sponsored flow: ${flowKey}`);
  flowStats.runs++;
  flowStats.tokenMeasurements.push(metrics.tokenMeasurement);
  flowStats.totalCostMist.push(metrics.totalCostMist);
  flowStats.executionCostClaimMist.push(metrics.executionCostClaimMist);
  flowStats.actualGasMist.push(metrics.actualGasMist);
  flowStats.hostMarginMist.push(metrics.hostMarginMist);
}

function assertExecutableBalances({
  phase,
  initialSuiObservation,
  minSuiReserveMist,
  directGasBudgetMist,
  requireZeroSuiForSponsored,
}) {
  const needsSponsored = includesPhase(phase, PHASE.SPONSORED);
  const needsDirect = includesPhase(phase, PHASE.DIRECT);

  if (!needsDirect && !(needsSponsored && requireZeroSuiForSponsored)) return;
  const initialSui = requireObservedBalance(initialSuiObservation, 'Pre-execution SUI balance');

  if (needsSponsored && requireZeroSuiForSponsored && initialSui !== 0n) {
    throw new Error(
      `Cannot start sponsored phase: wallet has ${initialSui.toString()} MIST (${formatMist(initialSui)}), but STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED=true.`,
    );
  }
  const requiredDirectBalanceMist = minSuiReserveMist + directGasBudgetMist;
  if (needsDirect && initialSui < requiredDirectBalanceMist) {
    throw new Error(
      `Cannot start direct phase: SUI balance ${initialSui.toString()} is below reserve + gas budget ${requiredDirectBalanceMist.toString()}.`,
    );
  }
}

function sponsorErrorDigest(err) {
  if (err instanceof StelisApiException && isValidTransactionDigest(err.meta?.digest)) {
    return err.meta.digest;
  }
  return err instanceof SponsorResponseContractError &&
    isValidTransactionDigest(err.candidateDigest)
    ? err.candidateDigest
    : null;
}

function sponsorErrorOutcome(err, digest, expectedDigest) {
  const currentCode =
    err instanceof StelisApiException &&
    RELAY_SPONSOR_ERROR_CODES.includes(err.code) &&
    isCurrentFailure(err, err.code)
      ? err.code
      : null;
  return classifySponsorPostOutcome({
    currentCode,
    reportedDigest: digest,
    expectedDigest,
  });
}

function assertSponsorResponseMatchesPrepared({
  sponsorResponse,
  prepared,
  expectedDigest,
  orderId,
}) {
  if (sponsorResponse.digest !== expectedDigest) {
    throw new Error(
      `Sponsor response digest ${sponsorResponse.digest} does not match prepared transaction ${expectedDigest}`,
    );
  }
  if (sponsorResponse.executionCostClaim !== prepared.cost.executionCostClaim) {
    throw new Error(
      `Sponsor executionCostClaim ${sponsorResponse.executionCostClaim} does not match prepare ${prepared.cost.executionCostClaim}`,
    );
  }
  if (sponsorResponse.orderId !== orderId) {
    throw new Error('Sponsor response did not echo the prepared orderId');
  }
}

function assertSponsorEffectsMatchTerminal(sponsorEffects, terminal) {
  if (!isRecord(sponsorEffects)) {
    throw new Error('Sponsor response effects must be a current TransactionEffects object');
  }
  if (sponsorEffects.transactionDigest !== terminal.digest) {
    throw new Error(
      `Sponsor response effects digest ${String(sponsorEffects.transactionDigest)} does not match terminal ${terminal.digest}`,
    );
  }
  if (
    !isRecord(sponsorEffects.status) ||
    sponsorEffects.status.success !== true ||
    sponsorEffects.status.error !== null
  ) {
    throw new Error('Sponsor response effects do not carry a successful current status');
  }
  if (!isRecord(sponsorEffects.gasUsed)) {
    throw new Error('Sponsor response effects do not carry canonical gasUsed');
  }
  for (const field of ['computationCost', 'storageCost', 'storageRebate']) {
    if (sponsorEffects.gasUsed[field] !== terminal.effects.gasUsed[field]) {
      throw new Error(
        `Sponsor response effects gasUsed.${field} does not match the on-chain terminal result`,
      );
    }
  }
  computeExecutionCostClaim({
    computationCost: sponsorEffects.gasUsed.computationCost,
    storageCost: sponsorEffects.gasUsed.storageCost,
    storageRebate: sponsorEffects.gasUsed.storageRebate,
  });
}

function assertVerifiedSettleEconomics(event, prepared) {
  const executionCostClaimMist = parseNonNegativeBigInt(
    prepared.cost.executionCostClaim,
    'executionCostClaim',
  );
  const hostFeeMist = parseNonNegativeBigInt(prepared.cost.quotedHostFee, 'quotedHostFee');
  const protocolFeeMist = parseNonNegativeBigInt(prepared.cost.protocolFee, 'protocolFee');
  const expectedPayoutMist = executionCostClaimMist + hostFeeMist;
  const expectedDeductionMist = expectedPayoutMist + protocolFeeMist;
  if (prepared.totalCostMist !== expectedDeductionMist) {
    throw new Error(
      `Prepared total cost ${prepared.totalCostMist} does not match its current cost fields ${expectedDeductionMist}`,
    );
  }
  const eventPayoutMist = parseNonNegativeBigInt(event.payout, 'SettleEvent.payout');
  const eventTotalInMist = parseNonNegativeBigInt(event.totalIn, 'SettleEvent.totalIn');
  if (eventPayoutMist !== expectedPayoutMist) {
    throw new Error(
      `SettleEvent payout ${eventPayoutMist} does not match claim + Host fee ${expectedPayoutMist}`,
    );
  }
  if (eventTotalInMist < expectedDeductionMist) {
    throw new Error(
      `SettleEvent totalIn ${eventTotalInMist} is below required deduction ${expectedDeductionMist}`,
    );
  }
  return {
    executionCostClaimMist,
    hostFeeMist,
    protocolFeeMist,
    payoutMist: eventPayoutMist,
    totalInMist: eventTotalInMist,
  };
}

async function readInitialWalletSnapshot(ctx) {
  const [sui, settlementToken, vault] = await Promise.all([
    observe(() => getSpendableBalanceRaw(ctx.endpoints, ctx.address, SUI_TYPE_ARG)),
    observe(() =>
      getSpendableBalanceRaw(
        ctx.endpoints,
        ctx.address,
        ctx.settlementSwapPath.settlementTokenType,
      ),
    ),
    observe(() => getUserVaultStatus(ctx.sdk, ctx.client, ctx.address)),
  ]);
  return { sui, settlementToken, vault };
}

async function readSponsoredDiagnosticSnapshot(ctx) {
  const [sui, vault] = await Promise.all([
    observe(() => getSpendableBalanceRaw(ctx.endpoints, ctx.address, SUI_TYPE_ARG)),
    observe(() => getUserVaultStatus(ctx.sdk, ctx.client, ctx.address)),
  ]);
  return { sui, vault };
}

function requireObservedBalance(observation, label) {
  if (observation.status !== 'observed') {
    throw new Error(`${label} is unavailable: ${observation.error.message}`);
  }
  return observation.value;
}

async function appendSubmittedUnverified(ctx, fields, err, attempt) {
  await appendBenchmarkRecord(ctx, {
    ...fields,
    recordType: 'terminal',
    outcome: 'submitted_unverified',
    reconciliationDigests: attempt.reconciliationDigests,
    error: describeError(err),
  });
}

async function runSponsoredPhase(ctx) {
  const stats = createSponsoredStats();

  for (let i = 1; i <= ctx.sponsoredMaxRuns; i++) {
    let attemptRecorded = false;
    let expectedDigest = null;
    let activeAttempt = null;
    try {
      const runLabel = `Sponsored #${i}`;
      const orderId = `stelis-empty:${ctx.runId}:${i}`;
      const beforeSnapshot = await readSponsoredDiagnosticSnapshot(ctx);
      if (
        ctx.requireZeroSuiForSponsored &&
        requireObservedBalance(beforeSnapshot.sui, `${runLabel} SUI balance`) !== 0n
      ) {
        const beforeSui = beforeSnapshot.sui.value;
        throw new Error(
          `Sponsored phase requires zero SUI, but wallet has ${beforeSui} MIST (${formatMist(beforeSui)}).`,
        );
      }

      console.log(`${runLabel}: preparing empty user PTB`);
      const prepared = await requestSponsoredPreparation({
        ...ctx,
        runLabel,
        orderId,
      });
      const sponsoredFlow = classifySponsoredProfile(prepared.profile);
      const preparationFields = {
        mode: PHASE.SPONSORED,
        executionKind: sponsoredFlow.key,
        sponsoredFlow: sponsoredFlow.key,
        sponsoredFlowLabel: sponsoredFlow.label,
        profile: prepared.profile,
        run: i,
        orderId,
        receiptId: prepared.receiptId,
        executedContractPackageId: ctx.packageId,
      };
      await appendBenchmarkRecord(ctx, {
        ...preparationFields,
        recordType: 'preparation',
        outcome: 'host_prepared',
        diagnosticSnapshotBefore: beforeSnapshot,
      });

      const { expectedDigest: signedDigest, sponsorRequest } = await signSponsoredPreparation(
        prepared,
        ctx.keypair,
      );
      expectedDigest = signedDigest;
      const baseFields = { ...preparationFields, expectedDigest };
      activeAttempt = await ctx.journal.beginAttempt({
        provenance: benchmarkProvenance(ctx),
        mode: PHASE.SPONSORED,
        expectedDigest,
      });
      await appendBenchmarkRecord(ctx, {
        ...baseFields,
        recordType: 'attempt',
        outcome: 'sponsor_ready',
      });
      attemptRecorded = true;
      activeAttempt = await ctx.journal.markSubmissionStarted(activeAttempt);

      let sponsorResponse;
      try {
        sponsorResponse = await withRateLimitRetry(`${runLabel} sponsor`, () =>
          postRelaySponsor(ctx.apiUrl, sponsorRequest),
        );
      } catch (err) {
        const digest = sponsorErrorDigest(err);
        const outcome = sponsorErrorOutcome(err, digest, expectedDigest);
        if (outcome === 'submitted_failed') {
          let loaded;
          let terminal;
          try {
            loaded = await waitForTransactionWithEvents(ctx.client, ctx.endpoints, expectedDigest);
            terminal = loaded;
            if (terminal.outcome !== 'failure') {
              throw new Error(
                `${runLabel} Host-reported on-chain failure was not proven by the matching failed Sui terminal result`,
              );
            }
          } catch (terminalProofError) {
            activeAttempt = await ctx.journal.markUncertain(activeAttempt, digest);
            await appendBenchmarkRecord(ctx, {
              ...baseFields,
              recordType: 'terminal',
              outcome: 'submitted_unverified',
              digest,
              reconciliationDigests: activeAttempt.reconciliationDigests,
              hostError: describeError(err),
              terminalProofError: describeError(terminalProofError),
            });
            throw terminalProofError;
          }

          await ctx.journal.resolveSubmittedResult(activeAttempt, loaded);
          activeAttempt = null;
          await appendBenchmarkRecord(ctx, {
            ...baseFields,
            recordType: 'terminal',
            outcome: 'submitted_failed',
            digest: terminal.digest,
            gasMist: gasNetMist(terminal.effects.gasUsed),
            error: terminal.error,
            hostError: describeError(err),
          });
          throw err;
        }

        let reconciliationDigests;
        switch (outcome) {
          case 'submission_uncertain':
          case 'submitted_unverified':
            activeAttempt = await ctx.journal.markUncertain(activeAttempt, digest);
            reconciliationDigests = activeAttempt.reconciliationDigests;
            break;
          case 'sponsor_rejected':
            await ctx.journal.resolveSponsorRejected(activeAttempt);
            activeAttempt = null;
            reconciliationDigests = [];
            break;
          default:
            throw new Error(`Unexpected definitive sponsor outcome: ${outcome}`);
        }
        await appendBenchmarkRecord(ctx, {
          ...baseFields,
          recordType: 'terminal',
          outcome,
          digest,
          reportedDigestMatchesExpected: digest === null ? null : digest === expectedDigest,
          reconciliationDigests,
          error: describeError(err),
        });
        throw err;
      }

      try {
        assertSponsorResponseMatchesPrepared({
          sponsorResponse,
          prepared,
          expectedDigest,
          orderId,
        });
      } catch (err) {
        activeAttempt = await ctx.journal.markUncertain(activeAttempt, sponsorResponse.digest);
        await appendSubmittedUnverified(
          ctx,
          { ...baseFields, digest: sponsorResponse.digest },
          err,
          activeAttempt,
        );
        throw err;
      }

      let loaded;
      try {
        loaded = await waitForTransactionWithEvents(
          ctx.client,
          ctx.endpoints,
          sponsorResponse.digest,
        );
      } catch (err) {
        activeAttempt = await ctx.journal.markUncertain(activeAttempt);
        await appendSubmittedUnverified(
          ctx,
          { ...baseFields, digest: sponsorResponse.digest },
          err,
          activeAttempt,
        );
        throw err;
      }

      const terminal = loaded;
      if (terminal.outcome === 'failure') {
        const actualGasMist = gasNetMist(terminal.effects.gasUsed);
        await ctx.journal.resolveSubmittedResult(activeAttempt, loaded);
        activeAttempt = null;
        await appendBenchmarkRecord(ctx, {
          ...baseFields,
          recordType: 'terminal',
          outcome: 'submitted_failed',
          digest: terminal.digest,
          gasMist: actualGasMist,
          error: terminal.error,
        });
        throw new Error(`${runLabel} failed on-chain: ${JSON.stringify(terminal.error)}`);
      }
      let verifiedEvent;
      let economics;
      try {
        assertSponsorEffectsMatchTerminal(sponsorResponse.effects, terminal);
        verifiedEvent = verifySettleEventResultAgainstExpected(terminal, terminal.digest, {
          receiptId: prepared.receiptId,
          user: ctx.address,
          orderId,
          executionCostClaimMist: sponsorResponse.executionCostClaim,
          quotedHostFeeMist: prepared.cost.quotedHostFee,
          protocolFeeMist: prepared.cost.protocolFee,
        });
        economics = assertVerifiedSettleEconomics(verifiedEvent, prepared);
      } catch (err) {
        activeAttempt = await ctx.journal.markUncertain(activeAttempt);
        await appendSubmittedUnverified(
          ctx,
          { ...baseFields, digest: terminal.digest },
          err,
          activeAttempt,
        );
        throw err;
      }

      const transactionBalanceChanges = await getSuiTransactionBalanceChanges(ctx.endpoints, {
        digest: terminal.digest,
      });
      const tokenMeasurement = measureSettlementTokenBalanceChanges(
        transactionBalanceChanges.balanceChanges,
        ctx.address,
        ctx.settlementSwapPath.settlementTokenType,
      );
      const afterSnapshot = await readSponsoredDiagnosticSnapshot(ctx);
      const vaultSnapshotTransition = classifyVaultSnapshots(
        beforeSnapshot.vault,
        afterSnapshot.vault,
      );
      const actualGasMist = gasNetMist(terminal.effects.gasUsed);
      const hostMarginMist = economics.payoutMist - actualGasMist;

      await ctx.journal.resolveSubmittedResult(activeAttempt, loaded);
      activeAttempt = null;

      recordSponsoredMetrics(stats, sponsoredFlow.key, {
        tokenMeasurement,
        totalCostMist: prepared.totalCostMist,
        executionCostClaimMist: economics.executionCostClaimMist,
        actualGasMist,
        hostMarginMist,
      });

      await appendBenchmarkRecord(ctx, {
        ...baseFields,
        recordType: 'terminal',
        outcome: 'success',
        digest: terminal.digest,
        gasMist: actualGasMist,
        settleEventVerified: true,
        settleEventReceiptId: verifiedEvent.receiptId,
        settleEventNonce: verifiedEvent.nonce,
        settleEventOrderIdHash: verifiedEvent.orderIdHash,
        settleEventUser: verifiedEvent.user,
        settleEventPayoutMist: economics.payoutMist,
        settleEventTotalInMist: economics.totalInMist,
        settleEventConfigVersion: verifiedEvent.configVersion,
        settleEventTimestampMs: verifiedEvent.execTimestampMs,
        executionCostClaimMist: economics.executionCostClaimMist,
        hostFeeMist: economics.hostFeeMist,
        protocolFeeMist: economics.protocolFeeMist,
        userTotalCostMist: prepared.totalCostMist,
        hostRecoveryMist: economics.payoutMist,
        hostMarginMist,
        settlementTokenMeasurement: tokenMeasurement,
        diagnosticSnapshotBefore: beforeSnapshot,
        diagnosticSnapshotAfter: afterSnapshot,
        vaultSnapshotTransition,
      });
      console.log(
        `${runLabel} [${sponsoredFlow.label}]: ${terminal.digest} gas=${formatMist(actualGasMist)} hostMargin=${formatMist(hostMarginMist)} settlementTokenChange=${tokenMeasurement.kind}`,
      );
    } catch (err) {
      const reportedDigest = sponsorErrorDigest(err);
      if (expectedDigest !== null && reportedDigest !== null && reportedDigest !== expectedDigest) {
        throw err;
      }
      if (isExhaustionError(err, expectedDigest)) {
        const stopReason = describeError(err);
        stats.stopReason = stopReason;
        if (!attemptRecorded) {
          await appendBenchmarkRecord(ctx, {
            mode: PHASE.SPONSORED,
            recordType: 'terminal',
            outcome: 'stopped_before_prepare',
            run: i,
            executedContractPackageId: null,
            digest: null,
            gasMist: null,
            error: stopReason,
          });
        }
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
    seenDigests: await ctx.journal.resolvedDigests(),
  };

  let i = 1;
  let duplicateRetriesForRun = 0;
  while (i <= ctx.directMaxRuns) {
    const beforeSui = await getSpendableBalanceRaw(ctx.endpoints, ctx.address, SUI_TYPE_ARG);
    const requiredDirectBalanceMist = ctx.minSuiReserveMist + ctx.directGasBudgetMist;
    if (beforeSui < requiredDirectBalanceMist) {
      const stopReason = {
        name: 'DirectBalanceGuard',
        message: `SUI balance ${beforeSui.toString()} is below reserve + gas budget ${requiredDirectBalanceMist.toString()}.`,
      };
      stats.stopReason = stopReason;
      await appendBenchmarkRecord(ctx, {
        mode: PHASE.DIRECT,
        executionKind: EXECUTION_KIND.DIRECT,
        recordType: 'terminal',
        outcome: 'stopped_before_build',
        run: i,
        digest: null,
        gasMist: null,
        suiBalanceBeforeMist: beforeSui,
        requiredDirectBalanceMist,
        error: stopReason,
      });
      console.log(`Direct stop: ${stopReason.message}`);
      break;
    }

    console.log(`Direct #${i}: building empty SUI PTB`);
    const prepared = await prepareDirectEmptyTransaction(ctx);
    if (stats.seenDigests.has(prepared.expectedDigest)) {
      stats.duplicateDigestRetries++;
      duplicateRetriesForRun++;
      if (duplicateRetriesForRun > DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT) {
        throw new Error(
          `Direct #${i} kept building duplicate digest ${prepared.expectedDigest} after ${DIRECT_DUPLICATE_DIGEST_RETRY_LIMIT} retries.`,
        );
      }
      console.log(
        `Direct #${i}: duplicate digest ${prepared.expectedDigest} before submit; waiting ${formatDurationMs(DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS)} before rebuild`,
      );
      await sleep(DIRECT_DUPLICATE_DIGEST_RETRY_WAIT_MS);
      continue;
    }

    const baseFields = {
      mode: PHASE.DIRECT,
      executionKind: EXECUTION_KIND.DIRECT,
      run: i,
      expectedDigest: prepared.expectedDigest,
      executedContractPackageId: null,
    };
    let activeAttempt = await ctx.journal.beginAttempt({
      provenance: benchmarkProvenance(ctx),
      mode: PHASE.DIRECT,
      expectedDigest: prepared.expectedDigest,
    });
    await appendBenchmarkRecord(ctx, {
      ...baseFields,
      recordType: 'attempt',
      outcome: 'prepared',
      suiBalanceBeforeMist: beforeSui,
      gasBudgetMist: ctx.directGasBudgetMist,
      reserveMist: ctx.minSuiReserveMist,
    });
    activeAttempt = await ctx.journal.markSubmissionStarted(activeAttempt);

    let result;
    try {
      result = await executeSuiTransaction(ctx.endpoints, {
        transaction: prepared.txBytes,
        signatures: [prepared.signature],
        expectedDigest: prepared.expectedDigest,
      });
    } catch (err) {
      activeAttempt = await ctx.journal.markUncertain(activeAttempt);
      await appendBenchmarkRecord(ctx, {
        ...baseFields,
        recordType: 'terminal',
        outcome: 'submission_uncertain',
        digest: null,
        reconciliationDigests: activeAttempt.reconciliationDigests,
        error: describeError(err),
      });
      throw err;
    }

    const terminal = result;
    if (terminal.outcome === 'failure') {
      const actualGasMist = gasNetMist(terminal.effects.gasUsed);
      await ctx.journal.resolveSubmittedResult(activeAttempt, result);
      activeAttempt = null;
      await appendBenchmarkRecord(ctx, {
        ...baseFields,
        recordType: 'terminal',
        outcome: 'submitted_failed',
        digest: terminal.digest,
        gasMist: actualGasMist,
        error: terminal.error,
      });
      throw new Error(`Direct #${i} failed on-chain: ${JSON.stringify(terminal.error)}`);
    }
    const actualGasMist = gasNetMist(terminal.effects.gasUsed);
    await ctx.journal.resolveSubmittedResult(activeAttempt, result);
    activeAttempt = null;

    stats.runs++;
    stats.seenDigests.add(terminal.digest);
    duplicateRetriesForRun = 0;
    stats.actualGasMist.push(actualGasMist);

    await appendBenchmarkRecord(ctx, {
      ...baseFields,
      recordType: 'terminal',
      outcome: 'success',
      digest: terminal.digest,
      gasMist: actualGasMist,
    });
    console.log(`Direct #${i}: ${terminal.digest} gas=${formatMist(actualGasMist)}`);
    i++;
  }
  return stats;
}

function printSummary(sponsoredStats, directStats, settlementSwapPath) {
  console.log('');
  console.log('Summary');
  let avgVaultCreditUseGas = null;
  let avgDirectGas = null;
  if (sponsoredStats) {
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
      const tokenSummary = summarizeTokenMeasurements(flowStats.tokenMeasurements);
      const flowAvgTokenSpent = average(tokenSummary.attributableSpentRaw);
      console.log(
        `  ${key}: ${flowStats.runs} run(s)${
          flowAvgGas === null ? '' : `, avg gas=${formatMist(flowAvgGas)}`
        } — ${flow.label}`,
      );
      console.log(
        `    settlement-token tx changes: debit=${tokenSummary.debit}, unchanged=${tokenSummary.unchanged}, credit=${tokenSummary.credit}, unavailable=${tokenSummary.unavailable}${
          flowAvgTokenSpent === null
            ? ''
            : `, avg attributable spend=${formatDecimal(flowAvgTokenSpent, settlementSwapPath.settlementTokenDecimals)} ${settlementSwapPath.settlementTokenSymbol}`
        }`,
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
  if (!error) return 'n/a';
  return `${error.code ?? error.name}: ${error.message}`;
}

function formatBalanceObservation(observation, format) {
  return observation.status === 'observed'
    ? format(observation.value)
    : `unavailable (${observation.error.name}: ${observation.error.message})`;
}

function formatVaultObservation(observation) {
  if (observation.status !== 'observed') {
    return `unavailable (${observation.error.name}: ${observation.error.message})`;
  }
  const vault = observation.value;
  if (vault.needsCreate) return 'none';
  return `present (${vault.vaultObjectId}; credit ${vault.creditMist.toString()} MIST; last nonce ${vault.lastNonce.toString()})`;
}

function renderMarkdownReport({
  runStartedAt,
  completedAt,
  phase,
  network,
  chainIdentifier,
  relayApiUrl,
  suiGrpcUrl,
  packageId,
  settlementSwapPath,
  sponsoredMaxRuns,
  directMaxRuns,
  initialSnapshot,
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
  const sponsoredFlowLines = sponsoredStats
    ? SPONSORED_FLOW_ORDER.flatMap((key) => {
        const flow = SPONSORED_FLOW_BY_KIND[key];
        const flowStats = sponsoredStats.byFlow[key];
        const flowAvgGas = average(flowStats.actualGasMist);
        const flowAvgHostMargin = average(flowStats.hostMarginMist);
        const tokenSummary = summarizeTokenMeasurements(flowStats.tokenMeasurements);
        const flowAvgTokenSpent = average(tokenSummary.attributableSpentRaw);
        return [
          `### ${flow.label}`,
          '',
          `- Flow key: \`${key}\``,
          `- Verified successes: ${flowStats.runs}`,
          `- Average gas: ${formatOptionalMist(flowAvgGas)}`,
          `- Average Host margin: ${formatOptionalMist(flowAvgHostMargin)}`,
          `- Settlement-token transaction changes: debit ${tokenSummary.debit}, unchanged ${tokenSummary.unchanged}, credit ${tokenSummary.credit}, unavailable ${tokenSummary.unavailable}`,
          `- Average attributable settlement-token spend: ${
            flowAvgTokenSpent === null
              ? 'n/a'
              : `${formatDecimal(flowAvgTokenSpent, settlementSwapPath.settlementTokenDecimals)} ${settlementSwapPath.settlementTokenSymbol}`
          }`,
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
    `- Chain identifier: \`${chainIdentifier}\``,
    `- Relay API: \`${relayApiUrl}\``,
    `- Sui gRPC: \`${suiGrpcUrl}\``,
    `- Stelis package ID: \`${packageId}\``,
    `- Mode: ${phase}`,
    `- Settlement token: ${settlementSwapPath.settlementTokenSymbol}`,
    `- Settlement token type: \`${settlementSwapPath.settlementTokenType}\``,
    '',
    '## Test Counts',
    '',
    `- Sponsored verified successes: ${sponsoredStats?.runs ?? 0} / ${sponsoredMaxRuns}`,
    `- Direct verified successes: ${directStats?.runs ?? 0} / ${directMaxRuns}`,
    `- Direct duplicate digest retries: ${directStats?.duplicateDigestRetries ?? 0}`,
    '',
    '## Sponsored Flow Breakdown',
    '',
    ...sponsoredFlowLines,
    '',
    '## Starting Balances',
    '',
    `- SUI: ${formatBalanceObservation(initialSnapshot.sui, (value) => `${formatMist(value)} (${value.toString()} MIST)`)}`,
    `- ${settlementSwapPath.settlementTokenSymbol}: ${formatBalanceObservation(initialSnapshot.settlementToken, (value) => `${formatDecimal(value, settlementSwapPath.settlementTokenDecimals)} (${value.toString()} raw)`)}`,
    `- User Vault: ${formatVaultObservation(initialSnapshot.vault)}`,
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
    `- Sponsored stop: ${formatStopSummary(sponsoredStats?.stopReason)}`,
    `- Direct stop: ${formatStopSummary(directStats?.stopReason)}`,
    '',
    '## Interpretation Fields',
    '',
    '- `gasMist`: actual on-chain gas paid for the submitted transaction.',
    '- Sponsored successes require the current Sui terminal shape and one compiled-schema SettleEvent bound to receipt, user, order, and quoted costs.',
    '- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.',
    '- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.',
    "- Settlement-token spend is derived only from this transaction's Sui `balanceChanges`, matched by exact user and token type. Wallet snapshots are diagnostic and never enter spend averages.",
    '- Token debit averages are reported per sponsored flow. Credit and unavailable observations are exposed rather than converted to zero.',
    '- Direct gas overhead is compared only against `vault_credit_use` runs. `vault_create` and `vault_top_up` include User Vault setup or settlement-token swap work and are reported separately.',
    '',
  ].join('\n');
}

async function writeMarkdownReport(reportPath, input) {
  await writeExclusiveText(
    reportPath,
    `# Empty Execution Benchmark Report\n\n${renderMarkdownReport(input)}\n`,
  );
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(usage());
    return;
  }

  assertSupportedProcessEnv(process.env);
  const fileEnv = await parseEnvFile(envPath);
  const secretKey = requireValue(
    envValue(fileEnv, cli, 'secretKey', 'STELIS_ONCHAIN_USER_SECRET_KEY'),
    'STELIS_ONCHAIN_USER_SECRET_KEY',
  );
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.getPublicKey().toSuiAddress();
  const grpcBaseUrl = normalizeGrpcUrl(
    envValue(fileEnv, cli, 'grpcUrl', 'STELIS_ONCHAIN_GRPC_URL') ??
      'https://fullnode.testnet.sui.io:443',
  );
  const journal = new EmptyExecutionBenchmarkJournal({
    root: defaultBenchmarkJournalRoot(SUI_CHAIN_IDENTIFIERS.testnet, address),
    chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    address,
  });

  await journal.acquireSessionLease();
  try {
    await runWithSession({ cli, fileEnv, keypair, address, grpcBaseUrl, journal });
  } finally {
    await journal.releaseSessionLease();
  }
}

async function runWithSession({ cli, fileEnv, keypair, address, grpcBaseUrl, journal }) {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: grpcBaseUrl });
  const endpoints = createSuiEndpointSnapshot([client]);
  await assertSuiNetwork(endpoints, {
    network: 'testnet',
    chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
  });
  const chainIdentity = { chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet };
  console.log(`Wallet: ${address}`);
  console.log(`Sui gRPC: ${redactEndpointUrl(grpcBaseUrl)}`);
  console.log(`Chain identifier: ${chainIdentity.chainIdentifier}`);
  console.log(`Machine journal: ${journal.root}`);

  if (await recoverActiveAttempt(journal, endpoints)) return;

  const apiUrl = normalizeRelayApiUrl(
    requireValue(
      envValue(fileEnv, cli, 'apiUrl', 'STELIS_ONCHAIN_RELAY_API_URL'),
      'STELIS_ONCHAIN_RELAY_API_URL',
    ),
  );
  const phase = requireValue(
    envValue(fileEnv, cli, 'phase', 'STELIS_ONCHAIN_PHASE', PHASE.SPONSORED),
    'STELIS_ONCHAIN_PHASE',
  );
  if (!RUN_PHASES.has(phase)) {
    throw new Error(`STELIS_ONCHAIN_PHASE must be sponsored, direct, or both; got ${phase}`);
  }
  const sponsoredMaxRuns = parsePositiveSafeInteger(
    envValue(fileEnv, cli, 'sponsoredMaxRuns', 'STELIS_ONCHAIN_SPONSORED_MAX_RUNS', '20'),
    'STELIS_ONCHAIN_SPONSORED_MAX_RUNS',
  );
  const directMaxRuns = parsePositiveSafeInteger(
    envValue(fileEnv, cli, 'directMaxRuns', 'STELIS_ONCHAIN_DIRECT_MAX_RUNS', '20'),
    'STELIS_ONCHAIN_DIRECT_MAX_RUNS',
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
  const slippageBps = parseNonNegativeSafeInteger(
    envValue(
      fileEnv,
      cli,
      'slippageBps',
      'STELIS_ONCHAIN_SLIPPAGE_BPS',
      DEFAULT_SLIPPAGE_BPS.toString(),
    ),
    'STELIS_ONCHAIN_SLIPPAGE_BPS',
  );
  if (slippageBps > SLIPPAGE_CAP_BPS) {
    throw new Error(`STELIS_ONCHAIN_SLIPPAGE_BPS must be <= ${SLIPPAGE_CAP_BPS}`);
  }
  const requireZeroSuiForSponsored = parseBoolean(
    envValue(
      fileEnv,
      cli,
      'requireZeroSuiForSponsored',
      'STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED',
      'false',
    ),
    'STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED',
  );

  const sdk = await StelisSDK.connect(apiUrl);
  if (sdk.network !== 'testnet') {
    throw new Error(
      `This benchmark supports the current testnet deployment only; got ${sdk.network}`,
    );
  }
  const runStartedAt = new Date();
  const runId = `${timestampForFileName(runStartedAt)}-${randomUUID()}`;
  const { rawPath, reportPath } = resolveOutputPaths({ fileEnv, cli, runId });
  const relayApiEvidenceUrl = redactEndpointUrl(apiUrl);
  const suiGrpcEvidenceUrl = redactEndpointUrl(grpcBaseUrl);
  const settlementSwapPath = resolveSettlementSwapPathByType(
    sdk,
    requireValue(
      envValue(fileEnv, cli, 'settlementTokenType', 'STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE'),
      'STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE',
    ),
  );

  console.log(`Network: ${sdk.network}`);
  console.log(`Relay API: ${relayApiEvidenceUrl}`);
  console.log(
    `Settlement token: ${settlementSwapPath.settlementTokenSymbol} (${settlementSwapPath.settlementTokenType})`,
  );
  console.log(`Phase: ${phase}`);

  const ctx = {
    sdk,
    apiUrl,
    client,
    endpoints,
    keypair,
    address,
    journal,
    network: sdk.network,
    chainIdentifier: chainIdentity.chainIdentifier,
    relayApiEvidenceUrl,
    relayEndpointHash: sha256Text(apiUrl),
    suiGrpcEvidenceUrl,
    suiGrpcEndpointHash: sha256Text(grpcBaseUrl),
    packageId: sdk.config.packageId,
    runId,
    settlementSwapPath,
    settlementTokenType: settlementSwapPath.settlementTokenType,
    sponsoredMaxRuns,
    directMaxRuns,
    directGasBudgetMist,
    minSuiReserveMist,
    slippageBps,
    rawPath,
    requireZeroSuiForSponsored,
  };
  const initialSnapshot = await readInitialWalletSnapshot(ctx);
  console.log(
    `Pre-execution SUI balance: ${formatBalanceObservation(initialSnapshot.sui, (value) => `${formatMist(value)} (${value.toString()} MIST)`)}`,
  );
  console.log(
    `Pre-execution ${settlementSwapPath.settlementTokenSymbol} balance: ${formatBalanceObservation(initialSnapshot.settlementToken, (value) => `${formatDecimal(value, settlementSwapPath.settlementTokenDecimals)} (${value.toString()} raw)`)}`,
  );
  console.log(`User Vault: ${formatVaultObservation(initialSnapshot.vault)}`);

  if (!cli.execute) {
    console.log('');
    console.log('Balance check only. No transaction was submitted.');
    console.log('Pass --execute to submit on-chain transactions.');
    return;
  }

  assertExecutableBalances({
    phase,
    initialSuiObservation: initialSnapshot.sui,
    minSuiReserveMist,
    directGasBudgetMist,
    requireZeroSuiForSponsored,
  });
  await createBenchmarkEvidence(ctx, {
    recordType: 'run',
    outcome: 'started',
    phase,
    initialSnapshot,
  });
  console.log(`Raw evidence: ${rawPath}`);

  try {
    const sponsoredStats = includesPhase(phase, PHASE.SPONSORED)
      ? await runSponsoredPhase(ctx)
      : null;
    const directStats = includesPhase(phase, PHASE.DIRECT) ? await runDirectPhase(ctx) : null;
    printSummary(sponsoredStats, directStats, settlementSwapPath);
    const completedAt = new Date();
    await writeMarkdownReport(reportPath, {
      runStartedAt,
      completedAt,
      phase,
      network: sdk.network,
      chainIdentifier: chainIdentity.chainIdentifier,
      relayApiUrl: relayApiEvidenceUrl,
      suiGrpcUrl: suiGrpcEvidenceUrl,
      packageId: sdk.config.packageId,
      settlementSwapPath,
      sponsoredMaxRuns,
      directMaxRuns,
      initialSnapshot,
      sponsoredStats,
      directStats,
    });
    await appendBenchmarkRecord(ctx, {
      recordType: 'run',
      outcome: 'completed',
      phase,
      completedAt: completedAt.toISOString(),
      reportPath,
    });
    console.log(`Report written: ${reportPath}`);
  } catch (error) {
    try {
      await appendBenchmarkRecord(ctx, {
        recordType: 'run',
        outcome: 'failed',
        phase,
        failedAt: new Date().toISOString(),
        error: describeError(error),
      });
    } catch (recordError) {
      console.error(`Failed to append run failure evidence: ${summarizeError(recordError)}`);
    }
    try {
      const active = await journal.readActiveAttempt();
      if (active) {
        console.error(
          `Run stopped with active journal state ${active.state}. This wallet is blocked until every candidate has a canonical terminal result: ${active.reconciliationDigests.join(', ')}`,
        );
      } else {
        console.error(`Run stopped. Raw evidence: ${rawPath}`);
      }
    } catch (journalError) {
      console.error(
        `Run stopped and the active journal could not be read: ${summarizeError(journalError)}`,
      );
    }
    throw error;
  }
}

main().catch((err) => {
  console.error(`Failed: ${summarizeError(err)}`);
  process.exitCode = 1;
});
