#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const BUILD_ROOT = join(WORKSPACE_ROOT, 'packages/contracts/move/build/Stelis');
const OUTPUT_PATH = join(WORKSPACE_ROOT, 'packages/contracts/src/settlementContract.ts');

const ENTRY_SPECS = [
  {
    functionName: 'swap_and_settle_new_user_bfq',
    variantClass: 'new_user',
    direction: 'baseForQuote',
    profile: 'newUser',
  },
  {
    functionName: 'swap_and_settle_with_vault_bfq',
    variantClass: 'with_vault',
    direction: 'baseForQuote',
    profile: 'withVault',
  },
  {
    functionName: 'swap_and_settle_new_user_qfb',
    variantClass: 'new_user',
    direction: 'quoteForBase',
    profile: 'newUser',
  },
  {
    functionName: 'swap_and_settle_with_vault_qfb',
    variantClass: 'with_vault',
    direction: 'quoteForBase',
    profile: 'withVault',
  },
  {
    exportName: 'SETTLE_WITH_CREDIT_FUNCTION',
    functionName: 'settle_with_credit',
    variantClass: 'credit',
  },
];

const SETTLE_FIELDS = [
  ['execution_cost_claim_mist', 'executionCostClaim', 'u64'],
  ['settlement_payout_recipient', 'settlementPayoutRecipient', 'address'],
  ['receipt_id', 'receiptId', 'vector<u8>'],
  ['nonce', 'nonce', 'u64'],
  ['sim_gas_reported', 'simGasReported', 'u64'],
  ['gas_variance_fixed_mist', 'gasVarianceFixedMist', 'u64'],
  ['slippage_buffer_mist', 'slippageBufferMist', 'u64'],
  ['quoted_host_fee_mist', 'quotedHostFeeMist', 'u64'],
  ['expected_protocol_fee_mist', 'expectedProtocolFeeMist', 'u64'],
  ['expected_config_version', 'expectedConfigVersion', 'u64'],
  ['quote_timestamp_ms', 'quoteTimestampMs', 'u64'],
  ['policy_hash', 'policyHash', 'vector<u8>'],
  ['order_id_hash', 'orderIdHash', 'vector<u8>'],
];

const SETTLE_ABORT_NAMES = [
  'EPaused',
  'EClaimTooHigh',
  'ETotalInTooLow',
  'EInsufficientFunds',
  'EInvalidReceiptId',
  'EInvalidPolicyHash',
  'EConfigVersionMismatch',
  'EProtocolFeeMismatch',
  'EHostFeeCapExceeded',
  'EInvalidOrderIdHash',
  'ESpreadTooWide',
];

const VAULT_ABORT_NAMES = [
  'EInsufficientBalance',
  'EReplayNonce',
  'EVaultAlreadyRegistered',
  'EVaultNotRegistered',
  'EVaultMismatch',
];

function fail(message) {
  throw new Error(`[generate-settlement-contract] ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runSui(args, options = {}) {
  const result = spawnSync('sui', args, {
    cwd: options.cwd ?? WORKSPACE_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `sui ${args.join(' ')} failed:\n${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

function walkJsonFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

function findModuleSummary(summaryRoot, predicate, label) {
  const matches = [];
  for (const path of walkJsonFiles(summaryRoot)) {
    if (path.endsWith('root_package_metadata.json') || path.endsWith('address_mapping.json')) {
      continue;
    }
    const value = readJson(path);
    if (predicate(value)) matches.push({ path, value });
  }
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} summary, found ${matches.length}`);
  }
  return matches[0].value;
}

function renderMoveType(type) {
  if (typeof type === 'string') return type;
  if (!type || typeof type !== 'object') fail(`unsupported Move type ${JSON.stringify(type)}`);
  if ('vector' in type) return `vector<${renderMoveType(type.vector)}>`;
  if ('TypeParameter' in type) return `T${type.TypeParameter}`;
  if ('Reference' in type) {
    const [mutable, inner] = type.Reference;
    return `&${mutable ? 'mut ' : ''}${renderMoveType(inner)}`;
  }
  if ('Datatype' in type) {
    const datatype = type.Datatype;
    const moduleAddress = datatype.module?.address;
    const moduleName = datatype.module?.name;
    if (
      typeof moduleAddress !== 'string' ||
      typeof moduleName !== 'string' ||
      typeof datatype.name !== 'string'
    ) {
      fail(`invalid datatype ${JSON.stringify(type)}`);
    }
    const args = (datatype.type_arguments ?? []).map((arg) => renderMoveType(arg?.argument ?? arg));
    return `${moduleAddress}::${moduleName}::${datatype.name}${args.length > 0 ? `<${args.join(', ')}>` : ''}`;
  }
  fail(`unsupported Move type ${JSON.stringify(type)}`);
}

function cleanDebugName(name) {
  if (typeof name !== 'string') fail(`invalid debug parameter name ${String(name)}`);
  return name.split('#', 1)[0];
}

export function parseU64ConstantPool(disassembly) {
  const constants = new Map();
  const pattern = /^\s*(\d+)\s*=>\s*u64:\s*(\d+)\s*$/gm;
  for (const match of disassembly.matchAll(pattern)) {
    const value = BigInt(match[2]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(`u64 constant at index ${match[1]} exceeds JavaScript's safe integer range`);
    }
    constants.set(Number(match[1]), Number(value));
  }
  if (constants.size === 0) fail('disassembly contained no u64 constant pool');
  return constants;
}

