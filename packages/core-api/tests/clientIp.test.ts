import { describe, expect, it } from 'vitest';
import {
  canonicalizeIpAddress,
  ClientIpResolutionError,
  parseTrustedProxyHops,
  resolveClientIp,
} from '../src/clientIp.js';

function headers(xForwardedFor?: string) {
  return {
    header(name: string) {
      if (name.toLowerCase() === 'x-forwarded-for') return xForwardedFor;
      return undefined;
    },
  };
}

describe('clientIp helper', () => {
  it('uses one canonical IPv6 identity without socket-local zone identifiers', () => {
    expect(canonicalizeIpAddress('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalizeIpAddress('fe80:0:0:0:0:0:0:1%lo0')).toBe('fe80::1');
    expect(canonicalizeIpAddress('fe80:0:0:0:0:0:0:1%en0')).toBe('fe80::1');
    expect(canonicalizeIpAddress(`fe80::1%${'z'.repeat(400)}`)).toBe('fe80::1');
    expect(
      resolveClientIp(headers(), {
        directIp: 'fe80:0:0:0:0:0:0:1%lo0',
        trustedProxyHops: 0,
      }),
    ).toBe('fe80::1');
  });

  it('uses the direct IP when no trusted proxy hops are configured', () => {
    expect(
      resolveClientIp(headers('198.51.100.10, 10.0.0.5'), {
        directIp: '127.0.0.1',
        trustedProxyHops: 0,
      }),
    ).toBe('127.0.0.1');
  });

  it('extracts the client from XFF by counting trusted hops from the right', () => {
    expect(
      resolveClientIp(headers('203.0.113.10, 10.0.0.5'), {
        trustedProxyHops: 1,
      }),
    ).toBe('203.0.113.10');

    expect(
      resolveClientIp(headers('203.0.113.10, 10.0.0.5, 10.0.0.9'), {
        trustedProxyHops: 2,
      }),
    ).toBe('203.0.113.10');

    expect(
      resolveClientIp(headers('fe80:0:0:0:0:0:0:1%proxy-zone, 10.0.0.5'), {
        trustedProxyHops: 1,
      }),
    ).toBe('fe80::1');
  });

  it('fails closed when no direct socket IP is available', () => {
    expect(() =>
      resolveClientIp(headers('198.51.100.10, 10.0.0.5'), {
        directIp: null,
        trustedProxyHops: 0,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('fails closed when the direct socket IP is invalid', () => {
    expect(() =>
      resolveClientIp(headers('198.51.100.10, 10.0.0.5'), {
        directIp: 'unknown',
        trustedProxyHops: 0,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('fails closed when XFF is missing under a trusted-proxy policy', () => {
    expect(() =>
      resolveClientIp(headers(), {
        trustedProxyHops: 1,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('fails closed when the XFF chain is shorter than the configured hop count', () => {
    expect(() =>
      resolveClientIp(headers('203.0.113.10'), {
        trustedProxyHops: 1,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('fails closed when the selected XFF client value is invalid', () => {
    expect(() =>
      resolveClientIp(headers('unknown, 10.0.0.5'), {
        trustedProxyHops: 1,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('fails closed instead of shifting XFF indexes around invalid chain entries', () => {
    expect(() =>
      resolveClientIp(headers('203.0.113.10, unknown, 10.0.0.5'), {
        trustedProxyHops: 1,
      }),
    ).toThrow(ClientIpResolutionError);
  });

  it('parses TRUSTED_PROXY_HOPS and defaults to zero when unset', () => {
    expect(parseTrustedProxyHops('2')).toBe(2);
    expect(parseTrustedProxyHops(undefined)).toBe(0);
  });

  it('rejects invalid hop configuration', () => {
    expect(() => parseTrustedProxyHops('-1')).toThrow(
      /TRUSTED_PROXY_HOPS must be a non-negative integer/,
    );
    expect(() => parseTrustedProxyHops('1e3')).toThrow(
      /TRUSTED_PROXY_HOPS must be a non-negative integer/,
    );
    expect(() => parseTrustedProxyHops('9007199254740993')).toThrow(
      /TRUSTED_PROXY_HOPS must be a non-negative integer/,
    );
  });
});
