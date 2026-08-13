import { createModuleLogger } from "./log_system/log_funcs.js";
import { ALL_STORES, IMAGE_STORE, STATE_STORE, createDBRequest, openLayerForgeDB, } from "./db_shared.js";
const log = createModuleLogger('db');
export async function getCanvasState(id) {
    log.info(`Getting state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readonly');
    const store = transaction.objectStore(STATE_STORE.name);
    const result = await createDBRequest(store, 'get', id, "Error getting canvas state", log);
    log.debug(`Get success for id: ${id}`, result ? 'found' : 'not found');
    return result ? result.state : null;
}
export async function setCanvasState(id, state) {
    log.info(`Setting state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);
    await createDBRequest(store, 'put', { id, state }, "Error setting canvas state", log);
    log.debug(`Set success for id: ${id}`);
}
export async function removeCanvasState(id) {
    log.info(`Removing state for id: ${id}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);
    await createDBRequest(store, 'delete', id, "Error removing canvas state", log);
    log.debug(`Remove success for id: ${id}`);
}
export async function saveImage(imageId, imageSrc) {
    log.info(`Saving image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readwrite');
    const store = transaction.objectStore(IMAGE_STORE.name);
    await createDBRequest(store, 'put', { imageId, imageSrc }, "Error saving image", log);
    log.debug(`Image saved successfully for id: ${imageId}`);
}
export async function getImage(imageId) {
    log.info(`Getting image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readonly');
    const store = transaction.objectStore(IMAGE_STORE.name);
    const result = await createDBRequest(store, 'get', imageId, "Error getting image", log);
    log.debug(`Get image success for id: ${imageId}`, result ? 'found' : 'not found');
    return result ? result.imageSrc : null;
}
export async function removeImage(imageId) {
    log.info(`Removing image with id: ${imageId}`);
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readwrite');
    const store = transaction.objectStore(IMAGE_STORE.name);
    await createDBRequest(store, 'delete', imageId, "Error removing image", log);
    log.debug(`Remove image success for id: ${imageId}`);
}
export async function getAllImageIds() {
    log.info("Getting all image IDs...");
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([IMAGE_STORE.name], 'readonly');
    const store = transaction.objectStore(IMAGE_STORE.name);
    const imageIds = await createDBRequest(store, 'getAllKeys', null, "Error getting all image IDs", log);
    log.debug(`Found ${imageIds.length} image IDs in database`);
    return imageIds;
}
export async function clearAllCanvasStates() {
    log.info("Clearing all canvas states...");
    const db = await openLayerForgeDB(log, ALL_STORES);
    const transaction = db.transaction([STATE_STORE.name], 'readwrite');
    const store = transaction.objectStore(STATE_STORE.name);
    await createDBRequest(store, 'clear', null, "Error clearing canvas states", log);
    log.info("All canvas states cleared successfully.");
}
