import { createModuleLogger } from "./log_system/log_funcs.js";
import { ALL_STORES, IMAGE_STORE, STATE_STORE, executeDBStoreRequest, } from "./db_shared.js";
const log = createModuleLogger('db');
export async function getCanvasState(id) {
    log.info(`Getting state for id: ${id}`);
    const result = await executeDBStoreRequest(log, ALL_STORES, STATE_STORE, 'readonly', 'get', id, "Error getting canvas state");
    log.debug(`Get success for id: ${id}`, result ? 'found' : 'not found');
    return result ? result.state : null;
}
export async function setCanvasState(id, state) {
    log.info(`Setting state for id: ${id}`);
    await executeDBStoreRequest(log, ALL_STORES, STATE_STORE, 'readwrite', 'put', { id, state }, "Error setting canvas state");
    log.debug(`Set success for id: ${id}`);
}
export async function removeCanvasState(id) {
    log.info(`Removing state for id: ${id}`);
    await executeDBStoreRequest(log, ALL_STORES, STATE_STORE, 'readwrite', 'delete', id, "Error removing canvas state");
    log.debug(`Remove success for id: ${id}`);
}
export async function saveImage(imageId, imageSrc) {
    log.info(`Saving image with id: ${imageId}`);
    await executeDBStoreRequest(log, ALL_STORES, IMAGE_STORE, 'readwrite', 'put', { imageId, imageSrc }, "Error saving image");
    log.debug(`Image saved successfully for id: ${imageId}`);
}
export async function getImage(imageId) {
    log.info(`Getting image with id: ${imageId}`);
    const result = await executeDBStoreRequest(log, ALL_STORES, IMAGE_STORE, 'readonly', 'get', imageId, "Error getting image");
    log.debug(`Get image success for id: ${imageId}`, result ? 'found' : 'not found');
    return result ? result.imageSrc : null;
}
export async function removeImage(imageId) {
    log.info(`Removing image with id: ${imageId}`);
    await executeDBStoreRequest(log, ALL_STORES, IMAGE_STORE, 'readwrite', 'delete', imageId, "Error removing image");
    log.debug(`Remove image success for id: ${imageId}`);
}
export async function getAllImageIds() {
    log.info("Getting all image IDs...");
    const imageIds = await executeDBStoreRequest(log, ALL_STORES, IMAGE_STORE, 'readonly', 'getAllKeys', null, "Error getting all image IDs");
    log.debug(`Found ${imageIds.length} image IDs in database`);
    return imageIds;
}
export async function clearAllCanvasStates() {
    log.info("Clearing all canvas states...");
    await executeDBStoreRequest(log, ALL_STORES, STATE_STORE, 'readwrite', 'clear', null, "Error clearing canvas states");
    log.info("All canvas states cleared successfully.");
}
