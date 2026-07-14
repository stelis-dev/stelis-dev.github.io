import { describe, it, expect } from 'vitest';
import { normalizeSponsorOperationsLastError } from '../../src/sponsor-operations/lastError.js';

describe('normalizeSponsorOperationsLastError', () => {
  it('preserves empty string as the no-error sentinel', () => {
    expect(normalizeSponsorOperationsLastError('')).toBe('');
  });

  it('uses Error.message for Error inputs', () => {
    expect(normalizeSponsorOperationsLastError(new Error('boom'))).toBe('boom');
  });

  it('redacts network credentials before persisting operator-visible state', () => {
    const normalized = normalizeSponsorOperationsLastError(
      new Error(
        'RPC failed at https://user:password@provider.example/rpc/private?token=secret ' +
          'Bearer jwt-secret SPONSOR_SECRET_KEY=suiprivkey1secretabc',
      ),
    );

    expect(normalized).toContain('https://provider.example/[REDACTED]?[REDACTED]');
    expect(normalized).toContain('Bearer [REDACTED]');
    expect(normalized).toContain('SPONSOR_SECRET_KEY=[REDACTED]');
    expect(normalized).not.toContain('password');
    expect(normalized).not.toContain('private');
    expect(normalized).not.toContain('jwt-secret');
    expect(normalized).not.toContain('suiprivkey1secretabc');
  });

  it('trims multibyte strings to <= 512 UTF-8 bytes without splitting a code point', () => {
    const raw = '한'.repeat(300);
    const normalized = normalizeSponsorOperationsLastError(raw);

    expect(normalized).toBe('한'.repeat(170));
    expect(new TextEncoder().encode(normalized).length).toBeLessThanOrEqual(512);
  });
});
