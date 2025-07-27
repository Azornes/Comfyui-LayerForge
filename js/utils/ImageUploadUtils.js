import { api } from "../../../scripts/api.js";
import { createModuleLogger } from "./LoggerUtils.js";
const log = createModuleLogger('ImageUploadUtils');
/**
 * Uploads an image blob to ComfyUI server and returns image element
 * @param blob - Image blob to upload
 * @param options - Upload options
 * @returns Promise with upload result
 */
export async function uploadImageBlob(blob, options = {}) {
    const { filenamePrefix = 'layerforge', overwrite = true, type = 'temp', nodeId } = options;
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
        const error = new Error(`Failed to upload image: ${response.statusText}`);
        log.error('Image upload failed:', error);
        throw error;
    }
    const data = await response.json();
    log.debug('Image uploaded successfully:', data);
    // Create image element with proper URL
    const imageUrl = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
    const imageElement = new Image();
    imageElement.crossOrigin = "anonymous";
    // Wait for image to load
    await new Promise((resolve, reject) => {
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
            reject(new Error("Failed to load uploaded image"));
        };
        imageElement.src = imageUrl;
    });
    return {
        data,
        filename,
        imageUrl,
        imageElement
    };
}
/**
 * Uploads canvas content as image blob
 * @param canvas - Canvas element or Canvas object with canvasLayers
 * @param options - Upload options
 * @returns Promise with upload result
 */
export async function uploadCanvasAsImage(canvas, options = {}) {
    let blob = null;
    // Handle different canvas types
    if (canvas.canvasLayers && typeof canvas.canvasLayers.getFlattenedCanvasAsBlob === 'function') {
        // LayerForge Canvas object
        blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
    }
    else if (canvas instanceof HTMLCanvasElement) {
        // Standard HTML Canvas
        blob = await new Promise(resolve => canvas.toBlob(resolve));
    }
    else {
        throw new Error("Unsupported canvas type");
    }
    if (!blob) {
        throw new Error("Failed to generate canvas blob");
    }
    return uploadImageBlob(blob, options);
}
/**
 * Uploads canvas with mask as image blob
 * @param canvas - Canvas object with canvasLayers
 * @param options - Upload options
 * @returns Promise with upload result
 */
export async function uploadCanvasWithMaskAsImage(canvas, options = {}) {
    if (!canvas.canvasLayers || typeof canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob !== 'function') {
        throw new Error("Canvas does not support mask operations");
    }
    const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
    if (!blob) {
        throw new Error("Failed to generate canvas with mask blob");
    }
    return uploadImageBlob(blob, options);
}
