import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryStack } from '../js/canvas/CanvasHistory.js';

test('history stack keeps independent snapshots and supports undo/redo', () => {
  const history = new HistoryStack({
    clone: (value) => ({ ...value }),
    equals: (left, right) => left.value === right.value,
    historyLimit: 3,
  });

  const first = { value: 1 };
  assert.equal(history.push(first), true);
  first.value = 99;
  assert.equal(history.undoStack[0].value, 1);

  assert.equal(history.push({ value: 1 }), false);
  assert.equal(history.push({ value: 2 }), true);
  assert.equal(history.push({ value: 3 }), true);
  assert.deepEqual(history.getHistoryInfo(), {
    undoCount: 3,
    redoCount: 0,
    canUndo: true,
    canRedo: false,
    historyLimit: 3,
  });

  assert.deepEqual(history.undo(), { value: 2 });
  assert.deepEqual(history.redo(), { value: 3 });
  assert.equal(history.redo(), null);
});

test('replacing the last snapshot clears redo history and respects the limit', () => {
  const history = new HistoryStack({
    clone: (value) => value,
    historyLimit: 2,
  });

  history.push('a');
  history.push('b');
  history.push('c');
  assert.deepEqual(history.undoStack, ['b', 'c']);

  assert.equal(history.undo(), 'b');
  assert.deepEqual(history.redoStack, ['c']);
  assert.equal(history.push('replacement', true), true);
  assert.deepEqual(history.undoStack, ['replacement']);
  assert.deepEqual(history.redoStack, []);

  history.clear();
  assert.deepEqual(history.getHistoryInfo(), {
    undoCount: 0,
    redoCount: 0,
    canUndo: false,
    canRedo: false,
    historyLimit: 2,
  });
});
