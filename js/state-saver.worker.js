console.log('[StateWorker] Worker script loaded and running.');

const DB_NAME = 'CanvasNodeDB';
const STATE_STORE_NAME = 'CanvasState';
const DB_VERSION = 3;

let db;

function log(...args) {
    console.log('[StateWorker]', ...args);
}

function error(...args) {
    console.error('[StateWorker]', ...args);
}

function createDBRequest(store, operation, data, errorMessage) {
    return new Promise((resolve, reject) => {
        let request;
        switch (operation) {
            case 'put':
                request = store.put(data);
                break;
            default:
                reject(new Error(`Unknown operation: ${operation}`));
                return;
        }

        request.onerror = (event) => {
            error(errorMessage, event.target.error);
            reject(errorMessage);
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
    });
}

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            error("IndexedDB error:", event.target.error);
            reject("Error opening IndexedDB.");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            log("IndexedDB opened successfully in worker.");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            log("Upgrading IndexedDB in worker...");
            const tempDb = event.target.result;
            if (!tempDb.objectStoreNames.contains(STATE_STORE_NAME)) {
                tempDb.createObjectStore(STATE_STORE_NAME, {keyPath: 'id'});
            }
        };
    });
}

async function setCanvasState(id, state) {
    const db = await openDB();
    const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STATE_STORE_NAME);
    await createDBRequest(store, 'put', {id, state}, "Error setting canvas state");
}

self.onmessage = async function(e) {
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
