import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MaskTool } from '../js/mask/mask_tool.js';
import {
  applyLuminanceAsAlpha,
  fillInverseAlphaMask,
  imageDataToBinaryMask,
  rasterizeDistanceFieldMask,
} from '../js/mask/mask_pixel_utils.js';

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
    const { createDistanceFieldMaskSync } = await import('../js/mask/image_analysis.js?characterization');
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
    const { calculateDistanceTransform } = await import('../js/mask/mask_pixel_utils.js?characterization');
  const imageAnalysisSource = await readFile(new URL('../src/mask/image_analysis.ts', import.meta.url), 'utf8');
  const maskToolSource = await readFile(new URL('../src/mask/mask_tool.ts', import.meta.url), 'utf8');

  assert.deepEqual(
    [...calculateDistanceTransform(new Uint8Array([1, 1, 0]), 3, 1)],
    [2, 1, 0],
  );
  assert.match(imageAnalysisSource, /from "\.\/mask_pixel_utils\.js"/);
  assert.match(maskToolSource, /from "\.\/mask_pixel_utils\.js"/);
  assert.match(maskToolSource, /calculateDistanceTransform\(binaryData, width, height\)/);
  assert.match(imageAnalysisSource, /rasterizeDistanceFieldMask\(distanceField, binaryMask, threshold, maskData\.data\)/);
  assert.match(maskToolSource, /rasterizeDistanceFieldMask\(distanceMap, binaryData, threshold, outputData\.data\)/);
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

test('shared distance-field rasterizer preserves masked, opaque, and zero-threshold pixels', () => {
  const outputData = new Uint8ClampedArray(16);
  rasterizeDistanceFieldMask(
    new Float32Array([0, 1, 2, 3]),
    new Uint8Array([0, 1, 1, 1]),
    2,
    outputData
  );
  assert.deepEqual([...outputData], [
    255, 255, 255, 0,
    255, 255, 255, 127,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);

  const opaqueOutput = new Uint8ClampedArray(8);
  rasterizeDistanceFieldMask(
    new Float32Array([0, 1]),
    null,
    0,
    opaqueOutput
  );
  assert.deepEqual([...opaqueOutput], [
    255, 255, 255, 0,
    255, 255, 255, 255,
  ]);
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

test('MaskTool preserves affected chunk order, boundaries, and source areas', () => {
  const maskTool = Object.create(MaskTool.prototype);
  const chunkCalls = [];
  const clearCalls = [];

  maskTool.chunkSize = 10;
  maskTool.canvasInstance = {
    outputAreaBounds: { x: -5, y: 3 },
  };
  maskTool.getChunkForPosition = (x, y) => {
    return { x, y };
  };
  maskTool.performChunkOperation = (chunk, source, sourceArea, operation, operationName) => {
    chunkCalls.push({ chunk, source, sourceArea, operation, operationName });
  };
  maskTool.activateChunksInArea = () => 0;
  maskTool.updateActiveMaskCanvas = () => {};
  maskTool.triggerStateChangeAndRender = () => {};
  maskTool.clearMaskInArea = (...args) => clearCalls.push(args);

  const image = { width: 25, height: 15 };
  const canvas = { width: 25, height: 15 };

  maskTool.addMask(image);
  assert.deepEqual(
    chunkCalls.map(({ chunk, operation }) => [chunk.x, chunk.y, operation]),
    [
      [-10, 0, 'add'], [0, 0, 'add'], [10, 0, 'add'], [20, 0, 'add'],
      [-10, 10, 'add'], [0, 10, 'add'], [10, 10, 'add'], [20, 10, 'add'],
    ],
  );
  assert.deepEqual(chunkCalls[0].sourceArea, {
    left: -5,
    top: 3,
    right: 20,
    bottom: 18,
  });

  chunkCalls.length = 0;
  maskTool.applyMaskCanvasToChunks(canvas, -5, 3);
  assert.deepEqual(clearCalls, [[-5, 3, 25, 15]]);
  assert.deepEqual(
    chunkCalls.map(({ chunk, operation }) => [chunk.x, chunk.y, operation]),
    [
      [-10, 0, 'apply'], [0, 0, 'apply'], [10, 0, 'apply'], [20, 0, 'apply'],
      [-10, 10, 'apply'], [0, 10, 'apply'], [10, 10, 'apply'], [20, 10, 'apply'],
    ],
  );
  assert.deepEqual(chunkCalls[0].sourceArea, {
    left: -5,
    top: 3,
    right: 20,
    bottom: 18,
  });

  chunkCalls.length = 0;
  maskTool.removeMaskCanvasFromChunks(canvas, -5, 3);
  assert.deepEqual(
    chunkCalls.map(({ chunk, operation }) => [chunk.x, chunk.y, operation]),
    [
      [-10, 0, 'remove'], [0, 0, 'remove'], [10, 0, 'remove'], [20, 0, 'remove'],
      [-10, 10, 'remove'], [0, 10, 'remove'], [10, 10, 'remove'], [20, 10, 'remove'],
    ],
  );
  assert.deepEqual(chunkCalls[0].sourceArea, {
    left: -5,
    top: 3,
    right: 20,
    bottom: 18,
  });
});

test('MaskTool feather rasterization preserves edge interpolation and threshold-zero behavior', () => {
  const stubs = installCanvasStub([]);
  const maskTool = Object.create(MaskTool.prototype);

  try {
    const feathered = maskTool.applyFeatherToDistanceMap(
      new Float32Array([0, 1, 2, 3]),
      new Uint8Array([0, 1, 1, 1]),
      2,
      4,
      1
    );
    assert.deepEqual([...feathered.data], [
      255, 255, 255, 0,
      255, 255, 255, 127,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]);

    const zeroThreshold = maskTool.applyFeatherToDistanceMap(
      new Float32Array([0, 1]),
      new Uint8Array([1, 1]),
      0,
      2,
      1
    );
    assert.deepEqual([...zeroThreshold.data], [
      255, 255, 255, 0,
      255, 255, 255, 255,
    ]);
  } finally {
    stubs.restore();
  }
});

test('CanvasIO and CanvasLayers preserve inverse-alpha mask generation', async () => {
  const canvasIOSource = await readFile(new URL('../src/io/canvas_io.ts', import.meta.url), 'utf8');
  const canvasLayersSource = await readFile(new URL('../src/canvas/canvas_layers.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(canvasIOSource, /from "\.\/utils\/mask_pixel_utils\.js"/);
  assert.match(canvasLayersSource, /from "\.\.\/mask\/mask_pixel_utils\.js"/);
  assert.match(canvasIOSource, /renderLayerVisibilityMask\(/);
  assert.doesNotMatch(canvasIOSource, /fillInverseAlphaMask\(visibilityData, maskData\)/);
  assert.match(canvasLayersSource, /fillInverseAlphaMask\(visibilityData, maskData\)/);
  assert.doesNotMatch(canvasIOSource, /const maskValue = 255 - alpha/);
  assert.doesNotMatch(canvasLayersSource, /const maskValue = 255 - alpha/);
});
