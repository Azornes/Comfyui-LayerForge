import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [canvasIOSource, imageUploadSource] = await Promise.all([
  readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/ImageUploadUtils.ts', import.meta.url), 'utf8'),
]);

test('current upload callers preserve their endpoint and form-data contracts', () => {
  assert.equal((canvasIOSource.match(/new FormData\(\)/g) ?? []).length, 0);
  assert.equal((canvasIOSource.match(/fetch\("\/upload\/image"/g) ?? []).length, 0);
  assert.equal((canvasIOSource.match(/postImageBlob\(/g) ?? []).length, 3);
  assert.equal((imageUploadSource.match(/new FormData\(\)/g) ?? []).length, 1);
  assert.equal((imageUploadSource.match(/api\.fetchApi\(/g) ?? []).length, 1);

  assert.match(canvasIOSource, /postImageBlob\(\s*\{ blob: blobWithoutMask, filename: fileNameWithoutMask \},\s*fetch\s*\)/s);
  assert.match(canvasIOSource, /postImageBlob\(\s*\{ blob, filename: fileName \},\s*fetch\s*\)/s);
  assert.match(canvasIOSource, /postImageBlob\(\s*\{ blob: maskBlob, filename: maskFileName \},\s*fetch\s*\)/s);

  assert.match(imageUploadSource, /export async function postImageBlob\(/);
  assert.match(imageUploadSource, /formData\.append\("image", request\.blob, request\.filename\)/);
  assert.match(imageUploadSource, /formData\.append\("overwrite", \(request\.overwrite \?\? true\)\.toString\(\)\)/);
  assert.match(imageUploadSource, /formData\.append\("type", request\.type\)/);
  assert.match(imageUploadSource, /return transport\("\/upload\/image"/);
  assert.match(imageUploadSource, /postImageBlob\(\{[\s\S]*?overwrite,[\s\S]*?type/s);
});
