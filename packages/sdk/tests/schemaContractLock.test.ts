/**
 * Schema-SDK contract coverage — bidirectional field-level assertions between
 * `docs/schemas/relay-api.schema.json` and SDK `types.ts` interfaces.
 *
 * SDK `tsconfig.json` excludes `**\/*.test.ts` from typecheck, so
 * compile-time `keyof` barriers in this file would not be caught by
 * `npm run typecheck -w @stelis/sdk`. Instead, this test uses the
 * TypeScript compiler API to extract declared interface members at
 * test time, and compares them against the JSON Schema `$defs`
 * properties/required sets.
 *
 * If a schema-SDK mismatch is found, this test fails. Fix the schema or
 * SDK source directly; this test is a drift detector, not a fixer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ─────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const sdkSrcDir = join(here, '..', 'src');
const workspaceRoot = join(here, '..', '..', '..');
const typesFilePath = join(sdkSrcDir, 'types.ts');

function readWorkspaceFile(relPath: string): string {
  return readFileSync(join(workspaceRoot, relPath), 'utf8');
}

// ─────────────────────────────────────────────
// Schema JSON helpers
// ─────────────────────────────────────────────

interface SchemaDef {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
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
// TypeScript AST helpers
// ─────────────────────────────────────────────

function parseInterfaceMembers(
  filePath: string,
): Map<string, { members: string[]; optional: string[] }> {
  const src = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const result = new Map<string, { members: string[]; optional: string[] }>();

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const members: string[] = [];
      const optional: string[] = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          const propName = ts.isIdentifier(member.name)
            ? member.name.text
            : (member.name as ts.StringLiteral).text;
          members.push(propName);
          if (member.questionToken) {
            optional.push(propName);
          }
        }
      }
      result.set(name, { members: members.sort(), optional: optional.sort() });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

// ─────────────────────────────────────────────
// Lock-pair configuration
// ─────────────────────────────────────────────

interface LockPair {
  schemaDef: string;
  sdkInterface: string;
  nested?: LockPair[];
}

const RELAY_LOCK_PAIRS: LockPair[] = [
  { schemaDef: 'prepareRequest', sdkInterface: 'PrepareParams' },
  {
    schemaDef: 'prepareResponse',
    sdkInterface: 'PrepareResponse',
    nested: [{ schemaDef: 'prepareCost', sdkInterface: '__inline_PrepareResponse_cost__' }],
  },
  { schemaDef: 'sponsorRequest', sdkInterface: 'SponsorParams' },
  { schemaDef: 'sponsorResponse', sdkInterface: 'SponsorResponse' },
  { schemaDef: 'relayConfigResponse', sdkInterface: 'RelayConfigResponse' },
];

const STUDIO_LOCK_PAIRS: LockPair[] = [
  { schemaDef: 'promotionPrepareRequest', sdkInterface: 'PromotionPrepareParams' },
  { schemaDef: 'promotionPrepareResponse', sdkInterface: 'PromotionPrepareResponse' },
  { schemaDef: 'promotionSponsorRequest', sdkInterface: 'PromotionSponsorParams' },
  { schemaDef: 'promotionSponsorResponse', sdkInterface: 'PromotionSponsorResponse' },
  { schemaDef: 'promotionListItem', sdkInterface: 'PromotionListItem' },
  { schemaDef: 'promotionListResponse', sdkInterface: 'PromotionListResponse' },
  { schemaDef: 'userPromotionDetail', sdkInterface: 'UserPromotionDetail' },
  { schemaDef: 'promotionDetailResponse', sdkInterface: 'PromotionDetailResponse' },
];

// ─────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────

const schema = loadSchema();
const interfaces = parseInterfaceMembers(typesFilePath);

function extractCostMembers(): { members: string[]; optional: string[] } {
  const src = readFileSync(typesFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(typesFilePath, src, ts.ScriptTarget.Latest, true);
  const members: string[] = [];
  const optional: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'PrepareResponse') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          if (member.name.text === 'cost' && member.type && ts.isTypeLiteralNode(member.type)) {
            for (const costMember of member.type.members) {
              if (
                ts.isPropertySignature(costMember) &&
                costMember.name &&
                ts.isIdentifier(costMember.name)
              ) {
                members.push(costMember.name.text);
                if (costMember.questionToken) optional.push(costMember.name.text);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { members: members.sort(), optional: optional.sort() };
}

function runLockPairTests(pairs: LockPair[]): void {
  for (const pair of pairs) {
    describe(`${pair.schemaDef} <-> ${pair.sdkInterface}`, () => {
      const schemaFields = getSchemaFields(schema, pair.schemaDef);

      if (pair.sdkInterface === '__inline_PrepareResponse_cost__') {
        return;
      }

      const sdkIface = interfaces.get(pair.sdkInterface);

      it(`SDK interface ${pair.sdkInterface} exists`, () => {
        expect(sdkIface).toBeDefined();
      });

      if (!sdkIface) return;

      it('schema properties are a subset of SDK members (schema -> SDK)', () => {
        const missing = schemaFields.properties.filter((p) => !sdkIface.members.includes(p));
        expect(missing).toEqual([]);
      });

      it('SDK members are a subset of schema properties (SDK -> schema)', () => {
        const extra = sdkIface.members.filter((m) => !schemaFields.properties.includes(m));
        expect(extra).toEqual([]);
      });

      it('schema required fields match SDK non-optional members', () => {
        const sdkRequired = sdkIface.members.filter((m) => !sdkIface.optional.includes(m)).sort();
        expect(schemaFields.required).toEqual(sdkRequired);
      });
    });

    if (pair.nested) {
      for (const nested of pair.nested) {
        if (nested.sdkInterface === '__inline_PrepareResponse_cost__') {
          describe(`${nested.schemaDef} <-> PrepareResponse.cost (inline)`, () => {
            const costSchemaFields = getSchemaFields(schema, nested.schemaDef);
            const costSdk = extractCostMembers();

            it('schema cost properties match SDK cost members', () => {
              expect(costSchemaFields.properties).toEqual(costSdk.members);
            });

            it('schema cost required matches SDK cost non-optional', () => {
              const sdkRequired = costSdk.members
                .filter((m) => !costSdk.optional.includes(m))
                .sort();
              expect(costSchemaFields.required).toEqual(sdkRequired);
            });
          });
        }
      }
    }
  }
}

describe('relay schema <-> SDK contract lock', () => {
  runLockPairTests(RELAY_LOCK_PAIRS);
});

describe('studio schema <-> SDK contract lock', () => {
  runLockPairTests(STUDIO_LOCK_PAIRS);
});
