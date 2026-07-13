/**
 * Relay HTTP error-code lock test.
 *
 * Locks `KNOWN_PREPARE_ERROR_CODES` / `KNOWN_SPONSOR_ERROR_CODES` /
 *     `KNOWN_PROMOTION_PREPARE_ERROR_CODES` /
 *     `KNOWN_PROMOTION_SPONSOR_ERROR_CODES` in
 *     `packages/core-relay/src/errorCode.ts` ↔
 *     `docs/schemas/relay-api.schema.json` `knownXxxErrorCode.enum` arrays.
 *
 * Per-entry assertions make drift appear at the exact failing code.
 * Move abort identities are generated from compiled artifacts in
 * `@stelis/contracts` and are not mirrored by this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  KNOWN_PREPARE_ERROR_CODES,
  KNOWN_SPONSOR_ERROR_CODES,
  KNOWN_PROMOTION_PREPARE_ERROR_CODES,
  KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
} from '../src/errorCode.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/core-relay/tests → workspace root = ../../..
const workspaceRoot = join(here, '..', '..', '..');

function readWorkspaceFile(relPath: string): string {
  return readFileSync(join(workspaceRoot, relPath), 'utf8');
}

// ─────────────────────────────────────────────
// Schema parse helper
// ─────────────────────────────────────────────

interface SchemaBundle {
  $defs: Record<string, { type?: string; enum?: string[] }>;
}

const schemaBundle: SchemaBundle = JSON.parse(
  readWorkspaceFile('docs/schemas/relay-api.schema.json'),
) as SchemaBundle;

function schemaEnum(defName: string): readonly string[] {
  const def = schemaBundle.$defs[defName];
  if (!def) throw new Error(`schema $defs.${defName} not found`);
  if (def.type !== 'string' || !Array.isArray(def.enum)) {
    throw new Error(`schema $defs.${defName} is not a string-enum definition`);
  }
  return def.enum;
}

// ─────────────────────────────────────────────
// Generic bidirectional enum / map locks
// ─────────────────────────────────────────────

function describeSchemaEnumLock(
  label: string,
  schemaDefName: string,
  tsArray: readonly string[],
): void {
  const schemaArr = schemaEnum(schemaDefName);
  const schemaSet = new Set(schemaArr);
  const tsSet = new Set(tsArray);

  describe(`HTTP error-code lock — ${label} (schema $defs.${schemaDefName})`, () => {
    it(`TS count matches schema enum count (${tsArray.length} entries)`, () => {
      expect(tsArray.length).toBe(schemaArr.length);
    });

    for (const code of tsArray) {
      it(`TS ${label} member "${code}" present in schema enum`, () => {
        expect(
          schemaSet.has(code),
          `TS ${label} exports "${code}" but schema $defs.${schemaDefName}.enum does not`,
        ).toBe(true);
      });
    }

    for (const code of schemaArr) {
      it(`schema enum member "${code}" present in TS ${label}`, () => {
        expect(
          tsSet.has(code),
          `schema $defs.${schemaDefName}.enum has "${code}" but TS ${label} does not`,
        ).toBe(true);
      });
    }
  });
}

// ─────────────────────────────────────────────
// Schema enum lock cases
// ─────────────────────────────────────────────

describeSchemaEnumLock(
  'KNOWN_PREPARE_ERROR_CODES',
  'knownPrepareErrorCode',
  KNOWN_PREPARE_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_SPONSOR_ERROR_CODES',
  'knownSponsorErrorCode',
  KNOWN_SPONSOR_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_PROMOTION_PREPARE_ERROR_CODES',
  'knownPromotionPrepareErrorCode',
  KNOWN_PROMOTION_PREPARE_ERROR_CODES,
);
describeSchemaEnumLock(
  'KNOWN_PROMOTION_SPONSOR_ERROR_CODES',
  'knownPromotionSponsorErrorCode',
  KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
);
