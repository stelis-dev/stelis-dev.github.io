import { describe, it, expect } from 'vitest';
import {
  validatePtbStructure,
  validateUserCommands,
  validateSettleArgs,
} from '../src/validate/static.js';
import type { PtbCommand, MoveCallCommand } from '@stelis/contracts';
import {
  DEEPBOOK_IDS,
  SETTLE_MODULE,
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
} from '@stelis/contracts';
import type { SettleArgs, OnchainConfig, HostValidationEnv } from '../src/types.js';

const ENV: HostValidationEnv = {
  network: 'testnet',
  settlementPayoutRecipientAddress: '0xPAYOUT',
  configId: '0xCONFIG',
  vaultRegistryId: '0xREGISTRY',
  packageId: '0xPACKAGE',
};

const CONFIG: OnchainConfig = {
  packageId: '0xPACKAGE',
  configId: '0xCONFIG',
  maxClaimMist: 50_000_000n,
  minSettleMist: 100_000n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 100_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
};

// ─── Helper factories ─────────────────────────────────────────────────────────

/** New-user settlement MoveCall. */
function makeNewUserCall(overrides?: Partial<MoveCallCommand>): MoveCallCommand {
  return {
    kind: 'MoveCall',
    packageId: '0xPACKAGE',
    module: SETTLE_MODULE,
    function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
    typeArguments: [],
    arguments: [],
    ...overrides,
  };
}

/** Vault-backed settlement MoveCall. */
function makeWithVaultCall(overrides?: Partial<MoveCallCommand>): MoveCallCommand {
  return {
    kind: 'MoveCall',
    packageId: '0xPACKAGE',
    module: SETTLE_MODULE,
    function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault,
    typeArguments: [],
    arguments: [],
    ...overrides,
  };
}

/** Arbitrary external MoveCall — allowed when it is not a forbidden Stelis call */
function makeExternalCall(pkg = '0xDEFI', mod = 'nft', fn = 'mint'): MoveCallCommand {
  return {
    kind: 'MoveCall',
    packageId: pkg,
    module: mod,
    function: fn,
    typeArguments: [],
    arguments: [],
  };
}

/** DeepBook swap — allowed (for internal swap inside swap_and_settle or user sidecalls) */
function makeDeepBookSwap(): MoveCallCommand {
  return {
    kind: 'MoveCall',
    packageId: DEEPBOOK_IDS.testnet!.packageId,
    module: 'pool',
    function: 'swap_exact_base_for_quote',
    typeArguments: [],
    arguments: [],
  };
}

// ─────────────────────────────────────────────
// Layer 1: PTB structure validation
// ─────────────────────────────────────────────

