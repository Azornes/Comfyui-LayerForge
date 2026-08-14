import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasIOSource = await readFile(
  new URL('../src/io/CanvasIO.ts', import.meta.url),
  'utf8'
);
const canvasIOCompiledSource = await readFile(
  new URL('../js/io/CanvasIO.js', import.meta.url),
  'utf8'
);

test('CanvasIO routes three independent disk stages through one PNG blob helper', () => {
  assert.equal((canvasIOSource.match(/canvasToPngBlob\(/g) ?? []).length, 4);
  assert.equal((canvasIOSource.match(/\.toBlob\(/g) ?? []).length, 1);
  assert.equal((canvasIOSource.match(/"image\/png"/g) ?? []).length, 1);
  assert.match(canvasIOSource, /private canvasToPngBlob\(/);
  assert.match(canvasIOSource, /this\.canvasToPngBlob\(tempCanvas, async \(blobWithoutMask\)/);
  assert.match(canvasIOSource, /this\.canvasToPngBlob\(tempCanvas, async \(blob\)/);
  assert.match(canvasIOSource, /this\.canvasToPngBlob\(maskCanvas, async \(maskBlob\)/);
});

test('canvasToPngBlob preserves Blob, null, and PNG MIME callback behavior', () => {
  const methodStart = canvasIOCompiledSource.indexOf('    canvasToPngBlob(');
  const methodEnd = canvasIOCompiledSource.indexOf('\n    async saveToServer', methodStart);
  assert.notEqual(methodStart, -1, 'compiled canvasToPngBlob helper should exist');
  assert.notEqual(methodEnd, -1, 'compiled canvasToPngBlob helper should precede saveToServer');

  const methodSource = canvasIOCompiledSource.slice(methodStart, methodEnd).trim();
  const canvasToPngBlob = new Function(
    `return ({ ${methodSource} }).canvasToPngBlob;`,
  )();
  const calls = [];
  const blob = { size: 12 };
  const canvas = {
    toBlob(callback, mimeType) {
      calls.push(mimeType);
      callback(blob);
    },
  };
  let receivedBlob;

  canvasToPngBlob.call({}, canvas, value => {
    receivedBlob = value;
  });
  assert.equal(receivedBlob, blob);

  canvas.toBlob = (callback, mimeType) => {
    calls.push(mimeType);
    callback(null);
  };
  receivedBlob = blob;
  canvasToPngBlob.call({}, canvas, value => {
    receivedBlob = value;
  });

  assert.equal(receivedBlob, null);
  assert.deepEqual(calls, ['image/png', 'image/png']);
});
