import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ADMIN_REQUEST_ADMISSION_ERROR_CODES } from '@stelis/contracts';
import { readAdmittedClientIp, type AdmittedClientIp } from '@stelis/core-api';
import {
  beginRequestAdmission,
  finishAuthenticatedRequestAdmission,
  type RequestAdmissionDependencies,
} from '../src/requestAdmission.js';

function createAdmissionDependencies(): RequestAdmissionDependencies {
  return {
    resolveClientIp: vi.fn(() => '127.0.0.1'),
    host: {
      abuseBlocker: {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
        recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
      },
      rateLimiter: {
        check: vi.fn().mockResolvedValue({
          allowed: true,
          retryAfterMs: 0,
          current: 1,
          limit: 20,
        }),
      },
    },
  };
}

function createAdmissionApp(dependencies = createAdmissionDependencies()) {
  const app = new Hono();
  app.post('/json', async (c) => {
    const admitted = await beginRequestAdmission(c, dependencies, {
      allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
      unexpectedFailureCode: 'INTERNAL_ERROR',
      jsonBodyLimitBytes: 1_024,
    });
    if (!admitted.ok) return admitted.response;
    return c.json(admitted.value.body);
  });
  return { app, dependencies };
}

describe('request Content-Type admission', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/Json; charset="utf-8"; profile="current; contract"',
    'application/json; profile="current\\"contract"; charset=utf-8',
    'application/json;',
    'application/json;; charset=utf-8;',
  ])('accepts JSON with valid media-type parameters: %s', async (contentType) => {
    const response = await createAdmissionApp().app.request('/json', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify({ current: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ current: true });
  });

  it.each([
    'text/plain',
    'application/json; charset',
    'application/json; =utf-8',
    'application/json; charset = utf-8',
    'application/json; charset="unterminated',
    'application/json; charset="unterminated\\',
    'application/json; charset="utf-8" trailing',
  ])(
    'rejects a non-current JSON media type even when the body is valid JSON: %s',
    async (contentType) => {
      const response = await createAdmissionApp().app.request('/json', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify({ current: true }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' });
    },
  );
});

describe('request admission authority', () => {
  it('mints one opaque client-IP token only after the adapter admits the IP', async () => {
    const dependencies = createAdmissionDependencies();
    let capturedClientIp: AdmittedClientIp | undefined;
    const app = new Hono();
    app.get('/admit', async (c) => {
      const admitted = await beginRequestAdmission(c, dependencies, {
        allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
      });
      if (!admitted.ok) return admitted.response;
      capturedClientIp = admitted.value.clientIp;
      return c.json({ ip: readAdmittedClientIp(admitted.value.clientIp) });
    });

    const response = await app.request('/admit');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ip: '127.0.0.1' });
    expect(dependencies.host.abuseBlocker.checkIp).toHaveBeenCalledOnce();
    expect(dependencies.host.abuseBlocker.checkIp).toHaveBeenCalledWith('127.0.0.1');
    expect(capturedClientIp).toBeDefined();
    expect(() => readAdmittedClientIp({} as AdmittedClientIp)).toThrow(
      'AdmittedClientIp must be a token created by admitClientIp',
    );
  });

  it('does not mint or continue admission when the IP adapter blocks the request', async () => {
    const dependencies = createAdmissionDependencies();
    vi.mocked(dependencies.host.abuseBlocker.checkIp).mockResolvedValueOnce({
      blocked: true,
      retryAfterMs: 5_000,
    });
    const { app } = createAdmissionApp(dependencies);

    const response = await app.request('/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: true }),
    });

    expect(response.status).toBe(429);
    expect(dependencies.host.rateLimiter.check).not.toHaveBeenCalled();
    expect(dependencies.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
  });

  it('carries the exact admitted token through authenticated subject admission', async () => {
    const dependencies = createAdmissionDependencies();
    let initialToken: AdmittedClientIp | undefined;
    let finishedToken: AdmittedClientIp | undefined;
    const app = new Hono();
    app.get('/subject', async (c) => {
      const initial = await beginRequestAdmission(c, dependencies, {
        allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
      });
      if (!initial.ok) return initial.response;
      initialToken = initial.value.clientIp;
      const finished = await finishAuthenticatedRequestAdmission(c, dependencies, initial.value, {
        allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
        subject: { kind: 'studio_user', userId: 'user-1' },
      });
      if (!finished.ok) return finished.response;
      finishedToken = finished.value.clientIp;
      return c.json({ ip: readAdmittedClientIp(finished.value.clientIp) });
    });

    const response = await app.request('/subject');

    expect(response.status).toBe(200);
    expect(finishedToken).toBe(initialToken);
    expect(dependencies.host.abuseBlocker.checkIp).toHaveBeenCalledOnce();
    expect(dependencies.host.abuseBlocker.checkSubject).toHaveBeenCalledOnce();
    expect(dependencies.host.abuseBlocker.checkSubject).toHaveBeenCalledWith({
      kind: 'studio_user',
      userId: 'user-1',
    });
  });

  it('rejects a forged token before calling the subject adapter', async () => {
    const dependencies = createAdmissionDependencies();
    const app = new Hono();
    app.get('/subject', async (c) => {
      const finished = await finishAuthenticatedRequestAdmission(
        c,
        dependencies,
        { clientIp: {} as AdmittedClientIp, body: undefined },
        {
          allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
          subject: { kind: 'studio_user', userId: 'user-1' },
        },
      );
      return finished.ok ? c.json({ admitted: true }) : finished.response;
    });

    const response = await app.request('/subject');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(dependencies.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
  });

  it('rejects a token minted by a different blocker before calling the subject adapter', async () => {
    const mintingDependencies = createAdmissionDependencies();
    const consumingDependencies = createAdmissionDependencies();
    let token: AdmittedClientIp | undefined;
    const app = new Hono();
    app.get('/subject', async (c) => {
      const initial = await beginRequestAdmission(c, mintingDependencies, {
        allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
      });
      if (!initial.ok) return initial.response;
      token = initial.value.clientIp;
      const finished = await finishAuthenticatedRequestAdmission(
        c,
        consumingDependencies,
        initial.value,
        {
          allowedErrorCodes: ADMIN_REQUEST_ADMISSION_ERROR_CODES,
          subject: { kind: 'studio_user', userId: 'user-1' },
        },
      );
      return finished.ok ? c.json({ admitted: true }) : finished.response;
    });

    const response = await app.request('/subject');

    expect(token).toBeDefined();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(consumingDependencies.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
  });
});