describe('Layer 1: validatePtbStructure', () => {
  // ── Pass cases ────────────────────────────────────────────────────────────

  it('pass — new-user settlement alone', () => {
    const commands: PtbCommand[] = [makeNewUserCall()];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — vault-backed settlement alone', () => {
    const commands: PtbCommand[] = [makeWithVaultCall()];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — new_user + SplitCoins + TransferObjects', () => {
    const commands: PtbCommand[] = [
      { kind: 'SplitCoins' },
      makeNewUserCall(),
      { kind: 'TransferObjects' },
    ];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — with_vault + arbitrary external MoveCall (DeFi action)', () => {
    const commands: PtbCommand[] = [
      makeWithVaultCall(),
      makeExternalCall('0xDEFI', 'staking', 'stake'),
    ];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — new_user + multiple external MoveCalls', () => {
    const commands: PtbCommand[] = [
      makeExternalCall('0xNFT', 'launchpad', 'mint'),
      makeNewUserCall(),
      makeExternalCall('0xGame', 'reward', 'claim'),
    ];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — DeepBook call + with_vault (external swap before settle)', () => {
    const commands: PtbCommand[] = [makeDeepBookSwap(), makeWithVaultCall()];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('boundary — exactly MAX_COMMANDS (16) passes', () => {
    const commands: PtbCommand[] = Array.from({ length: 15 }, () => ({
      kind: 'TransferObjects' as const,
    }));
    commands.push(makeNewUserCall());
    expect(commands.length).toBe(16);
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  // ── Fail: no settle ───────────────────────────────────────────────────────

  it('fail — zero settle calls', () => {
    const commands: PtbCommand[] = [{ kind: 'TransferObjects' }];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_NO_SETTLE');
  });

  it('fail — only external MoveCall, no settlement call', () => {
    const commands: PtbCommand[] = [makeExternalCall()];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_NO_SETTLE');
  });

  // ── Fail: multiple settle ─────────────────────────────────────────────────

  it('fail — two new-user settlement calls', () => {
    const commands: PtbCommand[] = [makeNewUserCall(), makeNewUserCall()];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_MULTIPLE_SETTLE');
  });

  it('fail — new_user + with_vault (both present)', () => {
    const commands: PtbCommand[] = [makeNewUserCall(), makeWithVaultCall()];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_MULTIPLE_SETTLE');
  });

  // ── Fail: Publish/Upgrade ─────────────────────────────────────────────────

  it('fail — contains Publish command', () => {
    const commands: PtbCommand[] = [makeNewUserCall(), { kind: 'Publish' }];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_FORBIDDEN_COMMAND');
  });

  it('fail — contains Upgrade command', () => {
    const commands: PtbCommand[] = [makeNewUserCall(), { kind: 'Upgrade' }];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_FORBIDDEN_COMMAND');
  });

  // ── Fail: command count ───────────────────────────────────────────────────

  it('fail — command count exceeds limit (17)', () => {
    const commands: PtbCommand[] = Array.from({ length: 17 }, () => ({
      kind: 'TransferObjects' as const,
    }));
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_TOO_MANY_COMMANDS');
  });

  // ── Fail: unauthorized Stelis call ────────────────────────────────────────

  it('fail — direct settle() rejected (L1_UNAUTHORIZED_STELIS_CALL)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'settle',
        function: 'settle',
        typeArguments: [],
        arguments: [],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_UNAUTHORIZED_STELIS_CALL');
  });

  it('fail — direct settle_with_vault() rejected (L1_UNAUTHORIZED_STELIS_CALL)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'settle',
        function: 'settle_with_vault',
        typeArguments: [],
        arguments: [],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_UNAUTHORIZED_STELIS_CALL');
  });

  it('fail — arbitrary Stelis settle module call rejected', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'settle',
        function: 'drain',
        typeArguments: [],
        arguments: [],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_UNAUTHORIZED_STELIS_CALL');
  });

  // ── S-15: GasCoin theft defense ───────────────────────────────────────────

  it('fail — TransferObjects references GasCoin (S-15)', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'TransferObjects',
        arguments: [{ $kind: 'GasCoin' }, { $kind: 'Input', Input: 0 }],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_GASCOIN_FORBIDDEN');
  });

  it('fail — SplitCoins references GasCoin (S-15)', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'SplitCoins',
        arguments: [{ $kind: 'GasCoin' }, { $kind: 'Input', Input: 0 }],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_GASCOIN_FORBIDDEN');
  });

  it('fail — GasCoin nested in array arg (S-15)', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'TransferObjects',
        arguments: [[{ $kind: 'GasCoin' }], { $kind: 'Input', Input: 0 }],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_GASCOIN_FORBIDDEN');
  });

  it('pass — TransferObjects with Input refs is safe (S-15)', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'TransferObjects',
        arguments: [
          { $kind: 'Result', Result: 0 },
          { $kind: 'Input', Input: 0 },
        ],
      },
    ];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('fail — GasCoin nested inside object member value (S-15 deep recursion)', () => {
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      {
        kind: 'TransferObjects',
        arguments: [
          { $kind: 'Wrapper', inner: { $kind: 'GasCoin' } },
          { $kind: 'Input', Input: 0 },
        ],
      },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_GASCOIN_FORBIDDEN');
  });

  // ── S-15 stack safety: deep nesting must not overflow ──────────────────────

  it('pass — very deep nested safe object (depth=5000) does not overflow', () => {
    // Build a chain: { wrapper: { wrapper: { ... { $kind: 'Input' } ... } } }
    // No GasCoin anywhere — should return false without stack overflow.
    let obj: Record<string, unknown> = { $kind: 'Input', Input: 0 };
    for (let i = 0; i < 5000; i++) obj = { wrapper: obj };
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      { kind: 'TransferObjects', arguments: [obj, { $kind: 'Input', Input: 1 }] },
    ];
    expect(validatePtbStructure(commands, ENV)).toEqual({ ok: true });
  });

  it('fail — GasCoin hidden at depth=5000 is still detected (S-15)', () => {
    // GasCoin is buried 5000 levels deep — must still be found.
    let obj: Record<string, unknown> = { $kind: 'GasCoin' };
    for (let i = 0; i < 5000; i++) obj = { wrapper: obj };
    const commands: PtbCommand[] = [
      makeNewUserCall(),
      { kind: 'TransferObjects', arguments: [obj, { $kind: 'Input', Input: 1 }] },
    ];
    const result = validatePtbStructure(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_GASCOIN_FORBIDDEN');
  });
});

