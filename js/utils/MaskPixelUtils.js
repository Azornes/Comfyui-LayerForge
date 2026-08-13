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
