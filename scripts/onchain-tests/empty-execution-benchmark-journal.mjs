import { link, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createConnection, createServer } from 'node:net';
import {
  applyAttemptJournalEvent,
  createAttemptJournal,
  currentSuiTerminalProof,
  parseAttemptJournal,
} from './empty-execution-benchmark-model.mjs';

const SESSION_LEASE_SCHEMA = 'stelis_empty_execution_benchmark_session_v1';
const LEASE_PROBE_TIMEOUT_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function benchmarkLeaseSocketPath(root, leaseId) {
  const socketKey = sha256Text(`${root}\n${leaseId}`);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\stelis-empty-benchmark-${socketKey}`
    : `/tmp/stelis-empty-benchmark-${socketKey}.sock`;
}

export function defaultBenchmarkJournalRoot(chainIdentifier, address) {
  const walletChainKey = sha256Text(`${chainIdentifier}\n${address}`);
  return path.join(
    homedir(),
    '.stelis',
    'onchain-tests',
    'empty-execution-benchmark',
    walletChainKey,
  );
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDurableDirectory(directory) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code === 'EEXIST') return;
    if (error?.code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    await ensureDurableDirectory(parent);
    try {
      await mkdir(directory);
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') return;
      throw retryError;
    }
  }
  await syncDirectory(path.dirname(directory));
}

async function writeSyncedTemp(directory, value) {
  await ensureDurableDirectory(directory);
  const tempPath = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tempPath;
}

async function writeExclusiveJson(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = await writeSyncedTemp(directory, value);
  try {
    await link(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function replaceJson(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = await writeSyncedTemp(directory, value);
  try {
    await rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writeExclusiveText(filePath, text) {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

export async function createDurableJsonl(filePath, record) {
  await writeExclusiveText(filePath, `${JSON.stringify(record)}\n`);
}

async function writeAllAt(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error('Durable JSONL append made no progress');
    offset += bytesWritten;
  }
}

export async function appendDurableJsonl(filePath, record) {
  const directory = path.dirname(filePath);
  const handle = await open(filePath, 'r+');
  try {
    const { size } = await handle.stat();
    await writeAllAt(handle, Buffer.from(`${JSON.stringify(record)}\n`), size);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function removeLeaseDirectory(directory) {
  await unlink(path.join(directory, 'lease.json')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rmdir(directory).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function parseSessionLease(value, root) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Benchmark session lease must be an object');
  }
  const keys = Object.keys(value).sort();
  const expected = ['schema', 'leaseId', 'pid', 'socketPath', 'startedAt'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Benchmark session lease is not the current exact shape');
  }
  if (value.schema !== SESSION_LEASE_SCHEMA) throw new Error('Unsupported benchmark session lease');
  if (typeof value.leaseId !== 'string' || !UUID.test(value.leaseId)) {
    throw new Error('Benchmark session leaseId is invalid');
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error('Benchmark session lease pid is invalid');
  }
  if (value.socketPath !== benchmarkLeaseSocketPath(root, value.leaseId)) {
    throw new Error('Benchmark session lease socketPath is invalid');
  }
  try {
    if (new Date(value.startedAt).toISOString() !== value.startedAt) throw new Error();
  } catch {
    throw new Error('Benchmark session lease startedAt is not a canonical UTC ISO timestamp');
  }
  return value;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Benchmark state is not valid JSON: ${filePath}`, { cause: error });
  }
}

async function startLeaseServer(socketPath, leaseId) {
  const server = createServer((socket) => {
    socket.end(`${leaseId}\n`);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  return server;
}

async function closeLeaseServer(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (process.platform !== 'win32') {
    await unlink(socketPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function probeLeaseServer(lease) {
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const socket = createConnection(lease.socketPath);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish('occupied'), LEASE_PROBE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.length > lease.leaseId.length + 1) finish('occupied');
    });
    socket.on('end', () => finish(response.trim() === lease.leaseId ? 'owned' : 'occupied'));
    socket.on('error', (error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') finish('stale');
      else finish('occupied');
    });
  });
}

/**
 * Move exactly the observed stale lease into a non-replaceable archive slot.
 *
 * The destination is the observed lease ID and contains lease.json. Every
 * stale takeover and normal release retains that destination. Once the
 * observed lease has left session.lock, its non-empty tombstone prevents this
 * rename from moving a newer session.lock directory (the stale-lease ABA case).
 */
