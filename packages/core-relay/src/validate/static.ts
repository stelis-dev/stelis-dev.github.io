/**
 * Layer 1: PTB structure validation
 * Layer 2: settle() argument validation
 *
 * Pure functions — no Sui SDK dependency.
 * The app layer parses the PTB and passes PtbCommand[] and SettleArgs.
 */
import { MAX_COMMANDS } from '../constants.js';
import { SETTLE_MODULE, SETTLE_FUNCTIONS, SETTLE_WITH_CREDIT_FUNCTION } from '@stelis/contracts';
import type { PtbCommand, MoveCallCommand } from '@stelis/contracts';
import type { OnchainConfig, HostValidationEnv, SettleArgs, ValidationResult } from '../types.js';
import { ok, fail } from '../types.js';

/** Type guard: narrows PtbCommand to MoveCallCommand */
export function isMoveCall(cmd: PtbCommand): cmd is MoveCallCommand {
  return cmd.kind === 'MoveCall';
}

/** S-14: Explicit allowlist for non-MoveCall PTB commands. */
const ALLOWED_NON_MOVECALL_KINDS = new Set([
  'SplitCoins',
  'MergeCoins',
  'TransferObjects',
  'MakeMoveVec',
]);

/**
 * S-15: Detect GasCoin references in command arguments.
 *
 * In a sponsored transaction, GasCoin belongs to the sponsor (gasOwner).
 * The user builds txKind (commands only) and can embed `tx.gas` references.
 * After the sponsor calls setGasOwner(), GasCoin resolves to the sponsor's
 * SUI coin. If any command (MoveCall or non-MoveCall) references GasCoin,
 * the attacker can steal the sponsor's gas funds.
 *
 * Attack scenario:
 *   PTB = [settle(...), TransferObjects([GasCoin], attackerAddress)]
 *   → sponsor signs → GasCoin = sponsor's SUI → transferred to attacker
 *
 * Defense: iteratively traverse all Arrays and Object values so that
 * GasCoin cannot be hidden in nested structures (e.g. MakeMoveVec or
 * other wrapper objects). Any $kind === 'GasCoin' anywhere in the arg tree
 * causes rejection.
 *
 * Implementation: explicit stack-based iterative traversal — avoids call
 * stack overflow for deeply nested PTB arguments (stress-tested up to
 * depth=5_000 without issue).
 */
