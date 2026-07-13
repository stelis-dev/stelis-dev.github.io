import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const packageRoot = new URL('../', import.meta.url);
const distRoot = new URL('dist/', packageRoot);
const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));

if (manifest.dependencies?.['@stelis/contracts'] !== undefined) {
  throw new Error('@stelis/mcp-server must not publish a runtime dependency on @stelis/contracts');
}

await access(new URL('index.js', distRoot), constants.R_OK | constants.X_OK);

const entrySource = await readFile(new URL('index.js', distRoot), 'utf8');
if (!entrySource.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('dist/index.js must retain the MCP CLI shebang');
}

for (const fileUrl of await listFiles(distRoot)) {
  if (!/\.(?:js|d\.ts)$/.test(fileUrl.pathname)) continue;
  const source = await readFile(fileUrl, 'utf8');
  if (source.includes('@stelis/contracts')) {
    throw new Error(
      `${fileUrl.pathname.slice(distRoot.pathname.length)} retains private @stelis/contracts reference`,
    );
  }
}

async function listFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(entry.name, directoryUrl);
    if (entry.isDirectory()) {
      child.pathname += '/';
      files.push(...(await listFiles(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}
