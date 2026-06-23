import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';

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

function getDigest(result: ExecuteTransactionResult): string {
  const txResult = result as {
    Transaction?: { digest?: string };
    FailedTransaction?: { digest?: string; status?: { error?: string } };
  };
  if (txResult.FailedTransaction) {
    throw new Error(
      `SUI execution failed: ${txResult.FailedTransaction.status?.error ?? 'unknown error'}`,
    );
  }
  const digest = txResult.Transaction?.digest;
  if (!digest) {
    throw new Error('SUI execution returned an empty digest');
  }
  return digest;
}

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
  const digest = getDigest(result);
  await client.waitForTransaction({ digest });
  return { digest, result };
}
