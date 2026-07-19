import { GrpcTypes } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
import {
  parseSuiArgument,
  parseSuiCallArg,
  parseSuiCommand,
  parseSuiCommands,
  parseRawSuiCommandResults,
  parseRawSuiSimulationTransaction,
  projectSuiCallArgObjectId,
  suiExecutionErrorMessage,
  SuiTransactionShapeError,
} from '../src/sui/suiTransactionShape.js';

const ID = `0x${'11'.repeat(32)}`;
const DIGEST = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';

function executedTransaction(
  value: Parameters<typeof GrpcTypes.ExecutedTransaction.create>[0],
): GrpcTypes.ExecutedTransaction {
  return GrpcTypes.ExecutedTransaction.create({
    transaction: { digest: DIGEST },
    ...value,
  });
}

describe('exact current Sui transaction shape', () => {
  it('rejects sparse arrays before projection can skip a missing element', () => {
    expect(() => parseSuiCommands(new Array(1))).toThrow('expected a dense array');
  });

  it('rejects enumerable properties outside the exact array elements', () => {
    const commands: unknown[] = [];
    Object.assign(commands, { extra: true });
    expect(() => parseSuiCommands(commands)).toThrow('expected a dense array');
  });

  it('accepts Receiving as an object input and projects its identity', () => {
    const input = parseSuiCallArg({
      $kind: 'Object',
      Object: {
        $kind: 'Receiving',
        Receiving: { objectId: ID, version: '7', digest: DIGEST },
      },
    });
    expect(projectSuiCallArgObjectId(input)).toBe(ID);
  });

  it('accepts exact FundsWithdrawal and rejects incomplete payload-only shapes', () => {
    expect(
      parseSuiCallArg({
        $kind: 'FundsWithdrawal',
        FundsWithdrawal: {
          reservation: { $kind: 'MaxAmountU64', MaxAmountU64: 7 },
          typeArg: { $kind: 'Balance', Balance: '0x2::sui::SUI' },
          withdrawFrom: { $kind: 'Sender', Sender: true },
        },
      }).$kind,
    ).toBe('FundsWithdrawal');
    expect(() =>
      parseSuiCallArg({
        $kind: 'FundsWithdrawal',
        FundsWithdrawal: {
          reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '7' },
          typeArg: { $kind: 'Balance', Balance: '0x2::sui::SUI' },
          withdrawFrom: { Sender: true },
        },
      }),
    ).toThrow(SuiTransactionShapeError);
  });

  it('requires enum payload ownership instead of accepting discriminators alone', () => {
    let thrown: unknown;
    try {
      parseSuiArgument({ $kind: 'GasCoin' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain('missing GasCoin payload');
    expect(() => parseSuiArgument({ $kind: 'Input', Input: 0, Result: 0 })).toThrow(
      'opposing Result payload',
    );
  });

  it('rejects fields outside the installed SDK Argument, CallArg, and ObjectArg shapes', () => {
    expect(() =>
      parseSuiArgument({ $kind: 'Input', Input: 0, type: 'object', legacyIndex: 0 }),
    ).toThrow('argument.legacyIndex: unsupported current field');

    expect(() =>
      parseSuiCallArg({
        $kind: 'Object',
        Object: {
          $kind: 'Receiving',
          Receiving: { objectId: ID, version: '7', digest: DIGEST, owner: ID },
        },
      }),
    ).toThrow('input.Object.Receiving.owner: unsupported current field');

    expect(() =>
      parseSuiCallArg({
        $kind: 'FundsWithdrawal',
        FundsWithdrawal: {
          reservation: { $kind: 'MaxAmountU64', MaxAmountU64: 7, amount: 7 },
          typeArg: { $kind: 'Balance', Balance: '0x2::sui::SUI' },
          withdrawFrom: { $kind: 'Sender', Sender: true },
        },
      }),
    ).toThrow('input.FundsWithdrawal.reservation.amount: unsupported current field');
  });

  it('accepts the current Intent command and rejects unknown command kinds', () => {
    expect(
      parseSuiCommand({
        $kind: '$Intent',
        $Intent: {
          name: 'current-intent',
          inputs: { coin: { $kind: 'Input', Input: 0 } },
          data: {},
        },
      }).$kind,
    ).toBe('$Intent');
    expect(() => parseSuiCommand({ $kind: 'UnsupportedCommand', UnsupportedCommand: {} })).toThrow(
      'unsupported current kind',
    );
  });

  it('validates every nested current Move-call argument signature', () => {
    expect(
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
          _argumentTypes: [
            {
              reference: 'immutable',
              body: {
                $kind: 'vector',
                vector: {
                  $kind: 'datatype',
                  datatype: {
                    typeName: '0x2::coin::Coin',
                    typeParameters: [{ $kind: 'typeParameter', index: 0 }],
                  },
                },
              },
            },
          ],
        },
      }).$kind,
    ).toBe('MoveCall');
    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
          _argumentTypes: [
            {
              reference: null,
              body: { $kind: 'u64', vector: { $kind: 'u8' } },
            },
          ],
        },
      }),
    ).toThrow('opposing vector payload');

    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: ['not a type tag'],
          arguments: [],
        },
      }),
    ).toThrow('expected a current Sui type tag');

    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
          _argumentTypes: [
            {
              reference: null,
              body: { $kind: 'typeParameter', index: -1 },
            },
          ],
        },
      }),
    ).toThrow('expected a non-negative safe integer');
  });

  it('rejects fields outside current command payload and open-signature shapes', () => {
    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
        },
        commandVersion: 1,
      }),
    ).toThrow('command.commandVersion: unsupported current field');

    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
          legacyArguments: [],
        },
      }),
    ).toThrow('command.MoveCall.legacyArguments: unsupported current field');

    expect(() =>
      parseSuiCommand({
        $kind: 'MoveCall',
        MoveCall: {
          package: ID,
          module: 'pool',
          function: 'swap',
          typeArguments: [],
          arguments: [],
          _argumentTypes: [
            {
              reference: null,
              body: { $kind: 'u64', legacyType: 'u64' },
            },
          ],
        },
      }),
    ).toThrow('command.MoveCall._argumentTypes[0].body.legacyType: unsupported current field');
  });

  it('validates optional MakeMoveVec types as full current TypeTags', () => {
    expect(
      parseSuiCommand({
        $kind: 'MakeMoveVec',
        MakeMoveVec: { type: 'vector<u64>', elements: [] },
      }).$kind,
    ).toBe('MakeMoveVec');
    expect(() =>
      parseSuiCommand({
        $kind: 'MakeMoveVec',
        MakeMoveVec: { type: 'not a type tag', elements: [] },
      }),
    ).toThrow('expected a current Sui type tag');
  });

  it('preserves structured MoveAbort identity instead of requiring message parsing', () => {
    const providerDescription = 'rpc-secret\n<script>alert("provider")</script>';
    const renderedCleverValue = 'https://user:password@example.invalid/private';
    const result = parseRawSuiSimulationTransaction(
      executedTransaction({
        effects: {
          version: 2,
          transactionDigest: DIGEST,
          status: {
            success: false,
            error: {
              description: providerDescription,
              command: 3n,
              kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
              errorDetails: {
                oneofKind: 'abort',
                abort: {
                  abortCode: 7n,
                  location: {
                    package: ID,
                    module: 'pool',
                    function: 2,
                    functionName: 'swap',
                    instruction: 9,
                  },
                  cleverError: {
                    constantName: 'ETooSmall',
                    value: { oneofKind: 'rendered', rendered: renderedCleverValue },
                  },
                },
              },
            },
          },
          gasUsed: {
            computationCost: 1n,
            storageCost: 2n,
            storageRebate: 0n,
            nonRefundableStorageFee: 0n,
          },
        },
      }),
      DIGEST,
    );

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error).toMatchObject({
        kind: 'MoveAbort',
        command: 3,
        moveAbort: {
          packageId: ID,
          module: 'pool',
          functionIndex: 2,
          functionName: 'swap',
          instruction: 9,
          abortCode: '7',
          constantName: 'ETooSmall',
        },
      });
      expect(result.error).not.toHaveProperty('message');
      expect(JSON.stringify(result.error)).not.toContain(providerDescription);
      expect(JSON.stringify(result.error)).not.toContain(renderedCleverValue);
      expect(suiExecutionErrorMessage(result.error)).toBe('Sui execution failed (MoveAbort)');
    }
  });

  it('accepts the current empty clever-error value and rejects opposing protobuf payloads', () => {
    const rawAbort = executedTransaction({
      effects: {
        version: 2,
        transactionDigest: DIGEST,
        status: {
          success: false,
          error: {
            description: 'display only',
            command: 0n,
            kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
            errorDetails: {
              oneofKind: 'abort',
              abort: {
                abortCode: 7n,
                cleverError: {
                  constantName: 'ETooSmall',
                  value: { oneofKind: undefined },
                },
              },
            },
          },
        },
        gasUsed: {
          computationCost: 1n,
          storageCost: 2n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });

    expect(parseRawSuiSimulationTransaction(rawAbort, DIGEST)).toMatchObject({
      outcome: 'failure',
      error: {
        kind: 'MoveAbort',
        moveAbort: { abortCode: '7', constantName: 'ETooSmall' },
      },
    });

    const opposing = structuredClone(rawAbort);
    const opposingDetails = opposing.effects?.status?.error?.errorDetails;
    if (!opposingDetails) throw new Error('test fixture requires execution-error details');
    Object.assign(opposingDetails, {
      sizeError: { size: 1n, maxSize: 2n },
    });
    expect(() => parseRawSuiSimulationTransaction(opposing, DIGEST)).toThrow(
      'opposing sizeError payload',
    );

    const malformedCleverError = structuredClone(rawAbort);
    const malformedAbort =
      malformedCleverError.effects?.status?.error?.errorDetails?.oneofKind === 'abort'
        ? malformedCleverError.effects.status.error.errorDetails.abort
        : undefined;
    if (!malformedAbort) throw new Error('test fixture requires MoveAbort details');
    malformedAbort.cleverError = 'not-a-clever-error' as never;
    expect(() => parseRawSuiSimulationTransaction(malformedCleverError, DIGEST)).toThrow(
      'simulation.transaction.effects.status.error.errorDetails.abort.cleverError: expected an object',
    );
  });

  it('rejects consumed Move abort and gas values outside the protobuf u64 range', () => {
    const overU64 = 1n << 64n;
    const rawAbort = executedTransaction({
      effects: {
        version: 2,
        transactionDigest: DIGEST,
        status: {
          success: false,
          error: {
            kind: GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT,
            errorDetails: {
              oneofKind: 'abort',
              abort: { abortCode: overU64 },
            },
          },
        },
        gasUsed: {
          computationCost: 1n,
          storageCost: 2n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });
    expect(() => parseRawSuiSimulationTransaction(rawAbort, DIGEST)).toThrow(
      'abort.abortCode: expected a current protobuf u64',
    );

    const rawGas = executedTransaction({
      effects: {
        version: 2,
        transactionDigest: DIGEST,
        status: { success: true },
        gasUsed: {
          computationCost: overU64,
          storageCost: 2n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });
    expect(() => parseRawSuiSimulationTransaction(rawGas, DIGEST)).toThrow(
      'gasUsed.computationCost: expected a current protobuf u64',
    );
  });

  it('binds normalized execution-error identity to the raw kind and detail tag', () => {
    const rawFailure = (kind: number, errorDetails: object) =>
      executedTransaction({
        effects: {
          version: 2,
          transactionDigest: DIGEST,
          status: {
            success: false,
            error: { description: 'display only', kind, errorDetails: errorDetails as never },
          },
          gasUsed: {
            computationCost: 1n,
            storageCost: 2n,
            storageRebate: 0n,
            nonRefundableStorageFee: 0n,
          },
        },
      });

    expect(
      parseRawSuiSimulationTransaction(
        rawFailure(GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS, {
          oneofKind: undefined,
        }),
        DIGEST,
      ),
    ).toMatchObject({ outcome: 'failure', error: { kind: 'InsufficientGas' } });

    expect(
      parseRawSuiSimulationTransaction(
        rawFailure(GrpcTypes.ExecutionError_ExecutionErrorKind.COMMAND_ARGUMENT_ERROR, {
          oneofKind: 'commandArgumentError',
          commandArgumentError: {
            argument: 0,
            kind: GrpcTypes.CommandArgumentError_CommandArgumentErrorKind
              .INVALID_REFERENCE_ARGUMENT,
          },
        }),
        DIGEST,
      ),
    ).toMatchObject({ outcome: 'failure', error: { kind: 'CommandArgumentError' } });

    expect(() =>
      parseRawSuiSimulationTransaction(
        rawFailure(GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT, {
          oneofKind: 'sizeError',
          sizeError: { size: 1n, maxSize: 2n },
        }),
        DIGEST,
      ),
    ).toThrow('execution-error kind disagrees with its payload');

    expect(() =>
      parseRawSuiSimulationTransaction(
        rawFailure(GrpcTypes.ExecutionError_ExecutionErrorKind.EXECUTION_ERROR_KIND_UNKNOWN, {
          oneofKind: undefined,
        }),
        DIGEST,
      ),
    ).toThrow('unknown current execution-error kind');

    expect(
      parseRawSuiSimulationTransaction(
        rawFailure(GrpcTypes.ExecutionError_ExecutionErrorKind.COMMAND_ARGUMENT_ERROR, {
          oneofKind: 'commandArgumentError',
          commandArgumentError: {
            argument: 'discarded',
            kind: GrpcTypes.CommandArgumentError_CommandArgumentErrorKind
              .COMMAND_ARGUMENT_ERROR_KIND_UNKNOWN,
          },
        }),
        DIGEST,
      ),
    ).toMatchObject({ outcome: 'failure', error: { kind: 'CommandArgumentError' } });
  });

  it('ignores provider fields outside returned transaction and command-result contracts', () => {
    const exactSuccess = executedTransaction({
      effects: {
        version: 2,
        transactionDigest: DIGEST,
        status: { success: true },
        gasUsed: {
          computationCost: 1n,
          storageCost: 2n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });

    expect(
      parseRawSuiSimulationTransaction({ ...exactSuccess, providerDetail: {} }, DIGEST),
    ).toMatchObject({ outcome: 'success' });

    const statusWithProviderDetail = structuredClone(exactSuccess);
    Object.assign(statusWithProviderDetail.effects!.status!, { providerDetail: 'success' });
    expect(parseRawSuiSimulationTransaction(statusWithProviderDetail, DIGEST)).toMatchObject({
      outcome: 'success',
    });

    expect(
      parseRawSuiCommandResults([{ returnValues: [], mutatedByRef: [], providerDetail: [] }]),
    ).toEqual([{ returnValues: [], mutatedReferences: [] }]);
  });

  it('binds simulation identity only to the nested TransactionData digest', () => {
    const simulation = executedTransaction({
      digest: 'not-a-consumed-digest',
      effects: {
        transactionDigest: 'not-a-consumed-digest',
        status: { success: true },
        gasUsed: {
          computationCost: 1n,
          storageCost: 2n,
          storageRebate: 0n,
          nonRefundableStorageFee: 0n,
        },
      },
    });

    expect(parseRawSuiSimulationTransaction(simulation, DIGEST)).toEqual({
      outcome: 'success',
      effects: {
        gasUsed: {
          computationCost: '1',
          storageCost: '2',
          storageRebate: '0',
          nonRefundableStorageFee: '0',
        },
      },
    });

    const missing = structuredClone(simulation);
    delete missing.transaction;
    expect(() => parseRawSuiSimulationTransaction(missing, DIGEST)).toThrow(
      'simulation.transaction.transaction: expected an object',
    );

    const different = structuredClone(simulation);
    different.transaction!.digest = 'CesHefDJFsgXEipkQmK6zbmWvicG5YLtAKqwZBYN4J6';
    expect(() => parseRawSuiSimulationTransaction(different, DIGEST)).toThrow(
      'simulation.transaction.transaction.digest: does not match the request',
    );
  });
});
