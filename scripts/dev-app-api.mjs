#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envFilePath = resolve('packages/app-api/.env');

function parseEnvFile(content) {
  const parsed = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`${envFilePath}:${index + 1}: expected KEY=value`);
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${envFilePath}:${index + 1}: invalid env key "${key}"`);
    }

    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

const childEnv = { ...process.env };
if (existsSync(envFilePath)) {
  const parsed = parseEnvFile(readFileSync(envFilePath, 'utf8'));
  let loadedCount = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (childEnv[key] === undefined) {
      childEnv[key] = value;
      loadedCount += 1;
    }
  }
  console.log(`[dev:app-api] Loaded ${loadedCount} value(s) from ${envFilePath}`);
} else {
  console.warn(`[dev:app-api] ${envFilePath} not found; using current process environment`);
}

function formatRedisUrl(host, port) {
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return `redis://${urlHost}:${port}`;
}

async function stopRedisHandle(redisHandle, signal = 'SIGTERM') {
  if (!redisHandle) return;
  try {
    await redisHandle.stop(signal);
  } catch (error) {
    console.error(
      `[dev:app-api] Failed to stop local Redis: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function startRedisMemoryServer() {
  let RedisMemoryServer;
  try {
    const redisMemoryServerModule = await import('redis-memory-server');
    RedisMemoryServer =
      redisMemoryServerModule.RedisMemoryServer ??
      redisMemoryServerModule.default?.RedisMemoryServer;
  } catch (error) {
    throw new Error(
      `redis-memory-server is required for local dev:app-api. Run npm install. Original error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!RedisMemoryServer) {
    throw new Error('redis-memory-server export not found');
  }

  console.log('[dev:app-api] Starting isolated Redis memory server');
  let server;
  try {
    server = new RedisMemoryServer();
    const host = await server.getHost();
    const port = await server.getPort();
    const redisUrl = formatRedisUrl(host, port);
    if (childEnv.REDIS_URL && childEnv.REDIS_URL !== redisUrl) {
      console.log('[dev:app-api] Overriding REDIS_URL with the local Redis memory server');
    }
    childEnv.REDIS_URL = redisUrl;
    console.log(`[dev:app-api] Using isolated Redis memory server at ${redisUrl}`);
    return {
      async stop() {
        await server.stop();
      },
    };
  } catch (error) {
    await server?.stop().catch(() => {});
    throw new Error(
      `Failed to start redis-memory-server for local dev:app-api. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const redisProcess = await startRedisMemoryServer();
const child = spawn(npmCommand, ['run', 'dev', '-w', '@stelis/app-api'], {
  env: childEnv,
  stdio: 'inherit',
});

child.on('error', (error) => {
  void stopRedisHandle(redisProcess);
  console.error(`[dev:app-api] Failed to start app-api dev server: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
    void stopRedisHandle(redisProcess, signal);
  });
}

child.on('exit', async (code, signal) => {
  await stopRedisHandle(redisProcess);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
