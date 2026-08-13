import {STATE_STORE, executeDBStoreRequest} from './db_shared.js';

console.log('[StateWorker] Worker script loaded and running.');

function log(...args: any[]): void {
    console.log('[StateWorker]', ...args);
}

function error(...args: any[]): void {
    console.error('[StateWorker]', ...args);
}

const dbLogger = {info: log, error};

async function setCanvasState(id: string, state: any): Promise<void> {
    await executeDBStoreRequest<void>(
        dbLogger,
        [STATE_STORE],
        STATE_STORE,
        'readwrite',
        'put',
        {id, state},
        "Error setting canvas state",
        {
            openingMessage: null,
            upgradingMessage: 'Upgrading IndexedDB in worker...',
            successMessage: 'IndexedDB opened successfully in worker.',
            logStoreCreation: false,
        }
    );
}

self.onmessage = async function(e: MessageEvent<{ state: any, stateKey: string }>): Promise<void> {
    log('Message received from main thread:', e.data ? 'data received' : 'no data');
    const { state, stateKey } = e.data;

    if (!state || !stateKey) {
        error('Invalid data received from main thread');
        return;
    }

    try {
        log(`Saving state for key: ${stateKey}`);
        await setCanvasState(stateKey, state);
        log(`State saved successfully for key: ${stateKey}`);
    } catch (err) {
        error(`Failed to save state for key: ${stateKey}`, err);
    }
};
