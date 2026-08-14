import { createModuleLogger } from "../log_system/log_funcs.js";
import { createCanvas } from "../utils/CommonUtils.js";
import { calculateDistanceTransform, rasterizeDistanceFieldMask } from "./MaskPixelUtils.js";
import { withErrorHandling, createValidationError } from "../shared/ErrorHandler.js";
const log = createModuleLogger('ImageAnalysis');
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
    const { canvas, ctx } = createCanvas(image.width, image.height, '2d', { willReadFrequently: true });
    if (!ctx) {
        log.error('Failed to create canvas context for distance field mask');
        return canvas;
    }
    // Draw the image to extract pixel data
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    // Check if image has transparency (any alpha < 255)
    let hasTransparency = false;
    for (let i = 0; i < width * height; i++) {
        if (data[i * 4 + 3] < 255) {
            hasTransparency = true;
            break;
        }
    }
    let distanceField;
    let binaryMask = null;
    let maxDistance;
    if (hasTransparency) {
        // For images with transparency, use alpha-based distance transform
        binaryMask = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            binaryMask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        }
        distanceField = calculateDistanceTransform(binaryMask, width, height);
    }
    else {
        // For opaque images, calculate distance from edges of the rectangle
        distanceField = calculateDistanceFromEdges(width, height);
    }
    // Find the maximum distance to normalize
    maxDistance = 0;
    for (let i = 0; i < distanceField.length; i++) {
        if (distanceField[i] > maxDistance) {
            maxDistance = distanceField[i];
        }
    }
    // Create the gradient mask based on blendArea
    const maskData = ctx.createImageData(width, height);
    const threshold = maxDistance * (blendArea / 100);
    rasterizeDistanceFieldMask(distanceField, binaryMask, threshold, maskData.data);
    // Clear canvas and put the mask data
    ctx.clearRect(0, 0, width, height);
    ctx.putImageData(maskData, 0, 0);
    return canvas;
}
/**
 * Async version with error handling for use in async contexts
 */
export const createDistanceFieldMask = withErrorHandling(function (image, blendArea) {
    return createDistanceFieldMaskSync(image, blendArea);
}, 'createDistanceFieldMask');
/**
 * Calculates distance from edges of a rectangle for opaque images.
 * @param width - Width of the rectangle
 * @param height - Height of the rectangle
 * @returns Float32Array containing distance values from edges
 */
function calculateDistanceFromEdges(width, height) {
    const distances = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            // Calculate distance to nearest edge
            const distToLeft = x;
            const distToRight = width - 1 - x;
            const distToTop = y;
            const distToBottom = height - 1 - y;
            // Minimum distance to any edge
            const minDistToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom);
            distances[idx] = minDistToEdge;
        }
    }
    return distances;
}
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
