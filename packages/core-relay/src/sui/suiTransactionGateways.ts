import { bcs } from '@mysten/sui/bcs';
import { parseSerializedSignature, SIGNATURE_SCHEME_TO_SIZE } from '@mysten/sui/cryptography';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { isValidTransactionDigest, toBase64 } from '@mysten/sui/utils';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import {
  malformedSuiResponse,
  runSuiPrimaryExecution,
  runSuiReadOperation,
  suiResourceNotFound,
  type SuiEndpointSnapshot,
} from './suiOperation.js';
import {
  parseRawEmptySuiCommandResults,
  parseRawSuiCommandResults,
  parseRawSuiBalanceChangesTransaction,
  parseRawSuiEffectsTransaction,
  parseRawSuiEventsTransaction,
  parseRawSuiExecutionTransaction,
  parseRawSuiSimulationTransaction,
  parseRawSuiMoveViewEvidence,
  parseExactSuiArray,
  rejectUnhandledSuiVariant,
  SuiTransactionShapeError,
  type SuiMoveViewResult,
  type SuiTransactionBalanceChangesResult,
  type SuiTransactionResult,
  type SuiTransactionWithEventsResult,
} from './suiTransactionShape.js';
import {
  bindSuiMoveViewTransactionBytes,
  resolveSuiMoveViewTransactionOnEndpoint,
} from './suiTransactionResolution.js';

export interface SuiTransactionBytesOptions {
  readonly transaction: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface SuiExecuteTransactionOptions extends SuiTransactionBytesOptions {
  readonly signatures: readonly string[];
}

export interface SuiTransactionDigestOptions {
  readonly digest: string;
  readonly signal?: AbortSignal;
}

export interface SuiMoveViewOptions {
  readonly transaction: Transaction;
  readonly signal?: AbortSignal;
}

const EXECUTED_EFFECTS_READ_MASK = [
  'digest',
  'effects.version',
  'effects.status',
  'effects.gas_used',
  'effects.transaction_digest',
  'effects.events_digest',
] as const;

const SIMULATION_EFFECTS_READ_MASK = [
  'transaction.digest',
  'transaction.effects.version',
  'transaction.effects.status',
  'transaction.effects.gas_used',
  'transaction.effects.transaction_digest',
  'transaction.effects.events_digest',
] as const;

const MOVE_VIEW_READ_MASK = [
  'transaction.transaction.bcs',
  'transaction.transaction.digest',
  'transaction.effects.version',
  'transaction.effects.status',
  'transaction.effects.gas_used',
  'transaction.effects.transaction_digest',
  'transaction.effects.events_digest',
  'command_outputs',
] as const;

const EXECUTED_EVENTS_READ_MASK = [
  ...EXECUTED_EFFECTS_READ_MASK,
  'events.digest',
  'events.events.package_id',
  'events.events.module',
  'events.events.sender',
  'events.events.event_type',
  'events.events.contents',
] as const;

function requireTransactionBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError('Sui transaction bytes must be a non-empty Uint8Array');
  }
  return value;
}

function requireDigest(value: string): string {
  if (!isValidTransactionDigest(value)) {
    throw new TypeError('Sui transaction digest is invalid');
  }
  return value;
}

function requestDigest(transaction: Uint8Array): string {
  const bytes = requireTransactionBytes(transaction);
  let canonical: Uint8Array;
  try {
    canonical = TransactionDataBuilder.fromBytes(bytes).build();
  } catch {
    throw new TypeError('Sui transaction bytes must contain current full TransactionData BCS');
  }
  if (
    canonical.length !== bytes.length ||
    !canonical.every((value, index) => value === bytes[index])
  ) {
    throw new TypeError('Sui transaction bytes must use canonical current TransactionData BCS');
  }
  return TransactionDataBuilder.getDigestFromBytes(bytes);
}

function canonicalSerializedBody(flag: number, body: Uint8Array): string {
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = flag;
  bytes.set(body, 1);
  return toBase64(bytes);
}

