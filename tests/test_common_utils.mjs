import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clamp,
  degreesToRadians,
  generateUniqueFileName,
  generateUUID,
  getSnapAdjustment,
  getStateSignature,
  isPointInRect,
  lerp,
  localToWorld,
  normalizeToUint8,
  radiansToDegrees,
  snapToGrid,
  worldToLocal,
} from '../js/utils/common_utils.js';

test('common numeric helpers keep canvas math stable', () => {
  assert.equal(snapToGrid(95, 64), 64);
  assert.deepEqual(
    getSnapAdjustment({ x: 63, y: 64, width: 20, height: 20 }),
    { x: 1, y: 0 }
  );
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(degreesToRadians(180), Math.PI);
  assert.equal(radiansToDegrees(Math.PI / 2), 90);
  assert.equal(normalizeToUint8(0.5), 128);
  assert.equal(normalizeToUint8(-1), 0);
  assert.equal(normalizeToUint8(2), 255);
});

test('world and local coordinates are inverse transforms', () => {
  const layer = { centerX: 100, centerY: 50, rotation: 90 };
  const local = worldToLocal(100, 60, layer);
  const world = localToWorld(local.x, local.y, layer);

  assert.ok(Math.abs(world.x - 100) < 1e-9);
  assert.ok(Math.abs(world.y - 60) < 1e-9);
});

test('state signatures contain stable transform and layer identity fields', () => {
  const layers = [{
    id: 'layer-1',
    x: 10.1234,
    y: 20.5678,
    width: 100,
    height: 200,
    rotation: 12.3456,
    zIndex: 3,
    blendMode: 'multiply',
    opacity: 0.75,
    visible: true,
    imageId: 'image-1',
  }];

  const signature = getStateSignature(layers);
  const parsed = JSON.parse(signature);

  assert.deepEqual(parsed[0], {
    index: 0,
    x: 10.12,
    y: 20.57,
    width: 100,
    height: 200,
    rotation: 12.35,
    zIndex: 3,
    blendMode: 'multiply',
    opacity: 0.75,
    flipH: false,
    flipV: false,
    imageId: 'image-1',
  });
});

test('filename, UUID, and rectangle helpers handle common workflow values', () => {
  assert.match(generateUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(
    generateUniqueFileName('portrait_node_4_node_9.png', 4),
    'portrait_node_4.png'
  );
  assert.equal(isPointInRect(10, 20, 0, 0, 10, 20), true);
  assert.equal(isPointInRect(10.1, 20, 0, 0, 10, 20), false);
});
