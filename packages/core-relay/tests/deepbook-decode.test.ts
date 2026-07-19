/**
 * getQuantityOut / getHopMidPriceRaw / getInputForTargetOutput
 *  — success decode + direction tests.
 *
 * Uses the real installed Transaction shape while mocking only the exact
 * Move-view gateway. This keeps ABI command construction observable without
 * replacing the SDK class that the gateway intentionally validates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import type { DeepBookPoolHop } from '@stelis/contracts';
import { SlippageQueryError } from '../src/deepbookErrors.js';
import {
  createSuiEndpointSnapshot,
  SuiOperationError,
  type SuiEndpointSnapshot,
} from '../src/sui/suiOperation.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeExactPureU64Base64 } from '../src/decodeU64.js';
import { fromBase64 } from '@mysten/sui/utils';

const mockState = vi.hoisted(() => ({
  simulateSuiMoveView: vi.fn(),
  builtTransactions: [] as unknown[],
}));

vi.mock('../src/sui/suiTransactionGateways.js', () => ({
  simulateSuiMoveView: (snapshot: unknown, options: { transaction: Transaction }) => {
    mockState.builtTransactions.push(options.transaction);
    return mockState.simulateSuiMoveView(snapshot, options);
  },
}));

beforeEach(() => {
  mockState.simulateSuiMoveView.mockReset();
  mockState.builtTransactions.length = 0;
});

// ── Import after mock ───────────────────────────────────────────────────────

import {
  batchGetHopMidPrices,
  getQuantityOut,
  getHopMidPriceRaw,
  getInputForTargetOutput,
} from '../src/deepbook.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

function makeHop(swapDirection: 'baseForQuote' | 'quoteForBase' = 'baseForQuote'): DeepBookPoolHop {
  return {
    poolId: `0x${'1'.repeat(64)}`,
    baseType: `0x${'2'.repeat(64)}::base::BASE`,
    quoteType: `0x${'3'.repeat(64)}::quote::QUOTE`,
    swapDirection,
    feeBps: 0,
  };
}

const DEEPBOOK_PACKAGE_ID = `0x${'d'.repeat(64)}`;

interface ObservedMoveCall {
  readonly package: string;
  readonly module: string;
  readonly function: string;
  readonly typeArguments: readonly string[];
  readonly arguments: readonly { readonly Input?: number }[];
}

function lastMoveCall(): { readonly call: ObservedMoveCall; readonly inputs: readonly unknown[] } {
  const transaction = mockState.builtTransactions.at(-1) as Transaction | undefined;
  if (!transaction) throw new Error('Expected the Move-view gateway to receive a Transaction');
  const data = transaction.getData();
  const command = data.commands[0] as { MoveCall?: ObservedMoveCall } | undefined;
  if (!command?.MoveCall) throw new Error('Expected one MoveCall command');
  return { call: command.MoveCall, inputs: data.inputs };
}

function pureInputBase64(
  call: ObservedMoveCall,
  inputs: readonly unknown[],
  argumentIndex: number,
): string {
  const inputIndex = call.arguments[argumentIndex]?.Input;
  if (typeof inputIndex !== 'number') throw new Error('Expected a direct pure input argument');
  const input = inputs[inputIndex] as { Pure?: { bytes?: unknown } } | undefined;
  if (typeof input?.Pure?.bytes !== 'string') throw new Error('Expected a Pure input');
  return input.Pure.bytes;
}

function make3TupleResult(baseOut: bigint, quoteOut: bigint, deepReq: bigint) {
  return makeSimulationResult([
    {
      returnValues: [
        { bcs: encodeU64LE(baseOut) },
        { bcs: encodeU64LE(quoteOut) },
        { bcs: encodeU64LE(deepReq) },
      ],
    },
  ]);
}

function makeSimulationResult(commandResults: unknown[]) {
  const digest = TransactionDataBuilder.getDigestFromBytes(new Uint8Array([0xaa, 0xbb]));
  return {
    outcome: 'success' as const,
    digest,
    effects: {
      version: 2 as const,
      transactionDigest: digest,
      status: { success: true as const, error: null },
      gasUsed: {
        computationCost: '0',
        storageCost: '0',
        storageRebate: '0',
        nonRefundableStorageFee: '0',
      },
      eventsDigest: null,
    },
    commandResults: commandResults.map((value) => {
      const command = value as Record<string, unknown>;
      return {
        ...command,
        mutatedReferences: command.mutatedReferences ?? [],
      };
    }),
  };
}

function snapshot(): SuiEndpointSnapshot {
  return createSuiEndpointSnapshot([{ network: 'testnet' } as SuiGrpcClient]);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getQuantityOut — success decode + direction', () => {
  it('baseForQuote returns returnValues[1] (quoteOut)', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(make3TupleResult(0n, 27_000_000n, 5_000n));

    const result = await getQuantityOut(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('baseForQuote'),
      1_000_000n,
    );
    expect(result).toBe(27_000_000n); // quoteOut
  });

  it('quoteForBase returns returnValues[0] (baseOut)', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(make3TupleResult(37_000_000n, 0n, 3_000n));

    const result = await getQuantityOut(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('quoteForBase'),
      1_000_000n,
    );
    expect(result).toBe(37_000_000n); // baseOut
  });

  it('decodes u64 max correctly', async () => {
    const u64Max = 18_446_744_073_709_551_615n;
    mockState.simulateSuiMoveView.mockResolvedValueOnce(make3TupleResult(0n, u64Max, 0n));

    const result = await getQuantityOut(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('baseForQuote'),
      1n,
    );
    expect(result).toBe(u64Max);
  });

  it('throws SlippageQueryError when BCS buffer is too short', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: new Uint8Array([1, 2, 3]) }, // 3 bytes, not 8
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(50n) },
          ],
        },
      ]),
    );

    await expect(
      getQuantityOut(
        snapshot(),
        DEEPBOOK_PACKAGE_ID,
        makeHop('quoteForBase'), // would read index 0 = malformed
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when fewer than 3 return values', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(200n) },
            // Missing 3rd element
          ],
        },
      ]),
    );

    await expect(
      getQuantityOut(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1_000_000n),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('rejects extra quantity-out return values instead of ignoring ABI drift', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(200n) },
            { bcs: encodeU64LE(0n) },
            { bcs: encodeU64LE(999n) },
          ],
        },
      ]),
    );
    await expect(
      getQuantityOut(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1_000_000n),
    ).rejects.toThrow(/expected 3 return values, got 4/);
  });
});

describe('getInputForTargetOutput — success decode + direction', () => {
  it('baseForQuote dispatches get_base_quantity_in with pay_with_deep=false', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      make3TupleResult(123_000n, 27_000_000n, 5_000n),
    );

    const quote = await getInputForTargetOutput(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('baseForQuote'),
      27_000_000n,
    );

    const { call, inputs } = lastMoveCall();
    expect(`${call.package}::${call.module}::${call.function}`).toBe(
      `${DEEPBOOK_PACKAGE_ID}::pool::get_base_quantity_in`,
    );
    expect(call.typeArguments).toEqual([makeHop().baseType, makeHop().quoteType]);
    // arguments: [pool, target_quote, pay_with_deep, clock]
    expect(call.arguments).toHaveLength(4);
    expect(decodeExactPureU64Base64(pureInputBase64(call, inputs, 1))).toBe(27_000_000n);
    expect(fromBase64(pureInputBase64(call, inputs, 2))).toEqual(new Uint8Array([0]));

    // bfq tuple interpretation: input = pos 0, actualOutput = pos 1
    expect(quote.inputAmountSmallest).toBe(123_000n);
    expect(quote.quantityInActualOutputSmallest).toBe(27_000_000n);
    expect(quote.deepRequiredAmount).toBe(5_000n);
  });

  it('quoteForBase dispatches get_quote_quantity_in with pay_with_deep=false', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      make3TupleResult(37_000_000n, 956_193n, 0n),
    );

    const quote = await getInputForTargetOutput(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('quoteForBase'),
      37_000_000n,
    );

    const { call, inputs } = lastMoveCall();
    expect(`${call.package}::${call.module}::${call.function}`).toBe(
      `${DEEPBOOK_PACKAGE_ID}::pool::get_quote_quantity_in`,
    );
    expect(call.typeArguments).toEqual([makeHop().baseType, makeHop().quoteType]);
    expect(call.arguments).toHaveLength(4);
    expect(decodeExactPureU64Base64(pureInputBase64(call, inputs, 1))).toBe(37_000_000n);
    expect(fromBase64(pureInputBase64(call, inputs, 2))).toEqual(new Uint8Array([0]));

    // qfb tuple interpretation: input = pos 1, actualOutput = pos 0
    expect(quote.inputAmountSmallest).toBe(956_193n);
    expect(quote.quantityInActualOutputSmallest).toBe(37_000_000n);
    expect(quote.deepRequiredAmount).toBe(0n);
  });

  it('returns zero tuple as-is (caller policy decides fail-closed)', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(make3TupleResult(0n, 0n, 0n));

    const quote = await getInputForTargetOutput(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('quoteForBase'),
      1_000_000_000n,
    );

    expect(quote.inputAmountSmallest).toBe(0n);
    expect(quote.quantityInActualOutputSmallest).toBe(0n);
    expect(quote.deepRequiredAmount).toBe(0n);
  });

  it('decodes u64 max correctly', async () => {
    const u64Max = 18_446_744_073_709_551_615n;
    mockState.simulateSuiMoveView.mockResolvedValueOnce(make3TupleResult(u64Max, 1n, 0n));

    const quote = await getInputForTargetOutput(
      snapshot(),
      DEEPBOOK_PACKAGE_ID,
      makeHop('baseForQuote'),
      1n,
    );

    expect(quote.inputAmountSmallest).toBe(u64Max);
  });

  it('throws SlippageQueryError when BCS buffer is too short', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: new Uint8Array([1, 2, 3]) }, // 3 bytes, not 8
            { bcs: encodeU64LE(50n) },
          ],
        },
      ]),
    );

    await expect(
      getInputForTargetOutput(
        snapshot(),
        DEEPBOOK_PACKAGE_ID,
        makeHop('baseForQuote'), // would read pos 1 (quoteValue) → malformed
        1_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when fewer than 3 return values', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(200n) },
            // Missing 3rd element (deep_required)
          ],
        },
      ]),
    );

    await expect(
      getInputForTargetOutput(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1_000n),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when BCS field is missing at index', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            {
              /* no bcs at index 1 */
            },
            { bcs: encodeU64LE(50n) },
          ],
        },
      ]),
    );

    await expect(
      getInputForTargetOutput(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1_000n),
    ).rejects.toThrow(SlippageQueryError);
  });
});

