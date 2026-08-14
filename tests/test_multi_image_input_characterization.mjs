import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [utilitySource, canvasViewSource, canvasIOSource] = await Promise.all([
  readFile(new URL('../src/utils/MultiImageInputUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8'),
]);

test('LayerForge exposes an ordered virtual multi-image input contract', () => {
  assert.match(utilitySource, /LAYERFORGE_IMAGE_LINKS_PROPERTY = 'layerforge_input_image_links'/);
  assert.match(utilitySource, /LAYERFORGE_MAX_IMAGE_INPUTS = 32/);
  assert.match(utilitySource, /addLayerForgeImageInputLink/);
  assert.match(utilitySource, /getLayerForgeImageInputSlot/);
  assert.match(canvasViewSource, /installLayerForgeMultiImagePromptPatch/);
  assert.match(canvasViewSource, /input_image_\$\{index \+ 1\}/);
  assert.match(canvasViewSource, /scheduleLayerForgeImageConnectionConversion/);
  assert.match(canvasViewSource, /pruneLayerForgeTransportInputs/);
  assert.match(canvasViewSource, /drawLayerForgeVirtualLinks/);
  assert.match(canvasViewSource, /installLayerForgeVirtualWirePatch/);
  assert.match(canvasViewSource, /bezierCurveTo/);
  assert.match(canvasViewSource, /hitTestLayerForgeVirtualLinks/);
  assert.match(canvasViewSource, /Remove connection/);
  assert.match(canvasViewSource, /removeLayerForgeImageInputLink/);
  assert.match(canvasViewSource, /installLayerForgeQuickCreateCapture/);
  assert.match(canvasViewSource, /createLayerForgeLoadImageNode/);
  assert.match(canvasViewSource, /content: 'Load image'/);
  assert.match(canvasViewSource, /scheduleLayerForgeQuickCreateMenu/);
  assert.match(canvasViewSource, /Show Inputs/);
  assert.match(canvasViewSource, /lf-inputs-menu/);
  assert.match(canvasViewSource, /addSelectedInputImage/);
  assert.match(canvasIOSource, /getConnectedInputImages\(\)/);
  assert.match(canvasIOSource, /connectionIndex: \+\+connectionIndex/);
});

test('CanvasIO uses virtual source links for immediate canvas loading', () => {
  assert.match(canvasViewSource, /hasLayerForgeImageInput\(this\)/);
  assert.match(canvasViewSource, /canvasIO\.checkForInputData\(\{ allowImage: true, allowMask: false, reason: "image_connect" \}\)/);
});
