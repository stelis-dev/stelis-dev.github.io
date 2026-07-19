import { describe, expect, it } from 'vitest';
import { parseAppWebEnvironment } from '../src/environment';

describe('app-web environment contract', () => {
  it('normalizes the documented values into one environment snapshot', () => {
    expect(
      parseAppWebEnvironment({
        VITE_STELIS_RELAY_API_URL: 'https://host.example/relay/',
        VITE_STELIS_UI_MODE: 'studio',
        VITE_REPO_DOCS_BASE_URL: 'https://github.com/stelis-dev/stelis/blob/main/',
      }),
    ).toEqual({
      relayApiBase: 'https://host.example/relay',
      uiMode: 'studio',
      repoDocsBaseUrl: 'https://github.com/stelis-dev/stelis/blob/main',
    });
  });

  it('rejects unsupported names and UI modes instead of silently changing behavior', () => {
    expect(() =>
      parseAppWebEnvironment({
        VITE_STELIS_RELAY_API_URL: 'https://host.example/relay',
        VITE_UNSUPPORTED_SETTING: 'unexpected',
      }),
    ).toThrow('Unsupported environment variable(s): VITE_UNSUPPORTED_SETTING');
    expect(() =>
      parseAppWebEnvironment({
        VITE_STELIS_RELAY_API_URL: 'https://host.example/relay',
        VITE_STELIS_UI_MODE: 'studoi',
      }),
    ).toThrow('VITE_STELIS_UI_MODE must be relay or studio');
  });

  it('rejects URL values that do not represent the documented boundaries', () => {
    expect(() =>
      parseAppWebEnvironment({
        VITE_STELIS_RELAY_API_URL: 'https://host.example/api/relay',
      }),
    ).toThrow('path is exactly /relay');
    expect(() =>
      parseAppWebEnvironment({
        VITE_STELIS_RELAY_API_URL: 'https://host.example/relay',
        VITE_REPO_DOCS_BASE_URL: 'javascript:alert(1)',
      }),
    ).toThrow('valid http(s) URL without credentials');
  });
});
