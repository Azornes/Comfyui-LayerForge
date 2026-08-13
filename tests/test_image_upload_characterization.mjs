import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveCanvasBlob } from '../js/utils/CanvasBlobUtils.js';

const source = await readFile(
  new URL('../src/utils/ImageUploadUtils.ts', import.meta.url),
  'utf8'
);
function getFunctionBody(functionName, nextFunctionName) {
  const start = [
    source.indexOf(`export const ${functionName}`),
    source.indexOf(`async function ${functionName}`),
  ].find((index) => index !== -1);
  const end = source.indexOf(`export const ${nextFunctionName}`, start);

  assert.notEqual(start, -1, `${functionName} should exist`);
  assert.notEqual(end, -1, `${nextFunctionName} should exist after ${functionName}`);
  return source.slice(start, end);
}

test('canvas upload variants share blob selection while preserving their policies', () => {
  const plainBody = getFunctionBody('uploadCanvasAsImage', 'uploadCanvasWithMaskAsImage');
  const maskedBody = source.slice(source.indexOf('export const uploadCanvasWithMaskAsImage'));

  assert.match(source, /resolveCanvasBlob\(canvas, config\.variant/);

  assert.match(plainBody, /variant: 'plain'/);
  assert.match(plainBody, /allowNativeCanvasFallback: true/);
  assert.match(plainBody, /unsupportedCanvasMessage: "Unsupported canvas type"/);
  assert.match(plainBody, /emptyBlobMessage: "Failed to generate canvas blob"/);
  assert.match(plainBody, /return uploadImageBlob\(blob, options\)/);

  assert.match(maskedBody, /variant: 'with-mask'/);
  assert.match(maskedBody, /allowNativeCanvasFallback: false/);
  assert.match(maskedBody, /unsupportedCanvasMessage: "Canvas does not support mask operations"/);
  assert.match(maskedBody, /emptyBlobMessage: "Failed to generate canvas with mask blob"/);
  assert.match(maskedBody, /return uploadImageBlob\(blob, options\)/);
});

test('canvas upload public wrappers retain their error-handling contexts', () => {
  assert.match(source, /\}, 'uploadCanvasAsImage'\);/);
  assert.match(source, /\}, 'uploadCanvasWithMaskAsImage'\);/);
  assert.equal((source.match(/return uploadImageBlob\(blob, options\)/g) ?? []).length, 2);
});

test('current canvas upload resolver preserves layer, native, and error behavior', async () => {
  const originalCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement');
  class TestCanvas {
    toBlob(resolve) {
      resolve('native-blob');
    }
  }
  Object.defineProperty(globalThis, 'HTMLCanvasElement', {
    configurable: true,
    value: TestCanvas,
  });

  try {
    const layerResolution = await resolveCanvasBlob({
      canvasLayers: {
        async getFlattenedCanvasAsBlob() {
          return 'layer-blob';
        },
      },
    }, 'plain');
    assert.deepEqual(layerResolution, { source: 'flattened', blob: 'layer-blob' });

    const nativeResolution = await resolveCanvasBlob(new TestCanvas(), 'plain', {
      allowNativeCanvasFallback: true,
    });
    assert.deepEqual(nativeResolution, { source: 'native', blob: 'native-blob' });

    const unsupportedResolution = await resolveCanvasBlob({}, 'with-mask');
    assert.deepEqual(unsupportedResolution, { source: 'unsupported', blob: null });

    const emptyResolution = await resolveCanvasBlob({
      canvasLayers: {
        async getFlattenedCanvasAsBlob() {
          return null;
        },
      },
    }, 'plain');
    assert.deepEqual(emptyResolution, { source: 'flattened', blob: null });
  } finally {
    if (originalCanvas) {
      Object.defineProperty(globalThis, 'HTMLCanvasElement', originalCanvas);
    } else {
      delete globalThis.HTMLCanvasElement;
    }
  }
});
