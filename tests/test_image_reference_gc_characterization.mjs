import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ImageReferenceManager } from '../js/ImageReferenceManager.js';

const source = await readFile(
  new URL('../src/ImageReferenceManager.ts', import.meta.url),
  'utf8'
);

test('garbage collection reuses the used image ids from reference rebuilding', async () => {
  const canvas = {
    layers: [],
    canvasState: {
      layersUndoStack: [],
      layersRedoStack: [],
    },
    imageCache: {
      has: () => false,
      delete: () => false,
    },
  };
  const manager = new ImageReferenceManager(canvas);
  let rebuildReferencesCalls = 0;
  let collectAllUsedImageIdsCalls = 0;
  let receivedUsedImageIds;

  const originalRebuildReferences = manager.rebuildReferences.bind(manager);
  manager.rebuildReferences = () => {
    rebuildReferencesCalls += 1;
    return originalRebuildReferences();
  };
  manager.collectAllUsedImageIds = () => {
    collectAllUsedImageIdsCalls += 1;
    return new Set(['used-image']);
  };
  manager.findUnusedImages = async usedImageIds => {
    receivedUsedImageIds = usedImageIds;
    return [];
  };

  await manager.performGarbageCollection();

  assert.equal(rebuildReferencesCalls, 1);
  assert.equal(collectAllUsedImageIdsCalls, 1);
  assert.deepEqual([...receivedUsedImageIds], ['used-image']);
});

test('public reference update delegates to the shared rebuild implementation', () => {
  const rebuildReferencesMethod = source.match(
    /private rebuildReferences\(\): Set<string> \{[\s\S]*?\n    \}/
  )?.[0];
  const updateReferencesMethod = source.match(
    /updateReferences\(\): void \{[\s\S]*?\n    \}/
  )?.[0];

  assert.ok(rebuildReferencesMethod);
  assert.ok(updateReferencesMethod);
  assert.match(rebuildReferencesMethod, /this\.imageReferences\.clear\(\)/);
  assert.match(rebuildReferencesMethod, /this\.collectAllUsedImageIds\(\)/);
  assert.match(updateReferencesMethod, /this\.rebuildReferences\(\)/);
  assert.match(source, /private rebuildReferences\(\): Set<string>/);
  assert.match(source, /const usedImageIds = this\.rebuildReferences\(\);/);
  assert.doesNotMatch(source, /this\.updateReferences\(\);[\s\S]*?this\.collectAllUsedImageIds\(\);/);
});
