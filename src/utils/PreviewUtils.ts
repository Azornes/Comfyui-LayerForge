import { createModuleLogger } from "./LoggerUtils.js";
import { withErrorHandling, createValidationError } from "../ErrorHandler.js";
import type { ComfyNode } from '../types';

const log = createModuleLogger('PreviewUtils');

/**
 * Utility functions for creating and managing preview images
 */

export interface PreviewOptions {
    /** Whether to include mask in the preview (default: true) */
    includeMask?: boolean;
    /** Whether to update node.imgs array (default: true) */
    updateNodeImages?: boolean;
    /** Custom blob source instead of canvas */
    customBlob?: Blob;
}

/**
 * Creates a preview image from canvas and updates node
 * @param canvas - Canvas object with canvasLayers
 * @param node - ComfyUI node to update
 * @param options - Preview options
 * @returns Promise with created Image element
 */
export const createPreviewFromCanvas = withErrorHandling(async function(
    canvas: any, 
    node: ComfyNode, 
    options: PreviewOptions = {}
): Promise<HTMLImageElement> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }
    if (!node) {
        throw createValidationError("Node is required", { node });
    }

    const {
        includeMask = true,
        updateNodeImages = true,
        customBlob
    } = options;

    log.debug('Creating preview from canvas:', {
        includeMask,
        updateNodeImages,
        hasCustomBlob: !!customBlob,
        nodeId: node.id
    });

    let blob: Blob | null = customBlob || null;

    // Get blob from canvas if not provided
    if (!blob) {
        if (!canvas.canvasLayers) {
            throw createValidationError("Canvas does not have canvasLayers", { canvas });
        }

        if (includeMask && typeof canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob === 'function') {
            blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        } else if (typeof canvas.canvasLayers.getFlattenedCanvasAsBlob === 'function') {
            blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
        } else {
            throw createValidationError("Canvas does not support required blob generation methods", { 
                canvas,
                availableMethods: Object.getOwnPropertyNames(canvas.canvasLayers)
            });
        }
    }

    if (!blob) {
        throw createValidationError("Failed to generate canvas blob for preview", { canvas, options });
    }

    // Create preview image
    const previewImage = new Image();
    previewImage.src = URL.createObjectURL(blob);

    // Wait for image to load
    await new Promise<void>((resolve, reject) => {
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
            reject(createValidationError("Failed to load preview image", { error, blob: blob?.size }));
        };
    });

    // Update node images if requested
    if (updateNodeImages) {
        node.imgs = [previewImage];
        log.debug("Node images updated with new preview");
    }

    return previewImage;
}, 'createPreviewFromCanvas');

/**
 * Creates a preview image from a blob
 * @param blob - Image blob
 * @param node - ComfyUI node to update (optional)
 * @param updateNodeImages - Whether to update node.imgs (default: false)
 * @returns Promise with created Image element
 */
export const createPreviewFromBlob = withErrorHandling(async function(
    blob: Blob, 
    node?: ComfyNode, 
    updateNodeImages: boolean = false
): Promise<HTMLImageElement> {
    if (!blob) {
        throw createValidationError("Blob is required", { blob });
    }
    if (blob.size === 0) {
        throw createValidationError("Blob cannot be empty", { blobSize: blob.size });
    }

    log.debug('Creating preview from blob:', {
        blobSize: blob.size,
        updateNodeImages,
        hasNode: !!node
    });

    const previewImage = new Image();
    previewImage.src = URL.createObjectURL(blob);

    await new Promise<void>((resolve, reject) => {
        previewImage.onload = () => {
            log.debug("Preview image from blob loaded successfully", {
                width: previewImage.width,
                height: previewImage.height
            });
            resolve();
        };
        previewImage.onerror = (error) => {
            log.error("Failed to load preview image from blob", error);
            reject(createValidationError("Failed to load preview image from blob", { error, blobSize: blob.size }));
        };
    });

    if (updateNodeImages && node) {
        node.imgs = [previewImage];
        log.debug("Node images updated with blob preview");
    }

    return previewImage;
}, 'createPreviewFromBlob');

/**
 * Updates node preview after canvas changes
 * @param canvas - Canvas object
 * @param node - ComfyUI node
 * @param includeMask - Whether to include mask in preview
 * @returns Promise with updated preview image
 */
export const updateNodePreview = withErrorHandling(async function(
    canvas: any, 
    node: ComfyNode, 
    includeMask: boolean = true
): Promise<HTMLImageElement> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }
    if (!node) {
        throw createValidationError("Node is required", { node });
    }

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
}, 'updateNodePreview');

/**
 * Clears node preview images
 * @param node - ComfyUI node
 */
export function clearNodePreview(node: ComfyNode): void {
    log.debug('Clearing node preview:', { nodeId: node.id });
    node.imgs = [];
}

/**
 * Checks if node has preview images
 * @param node - ComfyUI node
 * @returns True if node has preview images
 */
export function hasNodePreview(node: ComfyNode): boolean {
    return !!(node.imgs && node.imgs.length > 0 && node.imgs[0].src);
}

/**
 * Gets the current preview image from node
 * @param node - ComfyUI node
 * @returns Current preview image or null
 */
export function getCurrentPreview(node: ComfyNode): HTMLImageElement | null {
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
export const createCustomPreview = withErrorHandling(async function(
    canvas: any,
    node: ComfyNode,
    processor: (canvas: any) => Promise<Blob>
): Promise<HTMLImageElement> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }
    if (!node) {
        throw createValidationError("Node is required", { node });
    }
    if (!processor || typeof processor !== 'function') {
        throw createValidationError("Processor function is required", { processor });
    }

    log.debug('Creating custom preview:', { nodeId: node.id });

    const blob = await processor(canvas);
    return createPreviewFromBlob(blob, node, true);
}, 'createCustomPreview');
