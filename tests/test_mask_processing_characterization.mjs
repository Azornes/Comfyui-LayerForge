import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorTypes } from '../js/ErrorHandler.js';
import {
  processImageToMask,
  processImageWithTransform,
} from '../js/utils/MaskProcessingUtils.js';

function installCanvasStub(sourcePixels) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const output = { data: null };
  const drawCalls = [];
  const context = {
    drawImage(...args) {
      drawCalls.push(args);
    },
    getImageData(_x, _y, width, height) {
      return {
        width,
        height,
        data: new Uint8ClampedArray(sourcePixels),
      };
    },
    putImageData(imageData) {
      output.data = new Uint8ClampedArray(imageData.data);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
        return canvas;
      },
    },
  });

  return {
    output,
    drawCalls,
    restore() {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        delete globalThis.document;
      }
    },
  };
}

test('processImageToMask preserves dimensions, draw arguments, mask color, and alpha polarity', async () => {
  const stubs = installCanvasStub([
    10, 20, 30, 0,
    40, 50, 60, 128,
  ]);

  try {
    const source = { width: 2, height: 1 };
    const result = await processImageToMask(source, {
      targetWidth: 2,
      targetHeight: 1,
      invertAlpha: true,
      maskColor: { r: 7, g: 8, b: 9 },
    });

    assert.equal(result.width, 2);
    assert.equal(result.height, 1);
    assert.deepEqual(stubs.drawCalls, [[source, 0, 0, 2, 1]]);
    assert.deepEqual([...stubs.output.data], [
      7, 8, 9, 255,
      7, 8, 9, 127,
    ]);
  } finally {
    stubs.restore();
  }
});

test('processImageToMask keeps alpha when inversion is disabled', async () => {
  const stubs = installCanvasStub([10, 20, 30, 64]);

  try {
    await processImageToMask({ width: 1, height: 1 }, {
      invertAlpha: false,
      maskColor: { r: 1, g: 2, b: 3 },
    });

    assert.deepEqual([...stubs.output.data], [1, 2, 3, 64]);
  } finally {
    stubs.restore();
  }
});

test('processImageWithTransform passes original pixels and index to the transform', async () => {
  const stubs = installCanvasStub([
    10, 20, 30, 40,
    50, 60, 70, 80,
  ]);
  const seen = [];

  try {
    await processImageWithTransform(
      { width: 2, height: 1 },
      (r, g, b, a, index) => {
        seen.push([r, g, b, a, index]);
        return [b, g, r, a + index];
      }
    );

    assert.deepEqual(seen, [
      [10, 20, 30, 40, 0],
      [50, 60, 70, 80, 1],
    ]);
    assert.deepEqual([...stubs.output.data], [
      30, 20, 10, 40,
      70, 60, 50, 81,
    ]);
  } finally {
    stubs.restore();
  }
});

test('mask pixel processors preserve validation errors', async () => {
  await assert.rejects(
    () => processImageToMask(null),
    error => error.type === ErrorTypes.VALIDATION && error.message === 'Source image is required'
  );
  await assert.rejects(
    () => processImageWithTransform({ width: 1, height: 1 }, null),
    error => error.type === ErrorTypes.VALIDATION && error.message === 'Pixel transform function is required'
  );
});
