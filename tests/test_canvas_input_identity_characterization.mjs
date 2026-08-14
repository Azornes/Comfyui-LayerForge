import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [canvasIOSource, canvasSource] = await Promise.all([
  readFile(new URL('../src/io/CanvasIO.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/canvas/Canvas.ts', import.meta.url), 'utf8'),
]);

test('CanvasIO preserves ordered source and backend image identity semantics', () => {
  assert.match(canvasIOSource, /function imageBatchIdentity\(sources: readonly string\[\]\): string/);
  assert.match(canvasIOSource, /function getBackendImageIdentity\(data\?: BackendInputData\): string \| undefined/);
  assert.equal(
    (canvasIOSource.match(/imageBatchIdentity\([\s\S]*?sourceNode\.imgs\.map\(/g) ?? []).length,
    2,
  );
  assert.match(canvasIOSource, /getBackendImageIdentity\(result\.data\)/);
  assert.match(canvasIOSource, /getBackendImageIdentity\(inputData\)/);
  assert.doesNotMatch(canvasIOSource, /sourceNode\.imgs\.map\(\(img: HTMLImageElement\) => img\.src\)\.join\('\|'\)/);
  assert.doesNotMatch(canvasIOSource, /input_images_batch\.map\(\(i: any\) => i\.data\)\.join\('\|'\)/);
  assert.match(canvasIOSource, /lastLoadedImageSrc/);
});

test('automatic input loading waits for restored state and skips existing canvas images', () => {
  assert.match(canvasSource, /initialStateLoaded: boolean/);
  assert.match(canvasSource, /this\.canvasIO\.checkForInputData\(\{[\s\S]*reason: 'initial_state_loaded'/);
  assert.match(canvasSource, /this\.canvasIO\.initNodeData\(\)/);
  assert.match(canvasIOSource, /private _inputDataCheckPromise: Promise<void> \| null/);
  assert.match(canvasIOSource, /private async checkForInputDataInternal/);
  assert.match(canvasIOSource, /if \(!this\.canvas\.initialStateLoaded\)/);
  assert.match(canvasIOSource, /getCanvasImageIdentities\(\)/);
  assert.match(canvasIOSource, /layerForgeInputImageIdentity/);
  assert.match(canvasIOSource, /Skipping already imported input image/);
});
