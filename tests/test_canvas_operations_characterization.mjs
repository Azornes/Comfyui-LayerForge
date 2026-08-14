import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { cloneCanvas } from '../js/utils/CommonUtils.js';

const [layersSource, stateSource, maskEditorSource, commonUtilsSource] = await Promise.all([
  readFile(new URL('../src/canvas/CanvasLayers.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/canvas/CanvasState.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/mask/MaskEditorIntegration.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/CommonUtils.ts', import.meta.url), 'utf8'),
]);

test('mirror commands share the selected-layer flip lifecycle', () => {
  assert.match(
    layersSource,
    /private toggleSelectedFlip\(axis: 'flipH' \| 'flipV'\): void/
  );
  assert.match(layersSource, /layer\[axis\] = !layer\[axis\];/);
  assert.match(layersSource, /mirrorHorizontal\(\): Promise<void> \{[\s\S]*?this\.toggleSelectedFlip\('flipH'\);/);
  assert.match(layersSource, /mirrorVertical\(\): Promise<void> \{[\s\S]*?this\.toggleSelectedFlip\('flipV'\);/);
  assert.doesNotMatch(layersSource, /layer\.flipH = !layer\.flipH;/);
  assert.doesNotMatch(layersSource, /layer\.flipV = !layer\.flipV;/);
});

test('shared canvas cloning preserves dimensions, options, pixels, and null-context behavior', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls = [];
  const context = {
    drawImage: (...args) => calls.push(args),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(type, options) {
      calls.push({ type, options });
      return context;
    },
  };
  const source = { width: 12, height: 8 };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  });

  try {
    assert.equal(cloneCanvas(source), canvas);
    assert.equal(canvas.width, 12);
    assert.equal(canvas.height, 8);
    assert.deepEqual(calls, [
      { type: '2d', options: { willReadFrequently: true } },
      [source, 0, 0],
    ]);

    const contextlessCanvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    };
    globalThis.document.createElement = () => contextlessCanvas;
    assert.equal(cloneCanvas(source), contextlessCanvas);
    assert.equal(contextlessCanvas.width, 12);
    assert.equal(contextlessCanvas.height, 8);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  }
});

test('mask snapshots use the shared canvas clone helper', () => {
  assert.match(stateSource, /const clonedCanvas = cloneCanvas\(maskCanvas\);/);
  assert.doesNotMatch(stateSource, /clonedCtx\.drawImage\(maskCanvas, 0, 0\)/);
  assert.match(maskEditorSource, /const savedCanvas = cloneCanvas\(maskCanvas\);/);
  assert.doesNotMatch(maskEditorSource, /savedCtx\.drawImage\(maskCanvas, 0, 0\)/);
  assert.match(commonUtilsSource, /export function cloneCanvas\(/);
});
