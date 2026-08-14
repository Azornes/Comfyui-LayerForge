import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CanvasState } from '../js/canvas/canvas_state.js';

const [canvasStateSource, maskEditorSource] = await Promise.all([
  readFile(new URL('../src/canvas/canvas_state.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/mask/mask_editor_integration.ts', import.meta.url), 'utf8'),
]);

function installImageStub() {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');

  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class TestImage {
      constructor() {
        this.onload = null;
        this.onerror = null;
        this.crossOrigin = '';
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
    },
  });

  return () => {
    if (originalImage) {
      Object.defineProperty(globalThis, 'Image', originalImage);
    } else {
      delete globalThis.Image;
    }
  };
}

function installCanvasStub() {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
        return {
          getContext() {
            return { drawImage() {} };
          },
          toDataURL() {
            return 'bitmap-data';
          },
        };
      },
    },
  });

  return () => {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  };
}

test('CanvasState preserves image loading, cross-origin, and failure behavior', async () => {
  const restore = installImageStub();
  const state = Object.create(CanvasState.prototype);

  try {
    const loadedLayer = await new Promise(resolve => {
      state._createLayerFromSrc({ id: 'layer-1' }, 'good-image', 2, resolve);
    });
    assert.equal(loadedLayer.image.source, 'good-image');
    assert.equal(loadedLayer.image.crossOrigin, 'anonymous');

    const failedLayer = await new Promise(resolve => {
      state._createLayerFromSrc({ id: 'layer-2' }, 'bad-image', 3, resolve);
    });
    assert.equal(failedLayer, null);
  } finally {
    restore();
  }
});

test('CanvasState preserves ImageBitmap conversion before shared image loading', async () => {
  const restoreImage = installImageStub();
  const restoreCanvas = installCanvasStub();
  const state = Object.create(CanvasState.prototype);

  try {
    const loadedLayer = await new Promise(resolve => {
      state._createLayerFromSrc({ id: 'layer-bitmap' }, { width: 8, height: 6 }, 4, resolve);
    });
    assert.equal(loadedLayer.image.source, 'bitmap-data');
    assert.equal(loadedLayer.image.crossOrigin, 'anonymous');
  } finally {
    restoreCanvas();
    restoreImage();
  }
});

test('CanvasState layer source loading has no local Image construction', () => {
  const methodStart = canvasStateSource.indexOf('_createLayerFromSrc(');
  const methodEnd = canvasStateSource.indexOf('\n    async saveStateToDB', methodStart);
  const methodBody = canvasStateSource.slice(methodStart, methodEnd);

  assert.equal((methodBody.match(/loadImage\(/g) ?? []).length, 2);
  assert.doesNotMatch(methodBody, /new Image\(/);
});

test('Mask editor image loaders preserve their rejection and cleanup policies', () => {
  assert.match(maskEditorSource, /return loadImage\(this\.maskTool\.getMask\(\)\.toDataURL\(\)\)/);
  assert.match(maskEditorSource, /resultImage = await loadImage\(this\.node\.imgs\[0\]\.src\)/);
  assert.match(maskEditorSource, /this\.node\.imgs = \[\]/);
});
