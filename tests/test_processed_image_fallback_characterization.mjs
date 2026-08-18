import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasLayersSource = await readFile(
  new URL('../js/canvas/canvas_layers.js', import.meta.url),
  'utf8'
);

function extractMethod(methodName) {
  const start = canvasLayersSource.indexOf(`    ${methodName}(`);
  assert.notEqual(start, -1, `compiled ${methodName} method should exist`);

  const bodyStart = canvasLayersSource.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < canvasLayersSource.length; index += 1) {
    const character = canvasLayersSource[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return canvasLayersSource.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not extract ${methodName}`);
}

const getGeometryKey = new Function(
  `return ({ ${extractMethod('getProcessedImageGeometryKey')} }).getProcessedImageGeometryKey;`,
)();

test('processed-image fallback remains usable for a blend-area-only rebuild', () => {
  const sourceImage = {};
  const layer = {
    id: 'layer-1',
    image: sourceImage,
    width: 100,
    height: 80,
    blendArea: 25,
  };
  const blendAreaGeometry = getGeometryKey(layer);

  layer.blendArea = 75;
  assert.equal(getGeometryKey(layer), blendAreaGeometry);

  layer.width = 120;
  assert.notEqual(getGeometryKey(layer), blendAreaGeometry);

  assert.match(canvasLayersSource, /cacheOnly && allowStaleCacheWhileDragging/);
  assert.match(canvasLayersSource, /fallback\.sourceImage === layer\.image/);
  assert.match(canvasLayersSource, /fallback\.geometryKey === this\.getProcessedImageGeometryKey\(layer\)/);
});