export async function archiveObservedSessionLease(root, observedLease) {
  const lease = parseSessionLease(observedLease, root);
  const lockDirectory = path.join(root, 'session.lock');
  const lockRecordPath = path.join(lockDirectory, 'lease.json');
  const leaseHistoryDirectory = path.join(root, 'lease-history');
  const archivedDirectory = path.join(leaseHistoryDirectory, lease.leaseId);
  await ensureDurableDirectory(leaseHistoryDirectory);
  try {
    await rename(lockDirectory, archivedDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;

    let current;
    try {
      current = parseSessionLease(await readJson(lockRecordPath), root);
    } catch (readError) {
      if (readError?.code === 'ENOENT') return false;
      throw readError;
    }
    if (current.leaseId === lease.leaseId) {
      throw new Error('Stale benchmark lease archive conflicts with the current lease identity');
    }
    return false;
  }
  await Promise.all([syncDirectory(root), syncDirectory(leaseHistoryDirectory)]);
  return true;
}

export class EmptyExecutionBenchmarkJournal {
  constructor({ root, chainIdentifier, address }) {
    this.root = root;
    this.chainIdentifier = chainIdentifier;
    this.address = address;
    this.lockDirectory = path.join(root, 'session.lock');
    this.lockRecordPath = path.join(this.lockDirectory, 'lease.json');
    this.activePath = path.join(root, 'active.json');
    this.resolvedDirectory = path.join(root, 'resolved');
    this.lease = null;
    this.leaseServer = null;
  }

  async acquireSessionLease() {
    if (this.lease !== null) throw new Error('Benchmark session lease is already held');
    await ensureDurableDirectory(this.root);
    for (;;) {
      const lease = {
        schema: SESSION_LEASE_SCHEMA,
        leaseId: randomUUID(),
        pid: process.pid,
        socketPath: '',
        startedAt: nowIso(),
      };
      lease.socketPath = benchmarkLeaseSocketPath(this.root, lease.leaseId);
      let leaseServer;
      const candidateDirectory = path.join(this.root, `.session-lock-${lease.leaseId}`);
      try {
        leaseServer = await startLeaseServer(lease.socketPath, lease.leaseId);
        await mkdir(candidateDirectory, { mode: 0o700 });
        await writeExclusiveJson(path.join(candidateDirectory, 'lease.json'), lease);
        await syncDirectory(candidateDirectory);
        await rename(candidateDirectory, this.lockDirectory);
        await syncDirectory(this.root);
        this.lease = lease;
        this.leaseServer = leaseServer;
        return lease;
      } catch (error) {
        await removeLeaseDirectory(candidateDirectory).catch(() => undefined);
        if (leaseServer) await closeLeaseServer(leaseServer, lease.socketPath);
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      }

      let current;
      try {
        current = parseSessionLease(await readJson(this.lockRecordPath), this.root);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if ((await probeLeaseServer(current)) !== 'stale') {
        throw new Error(
          `Another empty-execution benchmark process owns this wallet on testnet (pid ${current.pid})`,
        );
      }

      if ((await archiveObservedSessionLease(this.root, current)) && process.platform !== 'win32') {
        await unlink(current.socketPath).catch(() => undefined);
      }
    }
  }

  async assertSessionLease() {
    if (this.lease === null) throw new Error('Benchmark session lease is not held');
    if (this.leaseServer === null || !this.leaseServer.listening) {
      throw new Error('Benchmark session lease server is not listening');
    }
    const current = parseSessionLease(await readJson(this.lockRecordPath), this.root);
    if (current.leaseId !== this.lease.leaseId) {
      throw new Error('Benchmark session lease ownership changed unexpectedly');
    }
  }

  async releaseSessionLease() {
    if (this.lease === null) return;
    await this.assertSessionLease();
    const lease = this.lease;
    const leaseServer = this.leaseServer;
    if (!(await archiveObservedSessionLease(this.root, lease))) {
      throw new Error('Benchmark session lease disappeared during release');
    }
    this.leaseServer = null;
    try {
      if (leaseServer !== null) await closeLeaseServer(leaseServer, lease.socketPath);
    } finally {
      this.lease = null;
    }
  }

  async readActiveAttempt() {
    await this.assertSessionLease();
    let value;
    try {
      value = await readJson(this.activePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    return parseAttemptJournal(value, this.chainIdentifier, this.address);
  }

  async resolvedDigests() {
    await this.assertSessionLease();
    await ensureDurableDirectory(this.resolvedDirectory);
    const digests = new Set();
    for (const name of await readdir(this.resolvedDirectory)) {
      if (!name.endsWith('.json')) continue;
      const attempt = parseAttemptJournal(
        await readJson(path.join(this.resolvedDirectory, name)),
        this.chainIdentifier,
        this.address,
      );
      if (attempt.state !== 'terminal') {
        throw new Error(`Resolved benchmark attempt is not terminal: ${name}`);
      }
      if (name !== `${attempt.attemptId}.json`) {
        throw new Error(`Resolved benchmark attempt filename does not match its identity: ${name}`);
      }
      for (const proof of attempt.resolution.terminalProofs) digests.add(proof.digest);
    }
    return digests;
  }

  async beginAttempt({ provenance, mode, expectedDigest }) {
    await this.assertSessionLease();
    if ((await this.readActiveAttempt()) !== null) {
      throw new Error('An active benchmark attempt already exists');
    }
    if ((await this.resolvedDigests()).has(expectedDigest)) {
      throw new Error(`Transaction digest ${expectedDigest} already exists in resolved history`);
    }
    const createdAt = nowIso();
    const attempt = createAttemptJournal({
      attemptId: randomUUID(),
      provenance,
      mode,
      expectedDigest,
      createdAt,
    });
    await writeExclusiveJson(this.activePath, attempt);
    return attempt;
  }

  async #replaceActive(previous, next) {
    await this.assertSessionLease();
    const current = await this.readActiveAttempt();
    const expectedPrevious = parseAttemptJournal(previous, this.chainIdentifier, this.address);
    const validatedNext = parseAttemptJournal(next, this.chainIdentifier, this.address);
    if (current === null || !isDeepStrictEqual(current, expectedPrevious)) {
      throw new Error('Active benchmark attempt changed unexpectedly');
    }
    if (validatedNext.attemptId !== expectedPrevious.attemptId) {
      throw new Error('Active benchmark attempt identity cannot change');
    }
    await replaceJson(this.activePath, validatedNext);
    return validatedNext;
  }

  async markSubmissionStarted(attempt) {
    const next = applyAttemptJournalEvent(attempt, {
      kind: 'submission_started',
      updatedAt: nowIso(),
    });
    return this.#replaceActive(attempt, next);
  }

  async markUncertain(attempt, candidateDigest = null) {
    const next = applyAttemptJournalEvent(attempt, {
      kind: 'submission_uncertain',
      candidateDigest,
      updatedAt: nowIso(),
    });
    return this.#replaceActive(attempt, next);
  }

  async #resolveEvent(attempt, event) {
    const terminal = applyAttemptJournalEvent(attempt, { ...event, updatedAt: nowIso() });
    await this.#replaceActive(attempt, terminal);
    await this.archiveTerminalAttempt(terminal);
    return terminal;
  }

  async abandonReadyAttempt(attempt) {
    return this.#resolveEvent(attempt, { kind: 'abandoned_before_submission' });
  }

  async resolveSponsorRejected(attempt) {
    return this.#resolveEvent(attempt, { kind: 'sponsor_rejected' });
  }

  async resolveSubmittedResult(attempt, result) {
    return this.#resolveEvent(attempt, {
      kind: 'submitted_terminal',
      terminalProof: currentSuiTerminalProof(result, attempt.expectedDigest),
    });
  }

  async resolveRecoveredResults(attempt, results) {
    if (!Array.isArray(results)) {
      throw new Error('Recovered Sui transaction results must be an array');
    }
    return this.#resolveEvent(attempt, {
      kind: 'recovered_chain_terminal',
      terminalProofs: results.map((result, index) =>
        currentSuiTerminalProof(result, attempt.reconciliationDigests[index]),
      ),
    });
  }

  async archiveTerminalAttempt(attempt) {
    await this.assertSessionLease();
    const expected = parseAttemptJournal(attempt, this.chainIdentifier, this.address);
    const current = await this.readActiveAttempt();
    if (
      current === null ||
      expected.state !== 'terminal' ||
      !isDeepStrictEqual(current, expected)
    ) {
      throw new Error('Only the current terminal benchmark attempt can be archived');
    }
    await ensureDurableDirectory(this.resolvedDirectory);
    const resolvedPath = path.join(this.resolvedDirectory, `${expected.attemptId}.json`);
    try {
      await link(this.activePath, resolvedPath);
      await syncDirectory(this.resolvedDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = parseAttemptJournal(
        await readJson(resolvedPath),
        this.chainIdentifier,
        this.address,
      );
      if (!isDeepStrictEqual(existing, expected)) {
        throw new Error('Resolved benchmark attempt path conflicts with another record');
      }
    }
    await unlink(this.activePath);
    await syncDirectory(this.root);
  }
}

