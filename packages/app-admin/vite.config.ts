import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function loadEnvFile() {
  const envPath = resolve('.env');
  if (!existsSync(envPath)) return;

  for (const [index, rawLine] of readFileSync(envPath, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`${envPath}:${index + 1}: expected KEY=value`);
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${envPath}:${index + 1}: invalid env key "${key}"`);
    }
    if (!key.startsWith('VITE_') || process.env[key] !== undefined) continue;

    const rawValue = normalized.slice(separatorIndex + 1).trim();
    process.env[key] =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
  }
}

export default defineConfig(({ mode }) => {
  loadEnvFile();
  const env = loadEnv(mode, false, 'VITE_');
  const apiUrl = (env.VITE_STELIS_API_URL || '').trim();
  if (!apiUrl) {
    throw new Error(
      '[app-admin] Missing required env VITE_STELIS_API_URL. Set packages/app-admin/.env (see .env.example).',
    );
  }

  return {
    envFile: false,
    plugins: [react()],
    server: {
      port: 3100,
      proxy: {
        '/admin': apiUrl,
        '/relay': apiUrl,
        '/studio': apiUrl,
        '/health': apiUrl,
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.{ts,tsx}'],
    },
  };
});