function parseCurrentSerializedSignature(signature: string): Uint8Array {
  const parsed = parseSerializedSignature(signature);
  const bytes =
    parsed.signatureScheme === 'Passkey' || parsed.signatureScheme === 'ZkLogin'
      ? parsed.signature
      : parsed.bytes;
  if (toBase64(bytes) !== signature) throw new Error('non-canonical base64');
  switch (parsed.signatureScheme) {
    case 'ED25519':
    case 'Secp256k1':
    case 'Secp256r1':
      if (
        parsed.signature.length !== 64 ||
        parsed.publicKey.length !== SIGNATURE_SCHEME_TO_SIZE[parsed.signatureScheme]
      ) {
        throw new Error('invalid simple signature length');
      }
      break;
    case 'MultiSig': {
      const body = bcs.MultiSig.serialize(parsed.multisig).toBytes();
      if (canonicalSerializedBody(bytes[0]!, body) !== signature) {
        throw new Error('non-canonical multisig');
      }
      break;
    }
    case 'Passkey': {
      const body = bcs.PasskeyAuthenticator.serialize({
        authenticatorData: parsed.authenticatorData,
        clientDataJson: parsed.clientDataJson,
        userSignature: parsed.userSignature,
      }).toBytes();
      if (canonicalSerializedBody(bytes[0]!, body) !== signature) {
        throw new Error('non-canonical passkey');
      }
      break;
    }
    case 'ZkLogin':
      if (
        getZkLoginSignature({
          inputs: parsed.zkLogin.inputs,
          maxEpoch: parsed.zkLogin.maxEpoch,
          userSignature: parsed.zkLogin.userSignature,
        }) !== signature
      ) {
        throw new Error('non-canonical zkLogin signature');
      }
      break;
    default:
      return rejectUnhandledSuiVariant(parsed, 'signature.signatureScheme');
  }
  return bytes;
}

function parseOrMalformed<T>(
  operation: Parameters<typeof malformedSuiResponse>[0],
  parse: () => T,
): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof SuiTransactionShapeError) throw malformedSuiResponse(operation);
    throw error;
  }
}

/** Simulate gas/effects against each qualified endpoint at most once. */
export function simulateSuiTransaction(
  snapshot: SuiEndpointSnapshot,
  options: SuiTransactionBytesOptions,
): Promise<SuiTransactionResult> {
  const transaction = requireTransactionBytes(options.transaction);
  const expectedDigest = requestDigest(transaction);
  return runSuiReadOperation(
    snapshot,
    'simulate_transaction',
    options.signal,
    async (client, context) => {
      const { response } = await client.transactionExecutionService.simulateTransaction(
        {
          transaction: { bcs: { value: transaction } },
          readMask: { paths: [...SIMULATION_EFFECTS_READ_MASK] },
          doGasSelection: false,
          checks: GrpcTypes.SimulateTransactionRequest_TransactionChecks.ENABLED,
        },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      return parseOrMalformed('simulate_transaction', () => {
        parseRawEmptySuiCommandResults(response.commandOutputs);
        return parseRawSuiSimulationTransaction(response.transaction, expectedDigest);
      });
    },
  );
}

/** Simulate a Move view with fixed effects and command-output evidence. */
export function simulateSuiMoveView(
  snapshot: SuiEndpointSnapshot,
  options: SuiMoveViewOptions,
): Promise<SuiMoveViewResult> {
  if (!(options.transaction instanceof Transaction)) {
    throw new TypeError('Sui Move view requires a Transaction');
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.from(options.transaction);
  } catch (error) {
    throw new TypeError('Sui Move view requires a synchronously snapshotable Transaction', {
      cause: error,
    });
  }
  return runSuiReadOperation(
    snapshot,
    'simulate_move_view',
    options.signal,
    async (client, context) => {
      const resolved = await resolveSuiMoveViewTransactionOnEndpoint(client, transaction, context);
      const { response } = await client.transactionExecutionService.simulateTransaction(
        {
          transaction: resolved.transaction,
          readMask: { paths: [...MOVE_VIEW_READ_MASK] },
          doGasSelection: false,
          checks: GrpcTypes.SimulateTransactionRequest_TransactionChecks.DISABLED,
        },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      return parseOrMalformed('simulate_move_view', () => {
        const evidence = parseRawSuiMoveViewEvidence(response.transaction);
        const expectedDigest = bindSuiMoveViewTransactionBytes(
          evidence.transactionBcs,
          resolved.data,
        );
        if (evidence.resolvedTransactionDigest !== expectedDigest) {
          throw new SuiTransactionShapeError(
            'moveView.transaction.transaction.digest',
            'does not match the returned TransactionData BCS',
          );
        }
        const commandResults = parseRawSuiCommandResults(response.commandOutputs);
        if (!evidence.status.success) {
          return { outcome: 'failure', error: evidence.status.error };
        }
        if (commandResults.length !== resolved.data.commands.length) {
          throw new SuiTransactionShapeError(
            'simulation.commandOutputs',
            'command result count does not match the resolved PTB',
          );
        }
        return {
          outcome: 'success',
          commandResults,
        } as const;
      });
    },
  );
}

/** Submit signed bytes to the primary qualified endpoint exactly once. */
export function executeSuiTransaction(
  snapshot: SuiEndpointSnapshot,
  options: SuiExecuteTransactionOptions,
): Promise<SuiTransactionWithEventsResult> {
  const transaction = requireTransactionBytes(options.transaction);
  const expectedDigest = requestDigest(transaction);
  if (!Array.isArray(options.signatures) || options.signatures.length === 0) {
    throw new TypeError('Signed Sui execution requires at least one signature');
  }
  const signatures = parseExactSuiArray(options.signatures, 'signatures').map((signature) => {
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new TypeError('Sui signatures must use the current serialized signature format');
    }
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = parseCurrentSerializedSignature(signature);
    } catch {
      throw new TypeError('Sui signatures must use the current serialized signature format');
    }
    return { bcs: { value: signatureBytes }, signature: { oneofKind: undefined } } as const;
  });

  return runSuiPrimaryExecution(snapshot, options.signal, async (client, context) => {
    const { response } = await client.transactionExecutionService.executeTransaction(
      {
        transaction: { bcs: { value: transaction } },
        signatures,
        readMask: { paths: [...EXECUTED_EVENTS_READ_MASK] },
      },
      { timeout: context.timeoutMs, abort: context.signal },
    );
    return parseOrMalformed('execute_transaction', () =>
      parseRawSuiExecutionTransaction(response.transaction, expectedDigest),
    );
  });
}

