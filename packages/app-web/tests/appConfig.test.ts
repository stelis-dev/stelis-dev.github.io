import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigProvider, useAppConfig } from '../src/AppConfigContext';
import { RELAY_API_BASE } from '../src/relayApiEndpoint';
import { getSuiRpcUrl } from '../src/suiRpc';

function ConfigState() {
  const state = useAppConfig();
  return createElement('output', { 'data-testid': 'config-state' }, JSON.stringify(state));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AppConfigProvider', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderProvider(children: ReactNode = createElement(ConfigState)) {
    await act(async () => {
      root.render(createElement(AppConfigProvider, null, children));
    });
  }

  it('loads and exposes the current Relay config through the SDK wire parser', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        network: 'testnet',
        packageId: `0x${'11'.repeat(32)}`,
        settlementPayoutRecipient: `0x${'22'.repeat(32)}`,
        supportedSettlementSwapPaths: [],
        quotedHostFeeMist: '1000',
        protocolFlatFeeMist: '100',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderProvider();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${RELAY_API_BASE}/config`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(JSON.parse(container.textContent ?? '')).toEqual({
      config: { network: 'testnet' },
      loading: false,
      error: null,
    });
  });

  it('exposes an HTTP failure instead of inventing config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'unavailable' }, 503)));

    await renderProvider();

    expect(JSON.parse(container.textContent ?? '')).toEqual({
      config: null,
      loading: false,
      error: '/relay/config returned 503',
    });
  });

  it('rejects a malformed current config instead of accepting a partial shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ network: 'testnet' })));

    await renderProvider();

    const state = JSON.parse(container.textContent ?? '') as {
      config: unknown;
      loading: boolean;
      error: string;
    };
    expect(state.config).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toMatch(/supportedSettlementSwapPaths/);
  });
});

describe('Sui RPC selection', () => {
  it('maps the Host-reported network to the matching fullnode', () => {
    expect(getSuiRpcUrl('testnet')).toBe('https://fullnode.testnet.sui.io:443');
    expect(getSuiRpcUrl('mainnet')).toBe('https://fullnode.mainnet.sui.io:443');
  });
});
