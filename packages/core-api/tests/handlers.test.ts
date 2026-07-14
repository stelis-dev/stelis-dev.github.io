import { describe, it, expect } from 'vitest';
import { handleStatus } from '../src/handlers/status.js';
import { SponsorValidationError } from '../src/handlers/sponsor.js';

// ─────────────────────────────────────────────
// handleStatus
// ─────────────────────────────────────────────

describe('handleStatus', () => {
  it('returns ok: true (health check only)', async () => {
    const result = await handleStatus();
    expect(result.ok).toBe(true);
  });
});

describe('SponsorValidationError', () => {
  it('carries code and message', () => {
    const err = new SponsorValidationError('BAD_REQUEST', 'Missing settle call');
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('Missing settle call');
    expect(err.name).toBe('SponsorValidationError');
    expect(err).toBeInstanceOf(Error);
  });
});
