import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../src/utils/ImageUploadUtils.ts', import.meta.url),
  'utf8'
);

function getFunctionBody(functionName, nextFunctionName) {
  const start = [
    source.indexOf(`export const ${functionName}`),
    source.indexOf(`async function ${functionName}`),
  ].find((index) => index !== -1);
  const end = source.indexOf(`export const ${nextFunctionName}`, start);

  assert.notEqual(start, -1, `${functionName} should exist`);
  assert.notEqual(end, -1, `${nextFunctionName} should exist after ${functionName}`);
  return source.slice(start, end);
}

test('canvas upload variants share blob selection while preserving their policies', () => {
  const helperBody = getFunctionBody('getCanvasBlobForUpload', 'uploadImageBlob');
  const plainBody = getFunctionBody('uploadCanvasAsImage', 'uploadCanvasWithMaskAsImage');
  const maskedBody = source.slice(source.indexOf('export const uploadCanvasWithMaskAsImage'));

  assert.match(helperBody, /supportsFlattenedCanvasBlob\(canvas, config\.variant\)/);
  assert.match(helperBody, /getFlattenedCanvasBlob\(canvas, config\.variant\)/);
  assert.match(helperBody, /config\.allowNativeCanvasFallback && canvas instanceof HTMLCanvasElement/);
  assert.match(helperBody, /canvas\.toBlob\(resolve\)/);
  assert.match(helperBody, /config\.unsupportedCanvasMessage/);
  assert.match(helperBody, /config\.emptyBlobMessage/);

  assert.match(plainBody, /variant: 'plain'/);
  assert.match(plainBody, /allowNativeCanvasFallback: true/);
  assert.match(plainBody, /unsupportedCanvasMessage: "Unsupported canvas type"/);
  assert.match(plainBody, /emptyBlobMessage: "Failed to generate canvas blob"/);
  assert.match(plainBody, /return uploadImageBlob\(blob, options\)/);

  assert.match(maskedBody, /variant: 'with-mask'/);
  assert.match(maskedBody, /allowNativeCanvasFallback: false/);
  assert.match(maskedBody, /unsupportedCanvasMessage: "Canvas does not support mask operations"/);
  assert.match(maskedBody, /emptyBlobMessage: "Failed to generate canvas with mask blob"/);
  assert.match(maskedBody, /return uploadImageBlob\(blob, options\)/);
});

test('canvas upload public wrappers retain their error-handling contexts', () => {
  assert.match(source, /\}, 'uploadCanvasAsImage'\);/);
  assert.match(source, /\}, 'uploadCanvasWithMaskAsImage'\);/);
  assert.equal((source.match(/return uploadImageBlob\(blob, options\)/g) ?? []).length, 2);
});
