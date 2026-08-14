import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('WebSocket manager reconnects and rejects pending acknowledgements on destroy', async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    send(message) {
      this.sent.push(message);
    }

    drop() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ wasClean: false, code: 1006, reason: 'network' });
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ wasClean: true, code: 1000, reason: 'destroyed' });
    }
  }

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost' },
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
  });

  try {
    const { WebSocketManager, webSocketManager } = await import('../js/utils/WebSocketManager.js?resilience');
    const manager = new WebSocketManager('ws://localhost/layerforge/canvas_ws');
    manager.reconnectInterval = 0;

    const firstSocket = sockets.at(-1);
    firstSocket.open();
    firstSocket.drop();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(sockets.length, 3);
    sockets.at(-1).open();

    const pendingAck = manager.sendMessage({ type: 'canvas_data', nodeId: 'node-1' }, true);
    manager.destroy();
    await assert.rejects(pendingAck);

    const socketCountAfterDestroy = sockets.length;
    sockets.at(-1).drop();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sockets.length, socketCountAfterDestroy);

    webSocketManager.destroy();
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', originalLocation);
    } else {
      delete globalThis.location;
    }
    if (originalWebSocket) {
      Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
    } else {
      delete globalThis.WebSocket;
    }
  }
});

test('async integrations cancel work and ignore results after their owner is destroyed', async () => {
  const [canvasSource, samSource, maskSource, canvasStateSource] = await Promise.all([
    readFile(new URL('../src/app/CanvasView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/mask/SAMDetectorIntegration.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/mask/MaskEditorIntegration.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/canvas/CanvasState.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(canvasSource, /new AbortController\(\)/);
  assert.match(canvasSource, /signal:\s*operationController\.signal/);
  assert.match(canvasSource, /mattingAbortController\?\.abort\(\)/);
  assert.match(canvasSource, /widgetDestroyed\s*=\s*true/);
  assert.match(canvasSource, /if \(widgetDestroyed \|\| operationController\.signal\.aborted\)/);
  assert.match(canvasSource, /cancelSAMDetectorMonitoring\(this\)/);

  assert.match(samSource, /export function cancelSAMDetectorMonitoring/);
  assert.match(samSource, /samMonitoringCancelled/);
  assert.match(samSource, /if \(\(node as any\)\.samMonitoringCancelled\)/);

  assert.match(maskSource, /maskEditorCancelled/);
  assert.match(maskSource, /setupCancelListener/);
  assert.match(canvasStateSource, /stateSaverWorker\.onerror/);
  assert.match(canvasStateSource, /this\.stateSaverWorker = null/);
});
