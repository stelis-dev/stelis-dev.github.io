import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isPromotionId, PROMOTION_PAGE_MAX_LIMIT } from '@stelis/contracts';
import { z } from 'zod';
import type { StelisMcpServerConfig } from './config.js';
import { StelisMcpHttpError } from './http.js';
import {
  claimPromotion,
  getPromotionDetail,
  getRelayApiConfig,
  listPromotions,
  preparePromotionSponsoredTransaction,
  prepareSponsoredTransaction,
  submitPromotionSponsoredTransaction,
  submitSponsoredTransaction,
} from './operations.js';

const RELAY_API_FIELDS = {
  relayApiUrl: z
    .string()
    .url()
    .optional()
    .describe('Relay API endpoint ending in /relay. Overrides STELIS_RELAY_API_URL for this call.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Per-call HTTP timeout in milliseconds.'),
};

const DEVELOPER_JWT = z
  .string()
  .min(1)
  .describe('Developer JWT for Studio promotion endpoints. Kept request-local.');
const PROMOTION_PAGE_CURSOR = z
  .string()
  .refine(isPromotionId, 'cursor must be a canonical lowercase UUID-v4')
  .optional()
  .describe('Exclusive cursor returned as nextCursor by the preceding Promotion page.');
const PROMOTION_PAGE_LIMIT = z
  .number()
  .int()
  .min(1)
  .max(PROMOTION_PAGE_MAX_LIMIT)
  .optional()
  .describe(`Maximum Promotions to return, from 1 through ${PROMOTION_PAGE_MAX_LIMIT}.`);
const PROMOTION_ID = z.string().min(1).describe('Promotion ID.');
const SUI_ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .describe('Sui address as 0x-prefixed hex.');
const BASE64_BYTES = z.string().min(1).describe('Base64-encoded transaction bytes.');
const RECEIPT_ID = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .describe('Receipt ID returned by prepare.');

export function registerStelisTools(server: McpServer, config: StelisMcpServerConfig): void {
  server.registerTool(
    'stelis_get_relay_api_config',
    {
      title: 'Get Stelis Relay API Config',
      description: 'Read a Stelis Host Relay API config from GET /relay/config.',
      inputSchema: RELAY_API_FIELDS,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => toToolResult(() => getRelayApiConfig(config, input)),
  );

  server.registerTool(
    'stelis_prepare_sponsored_transaction',
    {
      title: 'Prepare Sponsored Transaction',
      description:
        'Call POST /relay/prepare with caller-provided serialized TransactionKind bytes containing at most 11 user commands. Returns txBytes for wallet signing and a receiptId for sponsor.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        txKindBytes: BASE64_BYTES.describe(
          'Serialized generic TransactionKind bytes in base64, with at most 11 commands.',
        ),
        senderAddress: SUI_ADDRESS,
        settlementTokenType: z
          .string()
          .min(1)
          .describe(
            'Settlement token coin type from GET /relay/config.supportedSettlementSwapPaths. The host selects the single active settlement swap path for that token.',
          ),
        slippageBps: z.number().int().min(0).max(500).optional(),
        gasMarginBps: z.number().int().min(0).max(10000).optional(),
        orderId: z.string().min(1).max(128).optional(),
        txKindBytesHash: z
          .string()
          .regex(/^(?:0x)?[0-9a-fA-F]{64}$/)
          .describe('SHA-256 hash of txKindBytes as 32-byte hex, with optional 0x prefix.'),
        prepareAuthorizationTimestampMs: z
          .number()
          .int()
          .safe()
          .describe('Unix timestamp in milliseconds used in the prepare authorization message.'),
        prepareAuthorizationRequestNonce: z
          .string()
          .min(1)
          .max(128)
          .describe('Caller-generated nonce used in the prepare authorization message.'),
        prepareAuthorizationSignature: z
          .string()
          .min(1)
          .describe('Wallet personal-message signature over the prepare authorization message.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toToolResult(() => prepareSponsoredTransaction(config, input)),
  );

  server.registerTool(
    'stelis_submit_signed_transaction',
    {
      title: 'Submit Signed Sponsored Transaction',
      description:
        'Call POST /relay/sponsor with exact prepared txBytes, user signature, and receiptId. This can submit an on-chain transaction.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        txBytes: BASE64_BYTES.describe('Exact txBytes returned by prepare.'),
        userSignature: z.string().min(1).describe('User signature in base64.'),
        receiptId: RECEIPT_ID,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toToolResult(() => submitSponsoredTransaction(config, input)),
  );

  server.registerTool(
    'stelis_list_promotions',
    {
      title: 'List Studio Promotions',
      description: 'Call GET /studio/promotions using a developer JWT.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        developerJwt: DEVELOPER_JWT,
        cursor: PROMOTION_PAGE_CURSOR,
        limit: PROMOTION_PAGE_LIMIT,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => toToolResult(() => listPromotions(config, input)),
  );

  server.registerTool(
    'stelis_get_promotion_detail',
    {
      title: 'Get Studio Promotion Detail',
      description: 'Call GET /studio/promotions/:id using a developer JWT.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        developerJwt: DEVELOPER_JWT,
        promotionId: PROMOTION_ID,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => toToolResult(() => getPromotionDetail(config, input)),
  );

  server.registerTool(
    'stelis_claim_promotion',
    {
      title: 'Claim Studio Promotion',
      description: 'Call POST /studio/promotions/:id/claim using a developer JWT.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        developerJwt: DEVELOPER_JWT,
        promotionId: PROMOTION_ID,
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toToolResult(() => claimPromotion(config, input)),
  );

  server.registerTool(
    'stelis_prepare_promotion_sponsored_transaction',
    {
      title: 'Prepare Promotion-Sponsored Transaction',
      description:
        'Call POST /studio/promotions/:id/prepare with 1 to 16 MoveCall commands in caller-provided serialized TransactionKind bytes and a developer JWT.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        developerJwt: DEVELOPER_JWT,
        promotionId: PROMOTION_ID,
        senderAddress: SUI_ADDRESS,
        txKindBytes: BASE64_BYTES.describe(
          'Serialized Promotion TransactionKind bytes in base64 containing 1 to 16 MoveCall commands.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toToolResult(() => preparePromotionSponsoredTransaction(config, input)),
  );

  server.registerTool(
    'stelis_submit_signed_promotion_sponsored_transaction',
    {
      title: 'Submit Signed Promotion-Sponsored Transaction',
      description:
        'Call POST /studio/promotions/:id/sponsor with exact prepared txBytes, user signature, receiptId, and developer JWT. This can submit an on-chain transaction.',
      inputSchema: {
        ...RELAY_API_FIELDS,
        developerJwt: DEVELOPER_JWT,
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        txBytes: BASE64_BYTES.describe('Exact txBytes returned by promotion prepare.'),
        userSignature: z.string().min(1).describe('User signature in base64.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toToolResult(() => submitPromotionSponsoredTransaction(config, input)),
  );
}

async function toToolResult(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await action();
    return jsonContent(data);
  } catch (error) {
    return jsonContent(serializeError(error), true);
  }
}

function jsonContent(value: unknown, isError = false): CallToolResult {
  return {
    isError,
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof StelisMcpHttpError) {
    return {
      error: error.message,
      code: error.code,
      status: error.status,
      ...(error.meta ? { meta: error.meta } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      error: error.message,
      code: 'MCP_SERVER_ERROR',
    };
  }
  return {
    error: String(error),
    code: 'MCP_SERVER_ERROR',
  };
}