export function resolveAbortConstants(debugInfo, disassembly, names, label) {
  const constants = parseU64ConstantPool(disassembly);
  const resolved = {};
  for (const name of names) {
    const index = debugInfo.constant_map?.[name];
    if (!Number.isInteger(index)) fail(`${label}.${name} has no compiled constant index`);
    const value = constants.get(index);
    if (!Number.isInteger(value)) fail(`${label}.${name} constant index ${index} is not u64`);
    resolved[name] = value;
  }
  return resolved;
}

function resolveCompleteModuleAbortConstants(debugInfo, disassembly, expectedNames, label) {
  const constantPool = parseU64ConstantPool(disassembly);
  const namesByIndex = new Map();
  for (const [name, index] of Object.entries(debugInfo.constant_map ?? {})) {
    if (!Number.isInteger(index)) continue;
    const names = namesByIndex.get(index) ?? [];
    names.push(name);
    namesByIndex.set(index, names);
  }

  const resolved = {};
  const abortUsePattern =
    /^\s*\d+:\s*LdConst\[(\d+)\]\(u64:\s*(\d+)\)\s*$\r?\n^\s*\d+:\s*Abort\s*$/gm;
  let resolvedAbortUseCount = 0;
  for (const match of disassembly.matchAll(abortUsePattern)) {
    resolvedAbortUseCount += 1;
    const index = Number(match[1]);
    const code = Number(match[2]);
    if (constantPool.get(index) !== code) {
      fail(`${label} abort constant index ${index} disagrees with its constant-pool value`);
    }
    const names = namesByIndex.get(index) ?? [];
    if (names.length !== 1) {
      fail(`${label} abort constant index ${index} resolves to ${names.length} debug names`);
    }
    const name = names[0];
    if (resolved[name] !== undefined && resolved[name] !== code) {
      fail(`${label}.${name} has inconsistent compiled abort values`);
    }
    resolved[name] = code;
  }

  const abortInstructionCount = [...disassembly.matchAll(/^\s*\d+:\s*Abort\s*$/gm)].length;
  if (resolvedAbortUseCount !== abortInstructionCount) {
    fail(
      `${label} has ${abortInstructionCount} Abort instructions but only ${resolvedAbortUseCount} named constant uses`,
    );
  }

  const actualNames = Object.keys(resolved).sort();
  const supportedNames = [...expectedNames].sort();
  if (!sameJson(actualNames, supportedNames)) {
    fail(`${label} compiled abort names differ from the supported set: ${actualNames.join(', ')}`);
  }
  return Object.fromEntries(expectedNames.map((name) => [name, resolved[name]]));
}

function assertAbortUsed(debugInfo, disassembly, constantName, code, label, functionName) {
  const constantIndex = debugInfo.constant_map?.[constantName];
  if (!Number.isInteger(constantIndex)) {
    fail(`${label}.${constantName} has no compiled constant index`);
  }
  let scope = disassembly;
  if (functionName) {
    const header = new RegExp(
      String.raw`^public\s+${functionName}(?:<[^\n]*>)?\([^\n]*\)[^\n]*\{\s*$`,
      'm',
    ).exec(disassembly);
    if (!header || header.index === undefined) {
      fail(`${label} disassembly has no public ${functionName} function`);
    }
    const bodyEnd = disassembly.indexOf('\n}', header.index);
    if (bodyEnd < 0) fail(`${label}.${functionName} disassembly has no closing brace`);
    scope = disassembly.slice(header.index, bodyEnd);
  }
  const abortUse = new RegExp(
    String.raw`^\s*\d+:\s*LdConst\[${constantIndex}\]\(u64:\s*${code}\)\s*$\r?\n^\s*\d+:\s*Abort\s*$`,
    'm',
  );
  if (!abortUse.test(scope)) {
    fail(
      `${label}.${constantName} is not loaded immediately before Abort${functionName ? ` in ${functionName}` : ''}`,
    );
  }
}

