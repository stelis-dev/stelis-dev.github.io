/**
 * Promotion target policy — canonical `package::module::function` authority.
 *
 * `STUDIO_ALLOWED_TARGETS`, the boot snapshot, and prepare/sponsor validation
 * all use this one representation. Target hashes are intentionally not part of
 * the domain contract: exact canonical strings are simpler and preserve the
 * operator-visible value that owns the policy.
 *
 * @module promotionTargetPolicy
 */

import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

const MOVE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUI_ADDRESS_LITERAL = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Parse and canonicalize one current Studio target.
 *
 * The package address is normalized so short and full Sui addresses compare
 * identically. Module and function segments must be Move identifiers; accepting
 * an impossible target at boot would create policy that can never match a PTB.
 */
export function canonicalizePromotionTarget(rawTarget: string): string {
  const parts = rawTarget.split('::');
  if (parts.length !== 3) {
    throw new Error(`Invalid target format: "${rawTarget}". Expected "package::module::function".`);
  }

  const [packageId, moduleName, functionName] = parts;
  if (!SUI_ADDRESS_LITERAL.test(packageId)) {
    throw new Error(`Invalid target package address: "${packageId}".`);
  }
  const canonicalPackageId = normalizeSuiAddress(packageId);
  if (!isValidSuiAddress(canonicalPackageId)) {
    throw new Error(`Invalid target package address: "${packageId}".`);
  }
  if (!MOVE_IDENTIFIER.test(moduleName)) {
    throw new Error(`Invalid target module identifier: "${moduleName}".`);
  }
  if (!MOVE_IDENTIFIER.test(functionName)) {
    throw new Error(`Invalid target function identifier: "${functionName}".`);
  }

  return `${canonicalPackageId}::${moduleName}::${functionName}`;
}
