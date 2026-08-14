import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const STATIC_IMPORT_PATTERN = /(?:^|[;\r\n])\s*(?:import|export)\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_PATTERN = /(?:^|[;\r\n])\s*import\s+["']([^"']+)["']/g;

const LOWER_LEVEL_BOUNDARIES = {
  shared: new Set(['app', 'canvas', 'io', 'mask', 'media', 'persistence', 'utils']),
  media: new Set(['app', 'canvas', 'io', 'mask', 'persistence']),
  persistence: new Set(['app', 'io', 'mask', 'media']),
};

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function extractImports(source) {
  const imports = [];

  for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
    imports.push({
      isTypeOnly: Boolean(match[1]),
      specifier: match[2],
    });
  }

  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_PATTERN)) {
    imports.push({ isTypeOnly: false, specifier: match[1] });
  }

  return imports;
}

function getDomain(filePath) {
  const pathFromRoot = relative(SRC_ROOT, filePath);
  const [domain] = pathFromRoot.split(sep);
  return domain === 'canvas_view.ts' ? 'root' : domain;
}

function getImportedDomain(importerPath, specifier) {
  if (!specifier.startsWith('.')) return null;

  const targetPath = resolve(dirname(importerPath), specifier).replace(/\.js$/, '.ts');
  const pathFromRoot = relative(SRC_ROOT, targetPath);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..') return null;

  return pathFromRoot.split(sep)[0];
}

test('source root contains only the stable ComfyUI bootstrap', async () => {
  const files = await collectTypeScriptFiles(SRC_ROOT);
  const rootFiles = files
    .filter((filePath) => dirname(filePath) === resolve(SRC_ROOT))
    .map((filePath) => relative(SRC_ROOT, filePath))
    .sort();

  assert.deepEqual(rootFiles, ['canvas_view.ts']);

  const bootstrapSource = await readFile(resolve(SRC_ROOT, 'canvas_view.ts'), 'utf8');
  assert.match(bootstrapSource, /registerLayerForgeExtension\(\);/);
  assert.doesNotMatch(bootstrapSource, /app\.registerExtension\(/);
});

test('lower-level domains do not import higher-level runtime modules', async () => {
  const files = await collectTypeScriptFiles(SRC_ROOT);
  const violations = [];

  for (const importerPath of files) {
    const sourceDomain = getDomain(importerPath);
    const forbiddenDomains = LOWER_LEVEL_BOUNDARIES[sourceDomain];
    if (!forbiddenDomains) continue;

    const source = await readFile(importerPath, 'utf8');
    for (const { isTypeOnly, specifier } of extractImports(source)) {
      if (isTypeOnly) continue;

      const targetDomain = getImportedDomain(importerPath, specifier);
      if (!targetDomain || !forbiddenDomains.has(targetDomain)) continue;

      violations.push({
        importer: relative(SRC_ROOT, importerPath),
        sourceDomain,
        specifier,
        targetDomain,
      });
    }
  }

  assert.deepEqual(violations, [], 'lower-level domains must not depend on higher-level runtime modules');
});
