import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, canvasSource, canvasIOSource, webSocketSource, clipboardSource, mattingSource, routesSource, mattingApiSource] = await Promise.all([
  readFile(new URL('../src/app/canvas_view.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/canvas/canvas.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/io/canvas_io.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/web_socket_manager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/clipboard_manager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/matting_utils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../python/routes.py', import.meta.url), 'utf8'),
  readFile(new URL('../python/matting/api.py', import.meta.url), 'utf8'),
]);

const frontendSources = [appSource, canvasIOSource, clipboardSource, mattingSource].join('\n');
const backendSources = [routesSource, mattingApiSource].join('\n');

test('frontend HTTP calls have matching registered backend routes', () => {
  const routeContracts = [
    [String.raw`/layerforge/clear_input_data/\$\{nodeId\}`, '/layerforge/clear_input_data/{node_id}'],
    [String.raw`/layerforge/get_input_data/\$\{nodeId\}`, '/layerforge/get_input_data/{node_id}'],
    [String.raw`/layerforge/get-latest-images/\$\{sinceTimestamp\}`, '/layerforge/get-latest-images/{since}'],
    ['/ycnode/get_latest_image', '/ycnode/get_latest_image'],
    ['/ycnode/load_image_from_path', '/ycnode/load_image_from_path'],
    [String.raw`/matting/check-model\$\{query\}`, '/matting/check-model'],
    ['/matting/settings', '/matting/settings'],
    [String.raw`/matting/progress\?node_id=\$\{encodeURIComponent`, '/matting/progress'],
    ['/matting', '/matting'],
  ];

  for (const [frontendPath, backendPath] of routeContracts) {
    assert.match(frontendSources, new RegExp(frontendPath), `frontend route missing: ${frontendPath}`);
    assert.match(backendSources, new RegExp(`['"]${backendPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`), `backend route missing: ${backendPath}`);
  }
});

test('canvas WebSocket transport preserves payload and acknowledgement contracts', () => {
  assert.match(webSocketSource, /const wsUrl = `\$\{protocol\}\/\/\$\{location\.host\}\/layerforge\/canvas_ws`;/);
  assert.match(routesSource, /@PromptServer\.instance\.routes\.get\("\/layerforge\/canvas_ws"\)/);

  assert.match(canvasIOSource, /type: 'canvas_data'/);
  assert.match(canvasIOSource, /nodeId: String\(nodeId\)/);
  assert.match(canvasIOSource, /image: image/);
  assert.match(canvasIOSource, /mask: mask/);
  assert.match(canvasIOSource, /webSocketManager\.sendMessage\([\s\S]*?\}, true\)/);

  assert.match(webSocketSource, /if \(data\.type === 'ack' && data\.nodeId\)/);
  assert.match(routesSource, /node_id = data\.get\("nodeId"\)/);
  assert.match(routesSource, /"image": data\.get\("image"\)/);
  assert.match(routesSource, /"mask": data\.get\("mask"\)/);
  assert.match(routesSource, /send_json\(\{"type": "ack", "nodeId": node_id, "status": "success"\}\)/);
});

test('ComfyUI node and canvas lifecycles release frontend resources', () => {
  assert.match(appSource, /nodeType\.prototype\.onAdded\s*=/);
  assert.match(appSource, /canvasNodeInstances\.set\(this\.id, canvasWidget\)/);
  assert.match(appSource, /nodeType\.prototype\.onRemoved\s*=/);
  assert.match(appSource, /canvasNodeInstances\.delete\(this\.id\)/);
  assert.match(appSource, /canvasWidget\.destroy\(\)/);

  assert.match(canvasSource, /api\.addEventListener\('execution_start', handleExecutionStart\)/);
  assert.match(canvasSource, /api\.addEventListener\('execution_success', handleExecutionSuccess\)/);
  assert.match(canvasSource, /api\.removeEventListener\('execution_start', handleExecutionStart\)/);
  assert.match(canvasSource, /api\.removeEventListener\('execution_success', handleExecutionSuccess\)/);
});