// ─────────────────────────────────────────────
// Layer 2: validateSettleArgs
// ─────────────────────────────────────────────

describe('Layer 2: validateSettleArgs', () => {
  const validArgs: SettleArgs = {
    configObjectId: '0xCONFIG',
    registryObjectId: '0xREGISTRY',
    settlementPayoutRecipient: '0xPAYOUT',
    executionCostClaim: 10_000_000n,
    policyHash: new Uint8Array(32), // 32-byte zero hash
    orderIdHash: new Uint8Array(0), // empty = no orderId
    quotedHostFeeMist: 500_000n,
    expectedProtocolFeeMist: 100_000n,
    expectedConfigVersion: 1n,
    nonce: 1n,
    receiptId: new Uint8Array(32),
    simGasReported: 9_000_000n,
    gasVarianceFixedMist: 100_000n,
    slippageBufferMist: 0n,
    quoteTimestampMs: 1_741_680_000_000n,
  };

  it('pass — all arguments match', () => {
    expect(validateSettleArgs(validArgs, CONFIG, ENV)).toEqual({ ok: true });
  });

  it('fail — config ID mismatch', () => {
    const result = validateSettleArgs({ ...validArgs, configObjectId: '0xWRONG' }, CONFIG, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_WRONG_CONFIG');
  });

  it('fail — settlement payout recipient mismatch', () => {
    const result = validateSettleArgs(
      { ...validArgs, settlementPayoutRecipient: '0xATTACKER' },
      CONFIG,
      ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_WRONG_RECIPIENT');
  });

  it('fail — registry ID mismatch', () => {
    const result = validateSettleArgs(
      { ...validArgs, registryObjectId: '0xWRONG_REGISTRY' },
      CONFIG,
      ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_WRONG_REGISTRY');
  });

  it('fail — execution_cost_claim_mist > max_claim_mist', () => {
    const result = validateSettleArgs({ ...validArgs, executionCostClaim: 50_000_001n }, CONFIG, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_EXCESSIVE_CLAIM');
  });

  it('boundary — execution_cost_claim_mist == max_claim_mist passes', () => {
    const result = validateSettleArgs({ ...validArgs, executionCostClaim: 50_000_000n }, CONFIG, ENV);
    expect(result).toEqual({ ok: true });
  });

  it('boundary — execution_cost_claim_mist == 0 passes', () => {
    const result = validateSettleArgs({ ...validArgs, executionCostClaim: 0n }, CONFIG, ENV);
    expect(result).toEqual({ ok: true });
  });

  // ── S-16: policy_hash validation ──────────────────────────────────────────

  it('pass — S-16 policyHash matches expectedPolicyHash', () => {
    const hash = new Uint8Array(32).fill(0xab);
    const args = { ...validArgs, policyHash: hash };
    expect(validateSettleArgs(args, CONFIG, ENV, hash)).toEqual({ ok: true });
  });

  it('fail — S-16 policyHash mismatch', () => {
    const expected = new Uint8Array(32).fill(0xab);
    const tampered = new Uint8Array(32).fill(0xcd);
    const args = { ...validArgs, policyHash: tampered };
    const result = validateSettleArgs(args, CONFIG, ENV, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_POLICY_HASH_MISMATCH');
  });

  it('fail — S-16 policyHash length mismatch', () => {
    const expected = new Uint8Array(32).fill(0xab);
    const short = new Uint8Array(0); // empty
    const args = { ...validArgs, policyHash: short };
    const result = validateSettleArgs(args, CONFIG, ENV, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_POLICY_HASH_MISMATCH');
  });

  it('S-16 disabled — no expectedPolicyHash, skips check', () => {
    const args = { ...validArgs, policyHash: new Uint8Array(32).fill(0xff) };
    // Without expectedPolicyHash, S-16 is disabled (test/internal use)
    expect(validateSettleArgs(args, CONFIG, ENV)).toEqual({ ok: true });
  });

  // ── S-10b: orderIdHash validation ──────────────────────────────────────────

  it('pass — S-10b orderIdHash matches expectedOrderIdHash', () => {
    const hash = new Uint8Array(32).fill(0x42);
    const args = { ...validArgs, orderIdHash: hash };
    expect(validateSettleArgs(args, CONFIG, ENV, undefined, hash)).toEqual({ ok: true });
  });

  it('fail — S-10b orderIdHash mismatch', () => {
    const expected = new Uint8Array(32).fill(0x42);
    const tampered = new Uint8Array(32).fill(0x99);
    const args = { ...validArgs, orderIdHash: tampered };
    const result = validateSettleArgs(args, CONFIG, ENV, undefined, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_ORDER_ID_HASH_MISMATCH');
  });

  it('S-10b disabled — no expectedOrderIdHash, skips check', () => {
    const args = { ...validArgs, orderIdHash: new Uint8Array(32).fill(0xff) };
    expect(validateSettleArgs(args, CONFIG, ENV)).toEqual({ ok: true });
  });

  // ── L2 tamper-detection mirror tests (parallel to on-chain 106/107/108) ───
  // Mirror on-chain EHostFeeCapExceeded / EProtocolFeeMismatch /
  // EConfigVersionMismatch. Reject drift in off-chain /prepare before a TX is
  // ever built.

  it('fail — L2_HOST_FEE_CAP: quoted_host_fee_mist exceeds on-chain cap', () => {
    // CONFIG.maxHostFeeMist = 500_000n; 500_001n exceeds cap by 1.
    const result = validateSettleArgs(
      { ...validArgs, quotedHostFeeMist: 500_001n },
      CONFIG,
      ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_HOST_FEE_CAP');
  });

  it('boundary — quoted_host_fee_mist == max_host_fee_mist passes', () => {
    const result = validateSettleArgs(
      { ...validArgs, quotedHostFeeMist: 500_000n },
      CONFIG,
      ENV,
    );
    expect(result).toEqual({ ok: true });
  });

  it('fail — L2_PROTOCOL_FEE_MISMATCH: expected fee differs from on-chain', () => {
    // CONFIG.protocolFlatFeeMist = 100_000n; PTB carries stale 99_999n.
    const result = validateSettleArgs(
      { ...validArgs, expectedProtocolFeeMist: 99_999n },
      CONFIG,
      ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_PROTOCOL_FEE_MISMATCH');
  });

  it('fail — L2_CONFIG_VERSION_MISMATCH: prepared version diverged from on-chain', () => {
    // CONFIG.configVersion = 1n; PTB carries stale 0n → REPREPARE_REQUIRED path.
    const result = validateSettleArgs({ ...validArgs, expectedConfigVersion: 0n }, CONFIG, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_CONFIG_VERSION_MISMATCH');
  });

  it('fail — L2_CREDIT_SLIPPAGE_NONZERO: credit path cannot carry execution-gap buffer', () => {
    const result = validateSettleArgs({ ...validArgs, slippageBufferMist: 1n }, CONFIG, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_CREDIT_SLIPPAGE_NONZERO');
  });

  it('pass — swap path may carry non-zero execution-gap buffer', () => {
    const result = validateSettleArgs(
      {
        ...validArgs,
        slippageBufferMist: 1n,
        extractedSettlementSwapPath: {
          tokenType: DEEP_TYPE,
          hops: [POOL_1],
          settlementSwapDirection: 'baseForQuote',
        },
      },
      CONFIG,
      TENANT_ENV,
    );
    expect(result).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────
// Layer 2: settlement swap path validation (extractedSettlementSwapPath)
// ─────────────────────────────────────────────

const DEEP_TYPE = '0xdeep::deep::DEEP';
const POOL_1 = '0xpool1';
const POOL_2 = '0xpool2';

const validArgs: SettleArgs = {
  configObjectId: '0xCONFIG',
  registryObjectId: '0xREGISTRY',
  settlementPayoutRecipient: '0xPAYOUT',
  executionCostClaim: 5_000_000n,
  policyHash: new Uint8Array(32), // 32-byte zero hash
  orderIdHash: new Uint8Array(0), // empty = no orderId
  quotedHostFeeMist: 500_000n,
  expectedProtocolFeeMist: 100_000n,
  expectedConfigVersion: 1n,
  nonce: 1n,
  receiptId: new Uint8Array(32),
  simGasReported: 4_900_000n,
  gasVarianceFixedMist: 100_000n,
  slippageBufferMist: 0n,
  quoteTimestampMs: 1_741_680_000_000n,
};

const SETTLEMENT_SWAP_PATH_1HOP = {
  tokenType: DEEP_TYPE,
  hops: [POOL_1],
  settlementSwapDirection: 'baseForQuote' as const,
};

const ALLOWED_SETTLEMENT_SWAP_PATHS = [
  { tokenType: DEEP_TYPE, hops: [POOL_1], settlementSwapDirection: 'baseForQuote' as const },
];

const TENANT_ENV: HostValidationEnv = {
  ...ENV,
  allowedSettlementSwapPaths: ALLOWED_SETTLEMENT_SWAP_PATHS,
};

const CANONICAL_ENV: HostValidationEnv = {
  ...ENV,
  allowedSettlementSwapPaths: ALLOWED_SETTLEMENT_SWAP_PATHS,
};

describe('Layer 2: settlement swap path validation — allowedSettlementSwapPaths', () => {
  // ── No extractedSettlementSwapPath: skip settlement swap path validation ───────────────

  it('pass (tenant) — no extractedSettlementSwapPath: settlement swap path validation skipped', () => {
    expect(validateSettleArgs(validArgs, CONFIG, TENANT_ENV)).toEqual({ ok: true });
  });

  it('pass (canonical) — no extractedSettlementSwapPath: settlement swap path validation skipped', () => {
    expect(validateSettleArgs(validArgs, CONFIG, CANONICAL_ENV)).toEqual({ ok: true });
  });

  it('pass — qfb settlement swap path matches allowedSettlementSwapPaths by settlementSwapDirection + hops + tokenType', () => {
    const QFB_TOKEN = '0xqfb_token::token::TOKEN';
    const qfbSettlementSwapPath = {
      tokenType: QFB_TOKEN,
      hops: [POOL_1],
      settlementSwapDirection: 'quoteForBase' as const,
    };
    const qfbEnv: HostValidationEnv = {
      ...ENV,
      allowedSettlementSwapPaths: [
        { tokenType: QFB_TOKEN, hops: [POOL_1], settlementSwapDirection: 'quoteForBase' as const },
      ],
    };
    expect(
      validateSettleArgs(
        { ...validArgs, extractedSettlementSwapPath: qfbSettlementSwapPath },
        CONFIG,
        qfbEnv,
      ),
    ).toEqual({
      ok: true,
    });
  });

  it('fail — qfb PTB rejected when allowedSettlementSwapPaths only has bfq same token+hops', () => {
    // Same tokenType + hops, different settlementSwapDirection (bfq vs qfb) must NOT match.
    const qfbSettlementSwapPath = {
      tokenType: DEEP_TYPE,
      hops: [POOL_1],
      settlementSwapDirection: 'quoteForBase' as const,
    };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: qfbSettlementSwapPath },
      CONFIG,
      TENANT_ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH');
  });

  // ── hop/profile integrity ────────────────────────────────────────────────

  it('fail — settlement swap path with hop count > 1 rejected: L2_SETTLEMENT_SWAP_PATH_INTEGRITY', () => {
    const badSettlementSwapPath = {
      tokenType: DEEP_TYPE,
      hops: [POOL_1, POOL_2],
      settlementSwapDirection: 'baseForQuote' as const,
    };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: badSettlementSwapPath },
      CONFIG,
      TENANT_ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_SETTLEMENT_SWAP_PATH_INTEGRITY');
  });

  // ── allowedSettlementSwapPaths empty: harden fail ─────────────────────────────────────

  it('fail — allowedSettlementSwapPaths empty: L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED', () => {
    const emptyEnv: HostValidationEnv = { ...TENANT_ENV, allowedSettlementSwapPaths: [] };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: SETTLEMENT_SWAP_PATH_1HOP },
      CONFIG,
      emptyEnv,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED');
  });

  it('fail — allowedSettlementSwapPaths undefined: L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED', () => {
    const noSettlementSwapPathsEnv: HostValidationEnv = {
      ...TENANT_ENV,
      allowedSettlementSwapPaths: undefined,
    };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: SETTLEMENT_SWAP_PATH_1HOP },
      CONFIG,
      noSettlementSwapPathsEnv,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED');
  });

  // ── Ordered array equality ────────────────────────────────────────────────

  it('pass — 1hop exact match in allowedSettlementSwapPaths', () => {
    expect(
      validateSettleArgs(
        { ...validArgs, extractedSettlementSwapPath: SETTLEMENT_SWAP_PATH_1HOP },
        CONFIG,
        TENANT_ENV,
      ),
    ).toEqual({ ok: true });
  });

  it('fail — pool ID mismatched: L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH', () => {
    const badSettlementSwapPath = {
      tokenType: DEEP_TYPE,
      hops: ['0xWRONG_POOL'],
      settlementSwapDirection: 'baseForQuote' as const,
    };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: badSettlementSwapPath },
      CONFIG,
      TENANT_ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH');
  });

  it('fail — token type mismatch: L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH', () => {
    const badSettlementTokenSettlementSwapPath = {
      ...SETTLEMENT_SWAP_PATH_1HOP,
      tokenType: '0xfake::fake::FAKE',
    };
    const result = validateSettleArgs(
      { ...validArgs, extractedSettlementSwapPath: badSettlementTokenSettlementSwapPath },
      CONFIG,
      TENANT_ENV,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH');
  });

  // ── canonical 1hop: passes when in allowedSettlementSwapPaths ─────────────────────────

  it('pass (canonical) — 1hop in allowedSettlementSwapPaths', () => {
    expect(
      validateSettleArgs(
        { ...validArgs, extractedSettlementSwapPath: SETTLEMENT_SWAP_PATH_1HOP },
        CONFIG,
        CANONICAL_ENV,
      ),
    ).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────
// P1: Pre-settle validation (user commands only)
// ─────────────────────────────────────────────

describe('P1: validateUserCommands', () => {
  // ── Pass cases ────────────────────────────────────────────────────────────

  it('pass — empty commands (no user operations)', () => {
    const commands: PtbCommand[] = [];
    expect(validateUserCommands(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — external MoveCall only (DeFi action)', () => {
    const commands: PtbCommand[] = [makeExternalCall('0xDEFI', 'staking', 'stake')];
    expect(validateUserCommands(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — vault::withdraw (user operation, allowed)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'vault',
        function: 'withdraw',
        typeArguments: [],
        arguments: [],
      },
    ];
    expect(validateUserCommands(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — SplitCoins + TransferObjects + external MoveCall', () => {
    const commands: PtbCommand[] = [
      { kind: 'SplitCoins' },
      makeExternalCall('0xNFT', 'launchpad', 'mint'),
      { kind: 'TransferObjects' },
    ];
    expect(validateUserCommands(commands, ENV)).toEqual({ ok: true });
  });

  it('pass — vault::withdraw + external call', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'vault',
        function: 'withdraw',
        typeArguments: [],
        arguments: [],
      },
      makeExternalCall(),
    ];
    expect(validateUserCommands(commands, ENV)).toEqual({ ok: true });
  });

  // ── Fail: settle forbidden ────────────────────────────────────────────────

  it('fail — new-user settlement rejected (P1_USER_SETTLE_FORBIDDEN)', () => {
    const commands: PtbCommand[] = [makeNewUserCall()];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_USER_SETTLE_FORBIDDEN');
  });

  it('fail — vault-backed settlement rejected (P1_USER_SETTLE_FORBIDDEN)', () => {
    const commands: PtbCommand[] = [makeWithVaultCall()];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_USER_SETTLE_FORBIDDEN');
  });

  it('fail — credit-only settlement rejected (P1_USER_SETTLE_FORBIDDEN)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: SETTLE_MODULE,
        function: SETTLE_WITH_CREDIT_FUNCTION,
        typeArguments: [],
        arguments: [],
      },
    ];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_USER_SETTLE_FORBIDDEN');
  });

  // ── Fail: Publish/Upgrade ─────────────────────────────────────────────────

  it('fail — Publish command rejected (P1_FORBIDDEN_COMMAND)', () => {
    const commands: PtbCommand[] = [{ kind: 'Publish' }];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_FORBIDDEN_COMMAND');
  });

  it('fail — Upgrade command rejected (P1_FORBIDDEN_COMMAND)', () => {
    const commands: PtbCommand[] = [{ kind: 'Upgrade' }];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_FORBIDDEN_COMMAND');
  });

  // ── Fail: GasCoin reference (S-15) ────────────────────────────────────────

  it('fail — TransferObjects references GasCoin (P1_GASCOIN_FORBIDDEN)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'TransferObjects',
        arguments: [{ $kind: 'GasCoin' }, { $kind: 'Input', Input: 0 }],
      },
    ];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_GASCOIN_FORBIDDEN');
  });

  it('fail — GasCoin nested in object (S-15 deep recursion)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'TransferObjects',
        arguments: [
          { $kind: 'Wrapper', inner: { $kind: 'GasCoin' } },
          { $kind: 'Input', Input: 0 },
        ],
      },
    ];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_GASCOIN_FORBIDDEN');
  });

  // ── Fail: MAX_COMMANDS ────────────────────────────────────────────────────

  it('fail — command count exceeds limit (P1_TOO_MANY_COMMANDS)', () => {
    const commands: PtbCommand[] = Array.from({ length: 17 }, () => ({
      kind: 'TransferObjects' as const,
    }));
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_TOO_MANY_COMMANDS');
  });

  // ── Fail: unauthorized Stelis package call ─────────────────────────────────

  it('fail — Stelis admin function rejected (P1_UNAUTHORIZED_STELIS_CALL)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0xPACKAGE',
        module: 'config',
        function: 'set_fee',
        typeArguments: [],
        arguments: [],
      },
    ];
    const result = validateUserCommands(commands, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_UNAUTHORIZED_STELIS_CALL');
  });
});
