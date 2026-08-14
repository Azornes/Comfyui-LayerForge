import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CanvasSelection } from '../js/canvas/CanvasSelection.js';
import { removeLayersWithLifecycle } from '../js/utils/LayerRemovalUtils.js';

const [canvasSource, selectionSource] = await Promise.all([
  readFile(new URL('../src/canvas/Canvas.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/canvas/CanvasSelection.ts', import.meta.url), 'utf8'),
]);

function createCanvas(layers) {
  const calls = {
    saveState: 0,
    render: 0,
    onLayersChanged: 0,
    onSelectionChanged: 0,
  };

  const canvas = {
    layers,
    canvasLayersPanel: {
      onLayersChanged() {
        calls.onLayersChanged += 1;
      },
      onSelectionChanged() {
        calls.onSelectionChanged += 1;
      },
    },
    saveState() {
      calls.saveState += 1;
    },
    render() {
      calls.render += 1;
    },
  };

  return { canvas, calls };
}

test('selected-layer removal preserves reference identity and lifecycle', () => {
  const selected = { id: 'same-id', visible: true };
  const sameIdDifferentObject = { id: 'same-id', visible: true };
  const remaining = { id: 'remaining', visible: true };
  const { canvas, calls } = createCanvas([
    selected,
    sameIdDifferentObject,
    remaining,
  ]);
  const selection = new CanvasSelection(canvas);
  canvas.canvasSelection = selection;

  selection.updateSelection([selected]);
  calls.saveState = 0;
  calls.render = 0;
  calls.onLayersChanged = 0;
  calls.onSelectionChanged = 0;

  selection.removeSelectedLayers();

  assert.deepEqual(canvas.layers, [sameIdDifferentObject, remaining]);
  assert.deepEqual(selection.selectedLayers, []);
  assert.equal(selection.selectedLayer, null);
  assert.equal(calls.saveState, 2);
  assert.equal(calls.render, 2);
  assert.equal(calls.onSelectionChanged, 1);
  assert.equal(calls.onLayersChanged, 1);
});

test('shared removal helper preserves both ID and reference predicates', () => {
  const selected = { id: 'same-id', visible: true };
  const sameIdDifferentObject = { id: 'same-id', visible: true };
  const remaining = { id: 'remaining', visible: true };
  const { canvas, calls } = createCanvas([
    selected,
    sameIdDifferentObject,
    remaining,
  ]);
  canvas.canvasSelection = {
    selectedLayers: [selected],
    updateSelection(layers) {
      this.selectedLayers = layers;
    },
  };

  removeLayersWithLifecycle(
    canvas,
    layer => layer.id === 'same-id',
    removedCount => {
      assert.equal(removedCount, 2);
    },
  );

  assert.deepEqual(canvas.layers, [remaining]);
  assert.deepEqual(canvas.canvasSelection.selectedLayers, []);
  assert.equal(calls.saveState, 2);
  assert.equal(calls.render, 1);
  assert.equal(calls.onLayersChanged, 1);

  const referenceCanvas = createCanvas([
    selected,
    sameIdDifferentObject,
    remaining,
  ]);
  referenceCanvas.canvas.canvasSelection = {
    selectedLayers: [selected],
    updateSelection(layers) {
      this.selectedLayers = layers;
    },
  };

  removeLayersWithLifecycle(
    referenceCanvas.canvas,
    layer => layer === selected,
    () => undefined,
  );

  assert.deepEqual(referenceCanvas.canvas.layers, [sameIdDifferentObject, remaining]);
});

test('public removal methods delegate to the shared lifecycle', () => {
  assert.match(canvasSource, /removeLayersWithLifecycle\(/);
  assert.match(canvasSource, /layer => layerIds\.includes\(layer\.id\)/);
  assert.match(selectionSource, /removeLayersWithLifecycle\(/);
  assert.match(selectionSource, /layer => this\.selectedLayers\.includes\(layer\)/);
  assert.doesNotMatch(canvasSource, /this\.layers = this\.layers\.filter\(\(l: Layer\)/);
  assert.doesNotMatch(selectionSource, /this\.canvas\.layers = this\.canvas\.layers\.filter/);
});
