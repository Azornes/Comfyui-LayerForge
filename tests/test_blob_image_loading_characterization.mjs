import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { blobToDataUrl, loadImageFromBlob } from '../js/utils/ImageUtils.js';

const sourceFiles = await Promise.all([
  readFile(new URL('../src/utils/ImageUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/ClipboardManager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasInteractions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasLayers.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8'),
]);

test('Blob and File image entry points use the shared loading helpers', () => {
  const [imageUtilsSource, clipboardSource, interactionsSource, viewSource, layersSource, ioSource] = sourceFiles;
  const consumerSources = [clipboardSource, interactionsSource, viewSource, layersSource, ioSource];

  assert.match(imageUtilsSource, /export function blobToDataUrl\(/);
  assert.match(imageUtilsSource, /export async function loadImageFromBlob\(/);
  assert.ok(consumerSources.every(source => !source.includes('readAsDataURL(')));
  assert.match(clipboardSource, /loadImageFromBlob\(blob\)/);
  assert.match(clipboardSource, /loadImageFromBlob\(file\)/);
  assert.match(interactionsSource, /loadImageFromBlob\(file\)/);
  assert.match(viewSource, /loadImageFromBlob\(file\)/);
  assert.match(viewSource, /loadPreviewImage\(blob,/);
  assert.match(layersSource, /blobToDataUrl\(blob\)/);
  assert.match(ioSource, /blobToDataUrl\(imageBlob\)/);
  assert.match(ioSource, /blobToDataUrl\(maskBlob\)/);
});

test('shared Blob helpers preserve data URL conversion and image loading options', async () => {
  const originalFileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');

  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class TestFileReader {
      result = null;
      onload = null;
      onerror = null;

      readAsDataURL(blob) {
        if (blob.type === 'image/error') {
          queueMicrotask(() => this.onerror?.(new Error('file read failed')));
          return;
        }
        this.result = `data:${blob.type};base64,encoded`;
        queueMicrotask(() => this.onload?.());
      }
    },
  });

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class TestImage {
      onload = null;
      onerror = null;
      crossOrigin = '';

      set src(value) {
        this.source = value;
        queueMicrotask(() => {
          if (value.includes('image/bad')) {
            this.onerror?.(new Error('image decode failed'));
          } else {
            this.onload?.();
          }
        });
      }

      get src() {
        return this.source;
      }
    },
  });

  try {
    const blob = new Blob(['image'], { type: 'image/png' });
    assert.equal(await blobToDataUrl(blob), 'data:image/png;base64,encoded');

    const image = await loadImageFromBlob(blob, { crossOrigin: 'anonymous' });
    assert.equal(image.src, 'data:image/png;base64,encoded');
    assert.equal(image.crossOrigin, 'anonymous');

    await assert.rejects(
      () => blobToDataUrl(new Blob(['bad'], { type: 'image/error' })),
      error => error.message === 'file read failed'
    );
    await assert.rejects(
      () => loadImageFromBlob(new Blob(['bad'], { type: 'image/bad' })),
      error => error.message === 'image decode failed'
    );
  } finally {
    if (originalFileReader) {
      Object.defineProperty(globalThis, 'FileReader', originalFileReader);
    } else {
      delete globalThis.FileReader;
    }
    if (originalImage) {
      Object.defineProperty(globalThis, 'Image', originalImage);
    } else {
      delete globalThis.Image;
    }
  }
});
