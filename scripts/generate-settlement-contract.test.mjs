import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSettlementModel,
  loadSettlementModel,
  parseU64ConstantPool,
  renderSettlementContract,
  resolveAbortConstants,
} from './generate-settlement-contract.mjs';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOVE_ROOT = join(WORKSPACE_ROOT, 'packages/contracts/move');

const SETTLE_FIELD_TYPES = [
  'u64',
  'address',
  { vector: 'u8' },
  'u64',
  'u64',
  'u64',
  'u64',
  'u64',
  'u64',
  'u64',
  'u64',
  { vector: 'u8' },
  { vector: 'u8' },
];

const SETTLE_FIELD_NAMES = [
  'execution_cost_claim_mist',
  'settlement_payout_recipient',
  'receipt_id',
  'nonce',
  'sim_gas_reported',
  'gas_variance_fixed_mist',
  'slippage_buffer_mist',
  'quoted_host_fee_mist',
  'expected_protocol_fee_mist',
  'expected_config_version',
  'quote_timestamp_ms',
  'policy_hash',
  'order_id_hash',
];

const CTX_TYPE = {
  Reference: [
    true,
    {
      Datatype: {
        module: { address: `0x${'0'.repeat(64)}`, name: 'tx_context' },
        name: 'TxContext',
        type_arguments: [],
      },
    },
  ],
};

const LOCAL_ADDRESS = `0x${'0'.repeat(64)}`;
const SUI_ADDRESS = `0x${'0'.repeat(63)}2`;
const DEEPBOOK_ORIGINAL_ADDRESS = `0x${'f'.repeat(64)}`;

const T0 = { TypeParameter: 0 };

function datatype(address, moduleName, name, typeArguments = []) {
  return {
    Datatype: {
      module: { address, name: moduleName },
      name,
      type_arguments: typeArguments.map((argument) => ({ argument })),
    },
  };
}

function reference(mutable, inner) {
  return { Reference: [mutable, inner] };
}

function entryParameters(variantClass, direction) {
  const prefix = [
    ['config', reference(false, datatype(LOCAL_ADDRESS, 'config', 'Config'))],
    [
      'registry',
      reference(variantClass === 'new_user', datatype(LOCAL_ADDRESS, 'vault', 'VaultRegistry')),
    ],
    ['clock', reference(false, datatype(SUI_ADDRESS, 'clock', 'Clock'))],
  ];
  if (variantClass === 'credit') {
    prefix.push(
      ['user_vault', reference(true, datatype(LOCAL_ADDRESS, 'vault', 'UserVault'))],
      ['use_credit_amount', 'u64'],
    );
  } else {
    if (variantClass === 'with_vault') {
      prefix.push(['user_vault', reference(true, datatype(LOCAL_ADDRESS, 'vault', 'UserVault'))]);
    }
    const suiType = datatype(SUI_ADDRESS, 'sui', 'SUI');
    const poolTypeArguments = direction === 'baseForQuote' ? [T0, suiType] : [suiType, T0];
    prefix.push(
      [
        'pool',
        reference(true, datatype(DEEPBOOK_ORIGINAL_ADDRESS, 'pool', 'Pool', poolTypeArguments)),
      ],
      ['payment_coin', datatype(SUI_ADDRESS, 'coin', 'Coin', [T0])],
      ['swap_amount', 'u64'],
      ['min_sui_out', 'u64'],
    );
  }
  const tailNames = variantClass === 'with_vault' ? ['use_credit_amount'] : [];
  const names = [...prefix.map(([name]) => name), ...SETTLE_FIELD_NAMES, ...tailNames, 'ctx'];
  const types = [
    ...prefix.map(([, type]) => type),
    ...SETTLE_FIELD_TYPES,
    ...tailNames.map(() => 'u64'),
    CTX_TYPE,
  ];
  return { names, types };
}

