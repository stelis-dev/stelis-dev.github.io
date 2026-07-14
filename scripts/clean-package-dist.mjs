import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const packageRoot = process.cwd();
const manifestPath = path.join(packageRoot, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@stelis/')) {
  throw new Error(`Refusing to clean dist outside a Stelis workspace package: ${packageRoot}`);
}

await rm(path.join(packageRoot, 'dist'), { recursive: true, force: true });
