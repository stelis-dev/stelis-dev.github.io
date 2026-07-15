/**
 * Developer JWT Verifier — asymmetric JWT trust boundary for studio auth.
 *
 * Stelis does NOT trust raw userId or senderAddress input.
 * Stelis accepts only a verified developer JWT from a trusted issuer.
 *
 * Trust config is host-owned via STUDIO_DEVELOPER_JWT_TRUST_JSON (single issuer).
 * No hardcoded issuers, no runtime-derived trust material, no fallback keys.
 *
 * Supported algorithms: RS256, ES256.
 * Developer tokens use asymmetric signing (not HS256 — that's internal only).
 *
 * Optional callback verification via STUDIO_DEVELOPER_JWT_VERIFY_URL
 * is a host/runtime concern and belongs in app-api, not here.
 *
 * @module developerJwtVerifier
 */

import { createVerify, createPublicKey, type KeyObject } from 'node:crypto';

// Shared Sui address validation helper.
import { canonicalizeAddress } from '../addressConstraints.js';
import { decodeBase64url } from './base64url.js';

// ─────────────────────────────────────────────
// Trust config types (single issuer).
// ─────────────────────────────────────────────

/** Claim path mapping — tells Stelis where to find identity in the developer JWT. */
export interface DeveloperJwtClaimPaths {
  /** Dot-notation path to canonical userId (e.g., "sub" or "app.uid"). */
  userId: string;
  /** Dot-notation path to current wallet address (e.g., "wallet_address" or "app.wallet_address"). */
  senderAddress: string;
}

/**
 * Single trusted issuer definition — the only trust config shape.
 * No multi-issuer support. One operator → one issuer.
 */
export interface DeveloperJwtTrustConfig {
  /** Expected `iss` claim value. Must match exactly. */
  issuer: string;
  /** Expected `aud` claim value. Must match exactly. */
  audience: string;
  /** Allowed algorithm. "RS256" | "ES256". */
  algorithm: 'RS256' | 'ES256';
  /** PEM-encoded public key for signature verification. */
  publicKeyPem: string;
  /** Claim paths for identity extraction. */
  claimPaths: DeveloperJwtClaimPaths;
}

/** Verified developer identity extracted from a developer JWT. */
export interface VerifiedDeveloperIdentity {
  /** Canonical userId from the developer JWT. */
  userId: string;
  /** Validated and canonicalized Sui wallet address from the developer JWT. */
  senderAddress: string;
}

// ─────────────────────────────────────────────
// Algorithm → node:crypto mapping
// ─────────────────────────────────────────────

const ALGORITHM_MAP: Record<string, string> = {
  RS256: 'RSA-SHA256',
  ES256: 'SHA256',
};

const JWT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS = 60;

// ─────────────────────────────────────────────
// Trust Config Parsing and Validation
// ─────────────────────────────────────────────

/**
 * Parse and validate STUDIO_DEVELOPER_JWT_TRUST_JSON (single issuer object).
 *
 * Fail-fast on:
 * - Invalid JSON
 * - Not an object
 * - Missing required fields
 * - Unsupported algorithm
 * - Invalid PEM public key
 *
 * @throws Error with descriptive message on any validation failure.
 */
export function parseDeveloperJwtTrustConfig(jsonStr: string): DeveloperJwtTrustConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    throw new Error('STUDIO_DEVELOPER_JWT_TRUST_JSON: invalid JSON');
  }

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'STUDIO_DEVELOPER_JWT_TRUST_JSON: must be a single issuer definition object, not an array',
    );
  }

  const entry = raw as Record<string, unknown>;
  const prefix = 'STUDIO_DEVELOPER_JWT_TRUST_JSON';

  // Required string fields
  const issuer = requireString(entry, 'issuer', prefix);
  const audience = requireString(entry, 'audience', prefix);
  const algorithm = requireString(entry, 'algorithm', prefix);
  const publicKeyPem = requireString(entry, 'publicKeyPem', prefix);

  // Algorithm validation
  if (algorithm !== 'RS256' && algorithm !== 'ES256') {
    throw new Error(
      `${prefix}.algorithm: unsupported algorithm "${algorithm}". Supported: RS256, ES256`,
    );
  }

  // Public key validation — try to parse PEM and bind key type to alg.
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error(`${prefix}.publicKeyPem: invalid PEM public key`);
  }
  validatePublicKeyForAlgorithm(publicKey, algorithm, `${prefix}.publicKeyPem`);

  // Claim paths validation
  const claimPaths = entry.claimPaths;
  if (claimPaths == null || typeof claimPaths !== 'object' || Array.isArray(claimPaths)) {
    throw new Error(`${prefix}.claimPaths: required object`);
  }
  const cpObj = claimPaths as Record<string, unknown>;
  const userIdPath = requireString(cpObj, 'userId', `${prefix}.claimPaths`);
  const senderAddressPath = requireString(cpObj, 'senderAddress', `${prefix}.claimPaths`);

  return {
    issuer,
    audience,
    algorithm: algorithm as 'RS256' | 'ES256',
    publicKeyPem,
    claimPaths: { userId: userIdPath, senderAddress: senderAddressPath },
  };
}

