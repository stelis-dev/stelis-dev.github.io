import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SETTLE_FUNCTIONS, SETTLE_MODULE } from '@stelis/contracts';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';

function isSettleCommand(command: PtbCommand, normalizedPackageId: string): boolean {
  if (command.kind !== 'MoveCall') return false;
  const moveCall = command as MoveCallCommand;
  return (
    normalizeSuiAddress(moveCall.packageId) === normalizedPackageId &&
    moveCall.module === SETTLE_MODULE &&
    SETTLE_FUNCTIONS.has(moveCall.function)
  );
}

export function findSettleCommand(
  commands: PtbCommand[],
  packageId: string,
): MoveCallCommand | undefined {
  const normalizedPkg = normalizeSuiAddress(packageId);
  for (const cmd of commands) {
    if (isSettleCommand(cmd, normalizedPkg)) return cmd as MoveCallCommand;
  }
  return undefined;
}

/**
 * Return the command index only when the transaction contains exactly one
 * compiled Stelis settlement call. Abort provenance consumers use this to
 * bind a MoveAbort occurrence to the Host settlement command instead of a
 * user-authored prefix command or external wrapper.
 */
export function findUniqueSettleCommandIndex(
  commands: readonly PtbCommand[],
  packageId: string,
): number | undefined {
  const normalizedPkg = normalizeSuiAddress(packageId);
  let found: number | undefined;

  for (let index = 0; index < commands.length; index++) {
    if (!isSettleCommand(commands[index]!, normalizedPkg)) continue;
    if (found !== undefined) return undefined;
    found = index;
  }

  return found;
}
