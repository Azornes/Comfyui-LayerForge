import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStateSaverMessage,
} from '../js/persistence/contracts.js';

const validState = {
  layers: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  width: 512,
  height: 512,
  outputAreaBounds: { x: 0, y: 0, width: 512, height: 512 },
};

test('state saver contract accepts a persisted canvas state message', () => {
  assert.equal(isStateSaverMessage({
    stateKey: 'workflow:node:1',
    state: validState,
  }), true);
});

test('state saver contract rejects malformed or incomplete messages', () => {
  assert.equal(isStateSaverMessage(null), false);
  assert.equal(isStateSaverMessage({ stateKey: '', state: validState }), false);
  assert.equal(isStateSaverMessage({ stateKey: 'node-1', state: null }), false);
  assert.equal(isStateSaverMessage({
    stateKey: 'node-1',
    state: { ...validState, layers: null },
  }), false);
  assert.equal(isStateSaverMessage({
    stateKey: 'node-1',
    state: { ...validState, width: '512' },
  }), false);
});
