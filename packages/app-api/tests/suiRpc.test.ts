/**
 * Sui RPC endpoint configuration tests.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { parseEndpointConfigJson, loadRpcConfig } from '../src/sui/parseEndpointConfig.js';

function rpcConfigJson(
  testnet: unknown,
  mainnet: unknown = [{ baseUrl: 'https://mainnet.example' }],
): string {
  return JSON.stringify({ testnet, mainnet });
}

function parseTestnetRpcConfig(
  testnet: unknown,
  envLookup: (name: string) => string | undefined = () => undefined,
) {
  return parseEndpointConfigJson(rpcConfigJson(testnet), 'testnet', envLookup);
}

// ── loadRpcConfig ───────────────────────────────────────────────────────────

describe('loadRpcConfig', () => {
  it('loads endpoints from a JSON file', () => {
    const path = '/tmp/test-rpc-load.json';
    writeFileSync(
      path,
      rpcConfigJson([{ baseUrl: 'https://a.com' }, { baseUrl: 'https://b.com' }]),
    );
    try {
      const result = loadRpcConfig('testnet', path, () => undefined);
      expect(result).toEqual([{ baseUrl: 'https://a.com' }, { baseUrl: 'https://b.com' }]);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws on missing file with guidance', () => {
    expect(() => loadRpcConfig('testnet', '/tmp/nonexistent-rpc.json', () => undefined)).toThrow(
      'tracked packages/app-api/rpc.json',
    );
  });

  it('resolves auth.valueEnv from env lookup', () => {
    const path = '/tmp/test-rpc-auth.json';
    writeFileSync(
      path,
      rpcConfigJson([
        { baseUrl: 'https://a.com', auth: { header: 'x-token', valueEnv: 'TEST_TOK' } },
      ]),
    );
    try {
      const result = loadRpcConfig('testnet', path, (name) =>
        name === 'TEST_TOK' ? 'secret' : undefined,
      );
      expect(result[0].meta).toEqual({ 'x-token': 'secret' });
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error (not env error) on malformed JSON', () => {
    const path = '/tmp/test-rpc-malformed.json';
    writeFileSync(path, '{bad json');
    try {
      expect(() => loadRpcConfig('testnet', path, () => undefined)).toThrow('rpc.json');
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error on empty selected network endpoints', () => {
    const path = '/tmp/test-rpc-empty.json';
    writeFileSync(path, rpcConfigJson([]));
    try {
      expect(() => loadRpcConfig('testnet', path, () => undefined)).toThrow(
        'at least one endpoint',
      );
    } finally {
      unlinkSync(path);
    }
  });

  it('throws rpc.json error on flat-array JSON', () => {
    const path = '/tmp/test-rpc-flat-array.json';
    writeFileSync(path, '[{"baseUrl":"https://a.com"}]');
    try {
      expect(() => loadRpcConfig('testnet', path, () => undefined)).toThrow('object');
    } finally {
      unlinkSync(path);
    }
  });
});

// ── parseEndpointConfigJson ─────────────────────────────────────────────────

describe('parseEndpointConfigJson', () => {
  it('parses the selected network endpoint section', () => {
    const result = parseEndpointConfigJson(
      rpcConfigJson([{ baseUrl: 'https://testnet-a.com' }], [{ baseUrl: 'https://mainnet-a.com' }]),
      'mainnet',
      () => undefined,
    );
    expect(result).toEqual([{ baseUrl: 'https://mainnet-a.com' }]);
  });

  it('parses multiple endpoints from the selected network section', () => {
    const result = parseTestnetRpcConfig([
      { baseUrl: 'https://a.com' },
      { baseUrl: 'https://b.com' },
    ]);
    expect(result).toEqual([{ baseUrl: 'https://a.com' }, { baseUrl: 'https://b.com' }]);
  });

  it('resolves auth env indirection', () => {
    const result = parseTestnetRpcConfig(
      [{ baseUrl: 'https://a.com', auth: { header: 'x-token', valueEnv: 'MY_TOKEN' } }],
      (name) => (name === 'MY_TOKEN' ? 'secret123' : undefined),
    );
    expect(result).toEqual([{ baseUrl: 'https://a.com', meta: { 'x-token': 'secret123' } }]);
  });

  it('resolves auth with prefix', () => {
    const result = parseTestnetRpcConfig(
      [
        {
          baseUrl: 'https://a.com',
          auth: { header: 'Authorization', valueEnv: 'MY_TOKEN', prefix: 'Bearer ' },
        },
      ],
      (name) => (name === 'MY_TOKEN' ? 'abc' : undefined),
    );
    expect(result[0].meta).toEqual({ authorization: 'Bearer abc' });
  });

  it('throws on missing auth env', () => {
    expect(() =>
      parseTestnetRpcConfig(
        [{ baseUrl: 'https://a.com', auth: { header: 'x-token', valueEnv: 'MISSING' } }],
        () => undefined,
      ),
    ).toThrow('MISSING');
  });

  it('throws on non-string auth.prefix', () => {
    expect(() =>
      parseTestnetRpcConfig(
        [{ baseUrl: 'https://a.com', auth: { header: 'x-token', valueEnv: 'T', prefix: 123 } }],
        (name) => (name === 'T' ? 'tok' : undefined),
      ),
    ).toThrow('auth.prefix');
  });

  it('rejects unknown endpoint and auth fields', () => {
    expect(() => parseTestnetRpcConfig([{ baseUrl: 'https://a.com', timeoutMs: 1000 }])).toThrow(
      'unsupported field "timeoutMs"',
    );
    expect(() =>
      parseTestnetRpcConfig(
        [
          {
            baseUrl: 'https://a.com',
            auth: { header: 'x-token', valueEnv: 'T', legacyToken: true },
          },
        ],
        (name) => (name === 'T' ? 'tok' : undefined),
      ),
    ).toThrow('unsupported field "legacyToken"');
  });

  it('allows only env-indirected auth metadata in tracked endpoint config', () => {
    expect(() =>
      parseTestnetRpcConfig([{ baseUrl: 'https://a.com', meta: { 'x-token': 'tracked-secret' } }]),
    ).toThrow('unsupported field "meta"');

    const [authEndpoint] = parseTestnetRpcConfig(
      [{ baseUrl: 'https://b.com', auth: { header: '__proto__', valueEnv: 'T' } }],
      (name) => (name === 'T' ? 'auth-secret' : undefined),
    );
    expect(Object.getPrototypeOf(authEndpoint.meta)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(authEndpoint.meta, '__proto__')).toBe(true);
    expect(authEndpoint.meta?.['__proto__']).toBe('auth-secret');
  });

  it('canonicalizes full base URL identity and rejects only equivalent endpoints', () => {
    const result = parseTestnetRpcConfig([{ baseUrl: 'HTTPS://A.COM:443/provider/grpc/' }]);
    expect(result).toEqual([{ baseUrl: 'https://a.com/provider/grpc' }]);

    expect(() =>
      parseTestnetRpcConfig([
        { baseUrl: 'https://A.com:443/rpc///' },
        { baseUrl: 'https://a.com/rpc' },
      ]),
    ).toThrow('duplicates an existing Sui RPC endpoint');
    expect(
      parseTestnetRpcConfig([
        { baseUrl: 'https://a.com/first' },
        { baseUrl: 'https://a.com/second' },
      ]),
    ).toEqual([{ baseUrl: 'https://a.com/first' }, { baseUrl: 'https://a.com/second' }]);
    expect(() => parseTestnetRpcConfig([{ baseUrl: ' https://a.com ' }])).toThrow('HTTP(S) URL');
  });

  it('accepts only an exact environment-variable identity for auth', () => {
    for (const valueEnv of ['lowercase', ' LEADING_SPACE', 'BAD-NAME', 'BAD\nNAME']) {
      expect(() =>
        parseTestnetRpcConfig(
          [{ baseUrl: 'https://a.com', auth: { header: 'x-token', valueEnv } }],
          () => 'secret',
        ),
      ).toThrow('uppercase environment variable name');
    }
  });

  it('throws on empty JSON', () => {
    expect(() => parseEndpointConfigJson('', 'testnet', () => undefined)).toThrow(
      'must not be empty',
    );
  });

  it('throws on invalid JSON', () => {
    expect(() => parseEndpointConfigJson('{bad', 'testnet', () => undefined)).toThrow(
      'not valid JSON',
    );
  });

  it('throws on old flat-array JSON', () => {
    expect(() =>
      parseEndpointConfigJson('[{"baseUrl":"https://a.com"}]', 'testnet', () => undefined),
    ).toThrow('object');
  });

  it('throws on missing network section', () => {
    expect(() =>
      parseEndpointConfigJson(
        JSON.stringify({ mainnet: [{ baseUrl: 'https://mainnet.com' }] }),
        'testnet',
        () => undefined,
      ),
    ).toThrow('testnet');
  });

  it('throws on unsupported network section', () => {
    expect(() =>
      parseEndpointConfigJson(
        JSON.stringify({
          testnet: [{ baseUrl: 'https://a.com' }],
          mainnet: [{ baseUrl: 'https://b.com' }],
          devnet: [{ baseUrl: 'https://c.com' }],
        }),
        'testnet',
        () => undefined,
      ),
    ).toThrow('unsupported network section');
  });

  it('throws on empty selected network endpoints', () => {
    expect(() => parseEndpointConfigJson(rpcConfigJson([]), 'testnet', () => undefined)).toThrow(
      'testnet',
    );
  });

  it('throws on missing baseUrl', () => {
    expect(() => parseTestnetRpcConfig([{}])).toThrow('baseUrl');
  });

  it('does not echo invalid raw URL values in parser errors', () => {
    expect(() => parseTestnetRpcConfig([{ baseUrl: 'not a url with secret-token' }])).toThrow(
      '[INVALID_URL]',
    );
    try {
      parseTestnetRpcConfig([{ baseUrl: 'not a url with secret-token' }]);
    } catch (err) {
      expect(String(err)).not.toContain('secret-token');
    }
  });

  it('throws on URL with embedded credentials in JSON config', () => {
    expect(() => parseTestnetRpcConfig([{ baseUrl: 'https://user:secret@provider.com' }])).toThrow(
      'embedded credentials',
    );
  });

  it('preserves provider paths while rejecting components the transport cannot address', () => {
    expect(parseTestnetRpcConfig([{ baseUrl: 'https://provider.example/tenant/grpc/' }])).toEqual([
      { baseUrl: 'https://provider.example/tenant/grpc' },
    ]);
    expect(() => parseTestnetRpcConfig([{ baseUrl: 'https://provider.example/#secret' }])).toThrow(
      'must not contain a fragment',
    );
    expect(() =>
      parseTestnetRpcConfig([{ baseUrl: 'https://provider.example/?token=tracked-secret' }]),
    ).toThrow('must not contain a query');
    expect(() =>
      parseTestnetRpcConfig(
        [
          {
            baseUrl: 'https://provider.example',
            auth: { header: 'authorization', valueEnv: 'T', prefix: 'Bearer\t' },
          },
        ],
        () => 'secret',
      ),
    ).toThrow('invalid value');
  });

  it('rejects authenticated HTTP endpoints', () => {
    expect(() =>
      parseTestnetRpcConfig(
        [
          {
            baseUrl: 'http://127.0.0.1:9000',
            localDevelopmentEndpoint: true,
            auth: { header: 'x-token', valueEnv: 'MY_TOKEN' },
          },
        ],
        (name) => (name === 'MY_TOKEN' ? 'secret' : undefined),
      ),
    ).toThrow('HTTP RPC endpoints');
  });

  it('rejects static metadata as a non-current endpoint field', () => {
    expect(() =>
      parseTestnetRpcConfig([
        {
          baseUrl: 'http://127.0.0.1:9000',
          localDevelopmentEndpoint: true,
          meta: { 'x-token': 'secret' },
        },
      ]),
    ).toThrow('unsupported field "meta"');
  });

  it('rejects non-local HTTP endpoints even when local mode is explicit', () => {
    expect(() =>
      parseTestnetRpcConfig([
        { baseUrl: 'http://provider.example', localDevelopmentEndpoint: true },
      ]),
    ).toThrow('localhost');
  });

  it('rejects HTTP endpoints unless local mode is explicit', () => {
    expect(() => parseTestnetRpcConfig([{ baseUrl: 'http://127.0.0.1:9000' }])).toThrow(
      'localDevelopmentEndpoint',
    );
  });

  it('accepts unauthenticated local HTTP only when local mode is explicit', () => {
    const result = parseTestnetRpcConfig([
      { baseUrl: 'http://127.0.0.1:9000/local/grpc', localDevelopmentEndpoint: true },
    ]);
    expect(result).toEqual([{ baseUrl: 'http://127.0.0.1:9000/local/grpc' }]);
  });

  it('rejects the local-only flag on HTTPS endpoints', () => {
    expect(() =>
      parseTestnetRpcConfig([{ baseUrl: 'https://a.com', localDevelopmentEndpoint: true }]),
    ).toThrow('valid only for local HTTP');
  });

  it('throws on null array element', () => {
    expect(() => parseTestnetRpcConfig([null])).toThrow('must be a non-null object');
  });

  it('throws on primitive array element', () => {
    expect(() => parseTestnetRpcConfig([42])).toThrow('must be a non-null object');
  });

  it('throws on string array element', () => {
    expect(() => parseTestnetRpcConfig(['https://a.com'])).toThrow('must be a non-null object');
  });

  it('rejects the unused fetchInit compatibility surface', () => {
    expect(() =>
      parseTestnetRpcConfig([{ baseUrl: 'https://a.com', fetchInit: { credentials: 'include' } }]),
    ).toThrow('unsupported field "fetchInit"');
  });
});
