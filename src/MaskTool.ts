import {createModuleLogger} from "./utils/LoggerUtils.js";
import type { Canvas } from './Canvas';
import type { Point, CanvasState } from './types';

const log = createModuleLogger('Mask_tool');

interface MaskToolCallbacks {
    onStateChange?: () => void;
}

export class MaskTool {
    private brushHardness: number;
    private brushSize: number;
    private brushStrength: number;
    private canvasInstance: Canvas & { canvasState: CanvasState, width: number, height: number };
    public isActive: boolean;
    public isDrawing: boolean;
    public isOverlayVisible: boolean;
    private lastPosition: Point | null;
    private mainCanvas: HTMLCanvasElement;
    private maskCanvas: HTMLCanvasElement;
    private maskCtx: CanvasRenderingContext2D;
    private onStateChange: (() => void) | null;
    private previewCanvas: HTMLCanvasElement;
    private previewCanvasInitialized: boolean;
    private previewCtx: CanvasRenderingContext2D;
    private previewVisible: boolean;
    public x: number;
    public y: number;

    constructor(canvasInstance: Canvas & { canvasState: CanvasState, width: number, height: number }, callbacks: MaskToolCallbacks = {}) {
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.onStateChange = callbacks.onStateChange || null;
        this.maskCanvas = document.createElement('canvas');
        const maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!maskCtx) {
            throw new Error("Failed to get 2D context for mask canvas");
        }
        this.maskCtx = maskCtx;

        this.x = 0;
        this.y = 0;

        this.isOverlayVisible = true;
        this.isActive = false;
        this.brushSize = 20;
        this.brushStrength = 0.5;
        this.brushHardness = 0.5;
        this.isDrawing = false;
        this.lastPosition = null;

        this.previewCanvas = document.createElement('canvas');
        const previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
        if (!previewCtx) {
            throw new Error("Failed to get 2D context for preview canvas");
        }
        this.previewCtx = previewCtx;
        this.previewVisible = false;
        this.previewCanvasInitialized = false;

