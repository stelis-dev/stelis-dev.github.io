import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callDeveloperVerifyApi,
  DeveloperVerifyRejectedError,
  DeveloperVerifyUnavailableError,
} from '../src/developerJwtVerifyCallback.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('developer JWT verification callback contract', () => {
  it('accepts only an explicit current positive verdict', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ valid: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callDeveloperVerifyApi('developer-jwt', 'https://developer.example.test/verify'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://developer.example.test/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ jwt: 'developer-jwt' }),
        redirect: 'error',
        credentials: 'omit',
      }),
    );
  });

  it('refuses every fetch redirect before the JWT reaches its target', async () => {
    const jwt = 'redirect-test-developer-jwt';
    const redirectStatuses = [301, 302, 303, 307, 308] as const;
    const sourceBodies: string[] = [];
    let redirectStatus: (typeof redirectStatuses)[number] = redirectStatuses[0];
    let targetRequests = 0;

    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.statusCode = 204;
      response.end();
    });
    const targetPort = await listen(target);
    const source = createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) {
        body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      sourceBodies.push(Buffer.concat(body).toString('utf8'));
      response.statusCode = redirectStatus;
      response.setHeader('Location', `http://127.0.0.1:${targetPort}/redirected`);
      response.end();
    });
    const sourcePort = await listen(source);

    try {
      for (const status of redirectStatuses) {
        redirectStatus = status;
        await expect(
          callDeveloperVerifyApi(jwt, `http://127.0.0.1:${sourcePort}/verify`),
        ).rejects.toBeInstanceOf(DeveloperVerifyUnavailableError);
      }

      expect(sourceBodies).toEqual(redirectStatuses.map(() => JSON.stringify({ jwt })));
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([close(source), close(target)]);
    }
  });

  it('classifies an explicit negative verdict as credential rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ valid: false, reason: 'session revoked' })),
    );

    await expect(
      callDeveloperVerifyApi('developer-jwt', 'https://developer.example.test/verify'),
    ).rejects.toBeInstanceOf(DeveloperVerifyRejectedError);
  });

  it.each([{}, { valid: 'true' }, { valid: true, reason: 1 }, { valid: true, legacy: true }, []])(
    'classifies a non-current response shape as verifier unavailability',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

      await expect(
        callDeveloperVerifyApi('developer-jwt', 'https://developer.example.test/verify'),
      ).rejects.toBeInstanceOf(DeveloperVerifyUnavailableError);
    },
  );

  it('classifies transport failure as verifier unavailability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await expect(
      callDeveloperVerifyApi('developer-jwt', 'https://developer.example.test/verify'),
    ).rejects.toBeInstanceOf(DeveloperVerifyUnavailableError);
  });
});
