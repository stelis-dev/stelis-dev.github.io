import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toBase58 } from '@mysten/bcs';
import {
  appendDurableJsonl,
  archiveObservedSessionLease,
  benchmarkLeaseSocketPath,
  createDurableJsonl,
  EmptyExecutionBenchmarkJournal,
  recoverBenchmarkAttempt,
  writeExclusiveText,
} from './empty-execution-benchmark-journal.mjs';

const ADDRESS = `0x${'11'.repeat(32)}`;
const TOKEN = `0x${'22'.repeat(32)}::deep::DEEP`;
const EXPECTED_DIGEST = toBase58(new Uint8Array(32).fill(3));
const REPORTED_DIGEST = toBase58(new Uint8Array(32).fill(4));

function currentSuiResult(digest, kind) {
  const error = { kind: 'InsufficientGas', message: 'failed' };
  const status = kind === 'success' ? { success: true, error: null } : { success: false, error };
  const result = { outcome: kind, digest, effects: { status, transactionDigest: digest } };
  return kind === 'success' ? result : { ...result, error };
}

function provenance() {
  return {
    evidenceSchema: 'evidence-v1',
    network: 'testnet',
    chainIdentifier: 'chain-a',
    relayApiUrl: 'https://relay.example/[REDACTED]',
    relayEndpointHash: 'relay-hash',
    suiGrpcUrl: 'https://grpc.example/[REDACTED]',
    suiGrpcEndpointHash: 'grpc-hash',
    stelisPackageId: 'package-a',
    address: ADDRESS,
    settlementTokenType: TOKEN,
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'stelis-benchmark-journal-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('one session lease owns the full wallet-and-chain journal lifecycle', async () => {
  await withTempDirectory(async (root) => {
    const first = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    const competitor = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    const firstLease = await first.acquireSessionLease();
    await assert.rejects(
      () => competitor.acquireSessionLease(),
      /Another empty-execution benchmark/,
    );

    const ready = await first.beginAttempt({
      provenance: provenance(),
      mode: 'sponsored',
      expectedDigest: EXPECTED_DIGEST,
    });
    const started = await first.markSubmissionStarted(ready);
    const uncertain = await first.markUncertain(started, REPORTED_DIGEST);
    assert.deepEqual(uncertain.reconciliationDigests, [EXPECTED_DIGEST, REPORTED_DIGEST]);
    await assert.rejects(
      () => first.markUncertain(started, EXPECTED_DIGEST),
      /Active benchmark attempt changed unexpectedly/,
    );
    assert.deepEqual((await first.readActiveAttempt())?.reconciliationDigests, [
      EXPECTED_DIGEST,
      REPORTED_DIGEST,
    ]);

    await first.releaseSessionLease();
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(root, 'lease-history', firstLease.leaseId, 'lease.json'), 'utf8'),
      ),
      firstLease,
    );
    await competitor.acquireSessionLease();
    const recovered = await competitor.readActiveAttempt();
    assert.equal(recovered?.attemptId, uncertain.attemptId);
    await assert.rejects(
      () =>
        recoverBenchmarkAttempt(competitor, async (digest) => {
          if (digest === EXPECTED_DIGEST) return currentSuiResult(digest, 'success');
          throw new Error('not found');
        }),
      /remains unresolved/,
    );
    assert.equal((await competitor.readActiveAttempt())?.state, 'uncertain');
    await assert.rejects(
      () =>
        recoverBenchmarkAttempt(competitor, async () =>
          currentSuiResult(EXPECTED_DIGEST, 'success'),
        ),
      /does not match/,
    );

    await recoverBenchmarkAttempt(competitor, async (digest) =>
      currentSuiResult(digest, 'success'),
    );
    assert.equal(await competitor.readActiveAttempt(), null);
    assert.deepEqual(
      [...(await competitor.resolvedDigests())].sort(),
      [EXPECTED_DIGEST, REPORTED_DIGEST].sort(),
    );
    await assert.rejects(
      () =>
        competitor.beginAttempt({
          provenance: provenance(),
          mode: 'direct',
          expectedDigest: EXPECTED_DIGEST,
        }),
      /already exists in resolved history/,
    );
    await competitor.releaseSessionLease();
  });
});

test('ready attempts archive without submission', async () => {
  await withTempDirectory(async (root) => {
    const journal = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    await journal.acquireSessionLease();
    const ready = await journal.beginAttempt({
      provenance: provenance(),
      mode: 'direct',
      expectedDigest: EXPECTED_DIGEST,
    });
    await assert.rejects(
      () => journal.resolveSponsorRejected(ready),
      /Invalid sponsor_rejected event from ready/,
    );
    await journal.abandonReadyAttempt(ready);
    assert.equal(await journal.readActiveAttempt(), null);
    assert.deepEqual([...(await journal.resolvedDigests())], []);

    const reusable = await journal.beginAttempt({
      provenance: provenance(),
      mode: 'direct',
      expectedDigest: EXPECTED_DIGEST,
    });
    await journal.abandonReadyAttempt(reusable);

    await journal.releaseSessionLease();
  });
});

