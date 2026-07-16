/**
 * Developer JWT Verifier — unit tests.
 *
 * Tests local verification against a single issuer with RS256.
 * Uses a test RSA keypair generated at module scope (not a hidden default —
 * the key value is irrelevant to the test assertions, only the math matters).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS,
  parseDeveloperJwtTrustConfig,
  verifyDeveloperJwt,
  type DeveloperJwtTrustConfig,
} from '../src/studio/developerJwtVerifier.js';

// ─────────────────────────────────────────────
// Test RSA keypair (Ed25519Keypair.generate() comment in AGENTS.md:
// "allowed only when the key value is irrelevant to the test assertion")
// ─────────────────────────────────────────────

const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const TEST_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY.export({ type: 'spki', format: 'pem' }) as string;
const TEST_PRIVATE_KEY_PEM = TEST_PRIVATE_KEY.export({ type: 'pkcs8', format: 'pem' }) as string;
const { publicKey: TEST_ES256_PUBLIC_KEY } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const TEST_ES256_PUBLIC_KEY_PEM = TEST_ES256_PUBLIC_KEY.export({
  type: 'spki',
  format: 'pem',
}) as string;
const { publicKey: TEST_P384_PUBLIC_KEY } = generateKeyPairSync('ec', {
  namedCurve: 'P-384',
});
const TEST_P384_PUBLIC_KEY_PEM = TEST_P384_PUBLIC_KEY.export({
  type: 'spki',
  format: 'pem',
}) as string;

/** A valid Sui address (66 hex chars with 0x prefix). */
const TEST_SUI_ADDRESS = '0x' + 'ab'.repeat(32);

const TRUST_CONFIG: DeveloperJwtTrustConfig = {
  issuer: 'https://auth.test-studio.example',
  audience: 'stelis-studio',
  algorithm: 'RS256',
  publicKeyPem: TEST_PUBLIC_KEY_PEM,
  claimPaths: {
    userId: 'sub',
    senderAddress: 'wallet_address',
  },
};

// ─────────────────────────────────────────────
// JWT signing helpers (test-only)
// ─────────────────────────────────────────────

function base64urlEncode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlEncodeString(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

function base64urlEncodeWithMalformedUtf8(prefix: string, suffix: string): string {
  return base64urlEncode(
    new Uint8Array([
      ...new TextEncoder().encode(prefix),
      0x80,
      ...new TextEncoder().encode(suffix),
    ]),
  );
}

interface TestJwtOptions {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  privateKeyPem?: string;
}

function signTestJwt(opts: TestJwtOptions): string {
  const header = opts.header ?? { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = opts.payload ?? {
    iss: TRUST_CONFIG.issuer,
    aud: TRUST_CONFIG.audience,
    sub: 'user-123',
    wallet_address: TEST_SUI_ADDRESS,
    iat: now,
    exp: now + 300,
  };

  const headerB64 = base64urlEncodeString(JSON.stringify(header));
  const payloadB64 = base64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(opts.privateKeyPem ?? TEST_PRIVATE_KEY_PEM);

  return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
}

// ─────────────────────────────────────────────
// parseDeveloperJwtTrustConfig tests
// ─────────────────────────────────────────────

describe('parseDeveloperJwtTrustConfig', () => {
  it('parses a valid single issuer config', () => {
    const json = JSON.stringify({
      issuer: 'https://auth.example.com',
      audience: 'stelis-studio',
      algorithm: 'RS256',
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
    });

    const config = parseDeveloperJwtTrustConfig(json);
    expect(config.issuer).toBe('https://auth.example.com');
    expect(config.audience).toBe('stelis-studio');
    expect(config.algorithm).toBe('RS256');
    expect(config.claimPaths.userId).toBe('sub');
    expect(config.claimPaths.senderAddress).toBe('wallet_address');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDeveloperJwtTrustConfig('not json')).toThrow('invalid JSON');
  });

  it('rejects array (must be single object)', () => {
    const json = JSON.stringify([{ issuer: 'x' }]);
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow('single issuer definition object');
  });

  it('rejects unsupported algorithm', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'HS256',
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow('unsupported algorithm');
  });

  it('rejects missing required field', () => {
    const json = JSON.stringify({ issuer: 'x' });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow('required non-empty string');
  });

  it('rejects invalid PEM', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'RS256',
      publicKeyPem: 'not-a-pem',
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow('invalid PEM');
  });

  it('rejects RS256 config with an EC public key', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'RS256',
      publicKeyPem: TEST_ES256_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow('RS256 requires an RSA public key');
  });

  it('rejects ES256 config with an RSA public key', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'ES256',
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow(
      'ES256 requires an EC P-256 public key',
    );
  });

  it('rejects ES256 config with a non-P-256 EC public key', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'ES256',
      publicKeyPem: TEST_P384_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(() => parseDeveloperJwtTrustConfig(json)).toThrow(
      'ES256 requires an EC P-256 public key',
    );
  });

  it('accepts ES256 config with a P-256 public key', () => {
    const json = JSON.stringify({
      issuer: 'x',
      audience: 'y',
      algorithm: 'ES256',
      publicKeyPem: TEST_ES256_PUBLIC_KEY_PEM,
      claimPaths: { userId: 'sub', senderAddress: 'addr' },
    });
    expect(parseDeveloperJwtTrustConfig(json).algorithm).toBe('ES256');
  });
});

