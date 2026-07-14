import { createHash } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { encodePrepareAuthorizationMessage } from '@stelis/core-relay';
import type { SuiNetwork } from '@stelis/contracts';
import type { PrepareParams } from '../src/handlers/prepare.js';

export const TEST_PREPARE_AUTH_KEYPAIR = Ed25519Keypair.generate();
export const TEST_PREPARE_AUTH_SENDER = TEST_PREPARE_AUTH_KEYPAIR.getPublicKey().toSuiAddress();

let nonceCounter = 0;

type PrepareAuthFields = Pick<
  PrepareParams,
  | 'txKindBytesHash'
  | 'prepareAuthorizationTimestampMs'
  | 'prepareAuthorizationRequestNonce'
  | 'prepareAuthorizationSignature'
>;

type PrepareAuthInput = Omit<PrepareParams, keyof PrepareAuthFields>;

interface PrepareAuthorizationOptions extends Partial<PrepareAuthFields> {
  keypair?: Ed25519Keypair;
  network?: SuiNetwork;
  packageId?: string;
}

export async function withPrepareAuthorization(
  input: PrepareAuthInput,
  overrides: PrepareAuthorizationOptions = {},
): Promise<PrepareParams> {
  const keypair = overrides.keypair ?? TEST_PREPARE_AUTH_KEYPAIR;
  const timestampMs = overrides.prepareAuthorizationTimestampMs ?? Date.now();
  const requestNonce =
    overrides.prepareAuthorizationRequestNonce ?? `test-prepare-nonce-${++nonceCounter}`;
  const txKindBytesHash = overrides.txKindBytesHash ?? hashTxKindBytes(input.txKindBytes);

  const message = encodePrepareAuthorizationMessage({
    network: overrides.network ?? 'testnet',
    packageId: overrides.packageId ?? '0xPACKAGE',
    senderAddress: input.senderAddress,
    txKindBytesHash,
    settlementTokenType: input.settlementTokenType,
    slippageBps: input.slippageBps,
    gasMarginBps: input.gasMarginBps,
    orderId: input.orderId,
    timestampMs,
    requestNonce,
  });
  const { signature } = await keypair.signPersonalMessage(message);

  return {
    ...input,
    txKindBytesHash,
    prepareAuthorizationTimestampMs: timestampMs,
    prepareAuthorizationRequestNonce: requestNonce,
    prepareAuthorizationSignature: overrides.prepareAuthorizationSignature ?? signature,
  };
}

function hashTxKindBytes(txKindBytes: string): string {
  return createHash('sha256').update(fromBase64(txKindBytes)).digest('hex');
}
