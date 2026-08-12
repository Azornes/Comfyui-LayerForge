import assert from 'node:assert/strict';
import test from 'node:test';

import { Logger, LogLevel, logger as sharedLogger } from '../js/log_system/logger.js';
import { createModuleLogger, withErrorLogging } from '../js/log_system/log_funcs.js';


function silenceConsole() {
  const methods = ['debug', 'info', 'warn', 'error', 'log', 'groupCollapsed', 'groupEnd'];
  const originals = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) {
    console[method] = () => {};
  }
  return () => {
    for (const [method, original] of Object.entries(originals)) {
      console[method] = original;
    }
  };
}


test('canonical logger handles levels, retention, and callsites', () => {
  const restoreConsole = silenceConsole();
  try {
    const logger = new Logger();
    logger.configure({
      enabled: true,
      globalLevel: LogLevel.DEBUG,
      useColors: false,
      saveToStorage: false,
      maxStoredLogs: 3,
      compactCallsite: false,
    });

    logger.debug('LayerForge.test', 'debug message');
    logger.info('LayerForge.test', 'info message');
    logger.error('LayerForge.test', 'error message');
    logger.fatal('LayerForge.test', 'fatal message');

    assert.equal(logger.logs.length, 3);
    assert.equal(logger.logs[0].level, LogLevel.INFO);
    assert.equal(logger.logs.at(-1).level, LogLevel.FATAL);
    assert.equal(logger.splitModuleName('LayerForge.canvas').detail, 'canvas');
    assert.equal(logger.normalizeLevel('warning'), LogLevel.WARN);
    assert.equal(logger.normalizeLevel('critical'), LogLevel.FATAL);
    assert.equal(logger.parseJsonPayloadFromString('message {"value": 1}').value.value, 1);
    assert.match(logger.formatSuffix('canvas', 'Canvas.ts:10:2'), /Canvas\.ts:10:2/);

    logger.setModuleLevel('quiet', LogLevel.NONE);
    assert.equal(logger.isLevelEnabled('quiet', LogLevel.ERROR), false);
    logger.setEnabled(false);
    assert.equal(logger.isLevelEnabled('LayerForge.test', LogLevel.ERROR), false);

    assert.equal(sharedLogger.constructor, Logger);
    assert.equal(typeof createModuleLogger('LayerForge.test').error, 'function');
  } finally {
    restoreConsole();
  }
});


test('logger exception preserves an Error argument and helper wrappers report lifecycle', async () => {
  const restoreConsole = silenceConsole();
  try {
    const logger = new Logger();
    logger.configure({
      enabled: true,
      globalLevel: LogLevel.DEBUG,
      useColors: false,
      saveToStorage: false,
      compactCallsite: false,
    });

    logger.exception('LayerForge.test', 'failed', new Error('boom'));
    assert.equal(logger.logs.at(-1).args.at(-1).message, 'boom');

    const events = [];
    const wrapped = withErrorLogging(
      async (value) => value + 1,
      {
        debug: (message) => events.push(message),
        error: (message) => events.push(message),
      },
      'increment',
    );

    assert.equal(await wrapped(2), 3);
    assert.deepEqual(events, ['Starting increment', 'Completed increment']);
  } finally {
    restoreConsole();
  }
});