function disassembleCopiedModule(modulePath, tempRoot, name) {
  const copiedPath = join(tempRoot, `${name}.mv`);
  copyFileSync(modulePath, copiedPath);
  return runSui(['move', 'disassemble', copiedPath], { cwd: tempRoot });
}

function readFunctionContract(summary, debugInfo, functionName) {
  const fn = summary.functions?.[functionName];
  if (!fn) fail(`compiled settle function ${functionName} not found`);
  if (fn.visibility !== 'Public') fail(`${functionName} is not public`);
  if ((fn.return_ ?? []).length !== 0) fail(`${functionName} unexpectedly returns values`);
  if (!Array.isArray(fn.type_parameters)) {
    fail(`${functionName} has no compiled type-parameter list`);
  }
  const typeParameters = fn.type_parameters.map((parameter, index) => {
    if (!parameter || !Array.isArray(parameter.constraints)) {
      fail(`${functionName} type parameter ${index} has invalid constraints`);
    }
    if (!parameter.constraints.every((constraint) => typeof constraint === 'string')) {
      fail(`${functionName} type parameter ${index} has non-string constraints`);
    }
    return { constraints: [...parameter.constraints] };
  });
  const debugFn = debugInfo.function_map?.[String(fn.index)];
  if (!debugFn) fail(`${functionName} has no compiler debug entry at index ${fn.index}`);
  if (debugFn.parameters.length !== fn.parameters.length) {
    fail(`${functionName} summary/debug parameter count mismatch`);
  }
  const parameters = fn.parameters.map((parameter, index) => ({
    name: cleanDebugName(debugFn.parameters[index][0]),
    moveType: renderMoveType(parameter.type_),
  }));
  const ctx = parameters.at(-1);
  if (!ctx || ctx.name !== 'ctx' || !ctx.moveType.endsWith('tx_context::TxContext')) {
    fail(`${functionName} does not end in the compiler-injected TxContext parameter`);
  }
  return { typeParameters, parameters: parameters.slice(0, -1) };
}

function expectedEntryTypeParameters(spec) {
  return spec.variantClass === 'credit' ? [] : [{ constraints: [] }];
}

function expectedEntryParameters(spec, settleSummary, poolSummary) {
  const stelisAddress = settleSummary.id.address;
  const suiAddress = `0x${'0'.repeat(63)}2`;
  const stelisType = (moduleName, typeName, mutable = false) => ({
    name: '',
    moveType: `&${mutable ? 'mut ' : ''}${stelisAddress}::${moduleName}::${typeName}`,
  });
  const prefix = [
    { ...stelisType('config', 'Config'), name: 'config' },
    {
      ...stelisType('vault', 'VaultRegistry', spec.variantClass === 'new_user'),
      name: 'registry',
    },
    { name: 'clock', moveType: `&${suiAddress}::clock::Clock` },
  ];
  if (spec.variantClass === 'credit') {
    prefix.push(
      { ...stelisType('vault', 'UserVault', true), name: 'user_vault' },
      { name: 'use_credit_amount', moveType: 'u64' },
    );
  } else {
    if (spec.variantClass === 'with_vault') {
      prefix.push({ ...stelisType('vault', 'UserVault', true), name: 'user_vault' });
    }
    const suiType = `${suiAddress}::sui::SUI`;
    const poolTypes = spec.direction === 'baseForQuote' ? `T0, ${suiType}` : `${suiType}, T0`;
    prefix.push(
      {
        name: 'pool',
        moveType: `&mut ${poolSummary.id.address}::${poolSummary.id.name}::Pool<${poolTypes}>`,
      },
      { name: 'payment_coin', moveType: `${suiAddress}::coin::Coin<T0>` },
      { name: 'swap_amount', moveType: 'u64' },
      { name: 'min_sui_out', moveType: 'u64' },
    );
  }
  const settlement = SETTLE_FIELDS.map(([name, , moveType]) => ({ name, moveType }));
  const tail =
    spec.variantClass === 'with_vault' ? [{ name: 'use_credit_amount', moveType: 'u64' }] : [];
  return [...prefix, ...settlement, ...tail];
}

