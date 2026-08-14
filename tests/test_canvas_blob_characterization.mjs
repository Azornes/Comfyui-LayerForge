import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getFlattenedCanvasBlob,
  resolveCanvasBlob,
  supportsFlattenedCanvasBlob,
} from '../js/media/CanvasBlobUtils.js';
import { createPreviewFromCanvas } from '../js/media/PreviewUtils.js';

const sourceFiles = await Promise.all([
  readFile(new URL('../src/media/ImageUploadUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/media/PreviewUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/mask/MaskEditorIntegration.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/CanvasView.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/media/CanvasBlobUtils.ts', import.meta.url), 'utf8'),
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

test('canvas blob resolver distinguishes flattened, native, and unsupported sources', async () => {
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
    const flattened = await resolveCanvasBlob({
      canvasLayers: {
        async getFlattenedCanvasAsBlob() {
          return 'flattened-blob';
        },
      },
    }, 'plain');
    assert.deepEqual(flattened, { source: 'flattened', blob: 'flattened-blob' });

    const native = await resolveCanvasBlob(new TestCanvas(), 'plain', {
      allowNativeCanvasFallback: true,
    });
    assert.deepEqual(native, { source: 'native', blob: 'native-blob' });

    const unsupported = await resolveCanvasBlob({}, 'with-mask');
    assert.deepEqual(unsupported, { source: 'unsupported', blob: null });
  } finally {
    if (originalCanvas) {
      Object.defineProperty(globalThis, 'HTMLCanvasElement', originalCanvas);
    } else {
      delete globalThis.HTMLCanvasElement;
    }
  }
});

test('canvas blob callers preserve plain and mask method responsibilities', () => {
  const [imageUploadSource, previewSource, maskEditorSource, canvasViewSource, blobUtilsSource] = sourceFiles;

  assert.match(imageUploadSource, /resolveCanvasBlob\(canvas, config\.variant/);
  assert.doesNotMatch(imageUploadSource, /getFlattenedCanvasBlob\(canvas, config\.variant\)/);
  assert.match(imageUploadSource, /variant: 'plain'/);
  assert.match(imageUploadSource, /variant: 'with-mask'/);
  assert.match(imageUploadSource, /allowNativeCanvasFallback: true/);
  assert.match(imageUploadSource, /allowNativeCanvasFallback: false/);
  assert.match(previewSource, /resolveCanvasBlob\(canvas, variant\)/);
  assert.doesNotMatch(previewSource, /getFlattenedCanvasBlob\(canvas, variant\)/);
  assert.match(previewSource, /supportsFlattenedCanvasBlob\(canvas, 'with-mask'\)/);
  assert.match(maskEditorSource, /getFlattenedCanvasBlob\(this\.canvas, 'plain'\)/);
  assert.match(maskEditorSource, /getFlattenedCanvasBlob\(this\.canvas, 'with-mask'\)/);
  assert.match(canvasViewSource, /getFlattenedCanvasBlob\(canvas, 'with-mask'\)/);
  assert.match(blobUtilsSource, /getFlattenedCanvasAsBlob/);
  assert.match(blobUtilsSource, /getFlattenedCanvasWithMaskAsBlob/);
  assert.match(blobUtilsSource, /export async function resolveCanvasBlob/);
});

test('CanvasView preserves size-dependent preview loading strategies', () => {
  const canvasViewSource = sourceFiles[3];

  assert.match(canvasViewSource, /blob\.size > 2 \* 1024 \* 1024/);
  assert.match(canvasViewSource, /loadPreviewImage\(blob, \{[\s\S]*urlMode: 'object-url'/);
  assert.match(canvasViewSource, /loadPreviewImage\(blob, \{[\s\S]*urlMode: 'data-url'/);
});
