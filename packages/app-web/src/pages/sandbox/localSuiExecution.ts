import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { bindCurrentSuiResultToBytes } from '@stelis/core-relay/browser';

interface WalletTransactionSigner {
  signTransaction(input: { transaction: string }): Promise<{ signature: string }>;
}

interface SignAndExecuteLocalTransactionInput {
  transaction: Transaction;
  client: SuiGrpcClient;
  signer: WalletTransactionSigner;
  senderAddress: string;
}

type ExecuteTransactionResult = Awaited<ReturnType<SuiGrpcClient['executeTransaction']>>;

export async function signAndExecuteLocalTransaction({
  transaction,
  client,
  signer,
  senderAddress,
}: SignAndExecuteLocalTransactionInput): Promise<{
  digest: string;
  result: ExecuteTransactionResult;
}> {
  transaction.setSenderIfNotSet(senderAddress);
  const txBytes = await transaction.build({ client });
  const txBytesBase64 = toBase64(txBytes);
  const { signature } = await signer.signTransaction({ transaction: txBytesBase64 });
  const result = await client.executeTransaction({
    transaction: txBytes,
    signatures: [signature],
    include: { effects: true },
  });
  const bound = bindCurrentSuiResultToBytes(result, txBytes);
  if (!bound) throw new Error('SUI execution returned a malformed or mismatched result');
  if (bound.outcome === 'failure') {
    throw new Error(`SUI execution failed: ${bound.errorMessage}`);
  }
  if (bound.transaction.effects === undefined) {
    throw new Error('SUI execution returned no requested effects');
  }
  const digest = bound.digest;
  await client.waitForTransaction({ digest });
  return { digest, result };
}
