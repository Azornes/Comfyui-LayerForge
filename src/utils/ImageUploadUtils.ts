import { api } from "../../../scripts/api.js";
import { createModuleLogger } from "./LoggerUtils.js";
import { withErrorHandling, createValidationError, createNetworkError } from "../ErrorHandler.js";

const log = createModuleLogger('ImageUploadUtils');

/**
 * Utility functions for uploading images to ComfyUI server
 */

export interface UploadImageOptions {
    /** Custom filename prefix (default: 'layerforge') */
    filenamePrefix?: string;
    /** Whether to overwrite existing files (default: true) */
    overwrite?: boolean;
    /** Upload type (default: 'temp') */
    type?: string;
    /** Node ID for unique filename generation */
    nodeId?: string | number;
}

export interface UploadImageResult {
    /** Server response data */
    data: any;
    /** Generated filename */
    filename: string;
    /** Full image URL */
    imageUrl: string;
    /** Created Image element */
    imageElement: HTMLImageElement;
}

/**
 * Uploads an image blob to ComfyUI server and returns image element
 * @param blob - Image blob to upload
 * @param options - Upload options
 * @returns Promise with upload result
 */
export const uploadImageBlob = withErrorHandling(async function(blob: Blob, options: UploadImageOptions = {}): Promise<UploadImageResult> {
    if (!blob) {
        throw createValidationError("Blob is required", { blob });
    }
    if (blob.size === 0) {
        throw createValidationError("Blob cannot be empty", { blobSize: blob.size });
    }

    const {
        filenamePrefix = 'layerforge',
        overwrite = true,
        type = 'temp',
        nodeId
    } = options;

    // Generate unique filename
    const timestamp = Date.now();
    const nodeIdSuffix = nodeId ? `-${nodeId}` : '';
    const filename = `${filenamePrefix}${nodeIdSuffix}-${timestamp}.png`;

    log.debug('Uploading image blob:', {
        filename,
        blobSize: blob.size,
        type,
        overwrite
    });

    // Create FormData
    const formData = new FormData();
    formData.append("image", blob, filename);
    formData.append("overwrite", overwrite.toString());
    formData.append("type", type);

    // Upload to server
    const response = await api.fetchApi("/upload/image", {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        throw createNetworkError(`Failed to upload image: ${response.statusText}`, {
            status: response.status,
            statusText: response.statusText,
            filename,
            blobSize: blob.size
        });
    }

    const data = await response.json();
    log.debug('Image uploaded successfully:', data);

    // Create image element with proper URL
    const imageUrl = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
    const imageElement = new Image();
    imageElement.crossOrigin = "anonymous";

    // Wait for image to load
    await new Promise<void>((resolve, reject) => {
        imageElement.onload = () => {
            log.debug("Uploaded image loaded successfully", {
                width: imageElement.width,
                height: imageElement.height,
                src: imageElement.src.substring(0, 100) + '...'
            });
            resolve();
        };
        imageElement.onerror = (error) => {
            log.error("Failed to load uploaded image", error);
            reject(createNetworkError("Failed to load uploaded image", { error, imageUrl, filename }));
        };
        imageElement.src = imageUrl;
    });

    return {
        data,
        filename,
        imageUrl,
        imageElement
    };
}, 'uploadImageBlob');

/**
 * Uploads canvas content as image blob
 * @param canvas - Canvas element or Canvas object with canvasLayers
 * @param options - Upload options
 * @returns Promise with upload result
 */
export const uploadCanvasAsImage = withErrorHandling(async function(canvas: any, options: UploadImageOptions = {}): Promise<UploadImageResult> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }

    let blob: Blob | null = null;

    // Handle different canvas types
    if (canvas.canvasLayers && typeof canvas.canvasLayers.getFlattenedCanvasAsBlob === 'function') {
        // LayerForge Canvas object
        blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
    } else if (canvas instanceof HTMLCanvasElement) {
        // Standard HTML Canvas
        blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
    } else {
        throw createValidationError("Unsupported canvas type", { 
            canvas,
            hasCanvasLayers: !!canvas.canvasLayers,
            isHTMLCanvas: canvas instanceof HTMLCanvasElement
        });
    }

    if (!blob) {
        throw createValidationError("Failed to generate canvas blob", { canvas, options });
    }

    return uploadImageBlob(blob, options);
}, 'uploadCanvasAsImage');

/**
 * Uploads canvas with mask as image blob
 * @param canvas - Canvas object with canvasLayers
 * @param options - Upload options
 * @returns Promise with upload result
 */
export const uploadCanvasWithMaskAsImage = withErrorHandling(async function(canvas: any, options: UploadImageOptions = {}): Promise<UploadImageResult> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }
    if (!canvas.canvasLayers || typeof canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob !== 'function') {
        throw createValidationError("Canvas does not support mask operations", { 
            canvas,
            hasCanvasLayers: !!canvas.canvasLayers,
            hasMaskMethod: !!(canvas.canvasLayers && typeof canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob === 'function')
        });
    }

    const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
    if (!blob) {
        throw createValidationError("Failed to generate canvas with mask blob", { canvas, options });
    }

    return uploadImageBlob(blob, options);
}, 'uploadCanvasWithMaskAsImage');
