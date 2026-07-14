import assert from 'node:assert/strict';
import test from 'node:test';
import { toBase58 } from '@mysten/bcs';
import {
  applyAttemptJournalEvent,
  classifyVaultSnapshots,
  classifySponsorPostOutcome,
  composeBenchmarkRecord,
  createAttemptJournal,
  currentSuiTerminalProof,
  measureSettlementTokenBalanceChanges,
  parseAttemptJournal,
  parseSpendableBalanceRaw,
  projectBenchmarkErrorMeta,
  resolveSettlementSwapPathByType,
  summarizeTokenMeasurements,
} from './empty-execution-benchmark-model.mjs';

const USER = `0x${'11'.repeat(32)}`;
const OTHER_USER = `0x${'22'.repeat(32)}`;
const TOKEN = `0x${'33'.repeat(32)}::deep::DEEP`;
const OTHER_TOKEN = `0x${'44'.repeat(32)}::deep::DEEP`;
const EXPECTED_DIGEST = toBase58(new Uint8Array(32).fill(1));
const REPORTED_DIGEST = toBase58(new Uint8Array(32).fill(2));
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function currentSuiResult(digest, kind) {
  const status =
    kind === 'success'
      ? { success: true, error: null }
      : {
          success: false,
          error: { $kind: 'Unknown', message: 'failed', Unknown: null },
        };
  const transaction = {
    digest,
    status,
    effects: { status, transactionDigest: digest },
  };
  return kind === 'success'
    ? { $kind: 'Transaction', Transaction: transaction }
    : { $kind: 'FailedTransaction', FailedTransaction: transaction };
}

test('token selection uses the SDK exact-type lookup and never a symbol', () => {
  const calls = [];
  const path = { settlementTokenType: TOKEN, settlementTokenSymbol: 'SAME' };
  const otherPath = { settlementTokenType: OTHER_TOKEN, settlementTokenSymbol: 'SAME' };
  const sdk = {
    getSettlementSwapPathForSettlementToken(type) {
      calls.push(type);
      if (type === TOKEN) return path;
      if (type === OTHER_TOKEN) return otherPath;
      throw new Error('unsupported');
    },
  };

  assert.equal(resolveSettlementSwapPathByType(sdk, TOKEN), path);
  assert.equal(resolveSettlementSwapPathByType(sdk, OTHER_TOKEN), otherPath);
  assert.deepEqual(calls, [TOKEN, OTHER_TOKEN]);
  assert.throws(() => resolveSettlementSwapPathByType(sdk, undefined), /non-empty Move type/);
  assert.throws(() => resolveSettlementSwapPathByType(sdk, 'SAME'), /valid full Move type/);
});

test('current balance parsing proves exact type, u64 fields, and total invariant', () => {
  assert.equal(
    parseSpendableBalanceRaw(
      { coinType: TOKEN, balance: '9', coinBalance: '7', addressBalance: '2' },
      TOKEN,
    ),
    9n,
  );
  assert.throws(
    () =>
      parseSpendableBalanceRaw(
        { coinType: TOKEN, balance: '9', coinBalance: '8', addressBalance: '2' },
        TOKEN,
      ),
    /invariant failed/,
  );
  assert.throws(
    () =>
      parseSpendableBalanceRaw(
        { coinType: OTHER_TOKEN, balance: '0', coinBalance: '0', addressBalance: '0' },
        TOKEN,
      ),
    /expected/,
  );
});

test('transaction balance changes attribute only exact user and token entries', () => {
  const measured = measureSettlementTokenBalanceChanges(
    [
      { address: USER, coinType: TOKEN, amount: '-7' },
      { address: USER, coinType: TOKEN, amount: '-5' },
      { address: OTHER_USER, coinType: TOKEN, amount: '-1000' },
      { address: USER, coinType: OTHER_TOKEN, amount: '-2000' },
    ],
    USER,
    TOKEN,
  );
  assert.deepEqual(measured, {
    kind: 'debit',
    source: 'transaction_balance_changes',
    netChangeRaw: -12n,
    spentRaw: 12n,
  });
});

