import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getImageAddMode,
  isFitOnAddEnabled,
} from '../js/utils/CanvasInputUtils.js';

const [canvasIOSource, canvasViewSource, interactionsSource, inputUtilsSource] = await Promise.all([
  readFile(new URL('../src/CanvasIO.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasView.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/CanvasInteractions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/CanvasInputUtils.ts', import.meta.url), 'utf8'),
]);

test('image entry points use the shared fit_on_add policy', () => {
  assert.match(inputUtilsSource, /export function isFitOnAddEnabled\(/);
  assert.match(inputUtilsSource, /export function getImageAddMode\(/);
  assert.equal((canvasIOSource.match(/getImageAddMode\(this/g) ?? []).length, 2);
  assert.equal((canvasIOSource.match(/isFitOnAddEnabled\(this/g) ?? []).length, 2);
  assert.equal((canvasViewSource.match(/getImageAddMode\(node/g) ?? []).length, 2);
  assert.equal((interactionsSource.match(/getImageAddMode\(this/g) ?? []).length, 1);
  assert.doesNotMatch(canvasIOSource, /find\(.*fit_on_add/);
  assert.doesNotMatch(canvasViewSource, /find\(.*fit_on_add/);
  assert.doesNotMatch(interactionsSource, /find\(.*fit_on_add/);
});

test('shared fit_on_add helper preserves fit and center behavior', () => {
  assert.equal(isFitOnAddEnabled([{ name: 'fit_on_add', value: true }]), true);
  assert.equal(isFitOnAddEnabled([{ name: 'fit_on_add', value: false }]), false);
  assert.equal(isFitOnAddEnabled([{ name: 'fit_on_add', value: 1 }]), true);
  assert.equal(isFitOnAddEnabled([{ name: 'other', value: true }]), false);
  assert.equal(isFitOnAddEnabled(undefined), false);

  assert.equal(getImageAddMode([{ name: 'fit_on_add', value: true }]), 'fit');
  assert.equal(getImageAddMode([{ name: 'fit_on_add', value: false }]), 'center');
  assert.equal(getImageAddMode(undefined), 'center');
});
