import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CanvasRenderer } from '../js/canvas/canvas_renderer.js';
import { ShapeTool } from '../js/canvas/shape_tool.js';

import {
  getBoundsFromPoints,
  getLayerWorldBounds,
  getLayerWorldCorners,
  isPointInRotatedLayer,
  localToWorld,
  worldToLocal,
} from '../js/utils/common_utils.js';

const canvasLayersSource = await readFile(
  new URL('../src/canvas/canvas_layers.ts', import.meta.url),
  'utf8'
);

function assertAlmostEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function assertPointAlmostEqual(actual, expected, epsilon = 1e-9) {
  assertAlmostEqual(actual.x, expected.x, epsilon);
  assertAlmostEqual(actual.y, expected.y, epsilon);
}

function createRendererContext(arcs = []) {
  return {
    beginPath() {},
    arc(x, y, radius, startAngle, endAngle) {
      arcs.push({ x, y, radius, startAngle, endAngle });
    },
    fill() {},
    lineTo() {},
    moveTo() {},
    setLineDash() {},
    stroke() {},
    strokeRect() {},
  };
}

function createRenderer() {
  const renderer = Object.create(CanvasRenderer.prototype);
  renderer.canvas = {
    viewport: { zoom: 1 },
    canvasLayers: { getHandles: () => ({}) },
  };
  renderer.isPointCoveredByHigherLayers = () => false;
  return renderer;
}

test('rotated layer hit-test coordinates preserve current boundary behavior', () => {
  const layer = {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 45,
  };
  const transform = {
    centerX: layer.x + layer.width / 2,
    centerY: layer.y + layer.height / 2,
    rotation: layer.rotation,
  };

  const insideWorld = localToWorld(layer.width / 2, 0, transform);
  const insideLocal = worldToLocal(insideWorld.x, insideWorld.y, transform);
  assertPointAlmostEqual(insideLocal, { x: layer.width / 2, y: 0 });
  assert.equal(isPointInRotatedLayer(insideWorld.x, insideWorld.y, layer), true);

  const outsideWorld = localToWorld(layer.width / 2 + 0.001, 0, transform);
  const outsideLocal = worldToLocal(outsideWorld.x, outsideWorld.y, transform);
  assert.ok(Math.abs(outsideLocal.x) > layer.width / 2);
  assert.equal(isPointInRotatedLayer(outsideWorld.x, outsideWorld.y, layer), false);
});

test('rotated full-layer bounds preserve current dimensions', () => {
  const layer = {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 45,
  };
  const corners = getLayerWorldCorners(layer);
  const bounds = getBoundsFromPoints(corners);
  const layerBounds = getLayerWorldBounds(layer);

  assertAlmostEqual(bounds.x, 6.966991411008934);
  assertAlmostEqual(bounds.x + bounds.width, 113.03300858899107);
  assertAlmostEqual(bounds.y, -8.033008588991066);
  assertAlmostEqual(bounds.y + bounds.height, 98.03300858899107);
  assert.deepEqual(layerBounds, bounds);
  assert.equal(Math.ceil(bounds.width), 107);
  assert.equal(Math.ceil(bounds.height), 107);
});

test('crop bounds preserve flip-aware layer-local coordinates', () => {
  const layer = {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    cropMode: true,
    originalWidth: 400,
    originalHeight: 200,
    flipH: true,
    flipV: false,
    cropBounds: { x: 50, y: 20, width: 100, height: 60 },
  };
  assert.deepEqual(getLayerWorldCorners(layer, { cropAware: true }), [
    { x: 125, y: 10 },
    { x: 175, y: 10 },
    { x: 175, y: 40 },
    { x: 125, y: 40 },
  ]);
  assert.deepEqual(getLayerWorldBounds(layer, { cropAware: true }), {
    x: 125,
    y: 10,
    width: 50,
    height: 30,
  });
});

test('shape and renderer bounding boxes preserve local and world-space behavior', () => {
  const shapeTool = Object.create(ShapeTool.prototype);
  shapeTool.shape = {
    points: [
      { x: -10, y: 5 },
      { x: 20, y: -15 },
      { x: 4, y: 25 },
    ],
    isClosed: true,
  };

  assert.deepEqual(shapeTool.getBoundingBox(), {
    x: -10,
    y: -15,
    width: 30,
    height: 40,
  });

  shapeTool.shape = { points: [], isClosed: false };
  assert.equal(shapeTool.getBoundingBox(), null);

  const renderer = createRenderer();
  renderer.canvas.outputAreaBounds = { x: 100, y: 200 };
  renderer.canvas.outputAreaExtensionEnabled = true;
  renderer.canvas.outputAreaExtensions = { left: 5, top: -2, right: 0, bottom: 0 };
  renderer.canvas.outputAreaShape = {
    points: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
  };
  renderer.canvas.batchPreviewManagers = [
    { generationArea: { x: 104, y: 198, width: 2, height: 2 } },
  ];

  assert.equal(renderer.isCustomShapeOverlappingWithBatchAreas(), true);

  renderer.canvas.batchPreviewManagers = [
    { generationArea: { x: 200, y: 300, width: 2, height: 2 } },
  ];
  assert.equal(renderer.isCustomShapeOverlappingWithBatchAreas(), false);
});

test('renderer adaptive lines use the layer center and rotation contract', () => {
  const renderer = createRenderer();
  const observedWorldPoints = [];
  renderer.isPointCoveredByHigherLayers = (worldX, worldY) => {
    observedWorldPoints.push({ x: worldX, y: worldY });
    return false;
  };

  const layer = { x: 10, y: 20, width: 100, height: 50, rotation: 90 };
  renderer.drawAdaptiveLine(createRendererContext(), 0, 0, 16, 0, layer);

  const transform = {
    centerX: layer.x + layer.width / 2,
    centerY: layer.y + layer.height / 2,
    rotation: layer.rotation,
  };
  assertPointAlmostEqual(observedWorldPoints[0], localToWorld(0, 0, transform));
  assertPointAlmostEqual(observedWorldPoints.at(-1), localToWorld(16, 0, transform));
});

test('renderer selection handles convert world positions back to local coordinates with flips', () => {
  const renderer = createRenderer();
  const layer = {
    x: 100,
    y: 200,
    width: 100,
    height: 50,
    rotation: 90,
    flipH: true,
    flipV: false,
  };
  const transform = {
    centerX: layer.x + layer.width / 2,
    centerY: layer.y + layer.height / 2,
    rotation: layer.rotation,
  };
  const worldHandle = localToWorld(50, 0, transform);
  renderer.canvas.canvasLayers.getHandles = () => ({ e: worldHandle });

  const arcs = [];
  renderer.drawSelectionFrame(createRendererContext(arcs), layer);

  assert.equal(arcs.length, 1);
  assertAlmostEqual(arcs[0].x, -50);
  assertAlmostEqual(arcs[0].y, 0);
});

test('CanvasLayers handle construction uses the canonical point transform', () => {
  assert.match(canvasLayersSource, /localToWorld\(/);
  assert.doesNotMatch(canvasLayersSource, /const rad = layer\.rotation \* Math\.PI \/ 180/);
  assert.match(canvasLayersSource, /worldHandles\[key\] = localToWorld/);
});
