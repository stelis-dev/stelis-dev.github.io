import type { DeepBookPoolHop, SingleHopSettlementSwapPath } from '@stelis/contracts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DEEP_BOOK_POOL_HOP_FIELDS = [
  'poolId',
  'baseType',
  'quoteType',
  'swapDirection',
  'feeBps',
] as const satisfies readonly (keyof DeepBookPoolHop)[];
const deepBookPoolHopFieldsAreComplete: Exclude<
  keyof DeepBookPoolHop,
  (typeof DEEP_BOOK_POOL_HOP_FIELDS)[number]
> extends never
  ? true
  : never = true;

const SETTLEMENT_SWAP_PATH_FIELDS = [
  'hops',
  'settlementTokenType',
  'settlementTokenSymbol',
  'settlementTokenDecimals',
  'lotSize',
  'minSize',
  'effectiveFeeRateBps',
  'settlementSwapDirection',
] as const satisfies readonly (keyof SingleHopSettlementSwapPath)[];
const settlementSwapPathFieldsAreComplete: Exclude<
  keyof SingleHopSettlementSwapPath,
  (typeof SETTLEMENT_SWAP_PATH_FIELDS)[number]
> extends never
  ? true
  : never = true;

void deepBookPoolHopFieldsAreComplete;
void settlementSwapPathFieldsAreComplete;

interface SchemaDef {
  properties?: Record<string, unknown>;
  required?: string[];
}

type SchemaBundle = { $defs: Record<string, SchemaDef> };

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..', '..', '..');
const schema = JSON.parse(
  readFileSync(join(workspaceRoot, 'docs/schemas/relay-api.schema.json'), 'utf8'),
) as SchemaBundle;

function schemaFields(defName: string): { properties: string[]; required: string[] } {
  const def = schema.$defs[defName];
  if (!def) throw new Error(`Schema $defs.${defName} not found`);
  return {
    properties: Object.keys(def.properties ?? {}).sort(),
    required: [...(def.required ?? [])].sort(),
  };
}

describe.each([
  ['deepBookPoolHop', DEEP_BOOK_POOL_HOP_FIELDS],
  ['singleHopSettlementSwapPath', SETTLEMENT_SWAP_PATH_FIELDS],
] as const)('%s schema', (defName, currentFields) => {
  it('matches the complete current contracts type field set', () => {
    const fields = schemaFields(defName);
    const expected = [...currentFields].sort();
    expect(fields.properties).toEqual(expected);
    expect(fields.required).toEqual(expected);
  });
});