/**
 * Resolve only the previous process's active attempt.
 *
 * `lookupCanonicalTerminal` is the sole external evidence port. It must
 * return the raw current Sui transaction-result union; the journal applies
 * the current parser itself. A failed
 * or mismatched lookup leaves active.json untouched and therefore blocks all
 * later transaction work for this wallet on this machine.
 */
export async function recoverBenchmarkAttempt(journal, lookupCanonicalTerminal) {
  const active = await journal.readActiveAttempt();
  if (active === null) return null;
  if (active.state === 'terminal') {
    await journal.archiveTerminalAttempt(active);
    return active;
  }
  if (active.state === 'ready') {
    return journal.abandonReadyAttempt(active);
  }

  const results = [];
  for (const digest of active.reconciliationDigests) {
    let result;
    try {
      result = await lookupCanonicalTerminal(digest);
    } catch (error) {
      throw new Error(
        `Active benchmark attempt remains unresolved. Canonical terminal lookup failed for ${digest}; this wallet cannot start new benchmark work.`,
        { cause: error },
      );
    }

    try {
      currentSuiTerminalProof(result, digest);
    } catch (error) {
      throw new Error(
        `Active benchmark attempt remains unresolved. Canonical terminal result for ${digest} does not match the expected digest or current Sui result shape; this wallet cannot start new benchmark work.`,
        { cause: error },
      );
    }
    results.push(result);
  }
  return journal.resolveRecoveredResults(active, results);
}