        this.initMaskCanvas();
    }

    initPreviewCanvas(): void {
        if (this.previewCanvas.parentElement) {
            this.previewCanvas.parentElement.removeChild(this.previewCanvas);
        }
        this.previewCanvas.width = this.canvasInstance.canvas.width;
        this.previewCanvas.height = this.canvasInstance.canvas.height;
        this.previewCanvas.style.position = 'absolute';
        this.previewCanvas.style.left = `${this.canvasInstance.canvas.offsetLeft}px`;
        this.previewCanvas.style.top = `${this.canvasInstance.canvas.offsetTop}px`;
        this.previewCanvas.style.pointerEvents = 'none';
        this.previewCanvas.style.zIndex = '10';
        if (this.canvasInstance.canvas.parentElement) {
            this.canvasInstance.canvas.parentElement.appendChild(this.previewCanvas);
        }
    }

    setBrushHardness(hardness: number): void {
        this.brushHardness = Math.max(0, Math.min(1, hardness));
    }

    initMaskCanvas(): void {
        const extraSpace = 2000; // Allow for a generous drawing area outside the output area
        this.maskCanvas.width = this.canvasInstance.width + extraSpace;
        this.maskCanvas.height = this.canvasInstance.height + extraSpace;


        this.x = -extraSpace / 2;
        this.y = -extraSpace / 2;

        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        log.info(`Initialized mask canvas with extended size: ${this.maskCanvas.width}x${this.maskCanvas.height}, origin at (${this.x}, ${this.y})`);
    }

    activate(): void {
        if (!this.previewCanvasInitialized) {
            this.initPreviewCanvas();
            this.previewCanvasInitialized = true;
        }
        this.isActive = true;
        this.previewCanvas.style.display = 'block';
        this.canvasInstance.interaction.mode = 'drawingMask';
        if (this.canvasInstance.canvasState.maskUndoStack.length === 0) {
            this.canvasInstance.canvasState.saveMaskState();
        }
        this.canvasInstance.updateHistoryButtons();

        log.info("Mask tool activated");
    }

    deactivate(): void {
        this.isActive = false;
        this.previewCanvas.style.display = 'none';
        this.canvasInstance.interaction.mode = 'none';
        this.canvasInstance.updateHistoryButtons();

        log.info("Mask tool deactivated");
    }

    setBrushSize(size: number): void {
        this.brushSize = Math.max(1, size);
    }

    setBrushStrength(strength: number): void {
        this.brushStrength = Math.max(0, Math.min(1, strength));
    }

    handleMouseDown(worldCoords: Point, viewCoords: Point): void {
        if (!this.isActive) return;
        this.isDrawing = true;
        this.lastPosition = worldCoords;
        this.draw(worldCoords);
        this.clearPreview();
    }

    handleMouseMove(worldCoords: Point, viewCoords: Point): void {
        if (this.isActive) {
            this.drawBrushPreview(viewCoords);
        }
        if (!this.isActive || !this.isDrawing) return;
        this.draw(worldCoords);
        this.lastPosition = worldCoords;
    }

    handleMouseLeave(): void {
        this.previewVisible = false;
        this.clearPreview();
    }

    handleMouseEnter(): void {
        this.previewVisible = true;
    }

    handleMouseUp(viewCoords: Point): void {
        if (!this.isActive) return;
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastPosition = null;
            this.canvasInstance.canvasState.saveMaskState();
            if (this.onStateChange) {
                this.onStateChange();
            }
            this.drawBrushPreview(viewCoords);
        }
    }

    draw(worldCoords: Point): void {
        if (!this.lastPosition) {
            this.lastPosition = worldCoords;
        }


        const canvasLastX = this.lastPosition.x - this.x;
        const canvasLastY = this.lastPosition.y - this.y;
        const canvasX = worldCoords.x - this.x;
        const canvasY = worldCoords.y - this.y;


        const canvasWidth = this.maskCanvas.width;
        const canvasHeight = this.maskCanvas.height;

        if (canvasX >= 0 && canvasX < canvasWidth &&
            canvasY >= 0 && canvasY < canvasHeight &&
            canvasLastX >= 0 && canvasLastX < canvasWidth &&
            canvasLastY >= 0 && canvasLastY < canvasHeight) {

            this.maskCtx.beginPath();
            this.maskCtx.moveTo(canvasLastX, canvasLastY);
            this.maskCtx.lineTo(canvasX, canvasY);
            const gradientRadius = this.brushSize / 2;

            if (this.brushHardness === 1) {
                this.maskCtx.strokeStyle = `rgba(255, 255, 255, ${this.brushStrength})`;
            } else {
                const innerRadius = gradientRadius * this.brushHardness;
                const gradient = this.maskCtx.createRadialGradient(
                    canvasX, canvasY, innerRadius,
                    canvasX, canvasY, gradientRadius
                );
                gradient.addColorStop(0, `rgba(255, 255, 255, ${this.brushStrength})`);
                gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
                this.maskCtx.strokeStyle = gradient;
            }

            this.maskCtx.lineWidth = this.brushSize;
            this.maskCtx.lineCap = 'round';
            this.maskCtx.lineJoin = 'round';
            this.maskCtx.globalCompositeOperation = 'source-over';
            this.maskCtx.stroke();
        } else {
            log.debug(`Drawing outside mask canvas bounds: (${canvasX}, ${canvasY})`);
        }
    }

    drawBrushPreview(viewCoords: Point): void {
        if (!this.previewVisible || this.isDrawing) {
            this.clearPreview();
            return;
        }

        this.clearPreview();
        const zoom = this.canvasInstance.viewport.zoom;
        const radius = (this.brushSize / 2) * zoom;

        this.previewCtx.beginPath();
        this.previewCtx.arc(viewCoords.x, viewCoords.y, radius, 0, 2 * Math.PI);
        this.previewCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        this.previewCtx.lineWidth = 1;
        this.previewCtx.setLineDash([2, 4]);
        this.previewCtx.stroke();
    }

    clearPreview(): void {
        this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    }

    clear(): void {
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        if (this.isActive) {
            this.canvasInstance.canvasState.saveMaskState();
        }
    }

    getMask(): HTMLCanvasElement {
        return this.maskCanvas;
    }

    getMaskImageWithAlpha(): HTMLImageElement {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.maskCanvas.width;
        tempCanvas.height = this.maskCanvas.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        if (!tempCtx) {
            throw new Error("Failed to get 2D context for temporary canvas");
        }
        tempCtx.drawImage(this.maskCanvas, 0, 0);
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i];
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = alpha;
        }
        tempCtx.putImageData(imageData, 0, 0);
        const maskImage = new Image();
        maskImage.src = tempCanvas.toDataURL();
        return maskImage;
    }

    resize(width: number, height: number): void {
        this.initPreviewCanvas();
        const oldMask = this.maskCanvas;
        const oldX = this.x;
        const oldY = this.y;
        const oldWidth = oldMask.width;
        const oldHeight = oldMask.height;

        const isIncreasingWidth = width > this.canvasInstance.width;
        const isIncreasingHeight = height > this.canvasInstance.height;

        this.maskCanvas = document.createElement('canvas');

        const extraSpace = 2000;

        const newWidth = isIncreasingWidth ? width + extraSpace : Math.max(oldWidth, width + extraSpace);
        const newHeight = isIncreasingHeight ? height + extraSpace : Math.max(oldHeight, height + extraSpace);

        this.maskCanvas.width = newWidth;
        this.maskCanvas.height = newHeight;
        const newMaskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!newMaskCtx) {
            throw new Error("Failed to get 2D context for new mask canvas");
        }
        this.maskCtx = newMaskCtx;

        if (oldMask.width > 0 && oldMask.height > 0) {
            const offsetX = this.x - oldX;
            const offsetY = this.y - oldY;

            this.maskCtx.drawImage(oldMask, offsetX, offsetY);

            log.debug(`Preserved mask content with offset (${offsetX}, ${offsetY})`);
        }

        log.info(`Mask canvas resized to ${this.maskCanvas.width}x${this.maskCanvas.height}, position (${this.x}, ${this.y})`);
        log.info(`Canvas size change: width ${isIncreasingWidth ? 'increased' : 'decreased'}, height ${isIncreasingHeight ? 'increased' : 'decreased'}`);
    }

    updatePosition(dx: number, dy: number): void {
        this.x += dx;
        this.y += dy;
        log.info(`Mask position updated to (${this.x}, ${this.y})`);
    }

    toggleOverlayVisibility(): void {
        this.isOverlayVisible = !this.isOverlayVisible;
        log.info(`Mask overlay visibility toggled to: ${this.isOverlayVisible}`);
    }

    setMask(image: HTMLImageElement): void {
        const destX = -this.x;
        const destY = -this.y;

        this.maskCtx.clearRect(destX, destY, this.canvasInstance.width, this.canvasInstance.height);

        this.maskCtx.drawImage(image, destX, destY);

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`MaskTool updated with a new mask image at correct canvas position (${destX}, ${destY}).`);
    }

    addMask(image: HTMLImageElement): void {
        const destX = -this.x;
        const destY = -this.y;

        // Don't clear existing mask - just add to it
        this.maskCtx.globalCompositeOperation = 'source-over';
        this.maskCtx.drawImage(image, destX, destY);

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`MaskTool added mask overlay at correct canvas position (${destX}, ${destY}) without clearing existing mask.`);
    }

    applyShapeMask(saveState: boolean = true): void {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            log.warn("Cannot apply shape mask: shape is not defined or has too few points.");
            return;
        }
        if (saveState) {
            this.canvasInstance.canvasState.saveMaskState();
        }

        const shape = this.canvasInstance.outputAreaShape;
        const destX = -this.x;
        const destY = -this.y;

        // Clear the entire mask canvas first
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);

        // Create points relative to the mask canvas's coordinate system (by applying the offset)
        const maskPoints = shape.points.map(p => ({ x: p.x + destX, y: p.y + destY }));

        // Check if we need expansion or feathering
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;
        const needsFeather = this.canvasInstance.shapeMaskFeather && this.canvasInstance.shapeMaskFeatherValue > 0;

        if (!needsExpansion && !needsFeather) {
            // Simple case: just draw the original shape
            this.maskCtx.fillStyle = 'white';
            this.maskCtx.beginPath();
            this.maskCtx.moveTo(maskPoints[0].x, maskPoints[0].y);
            for (let i = 1; i < maskPoints.length; i++) {
                this.maskCtx.lineTo(maskPoints[i].x, maskPoints[i].y);
            }
            this.maskCtx.closePath();
            this.maskCtx.fill();
        } else if (needsExpansion && !needsFeather) {
            // Expansion only: use the new distance transform expansion
            const expandedMaskCanvas = this._createExpandedMaskCanvas(maskPoints, this.canvasInstance.shapeMaskExpansionValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(expandedMaskCanvas, 0, 0);
        } else if (!needsExpansion && needsFeather) {
            // Feather only: apply feathering to the original shape
            const featheredMaskCanvas = this._createFeatheredMaskCanvas(maskPoints, this.canvasInstance.shapeMaskFeatherValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(featheredMaskCanvas, 0, 0);
        } else {
            // Both expansion and feather: first expand, then apply feather to the expanded shape
            // Step 1: Create expanded shape
            const expandedMaskCanvas = this._createExpandedMaskCanvas(maskPoints, this.canvasInstance.shapeMaskExpansionValue, this.maskCanvas.width, this.maskCanvas.height);
            
            // Step 2: Extract points from the expanded canvas and apply feathering
            // For now, we'll apply feathering to the expanded canvas directly
            // This is a simplified approach - we could extract the outline points for more precision
            const tempCtx = expandedMaskCanvas.getContext('2d', { willReadFrequently: true })!;
            const expandedImageData = tempCtx.getImageData(0, 0, expandedMaskCanvas.width, expandedMaskCanvas.height);
            
            // Apply feathering to the expanded shape
            const featheredMaskCanvas = this._createFeatheredMaskFromImageData(expandedImageData, this.canvasInstance.shapeMaskFeatherValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(featheredMaskCanvas, 0, 0);
        }

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Applied shape mask with expansion: ${needsExpansion}, feather: ${needsFeather}.`);
    }

    /**
     * Removes mask in the area of the custom output area shape
     */
    removeShapeMask(): void {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            log.warn("Shape has insufficient points for mask removal");
            return;
        }

        this.canvasInstance.canvasState.saveMaskState();
        const shape = this.canvasInstance.outputAreaShape;
        const destX = -this.x;
        const destY = -this.y;
        
        this.maskCtx.save();
        this.maskCtx.globalCompositeOperation = 'destination-out';
        this.maskCtx.translate(destX, destY);
        
        this.maskCtx.beginPath();
        this.maskCtx.moveTo(shape.points[0].x, shape.points[0].y);
        for (let i = 1; i < shape.points.length; i++) {
            this.maskCtx.lineTo(shape.points[i].x, shape.points[i].y);
        }
        this.maskCtx.closePath();
        this.maskCtx.fill();
        this.maskCtx.restore();

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Removed shape mask with ${shape.points.length} points`);
    }

    private _createFeatheredMaskCanvas(points: Point[], featherRadius: number, width: number, height: number): HTMLCanvasElement {
        // 1. Create a binary mask on a temporary canvas.
        const binaryCanvas = document.createElement('canvas');
        binaryCanvas.width = width;
        binaryCanvas.height = height;
        const binaryCtx = binaryCanvas.getContext('2d', { willReadFrequently: true })!;
        
        binaryCtx.fillStyle = 'white';
        binaryCtx.beginPath();
        binaryCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            binaryCtx.lineTo(points[i].x, points[i].y);
        }
        binaryCtx.closePath();
        binaryCtx.fill();
        
        const maskImage = binaryCtx.getImageData(0, 0, width, height);
        const binaryData = new Uint8Array(width * height);
        for (let i = 0; i < binaryData.length; i++) {
            binaryData[i] = maskImage.data[i * 4] > 0 ? 1 : 0; // 1 = inside, 0 = outside
        }
        
        // 2. Calculate the fast distance transform (from ImageAnalysis.ts approach).
        const distanceMap = this._fastDistanceTransform(binaryData, width, height);

        // Find the maximum distance to normalize
        let maxDistance = 0;
        for (let i = 0; i < distanceMap.length; i++) {
            if (distanceMap[i] > maxDistance) {
                maxDistance = distanceMap[i];
            }
        }

        // 3. Create the final output canvas with the complete mask (solid + feather).
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true })!;
        const outputData = outputCtx.createImageData(width, height);

        // Use featherRadius as the threshold for the gradient
        const threshold = Math.min(featherRadius, maxDistance);

        for (let i = 0; i < distanceMap.length; i++) {
            const distance = distanceMap[i];
            const originalAlpha = maskImage.data[i * 4 + 3];
            
            if (originalAlpha === 0) {
                // Transparent pixels remain transparent
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = 0;
            } else if (distance <= threshold) {
                // Edge area - apply gradient alpha (from edge inward)
                const gradientValue = distance / threshold;
                const alphaValue = Math.floor(gradientValue * 255);
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = alphaValue;
            } else {
                // Inner area - full alpha (no blending effect)
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = 255;
            }
        }
        
        outputCtx.putImageData(outputData, 0, 0);
        return outputCanvas;
    }

    /**
     * Fast distance transform using the simple two-pass algorithm from ImageAnalysis.ts
     * Much faster than the complex Felzenszwalb algorithm
     */
    private _fastDistanceTransform(binaryMask: Uint8Array, width: number, height: number): Float32Array {
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
     * Creates an expanded mask using distance transform - much better for complex shapes
     * than the centroid-based approach. This version only does expansion without transparency calculations.
     */
    private _calculateExpandedPoints(points: Point[], expansionValue: number): Point[] {
        if (points.length < 3 || expansionValue === 0) return points;

        // For expansion, we need to create a temporary canvas to use the distance transform approach
        // This will give us much better results for complex shapes than the centroid method
        const tempCanvas = this._createExpandedMaskCanvas(points, expansionValue, this.maskCanvas.width, this.maskCanvas.height);
        
        // Extract the expanded shape outline from the canvas
        // For now, return the original points as a fallback - the real expansion happens in the canvas
        // The calling code will use the canvas directly instead of these points
        return points;
    }

    /**
     * Creates an expanded/contracted mask canvas using distance transform
     * Supports both positive values (expansion) and negative values (contraction)
     */
    private _createExpandedMaskCanvas(points: Point[], expansionValue: number, width: number, height: number): HTMLCanvasElement {
        // 1. Create a binary mask on a temporary canvas.
        const binaryCanvas = document.createElement('canvas');
        binaryCanvas.width = width;
        binaryCanvas.height = height;
        const binaryCtx = binaryCanvas.getContext('2d', { willReadFrequently: true })!;
        
        binaryCtx.fillStyle = 'white';
        binaryCtx.beginPath();
        binaryCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            binaryCtx.lineTo(points[i].x, points[i].y);
        }
        binaryCtx.closePath();
        binaryCtx.fill();
        
        const maskImage = binaryCtx.getImageData(0, 0, width, height);
        const binaryData = new Uint8Array(width * height);
        for (let i = 0; i < binaryData.length; i++) {
            binaryData[i] = maskImage.data[i * 4] > 0 ? 0 : 1; // 0 = inside, 1 = outside
        }
        
        // 2. Calculate the distance transform using the original Felzenszwalb algorithm
        const distanceMap = this._distanceTransform(binaryData, width, height);

        // 3. Create the final output canvas with the expanded/contracted mask
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true })!;
        const outputData = outputCtx.createImageData(width, height);

        const absExpansionValue = Math.abs(expansionValue);
        const isExpansion = expansionValue >= 0;

        for (let i = 0; i < distanceMap.length; i++) {
            const dist = distanceMap[i];
            let alpha = 0;
            
            if (isExpansion) {
                // Positive values: EXPANSION (rozszerzanie)
                if (dist === 0) { // Inside the original shape
                    alpha = 1.0;
                } else if (dist < absExpansionValue) { // In the expansion region
                    alpha = 1.0; // Solid expansion
                }
            } else {
                // Negative values: CONTRACTION (zmniejszanie)
                // Use distance transform but with inverted logic for contraction
                if (dist === 0) { // Inside the original shape
                    // For contraction, only keep pixels that are far enough from the edge
                    // We need to check if this pixel is more than absExpansionValue away from any edge
                    
                    // Simple approach: use the distance transform but only keep pixels
                    // that are "deep inside" the shape (far from edges)
                    // This is much faster than morphological erosion
                    
                    // Since dist=0 means we're inside, we need to calculate inward distance
                    // For now, use a simplified approach: assume pixels are kept if they're not too close to edge
                    // This is a placeholder - we'll use the distance transform result differently
                    alpha = 1.0; // We'll refine this below
                }
                
                // Actually, let's use a much simpler approach for contraction:
                // Just shrink the shape by moving all edge pixels inward by absExpansionValue
                // This is done by only keeping pixels that have distance > absExpansionValue from outside
                
                // Reset alpha and use proper contraction logic
                alpha = 0;
                if (dist === 0) { // We're inside the shape
                    // Check if we're far enough from the edge by looking at surrounding area
                    const x = i % width;
                    const y = Math.floor(i / width);
                    
                    // Check if we're near an edge by looking in the full contraction radius
                    let nearEdge = false;
                    const checkRadius = absExpansionValue + 1; // Full radius for accurate contraction
                    
                    for (let dy = -checkRadius; dy <= checkRadius && !nearEdge; dy++) {
                        for (let dx = -checkRadius; dx <= checkRadius && !nearEdge; dx++) {
                            const nx = x + dx;
                            const ny = y + dy;
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                const ni = ny * width + nx;
                                if (binaryData[ni] === 1) { // Found an outside pixel
                                    const distToEdge = Math.sqrt(dx * dx + dy * dy);
                                    if (distToEdge <= absExpansionValue) {
                                        nearEdge = true;
                                    }
                                }
                            }
                        }
                    }
                    
                    if (!nearEdge) {
                        alpha = 1.0; // Keep this pixel - it's far enough from edges
                    }
                }
            }
            
            const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
            outputData.data[i * 4 + 3] = a; // Set alpha
            // Set color to white
            outputData.data[i * 4] = 255;
            outputData.data[i * 4 + 1] = 255;
            outputData.data[i * 4 + 2] = 255;
        }
        outputCtx.putImageData(outputData, 0, 0);
        return outputCanvas;
    }

    /**
     * Original Felzenszwalb distance transform - more accurate than the fast version for expansion
     */
    private _distanceTransform(data: Uint8Array, width: number, height: number): Float32Array {
        const INF = 1e20;
        const d = new Float32Array(width * height);

        // 1. Transform along columns
        for (let x = 0; x < width; x++) {
            const f = new Float32Array(height);
            for (let y = 0; y < height; y++) {
                f[y] = data[y * width + x] === 0 ? 0 : INF;
            }
            const dt = this._edt1D(f);
            for (let y = 0; y < height; y++) {
                d[y * width + x] = dt[y];
            }
        }

        // 2. Transform along rows
        for (let y = 0; y < height; y++) {
            const f = new Float32Array(width);
            for (let x = 0; x < width; x++) {
                f[x] = d[y * width + x];
            }
            const dt = this._edt1D(f);
            for (let x = 0; x < width; x++) {
                d[y * width + x] = Math.sqrt(dt[x]); // Final Euclidean distance
            }
        }

        return d;
    }

    private _edt1D(f: Float32Array): Float32Array {
        const n = f.length;
        const d = new Float32Array(n);
        const v = new Int32Array(n);
        const z = new Float32Array(n + 1);

        let k = 0;
        v[0] = 0;
        z[0] = -Infinity;
        z[1] = Infinity;

        for (let q = 1; q < n; q++) {
            let s: number;
            do {
                const p = v[k];
                s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
            } while (s <= z[k] && --k >= 0);

            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = Infinity;
        }

        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) k++;
            const dx = q - v[k];
            d[q] = dx * dx + f[v[k]];
        }

        return d;
    }

    /**
     * Morphological erosion - similar to the Python WAS Suite implementation
     * This is much more efficient and accurate for contraction than distance transform
     */
    private _morphologicalErosion(binaryMask: Uint8Array, width: number, height: number, iterations: number): Uint8Array {
        let currentMask = new Uint8Array(binaryMask);
        let tempMask = new Uint8Array(width * height);
        
        // Apply erosion for the specified number of iterations (pixels)
        for (let iter = 0; iter < iterations; iter++) {
            // Clear temp mask
            tempMask.fill(0);
            
            // Apply erosion with a 3x3 kernel (cross pattern)
            for (let y = 1; y < height - 1; y++) {
                for (let x = 1; x < width - 1; x++) {
                    const idx = y * width + x;
                    
                    if (currentMask[idx] === 0) { // Only process pixels that are inside (0 = inside)
                        // Check if all neighbors in the cross pattern are also inside
                        const top = currentMask[(y - 1) * width + x];
                        const bottom = currentMask[(y + 1) * width + x];
                        const left = currentMask[y * width + (x - 1)];
                        const right = currentMask[y * width + (x + 1)];
                        const center = currentMask[idx];
                        
                        // Keep pixel only if all cross neighbors are inside (0)
                        if (top === 0 && bottom === 0 && left === 0 && right === 0 && center === 0) {
                            tempMask[idx] = 0; // Keep as inside
                        } else {
                            tempMask[idx] = 1; // Erode to outside
                        }
                    } else {
                        tempMask[idx] = 1; // Already outside, stay outside
                    }
                }
            }
            
            // Swap masks for next iteration
            const swap = currentMask;
            currentMask = tempMask;
            tempMask = swap;
        }
        
        return currentMask;
    }

    /**
     * Creates a feathered mask from existing ImageData (used when combining expansion + feather)
     */
    private _createFeatheredMaskFromImageData(imageData: ImageData, featherRadius: number, width: number, height: number): HTMLCanvasElement {
        const data = imageData.data;
        const binaryData = new Uint8Array(width * height);
        
        // Convert ImageData to binary mask
        for (let i = 0; i < width * height; i++) {
            binaryData[i] = data[i * 4 + 3] > 0 ? 1 : 0; // 1 = inside, 0 = outside
        }
        
        // Calculate the fast distance transform
        const distanceMap = this._fastDistanceTransform(binaryData, width, height);

        // Find the maximum distance to normalize
        let maxDistance = 0;
        for (let i = 0; i < distanceMap.length; i++) {
            if (distanceMap[i] > maxDistance) {
                maxDistance = distanceMap[i];
            }
        }

        // Create the final output canvas with feathering applied
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true })!;
        const outputData = outputCtx.createImageData(width, height);

        // Use featherRadius as the threshold for the gradient
        const threshold = Math.min(featherRadius, maxDistance);

        for (let i = 0; i < distanceMap.length; i++) {
            const distance = distanceMap[i];
            const originalAlpha = data[i * 4 + 3];
            
            if (originalAlpha === 0) {
                // Transparent pixels remain transparent
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = 0;
            } else if (distance <= threshold) {
                // Edge area - apply gradient alpha (from edge inward)
                const gradientValue = distance / threshold;
                const alphaValue = Math.floor(gradientValue * 255);
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = alphaValue;
            } else {
                // Inner area - full alpha (no blending effect)
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = 255;
            }
        }
        
        outputCtx.putImageData(outputData, 0, 0);
        return outputCanvas;
    }
}
