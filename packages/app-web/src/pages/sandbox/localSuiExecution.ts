import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import {
  buildSuiTransaction,
  createSuiEndpointSnapshot,
  executeSuiTransaction,
  suiExecutionErrorMessage,
  type SuiTransactionWithEventsResult,
} from '@stelis/core-relay/browser';

interface WalletTransactionSigner {
  signTransaction(input: { transaction: string }): Promise<{ signature: string }>;
}

interface SignAndExecuteLocalTransactionInput {
  transaction: Transaction;
  client: SuiGrpcClient;
  signer: WalletTransactionSigner;
  senderAddress: string;
}

export async function signAndExecuteLocalTransaction({
  transaction,
  client,
  signer,
  senderAddress,
}: SignAndExecuteLocalTransactionInput): Promise<{
  digest: string;
  result: SuiTransactionWithEventsResult;
}> {
  const endpoints = createSuiEndpointSnapshot([client]);
  transaction.setSenderIfNotSet(senderAddress);
  const txBytes = await buildSuiTransaction(endpoints, { transaction });
  const txBytesBase64 = toBase64(txBytes);
  const { signature } = await signer.signTransaction({ transaction: txBytesBase64 });
  const result = await executeSuiTransaction(endpoints, {
    transaction: txBytes,
    signatures: [signature],
  });
  if (result.outcome === 'failure') {
    throw new Error(`SUI execution failed: ${suiExecutionErrorMessage(result.error)}`);
  }
  return { digest: result.digest, result };
}