function assertSupportedEntryContract(spec, contract, settleSummary, poolSummary) {
  const expectedTypeParameters = expectedEntryTypeParameters(spec);
  if (!sameJson(contract.typeParameters, expectedTypeParameters)) {
    fail(
      `${spec.functionName} type parameters are unsupported:\nexpected ${JSON.stringify(expectedTypeParameters)}\ncompiled ${JSON.stringify(contract.typeParameters)}`,
    );
  }
  const expected = expectedEntryParameters(spec, settleSummary, poolSummary);
  if (!sameJson(contract.parameters, expected)) {
    fail(
      `${spec.functionName} parameters are unsupported:\nexpected ${JSON.stringify(expected)}\ncompiled ${JSON.stringify(contract.parameters)}`,
    );
  }
}

function deriveVariantLayout(parameters, variantClass) {
  const settleStartIndex = parameters.findIndex(
    (parameter) => parameter.name === SETTLE_FIELDS[0][0],
  );
  if (settleStartIndex < 0) fail(`${variantClass} has no settlement field block`);
  for (let offset = 0; offset < SETTLE_FIELDS.length; offset++) {
    const [moveName, , moveType] = SETTLE_FIELDS[offset];
    const parameter = parameters[settleStartIndex + offset];
    if (!parameter || parameter.name !== moveName || parameter.moveType !== moveType) {
      fail(
        `${variantClass} settlement field ${offset} expected ${moveName}: ${moveType}, got ${parameter?.name}: ${parameter?.moveType}`,
      );
    }
  }
  const paymentCoinIndex = parameters.findIndex((parameter) => parameter.name === 'payment_coin');
  const swapAmountIndex = parameters.findIndex((parameter) => parameter.name === 'swap_amount');
  const creditIndex = parameters.findIndex((parameter) => parameter.name === 'use_credit_amount');
  const layout = {
    settleStartIndex,
    poolIndices: parameters.flatMap((parameter, index) =>
      parameter.name === 'pool' ? [index] : [],
    ),
    hasVault: parameters.some((parameter) => parameter.name === 'user_vault'),
    hasTailCredit: creditIndex >= settleStartIndex + SETTLE_FIELDS.length,
  };
  if (paymentCoinIndex >= 0) layout.paymentCoinIndex = paymentCoinIndex;
  if (swapAmountIndex >= 0) layout.swapAmountIndex = swapAmountIndex;
  return layout;
}