export function containsGasCoinReference(args: unknown[]): boolean {
  // Iterative DFS using an explicit stack — no recursion depth limit.
  const stack: unknown[] = [...args];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if ((item as Record<string, unknown>)['$kind'] === 'GasCoin') return true;
      // Push object member values for further inspection.
      for (const v of Object.values(item as object)) {
        stack.push(v);
      }
    } else if (Array.isArray(item)) {
      for (const v of item) {
        stack.push(v);
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Layer 1: PTB structure validation
// ─────────────────────────────────────────────

/**
 * Validates that the PTB structure satisfies relayer policy.
 *
 * Policy (swap_and_settle phase):
 *   - Stelis package: exactly 1 call in SETTLE_FUNCTIONS (1-hop variants)
 *   - External packages: any MoveCall allowed
 *   - GasCoin reference: always rejected (S-15)
 *   - Publish/Upgrade: always rejected
 *   - Command count: <= MAX_COMMANDS
 */
export function validatePtbStructure(commands: PtbCommand[], env: HostValidationEnv): ValidationResult {
  if (commands.length > MAX_COMMANDS) {
    return fail(
      'L1_TOO_MANY_COMMANDS',
      `PTB command count ${commands.length} exceeds max ${MAX_COMMANDS}`,
    );
  }

  let settleCount = 0;

  for (const cmd of commands) {
    // S-15: GasCoin reference forbidden in ALL commands
    const cmdArgs = cmd.arguments;
    if (cmdArgs && containsGasCoinReference(cmdArgs)) {
      return fail(
        'L1_GASCOIN_FORBIDDEN',
        `${cmd.kind} references GasCoin — rejected to protect sponsor funds`,
      );
    }

    if (isMoveCall(cmd)) {
      const isStelisPkg = cmd.packageId === env.packageId;
      const isSwapAndSettle =
        isStelisPkg && cmd.module === SETTLE_MODULE && SETTLE_FUNCTIONS.has(cmd.function);

      // vault::withdraw is explicitly allowed: user must always be able to withdraw
      // even within a sponsored execution PTB (e.g. withdraw + settle in the same PTB).
      const isVaultWithdraw = isStelisPkg && cmd.module === 'vault' && cmd.function === 'withdraw';

      if (isSwapAndSettle) {
        settleCount++;
      } else if (isStelisPkg && !isVaultWithdraw) {
        // Any other Stelis package call (direct settle, admin functions, etc.) → rejected
        return fail(
          'L1_UNAUTHORIZED_STELIS_CALL',
          `Direct call to Stelis function not allowed: ${cmd.module}::${cmd.function}`,
        );
      }
      // vault::withdraw and external package MoveCalls: allowed freely
    } else if (!ALLOWED_NON_MOVECALL_KINDS.has(cmd.kind)) {
      return fail('L1_FORBIDDEN_COMMAND', `PTB contains forbidden command: ${cmd.kind}`);
    }
  }

  if (settleCount === 0) {
    return fail('L1_NO_SETTLE', 'PTB does not contain a settle or swap_and_settle call');
  }
  if (settleCount > 1) {
    return fail('L1_MULTIPLE_SETTLE', `PTB contains ${settleCount} settle calls (expected 1)`);
  }

  return ok();
}

// ─────────────────────────────────────────────
// P1: Pre-settle validation (user commands only)
// ─────────────────────────────────────────────

/**
 * Validates user-supplied commands before the relayer appends settle.
 *
 * This is the `/prepare` counterpart of `validatePtbStructure()` (L1).
 * Identical policy EXCEPT:
 *   - Zero settle calls is expected (the relayer will add settle later)
 *   - Settle calls are actively rejected (user must not include them)
 *
 * Security checks inherited from L1:
 *   - MAX_COMMANDS cap
 *   - GasCoin reference rejection (S-15, recursive)
 *   - Non-MoveCall allowlist (S-14: SplitCoins, MergeCoins, TransferObjects, MakeMoveVec)
 *   - Stelis package guard (only vault::withdraw allowed)
 *   - Publish/Upgrade implicitly blocked by non-MoveCall allowlist
 */
export function validateUserCommands(commands: PtbCommand[], env: HostValidationEnv): ValidationResult {
  if (commands.length > MAX_COMMANDS) {
    return fail(
      'P1_TOO_MANY_COMMANDS',
      `PTB command count ${commands.length} exceeds max ${MAX_COMMANDS}`,
    );
  }

  for (const cmd of commands) {
    // S-15: GasCoin reference forbidden in ALL commands (recursive)
    const cmdArgs = cmd.arguments;
    if (cmdArgs && containsGasCoinReference(cmdArgs)) {
      return fail(
        'P1_GASCOIN_FORBIDDEN',
        `${cmd.kind} references GasCoin — rejected to protect sponsor funds`,
      );
    }

    if (isMoveCall(cmd)) {
      const isStelisPkg = cmd.packageId === env.packageId;

      if (isStelisPkg) {
        // Settle calls in user commands → reject (relayer will add settle)
        const isSwapAndSettle = cmd.module === SETTLE_MODULE && SETTLE_FUNCTIONS.has(cmd.function);
        if (isSwapAndSettle) {
          return fail(
            'P1_USER_SETTLE_FORBIDDEN',
            `User commands must not contain settle calls — relayer will append settle`,
          );
        }

        // vault::withdraw is allowed (user operation)
        const isVaultWithdraw = cmd.module === 'vault' && cmd.function === 'withdraw';
        if (!isVaultWithdraw) {
          return fail(
            'P1_UNAUTHORIZED_STELIS_CALL',
            `Direct call to Stelis function not allowed: ${cmd.module}::${cmd.function}`,
          );
        }
      }
      // External package MoveCalls: allowed freely
    } else if (!ALLOWED_NON_MOVECALL_KINDS.has(cmd.kind)) {
      return fail('P1_FORBIDDEN_COMMAND', `PTB contains forbidden command: ${cmd.kind}`);
    }
  }

  return ok();
}

// ─────────────────────────────────────────────
// Layer 2: settle() argument validation
// ─────────────────────────────────────────────

/**
 * Validates that settle() call arguments match relayer policy.
 *
 * Checks (in order):
 *   1. Config object ID == env.configId
 *   2. VaultRegistry object ID == env.vaultRegistryId
 *   3. settlement_payout_recipient == env.settlementPayoutRecipientAddress
 *   4. execution_cost_claim_mist <= config.maxClaimMist
 *   5. quoted_host_fee_mist <= config.maxHostFeeMist (L2_HOST_FEE_CAP)
 *   6. expected_protocol_fee_mist == config.protocolFlatFeeMist (L2_PROTOCOL_FEE_MISMATCH)
 *   7. expected_config_version == config.configVersion (L2_CONFIG_VERSION_MISMATCH)
 *   8. Settlement swap path validation (if extractedSettlementSwapPath is present):
 *      b. hops.length ↔ settlementSwapDirection integrity check
 *      c. Ordered array equality against env.allowedSettlementSwapPaths[]
 *   9. S-16: policy_hash byte-equality check (if expectedPolicyHash provided)
 *   10. S-10b: order_id_hash byte-equality check (if expectedOrderIdHash provided)
 *
 * S-16 contract: Production `/prepare` path MUST always provide expectedPolicyHash.
 * When omitted, S-16 validation is disabled (test/internal use only).
 *
 * S-10b contract: When expectedOrderIdHash is provided, validates that the
 * orderIdHash embedded in the PTB matches byte-for-byte.
 */
export function validateSettleArgs(
  args: SettleArgs,
  config: OnchainConfig,
  env: HostValidationEnv,
  expectedPolicyHash?: Uint8Array,
  expectedOrderIdHash?: Uint8Array,
): ValidationResult {
  // (1) Config object ID check
  if (args.configObjectId !== env.configId) {
    return fail(
      'L2_WRONG_CONFIG',
      `Config object ID mismatch: got ${args.configObjectId}, expected ${env.configId}`,
    );
  }

  // (2) VaultRegistry object ID check — vault-backed variants only.
  if (args.registryObjectId !== undefined) {
    if (args.registryObjectId !== env.vaultRegistryId) {
      return fail(
        'L2_WRONG_REGISTRY',
        `VaultRegistry object ID mismatch: got ${args.registryObjectId}, expected ${env.vaultRegistryId}`,
      );
    }
  }

  // (3) Settlement payout recipient check
  if (args.settlementPayoutRecipient !== env.settlementPayoutRecipientAddress) {
    return fail(
      'L2_WRONG_RECIPIENT',
      `Settlement payout recipient mismatch: got ${args.settlementPayoutRecipient}, expected ${env.settlementPayoutRecipientAddress}`,
    );
  }

  // (4) Claim upper bound check
  if (args.executionCostClaim > config.maxClaimMist) {
    return fail(
      'L2_EXCESSIVE_CLAIM',
      `execution_cost_claim_mist ${args.executionCostClaim} exceeds max_claim_mist ${config.maxClaimMist}`,
    );
  }

  // (5) L2: Quoted host fee cap (mirrors on-chain EHostFeeCapExceeded)
  if (args.quotedHostFeeMist > config.maxHostFeeMist) {
    return fail(
      'L2_HOST_FEE_CAP',
      `quoted_host_fee_mist ${args.quotedHostFeeMist} exceeds max_host_fee_mist ${config.maxHostFeeMist}`,
    );
  }

  // (6) L2: Protocol fee tamper detection (mirrors on-chain EProtocolFeeMismatch)
  if (args.expectedProtocolFeeMist !== config.protocolFlatFeeMist) {
    return fail(
      'L2_PROTOCOL_FEE_MISMATCH',
      `expected_protocol_fee_mist ${args.expectedProtocolFeeMist} != on-chain ${config.protocolFlatFeeMist}`,
    );
  }

  // (7) L2: Config version drift detection (mirrors on-chain EConfigVersionMismatch)
  if (args.expectedConfigVersion !== config.configVersion) {
    return fail(
      'L2_CONFIG_VERSION_MISMATCH',
      `expected_config_version ${args.expectedConfigVersion} != on-chain ${config.configVersion} — REPREPARE_REQUIRED`,
    );
  }

  // Credit-only settlement has no DEX execution, so the execution-gap buffer
  // must be zero. Swap paths carry extractedSettlementSwapPath and may use a non-zero buffer.
  if (!args.extractedSettlementSwapPath && args.slippageBufferMist !== 0n) {
    return fail(
      'L2_CREDIT_SLIPPAGE_NONZERO',
      `${SETTLE_WITH_CREDIT_FUNCTION} carries slippage_buffer_mist ${args.slippageBufferMist}; expected 0`,
    );
  }

  // (5) Settlement swap path validation — only when extractedSettlementSwapPath is present
  //
  // Note on scope: `settlementSwapDirection ↔ ordered swapDirection vector` is enforced at boot time
  // by deriveAllowedSettlementSwapPaths() in core-api/prepareConfig.ts, which is the canonical
  // barrier for that invariant. L2 here only matches the PTB-extracted settlement swap path
  // identity (tokenType + ordered pool ids + settlementSwapDirection) against `allowedSettlementSwapPaths[]`
  // (already filtered through the boot barrier). L2 does not need to re-check
  // swapDirection vectors because a PTB that passes this match is implicitly consistent
  // with the swapDirection vector of its matched allowed settlement swap path.
  if (args.extractedSettlementSwapPath) {
    const settlementSwapPath = args.extractedSettlementSwapPath;

    // (5b) Integrity: exactly 1 hop required
    if (settlementSwapPath.hops.length !== 1) {
      return fail(
        'L2_SETTLEMENT_SWAP_PATH_INTEGRITY',
        `settlementSwapDirection '${settlementSwapPath.settlementSwapDirection}' inconsistent with hops.length=${settlementSwapPath.hops.length} (expected 1)`,
      );
    }

    // (5c) Ordered array equality against allowedSettlementSwapPaths[]
    if (!env.allowedSettlementSwapPaths || env.allowedSettlementSwapPaths.length === 0) {
      return fail(
        'L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED',
        'allowedSettlementSwapPaths is empty — no settlement swap paths are permitted. Configure app-api settlement-swap-paths.json.',
      );
    }

    const matched = env.allowedSettlementSwapPaths.some(
      (allowed) =>
        allowed.tokenType === settlementSwapPath.tokenType &&
        allowed.settlementSwapDirection === settlementSwapPath.settlementSwapDirection &&
        allowed.hops.length === settlementSwapPath.hops.length &&
        allowed.hops.every((pid, i) => pid === settlementSwapPath.hops[i]),
    );
    if (!matched) {
      return fail(
        'L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH',
        `Settlement swap path not in allowedSettlementSwapPaths: token=${settlementSwapPath.tokenType}, ` +
          `hops=[${settlementSwapPath.hops.join(', ')}], direction='${settlementSwapPath.settlementSwapDirection}'`,
      );
    }
  }

  // (6) S-16: policy_hash validation — byte-level equality
  if (expectedPolicyHash) {
    const extracted = args.policyHash;
    if (extracted.length !== expectedPolicyHash.length) {
      return fail(
        'L2_POLICY_HASH_MISMATCH',
        `policy_hash length mismatch: got ${extracted.length}, expected ${expectedPolicyHash.length}`,
      );
    }
    for (let i = 0; i < expectedPolicyHash.length; i++) {
      if (extracted[i] !== expectedPolicyHash[i]) {
        return fail('L2_POLICY_HASH_MISMATCH', `policy_hash byte mismatch at index ${i}`);
      }
    }
  }

  // (10) S-10b: order_id_hash validation — byte-level equality
  if (expectedOrderIdHash) {
    const extracted = args.orderIdHash;
    if (extracted.length !== expectedOrderIdHash.length) {
      return fail(
        'L2_ORDER_ID_HASH_MISMATCH',
        `order_id_hash length mismatch: got ${extracted.length}, expected ${expectedOrderIdHash.length}`,
      );
    }
    for (let i = 0; i < expectedOrderIdHash.length; i++) {
      if (extracted[i] !== expectedOrderIdHash[i]) {
        return fail('L2_ORDER_ID_HASH_MISMATCH', `order_id_hash byte mismatch at index ${i}`);
      }
    }
  }

  return ok();
}
