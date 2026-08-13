import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [imageUtilsSource, clipboardSource, uploadSource, previewSource, viewSource] = await Promise.all([
  readFile(new URL('../src/utils/ImageUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/ClipboardManager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/ImageUploadUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/PreviewUtils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
]);

test('targeted image consumers use the shared Image loading lifecycle', () => {
  assert.match(imageUtilsSource, /export function loadImage\(/);

  assert.doesNotMatch(clipboardSource, /new Image\(\)/);
  assert.match(clipboardSource, /loadImage\(/);

  assert.doesNotMatch(uploadSource, /new Image\(\)/);
  assert.match(uploadSource, /loadImage\(imageUrl, \{ crossOrigin: "anonymous" \}\)/);

  assert.doesNotMatch(previewSource, /new Image\(\)/);
  assert.match(previewSource, /loadImage\(previewUrl\)/);

  assert.doesNotMatch(viewSource, /const img = new Image\(\)/);
  assert.match(viewSource, /loadPreviewImage\(blob,/);
});
