/**
 * Settle ABI lock test.
 *
 * Pins three generated views to a single golden anchor:
 *   1. Production settlement entry point parameter lists
 *      (packages/contracts/move/sources/settle.move).
 *   2. `SETTLE_FIELD_SCHEMA` + `VARIANT_LAYOUTS` TS reference
 *      (packages/core-relay/src/settlePayloadContract.ts).
 *   3. The 5 production settlement entry points — presence, non-test status,
 *      variant-class mapping, and the `execution_cost_claim_mist` parameter position that
 *      must equal `VARIANT_LAYOUTS[class].settleStartIndex`.
 *
 * Any drift on either the Move side or the TS side that is not reflected in
 * settleAbi.golden.json fails per-field so the diverging field / entry is
 * localized in the error message. Does not depend on the Sui toolchain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SETTLE_FIELD_COUNT,
  SETTLE_FIELD_SCHEMA,
  VARIANT_LAYOUTS,
  variantClassFromFnName,
  type SettleVariantClass,
} from '../src/settlePayloadContract.js';
import {
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
} from '@stelis/contracts';

interface GoldenField {
  offset: number;
  moveName: string;
  moveType: string;
  tsName: string;
}

interface GoldenVariantLayout {
  settleStartIndex: number;
  poolIndices: number[];
  hasVault: boolean;
  hasTailCredit: boolean;
  paymentCoinIndex?: number;
  swapAmountIndex?: number;
}

interface Golden {
  sources: { move: string; typescript: string };
  settleBlock: { fieldCount: number; fields: GoldenField[] };
  productionEntryPoints: Array<{
    contractKey:
      | 'baseForQuote.newUser'
      | 'baseForQuote.withVault'
      | 'quoteForBase.newUser'
      | 'quoteForBase.withVault'
      | 'credit';
    variantClass: SettleVariantClass;
  }>;
  variantLayouts: Record<SettleVariantClass, GoldenVariantLayout>;
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/core-relay/tests → workspace root = ../../..
const workspaceRoot = join(here, '..', '..', '..');

const golden: Golden = JSON.parse(
  readFileSync(join(here, 'settleAbi.golden.json'), 'utf8'),
) as Golden;

const moveSrc = readFileSync(join(workspaceRoot, golden.sources.move), 'utf8');

// ─────────────────────────────────────────────
// Move source parsing helpers
// ─────────────────────────────────────────────

interface MoveParam {
  name: string;
  moveType: string;
  modifiers: string[];
}

function extractMoveFunctionParams(src: string, funcName: string): MoveParam[] {
  // Match: optional `#[test_only]` / `#[allow(...)]` attributes, then
  // `public` / `public(package)` visibility (optional), then
  // `fun <name><generics?>(params)`.
  const re = new RegExp(
    String.raw`(?:public(?:\(package\))?\s+)?fun\s+${funcName}\s*(?:<[^>]*>)?\s*\(([^)]*)\)`,
    's',
  );
  const match = src.match(re);
  if (!match) {
    throw new Error(`Move function '${funcName}' not found in source`);
  }
  const body = match[1];
  const params: MoveParam[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine
      .replace(/\/\/.*$/, '')
      .trim()
      .replace(/,$/, '')
      .trim();
    if (!line) continue;
    // `[mut ] name : type`. Type may include `&`, `&mut`, generics with `<>`.
    const m = line.match(/^(mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (!m) continue;
    params.push({
      name: m[2],
      moveType: m[3].trim(),
      modifiers: m[1] ? ['mut'] : [],
    });
  }
  return params;
}

function isTestOnlyFunction(src: string, funcName: string): boolean {
  const re = new RegExp(
    String.raw`#\[test_only\]\s*(?:#\[[^\]]*\]\s*)*(?:public(?:\(package\))?\s+)?fun\s+${funcName}\b`,
    's',
  );
  return re.test(src);
}

function hasPublicFunction(src: string, funcName: string): boolean {
  const re = new RegExp(String.raw`public\s+fun\s+${funcName}\b`, 's');
  return re.test(src);
}

function resolveProductionEntryName(entry: Golden['productionEntryPoints'][number]): string {
  switch (entry.contractKey) {
    case 'baseForQuote.newUser':
      return SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser;
    case 'baseForQuote.withVault':
      return SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault;
    case 'quoteForBase.newUser':
      return SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.newUser;
    case 'quoteForBase.withVault':
      return SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.withVault;
    case 'credit':
      return SETTLE_WITH_CREDIT_FUNCTION;
  }
}

// ─────────────────────────────────────────────
// SETTLE_FIELD_SCHEMA TS reference
// ─────────────────────────────────────────────

describe('Settle ABI lock — SETTLE_FIELD_SCHEMA', () => {
  it(`SETTLE_FIELD_COUNT matches golden.settleBlock.fieldCount`, () => {
    expect(SETTLE_FIELD_COUNT).toBe(golden.settleBlock.fieldCount);
  });

  it(`SETTLE_FIELD_SCHEMA length matches golden.settleBlock.fieldCount`, () => {
    expect(SETTLE_FIELD_SCHEMA.length).toBe(golden.settleBlock.fieldCount);
  });

  for (const g of golden.settleBlock.fields) {
    it(`SETTLE_FIELD_SCHEMA[${g.offset}] is ${g.tsName} : ${g.moveType} (offset ${g.offset})`, () => {
      const f = SETTLE_FIELD_SCHEMA[g.offset];
      expect(f, `SETTLE_FIELD_SCHEMA entry at offset ${g.offset} missing`).toBeDefined();
      expect(f.name, `TS name at offset ${g.offset}`).toBe(g.tsName);
      expect(f.moveType, `TS moveType at offset ${g.offset}`).toBe(g.moveType);
      expect(f.offset, `TS offset at offset ${g.offset}`).toBe(g.offset);
    });
  }
});

// ─────────────────────────────────────────────
// Production entry points + VARIANT_LAYOUTS
// ─────────────────────────────────────────────

describe('Settle ABI lock — production entry points', () => {
  it(`settle.move has ${golden.productionEntryPoints.length} production entry points`, () => {
    expect(golden.productionEntryPoints.length).toBeGreaterThan(0);
    for (const entry of golden.productionEntryPoints) {
      const entryName = resolveProductionEntryName(entry);
      expect(
        hasPublicFunction(moveSrc, entryName),
        `production entry '${entry.contractKey}' is not a public fun in settle.move`,
      ).toBe(true);
      expect(
        isTestOnlyFunction(moveSrc, entryName),
        `production entry '${entry.contractKey}' is annotated as #[test_only]`,
      ).toBe(false);
    }
  });

  for (const entry of golden.productionEntryPoints) {
    describe(`entry ${entry.contractKey} (${entry.variantClass})`, () => {
      const entryName = resolveProductionEntryName(entry);

      it('variantClassFromFnName returns expected class', () => {
        expect(variantClassFromFnName(entryName)).toBe(entry.variantClass);
      });

      it(`execution_cost_claim_mist parameter position equals VARIANT_LAYOUTS.${entry.variantClass}.settleStartIndex`, () => {
        const params = extractMoveFunctionParams(moveSrc, entryName);
        const executionCostClaimIdx = params.findIndex((p) => p.name === 'execution_cost_claim_mist');
        expect(
          executionCostClaimIdx,
          `'execution_cost_claim_mist' not found in ${entry.contractKey} parameters`,
        ).toBeGreaterThanOrEqual(0);
        const expectedIdx = golden.variantLayouts[entry.variantClass].settleStartIndex;
        expect(executionCostClaimIdx).toBe(expectedIdx);
      });

      for (const g of golden.settleBlock.fields) {
        it(`settle block param[${g.offset}] is ${g.moveName} : ${g.moveType}`, () => {
          const params = extractMoveFunctionParams(moveSrc, entryName);
          const blockStart = golden.variantLayouts[entry.variantClass].settleStartIndex;
          const p = params[blockStart + g.offset];
          expect(
            p,
            `${entry.contractKey} settle block param at offset ${g.offset} missing`,
          ).toBeDefined();
          expect(p.name, `${entry.contractKey} param name at offset ${g.offset}`).toBe(g.moveName);
          expect(p.moveType, `${entry.contractKey} param type at offset ${g.offset}`).toBe(
            g.moveType,
          );
        });
      }

      it('entrypoint parameter count matches variant layout', () => {
        const params = extractMoveFunctionParams(moveSrc, entryName);
        const layout = golden.variantLayouts[entry.variantClass];
        const expectedTotal =
          layout.settleStartIndex +
          golden.settleBlock.fieldCount +
          (layout.hasTailCredit ? 1 : 0) +
          1; // Move-only ctx suffix, not part of the PTB argument layout.
        expect(params.length).toBe(expectedTotal);
      });
    });
  }
});

// ─────────────────────────────────────────────
// zero_deep_fee_only invariant: no user-facing Coin<DEEP> in swap entries
// ─────────────────────────────────────────────

describe('Settle ABI lock — no Coin<DEEP> input in swap entries', () => {
  // Swap entries must take `payment_coin: Coin<T>` followed immediately by
  // `swap_amount: u64`. Any re-introduction of a `deep_fee_coin: Coin<DEEP>`
  // parameter (or any other `Coin<...::deep::DEEP>` input) must fail this lock.
  const DEEP_COIN_TYPE = /Coin\s*<[^>]*::deep::DEEP[^>]*>/;

  for (const entry of golden.productionEntryPoints) {
    if (entry.variantClass === 'credit') continue; // credit-only has no payment_coin / swap
    const entryName = resolveProductionEntryName(entry);

    it(`${entry.contractKey}: param after 'payment_coin' is 'swap_amount: u64' and no Coin<DEEP> anywhere`, () => {
      const params = extractMoveFunctionParams(moveSrc, entryName);
      const paymentIdx = params.findIndex((p) => p.name === 'payment_coin');
      expect(paymentIdx, `'payment_coin' not found in ${entry.contractKey}`).toBeGreaterThanOrEqual(
        0,
      );

      const next = params[paymentIdx + 1];
      expect(next, `no parameter after 'payment_coin' in ${entry.contractKey}`).toBeDefined();
      expect(next.name, `param after 'payment_coin' in ${entry.contractKey}`).toBe('swap_amount');
      expect(next.moveType, `param type after 'payment_coin' in ${entry.contractKey}`).toBe('u64');

      const deepCoinParams = params.filter((p) => DEEP_COIN_TYPE.test(p.moveType));
      expect(
        deepCoinParams.map((p) => p.name),
        `${entry.contractKey} must not accept any Coin<...::deep::DEEP> parameter (zero_deep_fee_only invariant)`,
      ).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────
// VARIANT_LAYOUTS TS reference
// ─────────────────────────────────────────────

describe('Settle ABI lock — VARIANT_LAYOUTS', () => {
  const variantClasses: SettleVariantClass[] = ['new_user', 'with_vault', 'credit'];

  for (const vc of variantClasses) {
    describe(`variant ${vc}`, () => {
      const g = golden.variantLayouts[vc];
      const actual = VARIANT_LAYOUTS[vc];

      it('settleStartIndex', () => {
        expect(actual.settleStartIndex).toBe(g.settleStartIndex);
      });

      it('poolIndices', () => {
        expect([...actual.poolIndices]).toEqual(g.poolIndices);
      });

      it('hasVault', () => {
        expect(actual.hasVault).toBe(g.hasVault);
      });

      it('hasTailCredit', () => {
        expect(actual.hasTailCredit).toBe(g.hasTailCredit);
      });

      it('paymentCoinIndex', () => {
        expect(actual.paymentCoinIndex).toBe(g.paymentCoinIndex);
      });

      it('swapAmountIndex', () => {
        expect(actual.swapAmountIndex).toBe(g.swapAmountIndex);
      });
    });
  }
});
