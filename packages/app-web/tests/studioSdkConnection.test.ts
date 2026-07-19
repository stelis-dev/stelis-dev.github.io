import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, pinnedPackageId } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  pinnedPackageId: `0x${'11'.repeat(32)}`,
}));

vi.mock('@stelis/sdk', () => ({
  StelisSDK: { connect: connectMock },
  STELIS_CONTRACT_IDS: { testnet: { packageId: pinnedPackageId } },
}));

vi.mock('../src/AppConfigContext', () => ({
  useAppConfig: () => ({
    config: { network: 'testnet' },
    loading: false,
    error: null,
  }),
}));

import { ConnectionPanel } from '../src/pages/promotion/components/ConnectionPanel';
import { useStudioSDK } from '../src/pages/promotion/hooks/useStudioSDK';

type Connect = (endpoint: string) => Promise<void>;

function ConnectionHarness({ capture }: { capture: (connect: Connect) => void }) {
  const { connect } = useStudioSDK();
  useEffect(() => capture(connect), [capture, connect]);
  return null;
}

describe('Studio page Host connection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    connectMock.mockReset().mockResolvedValue({});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('connects with package pinning and no client-side Studio switch', async () => {
    let connect: Connect | undefined;
    const capture = (current: Connect) => {
      connect = current;
    };

    await act(async () => {
      root.render(createElement(ConnectionHarness, { capture }));
    });
    expect(connect).toBeDefined();

    await act(async () => {
      await connect!('https://host.example/relay///');
    });

    expect(connectMock).toHaveBeenCalledWith('https://host.example/relay', {
      pinnedPackageId,
    });
  });

  it('describes Host-owned Studio availability without a client-side flag', () => {
    const markup = renderToStaticMarkup(
      createElement(ConnectionPanel, {
        endpoint: '',
        connected: false,
        connecting: false,
        error: null,
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
      }),
    );

    expect(markup).toContain('STUDIO_UNAVAILABLE');
  });
});
