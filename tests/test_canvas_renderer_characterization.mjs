import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [canvasIOSource, canvasLayersSource] = await Promise.all([
  readFile(new URL('../src/io/CanvasIO.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/canvas/CanvasLayers.ts', import.meta.url), 'utf8'),
]);

test('output paths preserve their current render bounds and mask responsibilities', () => {
  assert.match(canvasIOSource, /renderLayersToCanvas\(/);
  assert.match(canvasIOSource, /renderLayerVisibilityMask\(/);
  assert.match(canvasIOSource, /const renderBounds = \{ x: 0, y: 0, width: this\.canvas\.width, height: this\.canvas\.height \}/);
  assert.match(canvasIOSource, /const bounds = this\.canvas\.outputAreaBounds/);

  assert.match(canvasLayersSource, /public renderLayersToCanvas\(/);
  assert.match(canvasLayersSource, /public renderLayerVisibilityMask\(/);
  assert.match(canvasLayersSource, /this\.renderLayersToCanvas\(/);
  assert.doesNotMatch(canvasLayersSource, /this\._drawLayers\(tempCtx, layers\)/);
  assert.doesNotMatch(canvasLayersSource, /visibilityCtx\.translate\(-bounds\.x, -bounds\.y\)/);
  assert.match(canvasLayersSource, /maskCtx\.globalCompositeOperation = 'screen'/);
});

test('output rendering keeps persistence and transport in CanvasIO', () => {
  assert.match(canvasIOSource, /async _performSave\(fileName: string, outputMode: string\)/);
  assert.match(canvasIOSource, /tempCanvas\.toDataURL\('image\/png'\)/);
  assert.equal((canvasIOSource.match(/postImageBlob\(/g) ?? []).length, 3);
  assert.match(canvasLayersSource, /async getFlattenedCanvasAsBlob\(\)/);
  assert.match(canvasLayersSource, /async getFlattenedMaskAsBlob\(\)/);
});
