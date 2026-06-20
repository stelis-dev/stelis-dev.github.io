/**
 * AppConfigContext bootstrap tests — validates the /relay/config
 * fetch path: success, error, and invalid-network paths.
 *
 * Uses source-level validation (no React rendering needed — existing
 * app-web tests use this pattern). Tests verify the contract between
 * AppConfigContext and the /relay/config API.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ctxSrc = fs.readFileSync(path.resolve(__dirname, '../src/AppConfigContext.tsx'), 'utf-8');

describe('AppConfigContext bootstrap contract', () => {
  it('fetches from RELAY_API_BASE/config', () => {
    expect(ctxSrc).toContain('`${RELAY_API_BASE}/config`');
  });

  it('validates network against testnet and mainnet only', () => {
    expect(ctxSrc).toContain("'testnet'");
    expect(ctxSrc).toContain("'mainnet'");
    expect(ctxSrc).toContain('isValidNetwork');
  });

  it('does NOT reference VITE_NETWORK', () => {
    expect(ctxSrc).not.toContain('VITE_NETWORK');
    expect(ctxSrc).not.toContain('import.meta.env');
  });

  it('exposes loading state', () => {
    expect(ctxSrc).toContain('loading: true');
    expect(ctxSrc).toContain('loading: false');
  });

  it('exposes error state on fetch failure', () => {
    expect(ctxSrc).toContain('.catch(');
    expect(ctxSrc).toContain('error:');
  });

  it('uses 10s timeout for resilience', () => {
    expect(ctxSrc).toContain('AbortSignal.timeout(10_000)');
  });

  it('imports from relayApiEndpoint, not runtimeEnv', () => {
    expect(ctxSrc).toContain("from './relayApiEndpoint'");
    expect(ctxSrc).not.toContain("from './runtimeEnv'");
  });
});

describe('runtimeEnv keeps network-derived values out of build env', () => {
  const runtimeSrc = fs.readFileSync(path.resolve(__dirname, '../src/runtimeEnv.ts'), 'utf-8');
  const suiRpcSrc = fs.readFileSync(path.resolve(__dirname, '../src/suiRpc.ts'), 'utf-8');

  it('does NOT export APP_WEB_NETWORK', () => {
    expect(runtimeSrc).not.toContain('APP_WEB_NETWORK');
  });

  it('does NOT reference VITE_NETWORK', () => {
    expect(runtimeSrc).not.toContain('VITE_NETWORK');
  });

  it('does NOT reference VITE_SUI_RPC_URL', () => {
    expect(runtimeSrc).not.toContain('VITE_SUI_RPC_URL');
  });

  it('still exports APP_WEB_RELAY_API_BASE', () => {
    expect(runtimeSrc).toContain('export const APP_WEB_RELAY_API_BASE');
  });

  it('maps Sui RPC endpoints from the API-reported network', () => {
    expect(suiRpcSrc).toContain('https://fullnode.testnet.sui.io:443');
    expect(suiRpcSrc).toContain('https://fullnode.mainnet.sui.io:443');
    expect(suiRpcSrc).toContain('AppWebNetwork');
  });
});

describe('NetworkBadge uses AppConfigContext, not independent fetch', () => {
  const badgeSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/components/NetworkBadge.tsx'),
    'utf-8',
  );

  it('imports useAppConfig', () => {
    expect(badgeSrc).toContain('useAppConfig');
  });

  it('does NOT fetch /relay/config independently', () => {
    expect(badgeSrc).not.toContain('fetch(');
    expect(badgeSrc).not.toContain('RELAY_API_BASE');
  });
});

describe('useSDK singleton dedup', () => {
  const sdkSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/pages/sandbox/hooks/useSDK.ts'),
    'utf-8',
  );

  it('has module-level sdkCache for dedup', () => {
    expect(sdkSrc).toContain('sdkCache');
  });

  it('reuses existing promise from cache', () => {
    expect(sdkSrc).toContain('sdkCache.get(');
    expect(sdkSrc).toContain('sdkCache.set(');
  });

  it('clears cache entry on failure (allows retry)', () => {
    expect(sdkSrc).toContain('sdkCache.delete(');
  });
});

describe('ConfigGate is narrow (not app-wide)', () => {
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf-8');

  it('wraps Sandbox with ConfigGate', () => {
    expect(appSrc).toMatch(/<ConfigGate>\s*<Sandbox/);
  });

  it('wraps Promotion with ConfigGate', () => {
    expect(appSrc).toMatch(/<ConfigGate>\s*<Promotion/);
  });

  it('does NOT wrap Home with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Home/);
  });

  it('does NOT wrap Docs with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Docs/);
  });

  it('does NOT wrap Playground with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Playground/);
  });

  it('does NOT wrap Status with ConfigGate', () => {
    expect(appSrc).not.toMatch(/<ConfigGate>\s*<Status/);
  });
});

describe('Static hosting contract', () => {
  const viteConfigSrc = fs.readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf-8');
  const readmeSrc = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf-8');

  it('uses relative asset URLs for GitHub Pages project paths', () => {
    expect(viteConfigSrc).toContain("base: './'");
  });

  it('documents that app-web is the public sample-page target', () => {
    expect(readmeSrc).toContain('public sample-page deployment target');
    expect(readmeSrc).toContain('Do not publish `@stelis/app-admin` to GitHub Pages');
  });
});
