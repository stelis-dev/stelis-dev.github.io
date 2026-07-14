/**
 * getQuantityOut / getHopMidPriceRaw / getInputForTargetOutput
 *  — success decode + direction tests.
 *
 * Uses vi.mock('@mysten/sui/transactions') to make Transaction.build()
 * return dummy bytes, so the real decode + direction-selection logic
 * inside the helpers is exercised end-to-end. The mock also captures
 * each moveCall so tests can lock the dispatched function name and
 * argument shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { DeepBookPoolHop } from '@stelis/contracts';
import { SlippageQueryError } from '../src/deepbookErrors.js';

// ── Mock Transaction so build() returns dummy bytes + capture moveCalls ────

const mockState = vi.hoisted(() => ({
  moveCalls: [] as Array<{
    target: string;
    typeArguments: unknown[];
    arguments: unknown[];
  }>,
}));

vi.mock('@mysten/sui/transactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mysten/sui/transactions')>();
  class MockTransaction {
    moveCall(arg: { target: string; typeArguments?: unknown[]; arguments?: unknown[] }) {
      mockState.moveCalls.push({
        target: arg.target,
        typeArguments: arg.typeArguments ?? [],
        arguments: arg.arguments ?? [],
      });
    }
    object(id?: unknown) {
      return { kind: 'object', id };
    }
    pure = {
      u64: (value: bigint) => ({ kind: 'u64', value }),
      bool: (value: boolean) => ({ kind: 'bool', value }),
    };
    setSender() {}
    async build() {
      return new Uint8Array([0xaa, 0xbb]);
    }
  }
  return {
    ...actual,
    Transaction: MockTransaction,
  };
});

beforeEach(() => {
  mockState.moveCalls.length = 0;
});

// ── Import after mock ───────────────────────────────────────────────────────

import { getQuantityOut, getHopMidPriceRaw, getInputForTargetOutput } from '../src/deepbook.js';

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
    poolId: '0xPOOL',
    baseType: '0xBASE',
    quoteType: '0xQUOTE',
    swapDirection,
    feeBps: 0,
  };
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
    $kind: 'Transaction' as const,
    Transaction: {
      digest,
      status: { success: true as const, error: null },
    },
    commandResults,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getQuantityOut — success decode + direction', () => {
  it('baseForQuote returns returnValues[1] (quoteOut)', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(0n, 27_000_000n, 5_000n)),
    };

    const result = await getQuantityOut(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('baseForQuote'),
      1_000_000n,
    );
    expect(result).toBe(27_000_000n); // quoteOut
  });

  it('quoteForBase returns returnValues[0] (baseOut)', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(37_000_000n, 0n, 3_000n)),
    };

    const result = await getQuantityOut(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('quoteForBase'),
      1_000_000n,
    );
    expect(result).toBe(37_000_000n); // baseOut
  });

  it('decodes u64 max correctly', async () => {
    const u64Max = 18_446_744_073_709_551_615n;
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(0n, u64Max, 0n)),
    };

    const result = await getQuantityOut(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('baseForQuote'),
      1n,
    );
    expect(result).toBe(u64Max);
  });

  it('throws SlippageQueryError when BCS buffer is too short', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [
              { bcs: new Uint8Array([1, 2, 3]) }, // 3 bytes, not 8
              { bcs: encodeU64LE(100n) },
              { bcs: encodeU64LE(50n) },
            ],
          },
        ]),
      ),
    };

    await expect(
      getQuantityOut(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('quoteForBase'), // would read index 0 = malformed
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when fewer than 3 return values', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [
              { bcs: encodeU64LE(100n) },
              { bcs: encodeU64LE(200n) },
              // Missing 3rd element
            ],
          },
        ]),
      ),
    };

    await expect(
      getQuantityOut(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });
});

describe('getInputForTargetOutput — success decode + direction', () => {
  it('baseForQuote dispatches get_base_quantity_in with pay_with_deep=false', async () => {
    const mockClient = {
      simulateTransaction: vi
        .fn()
        .mockResolvedValue(make3TupleResult(123_000n, 27_000_000n, 5_000n)),
    };

    const quote = await getInputForTargetOutput(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('baseForQuote'),
      27_000_000n,
    );

    expect(mockState.moveCalls).toHaveLength(1);
    const call = mockState.moveCalls[0];
    expect(call.target).toBe('0xdeepbook::pool::get_base_quantity_in');
    expect(call.typeArguments).toEqual(['0xBASE', '0xQUOTE']);
    // arguments: [pool, target_quote, pay_with_deep, clock]
    expect(call.arguments).toHaveLength(4);
    expect(call.arguments[1]).toEqual({ kind: 'u64', value: 27_000_000n });
    expect(call.arguments[2]).toEqual({ kind: 'bool', value: false });

    // bfq tuple interpretation: input = pos 0, actualOutput = pos 1
    expect(quote.inputAmountSmallest).toBe(123_000n);
    expect(quote.quantityInActualOutputSmallest).toBe(27_000_000n);
    expect(quote.deepRequiredAmount).toBe(5_000n);
  });

  it('quoteForBase dispatches get_quote_quantity_in with pay_with_deep=false', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(37_000_000n, 956_193n, 0n)),
    };

    const quote = await getInputForTargetOutput(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('quoteForBase'),
      37_000_000n,
    );

    expect(mockState.moveCalls).toHaveLength(1);
    const call = mockState.moveCalls[0];
    expect(call.target).toBe('0xdeepbook::pool::get_quote_quantity_in');
    expect(call.typeArguments).toEqual(['0xBASE', '0xQUOTE']);
    expect(call.arguments).toHaveLength(4);
    expect(call.arguments[1]).toEqual({ kind: 'u64', value: 37_000_000n });
    expect(call.arguments[2]).toEqual({ kind: 'bool', value: false });

    // qfb tuple interpretation: input = pos 1, actualOutput = pos 0
    expect(quote.inputAmountSmallest).toBe(956_193n);
    expect(quote.quantityInActualOutputSmallest).toBe(37_000_000n);
    expect(quote.deepRequiredAmount).toBe(0n);
  });

  it('returns zero tuple as-is (caller policy decides fail-closed)', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(0n, 0n, 0n)),
    };

    const quote = await getInputForTargetOutput(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('quoteForBase'),
      1_000_000_000n,
    );

    expect(quote.inputAmountSmallest).toBe(0n);
    expect(quote.quantityInActualOutputSmallest).toBe(0n);
    expect(quote.deepRequiredAmount).toBe(0n);
  });

  it('decodes u64 max correctly', async () => {
    const u64Max = 18_446_744_073_709_551_615n;
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(make3TupleResult(u64Max, 1n, 0n)),
    };

    const quote = await getInputForTargetOutput(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop('baseForQuote'),
      1n,
    );

    expect(quote.inputAmountSmallest).toBe(u64Max);
  });

  it('throws SlippageQueryError when BCS buffer is too short', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [
              { bcs: encodeU64LE(100n) },
              { bcs: new Uint8Array([1, 2, 3]) }, // 3 bytes, not 8
              { bcs: encodeU64LE(50n) },
            ],
          },
        ]),
      ),
    };

    await expect(
      getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'), // would read pos 1 (quoteValue) → malformed
        1_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when fewer than 3 return values', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [
              { bcs: encodeU64LE(100n) },
              { bcs: encodeU64LE(200n) },
              // Missing 3rd element (deep_required)
            ],
          },
        ]),
      ),
    };

    await expect(
      getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError when BCS field is missing at index', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
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
      ),
    };

    await expect(
      getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
  });
});

describe('simulateTransaction-rejection path (Transaction.build mocked)', () => {
  // These tests prove that when Transaction.build succeeds (mocked dummy bytes)
  // and simulateTransaction rejects, the helpers wrap the underlying error in a
  // SlippageQueryError with a stable message-shape, AND that simulateTransaction
  // was actually invoked. This locks the post-build failure branch in deepbook.ts
  // that the deepbook.test.ts build-fail tests cannot reach.

  it('getQuantityOut: simulateTransaction reject → SlippageQueryError with stable prefix', async () => {
    const simulateTransaction = vi.fn().mockRejectedValue(new Error('upstream RPC: 503'));
    const mockClient = { simulateTransaction };

    await expect(
      getQuantityOut(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);

    // Re-invoke to capture the thrown error and lock the message shape.
    let thrown: unknown = null;
    simulateTransaction.mockClear();
    simulateTransaction.mockRejectedValueOnce(new Error('upstream RPC: 503'));
    try {
      await getQuantityOut(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1_000_000n,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SlippageQueryError);
    expect((thrown as Error).message).toBe('get_quantity_out RPC failed: upstream RPC: 503');
  });

  it('getInputForTargetOutput baseForQuote: simulateTransaction reject → SlippageQueryError with get_base_quantity_in prefix', async () => {
    const simulateTransaction = vi.fn().mockRejectedValue(new Error('grpc unavailable'));
    const mockClient = { simulateTransaction };

    let thrown: unknown = null;
    try {
      await getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        27_000_000n,
      );
    } catch (err) {
      thrown = err;
    }

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(SlippageQueryError);
    expect((thrown as Error).message).toBe('get_base_quantity_in RPC failed: grpc unavailable');

    // The dispatched moveCall must still have been the bfq function with pay_with_deep=false.
    const call = mockState.moveCalls.at(-1);
    expect(call?.target).toBe('0xdeepbook::pool::get_base_quantity_in');
    expect(call?.arguments[2]).toEqual({ kind: 'bool', value: false });
  });

  it('getInputForTargetOutput quoteForBase: simulateTransaction reject → SlippageQueryError with get_quote_quantity_in prefix', async () => {
    const simulateTransaction = vi.fn().mockRejectedValue(new Error('connection reset'));
    const mockClient = { simulateTransaction };

    let thrown: unknown = null;
    try {
      await getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('quoteForBase'),
        37_000_000n,
      );
    } catch (err) {
      thrown = err;
    }

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(SlippageQueryError);
    expect((thrown as Error).message).toBe('get_quote_quantity_in RPC failed: connection reset');
  });

  it('getInputForTargetOutput: pre-existing SlippageQueryError (decode-time) is rethrown unwrapped', async () => {
    // commandResults too short triggers the inner `rv.length < 3` SlippageQueryError;
    // the catch block must rethrow it as-is, NOT wrap it again with "RPC failed:".
    const simulateTransaction = vi.fn().mockResolvedValue(
      makeSimulationResult([
        {
          returnValues: [
            { bcs: encodeU64LE(1n) },
            // missing positions 1 and 2
          ],
        },
      ]),
    );
    const mockClient = { simulateTransaction };

    let thrown: unknown = null;
    try {
      await getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop('baseForQuote'),
        1n,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SlippageQueryError);
    // Must NOT be the "RPC failed:" wrapper — must be the inner decode-time error.
    expect((thrown as Error).message).toMatch(/^get_base_quantity_in: expected 3 return values/);
    expect((thrown as Error).message).not.toMatch(/RPC failed/);
  });
});

describe('getHopMidPriceRaw — success decode', () => {
  it('returns decoded bigint mid-price', async () => {
    const expectedMidPrice = 27_000_000_000n;
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [{ bcs: encodeU64LE(expectedMidPrice) }],
          },
        ]),
      ),
    };

    const result = await getHopMidPriceRaw(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop(),
    );
    expect(result).toBe(expectedMidPrice);
  });

  it('returns null when commandResults are empty', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(makeSimulationResult([])),
    };

    const result = await getHopMidPriceRaw(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop(),
    );
    expect(result).toBeNull();
  });

  it('returns null when BCS is missing', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(
        makeSimulationResult([
          {
            returnValues: [
              {
                /* no bcs */
              },
            ],
          },
        ]),
      ),
    };

    const result = await getHopMidPriceRaw(
      mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
      '0xdeepbook',
      makeHop(),
    );
    expect(result).toBeNull();
  });

  it('rejects command results attached to a different transaction digest', async () => {
    const resultForAnotherTransaction = makeSimulationResult([
      { returnValues: [{ bcs: encodeU64LE(27_000_000_000n) }] },
    ]);
    resultForAnotherTransaction.Transaction.digest = 'different-digest';
    const mockClient = {
      simulateTransaction: vi.fn().mockResolvedValue(resultForAnotherTransaction),
    };

    await expect(
      getHopMidPriceRaw(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop(),
      ),
    ).rejects.toThrow(/malformed or mismatched simulation result/);
  });

  it('throws SlippageQueryError when simulateTransaction rejects (RPC failure)', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    };

    await expect(
      getHopMidPriceRaw(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop(),
      ),
    ).rejects.toThrow(SlippageQueryError);
  });

  it('throws SlippageQueryError with RPC-specific message', async () => {
    const mockClient = {
      simulateTransaction: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    await expect(
      getHopMidPriceRaw(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        makeHop(),
      ),
    ).rejects.toThrow(/simulateTransaction failed.*connection refused/);
  });
});
