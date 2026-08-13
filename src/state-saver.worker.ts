import {STATE_STORE, createDBRequest, openLayerForgeDB} from './db_shared.js';

console.log('[StateWorker] Worker script loaded and running.');

function log(...args: any[]): void {
    console.log('[StateWorker]', ...args);
}

function error(...args: any[]): void {
    console.error('[StateWorker]', ...args);
}

const dbLogger = {info: log, error};

async function setCanvasState(id: string, state: any): Promise<void> {
    const db = await openLayerForgeDB(dbLogger, [STATE_STORE], {
        openingMessage: null,
        upgradingMessage: 'Upgrading IndexedDB in worker...',
        successMessage: 'IndexedDB opened successfully in worker.',
        logStoreCreation: false,
    });
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);
    await createDBRequest(store, 'put', {id, state}, "Error setting canvas state", dbLogger);
}

self.onmessage = async function(e: MessageEvent<{ state: any, nodeId: string }>): Promise<void> {
    log('Message received from main thread:', e.data ? 'data received' : 'no data');
    const { state, nodeId } = e.data;

    if (!state || !nodeId) {
        error('Invalid data received from main thread');
        return;
    }

    try {
        log(`Saving state for node: ${nodeId}`);
        await setCanvasState(nodeId, state);
        log(`State saved successfully for node: ${nodeId}`);
    } catch (err) {
        error(`Failed to save state for node: ${nodeId}`, err);
    }
};
