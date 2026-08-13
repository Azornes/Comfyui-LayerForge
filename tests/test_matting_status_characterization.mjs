import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { fetchMattingModelStatus } from '../js/utils/MattingUtils.js';

const canvasViewSource = await readFile(
  new URL('../src/CanvasView.ts', import.meta.url),
  'utf8',
);

test('shared matting status helper preserves endpoint, payload, and errors', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url) => {
    requests.push(url);
    const isErrorResponse = requests.length === 3;
    return {
      ok: !isErrorResponse,
      json: async () => ({
        available: !isErrorResponse,
        reason: isErrorResponse ? 'error' : 'ready',
        message: isErrorResponse ? 'failed' : 'ready',
        models: [],
      }),
    };
  };

  try {
    const automatic = await fetchMattingModelStatus();
    const selected = await fetchMattingModelStatus('models/my model.safetensors');
    const failed = await fetchMattingModelStatus('models/missing.safetensors');

    assert.deepEqual(requests, [
      '/matting/check-model',
      '/matting/check-model?model_path=models%2Fmy%20model.safetensors',
      '/matting/check-model?model_path=models%2Fmissing.safetensors',
    ]);
    assert.equal(automatic.ok, true);
    assert.equal(automatic.data.reason, 'ready');
    assert.equal(selected.data.message, 'ready');
    assert.equal(failed.ok, false);
    assert.equal(failed.data.reason, 'error');

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    await assert.rejects(fetchMattingModelStatus(), /offline/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CanvasView delegates both model status checks to the shared helper', () => {
  assert.match(canvasViewSource, /fetchMattingModelStatus<MattingModelOption>\(\)/);
  assert.match(canvasViewSource, /fetchMattingModelStatus\(mattingSettings\.modelPath\)/);
  assert.doesNotMatch(canvasViewSource, /const modelCheckUrl =/);
  assert.doesNotMatch(canvasViewSource, /fetch\(['"]\/matting\/check-model/);
});

test('Matting refreshes the layer panel after replacing a layer object', () => {
  assert.match(
    canvasViewSource,
    /canvas\.layers\[selectedLayerIndex\] = newLayer;\s+canvas\.canvasSelection\.updateSelection\(\[newLayer\]\);\s+canvas\.canvasLayersPanel\?\.onLayersChanged\(\);/,
  );
});
