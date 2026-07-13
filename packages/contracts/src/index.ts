// @stelis/contracts — shared TypeScript contract data for cross-package
// boundaries.
//
// Policy constraints:
//   - zero / minimal runtime scope;
//   - no runtime helper with Node-only or browser-only side effects;
//   - only request/response types, runtime data tables/identifiers/discriminator
//     literals, and trivial pure data-adjacent lookup functions.

export type {
  SuiNetwork,
  SettleProfile,
  SettlementSwapDirection,
  MoveCallCommand,
  OtherCommand,
  PtbCommand,
  DeepBookPoolHop,
  SingleHopSettlementSwapPath,
  SingleHopSettlementSwapPathResponse,
  PrepareAuthorizationFields,
  ExpectedSettleEventFields,
} from './types.js';

export type {
  RelayConfigResponse,
  RelayPrepareRequest,
  RelayPrepareResponse,
  RelaySponsorRequest,
  RelaySponsorResponse,
  PromotionPrepareRequest,
  PromotionPrepareResponse,
  PromotionSponsorRequest,
  PromotionSponsorResponse,
  AdminAuthChallengeResponse,
  AdminAuthVerifyRequest,
  AdminAuthSuccessResponse,
  SponsorRefillAccountWithdrawalChallengeResponse,
  SponsorRefillAccountWithdrawalRequest,
  SponsorRefillAccountWithdrawalResponse,
} from './hostWire.js';

export {
  HostWireParseError,
  parseRelayConfigResponse,
  parseRelayPrepareRequest,
  parseRelayPrepareResponse,
  parseRelaySponsorRequest,
  parseRelaySponsorResponse,
  parsePromotionPrepareRequest,
  parsePromotionPrepareResponse,
  parsePromotionSponsorRequest,
  parsePromotionSponsorResponse,
  parseAdminAuthChallengeResponse,
  parseAdminAuthVerifyRequest,
  parseAdminAuthSuccessResponse,
  parseSponsorRefillAccountWithdrawalChallengeResponse,
  parseSponsorRefillAccountWithdrawalRequest,
  parseSponsorRefillAccountWithdrawalResponse,
} from './hostWire.js';

export type {
  SettleVariantClass,
  SettleFieldValues,
  SettleEventFieldMoveType,
  SettleEventValue,
} from './settlementContract.js';

export {
  SETTLEMENT_CONTRACT_NETWORK,
  SETTLE_MODULE,
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_ENTRY_FUNCTIONS,
  SETTLE_FUNCTIONS,
  settlementParameterIndex,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  settlementSwapDirectionFromFunctionName,
  SETTLE_FIELD_SCHEMA,
  SETTLE_EVENT_MODULE,
  SETTLE_EVENT_NAME,
  SETTLE_EVENT_FIELDS,
  SETTLE_ABORT,
  VAULT_ABORT,
  DEEPBOOK_MIN_OUT_ABORT,
} from './settlementContract.js';

export {
  SETTLEMENT_SWAP_DIRECTION_VECTORS,
  VALID_SETTLEMENT_SWAP_DIRECTIONS,
  settlementSwapDirectionFromSwapDirections,
  PROFILE_RANKS,
  SUI_TYPE,
  DEEPBOOK_IDS,
  STELIS_CONTRACT_IDS,
  requireContractId,
  SLIPPAGE_CAP_BPS,
  GAS_MARGIN_CAP_BPS,
} from './constants.js';

export type { DeepBookIds, StelisContractIds } from './constants.js';

export type {
  SponsorSlotState,
  SponsorAvailabilityErrorCode,
  SponsorSlotStatus,
  SponsorSlotLeaseStatus,
  SponsorSlotLeaseSummary,
  SponsorRefillAccountStatus,
  SponsorOperationsStatus,
} from './admin.js';

export {
  buildSponsorRefillAccountWithdrawMessage,
  isPositiveU64DecimalString,
  SPONSOR_SLOT_STATES,
} from './admin.js';
