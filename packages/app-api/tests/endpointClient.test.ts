import { describe, expect, it } from 'vitest';
import {
  createQualifiedSuiRpcAdminSnapshot,
  createSuiRpcEndpointClient,
} from '../src/sui/endpointClient.js';

describe('createSuiRpcEndpointClient', () => {
  it('pins one client to one immutable endpoint configuration', () => {
    const endpoint = createSuiRpcEndpointClient('testnet', {
      baseUrl: 'https://rpc.example.test/provider/grpc',
      meta: { 'x-token': 'secret', 'x-scope': ['read', 'simulate'] },
    });

    expect(endpoint.client.network).toBe('testnet');
    expect(endpoint.endpoint).toEqual({
      baseUrl: 'https://rpc.example.test/provider/grpc',
      meta: { 'x-token': 'secret', 'x-scope': ['read', 'simulate'] },
    });
  });

  it('copies and freezes endpoint metadata instead of retaining mutable config', () => {
    const scopes = ['read'];
    const meta = { 'x-scope': scopes };
    const endpoint = createSuiRpcEndpointClient('testnet', {
      baseUrl: 'https://rpc.example.test',
      meta,
    });

    scopes.push('write');
    meta['x-scope'] = ['changed'];
    expect(endpoint.endpoint).toEqual({
      baseUrl: 'https://rpc.example.test',
      meta: { 'x-scope': ['read'] },
    });
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(Object.isFrozen(endpoint.endpoint)).toBe(true);
    expect(Object.isFrozen(endpoint.endpoint.meta)).toBe(true);
    expect(Object.isFrozen(endpoint.endpoint.meta?.['x-scope'])).toBe(true);
  });

  it('preserves a canonical provider path and rejects unusable transport input', () => {
    const endpoint = createSuiRpcEndpointClient('testnet', {
      baseUrl: 'HTTPS://RPC.EXAMPLE.TEST:443/provider/grpc/',
      meta: { Authorization: 'secret' },
    });
    expect(endpoint.endpoint).toEqual({
      baseUrl: 'https://rpc.example.test/provider/grpc',
      meta: { authorization: 'secret' },
    });

    expect(() =>
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test/#fragment',
      }),
    ).toThrow('must not contain a fragment');
    expect(() =>
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test/?token=secret',
      }),
    ).toThrow('must not contain a query');
    expect(() =>
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test\n',
      }),
    ).toThrow('HTTP(S) URL');
    expect(() =>
      createSuiRpcEndpointClient('testnet', {
        baseUrl: ' https://rpc.example.test ',
      }),
    ).toThrow('HTTP(S) URL');
    expect(() =>
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test',
        meta: { Authorization: 'first', authorization: 'second' },
      }),
    ).toThrow('more than once');
  });

  it('preserves valid magic header names without an object prototype', () => {
    const meta = JSON.parse('{"__proto__":"secret"}') as Record<string, string>;
    const endpoint = createSuiRpcEndpointClient('testnet', {
      baseUrl: 'https://rpc.example.test',
      meta,
    });

    expect(Object.getPrototypeOf(endpoint.endpoint.meta)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(endpoint.endpoint.meta, '__proto__')).toBe(true);
    expect(endpoint.endpoint.meta?.['__proto__']).toBe('secret');
  });

  it('rejects every ASCII control range in metadata values', () => {
    for (const value of [
      'prefix\u0000suffix',
      'prefix\tsuffix',
      'prefix\u001fsuffix',
      'prefix\u007fsuffix',
    ]) {
      expect(() =>
        createSuiRpcEndpointClient('testnet', {
          baseUrl: 'https://rpc.example.test',
          meta: { 'x-token': value },
        }),
      ).toThrow('invalid value');
    }
  });
});

describe('createQualifiedSuiRpcAdminSnapshot', () => {
  it('returns only immutable, redacted, accepted endpoints in order', () => {
    const accepted = [
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test/private/provider-path',
        meta: { authorization: 'secret' },
      }),
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://secondary.example.test/tenant/grpc',
      }),
    ];

    const snapshot = createQualifiedSuiRpcAdminSnapshot(accepted);

    expect(snapshot).toEqual({
      endpoints: [
        {
          origin: 'https://rpc.example.test',
          role: 'primary',
        },
        {
          origin: 'https://secondary.example.test',
          role: 'secondary',
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.endpoints)).toBe(true);
    expect(snapshot.endpoints.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|provider-path|tenant\/grpc/);
  });

  it('rejects an empty accepted endpoint set', () => {
    expect(() => createQualifiedSuiRpcAdminSnapshot([])).toThrow('at least one endpoint');
  });

  it('does not treat a redacted public origin as private endpoint identity', () => {
    const snapshot = createQualifiedSuiRpcAdminSnapshot([
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test/first/grpc',
      }),
      createSuiRpcEndpointClient('testnet', {
        baseUrl: 'https://rpc.example.test/second/grpc',
      }),
    ]);
    expect(snapshot).toEqual({
      endpoints: [
        { origin: 'https://rpc.example.test', role: 'primary' },
        { origin: 'https://rpc.example.test', role: 'secondary' },
      ],
    });
  });
});
