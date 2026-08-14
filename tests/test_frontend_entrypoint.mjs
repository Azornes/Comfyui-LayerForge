import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointSource = await readFile(
  new URL('../js/CanvasView.js', import.meta.url),
  'utf8'
);
const implementationSource = await readFile(
  new URL('../js/app/CanvasView.js', import.meta.url),
  'utf8'
);

test('frontend entrypoint registers the LayerForge ComfyUI extension contract', () => {
  assert.match(entrypointSource, /import \{ registerLayerForgeExtension \} from ["']\.\/app\/CanvasView\.js["']/);
  assert.match(entrypointSource, /registerLayerForgeExtension\(\);/);
  assert.match(implementationSource, /app\.registerExtension\(\{/);
  assert.match(implementationSource, /name:\s*["']Comfy\.LayerForgeNode["']/);
  assert.match(implementationSource, /async beforeRegisterNodeDef\(nodeType, nodeData, app\)/);
  assert.match(implementationSource, /nodeType\.comfyClass === ["']LayerForgeNode["']/);
  assert.match(implementationSource, /nodeType\.prototype\.onAdded\s*=/);
  assert.match(implementationSource, /nodeType\.prototype\.onRemoved\s*=/);
  assert.match(implementationSource, /nodeType\.prototype\.onConnectionsChange\s*=/);
  assert.match(implementationSource, /nodeType\.prototype\.onExecuted\s*=/);
  assert.match(implementationSource, /sendDataViaWebSocket\(nodeId\)/);
});
