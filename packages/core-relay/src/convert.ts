/**
 * Convert Sui SDK transaction commands to core-relay PtbCommand format.
 *
 * Pure TS — no @mysten/sui dependency. Accepts unknown[] from
 * Transaction.getData().commands and normalizes to PtbCommand[].
 *
 * Used by:
 *   - core-api (server-side structure and settlement-argument validation)
 *   - SDK integrity.ts (client-side S-16 verification)
 */
import type { PtbCommand } from '@stelis/contracts';

export function convertSdkCommands(commands: unknown[]): PtbCommand[] {
  return commands.map((cmd) => {
    const c = cmd as Record<string, unknown>;
    const kind = (c.$kind as string) ?? 'Unknown';

    if (kind === 'MoveCall' && c.MoveCall) {
      const mc = c.MoveCall as Record<string, unknown>;
      return {
        kind: 'MoveCall' as const,
        packageId: mc.package as string,
        module: mc.module as string,
        function: mc.function as string,
        typeArguments: Array.isArray(mc.typeArguments) ? mc.typeArguments : [],
        arguments: Array.isArray(mc.arguments) ? mc.arguments : [],
      };
    }

    // non-MoveCall (TransferObjects, SplitCoins, etc.):
    // Wrap the payload in an array so containsGasCoinReference() can
    // recursively scan for GasCoin references (S-15 defense).
    const payload = c[kind];
    return {
      kind,
      arguments: payload !== undefined ? [payload] : [],
    };
  });
}
