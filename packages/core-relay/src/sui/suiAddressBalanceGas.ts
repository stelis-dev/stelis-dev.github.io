import { createHash } from 'node:crypto';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getSuiEndpointSnapshotChainIdentifier,
  malformedSuiResponse,
  runSuiReadOperation,
  SuiOperationError,
  type ChainBoundSuiEndpointSnapshot,
} from './suiOperation.js';
import { simulateSuiTransaction } from './suiTransactionGateways.js';
import {
  resolveSuiTransactionOnEndpoint,
  type EndpointResolutionContext,
} from './suiTransactionResolution.js';
import type { SuiSimulationResult } from './suiTransactionShape.js';
import { SUI_U64_MAX, isSuiU64 } from './suiU64.js';

declare const ADDRESS_BALANCE_GAS_TRANSACTION: unique symbol;

/** Validated full transaction that spends the sponsor's address SUI balance. */
export interface AddressBalanceGasTransaction {
  readonly [ADDRESS_BALANCE_GAS_TRANSACTION]: true;
}

interface BuildAddressBalanceGasTransactionOptions {
  readonly transaction: Transaction;
  readonly sponsorAddress: string;
  readonly gasBudget: bigint;
  readonly signal?: AbortSignal;
}

interface AddressBalanceGasTransactionContents {
  readonly bytes: Uint8Array;
  readonly txBytesHash: string;
  readonly snapshot: ChainBoundSuiEndpointSnapshot;
}

/**
 * The resolver returned a current transaction that pays with `Coin<SUI>`
 * objects because the requested sponsor address balance could not supply gas.
 * This is a sponsor-capacity result, not a malformed RPC response.
 */
export class SuiAddressBalanceGasUnavailableError extends Error {
  constructor() {
    super('Sponsor address balance cannot supply the requested gas budget');
    this.name = 'SuiAddressBalanceGasUnavailableError';
  }
}

const CONTENTS = new WeakMap<AddressBalanceGasTransaction, AddressBalanceGasTransactionContents>();

function requireContents(
  transaction: AddressBalanceGasTransaction,
): AddressBalanceGasTransactionContents {
  const contents = CONTENTS.get(transaction);
  if (!contents) {
    throw new TypeError('Address-balance gas transaction was not created by its builder');
  }
  return contents;
}

function validateSourceTransaction(transaction: Transaction): Transaction {
  if (!(transaction instanceof Transaction)) {
    throw new TypeError('Address-balance gas builder requires a Transaction');
  }
  const source = Transaction.from(transaction);
  const data = source.getData();
  if (
    data.sender === null ||
    data.gasData.owner !== null ||
    data.gasData.price !== null ||
    data.gasData.budget !== null ||
    data.gasData.payment !== null ||
    data.expiration !== null
  ) {
    throw new TypeError(
      'Address-balance gas transaction requires a sender and no preset gas or expiration fields',
    );
  }
  return source;
}

function requireSponsorAddress(value: string): string {
  if (!isValidSuiAddress(value)) {
    throw new TypeError('Address-balance gas sponsor address is invalid');
  }
  return normalizeSuiAddress(value);
}

function requireGasBudget(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > SUI_U64_MAX) {
    throw new TypeError('Address-balance gas budget must be a positive Sui u64');
  }
  return value;
}

async function readReferenceGasPrice(
  endpoint: SuiGrpcClient,
  context: EndpointResolutionContext,
): Promise<bigint> {
  const { response } = await endpoint.ledgerService.getEpoch(
    { readMask: { paths: ['reference_gas_price'] } },
    { timeout: context.timeoutMs, abort: context.signal },
  );
  const price = response.epoch?.referenceGasPrice;
  if (!isSuiU64(price) || price === 0n) {
    throw malformedSuiResponse('resolve_transaction');
  }
  return price;
}

