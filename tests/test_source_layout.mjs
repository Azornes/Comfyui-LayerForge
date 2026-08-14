import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const requiredSourceModules = [
  '../src/app/CanvasView.ts',
  '../src/canvas/Canvas.ts',
  '../src/io/CanvasIO.ts',
  '../src/mask/MaskTool.ts',
  '../src/media/ImageUtils.ts',
  '../src/persistence/db.ts',
  '../src/shared/types.ts',
];

test('frontend source layout keeps domain modules and a single registration bootstrap', async () => {
  await Promise.all(requiredSourceModules.map((path) => access(new URL(path, import.meta.url))));

  const bootstrapSource = await readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8');
  const implementationSource = await readFile(new URL('../src/app/CanvasView.ts', import.meta.url), 'utf8');
  const canvasStateSource = await readFile(new URL('../src/canvas/CanvasState.ts', import.meta.url), 'utf8');

  assert.match(bootstrapSource, /registerLayerForgeExtension\(\);/);
  assert.match(implementationSource, /export function registerLayerForgeExtension\(\)/);
  assert.match(implementationSource, /app\.registerExtension\(\{/);
  assert.doesNotMatch(implementationSource, /^registerLayerForgeExtension\(\);/m);
  assert.match(canvasStateSource, /new URL\('\.\.\/persistence\/state-saver\.worker\.js'/);
});
