import {createModuleLogger} from "./log_system/log_funcs.js";
import {
    ALL_STORES,
    IMAGE_STORE,
    STATE_STORE,
    createDBRequest,
    openLayerForgeDB,
} from "./db_shared.js";

const log = createModuleLogger('db');

interface CanvasStateDB {
    id: string;
    state: any;
}

interface CanvasImageDB {
    imageId: string;
    imageSrc: string;
}

export async function getCanvasState(id: string): Promise<any | null> {
    log.info(`Getting state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readonly');
    const store = transaction.objectStore(STATE_STORE.name);

    const result = await createDBRequest(store, 'get', id, "Error getting canvas state", log) as CanvasStateDB;
    log.debug(`Get success for id: ${id}`, result ? 'found' : 'not found');
    return result ? result.state : null;
}

export async function setCanvasState(id: string, state: any): Promise<void> {
    log.info(`Setting state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);

    await createDBRequest(store, 'put', {id, state}, "Error setting canvas state", log);
    log.debug(`Set success for id: ${id}`);
}

export async function removeCanvasState(id: string): Promise<void> {
    log.info(`Removing state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);

    await createDBRequest(store, 'delete', id, "Error removing canvas state", log);
    log.debug(`Remove success for id: ${id}`);
}

export async function saveImage(imageId: string, imageSrc: string | ImageBitmap): Promise<void> {
    log.info(`Saving image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readwrite');
    const store = transaction.objectStore(IMAGE_STORE.name);

    await createDBRequest(store, 'put', {imageId, imageSrc}, "Error saving image", log);
    log.debug(`Image saved successfully for id: ${imageId}`);
}

export async function getImage(imageId: string): Promise<string | ImageBitmap | null> {
    log.info(`Getting image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readonly');
    const store = transaction.objectStore(IMAGE_STORE.name);

    const result = await createDBRequest(store, 'get', imageId, "Error getting image", log) as CanvasImageDB;
    log.debug(`Get image success for id: ${imageId}`, result ? 'found' : 'not found');
    return result ? result.imageSrc : null;
}

export async function removeImage(imageId: string): Promise<void> {
    log.info(`Removing image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readwrite');
    const store = transaction.objectStore(IMAGE_STORE.name);

    await createDBRequest(store, 'delete', imageId, "Error removing image", log);
    log.debug(`Remove image success for id: ${imageId}`);
}

export async function getAllImageIds(): Promise<string[]> {
    log.info("Getting all image IDs...");
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readonly');
    const store = transaction.objectStore(IMAGE_STORE.name);

    const imageIds = await createDBRequest(store, 'getAllKeys', null, "Error getting all image IDs", log) as string[];
    log.debug(`Found ${imageIds.length} image IDs in database`);
    return imageIds;
}

export async function clearAllCanvasStates(): Promise<void> {
    log.info("Clearing all canvas states...");
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);

    await createDBRequest(store, 'clear', null, "Error clearing canvas states", log);
    log.info("All canvas states cleared successfully.");
}
