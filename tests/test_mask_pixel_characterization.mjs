import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MaskTool } from '../js/MaskTool.js';
import {
  applyLuminanceAsAlpha,
  fillInverseAlphaMask,
  imageDataToBinaryMask,
} from '../js/utils/MaskPixelUtils.js';

function installCanvasStub(sourceAlpha) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const output = { data: null };
  const context = {
    clearRect() {},
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    drawImage() {},
    getImageData(_x, _y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < sourceAlpha.length; i++) {
        data[i * 4 + 3] = sourceAlpha[i];
      }
      return { width, height, data };
    },
    putImageData(imageData) {
      output.data = imageData.data;
    },
  };
  const canvas = {
    height: 0,
    width: 0,
    getContext() {
      return context;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
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
    },
  };
}

function installPixelCanvasStub(sourcePixels) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const outputs = [];
  const context = {
    beginPath() {},
    closePath() {},
    drawImage() {},
    fill() {},
    getImageData(_x, _y, width, height) {
      return { width, height, data: new Uint8ClampedArray(sourcePixels) };
    },
    lineTo() {},
    moveTo() {},
    putImageData(imageData) {
      outputs.push([...imageData.data]);
    },
    restore() {},
    rotate() {},
    save() {},
    scale() {},
    translate() {},
  };
  const canvas = {
    height: 0,
    width: 0,
    getContext() {
      return context;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
        return canvas;
      },
    },
  });

  return {
    outputs,
    restore() {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        delete globalThis.document;
      }
    },
  };
}

test('distance-field mask preserves alpha-distance behavior for transparent pixels', async () => {
  const stubs = installCanvasStub([255, 128, 0]);

  try {
    const { createDistanceFieldMaskSync } = await import('../js/utils/ImageAnalysis.js?characterization');
    createDistanceFieldMaskSync({ width: 3, height: 1 }, 100);

    assert.deepEqual([...stubs.output.data], [
      255, 255, 255, 255,
      255, 255, 255, 127,
      255, 255, 255, 0,
    ]);
  } finally {
    stubs.restore();
  }
});

test('mask consumers use one shared distance transform implementation', async () => {
  const { calculateDistanceTransform } = await import('../js/utils/MaskPixelUtils.js?characterization');
  const imageAnalysisSource = await readFile(new URL('../src/utils/ImageAnalysis.ts', import.meta.url), 'utf8');
  const maskToolSource = await readFile(new URL('../src/MaskTool.ts', import.meta.url), 'utf8');

  assert.deepEqual(
    [...calculateDistanceTransform(new Uint8Array([1, 1, 0]), 3, 1)],
    [2, 1, 0],
  );
  assert.match(imageAnalysisSource, /from "\.\/MaskPixelUtils\.js"/);
  assert.match(maskToolSource, /from "\.\/utils\/MaskPixelUtils\.js"/);
  assert.match(maskToolSource, /calculateDistanceTransform\(binaryData, width, height\)/);
  assert.match(maskToolSource, /applyLuminanceAsAlpha\(imgData\)/);
  assert.match(maskToolSource, /applyLuminanceAsAlpha\(sourceImageData\)/);
  assert.match(maskToolSource, /imageDataToBinaryMask\(maskImage, width, height, 0\)/);
  assert.match(maskToolSource, /imageDataToBinaryMask\(imageData, width, height, 3\)/);
  assert.doesNotMatch(imageAnalysisSource, /function calculateDistanceTransform\(/);
  assert.doesNotMatch(maskToolSource, /private _fastDistanceTransform\(/);
});

test('shared mask pixel helpers preserve luminance, inverse alpha, and explicit channels', () => {
  const imageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      255, 0, 0, 0,
      0, 255, 0, 255,
    ]),
  };
  applyLuminanceAsAlpha(imageData);
  assert.deepEqual([...imageData.data], [255, 255, 255, 76, 255, 255, 255, 150]);

  const visibilityData = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 0,
      0, 0, 0, 128,
      0, 0, 0, 255,
    ]),
  };
  const maskData = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray(12),
  };
  fillInverseAlphaMask(visibilityData, maskData);
  assert.deepEqual([...maskData.data], [
    255, 255, 255, 255,
    127, 127, 127, 255,
    0, 0, 0, 255,
  ]);

  const channelData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      255, 0, 0, 0,
      0, 0, 0, 255,
    ]),
  };
  assert.deepEqual([...imageDataToBinaryMask(channelData, 2, 1, 0)], [1, 0]);
  assert.deepEqual([...imageDataToBinaryMask(channelData, 2, 1, 3)], [0, 1]);
});