describe('typed Sui operation boundary', () => {
  function operationError(): SuiOperationError {
    return new SuiOperationError('transport_unavailable', {
      operation: 'simulate_move_view',
      attempt: 2,
      maxAttempts: 2,
    });
  }

  it('preserves the exact simulation error through quantity-out', async () => {
    const error = operationError();
    mockState.simulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(
      getQuantityOut(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1_000_000n),
    ).rejects.toBe(error);
  });

  it('preserves the exact simulation error through quantity-in without changing the ABI call', async () => {
    const error = operationError();
    mockState.simulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(
      getInputForTargetOutput(
        snapshot(),
        DEEPBOOK_PACKAGE_ID,
        makeHop('baseForQuote'),
        27_000_000n,
      ),
    ).rejects.toBe(error);

    const { call, inputs } = lastMoveCall();
    expect(`${call.package}::${call.module}::${call.function}`).toBe(
      `${DEEPBOOK_PACKAGE_ID}::pool::get_base_quantity_in`,
    );
    expect(fromBase64(pureInputBase64(call, inputs, 2))).toEqual(new Uint8Array([0]));
  });

  it('keeps completed-view ABI failures in the market domain', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(1n) },
            // missing positions 1 and 2
          ],
        },
      ]),
    );

    await expect(
      getInputForTargetOutput(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop('baseForQuote'), 1n),
    ).rejects.toMatchObject({
      name: 'SlippageQueryError',
      message: expect.stringMatching(/^get_base_quantity_in: command 0 expected 3 return values/),
    });
  });
});

