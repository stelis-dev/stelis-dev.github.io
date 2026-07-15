import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';

const mocks = vi.hoisted(() => {
  class MockSuiOperationError extends Error {
    constructor(
      readonly kind: string,
      readonly diagnostic: Record<string, unknown> = {},
    ) {
      super('redacted Sui operation error');
    }
  }
  return {
    MockSuiOperationError,
    getSuiChainIdentifier: vi.fn(),
    snapshotClients: new WeakMap<object, readonly SuiGrpcClient[]>(),
  };
});

vi.mock('@stelis/core-relay', () => ({
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS: 30_000,
  SuiOperationError: mocks.MockSuiOperationError,
  createSuiEndpointSnapshot: (endpoints: readonly SuiGrpcClient[]) => {
    if (endpoints.length === 0) throw new TypeError('at least one endpoint');
    const ordered = Object.freeze([...endpoints]);
    const snapshot = Object.freeze({
      endpointCount: ordered.length,
      network: ordered[0]!.network,
    });
    mocks.snapshotClients.set(snapshot, ordered);
    return snapshot;
  },
  getSuiChainIdentifier: mocks.getSuiChainIdentifier,
}));

import { SUI_OPERATION_ATTEMPT_TIMEOUT_MS } from '@stelis/core-relay';
import {
  qualifySuiRpcEndpoints,
  type SuiRpcQualificationContext,
} from '../src/sui/qualifiedSuiRpc.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ENDPOINTS = [
  { baseUrl: 'https://a.example.test' },
  { baseUrl: 'https://b.example.test' },
  { baseUrl: 'https://c.example.test' },
] as const;

