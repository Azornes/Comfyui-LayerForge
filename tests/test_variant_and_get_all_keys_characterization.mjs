import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [blobSource, exportSource, dbSource, sharedSource] = await Promise.all([
  readFile(new URL('../src/utils/CanvasBlobUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/CanvasExportUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/db.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/db_shared.ts', import.meta.url), 'utf8'),
]);

test('canvas export uses the canonical blob variant union', () => {
  assert.match(blobSource, /export type CanvasBlobVariant = 'plain' \| 'with-mask';/);
  assert.match(exportSource, /getFlattenedCanvasBlob, type CanvasBlobVariant/);
  assert.match(exportSource, /variant: CanvasBlobVariant/);
  assert.doesNotMatch(exportSource, /CanvasExportVariant|export type CanvasExportVariant/);
});

test('image ID lookup uses the shared IndexedDB getAllKeys operation', () => {
  assert.match(sharedSource, /export type DBRequestOperation = 'get' \| 'put' \| 'delete' \| 'clear' \| 'getAllKeys';/);
  assert.match(sharedSource, /export async function executeDBStoreRequest<T>\(/);
  assert.match(sharedSource, /const database = await openLayerForgeDB\(log, stores, openOptions\)/);
  assert.match(sharedSource, /return createDBRequest\(store, operation, data, errorMessage, log\)/);
  assert.match(sharedSource, /case 'getAllKeys':[\s\S]*?request = store\.getAllKeys\(\);/);
  assert.match(dbSource, /executeDBStoreRequest<string\[\]>\([\s\S]*?'getAllKeys',[\s\S]*?"Error getting all image IDs"/);
  assert.doesNotMatch(dbSource, /const request = store\.getAllKeys\(\);/);
});
