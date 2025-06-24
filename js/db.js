const DB_NAME = 'CanvasNodeDB';
const STORE_NAME = 'CanvasState';
const DB_VERSION = 1;

let db;

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        console.log("Opening IndexedDB...");
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.error);
            reject("Error opening IndexedDB.");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("IndexedDB opened successfully.");
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log("Upgrading IndexedDB...");
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                console.log("Object store created:", STORE_NAME);
            }
        };
    });
}

export async function getCanvasState(id) {
    console.log(`DB: Getting state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onerror = (event) => {
            console.error("DB: Error getting canvas state:", event.target.error);
            reject("Error getting state.");
        };

        request.onsuccess = (event) => {
            console.log(`DB: Get success for id: ${id}`, event.target.result ? 'found' : 'not found');
            resolve(event.target.result ? event.target.result.state : null);
        };
    });
}

export async function setCanvasState(id, state) {
    console.log(`DB: Setting state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put({ id, state });

        request.onerror = (event) => {
            console.error("DB: Error setting canvas state:", event.target.error);
            reject("Error setting state.");
        };

        request.onsuccess = () => {
            console.log(`DB: Set success for id: ${id}`);
            resolve();
        };
    });
}

export async function removeCanvasState(id) {
    console.log(`DB: Removing state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onerror = (event) => {
            console.error("DB: Error removing canvas state:", event.target.error);
            reject("Error removing state.");
        };

        request.onsuccess = () => {
            console.log(`DB: Remove success for id: ${id}`);
            resolve();
        };
    });
}

export async function clearAllCanvasStates() {
    console.log("DB: Clearing all canvas states...");
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onerror = (event) => {
            console.error("DB: Error clearing canvas states:", event.target.error);
            reject("Error clearing states.");
        };

        request.onsuccess = () => {
            console.log("DB: All canvas states cleared successfully.");
            resolve();
        };
    });
}