import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu db
const log = {
    debug: (...args) => logger.debug('db', ...args),
    info: (...args) => logger.info('db', ...args),
    warn: (...args) => logger.warn('db', ...args),
    error: (...args) => logger.error('db', ...args)
};

// Konfiguracja loggera dla modułu db
logger.setModuleLevel('db', LogLevel.INFO);

const DB_NAME = 'CanvasNodeDB';
const STATE_STORE_NAME = 'CanvasState';
const IMAGE_STORE_NAME = 'CanvasImages';
const DB_VERSION = 2; // Zwiększono wersję, aby wymusić aktualizację schematu

let db;

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        log.info("Opening IndexedDB...");
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            log.error("IndexedDB error:", event.target.error);
            reject("Error opening IndexedDB.");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            log.info("IndexedDB opened successfully.");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            log.info("Upgrading IndexedDB...");
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STATE_STORE_NAME)) {
                db.createObjectStore(STATE_STORE_NAME, {keyPath: 'id'});
                log.info("Object store created:", STATE_STORE_NAME);
            }
            if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
                db.createObjectStore(IMAGE_STORE_NAME, {keyPath: 'imageId'});
                log.info("Object store created:", IMAGE_STORE_NAME);
            }
        };
    });
}

export async function getCanvasState(id) {
    log.info(`Getting state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readonly');
        const store = transaction.objectStore(STATE_STORE_NAME);
        const request = store.get(id);

        request.onerror = (event) => {
            log.error("Error getting canvas state:", event.target.error);
            reject("Error getting state.");
        };

        request.onsuccess = (event) => {
            log.debug(`Get success for id: ${id}`, event.target.result ? 'found' : 'not found');
            resolve(event.target.result ? event.target.result.state : null);
        };
    });
}

export async function setCanvasState(id, state) {
    log.info(`Setting state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
        const request = store.put({id, state});

        request.onerror = (event) => {
            log.error("Error setting canvas state:", event.target.error);
            reject("Error setting state.");
        };

        request.onsuccess = () => {
            log.debug(`Set success for id: ${id}`);
            resolve();
        };
    });
}

export async function removeCanvasState(id) {
    log.info(`Removing state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
        const request = store.delete(id);

        request.onerror = (event) => {
            log.error("Error removing canvas state:", event.target.error);
            reject("Error removing state.");
        };

        request.onsuccess = () => {
            log.debug(`Remove success for id: ${id}`);
            resolve();
        };
    });
}

export async function saveImage(imageId, imageSrc) {
    log.info(`Saving image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.put({imageId, imageSrc});

        request.onerror = (event) => {
            log.error("Error saving image:", event.target.error);
            reject("Error saving image.");
        };

        request.onsuccess = () => {
            log.debug(`Image saved successfully for id: ${imageId}`);
            resolve();
        };
    });
}

export async function getImage(imageId) {
    log.info(`Getting image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readonly');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.get(imageId);

        request.onerror = (event) => {
            log.error("Error getting image:", event.target.error);
            reject("Error getting image.");
        };

        request.onsuccess = (event) => {
            log.debug(`Get image success for id: ${imageId}`, event.target.result ? 'found' : 'not found');
            resolve(event.target.result ? event.target.result.imageSrc : null);
        };
    });
}

export async function removeImage(imageId) {
    log.info(`Removing image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.delete(imageId);

        request.onerror = (event) => {
            log.error("Error removing image:", event.target.error);
            reject("Error removing image.");
        };

        request.onsuccess = () => {
            log.debug(`Remove image success for id: ${imageId}`);
            resolve();
        };
    });
}

export async function clearAllCanvasStates() {
    log.info("Clearing all canvas states...");
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
        const request = store.clear();

        request.onerror = (event) => {
            log.error("Error clearing canvas states:", event.target.error);
            reject("Error clearing states.");
        };

        request.onsuccess = () => {
            log.info("All canvas states cleared successfully.");
            resolve();
        };
    });
}