test('transaction balance changes distinguish unchanged, credit, missing, and malformed', () => {
  assert.equal(measureSettlementTokenBalanceChanges([], USER, TOKEN).kind, 'unchanged');
  assert.deepEqual(
    measureSettlementTokenBalanceChanges(
      [{ address: USER, coinType: TOKEN, amount: '4' }],
      USER,
      TOKEN,
    ),
    {
      kind: 'credit',
      source: 'transaction_balance_changes',
      netChangeRaw: 4n,
    },
  );
  assert.equal(measureSettlementTokenBalanceChanges(undefined, USER, TOKEN).kind, 'unavailable');
  assert.equal(
    measureSettlementTokenBalanceChanges(
      [{ address: USER, coinType: TOKEN, amount: '-0' }],
      USER,
      TOKEN,
    ).kind,
    'unavailable',
  );
});

function observedVault({ id, credit, nonce = 0n }) {
  return {
    status: 'observed',
    value: {
      vaultObjectId: id,
      needsCreate: id === null,
      creditMist: credit,
      lastNonce: nonce,
    },
  };
}

test('vault snapshots preserve creation, same identity, replacement, and unavailable meanings', () => {
  const created = classifyVaultSnapshots(
    observedVault({ id: null, credit: 0n }),
    observedVault({ id: '0x1', credit: 8n, nonce: 1n }),
  );
  assert.equal(created.kind, 'created');
  assert.equal(created.observedCreditDeltaMist, 8n);

  const same = classifyVaultSnapshots(
    observedVault({ id: '0x1', credit: 8n, nonce: 1n }),
    observedVault({ id: '0x1', credit: 3n, nonce: 2n }),
  );
  assert.equal(same.kind, 'same');
  assert.equal(same.observedCreditDeltaMist, -5n);

  assert.equal(
    classifyVaultSnapshots(
      observedVault({ id: '0x1', credit: 8n }),
      observedVault({ id: '0x2', credit: 3n }),
    ).kind,
    'replaced_or_stale',
  );
  assert.equal(
    classifyVaultSnapshots({ status: 'unavailable' }, observedVault({ id: null, credit: 0n })).kind,
    'unavailable',
  );
});

test('token summaries expose excluded credit and unavailable samples instead of hiding them', () => {
  const summary = summarizeTokenMeasurements([
    { kind: 'debit', spentRaw: 5n },
    { kind: 'unchanged', spentRaw: 0n },
    { kind: 'credit', netChangeRaw: 2n },
    { kind: 'unavailable', reason: 'missing' },
  ]);
  assert.deepEqual(summary, {
    debit: 1,
    unchanged: 1,
    credit: 1,
    unavailable: 1,
    attributableSpentRaw: [5n, 0n],
  });
});

test('benchmark error metadata is a closed current projection', () => {
  assert.deepEqual(
    projectBenchmarkErrorMeta({
      digest: EXPECTED_DIGEST,
      subcode: 'INSUFFICIENT_FUNDS',
      retryAfterMs: 250,
      secretKey: 'must-not-leak',
      authorizationHeader: 'Basic must-not-leak',
      nested: { token: 'must-not-leak' },
    }),
    {
      digest: EXPECTED_DIGEST,
      subcode: 'INSUFFICIENT_FUNDS',
      retryAfterMs: 250,
    },
  );
});

