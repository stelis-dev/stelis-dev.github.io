import {
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
} from '@mysten/sui/utils';
import { HOST_ERROR_META_POLICY, RELAY_SPONSOR_ERROR_CODES } from '@stelis/contracts';

const U64_MAX = (1n << 64n) - 1n;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL = /^(?:0|-?[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_SPONSOR_ERROR_CODE_SET = new Set(RELAY_SPONSOR_ERROR_CODES);
const BENCHMARK_ATTEMPT_JOURNAL_SCHEMA = 'stelis_empty_execution_benchmark_attempt_v1';
const ATTEMPT_STATES = new Set(['ready', 'submission_started', 'uncertain', 'terminal']);
const ATTEMPT_RESOLUTION_OUTCOMES = new Set([
  'success',
  'submitted_failed',
  'sponsor_rejected',
  'abandoned_before_submission',
  'recovered_chain_terminal',
]);
const SUI_TERMINAL_PROOF_SOURCE = 'sui_current_terminal';
const PROVENANCE_KEYS = [
  'evidenceSchema',
  'network',
  'chainIdentifier',
  'relayApiUrl',
  'relayEndpointHash',
  'suiGrpcUrl',
  'suiGrpcEndpointHash',
  'stelisPackageId',
  'address',
  'settlementTokenType',
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function transactionDigest(value, label) {
  if (typeof value !== 'string' || !isValidTransactionDigest(value)) {
    throw new Error(`${label} must be a canonical Sui transaction digest`);
  }
  return value;
}

export function currentSuiTerminalProof(result, expectedDigest) {
  transactionDigest(expectedDigest, 'expectedDigest');
  if (!isRecord(result) || (result.outcome !== 'success' && result.outcome !== 'failure')) {
    throw new Error('Current Sui terminal proof requires an exact gateway result');
  }
  const digest = transactionDigest(result.digest, 'result.digest');
  if (digest !== expectedDigest || !isRecord(result.effects)) {
    throw new Error('Current Sui terminal proof requires an exact gateway result');
  }
  const effectsDigest = transactionDigest(
    result.effects.transactionDigest,
    'result.effects.transactionDigest',
  );
  if (effectsDigest !== expectedDigest || !isRecord(result.effects.status)) {
    throw new Error('Current Sui terminal proof requires an exact gateway result');
  }
  const succeeded = result.effects.status.success === true && result.effects.status.error === null;
  const failed = result.effects.status.success === false && isRecord(result.effects.status.error);
  if ((result.outcome === 'success' && !succeeded) || (result.outcome === 'failure' && !failed)) {
    throw new Error('Current Sui terminal proof requires an exact gateway result');
  }
  return {
    source: SUI_TERMINAL_PROOF_SOURCE,
    digest,
    resultKind: result.outcome,
  };
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} is not the current exact shape`);
  }
}

function canonicalStructTag(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty Move type`);
  }
  try {
    return normalizeStructTag(value.trim());
  } catch (error) {
    throw new Error(`${label} must be a valid full Move type`, { cause: error });
  }
}

function parseU64(value, label) {
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error(`${label} exceeds u64`);
  return parsed;
}

