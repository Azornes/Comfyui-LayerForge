import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createImageFromImageData,
  tensorToImageData,
} from '../js/media/ImageUtils.js';

function installImageDataCanvasStubs() {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalImage = globalThis.Image;
  const originalImageData = globalThis.ImageData;
  const output = { pixels: null, source: null };

  globalThis.ImageData = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };

  globalThis.Image = class {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 2;
      this.height = 1;
    }

    set src(value) {
      output.source = value;
      queueMicrotask(() => this.onload?.());
    }
  };

  const context = {
    putImageData(imageData) {
      output.pixels = [...imageData.data];
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
    toDataURL() {
      return 'data:image/png;base64,tensor-image';
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
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
      if (originalImageData === undefined) {
        delete globalThis.ImageData;
      } else {
        globalThis.ImageData = originalImageData;
      }
    },
  };
}

test('tensor to image pipeline preserves RGB pixels and data URL conversion', async () => {
  const stubs = installImageDataCanvasStubs();

  try {
    const imageData = tensorToImageData({
      shape: [1, 1, 2, 3],
      data: new Float32Array([
        0, 0.5, 1,
        1, 0, 0,
      ]),
    }, 'rgb');
    const image = await createImageFromImageData(imageData);

    assert.deepEqual([...imageData.data], [
      0, 128, 255, 255,
      255, 0, 0, 255,
    ]);
    assert.deepEqual(stubs.output.pixels, [...imageData.data]);
    assert.equal(stubs.output.source, 'data:image/png;base64,tensor-image');
    assert.equal(image.width, 2);
    assert.equal(image.height, 1);
  } finally {
    stubs.restore();
  }
});

test('CanvasIO uses one tensor-to-image helper for all RGB image entry points', async () => {
  const source = await readFile(new URL('../src/io/CanvasIO.ts', import.meta.url), 'utf8');

  assert.match(source, /private async tensorToRgbImage\(/);
  assert.doesNotMatch(source, /convertTensorToImageData|createImageFromData/);
  assert.match(source, /const image = await this\.tensorToRgbImage\(inputImage\)/);
  assert.match(source, /const image = await this\.tensorToRgbImage\(tensor\)/);
  assert.match(source, /const image = await this\.tensorToRgbImage\(imageData\)/);
});
