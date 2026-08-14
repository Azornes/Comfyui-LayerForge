import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [utilitySource, canvasViewSource, connectionsSource, canvasIOSource] = await Promise.all([
  readFile(new URL('../src/utils/multi_image_input_utils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/canvas_view.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/layer_forge_connections.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/io/canvas_io.ts', import.meta.url), 'utf8'),
]);

test('LayerForge exposes an ordered virtual multi-image input contract', () => {
  assert.match(utilitySource, /LAYERFORGE_IMAGE_LINKS_PROPERTY = 'layerforge_input_image_links'/);
  assert.match(utilitySource, /LAYERFORGE_MAX_IMAGE_INPUTS = 32/);
  assert.match(utilitySource, /addLayerForgeImageInputLink/);
  assert.match(utilitySource, /getLayerForgeImageInputSlot/);
  assert.match(connectionsSource, /installLayerForgeMultiImagePromptPatch/);
  assert.match(connectionsSource, /input_image_\$\{index \+ 1\}/);
  assert.match(connectionsSource, /scheduleLayerForgeImageConnectionConversion/);
  assert.match(connectionsSource, /pruneLayerForgeTransportInputs/);
  assert.match(connectionsSource, /drawLayerForgeVirtualLinks/);
  assert.match(connectionsSource, /installLayerForgeVirtualWirePatch/);
  assert.match(connectionsSource, /bezierCurveTo/);
  assert.match(connectionsSource, /hitTestLayerForgeVirtualLinks/);
  assert.match(connectionsSource, /Remove connection/);
  assert.match(connectionsSource, /removeLayerForgeImageInputLink/);
  assert.match(connectionsSource, /installLayerForgeQuickCreateCapture/);
  assert.match(connectionsSource, /createLayerForgeLoadImageNode/);
  assert.match(connectionsSource, /content: 'Load image'/);
  assert.match(connectionsSource, /scheduleLayerForgeQuickCreateMenu/);
  assert.match(canvasViewSource, /Show Inputs/);
  assert.match(canvasViewSource, /lf-inputs-menu/);
  assert.match(canvasViewSource, /addSelectedInputImage/);
  assert.match(canvasViewSource, /Unlink/);
  assert.match(canvasViewSource, /unlinkConnectedInputImage/);
  assert.match(canvasIOSource, /getConnectedInputImages\(\)/);
  assert.match(canvasIOSource, /unlinkConnectedInputImage\(/);
  assert.match(canvasIOSource, /connectionIndex: \+\+connectionIndex/);
});

test('CanvasIO uses virtual source links for immediate canvas loading', () => {
  assert.match(canvasViewSource, /hasLayerForgeImageInput\(this\)/);
  assert.match(canvasViewSource, /canvasIO\.checkForInputData\(\{ allowImage: true, allowMask: false, reason: "image_connect" \}\)/);
});
