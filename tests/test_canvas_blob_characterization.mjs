import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getFlattenedCanvasBlob,
  supportsFlattenedCanvasBlob,
} from '../js/utils/CanvasBlobUtils.js';
import { createPreviewFromCanvas } from '../js/utils/PreviewUtils.js';

const sourceFiles = await Promise.all([
  readFile(new URL('../src/utils/ImageUploadUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/PreviewUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/MaskEditorIntegration.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/CanvasBlobUtils.ts', import.meta.url), 'utf8'),
]);

function installPreviewStubs() {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const originalUrl = Object.getOwnPropertyDescriptor(globalThis, 'URL');

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class TestImage {
      width = 64;
      height = 32;
      onload = null;
      onerror = null;

      set src(value) {
        this._src = value;
        setTimeout(() => this.onload?.(), 0);
      }

      get src() {
        return this._src;
      }
    },
  });

  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: {
      createObjectURL() {
        return 'blob:test-preview';
      },
    },
  });

  return () => {
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
  };
}

test('createPreviewFromCanvas selects mask, plain, and plain fallback variants', async () => {
  const restore = installPreviewStubs();
  const calls = [];
  const canvas = {
    canvasLayers: {
      async getFlattenedCanvasAsBlob() {
        calls.push('plain');
        return new Blob(['plain'], { type: 'image/png' });
      },
      async getFlattenedCanvasWithMaskAsBlob() {
        calls.push('with-mask');
        return new Blob(['with-mask'], { type: 'image/png' });
      },
    },
  };

  try {
    const node = { id: 1, imgs: [] };
    await createPreviewFromCanvas(canvas, node);
    await createPreviewFromCanvas(canvas, node, { includeMask: false });

    delete canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob;
    await createPreviewFromCanvas(canvas, node, { includeMask: true });

    assert.deepEqual(calls, ['with-mask', 'plain', 'plain']);
    assert.equal(node.imgs.length, 1);
  } finally {
    restore();
  }
});

test('shared canvas blob dispatcher maps variants and reports support', async () => {
  const calls = [];
  const canvas = {
    canvasLayers: {
      async getFlattenedCanvasAsBlob() {
        calls.push('plain');
        return 'plain-blob';
      },
      async getFlattenedCanvasWithMaskAsBlob() {
        calls.push('with-mask');
        return 'masked-blob';
      },
    },
  };

  assert.equal(supportsFlattenedCanvasBlob(canvas, 'plain'), true);
  assert.equal(supportsFlattenedCanvasBlob(canvas, 'with-mask'), true);
  assert.equal(await getFlattenedCanvasBlob(canvas, 'plain'), 'plain-blob');
  assert.equal(await getFlattenedCanvasBlob(canvas, 'with-mask'), 'masked-blob');
  assert.deepEqual(calls, ['plain', 'with-mask']);

  delete canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob;
  assert.equal(supportsFlattenedCanvasBlob(canvas, 'with-mask'), false);
});

test('canvas blob callers preserve plain and mask method responsibilities', () => {
  const [imageUploadSource, previewSource, maskEditorSource, canvasViewSource, blobUtilsSource] = sourceFiles;

  assert.match(imageUploadSource, /getFlattenedCanvasBlob\(canvas, config\.variant\)/);
  assert.match(imageUploadSource, /variant: 'plain'/);
  assert.match(imageUploadSource, /variant: 'with-mask'/);
  assert.match(imageUploadSource, /allowNativeCanvasFallback: true/);
  assert.match(imageUploadSource, /allowNativeCanvasFallback: false/);
  assert.match(previewSource, /getFlattenedCanvasBlob\(canvas, variant\)/);
  assert.match(previewSource, /supportsFlattenedCanvasBlob\(canvas, 'with-mask'\)/);
  assert.match(maskEditorSource, /getFlattenedCanvasBlob\(this\.canvas, 'plain'\)/);
  assert.match(maskEditorSource, /getFlattenedCanvasBlob\(this\.canvas, 'with-mask'\)/);
  assert.match(canvasViewSource, /getFlattenedCanvasBlob\(canvas, 'with-mask'\)/);
  assert.match(blobUtilsSource, /getFlattenedCanvasAsBlob/);
  assert.match(blobUtilsSource, /getFlattenedCanvasWithMaskAsBlob/);
});
