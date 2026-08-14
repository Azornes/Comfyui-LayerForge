import assert from 'node:assert/strict';
import test from 'node:test';

import { exportCanvasImage } from '../js/media/CanvasExportUtils.js';

function installBrowserStubs() {
  const globalKeys = ['ClipboardItem', 'URL', 'document', 'navigator', 'window'];
  const originalDescriptors = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );

  const openedUrls = [];
  const revokedUrls = [];
  const clipboardItems = [];
  const downloads = [];
  let nextUrl = 0;

  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class ClipboardItem {
    constructor(items) {
      this.items = items;
    }
    },
  });

  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: {
    createObjectURL() {
      nextUrl += 1;
      return `blob:test-${nextUrl}`;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
    },
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
    open(url, target) {
      openedUrls.push({ url, target });
    },
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
    clipboard: {
      async write(items) {
        clipboardItems.push(...items.map((item) => item.items));
      },
    },
    },
  });

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        click() {
          downloads.push({ href: this.href, filename: this.download });
        },
      };
    },
    },
  });

  return {
    openedUrls,
    revokedUrls,
    clipboardItems,
    downloads,
    restore() {
      for (const key of globalKeys) {
        const descriptor = originalDescriptors.get(key);
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete globalThis[key];
        }
      }
    },
  };
}

test('exportCanvasImage selects the requested canvas variant and action', async () => {
  const stubs = installBrowserStubs();
  const plainBlob = new Blob(['plain'], { type: 'image/png' });
  const maskedBlob = new Blob(['masked'], { type: 'image/png' });
  const calls = [];
  const canvas = {
    canvasLayers: {
      async getFlattenedCanvasAsBlob() {
        calls.push('plain');
        return plainBlob;
      },
      async getFlattenedCanvasWithMaskAsBlob() {
        calls.push('with-mask');
        return maskedBlob;
      },
    },
  };

  try {
    assert.equal(await exportCanvasImage(canvas, { action: 'open', variant: 'plain' }), true);
    assert.equal(await exportCanvasImage(canvas, { action: 'copy', variant: 'with-mask' }), true);
    assert.equal(await exportCanvasImage(canvas, {
      action: 'download',
      variant: 'plain',
      filename: 'canvas_output.png',
    }), true);

    assert.deepEqual(calls, ['plain', 'with-mask', 'plain']);
    assert.deepEqual(stubs.openedUrls, [{ url: 'blob:test-1', target: '_blank' }]);
    assert.deepEqual(stubs.clipboardItems, [{ 'image/png': maskedBlob }]);
    assert.deepEqual(stubs.downloads, [{ href: 'blob:test-2', filename: 'canvas_output.png' }]);
    assert.deepEqual(stubs.revokedUrls, []);
  } finally {
    stubs.restore();
  }
});

test('exportCanvasImage preserves the empty-blob no-op behavior', async () => {
  const stubs = installBrowserStubs();
  const canvas = {
    canvasLayers: {
      async getFlattenedCanvasAsBlob() {
        return null;
      },
    },
  };

  try {
    assert.equal(await exportCanvasImage(canvas, { action: 'open', variant: 'plain' }), false);
    assert.deepEqual(stubs.openedUrls, []);
    assert.deepEqual(stubs.downloads, []);
  } finally {
    stubs.restore();
  }
});
