import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const commonUtilsSource = await readFile(
  new URL('../src/utils/CommonUtils.ts', import.meta.url),
  'utf8',
);
const typesSource = await readFile(
  new URL('../src/shared/types.ts', import.meta.url),
  'utf8',
);

test('Point has one canonical definition and CommonUtils re-exports it', () => {
  assert.doesNotMatch(commonUtilsSource, /export interface Point/);
  assert.match(commonUtilsSource, /export type \{ Point \} from ['"]\.\.\/shared\/types['"];?/);
  assert.match(typesSource, /export interface Point \{\s+x: number;\s+y: number;\s+\}/);
});
