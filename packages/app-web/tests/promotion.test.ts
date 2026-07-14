import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';

describe('promotion product surface', () => {
  it('exports the current page and hook', async () => {
    const page = await import('../src/pages/promotion');
    const hook = await import('../src/pages/promotion/hooks/useStudioSDK');

    expect(page.PromotionPage).toBeDefined();
    expect(page.default).toBe(page.PromotionPage);
    expect(typeof hook.useStudioSDK).toBe('function');
  });

  it('exports the current promotion components', async () => {
    const [connection, jwt, debug, execution] = await Promise.all([
      import('../src/pages/promotion/components/ConnectionPanel'),
      import('../src/pages/promotion/components/DeveloperJwtPanel'),
      import('../src/pages/promotion/components/DebugPanel'),
      import('../src/pages/promotion/components/StudioExecutionPanel'),
    ]);

    expect(connection.ConnectionPanel).toBeDefined();
    expect(jwt.DeveloperJwtPanel).toBeDefined();
    expect(debug.DebugPanel).toBeDefined();
    expect(execution.StudioExecutionPanel).toBeDefined();
  });
});

describe('Studio test transaction target policy', () => {
  it('builds exactly the MoveCall targets shown as the required Host configuration', async () => {
    const {
      buildStudioTestTransaction,
      STUDIO_TEST_ALLOWED_TARGETS_CONFIG,
      STUDIO_TEST_MOVECALL_TARGETS,
    } = await import('../src/pages/promotion/components/StudioExecutionPanel');

    const { tx, moveCallTargets } = buildStudioTestTransaction();
    const kindBytes = await tx.build({ onlyTransactionKind: true });
    const commands = Transaction.fromKind(kindBytes).getData().commands as Array<{
      $kind: string;
      MoveCall?: { package: string; module: string; function: string };
    }>;

    expect(moveCallTargets).toBe(STUDIO_TEST_MOVECALL_TARGETS);
    expect(commands).toHaveLength(STUDIO_TEST_MOVECALL_TARGETS.length);
    expect(commands.map((command) => command.$kind)).toEqual(['MoveCall', 'MoveCall']);
    expect(
      commands.map((command) => ({
        package: normalizeSuiAddress(command.MoveCall!.package),
        module: command.MoveCall!.module,
        function: command.MoveCall!.function,
      })),
    ).toEqual(
      STUDIO_TEST_MOVECALL_TARGETS.map((target) => {
        const [packageId, module, fn] = target.split('::');
        return { package: normalizeSuiAddress(packageId), module, function: fn };
      }),
    );
    expect(STUDIO_TEST_ALLOWED_TARGETS_CONFIG).toBe(STUDIO_TEST_MOVECALL_TARGETS.join(','));
  });
});
