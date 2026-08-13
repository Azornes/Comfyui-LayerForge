import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasIOSource = await readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8');

test('CanvasIO preserves ordered source and backend image identity semantics', () => {
  assert.match(canvasIOSource, /function imageBatchIdentity\(sources: readonly string\[\]\): string/);
  assert.match(canvasIOSource, /function getBackendImageIdentity\(data\?: BackendInputData\): string \| undefined/);
  assert.equal(
    (canvasIOSource.match(/imageBatchIdentity\(sourceNode\.imgs\.map\(/g) ?? []).length,
    2,
  );
  assert.match(canvasIOSource, /getBackendImageIdentity\(result\.data\)/);
  assert.match(canvasIOSource, /getBackendImageIdentity\(inputData\)/);
  assert.doesNotMatch(canvasIOSource, /sourceNode\.imgs\.map\(\(img: HTMLImageElement\) => img\.src\)\.join\('\|'\)/);
  assert.doesNotMatch(canvasIOSource, /input_images_batch\.map\(\(i: any\) => i\.data\)\.join\('\|'\)/);
  assert.match(canvasIOSource, /lastLoadedImageSrc/);
});