describe('qualifySuiRpcEndpoints', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.getSuiChainIdentifier.mockReset();
  });

  it('keeps configured order after concurrent qualification and freezes accepted N', async () => {
    const chainResults = [
      deferred<{ chainIdentifier: string }>(),
      deferred<{ chainIdentifier: string }>(),
      deferred<{ chainIdentifier: string }>(),
    ];
    const candidateIndex = new WeakMap<SuiGrpcClient, number>();
    mocks.getSuiChainIdentifier.mockImplementation((snapshot: object) => {
      const index = mocks.getSuiChainIdentifier.mock.calls.length - 1;
      candidateIndex.set(mocks.snapshotClients.get(snapshot)![0]!, index);
      return chainResults[index]!.promise;
    });
    const qualify = vi.fn(async ({ snapshot }: SuiRpcQualificationContext) => {
      const index = candidateIndex.get(mocks.snapshotClients.get(snapshot)![0]!)!;
      if (index === 1) {
        throw new Error('provider secret must not escape');
      }
      return Object.freeze({ sourceIndex: index });
    });

    const pending = qualifySuiRpcEndpoints({ network: 'testnet', endpoints: ENDPOINTS, qualify });
    chainResults[2]!.resolve({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet });
    chainResults[0]!.resolve({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet });
    chainResults[1]!.resolve({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet });
    const result = await pending;

    expect(result.snapshot.endpointCount).toBe(2);
    expect(
      mocks.snapshotClients.get(result.snapshot)?.map((client) => candidateIndex.get(client)),
    ).toEqual([0, 2]);
    expect(result.primaryQualification).toEqual({ sourceIndex: 0 });
    expect(result.rejected).toEqual([
      { url: 'https://b.example.test', kind: 'qualification_failed' },
    ]);
    expect(result.adminSnapshot.endpoints.map(({ origin }) => origin)).toEqual([
      'https://a.example.test',
      'https://c.example.test',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.rejected)).toBe(true);
    expect(JSON.stringify(result.rejected)).not.toContain('secret');
    expect(JSON.stringify(result.adminSnapshot)).not.toContain('sourceIndex');
  });

  it('excludes chain mismatches and failed identity reads without surrogate proof', async () => {
    mocks.getSuiChainIdentifier
      .mockResolvedValueOnce({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet })
      .mockResolvedValueOnce({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.mainnet })
      .mockRejectedValueOnce(new TypeError('programming error'));
    const qualify = vi.fn(async () => {});

    const result = await qualifySuiRpcEndpoints({
      network: 'testnet',
      endpoints: ENDPOINTS,
      qualify,
    });

    expect(result.snapshot.endpointCount).toBe(1);
    expect(result.primaryQualification).toBeUndefined();
    expect(result.rejected).toEqual([
      { url: 'https://b.example.test', kind: 'chain_identifier_mismatch' },
      { url: 'https://c.example.test', kind: 'chain_identifier_failed' },
    ]);
    expect(qualify).toHaveBeenCalledTimes(1);
    expect(mocks.getSuiChainIdentifier).toHaveBeenCalledTimes(3);
    for (const [snapshot] of mocks.getSuiChainIdentifier.mock.calls as Array<
      [{ readonly endpointCount: number }]
    >) {
      expect(snapshot.endpointCount).toBe(1);
    }
  });

  it('caps the injected actual qualification suite at the core-relay attempt budget', async () => {
    vi.useFakeTimers();
    mocks.getSuiChainIdentifier.mockResolvedValue({
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    let qualificationSignal: AbortSignal | undefined;
    const qualify = vi.fn(({ signal }: SuiRpcQualificationContext) => {
      qualificationSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('callback observed the qualification deadline')),
          { once: true },
        );
      });
    });

    const pending = qualifySuiRpcEndpoints({
      network: 'testnet',
      endpoints: [ENDPOINTS[0]],
      qualify,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'NoQualifiedSuiRpcEndpointsError',
      rejected: [{ url: 'https://a.example.test', kind: 'qualification_timeout' }],
    });
    await vi.advanceTimersByTimeAsync(SUI_OPERATION_ATTEMPT_TIMEOUT_MS);

    await rejection;
    expect(qualificationSignal?.aborted).toBe(true);
  });

  it('aborts unfinished sibling reads when the actual qualification suite rejects early', async () => {
    mocks.getSuiChainIdentifier.mockResolvedValue({
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    let qualificationSignal: AbortSignal | undefined;
    let siblingAborted = false;
    const qualify = vi.fn(({ signal }: SuiRpcQualificationContext) => {
      qualificationSignal = signal;
      const failedRead = Promise.reject(new Error('one actual readiness read failed'));
      const unfinishedSibling = new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            siblingAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return Promise.all([failedRead, unfinishedSibling]);
    });

    await expect(
      qualifySuiRpcEndpoints({
        network: 'testnet',
        endpoints: [ENDPOINTS[0]],
        qualify,
      }),
    ).rejects.toMatchObject({
      rejected: [{ url: 'https://a.example.test', kind: 'qualification_failed' }],
    });
    expect(qualificationSignal?.aborted).toBe(true);
    expect(siblingAborted).toBe(true);
  });

  it('makes caller cancellation terminal when every endpoint is still qualifying', async () => {
    mocks.getSuiChainIdentifier.mockResolvedValue({
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    const controller = new AbortController();
    const qualify = vi.fn(
      ({ signal }: SuiRpcQualificationContext) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('callback observed caller cancellation')),
            { once: true },
          );
        }),
    );
    const pending = qualifySuiRpcEndpoints({
      network: 'testnet',
      endpoints: ENDPOINTS.slice(0, 2),
      qualify,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'QualificationBoundaryError',
      kind: 'aborted',
    });

    await Promise.resolve();
    controller.abort();

    await rejection;
  });

  it('does not return an accepted endpoint when a later qualification is caller-aborted', async () => {
    const candidateIndex = new WeakMap<SuiGrpcClient, number>();
    mocks.getSuiChainIdentifier.mockImplementation(async (snapshot: object) => {
      const index = mocks.getSuiChainIdentifier.mock.calls.length - 1;
      candidateIndex.set(mocks.snapshotClients.get(snapshot)![0]!, index);
      return { chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet };
    });
    const firstQualification = deferred<string>();
    const secondQualification = deferred<string>();
    const controller = new AbortController();
    const qualify = vi.fn(({ snapshot, signal }: SuiRpcQualificationContext) => {
      const index = candidateIndex.get(mocks.snapshotClients.get(snapshot)![0]!)!;
      const result = index === 0 ? firstQualification : secondQualification;
      signal.addEventListener(
        'abort',
        () => result.reject(new Error('callback observed caller cancellation')),
        { once: true },
      );
      return result.promise;
    });

    const pending = qualifySuiRpcEndpoints({
      network: 'testnet',
      endpoints: ENDPOINTS.slice(0, 2),
      qualify,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(qualify).toHaveBeenCalledTimes(2));
    firstQualification.resolve('accepted before cancellation');
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'QualificationBoundaryError',
      kind: 'aborted',
    });
  });

  it('does not return an accepted endpoint when another chain read is caller-aborted', async () => {
    const controller = new AbortController();
    mocks.getSuiChainIdentifier
      .mockResolvedValueOnce({ chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet })
      .mockImplementationOnce(
        (_snapshot: object, options: { readonly signal?: AbortSignal } | undefined) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new mocks.MockSuiOperationError('aborted')),
              { once: true },
            );
          }),
      );
    const qualify = vi.fn(async () => 'accepted before cancellation');

    const pending = qualifySuiRpcEndpoints({
      network: 'testnet',
      endpoints: ENDPOINTS.slice(0, 2),
      qualify,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(qualify).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'QualificationBoundaryError',
      kind: 'aborted',
    });
  });

  it('does not lose an abort while the qualification listener is being registered', async () => {
    mocks.getSuiChainIdentifier.mockResolvedValue({
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const qualify = vi.fn(async () => 'must not run');

    await expect(
      qualifySuiRpcEndpoints({
        network: 'testnet',
        endpoints: [ENDPOINTS[0]],
        qualify,
        signal,
      }),
    ).rejects.toMatchObject({
      name: 'QualificationBoundaryError',
      kind: 'aborted',
    });
    expect(qualify).not.toHaveBeenCalled();
  });

  it('does not accept a callback that aborts the caller and resolves in the same turn', async () => {
    mocks.getSuiChainIdentifier.mockResolvedValue({
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    const controller = new AbortController();
    const qualify = vi.fn(async () => {
      controller.abort();
      return 'must not be accepted';
    });

    await expect(
      qualifySuiRpcEndpoints({
        network: 'testnet',
        endpoints: [ENDPOINTS[0]],
        qualify,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: 'QualificationBoundaryError',
      kind: 'aborted',
    });
    expect(qualify).toHaveBeenCalledTimes(1);
  });

  it('rejects empty configuration without manufacturing a fallback endpoint', async () => {
    await expect(
      qualifySuiRpcEndpoints({ network: 'testnet', endpoints: [], qualify: async () => {} }),
    ).rejects.toThrow('at least one configured endpoint');
    expect(mocks.getSuiChainIdentifier).not.toHaveBeenCalled();
  });
});