test('sponsor POST outcomes trust only current stage-bound Host failures', () => {
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'PREPARED_TX_EXPIRED',
      reportedDigest: null,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'sponsor_rejected',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'SPONSOR_CONGESTION',
      reportedDigest: EXPECTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submitted_failed',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'SPONSOR_ONCHAIN_FAILED',
      reportedDigest: EXPECTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submitted_failed',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'SPONSOR_SUBMISSION_UNCERTAIN',
      reportedDigest: EXPECTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submission_uncertain',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'SPONSOR_SUBMISSION_UNCERTAIN',
      reportedDigest: REPORTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submitted_unverified',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'GAS_EFFECTS_MISSING',
      reportedDigest: EXPECTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submitted_unverified',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: 'SPONSOR_FAILED',
      reportedDigest: null,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submission_uncertain',
  );
  assert.equal(
    classifySponsorPostOutcome({
      currentCode: null,
      reportedDigest: REPORTED_DIGEST,
      expectedDigest: EXPECTED_DIGEST,
    }),
    'submitted_unverified',
  );
  assert.throws(
    () =>
      classifySponsorPostOutcome({
        currentCode: 'SPONSOR_SUBMISSION_UNCERTAIN',
        reportedDigest: null,
        expectedDigest: EXPECTED_DIGEST,
      }),
    /requires a digest/,
  );
  assert.throws(
    () =>
      classifySponsorPostOutcome({
        currentCode: 'PREPARED_TX_EXPIRED',
        reportedDigest: EXPECTED_DIGEST,
        expectedDigest: EXPECTED_DIGEST,
      }),
    /cannot carry a digest/,
  );
});

test('benchmark provenance cannot be replaced by record-local fields', () => {
  assert.deepEqual(
    composeBenchmarkRecord(
      {
        chainIdentifier: 'trusted-chain',
        relayApiUrl: 'https://trusted.example/[REDACTED]',
      },
      {
        recordType: 'attempt',
        chainIdentifier: 'override-chain',
        relayApiUrl: 'https://attacker.example',
      },
    ),
    {
      recordType: 'attempt',
      chainIdentifier: 'trusted-chain',
      relayApiUrl: 'https://trusted.example/[REDACTED]',
    },
  );
});

