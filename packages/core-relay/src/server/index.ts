export {
  PaymentInputContractError,
  extractSettlePaymentInputContract,
  validatePaymentInputIntegrity,
} from '../paymentInputIntegrity.js';
export { findUniqueSettleCommandIndex } from '../settleCommand.js';
export {
  buildAddressBalanceGasTransaction,
  getAddressBalanceGasTransactionBytes,
  getAddressBalanceGasTransactionTxBytesHash,
  simulateAddressBalanceGasTransaction,
  SuiAddressBalanceGasUnavailableError,
} from '../sui/suiAddressBalanceGas.js';
export type { AddressBalanceGasTransaction } from '../sui/suiAddressBalanceGas.js';
// Host signing verifies durable transaction identity before issuing a sponsor signature.
export { assertSuiTransactionDigest } from '../sui/suiTransactionGateways.js';
// Host prepare classification may inspect only authority-created resolution
// failures; browser/public errors never expose the retained structured value.
export { getSuiRejectedExecutionError } from '../sui/suiOperation.js';

export type {
  PaymentInputTrace,
  PaymentInputIntegrityExpectation,
  PaymentInputSource,
} from '../paymentInputIntegrity.js';

export type {
  StaticSettlementSwapPathDescriptor,
  StaticSettlementSwapPathDescriptorMap,
  ExecutableSwapQuote,
} from '../market-policy/types.js';
export { createStaticSettlementSwapPathDescriptorMap } from '../market-policy/descriptor.js';
export {
  createDeepbookQuotePort,
  wrapQuotePortWithStats,
  wrapQuotePortWithCacheAndStats,
  createRequestQuoteCache,
} from '../market-policy/quotePort.js';
export type { QuoteRpcStats, QuoteCache } from '../market-policy/quotePort.js';
export { solveExecutableSwap } from '../market-policy/solver.js';
export {
  MarketQuoteUnavailableError,
  ExecutionGapExceededError,
  SwapUnviableUnderPolicyError,
} from '../market-policy/errors.js';
