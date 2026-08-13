import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMaskToImageData,
  convertImageData,
  loadImage,
  prepareImageForCanvas,
  tensorToImageData,
  validateImageData,
} from '../js/utils/ImageUtils.js';
import { ErrorTypes } from '../js/ErrorHandler.js';

test('image validation accepts tensor-like payloads and normalizes array data', () => {
  const payload = [{
    shape: [1, 1, 1, 3],
    data: [0.1, 0.2, 0.3],
  }];

  assert.equal(validateImageData(payload), true);
  assert.ok(payload[0].data instanceof Float32Array);
  assert.equal(validateImageData(null), false);
  assert.equal(validateImageData({ shape: [1, 1, 1, 3] }), false);
});

test('image conversion maps RGB values and mask values to RGBA bytes', () => {
  const image = convertImageData({
    shape: [1, 1, 2, 3],
    data: new Float32Array([0, 0.5, 1, 1, 0, 0]),
  });

  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual([...image.data], [0, 128, 255, 255, 255, 0, 0, 255]);

  const masked = applyMaskToImageData(image, {
    shape: [1, 1, 2, 1],
    data: new Float32Array([0, 0.5]),
  });
  assert.deepEqual([...masked.data], [0, 128, 255, 0, 255, 0, 0, 128]);
});

test('prepareImageForCanvas returns pixels and reports validation errors', async () => {
  const result = await prepareImageForCanvas({
    shape: [1, 1, 1, 3],
    data: new Float32Array([0.25, 0.5, 0.75]),
  });

  assert.deepEqual([...result.data], [64, 128, 191, 255]);

  await assert.rejects(
    () => prepareImageForCanvas(null),
    error => error.type === ErrorTypes.VALIDATION && error.message === 'Invalid input image format'
  );
});

test('convertImageData and prepareImageForCanvas preserve identical RGB conversion semantics', async () => {
  const tensor = {
    shape: [1, 1, 2, 3],
    data: new Float32Array([-0.1, 0.5, 1.2, 0.25, 0.5, 0.75]),
  };

  const converted = convertImageData(tensor);
  const prepared = await prepareImageForCanvas([tensor]);

  assert.equal(converted.width, prepared.width);
  assert.equal(converted.height, prepared.height);
  assert.deepEqual([...converted.data], [...prepared.data]);
});

test('tensorToImageData supports grayscale masks without a browser canvas', () => {
  const originalImageData = globalThis.ImageData;
  globalThis.ImageData = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };

  try {
    const imageData = tensorToImageData({
      shape: [1, 1, 2, 1],
      data: new Float32Array([0, 1]),
    }, 'grayscale');

    assert.deepEqual([...imageData.data], [0, 0, 0, 255, 255, 255, 255, 255]);
  } finally {
    if (originalImageData === undefined) {
      delete globalThis.ImageData;
    } else {
      globalThis.ImageData = originalImageData;
    }
  }
});

test('image loading resolves loaded images and preserves load errors', async () => {
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 4;
      this.height = 3;
    }

    set src(value) {
      this.source = value;
      queueMicrotask(() => {
        if (value === 'bad-image') {
          this.onerror?.(new Error('image decode failed'));
        } else {
          this.onload?.();
        }
      });
    }
  };

  try {
    const image = await loadImage('good-image');
    assert.equal(image.source, 'good-image');
    assert.equal(image.width, 4);
    assert.equal(image.height, 3);

    await assert.rejects(
      () => loadImage('bad-image'),
      error => error.message === 'image decode failed'
    );
  } finally {
    if (originalImage === undefined) {
      delete globalThis.Image;
    } else {
      globalThis.Image = originalImage;
    }
  }
});
