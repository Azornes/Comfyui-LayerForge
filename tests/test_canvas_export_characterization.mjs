import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasViewSource = await readFile(
  new URL('../js/app/canvas_view.js', import.meta.url),
  'utf8'
);

test('canvas context menu exposes both export variants for each action', () => {
  for (const label of [
    'Open Image',
    'Open Image with Mask Alpha',
    'Copy Image',
    'Copy Image with Mask Alpha',
    'Save Image',
    'Save Image with Mask Alpha',
  ]) {
    assert.equal(
      canvasViewSource.split(`content: "${label}"`).length - 1,
      1,
      `${label} should be registered once`
    );
  }

  assert.match(canvasViewSource, /exportCanvasImage/);
  assert.match(canvasViewSource, /runCanvasExport\('open', 'plain'\)/);
  assert.match(canvasViewSource, /runCanvasExport\('open', 'with-mask'\)/);
  assert.match(canvasViewSource, /runCanvasExport\('copy', 'plain'\)/);
  assert.match(canvasViewSource, /runCanvasExport\('copy', 'with-mask'\)/);
  assert.match(canvasViewSource, /runCanvasExport\('download', 'plain', 'canvas_output\.png'\)/);
  assert.match(canvasViewSource, /runCanvasExport\('download', 'with-mask', 'canvas_output_with_mask\.png'\)/);
  assert.match(canvasViewSource, /canvas_output\.png/);
  assert.match(canvasViewSource, /canvas_output_with_mask\.png/);
});
