import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createCanvas, createCanvasWithContext } from '../js/utils/CommonUtils.js';

const maskToolSource = await readFile(
  new URL('../src/MaskTool.ts', import.meta.url),
  'utf8',
);

test('createCanvas preserves dimensions, context type, and options', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls = [];
  const context = {};
  const canvas = {
    width: 0,
    height: 0,
    getContext(type, options) {
      calls.push({ type, options });
      return context;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tagName) => {
      assert.equal(tagName, 'canvas');
      return canvas;
    } },
  });

  try {
    const result = createCanvas(12, 8, '2d', { willReadFrequently: true });

    assert.equal(result.canvas, canvas);
    assert.equal(result.ctx, context);
    assert.equal(canvas.width, 12);
    assert.equal(canvas.height, 8);
    assert.deepEqual(calls, [{ type: '2d', options: { willReadFrequently: true } }]);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  }
});

test('createCanvasWithContext keeps the strict MaskTool context contract', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = {};
  let returnContext = true;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return returnContext ? context : null;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  });

  try {
    const result = createCanvasWithContext(4, 3);
    assert.equal(result.canvas, canvas);
    assert.equal(result.ctx, context);
    assert.deepEqual(canvas, { width: 4, height: 3, getContext: canvas.getContext });

    returnContext = false;
    assert.throws(
      () => createCanvasWithContext(4, 3),
      /Failed to get 2D context for canvas/,
    );
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  }
});

test('MaskTool delegates its internal canvas creation to the shared strict helper', () => {
  assert.doesNotMatch(maskToolSource, /private createCanvas\(/);
  assert.match(maskToolSource, /createCanvasWithContext/);
  assert.doesNotMatch(maskToolSource, /this\.createCanvas\(/);
});
