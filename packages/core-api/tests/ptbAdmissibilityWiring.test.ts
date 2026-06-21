import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readWorkspaceFile(pathFromRoot: string): string {
  return readFileSync(resolve(repoRoot, pathFromRoot), 'utf8');
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function collapseWhitespace(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('PTB admissibility wiring lock', () => {
  it('keeps SDK and generic prepare on the same user TransactionKind validator', () => {
    const sdk = readWorkspaceFile('packages/sdk/src/sdk.ts');
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );

    expect(sdk).toContain('validateGenericUserTransactionKind');
    expect(genericPolicy).toContain('validateGenericUserTransactionKind');
    expect(sdk).not.toContain('validateUserCommands');
    expect(genericPolicy).not.toContain('validateUserCommands');
    expect(genericPolicy).not.toContain('containsSponsorWithdrawal');
  });

  it('keeps final settlement transaction validation separate from user TransactionKind validation', () => {
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );
    const finalValidationCalls = genericPolicy.match(/validateGenericSettlementTransaction\(/g);

    expect(finalValidationCalls).toHaveLength(2);
    expect(genericPolicy).not.toContain('validatePtbStructure');
  });

  it('keeps address-balance accounting evidence in the prepare build boundary', () => {
    const genericPolicy = readWorkspaceFile(
      'packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts',
    );
    const prepareBuild = readWorkspaceFile('packages/core-api/src/prepare/build.ts');

    expect(genericPolicy).not.toContain('extractPrefixWithdrawals');
    expect(collapseWhitespace(prepareBuild)).toContain(
      'extractPrefixWithdrawals( tx, settlementTokenType, )',
    );
  });

  it('keeps GasCoin detection in the shared primitive and reuses it from integrity and promotion layers', () => {
    const staticValidation = readWorkspaceFile('packages/core-relay/src/validate/static.ts');
    const sdkIntegrity = readWorkspaceFile('packages/sdk/src/integrity.ts');
    const promotionValidation = readWorkspaceFile('packages/core-api/src/studio/validation.ts');

    expect(staticValidation).toContain('export function containsGasCoinReference');
    expect(countMatches(staticValidation, /containsGasCoinReference\(/g)).toBeGreaterThanOrEqual(3);

    expect(sdkIntegrity).toContain('containsGasCoinReference,');
    expect(sdkIntegrity).toContain('if (cmd.arguments && containsGasCoinReference(cmd.arguments))');
    expect(sdkIntegrity).not.toContain('function containsGasCoinReference');

    expect(promotionValidation).toContain('containsGasCoinReference,');
    expect(promotionValidation).toContain('if (containsGasCoinReference(cmd.arguments))');
    expect(promotionValidation).not.toContain('function containsGasCoinReference');
  });

  it('keeps SDK returned-transaction integrity as a separate layer from generic validators', () => {
    const sdkIntegrity = readWorkspaceFile('packages/sdk/src/integrity.ts');

    expect(sdkIntegrity).toContain('export function verifyPrefix');
    expect(sdkIntegrity).toContain('export function verifySuffix');
    expect(sdkIntegrity).toContain('verifySuffix(suffix, packageId)');
    expect(sdkIntegrity).toContain('coin');
    expect(sdkIntegrity).toContain('redeem_funds');
    expect(sdkIntegrity).toContain('expected exactly 1 settle call in suffix');
    expect(sdkIntegrity).not.toContain('validateGenericUserTransactionKind');
    expect(sdkIntegrity).not.toContain('validateGenericSettlementTransaction');
  });
});
