import { createModuleLogger } from "./LoggerUtils.js";
const log = createModuleLogger('ImageAnalysis');
/**
 * Creates a distance field mask based on the alpha channel of an image.
 * The mask will have gradients from the edges of visible pixels inward.
 * @param image - The source image to analyze
 * @param blendArea - The percentage (0-100) of the area to apply blending
 * @returns HTMLCanvasElement containing the distance field mask
 */
export function createDistanceFieldMask(image, blendArea) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
    let maxDistance;
    if (hasTransparency) {
        // For images with transparency, use alpha-based distance transform
        const binaryMask = new Uint8Array(width * height);
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
    for (let i = 0; i < width * height; i++) {
        const distance = distanceField[i];
        const alpha = data[i * 4 + 3];
        if (alpha === 0) {
            // Transparent pixels remain transparent
            maskData.data[i * 4] = 255;
            maskData.data[i * 4 + 1] = 255;
            maskData.data[i * 4 + 2] = 255;
            maskData.data[i * 4 + 3] = 0;
        }
        else if (distance <= threshold) {
            // Edge area - apply gradient alpha
            const gradientValue = distance / threshold;
            const alphaValue = Math.floor(gradientValue * 255);
            maskData.data[i * 4] = 255;
            maskData.data[i * 4 + 1] = 255;
            maskData.data[i * 4 + 2] = 255;
            maskData.data[i * 4 + 3] = alphaValue;
        }
        else {
            // Inner area - full alpha (no blending effect)
            maskData.data[i * 4] = 255;
            maskData.data[i * 4 + 1] = 255;
            maskData.data[i * 4 + 2] = 255;
            maskData.data[i * 4 + 3] = 255;
        }
    }
    // Clear canvas and put the mask data
    ctx.clearRect(0, 0, width, height);
    ctx.putImageData(maskData, 0, 0);
    return canvas;
}
/**
 * Calculates the Euclidean distance transform of a binary mask.
 * Uses a two-pass algorithm for efficiency.
 * @param binaryMask - Binary mask where 1 = inside, 0 = outside
 * @param width - Width of the mask
 * @param height - Height of the mask
 * @returns Float32Array containing distance values
 */
function calculateDistanceTransform(binaryMask, width, height) {
    const distances = new Float32Array(width * height);
    const infinity = width + height; // A value larger than any possible distance
    // Initialize distances
    for (let i = 0; i < width * height; i++) {
        distances[i] = binaryMask[i] === 1 ? infinity : 0;
    }
    // Forward pass (top-left to bottom-right)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (distances[idx] > 0) {
                let minDist = distances[idx];
                // Check top neighbor
                if (y > 0) {
                    minDist = Math.min(minDist, distances[(y - 1) * width + x] + 1);
                }
                // Check left neighbor
                if (x > 0) {
                    minDist = Math.min(minDist, distances[y * width + (x - 1)] + 1);
                }
                // Check top-left diagonal
                if (x > 0 && y > 0) {
                    minDist = Math.min(minDist, distances[(y - 1) * width + (x - 1)] + Math.sqrt(2));
                }
                // Check top-right diagonal
                if (x < width - 1 && y > 0) {
                    minDist = Math.min(minDist, distances[(y - 1) * width + (x + 1)] + Math.sqrt(2));
                }
                distances[idx] = minDist;
            }
        }
    }
    // Backward pass (bottom-right to top-left)
    for (let y = height - 1; y >= 0; y--) {
        for (let x = width - 1; x >= 0; x--) {
            const idx = y * width + x;
            if (distances[idx] > 0) {
                let minDist = distances[idx];
                // Check bottom neighbor
                if (y < height - 1) {
                    minDist = Math.min(minDist, distances[(y + 1) * width + x] + 1);
                }
                // Check right neighbor
                if (x < width - 1) {
                    minDist = Math.min(minDist, distances[y * width + (x + 1)] + 1);
                }
                // Check bottom-right diagonal
                if (x < width - 1 && y < height - 1) {
                    minDist = Math.min(minDist, distances[(y + 1) * width + (x + 1)] + Math.sqrt(2));
                }
                // Check bottom-left diagonal
                if (x > 0 && y < height - 1) {
                    minDist = Math.min(minDist, distances[(y + 1) * width + (x - 1)] + Math.sqrt(2));
                }
                distances[idx] = minDist;
            }
        }
    }
    return distances;
}
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
export function createRadialGradientMask(width, height, blendArea) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
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
}
