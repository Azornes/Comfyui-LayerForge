/**
 * Converts RGB luminance into an opaque white mask with luminance as alpha.
 */
export function applyLuminanceAsAlpha(imageData) {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const luminance = Math.round(0.299 * data[i] +
            0.587 * data[i + 1] +
            0.114 * data[i + 2]);
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = luminance;
    }
}
/**
 * Fills an opaque white mask from the inverse alpha of visibility data.
 */
export function fillInverseAlphaMask(visibilityData, maskData) {
    for (let i = 0; i < visibilityData.data.length; i += 4) {
        const maskValue = 255 - visibilityData.data[i + 3];
        maskData.data[i] = maskValue;
        maskData.data[i + 1] = maskValue;
        maskData.data[i + 2] = maskValue;
        maskData.data[i + 3] = 255;
    }
}
/**
 * Converts one ImageData channel into a binary mask.
 */
export function imageDataToBinaryMask(imageData, width, height, channel) {
    const binaryMask = new Uint8Array(width * height);
    for (let i = 0; i < binaryMask.length; i++) {
        binaryMask[i] = imageData.data[i * 4 + channel] > 0 ? 1 : 0;
    }
    return binaryMask;
}
/**
 * Rasterizes a distance field into a white RGBA mask with feathered alpha.
 * A null binary mask means every pixel is inside the mask.
 */
export function rasterizeDistanceFieldMask(distanceMap, binaryMask, threshold, outputData) {
    for (let i = 0; i < distanceMap.length; i++) {
        const distance = distanceMap[i];
        const isInside = binaryMask === null || binaryMask[i] === 1;
        const pixelIndex = i * 4;
        outputData[pixelIndex] = 255;
        outputData[pixelIndex + 1] = 255;
        outputData[pixelIndex + 2] = 255;
        if (!isInside) {
            outputData[pixelIndex + 3] = 0;
        }
        else if (distance <= threshold) {
            const gradientValue = distance / threshold;
            outputData[pixelIndex + 3] = Math.floor(gradientValue * 255);
        }
        else {
            outputData[pixelIndex + 3] = 255;
        }
    }
}
/**
 * Calculates the Euclidean distance transform of a binary mask.
 * Uses a two-pass algorithm for efficiency.
 * @param binaryMask - Binary mask where 1 = inside, 0 = outside
 * @param width - Width of the mask
 * @param height - Height of the mask
 * @returns Float32Array containing distance values
 */
export function calculateDistanceTransform(binaryMask, width, height) {
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