// ─────────────────────────────────────────────
// verifyDeveloperJwt tests
// ─────────────────────────────────────────────

describe('verifyDeveloperJwt', () => {
  it('verifies a valid RS256 developer JWT', async () => {
    const jwt = signTestJwt({});
    const identity = await verifyDeveloperJwt(jwt, TRUST_CONFIG);
    expect(identity.userId).toBe('user-123');
    expect(identity.senderAddress).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('rejects malformed token', async () => {
    await expect(verifyDeveloperJwt('not.a.valid.jwt', TRUST_CONFIG)).rejects.toThrow(
      'malformed token',
    );
  });

  it('rejects padded base64url header encoding', async () => {
    const [header, payload, signature] = signTestJwt({}).split('.');
    await expect(
      verifyDeveloperJwt(`${header}=.${payload}.${signature}`, TRUST_CONFIG),
    ).rejects.toThrow('invalid header JSON');
  });

  it('rejects invalid base64url payload alphabet', async () => {
    const [header, payload, signature] = signTestJwt({}).split('.');
    await expect(
      verifyDeveloperJwt(`${header}.${payload}+.${signature}`, TRUST_CONFIG),
    ).rejects.toThrow('invalid payload JSON');
  });

  it('rejects padded base64url signature encoding', async () => {
    const [header, payload, signature] = signTestJwt({}).split('.');
    await expect(
      verifyDeveloperJwt(`${header}.${payload}.${signature}=`, TRUST_CONFIG),
    ).rejects.toThrow('invalid signature encoding');
  });

  it('rejects malformed UTF-8 in a JSON-shaped header', async () => {
    const malformedHeader = base64urlEncodeWithMalformedUtf8(
      '{"alg":"RS256","typ":"JWT","note":"',
      '"}',
    );
    const [, payload, signature] = signTestJwt({}).split('.');
    await expect(
      verifyDeveloperJwt(`${malformedHeader}.${payload}.${signature}`, TRUST_CONFIG),
    ).rejects.toThrow('invalid header JSON');
  });

  it('rejects malformed UTF-8 in a JSON-shaped payload', async () => {
    const malformedPayload = base64urlEncodeWithMalformedUtf8('{"iss":"', '"}');
    const [header, , signature] = signTestJwt({}).split('.');
    await expect(
      verifyDeveloperJwt(`${header}.${malformedPayload}.${signature}`, TRUST_CONFIG),
    ).rejects.toThrow('invalid payload JSON');
  });

  it('rejects unknown issuer', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: 'https://unknown-issuer.example',
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('unknown issuer');
  });

  it('rejects wrong audience', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: 'wrong-audience',
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('audience mismatch');
  });

  it('rejects expired token', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) - 120, // expired 120s ago
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('token expired');
  });

  it('accepts token at exact exp boundary within clock leeway', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: now,
        iat: now - 60,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).resolves.toMatchObject(
      { userId: 'user-1' },
    );
  });

  it('accepts token expired inside the configured clock leeway', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: now - DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS + 1,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).resolves.toMatchObject(
      { userId: 'user-1' },
    );
  });

  it('rejects token at the expired clock leeway boundary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: now - DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).rejects.toThrow(
      'token expired',
    );
  });

  it('accepts iat and nbf at the future clock leeway boundary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        iat: now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS,
        nbf: now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS,
        exp: now + 600,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).resolves.toMatchObject(
      { userId: 'user-1' },
    );
  });

  it('rejects iat in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        iat: now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS + 1,
        exp: now + 600,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).rejects.toThrow(
      'iat is in the future',
    );
  });

  it('rejects invalid signature (wrong key)', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = otherKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const jwt = signTestJwt({ privateKeyPem: otherPem });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'signature verification failed',
    );
  });

  it('rejects missing userId claim', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        // sub is missing!
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('missing or empty userId');
  });

  // ── Shared bounded Studio user ID validation ─────────────────────────────
  // The userId flows directly into Redis keys and structured-log fields.
  // The regex `^[A-Za-z0-9_:.-]{1,128}$` rejects shapes that could pollute
  // logs (whitespace, control chars), inflate Redis-key memory (overlong),
  // or collide with key conventions (forbidden punctuation).

  it('rejects empty-string userId (length 0)', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: '',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('missing or empty userId');
  });

  it('rejects overlong userId (129 chars exceeds 128-char cap)', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'x'.repeat(129),
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('accepts userId at exactly 128-char boundary', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'x'.repeat(128),
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const identity = await verifyDeveloperJwt(jwt, TRUST_CONFIG);
    expect(identity.userId).toHaveLength(128);
  });

  it('rejects userId containing whitespace', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user with space',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('rejects userId containing tab', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user\tid',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('rejects userId containing newline', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user\nid',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('rejects userId containing NUL control character', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user\x00id',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('rejects userId with forbidden punctuation (e.g. @, /)', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user@example.com',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'failed opaque-ID validation',
    );
  });

  it('accepts userId composed of allowed chars [A-Za-z0-9_:.-]', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'auth0:Tenant.Studio_42-user',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const identity = await verifyDeveloperJwt(jwt, TRUST_CONFIG);
    expect(identity.userId).toBe('auth0:Tenant.Studio_42-user');
  });

  it('rejects missing senderAddress claim', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        // wallet_address is missing!
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow(
      'missing or empty senderAddress',
    );
  });

  it('rejects invalid Sui address', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: 'not-a-sui-address',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG)).rejects.toThrow('invalid Sui address');
  });

  it('rejects algorithm mismatch (token uses HS256)', async () => {
    // Manually construct a token with HS256 header but signed with RSA (will fail)
    const headerB64 = base64urlEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadB64 = base64urlEncodeString(
      JSON.stringify({
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    const fakeJwt = `${headerB64}.${payloadB64}.fakesig`;
    await expect(verifyDeveloperJwt(fakeJwt, TRUST_CONFIG)).rejects.toThrow(
      'unsupported algorithm',
    );
  });

  it('supports nested claim paths (dot notation)', async () => {
    const nestedConfig: DeveloperJwtTrustConfig = {
      ...TRUST_CONFIG,
      claimPaths: {
        userId: 'app.uid',
        senderAddress: 'app.wallet',
      },
    };

    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        app: {
          uid: 'nested-user-42',
          wallet: TEST_SUI_ADDRESS,
        },
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });

    const identity = await verifyDeveloperJwt(jwt, nestedConfig);
    expect(identity.userId).toBe('nested-user-42');
    expect(identity.senderAddress).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('handles audience as array', async () => {
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: ['other-service', TRUST_CONFIG.audience, 'yet-another'],
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const identity = await verifyDeveloperJwt(jwt, TRUST_CONFIG);
    expect(identity.userId).toBe('user-1');
  });

  it('handles nbf claim in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signTestJwt({
      payload: {
        iss: TRUST_CONFIG.issuer,
        aud: TRUST_CONFIG.audience,
        sub: 'user-1',
        wallet_address: TEST_SUI_ADDRESS,
        nbf: now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS + 1,
        exp: now + 600,
      },
    });
    await expect(verifyDeveloperJwt(jwt, TRUST_CONFIG, { nowSeconds: now })).rejects.toThrow(
      'not yet valid (nbf)',
    );
  });
});
