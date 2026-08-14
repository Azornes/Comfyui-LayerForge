// @ts-ignore
import { api } from "../../../scripts/api.js";
import { createModuleLogger } from "../log_system/log_funcs.js";
import { withErrorHandling, createValidationError, createNetworkError } from "../shared/ErrorHandler.js";
import { resolveCanvasBlob, type CanvasBlobVariant } from './CanvasBlobUtils.js';
import { loadImage } from './ImageUtils.js';

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

interface CanvasBlobUploadConfig {
    variant: CanvasBlobVariant;
    allowNativeCanvasFallback: boolean;
    unsupportedCanvasMessage: string;
    emptyBlobMessage: string;
}

interface ImageBlobUploadRequest {
    blob: Blob;
    filename: string;
    overwrite?: boolean;
    type?: string;
}

type ImageUploadTransport = (input: string, init: RequestInit) => Promise<Response>;

export async function postImageBlob(
    request: ImageBlobUploadRequest,
    transport: ImageUploadTransport = (input, init) => api.fetchApi(input, init)
): Promise<Response> {
    const formData = new FormData();
    formData.append("image", request.blob, request.filename);
    formData.append("overwrite", (request.overwrite ?? true).toString());
    if (request.type !== undefined) {
        formData.append("type", request.type);
    }

    return transport("/upload/image", {
        method: "POST",
        body: formData,
    });
}

async function getCanvasBlobForUpload(
    canvas: any,
    uploadOptions: UploadImageOptions,
    config: CanvasBlobUploadConfig
): Promise<Blob> {
    if (!canvas) {
        throw createValidationError("Canvas is required", { canvas });
    }

    const resolution = await resolveCanvasBlob(canvas, config.variant, {
        allowNativeCanvasFallback: config.allowNativeCanvasFallback,
    });

    if (resolution.source === 'unsupported') {
        throw createValidationError(config.unsupportedCanvasMessage, {
            canvas,
            hasCanvasLayers: !!canvas.canvasLayers,
            isHTMLCanvas: typeof HTMLCanvasElement !== 'undefined'
                && canvas instanceof HTMLCanvasElement,
            ...(config.variant === 'with-mask'
                ? { hasMaskMethod: false }
                : {})
        });
    }

    if (!resolution.blob) {
        throw createValidationError(config.emptyBlobMessage, { canvas, options: uploadOptions });
    }

    return resolution.blob;
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

    // Upload to server
    const response = await postImageBlob({
        blob,
        filename,
        overwrite,
        type
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
    let imageElement: HTMLImageElement;
    try {
        imageElement = await loadImage(imageUrl, { crossOrigin: "anonymous" });
    } catch (error) {
        log.error("Failed to load uploaded image", error);
        throw createNetworkError("Failed to load uploaded image", { error, imageUrl, filename });
    }

    log.debug("Uploaded image loaded successfully", {
        width: imageElement.width,
        height: imageElement.height,
        src: imageElement.src.substring(0, 100) + '...'
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
    const blob = await getCanvasBlobForUpload(canvas, options, {
        variant: 'plain',
        allowNativeCanvasFallback: true,
        unsupportedCanvasMessage: "Unsupported canvas type",
        emptyBlobMessage: "Failed to generate canvas blob"
    });
    return uploadImageBlob(blob, options);
}, 'uploadCanvasAsImage');

/**
 * Uploads canvas with mask as image blob
 * @param canvas - Canvas object with canvasLayers
 * @param options - Upload options
 * @returns Promise with upload result
 */
export const uploadCanvasWithMaskAsImage = withErrorHandling(async function(canvas: any, options: UploadImageOptions = {}): Promise<UploadImageResult> {
    const blob = await getCanvasBlobForUpload(canvas, options, {
        variant: 'with-mask',
        allowNativeCanvasFallback: false,
        unsupportedCanvasMessage: "Canvas does not support mask operations",
        emptyBlobMessage: "Failed to generate canvas with mask blob"
    });
    return uploadImageBlob(blob, options);
}, 'uploadCanvasWithMaskAsImage');
