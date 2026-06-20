export interface PrepareRequest {
  txKindBytes: string;
  senderAddress: string;
  settlementTokenType: string;
  slippageBps?: number;
  gasMarginBps?: number;
  orderId?: string;
  txKindBytesHash: string;
  prepareAuthorizationTimestampMs: number;
  prepareAuthorizationRequestNonce: string;
  prepareAuthorizationSignature: string;
}

export interface SponsorRequest {
  txBytes: string;
  userSignature: string;
  receiptId: string;
}

export interface PromotionPrepareRequest {
  senderAddress: string;
  txKindBytes: string;
}

export interface PromotionSponsorRequest {
  receiptId: string;
  txBytes: string;
  userSignature: string;
}

export type JsonObject = Record<string, unknown>;
