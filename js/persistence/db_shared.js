export const DB_NAME = 'CanvasNodeDB';
export const DB_VERSION = 3;
export const STATE_STORE_NAME = 'CanvasState';
export const IMAGE_STORE_NAME = 'CanvasImages';
export const STATE_STORE = {
    name: STATE_STORE_NAME,
    keyPath: 'id',
};
export const IMAGE_STORE = {
    name: IMAGE_STORE_NAME,
    keyPath: 'imageId',
};
export const ALL_STORES = [STATE_STORE, IMAGE_STORE];
let db = null;
/** Create an IndexedDB request with shared operation and error handling. */
export function createDBRequest(store, operation, data, errorMessage, log) {
    return new Promise((resolve, reject) => {
        let request;
        switch (operation) {
            case 'get':
                request = store.get(data);
                break;
            case 'put':
                request = store.put(data);
                break;
            case 'delete':
                request = store.delete(data);
                break;
            case 'clear':
                request = store.clear();
                break;
            case 'getAllKeys':
                request = store.getAllKeys();
                break;
            default:
                reject(new Error(`Unknown operation: ${operation}`));
                return;
        }
        request.onerror = (event) => {
            log.error(errorMessage, event.target.error);
            reject(errorMessage);
        };
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
    });
}
/** Open the shared database, execute one store operation, and preserve request error handling. */
export async function executeDBStoreRequest(log, stores, storeDefinition, mode, operation, data, errorMessage, openOptions = {}) {
    const database = await openLayerForgeDB(log, stores, openOptions);
    const transaction = database.transaction([storeDefinition.name], mode);
    const store = transaction.objectStore(storeDefinition.name);
    return createDBRequest(store, operation, data, errorMessage, log);
}
/** Open the shared LayerForge database and create only the stores needed by the caller. */
export function openLayerForgeDB(log, stores, options = {}) {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        const openingMessage = options.openingMessage === undefined
            ? 'Opening IndexedDB...'
            : options.openingMessage;
        const upgradingMessage = options.upgradingMessage ?? 'Upgrading IndexedDB...';
        const successMessage = options.successMessage ?? 'IndexedDB opened successfully.';
        const logStoreCreation = options.logStoreCreation ?? true;
        if (openingMessage) {
            log.info(openingMessage);
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => {
            log.error('IndexedDB error:', event.target.error);
            reject('Error opening IndexedDB.');
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            log.info(successMessage);
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            log.info(upgradingMessage);
            const dbInstance = event.target.result;
            for (const store of stores) {
                if (!dbInstance.objectStoreNames.contains(store.name)) {
                    dbInstance.createObjectStore(store.name, { keyPath: store.keyPath });
                    if (logStoreCreation) {
                        log.info('Object store created:', store.name);
                    }
                }
            }
        };
    });
}
