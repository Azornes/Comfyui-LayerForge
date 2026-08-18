import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasLayersSource = await readFile(
  new URL('../js/canvas/canvas_layers.js', import.meta.url),
  'utf8'
);
const canvasRendererSource = await readFile(
  new URL('../js/canvas/canvas_renderer.js', import.meta.url),
  'utf8'
);

function extractMethod(methodName) {
  const start = canvasLayersSource.indexOf(`    ${methodName}(`);
  assert.notEqual(start, -1, `compiled ${methodName} method should exist`);

  const bodyStart = canvasLayersSource.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${methodName} should have a body`);

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

const methodFactory = new Function(
  `return {\n${[
    extractMethod('isSourceOverBlendMode'),
    extractMethod('getDragCanvasBlendMode'),
    extractMethod('createDragStaticSegments'),
  ].join(',\n')}\n};`,
);
const methods = methodFactory();

test('drag scene cache groups source-over layers and replays non-normal modes', () => {
  const context = {
    isSourceOverBlendMode: methods.isSourceOverBlendMode,
    getDragCanvasBlendMode: methods.getDragCanvasBlendMode,
  };
  const layers = [
    { id: 'lower', blendMode: 'normal', opacity: 0.8 },
    { id: 'middle', blendMode: 'source-over', opacity: 0.6 },
    { id: 'blend', blendMode: 'multiply', opacity: 0.5 },
    { id: 'upper', blendMode: 'screen', opacity: 0.7 },
    { id: 'top', blendMode: 'normal', opacity: 1 },
  ];

  const segments = methods.createDragStaticSegments.call(context, layers);

  assert.equal(segments.length, 4);
  assert.deepEqual(segments.map(segment => segment.layers.map(layer => layer.id)), [
    ['lower', 'middle'],
    ['blend'],
    ['upper'],
    ['top'],
  ]);
  assert.deepEqual(segments.map(({ blendMode, opacity, applyLayerOpacity }) => ({
    blendMode,
    opacity,
    applyLayerOpacity,
  })), [
    { blendMode: 'source-over', opacity: 1, applyLayerOpacity: true },
    { blendMode: 'multiply', opacity: 0.5, applyLayerOpacity: false },
    { blendMode: 'screen', opacity: 0.7, applyLayerOpacity: false },
    { blendMode: 'source-over', opacity: 1, applyLayerOpacity: true },
  ]);

  assert.match(canvasRendererSource, /canReuseDragFrame/);
  assert.match(canvasRendererSource, /getDragDirtyRect/);
  assert.match(canvasRendererSource, /ctx\.clip\(\)/);
  assert.match(canvasLayersSource, /getOrCreateDragLayerPreview/);
  assert.match(canvasLayersSource, /dragPreview: \{ viewport, width, height \}/);
  assert.match(canvasLayersSource, /ctx\.drawImage\(preview, -layer\.width \/ 2/);
});
