import { createModuleLogger } from "./LoggerUtils.js";
const log = createModuleLogger('PreviewUtils');
/**
 * Creates a preview image from canvas and updates node
 * @param canvas - Canvas object with canvasLayers
 * @param node - ComfyUI node to update
 * @param options - Preview options
 * @returns Promise with created Image element
 */
export async function createPreviewFromCanvas(canvas, node, options = {}) {
    const { includeMask = true, updateNodeImages = true, customBlob } = options;
    log.debug('Creating preview from canvas:', {
        includeMask,
        updateNodeImages,
        hasCustomBlob: !!customBlob,
        nodeId: node.id
    });
    let blob = customBlob || null;
    // Get blob from canvas if not provided
    if (!blob) {
        if (!canvas.canvasLayers) {
            throw new Error("Canvas does not have canvasLayers");
        }
        if (includeMask && typeof canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob === 'function') {
            blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        }
        else if (typeof canvas.canvasLayers.getFlattenedCanvasAsBlob === 'function') {
            blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
        }
        else {
            throw new Error("Canvas does not support required blob generation methods");
        }
    }
    if (!blob) {
        throw new Error("Failed to generate canvas blob for preview");
    }
    // Create preview image
    const previewImage = new Image();
    previewImage.src = URL.createObjectURL(blob);
    // Wait for image to load
    await new Promise((resolve, reject) => {
        previewImage.onload = () => {
            log.debug("Preview image loaded successfully", {
                width: previewImage.width,
                height: previewImage.height,
                nodeId: node.id
            });
            resolve();
        };
        previewImage.onerror = (error) => {
            log.error("Failed to load preview image", error);
            reject(new Error("Failed to load preview image"));
        };
    });
    // Update node images if requested
    if (updateNodeImages) {
        node.imgs = [previewImage];
        log.debug("Node images updated with new preview");
    }
    return previewImage;
}
/**
 * Creates a preview image from a blob
 * @param blob - Image blob
 * @param node - ComfyUI node to update (optional)
 * @param updateNodeImages - Whether to update node.imgs (default: false)
 * @returns Promise with created Image element
 */
export async function createPreviewFromBlob(blob, node, updateNodeImages = false) {
    log.debug('Creating preview from blob:', {
        blobSize: blob.size,
        updateNodeImages,
        hasNode: !!node
    });
    const previewImage = new Image();
    previewImage.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
        previewImage.onload = () => {
            log.debug("Preview image from blob loaded successfully", {
                width: previewImage.width,
                height: previewImage.height
            });
            resolve();
        };
        previewImage.onerror = (error) => {
            log.error("Failed to load preview image from blob", error);
            reject(new Error("Failed to load preview image from blob"));
        };
    });
    if (updateNodeImages && node) {
        node.imgs = [previewImage];
        log.debug("Node images updated with blob preview");
    }
    return previewImage;
}
/**
 * Updates node preview after canvas changes
 * @param canvas - Canvas object
 * @param node - ComfyUI node
 * @param includeMask - Whether to include mask in preview
 * @returns Promise with updated preview image
 */
export async function updateNodePreview(canvas, node, includeMask = true) {
    log.info('Updating node preview:', {
        nodeId: node.id,
        includeMask
    });
    // Trigger canvas render and save state
    if (typeof canvas.render === 'function') {
        canvas.render();
    }
    if (typeof canvas.saveState === 'function') {
        canvas.saveState();
    }
    // Create new preview
    const previewImage = await createPreviewFromCanvas(canvas, node, {
        includeMask,
        updateNodeImages: true
    });
    log.info('Node preview updated successfully');
    return previewImage;
}
/**
 * Clears node preview images
 * @param node - ComfyUI node
 */
export function clearNodePreview(node) {
    log.debug('Clearing node preview:', { nodeId: node.id });
    node.imgs = [];
}
/**
 * Checks if node has preview images
 * @param node - ComfyUI node
 * @returns True if node has preview images
 */
export function hasNodePreview(node) {
    return !!(node.imgs && node.imgs.length > 0 && node.imgs[0].src);
}
/**
 * Gets the current preview image from node
 * @param node - ComfyUI node
 * @returns Current preview image or null
 */
export function getCurrentPreview(node) {
    if (hasNodePreview(node) && node.imgs) {
        return node.imgs[0];
    }
    return null;
}
/**
 * Creates a preview with custom processing
 * @param canvas - Canvas object
 * @param node - ComfyUI node
 * @param processor - Custom processing function that takes canvas and returns blob
 * @returns Promise with processed preview image
 */
export async function createCustomPreview(canvas, node, processor) {
    log.debug('Creating custom preview:', { nodeId: node.id });
    const blob = await processor(canvas);
    return createPreviewFromBlob(blob, node, true);
}
