import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasViewPath = new URL('../src/app/canvas_view.ts', import.meta.url);
const widgetTypesPath = new URL('../src/app/canvas_widget_types.ts', import.meta.url);
const connectionsPath = new URL('../src/app/layer_forge_connections.ts', import.meta.url);

test('app integration responsibilities have dedicated modules', async () => {
  await Promise.all([
    access(widgetTypesPath),
    access(connectionsPath),
  ]);

  const canvasViewSource = await readFile(canvasViewPath, 'utf8');
  const connectionsSource = await readFile(connectionsPath, 'utf8');

  assert.match(canvasViewSource, /from ["']\.\/canvas_widget_types\.js["']/);
  assert.match(canvasViewSource, /from ["']\.\/layer_forge_connections\.js["']/);
  assert.match(connectionsSource, /export const canvasNodeInstances/);
  assert.match(connectionsSource, /export const installLayerForgeVirtualWirePatch/);
  assert.match(connectionsSource, /export const installLayerForgeMultiImagePromptPatch/);
  assert.match(connectionsSource, /export const pruneLayerForgeTransportInputs/);
  assert.doesNotMatch(canvasViewSource, /const canvasNodeInstances = new Map/);
  assert.doesNotMatch(canvasViewSource, /const installLayerForgeVirtualWirePatch/);
});
