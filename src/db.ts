import {createModuleLogger} from "./log_system/log_funcs.js";
import {
    ALL_STORES,
    IMAGE_STORE,
    STATE_STORE,
    executeDBStoreRequest,
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
    const result = await executeDBStoreRequest<CanvasStateDB | undefined>(
        log,
        ALL_STORES,
        STATE_STORE,
        'readonly',
        'get',
        id,
        "Error getting canvas state"
    );
    log.debug(`Get success for id: ${id}`, result ? 'found' : 'not found');
    return result ? result.state : null;
}

export async function setCanvasState(id: string, state: any): Promise<void> {
    log.info(`Setting state for id: ${id}`);
    await executeDBStoreRequest<void>(
        log,
        ALL_STORES,
        STATE_STORE,
        'readwrite',
        'put',
        {id, state},
        "Error setting canvas state"
    );
    log.debug(`Set success for id: ${id}`);
}

export async function removeCanvasState(id: string): Promise<void> {
    log.info(`Removing state for id: ${id}`);
    await executeDBStoreRequest<void>(
        log,
        ALL_STORES,
        STATE_STORE,
        'readwrite',
        'delete',
        id,
        "Error removing canvas state"
    );
    log.debug(`Remove success for id: ${id}`);
}

export async function saveImage(imageId: string, imageSrc: string | ImageBitmap): Promise<void> {
    log.info(`Saving image with id: ${imageId}`);
    await executeDBStoreRequest<void>(
        log,
        ALL_STORES,
        IMAGE_STORE,
        'readwrite',
        'put',
        {imageId, imageSrc},
        "Error saving image"
    );
    log.debug(`Image saved successfully for id: ${imageId}`);
}

export async function getImage(imageId: string): Promise<string | ImageBitmap | null> {
    log.info(`Getting image with id: ${imageId}`);
    const result = await executeDBStoreRequest<CanvasImageDB | undefined>(
        log,
        ALL_STORES,
        IMAGE_STORE,
        'readonly',
        'get',
        imageId,
        "Error getting image"
    );
    log.debug(`Get image success for id: ${imageId}`, result ? 'found' : 'not found');
    return result ? result.imageSrc : null;
}

export async function removeImage(imageId: string): Promise<void> {
    log.info(`Removing image with id: ${imageId}`);
    await executeDBStoreRequest<void>(
        log,
        ALL_STORES,
        IMAGE_STORE,
        'readwrite',
        'delete',
        imageId,
        "Error removing image"
    );
    log.debug(`Remove image success for id: ${imageId}`);
}

export async function getAllImageIds(): Promise<string[]> {
    log.info("Getting all image IDs...");
    const imageIds = await executeDBStoreRequest<string[]>(
        log,
        ALL_STORES,
        IMAGE_STORE,
        'readonly',
        'getAllKeys',
        null,
        "Error getting all image IDs"
    );
    log.debug(`Found ${imageIds.length} image IDs in database`);
    return imageIds;
}

export async function clearAllCanvasStates(): Promise<void> {
    log.info("Clearing all canvas states...");
    await executeDBStoreRequest<void>(
        log,
        ALL_STORES,
        STATE_STORE,
        'readwrite',
        'clear',
        null,
        "Error clearing canvas states"
    );
    log.info("All canvas states cleared successfully.");
}
