import { describe, expect, test, vi } from 'vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorPoolAdapter } from '../src/context.js';
import {
  parseCurrentSuiTerminalForBytes,
  runPreflight,
  signAndSubmit,
  SponsorPostSignatureUncertaintyError,
} from '../src/session/sessionPrimitives.js';
import { grpcExecutionSuccess, grpcSimulationSuccess } from './helpers/suiGrpcExecutionFixtures.js';

const TX_BYTES = new Uint8Array([1, 2, 3, 4]);
const EXPECTED_DIGEST = TransactionDataBuilder.getDigestFromBytes(TX_BYTES);

function sponsorPool(): SponsorPoolAdapter {
  return {
    size: 1,
    primaryAddress: '0x1',
    addresses: () => ['0x1'],
    checkout: vi.fn(),
    commit: vi.fn(),
    sign: vi.fn(async () => ({ signature: 'sponsor-signature' })),
    checkin: vi.fn(),
  } as unknown as SponsorPoolAdapter;
}

describe('Sui terminal request binding', () => {
  test('accepts only an internally valid terminal for the submitted transaction bytes', () => {
    expect(
      parseCurrentSuiTerminalForBytes(grpcExecutionSuccess(EXPECTED_DIGEST), TX_BYTES)?.digest,
    ).toBe(EXPECTED_DIGEST);

    expect(
      parseCurrentSuiTerminalForBytes(grpcExecutionSuccess('different-digest'), TX_BYTES),
    ).toBeNull();
  });

  test('preflight fails closed when RPC returns a self-consistent result for another transaction', async () => {
    const sui = {
      simulateTransaction: vi.fn(async () => grpcSimulationSuccess('different-digest')),
    } as unknown as SuiGrpcClient;

    await expect(runPreflight(sui, TX_BYTES)).resolves.toEqual({
      success: false,
      reason: 'Simulation returned malformed terminal result',
    });
  });

  test('post-signature digest mismatch preserves the signed transaction identity', async () => {
    const pool = sponsorPool();
    const sui = {
      executeTransaction: vi.fn(async () => grpcExecutionSuccess('different-digest')),
    } as unknown as SuiGrpcClient;

    const thrown = await signAndSubmit(
      pool,
      sui,
      '0x1',
      'receipt',
      TX_BYTES,
      'user-signature',
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SponsorPostSignatureUncertaintyError);
    expect((thrown as SponsorPostSignatureUncertaintyError).expectedDigest).toBe(EXPECTED_DIGEST);
    expect((thrown as SponsorPostSignatureUncertaintyError).message).toContain(
      'malformed terminal result',
    );
    expect(pool.sign).toHaveBeenCalledTimes(1);
  });
});