test('attempt journal is wallet-bound, monotonic, and terminal-proof exact', () => {
  assert.throws(
    () => currentSuiTerminalProof({ digest: EXPECTED_DIGEST, kind: 'success' }, EXPECTED_DIGEST),
    /current raw transaction result/,
  );
  assert.throws(
    () => currentSuiTerminalProof(currentSuiResult(REPORTED_DIGEST, 'success'), EXPECTED_DIGEST),
    /current raw transaction result/,
  );
  const provenance = {
    evidenceSchema: 'evidence-v1',
    network: 'testnet',
    chainIdentifier: 'chain-a',
    address: USER,
    relayApiUrl: 'https://relay.example/[REDACTED]',
    relayEndpointHash: 'relay-hash',
    suiGrpcUrl: 'https://grpc.example/[REDACTED]',
    suiGrpcEndpointHash: 'grpc-hash',
    stelisPackageId: 'package-a',
    settlementTokenType: TOKEN,
  };
  const ready = createAttemptJournal({
    attemptId: ATTEMPT_ID,
    provenance,
    mode: 'sponsored',
    expectedDigest: EXPECTED_DIGEST,
    createdAt: '2026-07-14T00:00:00.000Z',
  });
  const started = applyAttemptJournalEvent(ready, {
    kind: 'submission_started',
    updatedAt: '2026-07-14T00:00:01.000Z',
  });
  assert.throws(
    () =>
      parseAttemptJournal(
        { ...ready, reconciliationDigests: [EXPECTED_DIGEST, REPORTED_DIGEST] },
        'chain-a',
        USER,
      ),
    /state ready cannot carry candidate digests/,
  );
  const uncertain = applyAttemptJournalEvent(started, {
    kind: 'submission_uncertain',
    candidateDigest: REPORTED_DIGEST,
    updatedAt: '2026-07-14T00:00:02.000Z',
  });

  assert.deepEqual(uncertain.reconciliationDigests, [EXPECTED_DIGEST, REPORTED_DIGEST]);
  assert.equal(parseAttemptJournal(uncertain, 'chain-a', USER).expectedDigest, EXPECTED_DIGEST);
  assert.throws(() => parseAttemptJournal(uncertain, 'chain-b', USER), /different wallet or chain/);
  assert.throws(
    () => parseAttemptJournal({ ...uncertain, attemptId: '../escape' }, 'chain-a', USER),
    /canonical UUID/,
  );
  assert.throws(
    () =>
      applyAttemptJournalEvent(uncertain, {
        kind: 'recovered_chain_terminal',
        terminalProofs: [
          currentSuiTerminalProof(currentSuiResult(EXPECTED_DIGEST, 'success'), EXPECTED_DIGEST),
        ],
        updatedAt: '2026-07-14T00:00:03.000Z',
      }),
    /prove every reconciliation digest/,
  );
  assert.equal(
    applyAttemptJournalEvent(uncertain, {
      kind: 'recovered_chain_terminal',
      terminalProofs: [
        currentSuiTerminalProof(currentSuiResult(EXPECTED_DIGEST, 'success'), EXPECTED_DIGEST),
        currentSuiTerminalProof(currentSuiResult(REPORTED_DIGEST, 'failure'), REPORTED_DIGEST),
      ],
      updatedAt: '2026-07-14T00:00:03.000Z',
    }).state,
    'terminal',
  );
  assert.throws(
    () =>
      applyAttemptJournalEvent(uncertain, {
        kind: 'submission_started',
        updatedAt: '2026-07-14T00:00:04.000Z',
      }),
    /Invalid submission_started event/,
  );

  assert.throws(
    () =>
      applyAttemptJournalEvent(started, {
        kind: 'submitted_terminal',
        terminalProof: currentSuiTerminalProof(
          currentSuiResult(REPORTED_DIGEST, 'failure'),
          REPORTED_DIGEST,
        ),
        updatedAt: '2026-07-14T00:00:04.000Z',
      }),
    /expected failed Sui terminal/,
  );

  assert.equal(
    applyAttemptJournalEvent(started, {
      kind: 'submitted_terminal',
      terminalProof: currentSuiTerminalProof(
        currentSuiResult(EXPECTED_DIGEST, 'success'),
        EXPECTED_DIGEST,
      ),
      updatedAt: '2026-07-14T00:00:04.000Z',
    }).resolution.outcome,
    'success',
  );
  assert.equal(
    applyAttemptJournalEvent(started, {
      kind: 'sponsor_rejected',
      updatedAt: '2026-07-14T00:00:04.000Z',
    }).resolution.outcome,
    'sponsor_rejected',
  );
  const directReady = createAttemptJournal({
    attemptId: '12345678-1234-4234-8234-123456789abc',
    provenance,
    mode: 'direct',
    expectedDigest: EXPECTED_DIGEST,
    createdAt: '2026-07-14T00:00:00.000Z',
  });
  const directStarted = applyAttemptJournalEvent(directReady, {
    kind: 'submission_started',
    updatedAt: '2026-07-14T00:00:01.000Z',
  });
  assert.throws(
    () =>
      applyAttemptJournalEvent(directStarted, {
        kind: 'sponsor_rejected',
        updatedAt: '2026-07-14T00:00:02.000Z',
      }),
    /Only a sponsored attempt/,
  );
  const sponsorRejected = applyAttemptJournalEvent(started, {
    kind: 'sponsor_rejected',
    updatedAt: '2026-07-14T00:00:04.000Z',
  });
  assert.throws(
    () => parseAttemptJournal({ ...sponsorRejected, mode: 'direct' }, 'chain-a', USER),
    /Only a sponsored attempt/,
  );
  assert.throws(
    () =>
      applyAttemptJournalEvent(uncertain, {
        kind: 'sponsor_rejected',
        updatedAt: '2026-07-14T00:00:04.000Z',
      }),
    /Invalid sponsor_rejected event/,
  );

  assert.throws(
    () =>
      applyAttemptJournalEvent(started, {
        kind: 'abandoned_before_submission',
        updatedAt: '2026-07-14T00:00:04.000Z',
      }),
    /Invalid abandoned_before_submission event/,
  );
  assert.throws(
    () =>
      applyAttemptJournalEvent(ready, {
        kind: 'submitted_terminal',
        terminalProof: currentSuiTerminalProof(
          currentSuiResult(EXPECTED_DIGEST, 'success'),
          EXPECTED_DIGEST,
        ),
        updatedAt: '2026-07-14T00:00:04.000Z',
      }),
    /Invalid submitted_terminal event/,
  );
});