describe('getHopMidPriceRaw — success decode', () => {
  it('returns decoded bigint mid-price', async () => {
    const expectedMidPrice = 27_000_000_000n;
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [{ bcs: encodeU64LE(expectedMidPrice) }],
        },
      ]),
    );

    const result = await getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop());
    expect(result).toBe(expectedMidPrice);
  });

  it('rejects a missing mid-price command result instead of manufacturing no liquidity', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(makeSimulationResult([]));

    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop())).rejects.toThrow(
      /expected 1 command results, got 0/,
    );
  });

  it('rejects a missing mid-price BCS value instead of manufacturing no liquidity', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        {
          returnValues: [
            {
              /* no bcs */
            },
          ],
        },
      ]),
    );

    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop())).rejects.toThrow(
      SlippageQueryError,
    );
  });

  it('rejects extra mid-price command results and return values', async () => {
    const command = { returnValues: [{ bcs: encodeU64LE(1n) }] };
    mockState.simulateSuiMoveView.mockResolvedValueOnce(makeSimulationResult([command, command]));
    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop())).rejects.toThrow(
      /expected 1 command results, got 2/,
    );

    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([
        { returnValues: [{ bcs: encodeU64LE(1n) }, { bcs: encodeU64LE(2n) }] },
      ]),
    );
    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop())).rejects.toThrow(
      /expected 1 return values, got 2/,
    );
  });

  it('preserves the typed simulation error', async () => {
    const error = new SuiOperationError('deadline_exceeded', {
      operation: 'simulate_move_view',
      attempt: 1,
      maxAttempts: 1,
    });
    mockState.simulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, makeHop())).rejects.toBe(error);
  });
});

describe('batchGetHopMidPrices — exact command/result binding', () => {
  it('rejects a missing command result instead of substituting a zero price', async () => {
    mockState.simulateSuiMoveView.mockResolvedValueOnce(
      makeSimulationResult([{ returnValues: [{ bcs: encodeU64LE(1n) }] }]),
    );

    await expect(
      batchGetHopMidPrices(snapshot(), DEEPBOOK_PACKAGE_ID, [
        makeHop('baseForQuote'),
        makeHop('quoteForBase'),
      ]),
    ).rejects.toThrow(/expected 2 command results, got 1/);
  });
});
