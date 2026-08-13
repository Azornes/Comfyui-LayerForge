import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function installCanvasStub(sourceAlpha) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const output = { data: null };
  const context = {
    clearRect() {},
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    drawImage() {},
    getImageData(_x, _y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < sourceAlpha.length; i++) {
        data[i * 4 + 3] = sourceAlpha[i];
      }
      return { width, height, data };
    },
    putImageData(imageData) {
      output.data = imageData.data;
    },
  };
  const canvas = {
    height: 0,
    width: 0,
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
    restore() {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        delete globalThis.document;
      }
    },
  };
}

test('distance-field mask preserves alpha-distance behavior for transparent pixels', async () => {
  const stubs = installCanvasStub([255, 128, 0]);

  try {
    const { createDistanceFieldMaskSync } = await import('../js/utils/ImageAnalysis.js?characterization');
    createDistanceFieldMaskSync({ width: 3, height: 1 }, 100);

    assert.deepEqual([...stubs.output.data], [
      255, 255, 255, 255,
      255, 255, 255, 127,
      255, 255, 255, 0,
    ]);
  } finally {
    stubs.restore();
  }
});

test('mask consumers use one shared distance transform implementation', async () => {
  const { calculateDistanceTransform } = await import('../js/utils/MaskPixelUtils.js?characterization');
  const imageAnalysisSource = await readFile(new URL('../src/utils/ImageAnalysis.ts', import.meta.url), 'utf8');
  const maskToolSource = await readFile(new URL('../src/MaskTool.ts', import.meta.url), 'utf8');

  assert.deepEqual(
    [...calculateDistanceTransform(new Uint8Array([1, 1, 0]), 3, 1)],
    [2, 1, 0],
  );
  assert.match(imageAnalysisSource, /from "\.\/MaskPixelUtils\.js"/);
  assert.match(maskToolSource, /from "\.\/utils\/MaskPixelUtils\.js"/);
  assert.match(maskToolSource, /calculateDistanceTransform\(binaryData, width, height\)/);
  assert.doesNotMatch(imageAnalysisSource, /function calculateDistanceTransform\(/);
  assert.doesNotMatch(maskToolSource, /private _fastDistanceTransform\(/);
});
