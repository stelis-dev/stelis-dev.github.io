/**
 * Convert Sui SDK transaction commands to core-relay PtbCommand format.
 *
 * Accepts the exact current SDK command union from
 * Transaction.getData().commands and normalizes to PtbCommand[].
 *
 * Used by:
 *   - core-api (server-side structure and settlement-argument validation)
 *   - SDK integrity.ts (client-side S-16 verification)
 */
import type { PtbCommand } from '@stelis/contracts';
import { parseSuiCommands } from './sui/suiTransactionShape.js';

export function convertSdkCommands(commands: unknown[]): PtbCommand[] {
  return parseSuiCommands(commands).map((command) => {
    const current = command as unknown as Record<string, unknown>;
    const kind = command.$kind;

    if (kind === 'MoveCall') {
      const moveCall = command.MoveCall;
      return {
        kind: 'MoveCall' as const,
        packageId: moveCall.package,
        module: moveCall.module,
        function: moveCall.function,
        typeArguments: [...moveCall.typeArguments],
        arguments: [...moveCall.arguments],
      };
    }

    // Preserve the exact current non-MoveCall payload so the sponsor GasCoin
    // guard can recursively inspect every argument reference.
    return {
      kind,
      arguments: [current[kind]],
    };
  });
}
