import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasViewPath = new URL('../src/app/CanvasView.ts', import.meta.url);
const widgetTypesPath = new URL('../src/app/CanvasWidgetTypes.ts', import.meta.url);
const connectionsPath = new URL('../src/app/LayerForgeConnections.ts', import.meta.url);

test('app integration responsibilities have dedicated modules', async () => {
  await Promise.all([
    access(widgetTypesPath),
    access(connectionsPath),
  ]);

  const canvasViewSource = await readFile(canvasViewPath, 'utf8');
  const connectionsSource = await readFile(connectionsPath, 'utf8');

  assert.match(canvasViewSource, /from ["']\.\/CanvasWidgetTypes\.js["']/);
  assert.match(canvasViewSource, /from ["']\.\/LayerForgeConnections\.js["']/);
  assert.match(connectionsSource, /export const canvasNodeInstances/);
  assert.match(connectionsSource, /export const installLayerForgeVirtualWirePatch/);
  assert.match(connectionsSource, /export const installLayerForgeMultiImagePromptPatch/);
  assert.match(connectionsSource, /export const pruneLayerForgeTransportInputs/);
  assert.doesNotMatch(canvasViewSource, /const canvasNodeInstances = new Map/);
  assert.doesNotMatch(canvasViewSource, /const installLayerForgeVirtualWirePatch/);
});
