import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ImageCache } from '../js/ImageCache.js';

const sourceFiles = await Promise.all([
  readFile(new URL('../src/ImageCache.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/Canvas.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasLayers.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasState.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
]);

test('image cache preserves key/value storage and clearing behavior', () => {
  const cache = new ImageCache();
  const imageSource = 'data:image/png;base64,encoded-image';

  cache.set('image-1', imageSource);

  assert.equal(cache.has('image-1'), true);
  assert.equal(cache.get('image-1'), imageSource);
  assert.equal(cache.delete('image-1'), true);
  assert.equal(cache.has('image-1'), false);

  cache.set('image-1', imageSource);

  cache.clear();

  assert.equal(cache.has('image-1'), false);
  assert.equal(cache.get('image-1'), undefined);
});

test('layer persistence uses one image cache contract', () => {
  const [cacheSource, canvasSource, layersSource, stateSource, viewSource] = sourceFiles;

  assert.match(cacheSource, /private cache: Map<string, CachedImage>/);
  assert.match(canvasSource, /imageCache: ImageCache/);
  assert.match(canvasSource, /this\.imageCache = new ImageCache\(\)/);
  assert.match(layersSource, /imageCache\.set\(imageId, image\.src\)/);
  assert.match(stateSource, /const imageSrc = this\.canvas\.imageCache\.get\(layerData\.imageId\)/);
  assert.doesNotMatch(stateSource, /imageData\.data/);
  assert.doesNotMatch(viewSource, /new ImageCache\(\)/);
});
