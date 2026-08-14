import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

class FakeObjectStore {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.records = new Map();
  }

  get(key) {
    return this.createRequest(() => this.records.get(key));
  }

  put(value) {
    return this.createRequest(() => {
      const key = value[this.keyPath];
      this.records.set(key, value);
      return key;
    });
  }

  delete(key) {
    return this.createRequest(() => {
      this.records.delete(key);
      return undefined;
    });
  }

  clear() {
    return this.createRequest(() => {
      this.records.clear();
      return undefined;
    });
  }

  getAllKeys() {
    return this.createRequest(() => [...this.records.keys()]);
  }

  createRequest(operation) {
    const request = {
      error: null,
      onsuccess: null,
      onerror: null,
      result: undefined,
    };

    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });

    return request;
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = {
      contains: name => this.stores.has(name),
    };
  }

  createObjectStore(name, { keyPath }) {
    const store = new FakeObjectStore(keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames) {
    return {
      objectStore: name => {
        assert.ok(storeNames.includes(name));
        return this.stores.get(name);
      },
    };
  }
}

function createFakeIndexedDB() {
  const databases = new Map();
  const opens = [];

  return {
    opens,
    open(name, version) {
      opens.push({ name, version });
      const request = {
        error: null,
        onerror: null,
        onupgradeneeded: null,
        onsuccess: null,
        result: undefined,
      };

      queueMicrotask(() => {
        let database = databases.get(name);
        if (!database) {
          database = new FakeDatabase();
          databases.set(name, database);
          request.result = database;
          request.onupgradeneeded?.({ target: request });
        }

        request.result = database;
        request.onsuccess?.({ target: request });
      });

      return request;
    },
  };
}

test('IndexedDB persistence preserves state and image lifecycle behavior', async () => {
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const fakeIndexedDB = createFakeIndexedDB();
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: fakeIndexedDB,
  });

  try {
    const {
      clearAllCanvasStates,
      getAllImageIds,
      getCanvasState,
      getImage,
      removeCanvasState,
      removeImage,
      saveImage,
      setCanvasState,
    } = await import('../js/persistence/db.js?characterization');

    assert.equal(await getCanvasState('missing-node'), null);
    await setCanvasState('node-1', { layers: [{ id: 'layer-1' }] });
    assert.deepEqual(await getCanvasState('node-1'), { layers: [{ id: 'layer-1' }] });
    await removeCanvasState('node-1');
    assert.equal(await getCanvasState('node-1'), null);

    await saveImage('image-1', 'data:image/png;base64,test');
    assert.equal(await getImage('image-1'), 'data:image/png;base64,test');
    assert.deepEqual(await getAllImageIds(), ['image-1']);

    await clearAllCanvasStates();
    assert.equal(await getCanvasState('node-1'), null);
    assert.equal(await getImage('image-1'), 'data:image/png;base64,test');

    await removeImage('image-1');
    assert.equal(await getImage('image-1'), null);
    assert.deepEqual(fakeIndexedDB.opens, [{ name: 'CanvasNodeDB', version: 3 }]);
  } finally {
    if (originalIndexedDB) {
      Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
    } else {
      delete globalThis.indexedDB;
    }
  }
});

test('the worker uses shared database infrastructure for canvas-state persistence', async () => {
  const sharedSource = await readFile(new URL('../src/persistence/db_shared.ts', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('../src/persistence/state-saver.worker.ts', import.meta.url), 'utf8');

  assert.match(sharedSource, /export const DB_NAME = 'CanvasNodeDB'/);
  assert.match(sharedSource, /export const STATE_STORE_NAME = 'CanvasState'/);
  assert.match(sharedSource, /export const IMAGE_STORE_NAME = 'CanvasImages'/);
  assert.match(sharedSource, /export const DB_VERSION = 3/);
  assert.match(workerSource, /from '\.\/db_shared\.js'/);
  assert.match(workerSource, /executeDBStoreRequest<void>\(\s*dbLogger,\s*\[STATE_STORE\]/s);
  assert.doesNotMatch(workerSource, /const DB_NAME/);
  assert.doesNotMatch(workerSource, /function openDB/);
  assert.doesNotMatch(workerSource, /function createDBRequest/);
});

test('database callers share one transaction helper while preserving store and worker options', async () => {
  const [dbSource, workerSource] = await Promise.all([
    readFile(new URL('../src/persistence/db.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/persistence/state-saver.worker.ts', import.meta.url), 'utf8'),
  ]);

  assert.equal((dbSource.match(/executeDBStoreRequest</g) ?? []).length, 8);
  assert.doesNotMatch(dbSource, /const transaction = db\.transaction\(/);
  assert.doesNotMatch(dbSource, /const store = transaction\.objectStore\(/);
  assert.match(workerSource, /executeDBStoreRequest<void>\(/);
  assert.doesNotMatch(workerSource, /const transaction = db\.transaction\(/);
  assert.doesNotMatch(workerSource, /const store = transaction\.objectStore\(/);
  assert.match(workerSource, /openingMessage: null/);
  assert.match(workerSource, /logStoreCreation: false/);
});
