import { createModuleLogger } from "../log_system/log_funcs.js";
import { createCanvas } from "../utils/common_utils.js";
import { calculateDistanceTransform, rasterizeDistanceFieldMask } from "./mask_pixel_utils.js";
import { withErrorHandling, createValidationError } from "../shared/error_handler.js";
const log = createModuleLogger('ImageAnalysis');
export function createDistanceFieldDataSync(image) {
    if (!image) {
        log.error("Image is required for distance field data");
        return null;
    }
    const { canvas: analysisCanvas, ctx: analysisCtx } = createCanvas(image.width, image.height, '2d', { willReadFrequently: true });
    if (!analysisCtx) {
        log.error('Failed to create canvas context for distance field data');
        return null;
    }
    // Draw the source once. Pixel geometry does not depend on blendArea.
    analysisCtx.drawImage(image, 0, 0);
    const imageData = analysisCtx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
    const data = imageData.data;
    const width = analysisCanvas.width;
    const height = analysisCanvas.height;
    let hasTransparency = false;
    for (let i = 0; i < width * height; i++) {
        if (data[i * 4 + 3] < 255) {
            hasTransparency = true;
            break;
        }
    }
    let distanceField = null;
    let binaryMask = null;
    let isOpaqueRectangle = false;
    if (hasTransparency) {
        binaryMask = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            binaryMask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        }
        distanceField = calculateDistanceTransform(binaryMask, width, height);
    }
    else {
        // For a fully opaque image the distance is always the distance to
        // the nearest rectangle edge. Keep this analytic instead of storing
        // another 32-bit value for every pixel.
        isOpaqueRectangle = true;
    }
    let maxDistance = 0;
    if (distanceField) {
        for (let i = 0; i < distanceField.length; i++) {
            if (distanceField[i] > maxDistance) {
                maxDistance = distanceField[i];
            }
        }
    }
    else if (isOpaqueRectangle) {
        maxDistance = Math.floor((Math.min(width, height) - 1) / 2);
    }
    const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(width, height);
    if (!maskCtx) {
        log.error('Failed to create canvas context for distance field mask');
        return null;
    }
    return {
        width,
        height,
        distanceField,
        binaryMask,
        maxDistance,
        isOpaqueRectangle,
        // Reuse this backing canvas when only blendArea changes.
        maskCanvas,
        maskImageData: maskCtx.createImageData(width, height)
    };
}
export function rasterizeDistanceFieldMaskSync(data, blendArea) {
    const { maskCanvas, width, height, distanceField, binaryMask, maxDistance } = data;
    const ctx = maskCanvas.getContext('2d');
    if (!ctx) {
        log.error('Failed to create canvas context for distance field mask');
        return maskCanvas;
    }
    const maskData = data.maskImageData ?? ctx.createImageData(width, height);
    data.maskImageData = maskData;
    const threshold = maxDistance * (blendArea / 100);
    if (data.isOpaqueRectangle) {
        rasterizeOpaqueRectangleMask(width, height, threshold, maskData.data);
    }
    else if (distanceField) {
        rasterizeDistanceFieldMask(distanceField, binaryMask, threshold, maskData.data);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.putImageData(maskData, 0, 0);
    return maskCanvas;
}
function rasterizeOpaqueRectangleMask(width, height, threshold, outputData) {
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const distance = Math.min(x, width - 1 - x, y, height - 1 - y);
            const pixelIndex = (y * width + x) * 4;
            outputData[pixelIndex] = 255;
            outputData[pixelIndex + 1] = 255;
            outputData[pixelIndex + 2] = 255;
            if (distance <= threshold) {
                const gradientValue = distance / threshold;
                outputData[pixelIndex + 3] = Math.floor(gradientValue * 255);
            }
            else {
                outputData[pixelIndex + 3] = 255;
            }
        }
    }
}
/**
 * Creates a distance field mask based on the alpha channel of an image.
 * The mask will have gradients from the edges of visible pixels inward.
 * @param image - The source image to analyze
 * @param blendArea - The percentage (0-100) of the area to apply blending
 * @returns HTMLCanvasElement containing the distance field mask
 */
/**
 * Synchronous version of createDistanceFieldMask for use in synchronous rendering
 */
export function createDistanceFieldMaskSync(image, blendArea) {
    if (!image) {
        log.error("Image is required for distance field mask");
        return createCanvas(1, 1).canvas;
    }
    if (typeof blendArea !== 'number' || blendArea < 0 || blendArea > 100) {
        log.error("Blend area must be a number between 0 and 100");
        return createCanvas(1, 1).canvas;
    }
    const data = createDistanceFieldDataSync(image);
    if (!data)
        return createCanvas(image.width, image.height).canvas;
    return rasterizeDistanceFieldMaskSync(data, blendArea);
}
/**
 * Async version with error handling for use in async contexts
 */
export const createDistanceFieldMask = withErrorHandling(function (image, blendArea) {
    return createDistanceFieldMaskSync(image, blendArea);
}, 'createDistanceFieldMask');
/**
 * Creates a simple radial gradient mask (fallback for rectangular areas).
 * @param width - Width of the mask
 * @param height - Height of the mask
 * @param blendArea - The percentage (0-100) of the area to apply blending
 * @returns HTMLCanvasElement containing the radial gradient mask
 */
export const createRadialGradientMask = withErrorHandling(function (width, height, blendArea) {
    if (typeof width !== 'number' || width <= 0) {
        throw createValidationError("Width must be a positive number", { width });
    }
    if (typeof height !== 'number' || height <= 0) {
        throw createValidationError("Height must be a positive number", { height });
    }
    if (typeof blendArea !== 'number' || blendArea < 0 || blendArea > 100) {
        throw createValidationError("Blend area must be a number between 0 and 100", { blendArea });
    }
    const { canvas, ctx } = createCanvas(width, height);
    if (!ctx) {
        log.error('Failed to create canvas context for radial gradient mask');
        return canvas;
    }
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);
    const innerRadius = maxRadius * (1 - blendArea / 100);
    // Create radial gradient
    const gradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, maxRadius);
    gradient.addColorStop(0, 'white');
    gradient.addColorStop(1, 'black');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return canvas;
}, 'createRadialGradientMask');
