console.log('[StateWorker] Worker script loaded and running.');

const DB_NAME = 'CanvasNodeDB';
const STATE_STORE_NAME = 'CanvasState';
const DB_VERSION = 3;

let db: IDBDatabase | null;

function log(...args: any[]): void {
    console.log('[StateWorker]', ...args);
}

function error(...args: any[]): void {
    console.error('[StateWorker]', ...args);
}

function createDBRequest(store: IDBObjectStore, operation: 'put', data: any, errorMessage: string): Promise<any> {
    return new Promise((resolve, reject) => {
        let request: IDBRequest;
        switch (operation) {
            case 'put':
                request = store.put(data);
                break;
            default:
                reject(new Error(`Unknown operation: ${operation}`));
                return;
        }

        request.onerror = (event) => {
            error(errorMessage, (event.target as IDBRequest).error);
            reject(errorMessage);
        };

        request.onsuccess = (event) => {
            resolve((event.target as IDBRequest).result);
        };
    });
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            error("IndexedDB error:", (event.target as IDBOpenDBRequest).error);
            reject("Error opening IndexedDB.");
        };

        request.onsuccess = (event) => {
            db = (event.target as IDBOpenDBRequest).result;
            log("IndexedDB opened successfully in worker.");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            log("Upgrading IndexedDB in worker...");
            const tempDb = (event.target as IDBOpenDBRequest).result;
            if (!tempDb.objectStoreNames.contains(STATE_STORE_NAME)) {
                tempDb.createObjectStore(STATE_STORE_NAME, {keyPath: 'id'});
            }
        };
    });
}

async function setCanvasState(id: string, state: any): Promise<void> {
    const db = await openDB();
    const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STATE_STORE_NAME);
    await createDBRequest(store, 'put', {id, state}, "Error setting canvas state");
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
