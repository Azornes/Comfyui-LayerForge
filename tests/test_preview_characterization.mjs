import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPreviewFromBlob,
  createPreviewFromCanvas,
} from '../js/utils/PreviewUtils.js';

function installPreviewStubs({ fail = false } = {}) {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalUrl = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  const createdUrls = [];

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class TestImage {
      width = 64;
      height = 32;
      onload = null;
      onerror = null;

      set src(value) {
        this._src = value;
        setTimeout(() => {
          if (fail) {
            this.onerror?.(new Error('preview image decode failed'));
          } else {
            this.onload?.();
          }
        }, 0);
      }

      get src() {
        return this._src;
      }
    },
  });

  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: {
      createObjectURL(blob) {
        const url = `blob:preview-${createdUrls.length + 1}`;
        createdUrls.push({ blob, url });
        return url;
      },
    },
  });

  return {
    createdUrls,
    restore() {
      if (originalImage) {
        Object.defineProperty(globalThis, 'Image', originalImage);
      } else {
        delete globalThis.Image;
      }
      if (originalUrl) {
        Object.defineProperty(globalThis, 'URL', originalUrl);
      } else {
        delete globalThis.URL;
      }
    },
  };
}

test('canvas and Blob preview functions preserve loading and node update behavior', async () => {
  const stubs = installPreviewStubs();
  const blob = new Blob(['preview'], { type: 'image/png' });
  const canvas = {
    canvasLayers: {
      async getFlattenedCanvasAsBlob() {
        return blob;
      },
    },
  };
  const canvasNode = { id: 1, imgs: [] };
  const blobNode = { id: 2, imgs: [] };
  const untouchedNode = { id: 3, imgs: [] };

  try {
    const canvasImage = await createPreviewFromCanvas(canvas, canvasNode, { includeMask: false });
    const blobImage = await createPreviewFromBlob(blob, blobNode, true);
    const untouchedImage = await createPreviewFromBlob(blob, untouchedNode);

    assert.equal(canvasImage.src, 'blob:preview-1');
    assert.equal(blobImage.src, 'blob:preview-2');
    assert.equal(untouchedImage.src, 'blob:preview-3');
    assert.deepEqual(canvasNode.imgs, [canvasImage]);
    assert.deepEqual(blobNode.imgs, [blobImage]);
    assert.deepEqual(untouchedNode.imgs, []);
    assert.equal(stubs.createdUrls.length, 3);
  } finally {
    stubs.restore();
  }
});

test('Blob preview validation and image load failures preserve current errors', async () => {
  const stubs = installPreviewStubs({ fail: true });
  const blob = new Blob(['preview'], { type: 'image/png' });

  try {
    await assert.rejects(
      () => createPreviewFromBlob(new Blob([], { type: 'image/png' })),
      error => error.message === 'Blob cannot be empty'
    );
    await assert.rejects(
      () => createPreviewFromBlob(blob),
      error => error.message === 'Failed to load preview image from blob'
    );
  } finally {
    stubs.restore();
  }
});
