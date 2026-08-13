import { STATE_STORE, executeDBStoreRequest } from './db_shared.js';
console.log('[StateWorker] Worker script loaded and running.');
function log(...args) {
    console.log('[StateWorker]', ...args);
}
function error(...args) {
    console.error('[StateWorker]', ...args);
}
const dbLogger = { info: log, error };
async function setCanvasState(id, state) {
    await executeDBStoreRequest(dbLogger, [STATE_STORE], STATE_STORE, 'readwrite', 'put', { id, state }, "Error setting canvas state", {
        openingMessage: null,
        upgradingMessage: 'Upgrading IndexedDB in worker...',
        successMessage: 'IndexedDB opened successfully in worker.',
        logStoreCreation: false,
    });
}
self.onmessage = async function (e) {
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
    }
    catch (err) {
        error(`Failed to save state for node: ${nodeId}`, err);
    }
};
