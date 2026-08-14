export interface DBLogger {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

export interface DBStoreDefinition {
    readonly name: string;
    readonly keyPath: string;
}

export interface DBOpenOptions {
    openingMessage?: string | null;
    upgradingMessage?: string;
    successMessage?: string;
    logStoreCreation?: boolean;
}

export type DBRequestOperation = 'get' | 'put' | 'delete' | 'clear' | 'getAllKeys';

export const DB_NAME = 'CanvasNodeDB';
export const DB_VERSION = 3;
export const STATE_STORE_NAME = 'CanvasState';
export const IMAGE_STORE_NAME = 'CanvasImages';

export const STATE_STORE: DBStoreDefinition = {
    name: STATE_STORE_NAME,
    keyPath: 'id',
};

export const IMAGE_STORE: DBStoreDefinition = {
    name: IMAGE_STORE_NAME,
    keyPath: 'imageId',
};

export const ALL_STORES: readonly DBStoreDefinition[] = [STATE_STORE, IMAGE_STORE];

let db: IDBDatabase | null = null;

/** Create an IndexedDB request with shared operation and error handling. */
export function createDBRequest(
    store: IDBObjectStore,
    operation: DBRequestOperation,
    data: any,
    errorMessage: string,
    log: DBLogger,
): Promise<any> {
    return new Promise((resolve, reject) => {
        let request: IDBRequest;
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
            const error = (event.target as IDBRequest).error ?? new Error(errorMessage);
            log.error(errorMessage, error);
            reject(error);
        };

        request.onsuccess = (event) => {
            resolve((event.target as IDBRequest).result);
        };
    });
}

/** Open the shared database, execute one store operation, and preserve request error handling. */
export async function executeDBStoreRequest<T>(
    log: DBLogger,
    stores: readonly DBStoreDefinition[],
    storeDefinition: DBStoreDefinition,
    mode: IDBTransactionMode,
    operation: DBRequestOperation,
    data: any,
    errorMessage: string,
    openOptions: DBOpenOptions = {},
): Promise<T> {
    const database = await openLayerForgeDB(log, stores, openOptions);
    const transaction = database.transaction([storeDefinition.name], mode);
    const store = transaction.objectStore(storeDefinition.name);

    return createDBRequest(store, operation, data, errorMessage, log) as Promise<T>;
}

/** Open the shared LayerForge database and create only the stores needed by the caller. */
export function openLayerForgeDB(
    log: DBLogger,
    stores: readonly DBStoreDefinition[],
    options: DBOpenOptions = {},
): Promise<IDBDatabase> {
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
            const error = (event.target as IDBOpenDBRequest).error ?? new Error('Error opening IndexedDB.');
            log.error('IndexedDB error:', error);
            reject(error);
        };

        request.onsuccess = (event) => {
            db = (event.target as IDBOpenDBRequest).result;
            log.info(successMessage);
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            log.info(upgradingMessage);
            const dbInstance = (event.target as IDBOpenDBRequest).result;
            for (const store of stores) {
                if (!dbInstance.objectStoreNames.contains(store.name)) {
                    dbInstance.createObjectStore(store.name, {keyPath: store.keyPath});
                    if (logStoreCreation) {
                        log.info('Object store created:', store.name);
                    }
                }
            }
        };
    });
}
