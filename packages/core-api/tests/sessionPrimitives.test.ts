import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { describe, expect, test, vi } from 'vitest';
import type { SponsorPoolAdapter } from '../src/context.js';
import {
  runPreflight,
  signAndSubmit,
  SponsorPostSignatureUncertaintyError,
} from '../src/session/sessionPrimitives.js';
import {
  moveAbortSuiExecutionError,
  suiEndpointSnapshotFixture,
  suiExecutionSuccess,
  suiSimulationFailure,
  suiSimulationSuccess,
} from './helpers/suiGatewayResultFixtures.js';

const { executeSuiTransactionMock, simulateSuiTransactionMock } = vi.hoisted(() => ({
  executeSuiTransactionMock: vi.fn(),
  simulateSuiTransactionMock: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  executeSuiTransaction: executeSuiTransactionMock,
  simulateSuiTransaction: simulateSuiTransactionMock,
}));

const TX_BYTES = new Uint8Array([1, 2, 3, 4]);
const EXPECTED_DIGEST = TransactionDataBuilder.getDigestFromBytes(TX_BYTES);
const SUI = suiEndpointSnapshotFixture();

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

describe('current Sui gateway results at the sponsor-session boundary', () => {
  test('preflight consumes one validated success result', async () => {
    simulateSuiTransactionMock.mockResolvedValueOnce(
      suiSimulationSuccess({
        computationCost: '3',
        storageCost: '2',
        storageRebate: '1',
      }),
    );

    await expect(runPreflight(SUI, TX_BYTES)).resolves.toEqual({
      success: true,
      gasUsed: {
        computationCost: '3',
        storageCost: '2',
        storageRebate: '1',
        nonRefundableStorageFee: '0',
      },
    });
    expect(simulateSuiTransactionMock).toHaveBeenCalledWith(SUI, { transaction: TX_BYTES });
  });

  test('preflight preserves the structured failure supplied by the gateway', async () => {
    const error = moveAbortSuiExecutionError({
      command: 0,
      packageId: '0xabc',
      module: 'settle',
      abortCode: '101',
      constantName: 'EClaimTooHigh',
    });
    simulateSuiTransactionMock.mockResolvedValueOnce(suiSimulationFailure(error));

    await expect(runPreflight(SUI, TX_BYTES)).resolves.toEqual({
      success: false,
      error,
    });
  });

  test('post-signature gateway rejection preserves the signed transaction identity', async () => {
    const pool = sponsorPool();
    executeSuiTransactionMock.mockRejectedValueOnce(new Error('qualified RPC unavailable'));

    const thrown = await signAndSubmit(
      pool,
      SUI,
      '0x1',
      'receipt',
      TX_BYTES,
      'user-signature',
      EXPECTED_DIGEST,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SponsorPostSignatureUncertaintyError);
    expect((thrown as SponsorPostSignatureUncertaintyError).expectedDigest).toBe(EXPECTED_DIGEST);
    expect(pool.sign).toHaveBeenCalledTimes(1);
  });

  test('a mismatched durable digest cannot obtain a sponsor signature', async () => {
    const pool = sponsorPool();
    executeSuiTransactionMock.mockClear();

    await expect(
      signAndSubmit(
        pool,
        SUI,
        '0x1',
        'receipt',
        TX_BYTES,
        'user-signature',
        TransactionDataBuilder.getDigestFromBytes(new Uint8Array([9, 9, 9])),
      ),
    ).rejects.toThrow('digest does not match its transaction bytes');
    expect(pool.sign).not.toHaveBeenCalled();
    expect(executeSuiTransactionMock).not.toHaveBeenCalled();
  });

  test('submission consumes one validated execution success result', async () => {
    const pool = sponsorPool();
    executeSuiTransactionMock.mockResolvedValueOnce(suiExecutionSuccess(EXPECTED_DIGEST));

    await expect(
      signAndSubmit(pool, SUI, '0x1', 'receipt', TX_BYTES, 'user-signature', EXPECTED_DIGEST),
    ).resolves.toMatchObject({
      success: true,
      executionStage: 'on_chain',
      digest: EXPECTED_DIGEST,
    });
    expect(pool.sign).toHaveBeenCalledWith('0x1', 'receipt', TX_BYTES);
    expect(executeSuiTransactionMock).toHaveBeenCalledWith(SUI, {
      transaction: TX_BYTES,
      expectedDigest: EXPECTED_DIGEST,
      signatures: ['user-signature', 'sponsor-signature'],
    });
  });
});
