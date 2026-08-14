import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppError,
  ErrorHandler,
  ErrorTypes,
  handleErrors,
  retryWithBackoff,
  safeExecute,
  withErrorHandling,
} from '../js/shared/error_handler.js';

test('error handler categorizes and records application errors', () => {
  const handler = new ErrorHandler();

  const error = handler.handle(new Error('network timeout'), 'upload');
  const stats = handler.getErrorStats();

  assert.ok(error instanceof AppError);
  assert.equal(error.type, ErrorTypes.NETWORK);
  assert.equal(stats.totalErrors, 1);
  assert.equal(stats.errorCounts[ErrorTypes.NETWORK], 1);
  assert.equal(stats.errorsByType[ErrorTypes.NETWORK][0].context, 'upload');

  handler.clearHistory();
  assert.equal(handler.getErrorStats().totalErrors, 0);
});

test('error wrappers preserve failures and provide fallback values', async () => {
  const wrapped = withErrorHandling(async () => {
    throw new Error('invalid image format');
  }, 'image-preparation');

  await assert.rejects(
    () => wrapped(),
    error => error instanceof AppError && error.type === ErrorTypes.VALIDATION
  );
  assert.equal(await safeExecute(async () => { throw new Error('failed'); }, 'fallback'), 'fallback');
});

test('handleErrors normalizes failures with method context', async () => {
  class TestService {}

  const target = TestService.prototype;
  const descriptor = {
    value: async function (first, second) {
      void first;
      void second;
      throw new Error('invalid image format');
    },
  };

  const decoratedDescriptor = handleErrors('image-service')(target, 'loadImage', descriptor);

  assert.equal(decoratedDescriptor, descriptor);
  await assert.rejects(
    () => descriptor.value.call(new TestService(), 'first', 'second'),
    error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.type, ErrorTypes.VALIDATION);
      assert.deepEqual(error.details, {
        context: 'image-service.loadImage',
        className: 'TestService',
        methodName: 'loadImage',
        arguments: 2,
      });
      return true;
    }
  );
});

test('retryWithBackoff retries transient operations and succeeds', async () => {
  let attempts = 0;
  const value = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('temporary network failure');
    return 'ok';
  }, 2, 0, 'test-retry');

  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});