function deriveSettleEventFields(eventsSummary) {
  const event = eventsSummary.structs?.SettleEvent;
  if (!event || !Array.isArray(event.type_parameters) || event.type_parameters.length !== 0) {
    fail('compiled events::SettleEvent must be non-generic');
  }
  const fields = event?.fields?.fields;
  if (!fields || event.fields.positional_fields !== false) {
    fail('compiled events::SettleEvent is missing named fields');
  }
  const result = Object.entries(fields)
    .map(([name, field]) => ({ name, index: field.index, moveType: renderMoveType(field.type_) }))
    .sort((a, b) => a.index - b.index);
  for (const [index, field] of result.entries()) {
    if (field.index !== index)
      fail(`SettleEvent field indices are not contiguous at ${field.name}`);
    if (!['u64', 'address', 'vector<u8>'].includes(field.moveType)) {
      fail(`unsupported SettleEvent field type ${field.name}: ${field.moveType}`);
    }
  }
  return result;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCompiledAddress(address) {
  if (typeof address !== 'string') fail(`invalid compiled address ${String(address)}`);
  return address.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0';
}

function assertDisassemblyModule(disassembly, summary, label) {
  const moduleHeader = disassembly.match(
    /^module\s+([0-9a-fA-F]+)\.([A-Za-z_][A-Za-z0-9_]*)\s*\{/m,
  );
  if (!moduleHeader) fail(`${label} disassembly has no module header`);
  if (
    normalizeCompiledAddress(moduleHeader[1]) !== normalizeCompiledAddress(summary.id?.address) ||
    moduleHeader[2] !== summary.id?.name
  ) {
    fail(
      `${label} summary/disassembly identity mismatch: ${summary.id?.address}::${summary.id?.name} vs ${moduleHeader[1]}::${moduleHeader[2]}`,
    );
  }
}

export function buildSettlementModel(inputs) {
  const {
    settleSummary,
    vaultSummary,
    eventsSummary,
    poolSummary,
    settleDebug,
    vaultDebug,
    poolDebug,
  } = inputs;
  assertDisassemblyModule(inputs.settleDisassembly, settleSummary, 'Stelis settle');
  assertDisassemblyModule(inputs.vaultDisassembly, vaultSummary, 'Stelis vault');
  assertDisassemblyModule(inputs.poolDisassembly, poolSummary, 'DeepBook pool');
  const compiledPublicFunctions = Object.entries(settleSummary.functions ?? {})
    .filter(([, fn]) => fn.visibility === 'Public')
    .map(([name]) => name)
    .sort();
  const supportedFunctions = ENTRY_SPECS.map((spec) => spec.functionName).sort();
  if (!sameJson(compiledPublicFunctions, supportedFunctions)) {
    fail(
      `compiled public settlement functions differ from the supported production set: ${compiledPublicFunctions.join(', ')}`,
    );
  }
  const entryFunctions = {};
  const variantLayouts = {};
  for (const spec of ENTRY_SPECS) {
    const contract = readFunctionContract(settleSummary, settleDebug, spec.functionName);
    assertSupportedEntryContract(spec, contract, settleSummary, poolSummary);
    entryFunctions[spec.functionName] = { variantClass: spec.variantClass, ...contract };
    const layout = deriveVariantLayout(contract.parameters, spec.variantClass);
    const previous = variantLayouts[spec.variantClass];
    if (previous && !sameJson(previous, layout)) {
      fail(`compiled ${spec.variantClass} settlement functions have different layouts`);
    }
    variantLayouts[spec.variantClass] = layout;
  }

  const firstEntry = entryFunctions[ENTRY_SPECS[0].functionName];
  const firstStart = variantLayouts[ENTRY_SPECS[0].variantClass].settleStartIndex;
  const settleFields = SETTLE_FIELDS.map(([moveName, name, moveType], offset) => {
    const parameter = firstEntry.parameters[firstStart + offset];
    if (parameter.name !== moveName || parameter.moveType !== moveType) {
      fail(`canonical settlement field ${moveName} did not match compiled entry`);
    }
    return { name, moveName, moveType };
  });

  const settleAbort = resolveCompleteModuleAbortConstants(
    settleDebug,
    inputs.settleDisassembly,
    SETTLE_ABORT_NAMES,
    'SETTLE_ABORT',
  );
  const vaultAbort = resolveCompleteModuleAbortConstants(
    vaultDebug,
    inputs.vaultDisassembly,
    VAULT_ABORT_NAMES,
    'VAULT_ABORT',
  );
  const deepbookAbort = resolveAbortConstants(
    poolDebug,
    inputs.poolDisassembly,
    ['EMinimumQuantityOutNotMet'],
    'DEEPBOOK_MIN_OUT_ABORT',
  );
  assertAbortUsed(
    poolDebug,
    inputs.poolDisassembly,
    'EMinimumQuantityOutNotMet',
    deepbookAbort.EMinimumQuantityOutNotMet,
    'DEEPBOOK_MIN_OUT_ABORT',
    'swap_exact_quantity',
  );

  return {
    entryFunctions,
    settleFields,
    settleEventFields: deriveSettleEventFields(eventsSummary),
    settleAbort,
    vaultAbort,
    deepbookMinOutAbort: {
      runtimePackageId: poolSummary.id.address,
      modulePath: `${poolSummary.id.name}::swap_exact_quantity`,
      constantName: 'EMinimumQuantityOutNotMet',
      code: deepbookAbort.EMinimumQuantityOutNotMet,
    },
  };
}

function tsJson(value) {
  return JSON.stringify(value, null, 2);
}

function settleFieldValueType(field) {
  if (field.moveType === 'u64') return 'bigint';
  if (field.moveType === 'address') return 'string';
  if (field.moveType === 'vector<u8>') return 'Uint8Array';
  fail(`no TypeScript value type for ${field.name}: ${field.moveType}`);
}

function eventFieldValueType(field) {
  if (field.moveType === 'u64') return 'string';
  if (field.moveType === 'address') return 'string';
  if (field.moveType === 'vector<u8>') return 'Uint8Array';
  fail(`no event value type for ${field.name}: ${field.moveType}`);
}

export function renderSettlementContract(model) {
  const exportLines = ENTRY_SPECS.filter((spec) => spec.exportName)
    .map((spec) => `export const ${spec.exportName} = '${spec.functionName}';`)
    .join('\n');
  const directionFunctions = {
    baseForQuote: {
      newUser: ENTRY_SPECS.find(
        (spec) => spec.direction === 'baseForQuote' && spec.profile === 'newUser',
      ).functionName,
      withVault: ENTRY_SPECS.find(
        (spec) => spec.direction === 'baseForQuote' && spec.profile === 'withVault',
      ).functionName,
    },
    quoteForBase: {
      newUser: ENTRY_SPECS.find(
        (spec) => spec.direction === 'quoteForBase' && spec.profile === 'newUser',
      ).functionName,
      withVault: ENTRY_SPECS.find(
        (spec) => spec.direction === 'quoteForBase' && spec.profile === 'withVault',
      ).functionName,
    },
  };
  const settleValueFields = model.settleFields
    .map((field) => `  ${field.name}: ${settleFieldValueType(field)};`)
    .join('\n');
  const eventValueFields = model.settleEventFields
    .map((field) => `  ${field.name}: ${eventFieldValueType(field)};`)
    .join('\n');

  return `// Generated by scripts/generate-settlement-contract.mjs from locked production Move bytecode.\n// Do not edit by hand.\n\nimport type { SettlementSwapDirection } from './types.js';\n\nexport const SETTLEMENT_CONTRACT_NETWORK = 'testnet' as const;\nexport const SETTLE_MODULE = 'settle';\n${exportLines}\n\nexport type SettleVariantClass = 'new_user' | 'with_vault' | 'credit';\n\nexport interface SettlementTypeParameterDescriptor {\n  readonly constraints: readonly string[];\n}\n\nexport interface SettlementParameterDescriptor {\n  readonly name: string;\n  readonly moveType: string;\n}\n\nexport const SETTLEMENT_ENTRY_FUNCTIONS = ${tsJson(model.entryFunctions)} as const satisfies Readonly<\n  Record<\n    string,\n    {\n      readonly variantClass: SettleVariantClass;\n      readonly typeParameters: readonly SettlementTypeParameterDescriptor[];\n      readonly parameters: readonly SettlementParameterDescriptor[];\n    }\n  >\n>;\n\nexport const SETTLE_FUNCTIONS: ReadonlySet<string> = new Set(\n  Object.keys(SETTLEMENT_ENTRY_FUNCTIONS),\n);\n\nexport function settlementParameterIndex(\n  functionName: string,\n  parameterName: string,\n): number | undefined {\n  const entry = (SETTLEMENT_ENTRY_FUNCTIONS as Readonly<\n    Record<string, { readonly parameters: readonly SettlementParameterDescriptor[] } | undefined>\n  >)[functionName];\n  if (!entry) return undefined;\n  const index = entry.parameters.findIndex((parameter) => parameter.name === parameterName);\n  return index >= 0 ? index : undefined;\n}\n\nexport const SETTLEMENT_SWAP_DIRECTION_FUNCTIONS: Record<\n  SettlementSwapDirection,\n  { readonly newUser: string; readonly withVault: string }\n> = ${tsJson(directionFunctions)};\n\nexport function settlementSwapDirectionFromFunctionName(\n  functionName: string,\n): SettlementSwapDirection | undefined {\n  for (const [direction, functions] of Object.entries(SETTLEMENT_SWAP_DIRECTION_FUNCTIONS)) {\n    if (functions.newUser === functionName || functions.withVault === functionName) {\n      return direction as SettlementSwapDirection;\n    }\n  }\n  return undefined;\n}\n\nexport type SettleFieldName = ${model.settleFields.map((field) => `'${field.name}'`).join(' | ')};\nexport type SettlementPureMoveType = 'u64' | 'address' | 'vector<u8>';\n\nexport interface SettleFieldDescriptor {\n  readonly name: SettleFieldName;\n  readonly moveName: string;\n  readonly moveType: SettlementPureMoveType;\n}\n\nexport const SETTLE_FIELD_SCHEMA = ${tsJson(model.settleFields)} as const satisfies readonly SettleFieldDescriptor[];\n\nexport interface SettleFieldValues {\n${settleValueFields}\n}\n\nexport const SETTLE_EVENT_MODULE = 'events';\nexport const SETTLE_EVENT_NAME = 'SettleEvent';\nexport type SettleEventFieldMoveType = 'u64' | 'address' | 'vector<u8>';\n\nexport interface SettleEventFieldDescriptor {\n  readonly name: string;\n  readonly index: number;\n  readonly moveType: SettleEventFieldMoveType;\n}\n\nexport const SETTLE_EVENT_FIELDS = ${tsJson(model.settleEventFields)} as const satisfies readonly SettleEventFieldDescriptor[];\n\nexport interface SettleEventValue {\n${eventValueFields}\n}\n\nexport const SETTLE_ABORT = ${tsJson(model.settleAbort)} as const satisfies Record<string, number>;\nexport const VAULT_ABORT = ${tsJson(model.vaultAbort)} as const satisfies Record<string, number>;\nexport const DEEPBOOK_MIN_OUT_ABORT = ${tsJson(model.deepbookMinOutAbort)} as const satisfies {\n  readonly runtimePackageId: string;\n  readonly modulePath: string;\n  readonly constantName: string;\n  readonly code: number;\n};\n`;
}

export function loadSettlementModel(buildRoot = BUILD_ROOT) {
  const bytecodeRoot = join(buildRoot, 'bytecode_modules');
  const debugRoot = join(buildRoot, 'debug_info');
  const buildInfo = readFileSync(join(buildRoot, 'BuildInfo.yaml'), 'utf8');
  if (!/^\s*test_mode:\s*false\s*$/m.test(buildInfo)) {
    fail('BuildInfo.yaml is not a production build (test_mode: false required)');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'stelis-settlement-contract-'));
  try {
    const summaryRoot = join(tempRoot, 'summaries');
    runSui([
      'move',
      'summary',
      '--bytecode',
      '--path',
      bytecodeRoot,
      '--output-directory',
      summaryRoot,
    ]);
    const settleSummary = findModuleSummary(
      summaryRoot,
      (summary) => summary.id?.name === 'settle' && summary.id.address === `0x${'0'.repeat(64)}`,
      'Stelis settle',
    );
    const eventsSummary = findModuleSummary(
      summaryRoot,
      (summary) => summary.id?.name === 'events' && summary.id.address === `0x${'0'.repeat(64)}`,
      'Stelis events',
    );
    const vaultSummary = findModuleSummary(
      summaryRoot,
      (summary) => summary.id?.name === 'vault' && summary.id.address === `0x${'0'.repeat(64)}`,
      'Stelis vault',
    );
    const poolSummary = findModuleSummary(
      summaryRoot,
      (summary) =>
        summary.id?.name === 'pool' &&
        summary.id.address !== `0x${'0'.repeat(64)}` &&
        summary.functions?.swap_exact_quantity,
      'consumed DeepBook pool',
    );

    const settleModule = join(bytecodeRoot, 'settle.mv');
    const vaultModule = join(bytecodeRoot, 'vault.mv');
    const poolModule = join(bytecodeRoot, 'dependencies/deepbook/pool.mv');
    return buildSettlementModel({
      settleSummary,
      vaultSummary,
      eventsSummary,
      poolSummary,
      settleDebug: readJson(join(debugRoot, 'settle.json')),
      vaultDebug: readJson(join(debugRoot, 'vault.json')),
      poolDebug: readJson(join(debugRoot, 'dependencies/deepbook/pool.json')),
      settleDisassembly: disassembleCopiedModule(settleModule, tempRoot, 'settle'),
      vaultDisassembly: disassembleCopiedModule(vaultModule, tempRoot, 'vault'),
      poolDisassembly: disassembleCopiedModule(poolModule, tempRoot, 'pool'),
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function generateSettlementContract({ check = false } = {}) {
  const prettierConfig = (await prettier.resolveConfig(OUTPUT_PATH)) ?? {};
  const rendered = await prettier.format(renderSettlementContract(loadSettlementModel()), {
    ...prettierConfig,
    filepath: OUTPUT_PATH,
  });
  if (check) {
    const current = readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== rendered) fail(`${OUTPUT_PATH} is stale; run the generator`);
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await generateSettlementContract({ check: process.argv.includes('--check') });
}
