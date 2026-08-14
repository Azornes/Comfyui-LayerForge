import assert from 'node:assert/strict';
import test from 'node:test';

const currentState = {
  layers: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  width: 512,
  height: 512,
  outputAreaBounds: { x: 0, y: 0, width: 512, height: 512 },
};

test('persisted state migration restores defaults for legacy records', async () => {
  const { migratePersistedCanvasState } = await import('../js/persistence/contracts.js?resilience');

  const migrated = migratePersistedCanvasState({
    layers: [{
      id: 'legacy-layer',
      imageSrc: 'data:image/png;base64,legacy',
      width: 320,
      height: 240,
    }],
    width: 1024,
    height: 768,
  });

  assert.deepEqual(migrated, {
    version: 2,
    layers: [{
      id: 'legacy-layer',
      imageSrc: 'data:image/png;base64,legacy',
      width: 320,
      height: 240,
    }],
    viewport: { x: -256, y: -192, zoom: 0.8 },
    width: 1024,
    height: 768,
    outputAreaBounds: { x: -256, y: -192, width: 1024, height: 768 },
  });
});

test('persisted state migration rejects corrupted or incomplete records', async () => {
  const { migratePersistedCanvasState } = await import('../js/persistence/contracts.js?resilience-invalid');

  assert.equal(migratePersistedCanvasState(null), null);
  assert.equal(migratePersistedCanvasState({}), null);
  assert.equal(migratePersistedCanvasState({ layers: null }), null);
  assert.equal(migratePersistedCanvasState({ layers: [{ id: 'missing-image' }] }), null);
});

test('database requests reject the underlying IndexedDB error', async () => {
  const { createDBRequest } = await import('../js/persistence/db_shared.js?resilience-request');
  const storageError = new Error('quota exceeded');
  const logs = [];
  const store = {
    get() {
      const request = { error: storageError, onerror: null, onsuccess: null };
      queueMicrotask(() => request.onerror?.({ target: request }));
      return request;
    },
  };

  await assert.rejects(
    createDBRequest(store, 'get', 'node-1', 'Unable to read state', {
      error: (...args) => logs.push(args),
      info() {},
    }),
    storageError,
  );
  assert.equal(logs.length, 1);
});

test('state saver worker ignores malformed messages and reports storage failures', async () => {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalConsoleError = console.error;
  const errors = [];

  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request = {
          error: new Error('worker quota exceeded'),
          onerror: null,
          onupgradeneeded: null,
          onsuccess: null,
          result: undefined,
        };
        queueMicrotask(() => request.onerror?.({ target: request }));
        return request;
      },
    },
  });
  console.error = (...args) => errors.push(args);

  try {
    await import('../js/persistence/state_saver.worker.js?resilience-worker');
    await globalThis.self.onmessage({ data: { stateKey: '', state: null } });
    assert.match(errors.flat().join(' '), /Invalid data received/);

    await globalThis.self.onmessage({
      data: {
        stateKey: 'node-1',
        state: currentState,
      },
    });
    assert.match(errors.flat().join(' '), /Failed to save state for key: node-1/);
  } finally {
    console.error = originalConsoleError;
    if (originalSelf) {
      Object.defineProperty(globalThis, 'self', originalSelf);
    } else {
      delete globalThis.self;
    }
    if (originalIndexedDB) {
      Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
    } else {
      delete globalThis.indexedDB;
    }
  }
});
