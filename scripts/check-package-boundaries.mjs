/**
 * check-package-boundaries.mjs — workspace package import boundary check.
 *
 * The monorepo may use internal source-of-truth packages, but each package
 * may import only the current verified product/internal boundaries. This
 * script checks real TypeScript imports, dynamic imports, and import() types.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '..');
const packagesRoot = join(workspaceRoot, 'packages');

const PACKAGE_IMPORT_ALLOWLIST = {
  '@stelis/contracts': [],
  '@stelis/core-relay': ['@stelis/contracts'],
  '@stelis/core-api': ['@stelis/contracts', '@stelis/core-relay'],
  '@stelis/sdk': ['@stelis/contracts', '@stelis/core-relay'],
  '@stelis/app-api': ['@stelis/contracts', '@stelis/core-api'],
  '@stelis/app-web': ['@stelis/sdk'],
  '@stelis/app-admin': ['@stelis/contracts'],
  '@stelis/mcp-server': ['@stelis/contracts'],
};

const SPECIFIER_ALLOWLIST = {
  '@stelis/core-api->@stelis/core-relay': new Set([
    '@stelis/core-relay',
    '@stelis/core-relay/server',
    '@stelis/core-relay/browser',
  ]),
  '@stelis/sdk->@stelis/core-relay': new Set([
    '@stelis/core-relay',
    '@stelis/core-relay/browser',
  ]),
  '@stelis/app-api->@stelis/core-api': new Set([
    '@stelis/core-api',
    '@stelis/core-api/admin',
    '@stelis/core-api/studio',
    '@stelis/core-api/observability',
    '@stelis/core-api/prepareConfig',
  ]),
  '@stelis/app-web->@stelis/sdk': new Set(['@stelis/sdk', '@stelis/sdk/server']),
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

const packageDirs = loadWorkspacePackages();
const packageNames = new Set(packageDirs.map((pkg) => pkg.name));
const packageExports = new Map(packageDirs.map((pkg) => [pkg.name, loadPublicExports(pkg.dir)]));

const violations = [];

for (const pkg of packageDirs) {
  for (const dep of workspaceManifestDependencies(pkg)) {
    const allowedTargets = PACKAGE_IMPORT_ALLOWLIST[pkg.name] ?? [];
    if (!allowedTargets.includes(dep)) {
      violations.push(
        `${pkg.name} package.json depends on ${dep}: workspace dependency target is not allowed`,
      );
    }
  }

  const files = listSourceFiles(pkg.dir);
  for (const file of files) {
    const imports = collectModuleSpecifiers(file);
    for (const specifier of imports) {
      const targetPackage = getWorkspacePackageName(specifier);
      if (!targetPackage || targetPackage === pkg.name) continue;

      const allowedTargets = PACKAGE_IMPORT_ALLOWLIST[pkg.name] ?? [];
      if (!allowedTargets.includes(targetPackage)) {
        violations.push(
          formatViolation(
            file,
            pkg.name,
            specifier,
            `workspace import target ${targetPackage} is not allowed`,
          ),
        );
        continue;
      }

      const allowedSpecifiers = allowedSpecifiersFor(pkg.name, targetPackage, file);
      if (!allowedSpecifiers.has(specifier)) {
        violations.push(
          formatViolation(
            file,
            pkg.name,
            specifier,
            `specifier is not an allowed public boundary for ${pkg.name} -> ${targetPackage}`,
          ),
        );
      }

      if (!isPublicSpecifier(targetPackage, specifier)) {
        violations.push(
          formatViolation(
            file,
            pkg.name,
            specifier,
            `specifier is not exported by ${targetPackage}`,
          ),
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`❌ Package boundary check found ${violations.length} violation(s):\n`);
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`✅ Package boundary check passed — ${packageDirs.length} workspace package(s) scanned`);

function loadWorkspacePackages() {
  const dirs = readdirSync(packagesRoot)
    .map((entry) => join(packagesRoot, entry))
    .filter((entry) => statSync(entry).isDirectory());
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { dir, manifest, name: manifest.name };
  });
}

function workspaceManifestDependencies(pkg) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const out = new Set();
  for (const section of sections) {
    const deps = pkg.manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (packageNames.has(name) && name !== pkg.name) {
        out.add(name);
      }
    }
  }
  return out;
}

function loadPublicExports(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (!manifest.exports) return new Set(['.']);
  if (typeof manifest.exports === 'string') return new Set(['.']);
  return new Set(Object.keys(manifest.exports));
}

function publicSpecifiers(packageName) {
  const exports = packageExports.get(packageName) ?? new Set(['.']);
  const specifiers = new Set();
  for (const exportKey of exports) {
    if (exportKey === '.') {
      specifiers.add(packageName);
    } else if (exportKey.startsWith('./')) {
      specifiers.add(`${packageName}/${exportKey.slice(2)}`);
    }
  }
  return specifiers;
}

function allowedSpecifiersFor(sourcePackage, targetPackage, file) {
  const exact = SPECIFIER_ALLOWLIST[`${sourcePackage}->${targetPackage}`];
  const allowed = new Set(exact ?? publicSpecifiers(targetPackage));
  if (
    sourcePackage === '@stelis/app-api' &&
    targetPackage === '@stelis/core-api' &&
    isPackageTestFile(file)
  ) {
    allowed.add('@stelis/core-api/testing/studio');
  }
  return allowed;
}

function isPackageTestFile(file) {
  const rel = relative(workspaceRoot, file).split(sep).join('/');
  return /^packages\/[^/]+\/tests\//.test(rel);
}

function isPublicSpecifier(packageName, specifier) {
  if (specifier === packageName) {
    return (packageExports.get(packageName) ?? new Set(['.'])).has('.');
  }
  if (!specifier.startsWith(`${packageName}/`)) return false;
  const exportKey = `./${specifier.slice(packageName.length + 1)}`;
  return (packageExports.get(packageName) ?? new Set()).has(exportKey);
}

function listSourceFiles(root) {
  const files = [];
  walk(root, files);
  return files;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extensionOf(fullPath))) {
      files.push(fullPath);
    }
  }
}

function extensionOf(file) {
  const name = file.toLowerCase();
  for (const ext of SOURCE_EXTENSIONS) {
    if (name.endsWith(ext)) return ext;
  }
  return '';
}

function collectModuleSpecifiers(file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function getWorkspacePackageName(specifier) {
  if (!specifier.startsWith('@stelis/')) return null;
  const parts = specifier.split('/');
  const packageName = `${parts[0]}/${parts[1]}`;
  return packageNames.has(packageName) ? packageName : null;
}

function formatViolation(file, sourcePackage, specifier, reason) {
  const rel = relative(workspaceRoot, file).split(sep).join('/');
  return `- ${rel}: ${sourcePackage} imports ${specifier}: ${reason}`;
}
