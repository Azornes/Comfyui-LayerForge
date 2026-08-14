import assert from 'node:assert/strict';
import test from 'node:test';

import {HistoryStack} from '../js/canvas/canvas_history.js';
import {ImageReferenceManager} from '../js/persistence/image_reference_manager.js';

function createReferenceCanvas(layers = []) {
  return {
    layers,
    canvasState: {
      layersUndoStack: [],
      layersRedoStack: [],
    },
    imageCache: {
      has: () => false,
      delete: () => false,
    },
  };
}

test('history stack remains bounded during a large edit sequence', () => {
  const history = new HistoryStack({
    clone: value => ({ ...value }),
    historyLimit: 64,
  });

  for (let index = 0; index < 5000; index += 1) {
    assert.equal(history.push({ index }), true);
  }

  assert.equal(history.undoStack.length, 64);
  assert.equal(history.undoStack[0].index, 4936);
  assert.equal(history.undoStack.at(-1).index, 4999);
  assert.equal(history.redoStack.length, 0);
});

test('reference manager rebuilds unique ids across current and historical layers', () => {
  const currentLayers = Array.from({ length: 2000 }, (_, index) => ({
    imageId: `current-${index % 100}`,
  }));
  const canvas = createReferenceCanvas(currentLayers);
  canvas.canvasState.layersUndoStack = [[{ imageId: 'undo-only' }]];
  canvas.canvasState.layersRedoStack = [[{ imageId: 'redo-only' }]];

  const manager = new ImageReferenceManager(canvas);
  const usedImageIds = manager.collectAllUsedImageIds();

  assert.equal(usedImageIds.size, 102);
  assert.equal(usedImageIds.has('undo-only'), true);
  assert.equal(usedImageIds.has('redo-only'), true);
});

test('reference manager cleanup stops its timer and releases tracked state', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalClearInterval = Object.getOwnPropertyDescriptor(globalThis, 'clearInterval');
  const timers = [];
  const clearedTimers = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval(callback, delay) {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearInterval(timer) {
        clearedTimers.push(timer);
      },
    },
  });
  Object.defineProperty(globalThis, 'clearInterval', {
    configurable: true,
    value: timer => clearedTimers.push(timer),
  });

  try {
    const manager = new ImageReferenceManager(createReferenceCanvas());
    manager.addReference('image-1');
    manager.addReference('image-1');
    manager.startGarbageCollection();

    assert.equal(timers.length, 1);
    assert.equal(manager.getStats().totalReferences, 2);

    manager.destroy();

    assert.deepEqual(clearedTimers, [timers[0]]);
    assert.deepEqual(manager.getStats(), {
      trackedImages: 0,
      totalReferences: 0,
      isRunning: false,
      gcInterval: 5 * 60 * 1000,
      maxAge: 30 * 60 * 1000,
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      delete globalThis.window;
    }
    if (originalClearInterval) {
      Object.defineProperty(globalThis, 'clearInterval', originalClearInterval);
    } else {
      delete globalThis.clearInterval;
    }
  }
});

test('garbage collection ignores reentrant calls while one run is active', async () => {
  const manager = new ImageReferenceManager(createReferenceCanvas());
  let nestedRunCompleted = false;

  manager.findUnusedImages = async () => {
    await manager.performGarbageCollection();
    nestedRunCompleted = true;
    return [];
  };

  await manager.performGarbageCollection();

  assert.equal(nestedRunCompleted, true);
  assert.equal(manager.getStats().isRunning, false);
});
