import { RpcError } from '@protobuf-ts/runtime-rpc';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it, vi } from 'vitest';
import {
  createSuiEndpointSnapshot,
  malformedSuiResponse,
  runSuiPrimaryExecution,
  runSuiReadOperation,
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  SuiOperationError,
} from '../src/sui/suiOperation.js';

function client(network = 'testnet'): SuiGrpcClient {
  return { network } as SuiGrpcClient;
}

describe('Sui endpoint and attempt authority', () => {
  it('freezes one ordered same-network endpoint snapshot', () => {
    const first = client();
    const second = client();
    const snapshot = createSuiEndpointSnapshot([first, second]);

    expect(snapshot).toEqual({ endpointCount: 2, network: 'testnet' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect('primary' in snapshot).toBe(false);
    expect('endpoints' in snapshot).toBe(false);
    expect(() => createSuiEndpointSnapshot([first, first])).toThrow('more than once');
    expect(() => createSuiEndpointSnapshot([first, client('mainnet')])).toThrow('one network');
  });

  it('retries only redacted read failures and preserves endpoint order', async () => {
    const first = client();
    const second = client();
    const calls: SuiGrpcClient[] = [];
    const attempt = vi.fn(async (current: SuiGrpcClient) => {
      calls.push(current);
      if (current === first) throw malformedSuiResponse('get_object');
      return 'accepted';
    });

    await expect(
      runSuiReadOperation(
        createSuiEndpointSnapshot([first, second]),
        'get_object',
        undefined,
        attempt,
      ),
    ).resolves.toBe('accepted');
    expect(calls).toEqual([first, second]);
  });

  it('does not retry request, internal, or non-retryable RPC errors', async () => {
    const snapshot = createSuiEndpointSnapshot([client(), client()]);
    const typeAttempt = vi.fn(async () => {
      throw new TypeError('provider detail must not escape');
    });
    await expect(
      runSuiReadOperation(snapshot, 'get_balance', undefined, typeAttempt),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
      message: 'Sui operation request was invalid',
    });
    expect(typeAttempt).toHaveBeenCalledTimes(1);

    const internalAttempt = vi.fn(async () => {
      throw new Error('private implementation detail');
    });
    await expect(
      runSuiReadOperation(snapshot, 'get_balance', undefined, internalAttempt),
    ).rejects.toMatchObject({
      kind: 'internal_error',
      message: 'Sui operation failed internally',
    });
    expect(internalAttempt).toHaveBeenCalledTimes(1);

    const rejectedAttempt = vi.fn(async () => {
      throw new RpcError('permission detail must not escape', 'PERMISSION_DENIED');
    });
    await expect(
      runSuiReadOperation(snapshot, 'get_balance', undefined, rejectedAttempt),
    ).rejects.toMatchObject({ kind: 'rpc_rejected', message: 'Sui RPC rejected the operation' });
    expect(rejectedAttempt).toHaveBeenCalledTimes(1);

    const unboundNotFoundAttempt = vi.fn(async () => {
      throw new RpcError('method or service not found', 'NOT_FOUND');
    });
    await expect(
      runSuiReadOperation(snapshot, 'get_object', undefined, unboundNotFoundAttempt),
    ).rejects.toMatchObject({
      kind: 'rpc_rejected',
      message: 'Sui RPC rejected the operation',
      diagnostic: { rpcCode: 'NOT_FOUND' },
    });
    expect(unboundNotFoundAttempt).toHaveBeenCalledTimes(1);
  });

  it('submits signed execution to the primary exactly once', async () => {
    const primary = client();
    const secondary = client();
    const attempt = vi.fn(async (current: SuiGrpcClient) => {
      expect(current).toBe(primary);
      throw new RpcError('unavailable', 'UNAVAILABLE');
    });

    await expect(
      runSuiPrimaryExecution(createSuiEndpointSnapshot([primary, secondary]), undefined, attempt),
    ).rejects.toBeInstanceOf(SuiOperationError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('caps every read attempt and the total operation at N multiplied by U', async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn(() => new Promise<never>(() => undefined));
      const operation = runSuiReadOperation(
        createSuiEndpointSnapshot([client(), client()]),
        'get_object',
        undefined,
        attempt,
      );
      const rejection = expect(operation).rejects.toMatchObject({
        kind: 'deadline_exceeded',
        diagnostic: { attempt: 2, maxAttempts: 2 },
      });

      await vi.advanceTimersByTimeAsync(SUI_OPERATION_ATTEMPT_TIMEOUT_MS);
      expect(attempt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SUI_OPERATION_ATTEMPT_TIMEOUT_MS);
      await rejection;
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops immediately when the caller aborts and never advances to another endpoint', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => new Promise<never>(() => undefined));
    const operation = runSuiReadOperation(
      createSuiEndpointSnapshot([client(), client()]),
      'get_object',
      controller.signal,
      attempt,
    );
    const rejection = expect(operation).rejects.toMatchObject({ kind: 'aborted' });

    controller.abort();
    await rejection;
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not lose an abort that lands while the listener is being registered', async () => {
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const attempt = vi.fn(async () => 'must not run');

    await expect(
      runSuiReadOperation(createSuiEndpointSnapshot([client()]), 'get_object', signal, attempt),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('does not accept a result when caller abort wins in the same microtask turn', async () => {
    const controller = new AbortController();
    const completed = Promise.resolve('must not be accepted');
    completed.then(() => controller.abort());
    const attempt = vi.fn(() => completed);

    await expect(
      runSuiReadOperation(
        createSuiEndpointSnapshot([client()]),
        'get_object',
        controller.signal,
        attempt,
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
