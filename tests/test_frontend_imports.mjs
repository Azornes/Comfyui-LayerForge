import assert from 'node:assert/strict';
import { readdir, stat, readFile } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const JS_ROOT = fileURLToPath(new URL('../js/', import.meta.url));
const STATIC_IMPORT_PATTERN = /(?:^|[;\r\n])\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.js') {
      files.push(entryPath);
    }
  }

  return files;
}

function extractModuleSpecifiers(source) {
  const specifiers = new Set();

  for (const pattern of [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

function isInsideJsRoot(targetPath) {
  const pathFromRoot = relative(JS_ROOT, targetPath);
  return Boolean(
    pathFromRoot === ''
      || (!pathFromRoot.startsWith(`..${sep}`)
        && pathFromRoot !== '..'
        && !isAbsolute(pathFromRoot))
  );
}

async function resolveLocalModule(importerPath, specifier) {
  const targetPath = resolve(dirname(importerPath), specifier);
  if (!isInsideJsRoot(targetPath)) {
    // Imports outside js/ are ComfyUI-provided modules such as scripts/app.js.
    return null;
  }

  const candidates = [
    targetPath,
    `${targetPath}.js`,
    resolve(targetPath, 'index.js'),
  ];

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return targetPath;
}

test('all local frontend module imports resolve to files', async () => {
  const sourceFiles = await collectJavaScriptFiles(JS_ROOT);
  const missingImports = [];

  for (const importerPath of sourceFiles) {
    const source = await readFile(importerPath, 'utf8');
    for (const specifier of extractModuleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;

      const resolvedPath = await resolveLocalModule(importerPath, specifier);
      if (!resolvedPath) continue;

      try {
        if ((await stat(resolvedPath)).isFile()) continue;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      missingImports.push({
        importer: relative(JS_ROOT, importerPath),
        specifier,
        expected: relative(JS_ROOT, resolvedPath),
      });
    }
  }

  assert.deepEqual(missingImports, [], 'local frontend imports must point to existing files');
});