test('raw and report projections require exclusive creation before append or write', async () => {
  await withTempDirectory(async (root) => {
    const evidencePath = path.join(root, 'projection.jsonl');
    await assert.rejects(
      () => appendDurableJsonl(evidencePath, { recordType: 'implicit-create' }),
      (error) => error?.code === 'ENOENT',
    );
    await createDurableJsonl(evidencePath, {
      recordType: 'attempt',
      digest: EXPECTED_DIGEST,
    });
    await assert.rejects(
      () => createDurableJsonl(evidencePath, { recordType: 'replacement' }),
      (error) => error?.code === 'EEXIST',
    );
    await appendDurableJsonl(evidencePath, { recordType: 'terminal', digest: EXPECTED_DIGEST });
    const records = (await readFile(evidencePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.recordType),
      ['attempt', 'terminal'],
    );

    const reportPath = path.join(root, 'report.md');
    await writeExclusiveText(reportPath, 'first report\n');
    await assert.rejects(
      () => writeExclusiveText(reportPath, 'replacement report\n'),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(await readFile(reportPath, 'utf8'), 'first report\n');
  });
});

test('submitted outcome is derived from the current Sui terminal kind', async () => {
  await withTempDirectory(async (root) => {
    const journal = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    await journal.acquireSessionLease();
    const ready = await journal.beginAttempt({
      provenance: provenance(),
      mode: 'direct',
      expectedDigest: EXPECTED_DIGEST,
    });
    const started = await journal.markSubmissionStarted(ready);
    const resolved = await journal.resolveSubmittedResult(
      started,
      currentSuiResult(EXPECTED_DIGEST, 'failure'),
    );
    assert.equal(resolved.resolution.outcome, 'submitted_failed');
    assert.deepEqual(resolved.resolution.terminalProofs, [
      { source: 'sui_current_terminal', digest: EXPECTED_DIGEST, resultKind: 'failure' },
    ]);
    assert.equal(await journal.readActiveAttempt(), null);
    await journal.releaseSessionLease();
  });
});

test('resolved storage keys remain bound to the attempt identity', async () => {
  await withTempDirectory(async (root) => {
    const journal = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    await journal.acquireSessionLease();
    const ready = await journal.beginAttempt({
      provenance: provenance(),
      mode: 'direct',
      expectedDigest: EXPECTED_DIGEST,
    });
    await journal.abandonReadyAttempt(ready);
    await rename(
      path.join(root, 'resolved', `${ready.attemptId}.json`),
      path.join(root, 'resolved', 'wrong-attempt-name.json'),
    );

    await assert.rejects(() => journal.resolvedDigests(), /filename does not match its identity/);
    await journal.releaseSessionLease();
  });
});

test('a stale lease is recovered even when its PID now belongs to a live process', async () => {
  await withTempDirectory(async (root) => {
    const leaseId = '22222222-2222-4222-8222-222222222222';
    await mkdir(path.join(root, 'session.lock'));
    await writeFile(
      path.join(root, 'session.lock', 'lease.json'),
      `${JSON.stringify({
        schema: 'stelis_empty_execution_benchmark_session_v1',
        leaseId,
        pid: process.pid,
        socketPath: benchmarkLeaseSocketPath(root, leaseId),
        startedAt: '2026-07-14T00:00:00.000Z',
      })}\n`,
    );
    const journal = new EmptyExecutionBenchmarkJournal({
      root,
      chainIdentifier: 'chain-a',
      address: ADDRESS,
    });
    await journal.acquireSessionLease();
    assert.equal((await journal.readActiveAttempt()) === null, true);
    await journal.releaseSessionLease();
  });
});

test('a stale claimant cannot rename a newer live lease after another claimant archives its observation', async () => {
  await withTempDirectory(async (root) => {
    const staleLease = {
      schema: 'stelis_empty_execution_benchmark_session_v1',
      leaseId: '22222222-2222-4222-8222-222222222222',
      pid: process.pid,
      socketPath: benchmarkLeaseSocketPath(root, '22222222-2222-4222-8222-222222222222'),
      startedAt: '2026-07-14T00:00:00.000Z',
    };
    const newerLease = {
      ...staleLease,
      leaseId: '33333333-3333-4333-8333-333333333333',
      socketPath: benchmarkLeaseSocketPath(root, '33333333-3333-4333-8333-333333333333'),
      startedAt: '2026-07-14T00:00:01.000Z',
    };

    await mkdir(path.join(root, 'lease-history', staleLease.leaseId), { recursive: true });
    await writeFile(
      path.join(root, 'lease-history', staleLease.leaseId, 'lease.json'),
      `${JSON.stringify(staleLease)}\n`,
    );
    await mkdir(path.join(root, 'session.lock'));
    await writeFile(
      path.join(root, 'session.lock', 'lease.json'),
      `${JSON.stringify(newerLease)}\n`,
    );

    assert.equal(await archiveObservedSessionLease(root, staleLease), false);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, 'session.lock', 'lease.json'), 'utf8')),
      newerLease,
    );
  });
});
