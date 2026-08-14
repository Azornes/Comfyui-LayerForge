import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyMaskResultToTool,
  createMaskImageFromResult,
} from '../js/mask/mask_result_utils.js';

function installMaskConversionStubs(sourcePixels) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalImage = globalThis.Image;
  const originalHtmlImageElement = globalThis.HTMLImageElement;
  const output = { data: null };

  class ImageElementStub {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 2;
      this.height = 1;
    }

    set src(value) {
      this.srcValue = value;
      queueMicrotask(() => this.onload?.());
    }
  }

  globalThis.HTMLImageElement = ImageElementStub;
  globalThis.Image = ImageElementStub;

  const context = {
    drawImage() {},
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
    toDataURL() {
      return 'data:image/png;base64,mask-result';
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
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
      if (originalImage === undefined) {
        delete globalThis.Image;
      } else {
        globalThis.Image = originalImage;
      }
      if (originalHtmlImageElement === undefined) {
        delete globalThis.HTMLImageElement;
      } else {
        globalThis.HTMLImageElement = originalHtmlImageElement;
      }
    },
  };
}

test('mask result conversion preserves target size, transformed pixels, and image loading', async () => {
  const stubs = installMaskConversionStubs([
    10, 20, 30, 0,
    40, 50, 60, 128,
  ]);

  try {
    const source = { width: 2, height: 1 };
    const maskImage = await createMaskImageFromResult(source, {
      targetWidth: 2,
      targetHeight: 1,
      invertAlpha: true,
    });

    assert.equal(maskImage.width, 2);
    assert.equal(maskImage.height, 1);
    assert.deepEqual([...stubs.output.data], [
      255, 255, 255, 255,
      255, 255, 255, 127,
    ]);
    assert.equal(maskImage.srcValue, 'data:image/png;base64,mask-result');
  } finally {
    stubs.restore();
  }
});

test('mask result application processes before resolving and updating the target tool', async () => {
  const stubs = installMaskConversionStubs([
    10, 20, 30, 0,
    40, 50, 60, 128,
  ]);
  const appliedMasks = [];

  try {
    const result = await applyMaskResultToTool(
      { width: 2, height: 1 },
      { targetWidth: 2, targetHeight: 1, invertAlpha: true },
      () => ({
        setMask(mask) {
          appliedMasks.push(mask);
        },
      })
    );

    assert.deepEqual(appliedMasks, [result]);
    assert.deepEqual([...stubs.output.data], [
      255, 255, 255, 255,
      255, 255, 255, 127,
    ]);
  } finally {
    stubs.restore();
  }
});

test('mask integrations share conversion but retain their own side effects', async () => {
  const processingSource = await readFile(new URL('../src/mask/mask_processing_utils.ts', import.meta.url), 'utf8');
  const resultSource = await readFile(new URL('../src/mask/mask_result_utils.ts', import.meta.url), 'utf8');
  const maskEditorSource = await readFile(new URL('../src/mask/mask_editor_integration.ts', import.meta.url), 'utf8');
  const samSource = await readFile(new URL('../src/mask/sam_detector_integration.ts', import.meta.url), 'utf8');

  assert.match(resultSource, /from "\.\/mask_processing_utils\.js"/);
  assert.match(resultSource, /export async function applyMaskResultToTool/);
  assert.doesNotMatch(processingSource, /createMaskImageFromResult|applyMaskResultToTool/);
  assert.match(maskEditorSource, /from "\.\/mask_result_utils\.js"/);
  assert.match(samSource, /from "\.\/mask_result_utils\.js"/);
  assert.match(maskEditorSource, /applyMaskResultToTool\(/);
  assert.match(samSource, /applyMaskResultToTool\(/);
  assert.doesNotMatch(maskEditorSource, /processImageToMask|convertToImage/);
  assert.doesNotMatch(samSource, /processImageToMask|convertToImage/);
  assert.doesNotMatch(maskEditorSource, /setMask\(maskAsImage\)/);
  assert.doesNotMatch(samSource, /setMask\(maskAsImage\)/);
  assert.match(maskEditorSource, /targetWidth: bounds\.width/);
  assert.match(samSource, /targetWidth: resultImage\.width/);
  assert.match(samSource, /actualCanvas\.render\(\)/);
  assert.match(samSource, /actualCanvas\.saveState\(\)/);
});
