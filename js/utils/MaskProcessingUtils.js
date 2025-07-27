import { createModuleLogger } from "./LoggerUtils.js";
import { createCanvas } from "./CommonUtils.js";
import { withErrorHandling, createValidationError } from "../ErrorHandler.js";
const log = createModuleLogger('MaskProcessingUtils');
/**
 * Processes an image to create a mask with inverted alpha channel
 * @param sourceImage - Source image or canvas element
 * @param options - Processing options
 * @returns Promise with processed mask as HTMLCanvasElement
 */
export const processImageToMask = withErrorHandling(async function (sourceImage, options = {}) {
    if (!sourceImage) {
        throw createValidationError("Source image is required", { sourceImage });
    }
    const { targetWidth = sourceImage.width, targetHeight = sourceImage.height, invertAlpha = true, maskColor = { r: 255, g: 255, b: 255 } } = options;
    log.debug('Processing image to mask:', {
        sourceSize: { width: sourceImage.width, height: sourceImage.height },
        targetSize: { width: targetWidth, height: targetHeight },
        invertAlpha,
        maskColor
    });
    // Create temporary canvas for processing
    const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(targetWidth, targetHeight, '2d', { willReadFrequently: true });
    if (!tempCtx) {
        throw createValidationError("Failed to get 2D context for mask processing");
    }
    // Draw the source image
    tempCtx.drawImage(sourceImage, 0, 0, targetWidth, targetHeight);
    // Get image data for processing
    const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imageData.data;
    // Process pixels to create mask
    for (let i = 0; i < data.length; i += 4) {
        const originalAlpha = data[i + 3];
        // Set RGB to mask color
        data[i] = maskColor.r; // Red
        data[i + 1] = maskColor.g; // Green
        data[i + 2] = maskColor.b; // Blue
        // Handle alpha channel
        if (invertAlpha) {
            data[i + 3] = 255 - originalAlpha; // Invert alpha
        }
        else {
            data[i + 3] = originalAlpha; // Keep original alpha
        }
    }
    // Put processed data back to canvas
    tempCtx.putImageData(imageData, 0, 0);
    log.debug('Mask processing completed');
    return tempCanvas;
}, 'processImageToMask');
/**
 * Processes image data with custom pixel transformation
 * @param sourceImage - Source image or canvas element
 * @param pixelTransform - Custom pixel transformation function
 * @param options - Processing options
 * @returns Promise with processed image as HTMLCanvasElement
 */
export const processImageWithTransform = withErrorHandling(async function (sourceImage, pixelTransform, options = {}) {
    if (!sourceImage) {
        throw createValidationError("Source image is required", { sourceImage });
    }
    if (!pixelTransform || typeof pixelTransform !== 'function') {
        throw createValidationError("Pixel transform function is required", { pixelTransform });
    }
    const { targetWidth = sourceImage.width, targetHeight = sourceImage.height } = options;
    const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(targetWidth, targetHeight, '2d', { willReadFrequently: true });
    if (!tempCtx) {
        throw createValidationError("Failed to get 2D context for image processing");
    }
    tempCtx.drawImage(sourceImage, 0, 0, targetWidth, targetHeight);
    const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = pixelTransform(data[i], data[i + 1], data[i + 2], data[i + 3], i / 4);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
    }
    tempCtx.putImageData(imageData, 0, 0);
    return tempCanvas;
}, 'processImageWithTransform');
/**
 * Crops an image to a specific region
 * @param sourceImage - Source image or canvas
 * @param cropArea - Crop area {x, y, width, height}
 * @returns Promise with cropped image as HTMLCanvasElement
 */
export const cropImage = withErrorHandling(async function (sourceImage, cropArea) {
    if (!sourceImage) {
        throw createValidationError("Source image is required", { sourceImage });
    }
    if (!cropArea || typeof cropArea !== 'object') {
        throw createValidationError("Crop area is required", { cropArea });
    }
    const { x, y, width, height } = cropArea;
    if (width <= 0 || height <= 0) {
        throw createValidationError("Crop area must have positive width and height", { cropArea });
    }
    log.debug('Cropping image:', {
        sourceSize: { width: sourceImage.width, height: sourceImage.height },
        cropArea
    });
    const { canvas, ctx } = createCanvas(width, height);
    if (!ctx) {
        throw createValidationError("Failed to get 2D context for image cropping");
    }
    ctx.drawImage(sourceImage, x, y, width, height, // Source rectangle
    0, 0, width, height // Destination rectangle
    );
    return canvas;
}, 'cropImage');
/**
 * Applies a mask to an image using viewport positioning
 * @param maskImage - Mask image or canvas
 * @param targetWidth - Target viewport width
 * @param targetHeight - Target viewport height
 * @param viewportOffset - Viewport offset {x, y}
 * @param maskColor - Mask color (default: white)
 * @returns Promise with processed mask for viewport
 */
export const processMaskForViewport = withErrorHandling(async function (maskImage, targetWidth, targetHeight, viewportOffset, maskColor = { r: 255, g: 255, b: 255 }) {
    if (!maskImage) {
        throw createValidationError("Mask image is required", { maskImage });
    }
    if (!viewportOffset || typeof viewportOffset !== 'object') {
        throw createValidationError("Viewport offset is required", { viewportOffset });
    }
    if (targetWidth <= 0 || targetHeight <= 0) {
        throw createValidationError("Target dimensions must be positive", { targetWidth, targetHeight });
    }
    log.debug("Processing mask for viewport:", {
        sourceSize: { width: maskImage.width, height: maskImage.height },
        targetSize: { width: targetWidth, height: targetHeight },
        viewportOffset
    });
    const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(targetWidth, targetHeight, '2d', { willReadFrequently: true });
    if (!tempCtx) {
        throw createValidationError("Failed to get 2D context for viewport mask processing");
    }
    // Calculate source coordinates based on viewport offset
    const sourceX = -viewportOffset.x;
    const sourceY = -viewportOffset.y;
    // Draw the mask with viewport cropping
    tempCtx.drawImage(maskImage, // Source: full mask from "output area"
    sourceX, // sx: Real X coordinate on large mask
    sourceY, // sy: Real Y coordinate on large mask
    targetWidth, // sWidth: Width of cropped fragment
    targetHeight, // sHeight: Height of cropped fragment
    0, // dx: Where to paste in target canvas (always 0)
    0, // dy: Where to paste in target canvas (always 0)
    targetWidth, // dWidth: Width of pasted image
    targetHeight // dHeight: Height of pasted image
    );
    // Apply mask color
    const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha > 0) {
            data[i] = maskColor.r;
            data[i + 1] = maskColor.g;
            data[i + 2] = maskColor.b;
        }
    }
    tempCtx.putImageData(imageData, 0, 0);
    log.debug("Viewport mask processing completed");
    return tempCanvas;
}, 'processMaskForViewport');
