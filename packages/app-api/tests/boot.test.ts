import { describe, expect, it } from 'vitest';
import { resolveTrustedProxyHopsForBoot } from '../src/boot.js';

describe('resolveTrustedProxyHopsForBoot', () => {
  it('requires explicit TRUSTED_PROXY_HOPS outside local development runtimes', () => {
    expect(() =>
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: undefined,
        nodeEnv: 'production',
      }),
    ).toThrow(/TRUSTED_PROXY_HOPS must be set/);

    expect(() =>
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: undefined,
        nodeEnv: undefined,
      }),
    ).toThrow(/TRUSTED_PROXY_HOPS must be set/);
  });

  it('accepts explicit proxy-hop policy in deployed runtimes', () => {
    expect(
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: '0',
        nodeEnv: 'production',
      }),
    ).toBe(0);

    expect(
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: '2',
        nodeEnv: 'production',
      }),
    ).toBe(2);
  });

  it('allows implicit zero only in local development and test runtimes', () => {
    expect(
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: undefined,
        nodeEnv: 'development',
      }),
    ).toBe(0);

    expect(
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: undefined,
        nodeEnv: 'test',
      }),
    ).toBe(0);
  });

  it('rejects invalid hop configuration before runtime mode handling completes', () => {
    expect(() =>
      resolveTrustedProxyHopsForBoot({
        trustedProxyHops: '1e3',
        nodeEnv: 'test',
      }),
    ).toThrow(/TRUSTED_PROXY_HOPS must be a non-negative integer/);
  });
});
