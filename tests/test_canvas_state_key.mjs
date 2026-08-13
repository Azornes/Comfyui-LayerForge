import assert from 'node:assert/strict';
import test from 'node:test';

import {getCanvasStateKey, getWorkflowIdentity} from '../js/utils/CanvasStateKey.js';

test('LayerForge state keys isolate equal node IDs between workflows', () => {
  const firstNode = {id: 1, graph: {rootGraph: {id: 'workflow-a'}}};
  const secondNode = {id: 1, graph: {rootGraph: {id: 'workflow-b'}}};

  assert.notEqual(getCanvasStateKey(firstNode), getCanvasStateKey(secondNode));
  assert.equal(getCanvasStateKey(firstNode), getCanvasStateKey(firstNode));
});

test('LayerForge assigns and reuses a workflow identity when ComfyUI has no graph ID', () => {
  const rootGraph = {extra: {}};
  const node = {id: 7, graph: {rootGraph}};

  const firstIdentity = getWorkflowIdentity(node);
  const firstKey = getCanvasStateKey(node);

  assert.equal(rootGraph.extra.layerforgeWorkflowId, firstIdentity);
  assert.equal(getWorkflowIdentity(node), firstIdentity);
  assert.equal(getCanvasStateKey(node), firstKey);
});
