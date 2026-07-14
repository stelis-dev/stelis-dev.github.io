import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  redactDiagnosticRecord,
  redactEndpointUrl,
  redactSensitiveText,
  safeErrorSummary,
} from '../src/observability/redaction.js';
import { logStructuredEvent } from '../src/structuredEventLog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observability redaction authority', () => {
  it('retains endpoint origin while removing every credential-bearing component', () => {
    const redacted = redactEndpointUrl(
      'https://rpc-user:rpc-password@provider.example:9443/rpc/private-token?apiKey=secret#tenant-secret',
    );

    expect(redacted).toBe('https://provider.example:9443/[REDACTED]?[REDACTED]#[REDACTED]');
    expect(redacted).not.toMatch(/rpc-user|rpc-password|private-token|apiKey|secret|tenant-secret/);
  });

  it('redacts free-text credentials and returns bounded stack-free summaries', () => {
    const redacted = redactSensitiveText(
      'request failed at https://user:password@provider.example/rpc/key?q=token#fragment; ' +
        'Authorization: Basic dXNlcjpwYXNz; Bearer eyJ.secret.value; ' +
        'key=suiprivkey1secretabc; SPONSOR_LEASE_HMAC_SECRET="very secret value"',
    );

    expect(redacted).toContain('https://provider.example/[REDACTED]');
    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('[REDACTED_SUI_PRIVATE_KEY]');
    expect(redacted).toContain('SPONSOR_LEASE_HMAC_SECRET=[REDACTED]');
    expect(redacted).not.toMatch(/dXNlcjpwYXNz|eyJ\.secret|suiprivkey1secretabc|very secret value/);

    const error = new Error(`failed https://provider.example/private/${'x'.repeat(600)}`);
    error.stack = 'stack contains suiprivkey1mustneverappear';
    const summary = safeErrorSummary(error);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).not.toContain('mustneverappear');
  });

  it('recursively sanitizes metadata without treating exact token type as a credential', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const redacted = redactDiagnosticRecord({
      settlementTokenType: '0x2::coin::TOKEN',
      secretKey: 'secret-key-value',
      authorizationHeader: 'Basic credential-value',
      nested: {
        endpoint: 'https://user:password@provider.example/private?apiKey=secret',
        accessToken: 'access-token-value',
      },
      circular,
      amount: 10n,
    });

    expect(redacted).toEqual({
      settlementTokenType: '0x2::coin::TOKEN',
      secretKey: '[REDACTED]',
      authorizationHeader: '[REDACTED]',
      nested: {
        endpoint: 'https://provider.example/[REDACTED]?[REDACTED]',
        accessToken: '[REDACTED]',
      },
      circular: { self: { circular: '[CIRCULAR]' } },
      amount: '10',
    });
  });

  it('sanitizes at the shared structured-log sink and preserves event authority', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logStructuredEvent(
      'SPONSOR_FAILURE_RECORDER_FAILED',
      {
        event: 'OVERRIDE_ATTEMPT',
        error: 'Redis failed at redis://user:password@cache.example/0',
        secretKey: 'must-not-leak',
      },
      'error',
    );

    expect(output).toHaveBeenCalledOnce();
    const line = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(line).toEqual({
      event: 'SPONSOR_FAILURE_RECORDER_FAILED',
      error: 'Redis failed at redis://cache.example/[REDACTED]',
      secretKey: '[REDACTED]',
    });
  });
});