function parseSignedDecimal(value, label) {
  if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical signed decimal string`);
  }
  return BigInt(value);
}

/**
 * Resolve token identity only through the current SDK exact-type authority.
 * Symbol and decimal metadata on the returned path are presentation-only.
 */
export function resolveSettlementSwapPathByType(sdk, rawSettlementTokenType) {
  const settlementTokenType = canonicalStructTag(
    rawSettlementTokenType,
    'STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE',
  );
  if (typeof sdk?.getSettlementSwapPathForSettlementToken !== 'function') {
    throw new Error('Current SDK exact settlement-token lookup is unavailable');
  }
  const path = sdk.getSettlementSwapPathForSettlementToken(settlementTokenType);
  if (
    !isRecord(path) ||
    canonicalStructTag(path.settlementTokenType, 'Host settlementTokenType') !== settlementTokenType
  ) {
    throw new Error('SDK settlement swap path did not preserve the requested token identity');
  }
  return path;
}

/** Keep only fields the current benchmark uses to classify sponsor responses. */
export function projectBenchmarkErrorMeta(meta) {
  if (!isRecord(meta)) return undefined;
  const projected = {};
  if (typeof meta.digest === 'string' && isValidTransactionDigest(meta.digest)) {
    projected.digest = meta.digest;
  }
  if (typeof meta.subcode === 'string' && meta.subcode !== '') projected.subcode = meta.subcode;
  if (
    typeof meta.retryAfterMs === 'number' &&
    Number.isSafeInteger(meta.retryAfterMs) &&
    meta.retryAfterMs >= 0
  ) {
    projected.retryAfterMs = meta.retryAfterMs;
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

/**
 * Classify the result of the POST /sponsor boundary.
 *
 * Only current Host failures whose execution stage is known are definitive.
 * Unknown HTTP status/code combinations remain submission-uncertain even when
 * they are 4xx responses.
 */
export function classifySponsorPostOutcome({ currentCode, reportedDigest, expectedDigest }) {
  if (currentCode !== null && !RELAY_SPONSOR_ERROR_CODE_SET.has(currentCode)) {
    throw new Error('Unknown current Relay sponsor failure code');
  }
  transactionDigest(expectedDigest, 'expectedDigest');
  if (reportedDigest !== null) transactionDigest(reportedDigest, 'reportedDigest');

  const requiresDigest =
    currentCode !== null && HOST_ERROR_META_POLICY[currentCode]?.required?.includes('digest');
  if (requiresDigest && reportedDigest === null) {
    throw new Error(`Current Relay sponsor failure ${currentCode} requires a digest`);
  }
  if (!requiresDigest && currentCode !== null && reportedDigest !== null) {
    throw new Error(`Current Relay sponsor failure ${currentCode} cannot carry a digest`);
  }
  if (reportedDigest !== null && reportedDigest !== expectedDigest) {
    return 'submitted_unverified';
  }

  if (currentCode === 'SPONSOR_SUBMISSION_UNCERTAIN') {
    return 'submission_uncertain';
  }
  if (currentCode === 'SPONSOR_ONCHAIN_FAILED' || currentCode === 'SPONSOR_CONGESTION') {
    return 'submitted_failed';
  }
  if (requiresDigest) return 'submitted_unverified';
  if (currentCode !== null && currentCode !== 'SPONSOR_FAILED') {
    return 'sponsor_rejected';
  }
  return reportedDigest === null ? 'submission_uncertain' : 'submitted_unverified';
}

/** Context fields are written last so record-local data cannot replace provenance. */
export function composeBenchmarkRecord(provenance, fields) {
  if (!isRecord(provenance) || !isRecord(fields)) {
    throw new Error('Benchmark provenance and fields must be records');
  }
  return { ...fields, ...provenance };
}

export function createAttemptJournal({ attemptId, provenance, mode, expectedDigest, createdAt }) {
  const attempt = {
    schema: BENCHMARK_ATTEMPT_JOURNAL_SCHEMA,
    attemptId,
    provenance,
    mode,
    expectedDigest,
    reconciliationDigests: [expectedDigest],
    state: 'ready',
    resolution: null,
    createdAt,
    updatedAt: createdAt,
  };
  return parseAttemptJournal(attempt, provenance.chainIdentifier, provenance.address);
}

export function parseAttemptJournal(value, expectedChainIdentifier, expectedAddress) {
  if (!isRecord(value)) throw new Error('Benchmark attempt journal must be an object');
  exactKeys(
    value,
    [
      'schema',
      'attemptId',
      'provenance',
      'mode',
      'expectedDigest',
      'reconciliationDigests',
      'state',
      'resolution',
      'createdAt',
      'updatedAt',
    ],
    'Benchmark attempt journal',
  );
  if (value.schema !== BENCHMARK_ATTEMPT_JOURNAL_SCHEMA) {
    throw new Error('Benchmark attempt journal has an unsupported schema');
  }
  const attemptId = uuid(value.attemptId, 'attemptId');
  if (!isRecord(value.provenance)) throw new Error('Benchmark provenance must be an object');
  exactKeys(value.provenance, PROVENANCE_KEYS, 'Benchmark provenance');
  const provenance = Object.fromEntries(
    Object.entries(value.provenance).map(([key, entry]) => [
      key,
      nonEmptyString(entry, `provenance.${key}`),
    ]),
  );
  if (provenance.network !== 'testnet') throw new Error('Benchmark provenance is not testnet');
  if (
    provenance.chainIdentifier !== expectedChainIdentifier ||
    provenance.address !== expectedAddress
  ) {
    throw new Error('Benchmark attempt journal belongs to a different wallet or chain');
  }
  if (value.mode !== 'sponsored' && value.mode !== 'direct') {
    throw new Error('Benchmark attempt journal has an invalid mode');
  }
  if (!ATTEMPT_STATES.has(value.state)) throw new Error('Benchmark attempt state is invalid');
  const expectedDigest = transactionDigest(value.expectedDigest, 'expectedDigest');
  if (!Array.isArray(value.reconciliationDigests) || value.reconciliationDigests.length === 0) {
    throw new Error('Benchmark attempt journal has no reconciliation digests');
  }
  const reconciliationDigests = value.reconciliationDigests.map((digest, index) =>
    transactionDigest(digest, `reconciliationDigests[${index}]`),
  );
  if (
    new Set(reconciliationDigests).size !== reconciliationDigests.length ||
    !reconciliationDigests.includes(expectedDigest)
  ) {
    throw new Error('Benchmark attempt reconciliation digests are inconsistent');
  }
  if (
    (value.state === 'ready' || value.state === 'submission_started') &&
    (reconciliationDigests.length !== 1 || reconciliationDigests[0] !== expectedDigest)
  ) {
    throw new Error(`Benchmark attempt state ${value.state} cannot carry candidate digests`);
  }
  const createdAt = isoTimestamp(value.createdAt, 'createdAt');
  const updatedAt = isoTimestamp(value.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Benchmark attempt updatedAt cannot precede createdAt');
  }

  let resolution = null;
  if (value.state === 'terminal') {
    if (!isRecord(value.resolution)) throw new Error('Terminal attempt must carry resolution');
    exactKeys(value.resolution, ['outcome', 'terminalProofs', 'resolvedAt'], 'Attempt resolution');
    const terminalProofs = value.resolution.terminalProofs;
    if (!Array.isArray(terminalProofs)) {
      throw new Error('Attempt resolution terminalProofs must be an array');
    }
    resolution = {
      outcome: nonEmptyString(value.resolution.outcome, 'resolution.outcome'),
      terminalProofs: terminalProofs.map((proof, index) => {
        if (!isRecord(proof)) throw new Error(`resolution.terminalProofs[${index}] is invalid`);
        exactKeys(proof, ['source', 'digest', 'resultKind'], `resolution.terminalProofs[${index}]`);
        if (proof.source !== SUI_TERMINAL_PROOF_SOURCE) {
          throw new Error(`resolution.terminalProofs[${index}] has an invalid source`);
        }
        if (proof.resultKind !== 'success' && proof.resultKind !== 'failure') {
          throw new Error(`resolution.terminalProofs[${index}] has an invalid resultKind`);
        }
        return {
          source: SUI_TERMINAL_PROOF_SOURCE,
          digest: transactionDigest(proof.digest, `resolution.terminalProofs[${index}].digest`),
          resultKind: proof.resultKind,
        };
      }),
      resolvedAt: isoTimestamp(value.resolution.resolvedAt, 'resolution.resolvedAt'),
    };
    if (resolution.resolvedAt !== updatedAt) {
      throw new Error('Terminal attempt resolvedAt must equal updatedAt');
    }
    if (!ATTEMPT_RESOLUTION_OUTCOMES.has(resolution.outcome)) {
      throw new Error('Attempt resolution outcome is invalid');
    }
    if (resolution.outcome === 'sponsor_rejected' && value.mode !== 'sponsored') {
      throw new Error('Only a sponsored attempt can resolve as sponsor_rejected');
    }
    const terminalDigests = resolution.terminalProofs.map((proof) => proof.digest);
    if (new Set(terminalDigests).size !== terminalDigests.length) {
      throw new Error('Attempt resolution terminal proofs must have unique digests');
    }
    const terminalByDigest = new Map(
      resolution.terminalProofs.map((proof) => [proof.digest, proof]),
    );
    if (resolution.outcome === 'recovered_chain_terminal') {
      if (
        terminalByDigest.size !== reconciliationDigests.length ||
        reconciliationDigests.some((digest) => !terminalByDigest.has(digest))
      ) {
        throw new Error('Recovered attempt must prove every reconciliation digest terminal');
      }
    } else if (resolution.outcome === 'success') {
      if (
        terminalByDigest.size !== 1 ||
        terminalByDigest.get(expectedDigest)?.resultKind !== 'success'
      ) {
        throw new Error('Successful resolution must prove the expected successful Sui terminal');
      }
    } else if (resolution.outcome === 'submitted_failed') {
      if (
        terminalByDigest.size !== 1 ||
        terminalByDigest.get(expectedDigest)?.resultKind !== 'failure'
      ) {
        throw new Error('Failed resolution must prove the expected failed Sui terminal');
      }
    } else if (terminalByDigest.size !== 0) {
      throw new Error('Non-submitted resolution cannot carry terminal proofs');
    }
    if (
      resolution.outcome !== 'recovered_chain_terminal' &&
      (reconciliationDigests.length !== 1 || reconciliationDigests[0] !== expectedDigest)
    ) {
      throw new Error(`Attempt resolution ${resolution.outcome} cannot carry candidate digests`);
    }
  } else if (value.resolution !== null) {
    throw new Error('Non-terminal attempt cannot carry resolution');
  }

  return {
    schema: BENCHMARK_ATTEMPT_JOURNAL_SCHEMA,
    attemptId,
    provenance,
    mode: value.mode,
    expectedDigest,
    reconciliationDigests,
    state: value.state,
    resolution,
    createdAt,
    updatedAt,
  };
}

export function applyAttemptJournalEvent(attempt, event) {
  const current = parseAttemptJournal(
    attempt,
    attempt?.provenance?.chainIdentifier,
    attempt?.provenance?.address,
  );
  if (!isRecord(event)) throw new Error('Benchmark attempt event must be an object');
  const updatedAt = isoTimestamp(event.updatedAt, 'event.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error('Benchmark attempt event cannot move time backwards');
  }

  const reconciliationDigests = [...current.reconciliationDigests];
  let state;
  let resolution = null;

  if (event.kind === 'submission_started') {
    exactKeys(event, ['kind', 'updatedAt'], 'submission_started event');
    if (current.state !== 'ready') {
      throw new Error(`Invalid submission_started event from ${current.state}`);
    }
    state = 'submission_started';
  } else if (event.kind === 'submission_uncertain') {
    exactKeys(event, ['kind', 'candidateDigest', 'updatedAt'], 'submission_uncertain event');
    if (current.state !== 'submission_started' && current.state !== 'uncertain') {
      throw new Error(`Invalid submission_uncertain event from ${current.state}`);
    }
    if (event.candidateDigest !== null) {
      const digest = transactionDigest(event.candidateDigest, 'event.candidateDigest');
      if (!reconciliationDigests.includes(digest)) reconciliationDigests.push(digest);
    }
    state = 'uncertain';
  } else if (event.kind === 'abandoned_before_submission') {
    exactKeys(event, ['kind', 'updatedAt'], 'abandoned_before_submission event');
    if (current.state !== 'ready') {
      throw new Error(`Invalid abandoned_before_submission event from ${current.state}`);
    }
    state = 'terminal';
    resolution = {
      outcome: 'abandoned_before_submission',
      terminalProofs: [],
      resolvedAt: updatedAt,
    };
  } else if (event.kind === 'sponsor_rejected') {
    exactKeys(event, ['kind', 'updatedAt'], 'sponsor_rejected event');
    if (current.state !== 'submission_started') {
      throw new Error(`Invalid sponsor_rejected event from ${current.state}`);
    }
    if (current.mode !== 'sponsored') {
      throw new Error('Only a sponsored attempt can receive sponsor_rejected');
    }
    state = 'terminal';
    resolution = { outcome: 'sponsor_rejected', terminalProofs: [], resolvedAt: updatedAt };
  } else if (event.kind === 'submitted_terminal') {
    exactKeys(event, ['kind', 'terminalProof', 'updatedAt'], 'submitted_terminal event');
    if (current.state !== 'submission_started') {
      throw new Error(`Invalid submitted_terminal event from ${current.state}`);
    }
    if (!isRecord(event.terminalProof)) {
      throw new Error('submitted_terminal event requires one Sui terminal proof');
    }
    state = 'terminal';
    resolution = {
      outcome: event.terminalProof.resultKind === 'success' ? 'success' : 'submitted_failed',
      terminalProofs: [event.terminalProof],
      resolvedAt: updatedAt,
    };
  } else if (event.kind === 'recovered_chain_terminal') {
    exactKeys(event, ['kind', 'terminalProofs', 'updatedAt'], 'recovered_chain_terminal event');
    if (current.state !== 'submission_started' && current.state !== 'uncertain') {
      throw new Error(`Invalid recovered_chain_terminal event from ${current.state}`);
    }
    state = 'terminal';
    resolution = {
      outcome: 'recovered_chain_terminal',
      terminalProofs: event.terminalProofs,
      resolvedAt: updatedAt,
    };
  } else {
    throw new Error('Benchmark attempt event kind is invalid');
  }

  const next = {
    ...current,
    reconciliationDigests,
    state,
    resolution,
    updatedAt,
  };
  return parseAttemptJournal(next, current.provenance.chainIdentifier, current.provenance.address);
}

/** Parse the current Sui getBalance shape and prove its total-balance invariant. */
export function parseSpendableBalanceRaw(balance, expectedCoinType) {
  if (!isRecord(balance)) throw new Error('Balance response is missing balance');
  const expectedType = canonicalStructTag(expectedCoinType, 'Requested coin type');
  const actualType = canonicalStructTag(balance.coinType, 'Balance coinType');
  if (actualType !== expectedType) {
    throw new Error(`Balance response returned ${actualType}, expected ${expectedType}`);
  }
  const total = parseU64(balance.balance, `${expectedType} balance`);
  const coinBalance = parseU64(balance.coinBalance, `${expectedType} coinBalance`);
  const addressBalance = parseU64(balance.addressBalance, `${expectedType} addressBalance`);
  if (coinBalance + addressBalance !== total) {
    throw new Error(
      `${expectedType} balance invariant failed: total ${total} != coin ${coinBalance} + address ${addressBalance}`,
    );
  }
  return total;
}

/**
 * Attribute settlement-token movement to one successful transaction.
 * No wallet snapshot participates in this calculation.
 */
export function measureSettlementTokenBalanceChanges(
  balanceChanges,
  expectedUser,
  expectedTokenType,
) {
  const source = 'transaction_balance_changes';
  if (!Array.isArray(balanceChanges)) {
    return { kind: 'unavailable', source, reason: 'balance_changes_missing' };
  }

  let user;
  let tokenType;
  try {
    user = normalizeSuiAddress(expectedUser);
    tokenType = canonicalStructTag(expectedTokenType, 'Settlement token type');
  } catch (error) {
    return {
      kind: 'unavailable',
      source,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let netChangeRaw = 0n;
  for (const [index, change] of balanceChanges.entries()) {
    if (!isRecord(change)) {
      return { kind: 'unavailable', source, reason: `balance_change_${index}_not_object` };
    }
    let address;
    let coinType;
    let amount;
    try {
      if (typeof change.address !== 'string') {
        throw new Error('address is missing');
      }
      address = normalizeSuiAddress(change.address);
      coinType = canonicalStructTag(change.coinType, `balanceChanges[${index}].coinType`);
      amount = parseSignedDecimal(change.amount, `balanceChanges[${index}].amount`);
    } catch (error) {
      return {
        kind: 'unavailable',
        source,
        reason: `balance_change_${index}_malformed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (address === user && coinType === tokenType) netChangeRaw += amount;
  }

  if (netChangeRaw < 0n) {
    return { kind: 'debit', source, netChangeRaw, spentRaw: -netChangeRaw };
  }
  if (netChangeRaw === 0n) {
    return { kind: 'unchanged', source, netChangeRaw, spentRaw: 0n };
  }
  return { kind: 'credit', source, netChangeRaw };
}

