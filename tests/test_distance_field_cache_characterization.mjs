import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasLayersSource = await readFile(
  new URL('../js/canvas/canvas_layers.js', import.meta.url),
  'utf8'
);

function createDistanceFieldMethods(createData, rasterizeMask) {
  const helperStart = canvasLayersSource.indexOf('    getOrCreateDistanceFieldMask(');
  const methodStart = canvasLayersSource.indexOf('    getDistanceFieldMaskSync(');
  const methodEnd = canvasLayersSource.indexOf('\n    getDragSceneCacheKey', methodStart);
  assert.notEqual(helperStart, -1, 'compiled distance-field helper should exist');
  assert.notEqual(methodStart, -1, 'compiled distance-field method should exist');
  assert.notEqual(methodEnd, -1, 'compiled distance-field method should have a following method');

  const helperSource = canvasLayersSource.slice(helperStart, methodStart).trim();
  const methodSource = canvasLayersSource.slice(methodStart, methodEnd).trim();
  return new Function(
    'createDistanceFieldDataSync',
    'rasterizeDistanceFieldMaskSync',
    'log',
    `return {
      getOrCreateDistanceFieldMask: ({ ${helperSource} }).getOrCreateDistanceFieldMask,
      getDistanceFieldMaskSync: ({ ${methodSource} }).getDistanceFieldMaskSync,
    };`,
  )(createData, rasterizeMask, { info() {}, error() {} });
}

test('distance-field cache reuses geometry and one mask canvas per source', () => {
  const originalCanvasElement = globalThis.HTMLCanvasElement;
  class CanvasStub {}
  globalThis.HTMLCanvasElement = CanvasStub;

  const calls = [];
  const createData = (source) => {
    const maskCanvas = { source };
    calls.push({ type: 'data', source });
    return {
      width: 8,
      height: 6,
      distanceField: new Float32Array(48),
      binaryMask: null,
      maxDistance: 10,
      maskCanvas,
    };
  };
  const rasterizeMask = (data, blendArea) => {
    calls.push({ type: 'mask', source: data.maskCanvas.source, blendArea });
    return data.maskCanvas;
  };
  const methods = createDistanceFieldMethods(createData, rasterizeMask);
  const context = {
    _canvasMaskCache: new WeakMap(),
    distanceFieldCache: new WeakMap(),
    getOrCreateDistanceFieldMask: methods.getOrCreateDistanceFieldMask,
  };
  const image = { width: 8, height: 6 };
  const canvas = new CanvasStub();

  try {
    const imageMask = methods.getDistanceFieldMaskSync.call(context, image, 25);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 25), imageMask);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, image, 50), imageMask);

    const canvasMask = methods.getDistanceFieldMaskSync.call(context, canvas, 25);
    assert.equal(methods.getDistanceFieldMaskSync.call(context, canvas, 25), canvasMask);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map(({ type, source, blendArea }) => [type, source, blendArea]), [
      ['data', image, undefined],
      ['mask', image, 25],
      ['mask', image, 50],
      ['data', canvas, undefined],
      ['mask', canvas, 25],
    ]);
  } finally {
    if (originalCanvasElement === undefined) {
      delete globalThis.HTMLCanvasElement;
    } else {
      globalThis.HTMLCanvasElement = originalCanvasElement;
    }
  }
});

test('distance-field cache does not retain failed geometry creation', () => {
  const originalCanvasElement = globalThis.HTMLCanvasElement;
  class CanvasStub {}
  globalThis.HTMLCanvasElement = CanvasStub;

  let attempts = 0;
  const methods = createDistanceFieldMethods(() => {
    attempts += 1;
    throw new Error('distance-field creation failed');
  }, () => {
    throw new Error('mask rasterization should not run');
  });
  const context = {
    _canvasMaskCache: new WeakMap(),
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
