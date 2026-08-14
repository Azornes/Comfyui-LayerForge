import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [canvasIOSource, maskEditorSource] = await Promise.all([
  readFile(new URL('../src/io/CanvasIO.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/mask/MaskEditorIntegration.ts', import.meta.url), 'utf8'),
]);

function getMethodBody(source, methodName, nextMethodName) {
  const start = source.indexOf(`async ${methodName}`);
  const end = source.indexOf(`async ${nextMethodName}`, start);

  assert.notEqual(start, -1, `${methodName} should exist`);
  assert.notEqual(end, -1, `${nextMethodName} should exist after ${methodName}`);
  return source.slice(start, end);
}

test('batch input paths share one layer insertion helper', () => {
  assert.match(
    canvasIOSource,
    /private async addBatchImages\([\s\S]*?const image = typeof imageSource === 'string' \? await loadImage\(imageSource\) : imageSource;[\s\S]*?name: `Batch Image \$\{i \+ 1\}`[\s\S]*?targetArea/
  );
  assert.equal((canvasIOSource.match(/await this\.addBatchImages\(/g) ?? []).length, 3);
  assert.equal((canvasIOSource.match(/await this\.canvas\.canvasLayers\.addLayerWithImage\(/g) ?? []).length, 5);
  assert.match(canvasIOSource, /async addSelectedInputImage\(/);
  assert.doesNotMatch(canvasIOSource, /for \(let i = 0; i < sourceNode\.imgs\.length; i\+\+\)/);
  assert.doesNotMatch(canvasIOSource, /for \(let i = 0; i < batch\.length; i\+\+\)/);
});

test('mask editor variants share one drawing helper but retain their own side effects', () => {
  const newEditorBody = getMethodBody(maskEditorSource, 'applyMaskToNewEditor', 'applyMaskToOldEditor');
  const oldEditorBody = getMethodBody(maskEditorSource, 'applyMaskToOldEditor', 'processMaskForEditor');

  for (const body of [newEditorBody, oldEditorBody]) {
    assert.match(body, /await this\.renderProcessedMask\(maskData, maskCanvas, maskCtx, maskColor\)/);
  }

  assert.match(newEditorBody, /messageBroker\.publish\('saveState'\)/);
  assert.doesNotMatch(oldEditorBody, /messageBroker\.publish\('saveState'\)/);
  assert.match(maskEditorSource, /private async renderProcessedMask\(/);
  assert.equal(
    (maskEditorSource.match(/maskCtx\.clearRect\(0, 0, maskCanvas\.width, maskCanvas\.height\)/g) ?? []).length,
    1
  );
  assert.equal(
    (maskEditorSource.match(/maskCtx\.drawImage\(processedMask, 0, 0\)/g) ?? []).length,
    1
  );
});