test('MaskTool converts shape pixels through the existing red-channel binary contract', () => {
  const stubs = installPixelCanvasStub([
    0, 255, 0, 0,
    255, 0, 0, 0,
  ]);
  const maskTool = Object.create(MaskTool.prototype);

  try {
    assert.deepEqual(
      [...maskTool.createBinaryMaskFromShape([{ x: 0, y: 0 }], 2, 1)],
      [0, 1]
    );
  } finally {
    stubs.restore();
  }
});

test('MaskTool preserves luminance-to-alpha behavior for input and layer masks', () => {
  const pixels = [
    0, 0, 0, 255,
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
  ];
  const expected = [
    255, 255, 255, 0,
    255, 255, 255, 76,
    255, 255, 255, 150,
    255, 255, 255, 29,
  ];

  const inputStubs = installPixelCanvasStub(pixels);
  const inputMaskTool = Object.create(MaskTool.prototype);
  inputMaskTool.canvasInstance = {
    outputAreaBounds: { x: 0, y: 0, width: 2, height: 2 },
    canvasState: { saveMaskState() {} },
    render() {},
  };
  inputMaskTool.clearMaskInArea = () => {};
  inputMaskTool.applyMaskCanvasToChunks = () => {};
  inputMaskTool.updateActiveMaskCanvas = () => {};

  try {
    inputMaskTool.setMask({ width: 2, height: 2 }, true);
    assert.deepEqual(inputStubs.outputs[0], expected);
  } finally {
    inputStubs.restore();
  }

  const layerStubs = installPixelCanvasStub(pixels);
  const layerMaskTool = Object.create(MaskTool.prototype);
  layerMaskTool.canvasInstance = {
    canvasState: { saveMaskState() {} },
    render() {},
  };
  layerMaskTool.clearMaskInArea = () => {};
  layerMaskTool.applyMaskCanvasToChunks = () => {};
  layerMaskTool.updateActiveMaskCanvas = () => {};

  try {
    layerMaskTool.setMaskForLayer(
      { width: 2, height: 2, naturalWidth: 2, naturalHeight: 2 },
      { x: 0, y: 0, width: 2, height: 2, originalWidth: 2, originalHeight: 2, rotation: 0 }
    );
    assert.deepEqual(layerStubs.outputs[0], expected);
  } finally {
    layerStubs.restore();
  }
});

test('CanvasIO and CanvasLayers preserve inverse-alpha mask generation', async () => {
  const canvasIOSource = await readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8');
  const canvasLayersSource = await readFile(new URL('../src/CanvasLayers.ts', import.meta.url), 'utf8');

  assert.match(canvasIOSource, /from "\.\/utils\/MaskPixelUtils\.js"/);
  assert.match(canvasLayersSource, /from "\.\/utils\/MaskPixelUtils\.js"/);
  assert.match(canvasIOSource, /fillInverseAlphaMask\(visibilityData, maskData\)/);
  assert.match(canvasLayersSource, /fillInverseAlphaMask\(visibilityData, maskData\)/);
  assert.doesNotMatch(canvasIOSource, /const maskValue = 255 - alpha/);
  assert.doesNotMatch(canvasLayersSource, /const maskValue = 255 - alpha/);
});
