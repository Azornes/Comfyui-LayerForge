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
            if (!db.objectStoreNames.contains(STATE_STORE_NAME)) {
                db.createObjectStore(STATE_STORE_NAME, {keyPath: 'id'});
                console.log("Object store created:", STATE_STORE_NAME);
            }
            if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
                db.createObjectStore(IMAGE_STORE_NAME, {keyPath: 'imageId'});
                console.log("Object store created:", IMAGE_STORE_NAME);
            }
        };
    });
}

export async function getCanvasState(id) {
    console.log(`DB: Getting state for id: ${id}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readonly');
        const store = transaction.objectStore(STATE_STORE_NAME);
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
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
        const request = store.put({id, state});

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
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
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

export async function saveImage(imageId, imageSrc) {
    console.log(`DB: Saving image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.put({imageId, imageSrc});

        request.onerror = (event) => {
            console.error("DB: Error saving image:", event.target.error);
            reject("Error saving image.");
        };

        request.onsuccess = () => {
            console.log(`DB: Image saved successfully for id: ${imageId}`);
            resolve();
        };
    });
}

export async function getImage(imageId) {
    console.log(`DB: Getting image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readonly');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.get(imageId);

        request.onerror = (event) => {
            console.error("DB: Error getting image:", event.target.error);
            reject("Error getting image.");
        };

        request.onsuccess = (event) => {
            console.log(`DB: Get image success for id: ${imageId}`, event.target.result ? 'found' : 'not found');
            resolve(event.target.result ? event.target.result.imageSrc : null);
        };
    });
}

export async function removeImage(imageId) {
    console.log(`DB: Removing image with id: ${imageId}`);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        const request = store.delete(imageId);

        request.onerror = (event) => {
            console.error("DB: Error removing image:", event.target.error);
            reject("Error removing image.");
        };

        request.onsuccess = () => {
            console.log(`DB: Remove image success for id: ${imageId}`);
            resolve();
        };
    });
}

export async function clearAllCanvasStates() {
    console.log("DB: Clearing all canvas states...");
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STATE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STATE_STORE_NAME);
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