function validateVaultSnapshot(snapshot, label) {
  if (!isRecord(snapshot) || snapshot.status !== 'observed' || !isRecord(snapshot.value)) {
    throw new Error(`${label} is not an observed vault snapshot`);
  }
  const value = snapshot.value;
  if (typeof value.needsCreate !== 'boolean') throw new Error(`${label}.needsCreate is invalid`);
  if (
    (value.needsCreate && value.vaultObjectId !== null) ||
    (!value.needsCreate && typeof value.vaultObjectId !== 'string')
  ) {
    throw new Error(`${label} has inconsistent vault identity`);
  }
  if (typeof value.creditMist !== 'bigint' || value.creditMist < 0n) {
    throw new Error(`${label}.creditMist is invalid`);
  }
  if (typeof value.lastNonce !== 'bigint' || value.lastNonce < 0n) {
    throw new Error(`${label}.lastNonce is invalid`);
  }
  return value;
}

/** Classify two diagnostic snapshots without promoting them to transaction evidence. */
export function classifyVaultSnapshots(before, after) {
  if (before?.status !== 'observed' || after?.status !== 'observed') {
    return {
      kind: 'unavailable',
      source: 'rpc_snapshots',
      beforeStatus: before?.status ?? 'unavailable',
      afterStatus: after?.status ?? 'unavailable',
    };
  }

  let beforeValue;
  let afterValue;
  try {
    beforeValue = validateVaultSnapshot(before, 'before vault snapshot');
    afterValue = validateVaultSnapshot(after, 'after vault snapshot');
  } catch (error) {
    return {
      kind: 'unavailable',
      source: 'rpc_snapshots',
      beforeStatus: before.status,
      afterStatus: after.status,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (
    !beforeValue.needsCreate &&
    (afterValue.needsCreate || beforeValue.vaultObjectId !== afterValue.vaultObjectId)
  ) {
    return {
      kind: 'replaced_or_stale',
      source: 'rpc_snapshots',
      beforeVaultObjectId: beforeValue.vaultObjectId,
      afterVaultObjectId: afterValue.vaultObjectId,
    };
  }

  const kind = beforeValue.needsCreate && !afterValue.needsCreate ? 'created' : 'same';
  return {
    kind,
    source: 'rpc_snapshots',
    vaultObjectId: afterValue.vaultObjectId,
    observedCreditDeltaMist: afterValue.creditMist - beforeValue.creditMist,
    beforeLastNonce: beforeValue.lastNonce,
    afterLastNonce: afterValue.lastNonce,
  };
}

export function summarizeTokenMeasurements(measurements) {
  const summary = {
    debit: 0,
    unchanged: 0,
    credit: 0,
    unavailable: 0,
    attributableSpentRaw: [],
  };
  for (const measurement of measurements) {
    if (!isRecord(measurement)) throw new Error('Unknown settlement-token measurement');
    switch (measurement.kind) {
      case 'debit':
      case 'unchanged':
        if (typeof measurement.spentRaw !== 'bigint') {
          throw new Error(`${measurement.kind} measurement is missing spentRaw`);
        }
        summary[measurement.kind]++;
        summary.attributableSpentRaw.push(measurement.spentRaw);
        break;
      case 'credit':
      case 'unavailable':
        summary[measurement.kind]++;
        break;
      default:
        throw new Error('Unknown settlement-token measurement');
    }
  }
  return summary;
}
