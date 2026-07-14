/**
 * Schema-wire contract coverage — bidirectional field-level assertions between
 * `docs/schemas/relay-api.schema.json` and the shared Host wire interfaces.
 *
 * The SDK test-inclusive typecheck makes the `keyof` lists below compile-time
 * exhaustive. Runtime assertions compare those current shared wire types with
 * the checked-in JSON Schema artifact without constraining TypeScript source
 * declaration syntax.
 *
 * If a schema-SDK mismatch is found, this test fails. Fix the schema or
 * SDK source directly; this test is a drift detector, not a fixer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  SPONSOR_FAILURE_SUBCODES,
  PAYMENT_INPUT_INTEGRITY_SUBCODES,
  RELAY_CONFIG_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  STUDIO_CLAIM_ERROR_CODES,
  STUDIO_DETAIL_ERROR_CODES,
  STUDIO_LIST_ERROR_CODES,
  parseHostErrorResponse,
  type HostErrorResponse,
  type HostErrorCode,
  type HostErrorMetaField,
  type PromotionClaimResponse,
  type PromotionDetailResponse,
  type PromotionEntitlement,
  type PromotionListItem,
  type PromotionListResponse,
  type PromotionPrepareRequest,
  type PromotionPrepareResponse,
  type PromotionSponsorRequest,
  type PromotionSponsorResponse,
  type RelayConfigResponse,
  type RelayPrepareRequest,
  type RelayPrepareResponse,
  type RelaySponsorRequest,
  type RelaySponsorResponse,
  type RelayStatusResponse,
  type UserPromotionDetail,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..', '..', '..');
function readWorkspaceFile(relPath: string): string {
  return readFileSync(join(workspaceRoot, relPath), 'utf8');
}

// ─────────────────────────────────────────────
// Schema JSON helpers
// ─────────────────────────────────────────────

interface SchemaDef {
  $comment?: string;
  type?: string;
  enum?: string[];
  anyOf?: Array<{ $ref: string }>;
  allOf?: unknown[];
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

const ROUTE_ERROR_SCHEMA_LOCKS = [
  ['relayConfigHostError', 'relayConfigErrorCode', RELAY_CONFIG_ERROR_CODES],
  ['studioListHostError', 'studioListErrorCode', STUDIO_LIST_ERROR_CODES],
  ['studioDetailHostError', 'studioDetailErrorCode', STUDIO_DETAIL_ERROR_CODES],
  ['studioClaimHostError', 'studioClaimErrorCode', STUDIO_CLAIM_ERROR_CODES],
  ['relayPrepareHostError', 'relayPrepareErrorCode', RELAY_PREPARE_ERROR_CODES],
  ['relaySponsorHostError', 'relaySponsorErrorCode', RELAY_SPONSOR_ERROR_CODES],
  ['promotionPrepareHostError', 'promotionPrepareErrorCode', PROMOTION_PREPARE_ERROR_CODES],
  ['promotionSponsorHostError', 'promotionSponsorErrorCode', PROMOTION_SPONSOR_ERROR_CODES],
] as const;

const ALL_HOST_ERROR_CODES = [
  ...new Set(ROUTE_ERROR_SCHEMA_LOCKS.flatMap(([, , codes]) => [...codes])),
] as HostErrorCode[];

function codesAllowing(field: HostErrorMetaField): HostErrorCode[] {
  return ALL_HOST_ERROR_CODES.filter((code) =>
    HOST_ERROR_META_POLICY[code]?.allowed.includes(field),
  );
}

function codesRequiring(field: HostErrorMetaField): HostErrorCode[] {
  return ALL_HOST_ERROR_CODES.filter((code) =>
    HOST_ERROR_META_POLICY[code]?.required?.includes(field),
  );
}

function codesWithSubcodeKind(kind: 'sponsor' | 'payment_input'): HostErrorCode[] {
  return ALL_HOST_ERROR_CODES.filter((code) => HOST_ERROR_META_POLICY[code]?.subcodeKind === kind);
}

type SchemaBundle = {
  $defs: Record<string, SchemaDef>;
};

function loadSchema(): SchemaBundle {
  const raw = readWorkspaceFile('docs/schemas/relay-api.schema.json');
  return JSON.parse(raw) as SchemaBundle;
}

function getSchemaFields(
  schema: SchemaBundle,
  defName: string,
): {
  properties: string[];
  required: string[];
} {
  const def = schema.$defs[defName];
  if (!def) throw new Error(`Schema $defs.${defName} not found`);
  const properties = def.properties ? Object.keys(def.properties).sort() : [];
  const required = def.required ? [...def.required].sort() : [];
  return { properties, required };
}

// ─────────────────────────────────────────────
// Lock-pair configuration
// ─────────────────────────────────────────────

type StringKey<T> = Extract<keyof T, string>;
type OptionalKey<T> = {
  [K in StringKey<T>]-?: object extends Pick<T, K> ? K : never;
}[StringKey<T>];

interface CurrentShape {
  members: string[];
  optional: string[];
}

function currentShape<T>() {
  return <
    const Members extends readonly StringKey<T>[],
    const Optional extends readonly OptionalKey<T>[],
  >(
    members: Members &
      (Exclude<StringKey<T>, Members[number]> extends never
        ? unknown
        : ['missing members', Exclude<StringKey<T>, Members[number]>]),
    optional: Optional &
      (Exclude<OptionalKey<T>, Optional[number]> extends never
        ? unknown
        : ['missing optional members', Exclude<OptionalKey<T>, Optional[number]>]),
  ): CurrentShape => ({ members: [...members].sort(), optional: [...optional].sort() });
}

const RELAY_LOCK_PAIRS = [
  {
    schemaDef: 'relayStatusResponse',
    typeName: 'RelayStatusResponse',
    shape: currentShape<RelayStatusResponse>()(['ok'], []),
  },
  {
    schemaDef: 'prepareRequest',
    typeName: 'RelayPrepareRequest',
    shape: currentShape<RelayPrepareRequest>()(
      [
        'txKindBytes',
        'senderAddress',
        'settlementTokenType',
        'slippageBps',
        'gasMarginBps',
        'orderId',
        'txKindBytesHash',
        'prepareAuthorizationTimestampMs',
        'prepareAuthorizationRequestNonce',
        'prepareAuthorizationSignature',
      ],
      ['slippageBps', 'gasMarginBps', 'orderId'],
    ),
  },
  {
    schemaDef: 'prepareResponse',
    typeName: 'RelayPrepareResponse',
    shape: currentShape<RelayPrepareResponse>()(
      [
        'txBytes',
        'receiptId',
        'nonce',
        'cost',
        'profile',
        'quoteTimestampMs',
        'policyHash',
        'orderId',
      ],
      ['orderId'],
    ),
  },
  {
    schemaDef: 'prepareCost',
    typeName: 'RelayPrepareResponse.cost',
    shape: currentShape<RelayPrepareResponse['cost']>()(
      [
        'simGas',
        'gasVarianceFixedMist',
        'slippageBufferMist',
        'quotedHostFee',
        'protocolFee',
        'executionCostClaim',
        'grossGas',
      ],
      [],
    ),
  },
  {
    schemaDef: 'sponsorRequest',
    typeName: 'RelaySponsorRequest',
    shape: currentShape<RelaySponsorRequest>()(['txBytes', 'userSignature', 'receiptId'], []),
  },
  {
    schemaDef: 'sponsorResponse',
    typeName: 'RelaySponsorResponse',
    shape: currentShape<RelaySponsorResponse>()(
      ['digest', 'effects', 'executionCostClaim', 'orderId'],
      ['orderId'],
    ),
  },
  {
    schemaDef: 'hostError',
    typeName: 'HostErrorResponse',
    shape: currentShape<HostErrorResponse>()(
      [
        'error',
        'code',
        'retryAfterMs',
        'subcode',
        'digest',
        'minSettleMist',
        'requiredTotalIn',
        'isEstimate',
      ],
      [
        'code',
        'retryAfterMs',
        'subcode',
        'digest',
        'minSettleMist',
        'requiredTotalIn',
        'isEstimate',
      ],
    ),
  },
  {
    schemaDef: 'relayConfigResponse',
    typeName: 'RelayConfigResponse',
    shape: currentShape<RelayConfigResponse>()(
      [
        'network',
        'packageId',
        'settlementPayoutRecipient',
        'supportedSettlementSwapPaths',
        'quotedHostFeeMist',
        'protocolFlatFeeMist',
      ],
      [],
    ),
  },
] as const;

const STUDIO_LOCK_PAIRS = [
  {
    schemaDef: 'promotionListItem',
    typeName: 'PromotionListItem',
    shape: currentShape<PromotionListItem>()(
      [
        'promotionId',
        'displayName',
        'type',
        'status',
        'canClaim',
        'canUseSponsoredAction',
        'promotionRemainingBudgetMist',
        'remainingParticipantSlots',
        'userRemainingGasAllowanceMist',
        'unavailableReason',
      ],
      [],
    ),
  },
  {
    schemaDef: 'promotionListResponse',
    typeName: 'PromotionListResponse',
    shape: currentShape<PromotionListResponse>()(['promotions'], []),
  },
  {
    schemaDef: 'userPromotionDetail',
    typeName: 'UserPromotionDetail',
    shape: currentShape<UserPromotionDetail>()(
      [
        'claimStatus',
        'userRemainingGasAllowanceMist',
        'claimDeadlineAt',
        'useUntilAt',
        'canClaim',
        'canUseSponsoredAction',
        'unavailableReason',
      ],
      [],
    ),
  },
  {
    schemaDef: 'promotionDetailResponse',
    typeName: 'PromotionDetailResponse',
    shape: currentShape<PromotionDetailResponse>()(
      ['promotionId', 'displayName', 'type', 'promotionRemainingBudgetMist', 'detail'],
      [],
    ),
  },
  {
    schemaDef: 'promotionEntitlement',
    typeName: 'PromotionEntitlement',
    shape: currentShape<PromotionEntitlement>()(
      [
        'promotionId',
        'userId',
        'claimedAt',
        'useUntilAt',
        'remainingGasAllowanceMist',
        'consumedGasAllowanceMist',
        'status',
        'activeReservationReceiptId',
        'activeReservationAmountMist',
        'lastUsedAt',
      ],
      [],
    ),
  },
  {
    schemaDef: 'promotionClaimResponse',
    typeName: 'PromotionClaimResponse',
    shape: currentShape<PromotionClaimResponse>()(['entitlement'], []),
  },
  {
    schemaDef: 'promotionPrepareRequest',
    typeName: 'PromotionPrepareRequest',
    shape: currentShape<PromotionPrepareRequest>()(['senderAddress', 'txKindBytes'], []),
  },
  {
    schemaDef: 'promotionPrepareResponse',
    typeName: 'PromotionPrepareResponse',
    shape: currentShape<PromotionPrepareResponse>()(
      ['txBytes', 'receiptId', 'estimatedGasMist'],
      [],
    ),
  },
  {
    schemaDef: 'promotionSponsorRequest',
    typeName: 'PromotionSponsorRequest',
    shape: currentShape<PromotionSponsorRequest>()(['receiptId', 'txBytes', 'userSignature'], []),
  },
  {
    schemaDef: 'promotionSponsorResponse',
    typeName: 'PromotionSponsorResponse',
    shape: currentShape<PromotionSponsorResponse>()(['digest', 'effects', 'actualGasMist'], []),
  },
] as const;

// ─────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────

const schema = loadSchema();
function runLockPairTests(
  pairs: readonly { schemaDef: string; typeName: string; shape: CurrentShape }[],
): void {
  for (const pair of pairs) {
    describe(`${pair.schemaDef} <-> ${pair.typeName}`, () => {
      const schemaFields = getSchemaFields(schema, pair.schemaDef);

      it('schema fields and requiredness match the complete current shared type', () => {
        expect(schemaFields.properties).toEqual(pair.shape.members);
        const required = pair.shape.members.filter(
          (member) => !pair.shape.optional.includes(member),
        );
        expect(schemaFields.required).toEqual(required);
      });
    });
  }
}

describe('relay schema <-> SDK contract lock', () => {
  runLockPairTests(RELAY_LOCK_PAIRS);

  describe('hostError closed value semantics', () => {
    const hostError = schema.$defs.hostError;
    const properties = hostError.properties as Record<string, Record<string, unknown>>;

    it('rejects fields outside the current error vocabulary', () => {
      expect(hostError.additionalProperties).toBe(false);
    });

    it('matches the runtime parser string and safe-integer boundaries', () => {
      for (const field of ['error', 'digest']) {
        expect(properties[field]).toMatchObject({ type: 'string', minLength: 1 });
      }
      expect(properties.code).toEqual({
        $ref: '#/$defs/currentHostErrorCode',
        description:
          'Optional current Host error code. Uncoded transport failures and rate-limit responses omit this field.',
      });
      expect(properties.subcode).toEqual({ $ref: '#/$defs/currentHostErrorSubcode' });
      expect(properties.retryAfterMs).toEqual({
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      });
    });

    it('keeps MIST and boolean diagnostics on their current wire types', () => {
      expect(properties.minSettleMist).toEqual({ $ref: '#/$defs/mistString' });
      expect(properties.requiredTotalIn).toEqual({ $ref: '#/$defs/mistString' });
      expect(properties.isEstimate).toEqual({ type: 'boolean' });
      expect(schema.$defs.mistString).toMatchObject({
        type: 'string',
        pattern: '^(?:0|[1-9][0-9]*)$',
      });
    });

    it.each([
      ['relayConfigErrorCode', RELAY_CONFIG_ERROR_CODES],
      ['studioListErrorCode', STUDIO_LIST_ERROR_CODES],
      ['studioDetailErrorCode', STUDIO_DETAIL_ERROR_CODES],
      ['studioClaimErrorCode', STUDIO_CLAIM_ERROR_CODES],
      ['relayPrepareErrorCode', RELAY_PREPARE_ERROR_CODES],
      ['relaySponsorErrorCode', RELAY_SPONSOR_ERROR_CODES],
      ['promotionPrepareErrorCode', PROMOTION_PREPARE_ERROR_CODES],
      ['promotionSponsorErrorCode', PROMOTION_SPONSOR_ERROR_CODES],
      ['sponsorFailureSubcode', SPONSOR_FAILURE_SUBCODES],
      ['paymentInputIntegritySubcode', PAYMENT_INPUT_INTEGRITY_SUBCODES],
    ] as const)('locks %s to the contracts runtime authority', (defName, values) => {
      expect(schema.$defs[defName]?.enum).toEqual([...values]);
    });

    it('derives aggregate code and subcode schemas from the route/domain enums', () => {
      expect(schema.$defs.currentHostErrorCode?.anyOf).toEqual([
        { $ref: '#/$defs/relayConfigErrorCode' },
        { $ref: '#/$defs/studioListErrorCode' },
        { $ref: '#/$defs/studioDetailErrorCode' },
        { $ref: '#/$defs/studioClaimErrorCode' },
        { $ref: '#/$defs/relayPrepareErrorCode' },
        { $ref: '#/$defs/relaySponsorErrorCode' },
        { $ref: '#/$defs/promotionPrepareErrorCode' },
        { $ref: '#/$defs/promotionSponsorErrorCode' },
      ]);
      expect(schema.$defs.currentHostErrorSubcode?.anyOf).toEqual([
        { $ref: '#/$defs/sponsorFailureSubcode' },
        { $ref: '#/$defs/paymentInputIntegritySubcode' },
      ]);
    });

    it('constrains each route error body to that route current code enum', () => {
      expect(schema.$defs.relayStatusHostError?.allOf).toEqual([
        { $ref: '#/$defs/hostError' },
        {
          type: 'object',
          properties: {
            code: false,
            retryAfterMs: false,
          },
        },
      ]);
      for (const [errorDefName, codeDefName] of ROUTE_ERROR_SCHEMA_LOCKS) {
        expect(schema.$defs[errorDefName]?.allOf).toEqual([
          { $ref: '#/$defs/hostError' },
          {
            type: 'object',
            properties: {
              code: { $ref: `#/$defs/${codeDefName}` },
            },
          },
        ]);
      }
    });

    it('forbids metadata unless the contracts policy allows it for the code', () => {
      const diagnosticCodes = codesAllowing('minSettleMist');
      expect(codesAllowing('requiredTotalIn')).toEqual(diagnosticCodes);
      expect(codesAllowing('isEstimate')).toEqual(diagnosticCodes);
      expect(codesAllowing('retryAfterMs')).toEqual(['ABUSE_BLOCKED']);
      for (const field of [
        'retryAfterMs',
        'subcode',
        'minSettleMist',
        'requiredTotalIn',
        'isEstimate',
      ] as const) {
        expect(codesRequiring(field)).toEqual([]);
      }
      expect(schema.$defs.settlementDiagnosticHostErrorCode?.enum).toEqual(diagnosticCodes);

      const rules = hostError.allOf as Array<Record<string, unknown>>;
      expect(rules[0]).toEqual({
        if: {
          type: 'object',
          required: ['code'],
          properties: { code: { not: { const: 'ABUSE_BLOCKED' } } },
        },
        then: { type: 'object', properties: { retryAfterMs: false } },
      });
      expect(rules[1]).toEqual({
        if: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { $ref: '#/$defs/settlementDiagnosticHostErrorCode' },
          },
        },
        else: {
          type: 'object',
          properties: {
            minSettleMist: false,
            requiredTotalIn: false,
            isEstimate: false,
          },
        },
      });
    });

    it('binds each subcode owner to the correct closed subcode vocabulary', () => {
      const sponsorCodes = codesWithSubcodeKind('sponsor');
      const paymentInputCodes = codesWithSubcodeKind('payment_input');
      expect(paymentInputCodes).toEqual(['L2_EXTRACT_FAILED']);
      expect(codesAllowing('subcode')).toEqual(
        ALL_HOST_ERROR_CODES.filter(
          (code) => sponsorCodes.includes(code) || paymentInputCodes.includes(code),
        ),
      );
      expect(schema.$defs.sponsorSubcodeHostErrorCode?.enum).toEqual(sponsorCodes);

      const rules = hostError.allOf as Array<Record<string, unknown>>;
      expect(rules[2]).toEqual({
        if: {
          type: 'object',
          required: ['code'],
          properties: { code: { const: 'L2_EXTRACT_FAILED' } },
        },
        then: {
          type: 'object',
          properties: {
            subcode: { $ref: '#/$defs/paymentInputIntegritySubcode' },
          },
        },
        else: {
          if: {
            type: 'object',
            required: ['code'],
            properties: { code: { $ref: '#/$defs/sponsorSubcodeHostErrorCode' } },
          },
          then: {
            type: 'object',
            properties: { subcode: { $ref: '#/$defs/sponsorFailureSubcode' } },
          },
          else: { type: 'object', properties: { subcode: false } },
        },
      });
    });

    it('requires digest exactly for codes whose runtime metadata policy requires it', () => {
      const digestCodes = codesRequiring('digest');
      expect(codesAllowing('digest')).toEqual(digestCodes);
      expect(schema.$defs.digestRequiredHostErrorCode?.enum).toEqual(digestCodes);

      const rules = hostError.allOf as Array<Record<string, unknown>>;
      expect(rules[3]).toEqual({
        if: {
          type: 'object',
          required: ['code'],
          properties: { code: { $ref: '#/$defs/digestRequiredHostErrorCode' } },
        },
        then: { type: 'object', properties: { digest: {} }, required: ['digest'] },
        else: { type: 'object', properties: { digest: false } },
      });
    });

    it('leaves HTTP status out of the body schema and binds every code in the runtime parser', () => {
      expect(hostError.$comment).toContain('parseHostErrorResponse');
      expect(hostError.$comment).toContain('HOST_ERROR_HTTP_STATUS');

      for (const code of ALL_HOST_ERROR_CODES) {
        const requiredMetadata = HOST_ERROR_META_POLICY[code]?.required ?? [];
        const body = {
          error: 'Current Host error',
          code,
          ...(requiredMetadata.includes('digest') ? { digest: '0xdigest' } : {}),
        };
        const status = HOST_ERROR_HTTP_STATUS[code];
        expect(parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, status).code).toBe(code);
        const wrongStatus = status === 400 ? 422 : 400;
        expect(() => parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, wrongStatus)).toThrow(
          /code does not match the HTTP status/,
        );
      }
    });
  });
});

describe('studio schema <-> SDK contract lock', () => {
  runLockPairTests(STUDIO_LOCK_PAIRS);
});