/** Look up exact transaction effects across the qualified read endpoints. */
export function getSuiTransactionEffects(
  snapshot: SuiEndpointSnapshot,
  options: SuiTransactionDigestOptions,
): Promise<SuiTransactionResult> {
  const expectedDigest = requireDigest(options.digest);
  return runSuiReadOperation(
    snapshot,
    'get_transaction_effects',
    options.signal,
    async (client, context) => {
      const { response } = await client.ledgerService.getTransaction(
        { digest: expectedDigest, readMask: { paths: [...EXECUTED_EFFECTS_READ_MASK] } },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      if (!response.transaction) {
        throw suiResourceNotFound('get_transaction_effects', expectedDigest);
      }
      return parseOrMalformed('get_transaction_effects', () =>
        parseRawSuiEffectsTransaction(response.transaction, expectedDigest),
      );
    },
  );
}

/** Look up exact transaction events across the qualified read endpoints. */
export function getSuiTransactionEvents(
  snapshot: SuiEndpointSnapshot,
  options: SuiTransactionDigestOptions,
): Promise<SuiTransactionWithEventsResult> {
  const expectedDigest = requireDigest(options.digest);
  return runSuiReadOperation(
    snapshot,
    'get_transaction_events',
    options.signal,
    async (client, context) => {
      const { response } = await client.ledgerService.getTransaction(
        { digest: expectedDigest, readMask: { paths: [...EXECUTED_EVENTS_READ_MASK] } },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      if (!response.transaction) {
        throw suiResourceNotFound('get_transaction_events', expectedDigest);
      }
      return parseOrMalformed('get_transaction_events', () =>
        parseRawSuiEventsTransaction(response.transaction, expectedDigest),
      );
    },
  );
}

/** Look up exact per-transaction balance changes across qualified read endpoints. */
export function getSuiTransactionBalanceChanges(
  snapshot: SuiEndpointSnapshot,
  options: SuiTransactionDigestOptions,
): Promise<SuiTransactionBalanceChangesResult> {
  const expectedDigest = requireDigest(options.digest);
  return runSuiReadOperation(
    snapshot,
    'get_transaction_balance_changes',
    options.signal,
    async (client, context) => {
      const { response } = await client.ledgerService.getTransaction(
        {
          digest: expectedDigest,
          readMask: { paths: ['digest', 'balance_changes'] },
        },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      if (!response.transaction) {
        throw suiResourceNotFound('get_transaction_balance_changes', expectedDigest);
      }
      return parseOrMalformed('get_transaction_balance_changes', () =>
        parseRawSuiBalanceChangesTransaction(response.transaction, expectedDigest),
      );
    },
  );
}