function requireString(obj: Record<string, unknown>, key: string, prefix: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`${prefix}.${key}: required non-empty string`);
  }
  return val;
}

function validatePublicKeyForAlgorithm(
  publicKey: KeyObject,
  algorithm: DeveloperJwtTrustConfig['algorithm'],
  prefix: string,
): void {
  if (algorithm === 'RS256') {
    if (publicKey.asymmetricKeyType !== 'rsa') {
      throw new Error(`${prefix}: RS256 requires an RSA public key`);
    }
    return;
  }

  if (publicKey.asymmetricKeyType !== 'ec') {
    throw new Error(`${prefix}: ES256 requires an EC P-256 public key`);
  }
  const details = publicKey.asymmetricKeyDetails as { namedCurve?: string } | undefined;
  if (details?.namedCurve !== 'prime256v1' && details?.namedCurve !== 'secp256r1') {
    throw new Error(`${prefix}: ES256 requires an EC P-256 public key`);
  }
}

// ─────────────────────────────────────────────
// Developer JWT Verification
// ─────────────────────────────────────────────

/**
 * Verify a developer JWT against the trust config (single issuer).
 *
 * Flow:
 * 1. Decode header → check algorithm
 * 2. Decode payload → check `iss` matches trusted issuer
 * 3. Verify signature using issuer's public key
 * 4. Validate `aud`, `exp`, optional `iat`/`nbf`
 * 5. Extract userId and senderAddress via claim paths
 * 6. Validate senderAddress as a valid Sui address
 *
 * Fail-closed: throws on every failure case.
 * No "try next issuer" — single issuer config.
 *
 * This function is pure local verification only.
 * Optional callback verification (STUDIO_DEVELOPER_JWT_VERIFY_URL) is
 * a host/runtime concern and belongs in app-api, not here.
 *
 * @throws Error on any verification failure.
 */
