import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointSource = await readFile(
  new URL('../js/CanvasView.js', import.meta.url),
  'utf8'
);

test('frontend entrypoint registers the LayerForge ComfyUI extension contract', () => {
  assert.match(entrypointSource, /app\.registerExtension\(\{/);
  assert.match(entrypointSource, /name:\s*["']Comfy\.LayerForgeNode["']/);
  assert.match(entrypointSource, /async beforeRegisterNodeDef\(nodeType, nodeData, app\)/);
  assert.match(entrypointSource, /nodeType\.comfyClass === ["']LayerForgeNode["']/);
  assert.match(entrypointSource, /nodeType\.prototype\.onAdded\s*=/);
  assert.match(entrypointSource, /nodeType\.prototype\.onRemoved\s*=/);
  assert.match(entrypointSource, /nodeType\.prototype\.onConnectionsChange\s*=/);
  assert.match(entrypointSource, /nodeType\.prototype\.onExecuted\s*=/);
  assert.match(entrypointSource, /sendDataViaWebSocket\(nodeId\)/);
});
