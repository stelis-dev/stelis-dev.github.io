import { describe, expect, it } from 'vitest';
import { parseAppAdminEnvironment } from '../src/environment';

describe('app-admin environment contract', () => {
  it('normalizes the documented Host origin', () => {
    expect(parseAppAdminEnvironment({ VITE_STELIS_API_URL: 'https://host.example/' })).toEqual({
      apiBase: 'https://host.example',
    });
  });

  it('rejects unsupported names and values outside the Host-origin boundary', () => {
    expect(() =>
      parseAppAdminEnvironment({
        VITE_STELIS_API_URL: 'https://host.example',
        VITE_STELIS_RELAY_API_URL: 'https://host.example/relay',
      }),
    ).toThrow('Unsupported environment variable(s): VITE_STELIS_RELAY_API_URL');
    expect(() =>
      parseAppAdminEnvironment({ VITE_STELIS_API_URL: 'https://host.example/prefix' }),
    ).toThrow('without credentials, path, query, or fragment');
  });
});