export async function verifyDeveloperJwt(
  jwt: string,
  trustConfig: DeveloperJwtTrustConfig,
  options?: {
    /** Current time in seconds. Defaults to Math.floor(Date.now() / 1000). Test-only override. */
    nowSeconds?: number;
  },
): Promise<VerifiedDeveloperIdentity> {
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('developer JWT: nowSeconds must be a non-negative safe integer');
  }

  // ── 1. Split and decode ──────────────────────────────────────
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('developer JWT: malformed token (expected 3 parts)');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Header
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(JWT_UTF8_DECODER.decode(decodeBase64url(headerB64)));
  } catch {
    throw new Error('developer JWT: invalid header JSON');
  }

  if (!header.alg) {
    throw new Error('developer JWT: missing alg in header');
  }

  const cryptoAlg = ALGORITHM_MAP[header.alg];
  if (!cryptoAlg) {
    throw new Error(`developer JWT: unsupported algorithm "${header.alg}"`);
  }

  // JWT payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(JWT_UTF8_DECODER.decode(decodeBase64url(payloadB64)));
  } catch {
    throw new Error('developer JWT: invalid payload JSON');
  }

  // ── 2. Issuer match (single issuer — no find loop) ───────────
  const iss = payload.iss;
  if (typeof iss !== 'string' || iss.length === 0) {
    throw new Error('developer JWT: missing or empty iss claim');
  }

  if (iss !== trustConfig.issuer) {
    throw new Error(`developer JWT: unknown issuer "${iss}"`);
  }

  // ── 3. Algorithm match ───────────────────────────────────────
  if (header.alg !== trustConfig.algorithm) {
    throw new Error(
      `developer JWT: algorithm mismatch — token uses "${header.alg}", trusted issuer requires "${trustConfig.algorithm}"`,
    );
  }

  // ── 4. Signature verification ────────────────────────────────
  const signingInput = `${headerB64}.${payloadB64}`;
  let signatureBytes: Uint8Array;
  try {
    if (signatureB64.length === 0) throw new Error('empty signature');
    signatureBytes = decodeBase64url(signatureB64);
  } catch {
    throw new Error('developer JWT: invalid signature encoding');
  }
  const publicKey: KeyObject = createPublicKey(trustConfig.publicKeyPem);
  validatePublicKeyForAlgorithm(publicKey, trustConfig.algorithm, 'developer JWT publicKeyPem');

  let signatureValid: boolean;

  if (header.alg === 'ES256') {
    // ES256 (P-256) — JWT spec mandates IEEE P1363 format for ECDSA signatures
    const verifier = createVerify(cryptoAlg);
    verifier.update(signingInput);
    signatureValid = verifier.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      new Uint8Array(signatureBytes),
    );
  } else {
    // RS256 — standard RSA-SHA256 verification
    const verifier = createVerify(cryptoAlg);
    verifier.update(signingInput);
    signatureValid = verifier.verify(publicKey, new Uint8Array(signatureBytes));
  }

  if (!signatureValid) {
    throw new Error('developer JWT: signature verification failed');
  }

  // ── 5. Audience validation ───────────────────────────────────
  const aud = payload.aud;
  const audMatches =
    typeof aud === 'string'
      ? aud === trustConfig.audience
      : Array.isArray(aud) && aud.includes(trustConfig.audience);

  if (!audMatches) {
    throw new Error(
      `developer JWT: audience mismatch — expected "${trustConfig.audience}", got "${String(aud)}"`,
    );
  }

  // ── 6. Temporal validation ───────────────────────────────────
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
    throw new Error('developer JWT: exp must be a safe integer number');
  }
  if (exp <= now - DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS) {
    throw new Error('developer JWT: token expired');
  }

  const iat = payload.iat;
  if (iat !== undefined) {
    if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) {
      throw new Error('developer JWT: iat must be a safe integer number');
    }
    if (iat > now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS) {
      throw new Error('developer JWT: iat is in the future');
    }
  }

  const nbf = payload.nbf;
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isSafeInteger(nbf)) {
      throw new Error('developer JWT: nbf must be a safe integer number');
    }
    if (nbf > now + DEVELOPER_JWT_CLOCK_LEEWAY_SECONDS) {
      throw new Error('developer JWT: token not yet valid (nbf)');
    }
  }

  // ── 7. Extract identity via claim paths ──────────────────────
  const rawUserId = extractClaimByPath(payload, trustConfig.claimPaths.userId);
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    throw new Error(
      `developer JWT: missing or empty userId at claim path "${trustConfig.claimPaths.userId}"`,
    );
  }
  // Bounded opaque-ID rule. The Studio promotion principal (`userId`) is
  // used directly as a Redis key fragment and a structured-log field, so
  // it must be safe for both callers without an HMAC layer. The rule
  // accepts the conservative cross-section of common JWT `sub` formats —
  // alphanumerics plus `_`, `-`, `.`, `:` separators — bounded at 128
  // characters to keep Redis keys reasonable and prevent log pollution.
  // Reject control characters, whitespace, and non-printable bytes to
  // avoid log-injection or key-confusion when the value reaches Redis or
  // structured-log consumers.
  if (!USER_ID_PATTERN.test(rawUserId)) {
    throw new Error(
      `developer JWT: userId at claim path "${trustConfig.claimPaths.userId}" failed opaque-ID validation (length 1-128, [A-Za-z0-9_:.\\-])`,
    );
  }
  const userId = rawUserId;

  const rawSenderAddress = extractClaimByPath(payload, trustConfig.claimPaths.senderAddress);
  if (typeof rawSenderAddress !== 'string' || rawSenderAddress.length === 0) {
    throw new Error(
      `developer JWT: missing or empty senderAddress at claim path "${trustConfig.claimPaths.senderAddress}"`,
    );
  }

  // ── 8. Sui address validation ────────────────────────────────
  // Uses the repo's Sui address normalization + validation helper.
  let senderAddress: string;
  try {
    senderAddress = canonicalizeAddress(rawSenderAddress, 'developer JWT senderAddress');
  } catch {
    throw new Error(
      `developer JWT: invalid Sui address at claim path "${trustConfig.claimPaths.senderAddress}": "${rawSenderAddress}"`,
    );
  }

  return { userId, senderAddress };
}

// ─────────────────────────────────────────────
// userId validation
// ─────────────────────────────────────────────

/**
 * Bounded opaque-ID pattern. The Studio promotion principal flows
 * directly into Redis keys and structured-log fields, so the value is
 * constrained to a conservative printable set without separators that
 * could collide with Redis-key conventions or pollute structured logs.
 * Length is capped at 128 characters; the floor of 1 character prevents
 * empty principals from reaching enforcement.
 */
const USER_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

// ─────────────────────────────────────────────
// Claim path extraction
// ─────────────────────────────────────────────

/**
 * Extract a value from a nested object using dot-notation path.
 * E.g., "app.uid" → obj.app.uid
 */
function extractClaimByPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}