function compiledFixture() {
  const specs = [
    ['swap_and_settle_new_user_bfq', 'new_user', 'baseForQuote'],
    ['swap_and_settle_with_vault_bfq', 'with_vault', 'baseForQuote'],
    ['swap_and_settle_new_user_qfb', 'new_user', 'quoteForBase'],
    ['swap_and_settle_with_vault_qfb', 'with_vault', 'quoteForBase'],
    ['settle_with_credit', 'credit', undefined],
  ];
  const functions = {};
  const functionMap = {};
  for (const [index, [name, variantClass, direction]] of specs.entries()) {
    const parameters = entryParameters(variantClass, direction);
    functions[name] = {
      index,
      visibility: 'Public',
      type_parameters: variantClass === 'credit' ? [] : [{ constraints: [] }],
      parameters: parameters.types.map((type_) => ({ type_ })),
    };
    functionMap[String(index)] = {
      parameters: parameters.names.map((parameter) => [`${parameter}#0#0`, {}]),
    };
  }

  const eventTypes = [
    { vector: 'u8' },
    'u64',
    { vector: 'u8' },
    'u64',
    'u64',
    'u64',
    'u64',
    'u64',
    'u64',
    'u64',
    'u64',
    'address',
    'u64',
    'u64',
    'u64',
    'u64',
    'address',
    'address',
    { vector: 'u8' },
  ];
  const eventNames = [
    'receipt_id',
    'nonce',
    'policy_hash',
    'quote_timestamp_ms',
    'exec_timestamp_ms',
    'sim_gas_reported',
    'gas_variance_fixed_mist',
    'slippage_buffer_mist',
    'execution_cost_claim_mist',
    'quoted_host_fee_mist',
    'protocol_fee',
    'protocol_treasury',
    'payout',
    'total_in',
    'surplus_credited',
    'config_version',
    'user',
    'settlement_payout_recipient',
    'order_id_hash',
  ];

  const settleAbortNames = [
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
  const vaultAbortNames = [
    'EInsufficientBalance',
    'EReplayNonce',
    'EVaultAlreadyRegistered',
    'EVaultNotRegistered',
    'EVaultMismatch',
  ];

  return {
    settleSummary: { id: { address: LOCAL_ADDRESS, name: 'settle' }, functions },
    vaultSummary: { id: { address: LOCAL_ADDRESS, name: 'vault' } },
    poolSummary: {
      id: { address: DEEPBOOK_ORIGINAL_ADDRESS, name: 'pool' },
    },
    eventsSummary: {
      structs: {
        SettleEvent: {
          type_parameters: [],
          fields: {
            positional_fields: false,
            fields: Object.fromEntries(
              eventNames.map((name, index) => [name, { index, type_: eventTypes[index] }]),
            ),
          },
        },
      },
    },
    settleDebug: {
      function_map: functionMap,
      constant_map: Object.fromEntries(settleAbortNames.map((name, index) => [name, index])),
    },
    vaultDebug: {
      constant_map: Object.fromEntries(vaultAbortNames.map((name, index) => [name, index])),
    },
    poolDebug: { constant_map: { EMinimumQuantityOutNotMet: 10 } },
    settleDisassembly: `module ${'0'.repeat(64)}.settle {\n${settleAbortNames
      .map((_, index) => `${index} => u64: ${100 + index}`)
      .join('\n')}\n${settleAbortNames
      .map(
        (_, index) =>
          `${200 + index * 2}: LdConst[${index}](u64: ${100 + index})\n${201 + index * 2}: Abort`,
      )
      .join('\n')}\n}`,
    vaultDisassembly: `module ${'0'.repeat(64)}.vault {\n${vaultAbortNames
      .map((_, index) => `${index} => u64: ${index}`)
      .join('\n')}\n${vaultAbortNames
      .map(
        (_, index) =>
          `${200 + index * 2}: LdConst[${index}](u64: ${index})\n${201 + index * 2}: Abort`,
      )
      .join('\n')}\n}`,
    poolDisassembly: `module ${'f'.repeat(64)}.pool {\n10 => u64: 12\npublic swap_exact_quantity<Ty0, Ty1>() {\n164: LdConst[10](u64: 12)\n165: Abort\n}\n}`,
  };
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}: source pattern was not found`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `${label}: source pattern repeated`,
  );
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceInFunctionExactlyOnce(source, functionName, before, after) {
  const marker = `public fun ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName}: function was not found`);
  assert.equal(
    source.indexOf(marker, start + marker.length),
    -1,
    `${functionName}: function repeated`,
  );
  const nextSection = source.indexOf('\n    // ─', start);
  assert.notEqual(nextSection, -1, `${functionName}: next section boundary was not found`);
  const functionSource = source.slice(start, nextSection);
  const changedFunction = replaceExactlyOnce(
    functionSource,
    before,
    after,
    `${functionName} mutation`,
  );
  return source.slice(0, start) + changedFunction + source.slice(nextSection);
}

describe('compiled settlement contract generator', () => {
  it('resolves named aborts through compiled constant-pool indices', () => {
    const disassembly = '0 => u64: 100\n10 => u64: 12';
    assert.deepEqual(
      [...parseU64ConstantPool(disassembly)],
      [
        [0, 100],
        [10, 12],
      ],
    );
    assert.deepEqual(
      resolveAbortConstants(
        { constant_map: { EMinimumQuantityOutNotMet: 10 } },
        disassembly,
        ['EMinimumQuantityOutNotMet'],
        'DEEPBOOK_MIN_OUT_ABORT',
      ),
      { EMinimumQuantityOutNotMet: 12 },
    );
  });

  it('fails when a compiled production settlement field changes type', () => {
    const fixture = compiledFixture();
    fixture.settleSummary.functions.swap_and_settle_new_user_bfq.parameters[7].type_ = 'address';
    assert.throws(() => buildSettlementModel(fixture), /execution_cost_claim_mist/);
  });

  it('fails when a compiled production settlement generic declaration changes', () => {
    const fixture = compiledFixture();
    fixture.settleSummary.functions.swap_and_settle_new_user_bfq.type_parameters.push({
      constraints: [],
    });
    assert.throws(() => buildSettlementModel(fixture), /type parameters are unsupported/);
  });

  it('fails when the compiled Stelis module adds an unsupported named abort', () => {
    const fixture = compiledFixture();
    fixture.settleDebug.constant_map.ENewAbort = 11;
    fixture.settleDisassembly = fixture.settleDisassembly.replace(
      '\n}',
      '\n11 => u64: 999\n500: LdConst[11](u64: 999)\n501: Abort\n}',
    );
    assert.throws(() => buildSettlementModel(fixture), /compiled abort names differ/);
  });

  it('changes generated output when the compiled SettleEvent layout changes', () => {
    const baseline = compiledFixture();
    const changed = compiledFixture();
    changed.eventsSummary.structs.SettleEvent.fields.fields.user.type_ = 'u64';
    assert.notEqual(
      renderSettlementContract(buildSettlementModel(baseline)),
      renderSettlementContract(buildSettlementModel(changed)),
    );
  });

  it('fails when the compiled SettleEvent becomes generic', () => {
    const fixture = compiledFixture();
    fixture.eventsSummary.structs.SettleEvent.type_parameters.push({ constraints: [] });
    assert.throws(() => buildSettlementModel(fixture), /SettleEvent must be non-generic/);
  });

  it('changes generated output when a compiled abort value changes', () => {
    const baseline = compiledFixture();
    const changed = compiledFixture();
    changed.settleDisassembly = changed.settleDisassembly.replaceAll('u64: 101', 'u64: 201');
    assert.notEqual(
      renderSettlementContract(buildSettlementModel(baseline)),
      renderSettlementContract(buildSettlementModel(changed)),
    );
  });

  it(
    'observes entry, event, and abort mutations compiled from Move source',
    { timeout: 180_000 },
    () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'stelis-settlement-source-mutation-'));
      const mutatedMoveRoot = join(tempRoot, 'move');
      try {
        const ignoredBuildRoot = join(MOVE_ROOT, 'build');
        cpSync(MOVE_ROOT, mutatedMoveRoot, {
          recursive: true,
          filter: (source) =>
            source !== ignoredBuildRoot && !source.startsWith(`${ignoredBuildRoot}/`),
        });

        const settlePath = join(mutatedMoveRoot, 'sources/settle.move');
        const eventsPath = join(mutatedMoveRoot, 'sources/events.move');
        const buildMutatedMove = () => {
          const build = spawnSync('sui', ['move', 'build', '--path', mutatedMoveRoot], {
            cwd: WORKSPACE_ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          });
          assert.equal(
            build.status,
            0,
            `mutated Move build failed:\n${build.stderr || build.stdout || `exit ${build.status}`}`,
          );
        };

        let settleSource = readFileSync(settlePath, 'utf8');
        settleSource = replaceExactlyOnce(
          settleSource,
          '    const EClaimTooHigh: u64 = 101;',
          '    const EClaimTooHigh: u64 = 201;',
          'EClaimTooHigh mutation',
        );
        writeFileSync(settlePath, settleSource);

        const eventsSource = replaceExactlyOnce(
          readFileSync(eventsPath, 'utf8'),
          '        receipt_id: vector<u8>,\n        nonce: u64,                    // S-14: monotonic nonce for replay prevention',
          '        nonce: u64,                    // S-14: monotonic nonce for replay prevention\n        receipt_id: vector<u8>,',
          'SettleEvent field-order mutation',
        );
        writeFileSync(eventsPath, eventsSource);

        buildMutatedMove();
        const baseline = loadSettlementModel();
        const changed = loadSettlementModel(join(mutatedMoveRoot, 'build/Stelis'));
        assert.deepEqual(
          changed.settleEventFields.slice(0, 2).map((field) => field.name),
          ['nonce', 'receipt_id'],
        );
        assert.equal(changed.settleAbort.EClaimTooHigh, 201);
        assert.notEqual(renderSettlementContract(baseline), renderSettlementContract(changed));

        for (const functionName of [
          'swap_and_settle_new_user_bfq',
          'swap_and_settle_new_user_qfb',
        ]) {
          settleSource = replaceInFunctionExactlyOnce(
            settleSource,
            functionName,
            '        swap_amount: u64,\n        min_sui_out: u64,',
            '        min_sui_out: u64,\n        swap_amount: u64,',
          );
        }
        writeFileSync(settlePath, settleSource);
        buildMutatedMove();
        assert.throws(
          () => loadSettlementModel(join(mutatedMoveRoot, 'build/Stelis')),
          /swap_and_settle_new_user_bfq parameters are unsupported/,
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