function requireExactGasEnvelope(
  bytes: Uint8Array,
  sponsorAddress: string,
  gasBudget: bigint,
  gasPrice: bigint,
  chainIdentifier: string,
): boolean {
  let data: ReturnType<TransactionDataBuilder['snapshot']>;
  try {
    data = TransactionDataBuilder.fromBytes(bytes).snapshot();
  } catch {
    throw malformedSuiResponse('resolve_transaction');
  }

  const gas = data.gasData;
  if (
    gas.owner === null ||
    normalizeSuiAddress(gas.owner) !== sponsorAddress ||
    gas.budget === null ||
    BigInt(gas.budget) !== gasBudget ||
    gas.price === null ||
    BigInt(gas.price) !== gasPrice ||
    !Array.isArray(gas.payment)
  ) {
    throw malformedSuiResponse('resolve_transaction');
  }
  const usesAddressBalance = gas.payment.length === 0;

  if (data.expiration?.$kind !== 'ValidDuring') {
    throw malformedSuiResponse('resolve_transaction');
  }
  const validDuring = data.expiration.ValidDuring;
  if (
    validDuring.minEpoch === null ||
    validDuring.maxEpoch === null ||
    BigInt(validDuring.maxEpoch) !== BigInt(validDuring.minEpoch) + 1n ||
    validDuring.minTimestamp !== null ||
    validDuring.maxTimestamp !== null ||
    validDuring.chain !== chainIdentifier
  ) {
    throw malformedSuiResponse('resolve_transaction');
  }
  // TransactionData BCS decoding above is the single width check for nonce.
  void validDuring.nonce;
  return usesAddressBalance;
}

/**
 * Resolve and seal one transaction that pays gas from the sponsor's address
 * balance. Each endpoint attempt reads price and resolves through that endpoint.
 */
export async function buildAddressBalanceGasTransaction(
  snapshot: ChainBoundSuiEndpointSnapshot,
  options: BuildAddressBalanceGasTransactionOptions,
): Promise<AddressBalanceGasTransaction> {
  const source = validateSourceTransaction(options.transaction);
  const sponsorAddress = requireSponsorAddress(options.sponsorAddress);
  const gasBudget = requireGasBudget(options.gasBudget);
  const chainIdentifier = getSuiEndpointSnapshotChainIdentifier(snapshot);
  let capacityObserved = false;

  try {
    return await runSuiReadOperation(
      snapshot,
      'resolve_transaction',
      options.signal,
      async (endpoint, context) => {
        const gasPrice = await readReferenceGasPrice(endpoint, context);
        context.assertActive();

        const candidate = Transaction.from(source);
        candidate.setGasOwner(sponsorAddress);
        candidate.setGasBudget(gasBudget);
        candidate.setGasPrice(gasPrice);
        const resolved = await resolveSuiTransactionOnEndpoint(
          endpoint,
          TransactionDataBuilder.restore(candidate.getData()),
          {},
          context,
        );
        context.assertActive();

        const bytes = resolved.transactionBytes;
        if (bytes === null) {
          throw malformedSuiResponse('resolve_transaction');
        }
        if (!requireExactGasEnvelope(bytes, sponsorAddress, gasBudget, gasPrice, chainIdentifier)) {
          capacityObserved = true;
          // A valid Coin fallback is retryable across the qualified fleet, but
          // the fleet-level failure remains a sponsor-capacity result below.
          throw malformedSuiResponse('resolve_transaction');
        }
        const token = Object.freeze({}) as AddressBalanceGasTransaction;
        CONTENTS.set(token, {
          bytes: bytes.slice(),
          txBytesHash: createHash('sha256').update(bytes).digest('hex'),
          snapshot,
        });
        return token;
      },
    );
  } catch (error) {
    if (capacityObserved && error instanceof SuiOperationError && error.kind !== 'aborted') {
      throw new SuiAddressBalanceGasUnavailableError();
    }
    throw error;
  }
}

/** Simulate a sealed address-balance gas transaction without exposing its bytes. */
export function simulateAddressBalanceGasTransaction(
  transaction: AddressBalanceGasTransaction,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SuiSimulationResult> {
  const contents = requireContents(transaction);
  return simulateSuiTransaction(contents.snapshot, {
    transaction: contents.bytes.slice(),
    signal: options.signal,
  });
}

/** Return a defensive copy for the prepare runner's response and durable entry. */
export function getAddressBalanceGasTransactionBytes(
  transaction: AddressBalanceGasTransaction,
): Uint8Array {
  return requireContents(transaction).bytes.slice();
}

/** Return the SHA-256 hash bound to the same validated bytes. */
export function getAddressBalanceGasTransactionTxBytesHash(
  transaction: AddressBalanceGasTransaction,
): string {
  return requireContents(transaction).txBytesHash;
}
