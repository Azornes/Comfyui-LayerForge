import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasLayersSource = await readFile(
  new URL('../js/canvas/canvas_layers.js', import.meta.url),
  'utf8'
);

function createDistanceFieldMethods(createMask) {
  const helperStart = canvasLayersSource.indexOf('    getOrCreateDistanceFieldMask(');
  const methodStart = canvasLayersSource.indexOf('    getDistanceFieldMaskSync(');
  const methodEnd = canvasLayersSource.indexOf('\n    _drawLayers', methodStart);
  assert.notEqual(helperStart, -1, 'compiled distance-field helper should exist');
  assert.notEqual(methodStart, -1, 'compiled distance-field method should exist');
  assert.notEqual(methodEnd, -1, 'compiled distance-field method should have a following method');

  const helperSource = canvasLayersSource.slice(helperStart, methodStart).trim();
  const methodSource = canvasLayersSource.slice(methodStart, methodEnd).trim();
  return new Function(
    'createDistanceFieldMaskSync',
    'log',
    `return {
      getOrCreateDistanceFieldMask: ({ ${helperSource} }).getOrCreateDistanceFieldMask,
      getDistanceFieldMaskSync: ({ ${methodSource} }).getDistanceFieldMaskSync,
    };`,
  )(createMask, { info() {}, error() {} });
}

test('distance-field cache preserves image/canvas ownership and blend-area keys', () => {
  const originalCanvasElement = globalThis.HTMLCanvasElement;
  class CanvasStub {}
  globalThis.HTMLCanvasElement = CanvasStub;

  const calls = [];
  const createMask = (source, blendArea) => {
    calls.push({ source, blendArea });
    return { source, blendArea, width: 8, height: 6 };
  };
  const methods = createDistanceFieldMethods(createMask);
  const context = {
    _canvasMaskCache: new Map(),
    distanceFieldCache: new WeakMap(),
    getOrCreateDistanceFieldMask: methods.getOrCreateDistanceFieldMask,
  };
  const image = { width: 8, height: 6 };
  const canvas = new CanvasStub();

  try {
    const imageMask = methods.getDistanceFieldMaskSync.call(context, image, 25);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 25), imageMask);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 50).blendArea, 50);

    const canvasMask = methods.getDistanceFieldMaskSync.call(context, canvas, 25);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, canvas, 25), canvasMask);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(({ source, blendArea }) => [source, blendArea]), [
      [image, 25],
      [image, 50],
      [canvas, 25],
    ]);
  } finally {
    if (originalCanvasElement === undefined) {
      delete globalThis.HTMLCanvasElement;
    } else {
      globalThis.HTMLCanvasElement = originalCanvasElement;
    }
  }
});

test('distance-field cache does not retain failed mask creation', () => {
  const originalCanvasElement = globalThis.HTMLCanvasElement;
  class CanvasStub {}
  globalThis.HTMLCanvasElement = CanvasStub;

  let attempts = 0;
  const methods = createDistanceFieldMethods(() => {
    attempts += 1;
    throw new Error('distance-field creation failed');
  });
  const context = {
    _canvasMaskCache: new Map(),
    distanceFieldCache: new WeakMap(),
    getOrCreateDistanceFieldMask: methods.getOrCreateDistanceFieldMask,
  };

  try {
    const image = {};
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 25), null);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 25), null);
    assert.equal(attempts, 2);
  } finally {
    if (originalCanvasElement === undefined) {
      delete globalThis.HTMLCanvasElement;
    } else {
      globalThis.HTMLCanvasElement = originalCanvasElement;
    }
  }
});
