import { describe, expect, it, vi } from 'vitest';
import { toBase64 } from '@mysten/sui/utils';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { executeSponsorSlotRefill } from '../../src/sponsor-operations/executeRefill.js';

function u64Bytes(value: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return toBase64(bytes);
}

function addressBytes(hexAddress: string): string {
  const hex = hexAddress.startsWith('0x') ? hexAddress.slice(2) : hexAddress;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return toBase64(bytes);
}

describe('executeSponsorSlotRefill', () => {
  it('builds a tx.gas split-and-transfer transaction for the sponsor slot refill amount', async () => {
    const amountMist = 123_456_789n;
    const sponsorAddress = `0x${'11'.repeat(32)}`;
    let capturedTransaction: Transaction | null = null;
    const signer = {
      signAndExecuteTransaction: vi.fn(async ({ transaction }: { transaction: Transaction }) => {
        capturedTransaction = transaction;
        return {
          Transaction: {
            digest: '0xrefill',
            effects: { status: { success: true } },
          },
        };
      }),
    } as unknown as Ed25519Keypair;

    const result = await executeSponsorSlotRefill({
      sui: {} as SuiGrpcClient,
      signer,
      sponsorAddress,
      amountMist,
    });

    expect(result).toEqual({ success: true, digest: '0xrefill', error: null });
    expect(signer.signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(capturedTransaction).not.toBeNull();

    const data = capturedTransaction!.getData() as { commands: unknown[]; inputs: unknown[] };
    expect(data.commands).toHaveLength(2);
    expect(data.inputs).toHaveLength(2);

    expect(data.commands[0]).toEqual({
      $kind: 'SplitCoins',
      SplitCoins: {
        coin: { $kind: 'GasCoin', GasCoin: true },
        amounts: [{ $kind: 'Input', Input: 0, type: 'pure' }],
      },
    });
    expect(data.inputs[0]).toEqual({ $kind: 'Pure', Pure: { bytes: u64Bytes(amountMist) } });

    expect(data.commands[1]).toEqual({
      $kind: 'TransferObjects',
      TransferObjects: {
        objects: [{ $kind: 'NestedResult', NestedResult: [0, 0] }],
        address: { $kind: 'Input', Input: 1, type: 'pure' },
      },
    });
    expect(data.inputs[1]).toEqual({ $kind: 'Pure', Pure: { bytes: addressBytes(sponsorAddress) } });
  });
});
