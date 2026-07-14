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
  PtbCommand,
  DeepBookPoolHop,
  SingleHopSettlementSwapPath,
  SingleHopSettlementSwapPathResponse,
  PrepareAuthorizationFields,
  ExpectedSettleEventFields,
} from './types.js';

export type {
  RelayStatusResponse,
  RelayConfigResponse,
  RelayPrepareRequest,
  RelayPrepareResponse,
  RelaySponsorRequest,
  RelaySponsorResponse,
  HostErrorResponse,
  HostErrorMeta,
  PromotionType,
  PromotionStatus,
  PromotionUnavailableReason,
  PromotionListItem,
  PromotionListResponse,
  UserPromotionDetail,
  PromotionDetailResponse,
  PromotionEntitlementStatus,
  PromotionEntitlement,
  PromotionClaimResponse,
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
  parseRelayStatusResponse,
  parseRelayConfigResponse,
  parseRelayPrepareRequest,
  parseRelayPrepareResponse,
  parseRelaySponsorRequest,
  parseRelaySponsorResponse,
  parseHostErrorResponse,
  parsePromotionListResponse,
  parsePromotionDetailResponse,
  parsePromotionClaimResponse,
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
  RelayPrepareErrorCode,
  RelaySponsorErrorCode,
  PromotionPrepareErrorCode,
  PromotionSponsorErrorCode,
  HostErrorCode,
  HostErrorMetaField,
  SponsorFailureSubcode,
  PaymentInputIntegritySubcode,
  HostErrorSubcode,
} from './hostError.js';

export {
  RELAY_CONFIG_ERROR_CODES,
  STUDIO_LIST_ERROR_CODES,
  STUDIO_DETAIL_ERROR_CODES,
  STUDIO_CLAIM_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  SPONSOR_FAILURE_SUBCODES,
  PAYMENT_INPUT_INTEGRITY_SUBCODES,
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  isHostErrorCode,
  isHostErrorSubcode,
} from './hostError.js';

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
  settlementSwapDirectionFromSwapDirections,
  SUI_TYPE,
  SUI_CHAIN_IDENTIFIERS,
  DEEPBOOK_IDS,
  STELIS_CONTRACT_IDS,
  requireContractId,
  SLIPPAGE_CAP_BPS,
  GAS_MARGIN_CAP_BPS,
} from './constants.js';

export type {
  SponsorSlotState,
  SponsorAvailabilityErrorCode,
  SponsorSlotLeaseSummary,
  SponsorOperationsStatus,
} from './admin.js';

export {
  buildSponsorRefillAccountWithdrawMessage,
  isPositiveU64DecimalString,
  SPONSOR_SLOT_STATES,
} from './admin.js';
