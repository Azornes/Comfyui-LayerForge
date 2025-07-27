import {createModuleLogger} from "./utils/LoggerUtils.js";
import { createCanvas } from "./utils/CommonUtils.js";
import type { Canvas } from './Canvas';
import type { Point, CanvasState } from './types';

const log = createModuleLogger('Mask_tool');

interface MaskToolCallbacks {
    onStateChange?: () => void;
}

interface MaskChunk {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    x: number; // World coordinates of chunk
    y: number; // World coordinates of chunk
    isDirty: boolean; // Has been modified
    isEmpty: boolean; // Contains no mask data
    isActive: boolean; // Is currently active for drawing operations
    lastAccessTime: number; // For LRU cache management
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
    
    // Chunked mask system
    private maskChunks: Map<string, MaskChunk>; // Key: "x,y" (chunk coordinates)
    private chunkSize: number;
    private activeMaskCanvas: HTMLCanvasElement; // Composite of active chunks only
    private activeMaskCtx: CanvasRenderingContext2D;
    private activeChunkBounds: { minX: number, minY: number, maxX: number, maxY: number } | null;
    
    // Active chunk management for performance
    private activeChunkRadius: number; // Radius of active chunks around drawing position (in chunks)
    private currentDrawingChunk: { x: number, y: number } | null; // Current chunk being drawn on
    private maxActiveChunks: number; // Maximum number of active chunks to prevent memory issues
    
    private onStateChange: (() => void) | null;
    private previewCanvas: HTMLCanvasElement;
    private previewCanvasInitialized: boolean;
    private previewCtx: CanvasRenderingContext2D;
    private previewVisible: boolean;
    public x: number; // Active mask canvas position
    public y: number; // Active mask canvas position
    
    // Shape mask preview system
    private shapePreviewCanvas: HTMLCanvasElement;
    private shapePreviewCtx: CanvasRenderingContext2D;
    public shapePreviewVisible: boolean;
    private isPreviewMode: boolean;

    // Performance optimization for active canvas updates
    private activeMaskNeedsUpdate: boolean;
    private activeMaskUpdateTimeout: number | null;
    private readonly ACTIVE_MASK_UPDATE_DELAY = 16; // ~60fps throttling

    // Performance optimization for shape preview
    private shapePreviewThrottleTimeout: number | null;
    private pendingPreviewParams: { expansionValue: number, featherValue: number } | null;
    private readonly SHAPE_PREVIEW_THROTTLE_DELAY = 16; // ~60fps throttling for preview

    constructor(canvasInstance: Canvas & { canvasState: CanvasState, width: number, height: number }, callbacks: MaskToolCallbacks = {}) {
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.onStateChange = callbacks.onStateChange || null;
        
        // Initialize chunked mask system
        this.maskChunks = new Map();
        this.chunkSize = 512;
        this.activeChunkBounds = null;
        
        // Initialize active chunk management
        this.activeChunkRadius = 1; // 3x3 grid of active chunks (radius 1 = 9 chunks total)
        this.currentDrawingChunk = null;
        this.maxActiveChunks = 25; // Safety limit to prevent memory issues (5x5 grid max)
        
        // Create active mask canvas (composite of chunks)
        this.activeMaskCanvas = document.createElement('canvas');
        const activeMaskCtx = this.activeMaskCanvas.getContext('2d', { willReadFrequently: true });
        if (!activeMaskCtx) {
            throw new Error("Failed to get 2D context for active mask canvas");
        }
        this.activeMaskCtx = activeMaskCtx;

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

        // Initialize shape preview system
        this.shapePreviewCanvas = document.createElement('canvas');
        const shapePreviewCtx = this.shapePreviewCanvas.getContext('2d', { willReadFrequently: true });
        if (!shapePreviewCtx) {
            throw new Error("Failed to get 2D context for shape preview canvas");
        }
        this.shapePreviewCtx = shapePreviewCtx;
        this.shapePreviewVisible = false;
        this.isPreviewMode = false;

        // Initialize performance optimization flags
        this.activeMaskNeedsUpdate = false;
        this.activeMaskUpdateTimeout = null;

        // Initialize shape preview throttling
        this.shapePreviewThrottleTimeout = null;
        this.pendingPreviewParams = null;

        this.initMaskCanvas();
    }

    // Temporary compatibility getters - will be replaced with chunked system
    get maskCanvas(): HTMLCanvasElement {
        return this.activeMaskCanvas;
    }

    get maskCtx(): CanvasRenderingContext2D {
        return this.activeMaskCtx;
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
        // Initialize chunked system
        this.chunkSize = 512;
        this.maskChunks = new Map();
        
        // Create initial active mask canvas
        this.updateActiveMaskCanvas();
        
        log.info(`Initialized chunked mask system with chunk size: ${this.chunkSize}x${this.chunkSize}`);
    }

    /**
     * Updates the active mask canvas to show ALL chunks but optimize updates during drawing
     * Always shows all chunks, but during drawing only updates the active chunks for performance
     */
    private updateActiveMaskCanvas(forceFullUpdate: boolean = false): void {
        // Always show all chunks - find bounds of all non-empty chunks
        const chunkBounds = this.getAllChunkBounds();
        
        if (!chunkBounds) {
            // No chunks with data - create minimal canvas
            this.activeMaskCanvas.width = 1;
            this.activeMaskCanvas.height = 1;
            this.x = 0;
            this.y = 0;
            this.activeChunkBounds = null;
            log.debug("No mask chunks found - created minimal active canvas");
            return;
        }
        
        // Calculate canvas size to cover ALL chunks
        const canvasLeft = chunkBounds.minX * this.chunkSize;
        const canvasTop = chunkBounds.minY * this.chunkSize;
        const canvasWidth = (chunkBounds.maxX - chunkBounds.minX + 1) * this.chunkSize;
        const canvasHeight = (chunkBounds.maxY - chunkBounds.minY + 1) * this.chunkSize;
        
        // Update active mask canvas size and position if needed
        if (this.activeMaskCanvas.width !== canvasWidth || 
            this.activeMaskCanvas.height !== canvasHeight ||
            this.x !== canvasLeft || 
            this.y !== canvasTop ||
            forceFullUpdate) {
            
            this.activeMaskCanvas.width = canvasWidth;
            this.activeMaskCanvas.height = canvasHeight;
            this.x = canvasLeft;
            this.y = canvasTop;
            this.activeChunkBounds = chunkBounds;
            
            // Full redraw when canvas size changes
            this.activeMaskCtx.clearRect(0, 0, canvasWidth, canvasHeight);
            
            // Draw ALL chunks
            for (let chunkY = chunkBounds.minY; chunkY <= chunkBounds.maxY; chunkY++) {
                for (let chunkX = chunkBounds.minX; chunkX <= chunkBounds.maxX; chunkX++) {
                    const chunkKey = `${chunkX},${chunkY}`;
                    const chunk = this.maskChunks.get(chunkKey);
                    
                    if (chunk && !chunk.isEmpty) {
                        const destX = (chunkX - chunkBounds.minX) * this.chunkSize;
                        const destY = (chunkY - chunkBounds.minY) * this.chunkSize;
                        this.activeMaskCtx.drawImage(chunk.canvas, destX, destY);
                    }
                }
            }
            
            log.debug(`Full update: rendered ${this.getAllNonEmptyChunkCount()} chunks`);
        } else {
            // Canvas size unchanged - this is handled by partial updates during drawing
            this.activeChunkBounds = chunkBounds;
        }
    }

    /**
     * Universal chunk data processing method - eliminates duplication between chunk bounds and counting operations
     * Processes chunks based on filter criteria and accumulates results using provided processor function
     */
    private _processChunks<T>(
        processor: (chunk: MaskChunk, chunkKey: string, accumulator: T) => T,
        initialValue: T,
        filter: (chunk: MaskChunk) => boolean = () => true
    ): T {
        let result = initialValue;
        for (const [chunkKey, chunk] of this.maskChunks) {
            if (filter(chunk)) {
                result = processor(chunk, chunkKey, result);
            }
        }
        return result;
    }

    /**
     * Finds the bounds of all chunks that contain mask data
     * Returns null if no chunks have data
     */
    private getAllChunkBounds(): { minX: number, minY: number, maxX: number, maxY: number } | null {
        const filter = (chunk: MaskChunk) => !chunk.isEmpty;
        const processor = (chunk: MaskChunk, chunkKey: string, bounds: { minX: number, minY: number, maxX: number, maxY: number, hasData: boolean }) => {
            const [chunkXStr, chunkYStr] = chunkKey.split(',');
            const chunkX = parseInt(chunkXStr);
            const chunkY = parseInt(chunkYStr);
            
            return {
                minX: Math.min(bounds.minX, chunkX),
                minY: Math.min(bounds.minY, chunkY),
                maxX: Math.max(bounds.maxX, chunkX),
                maxY: Math.max(bounds.maxY, chunkY),
                hasData: true
            };
        };
        
        const result = this._processChunks(processor, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hasData: false }, filter);
        return result.hasData ? { minX: result.minX, minY: result.minY, maxX: result.maxX, maxY: result.maxY } : null;
    }

    /**
     * Finds the bounds of only active chunks that contain mask data
     * Returns null if no active chunks have data
     */
    private getActiveChunkBounds(): { minX: number, minY: number, maxX: number, maxY: number } | null {
        const filter = (chunk: MaskChunk) => !chunk.isEmpty && chunk.isActive;
        const processor = (chunk: MaskChunk, chunkKey: string, bounds: { minX: number, minY: number, maxX: number, maxY: number, hasData: boolean }) => {
            const [chunkXStr, chunkYStr] = chunkKey.split(',');
            const chunkX = parseInt(chunkXStr);
            const chunkY = parseInt(chunkYStr);
            
            return {
                minX: Math.min(bounds.minX, chunkX),
                minY: Math.min(bounds.minY, chunkY),
                maxX: Math.max(bounds.maxX, chunkX),
                maxY: Math.max(bounds.maxY, chunkY),
                hasData: true
            };
        };
        
        const result = this._processChunks(processor, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hasData: false }, filter);
        return result.hasData ? { minX: result.minX, minY: result.minY, maxX: result.maxX, maxY: result.maxY } : null;
    }

    /**
     * Counts all non-empty chunks
     */
    private getAllNonEmptyChunkCount(): number {
        const filter = (chunk: MaskChunk) => !chunk.isEmpty;
        const processor = (chunk: MaskChunk, chunkKey: string, count: number) => count + 1;
        
        return this._processChunks(processor, 0, filter);
    }

    /**
     * Counts active non-empty chunks
     */
    private getActiveChunkCount(): number {
        const filter = (chunk: MaskChunk) => !chunk.isEmpty && chunk.isActive;
        const processor = (chunk: MaskChunk, chunkKey: string, count: number) => count + 1;
        
        return this._processChunks(processor, 0, filter);
    }

    /**
     * Gets extension offset for shape positioning
     */
    private getExtensionOffset(): { x: number, y: number } {
        const ext = this.canvasInstance.outputAreaExtensionEnabled ? 
            this.canvasInstance.outputAreaExtensions : 
            { top: 0, bottom: 0, left: 0, right: 0 };
        return { x: ext.left, y: ext.top };
    }

    /**
     * Calculates chunk bounds for a given area
     */
    private calculateChunkBounds(left: number, top: number, right: number, bottom: number): {
        minX: number, minY: number, maxX: number, maxY: number
    } {
        return {
            minX: Math.floor(left / this.chunkSize),
            minY: Math.floor(top / this.chunkSize),
            maxX: Math.floor(right / this.chunkSize),
            maxY: Math.floor(bottom / this.chunkSize)
        };
    }

    /**
     * Activates chunks in a specific area and surrounding chunks for visibility
     */
    private activateChunksInArea(left: number, top: number, right: number, bottom: number): number {
        // First, deactivate all chunks
        for (const chunk of this.maskChunks.values()) {
            chunk.isActive = false;
        }

        const chunkBounds = this.calculateChunkBounds(left, top, right, bottom);
        
        // Activate chunks in the area
        for (let chunkY = chunkBounds.minY; chunkY <= chunkBounds.maxY; chunkY++) {
            for (let chunkX = chunkBounds.minX; chunkX <= chunkBounds.maxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                chunk.isActive = true;
                chunk.lastAccessTime = Date.now();
            }
        }
        
        // Also activate surrounding chunks for better visibility (3x3 grid around area)
        const centerChunkX = Math.floor((left + right) / 2 / this.chunkSize);
        const centerChunkY = Math.floor((top + bottom) / 2 / this.chunkSize);
        
        for (let dy = -this.activeChunkRadius; dy <= this.activeChunkRadius; dy++) {
            for (let dx = -this.activeChunkRadius; dx <= this.activeChunkRadius; dx++) {
                const chunkX = centerChunkX + dx;
                const chunkY = centerChunkY + dy;
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                chunk.isActive = true;
                chunk.lastAccessTime = Date.now();
            }
        }

        return Array.from(this.maskChunks.values()).filter(chunk => chunk.isActive).length;
    }

    /**
     * Calculates intersection between a chunk and a rectangular area
     * Returns null if no intersection exists
     */
    private calculateChunkIntersection(chunk: MaskChunk, areaLeft: number, areaTop: number, areaRight: number, areaBottom: number): {
        intersectLeft: number, intersectTop: number, intersectRight: number, intersectBottom: number,
        srcX: number, srcY: number, srcWidth: number, srcHeight: number,
        destX: number, destY: number, destWidth: number, destHeight: number
    } | null {
        const chunkLeft = chunk.x;
        const chunkTop = chunk.y;
        const chunkRight = chunk.x + this.chunkSize;
        const chunkBottom = chunk.y + this.chunkSize;
        
        // Find intersection
        const intersectLeft = Math.max(chunkLeft, areaLeft);
        const intersectTop = Math.max(chunkTop, areaTop);
        const intersectRight = Math.min(chunkRight, areaRight);
        const intersectBottom = Math.min(chunkBottom, areaBottom);
        
        // Check if there's actually an intersection
        if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
            return null; // No intersection
        }
        
        // Calculate source coordinates (relative to area)
        const srcX = intersectLeft - areaLeft;
        const srcY = intersectTop - areaTop;
        const srcWidth = intersectRight - intersectLeft;
        const srcHeight = intersectBottom - intersectTop;
        
        // Calculate destination coordinates (relative to chunk)
        const destX = intersectLeft - chunkLeft;
        const destY = intersectTop - chunkTop;
        const destWidth = srcWidth;
        const destHeight = srcHeight;
        
        return {
            intersectLeft, intersectTop, intersectRight, intersectBottom,
            srcX, srcY, srcWidth, srcHeight,
            destX, destY, destWidth, destHeight
        };
    }

    /**
     * Checks if a chunk is empty by examining its pixel data
     * Updates the chunk's isEmpty flag
     */
    private updateChunkEmptyStatus(chunk: MaskChunk): void {
        const imageData = chunk.ctx.getImageData(0, 0, this.chunkSize, this.chunkSize);
        const data = imageData.data;
        let hasData = false;
        
        // Check alpha channel for any non-zero values
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) {
                hasData = true;
                break;
            }
        }
        
        chunk.isEmpty = !hasData;
        chunk.isDirty = true;
    }

    /**
     * Marks chunk as dirty and not empty after drawing operations
     */
    private markChunkAsModified(chunk: MaskChunk): void {
        chunk.isDirty = true;
        chunk.isEmpty = false;
    }

    /**
     * Logs chunk operation with standardized format
     */
    private logChunkOperation(operation: string, chunk: MaskChunk, intersection: { destX: number, destY: number }): void {
        const chunkCoordX = Math.floor(chunk.x / this.chunkSize);
        const chunkCoordY = Math.floor(chunk.y / this.chunkSize);
        log.debug(`${operation} chunk (${chunkCoordX}, ${chunkCoordY}) at local position (${intersection.destX}, ${intersection.destY})`);
    }

    /**
     * Universal chunk operation method - eliminates duplication between chunk operations
     * Handles intersection calculation, drawing, and post-processing for all chunk operations
     */
    private performChunkOperation(
        chunk: MaskChunk, 
        source: HTMLImageElement | HTMLCanvasElement, 
        sourceArea: { left: number, top: number, right: number, bottom: number },
        operation: 'add' | 'apply' | 'remove',
        operationName: string
    ): void {
        const intersection = this.calculateChunkIntersection(chunk, sourceArea.left, sourceArea.top, sourceArea.right, sourceArea.bottom);
        if (!intersection) {
            return; // No intersection
        }
        
        // Set composition mode based on operation
        if (operation === 'remove') {
            chunk.ctx.globalCompositeOperation = 'destination-out';
        } else {
            chunk.ctx.globalCompositeOperation = 'source-over';
        }
        
        // Draw the source portion onto this chunk
        chunk.ctx.drawImage(
            source,
            intersection.srcX, intersection.srcY, intersection.srcWidth, intersection.srcHeight,  // Source rectangle
            intersection.destX, intersection.destY, intersection.destWidth, intersection.destHeight // Destination rectangle
        );
        
        // Restore normal composition mode if it was changed
        if (operation === 'remove') {
            chunk.ctx.globalCompositeOperation = 'source-over';
        }
        
        // Update chunk status based on operation
        if (operation === 'remove') {
            this.updateChunkEmptyStatus(chunk);
        } else {
            this.markChunkAsModified(chunk);
        }
        
        // Log the operation
        this.logChunkOperation(operationName, chunk, intersection);
    }

    /**
     * Triggers state change callback and renders canvas
     */
    private triggerStateChangeAndRender(): void {
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
    }

    /**
     * Saves mask state if tool is active
     */
    private saveMaskStateIfActive(): void {
        if (this.isActive) {
            this.canvasInstance.canvasState.saveMaskState();
        }
    }

    /**
     * Saves mask state, triggers state change and renders
     */
    private completeMaskOperation(saveState: boolean = true): void {
        if (saveState) {
            this.canvasInstance.canvasState.saveMaskState();
        }
        this.triggerStateChangeAndRender();
    }

    /**
     * Creates a canvas with specified dimensions and returns both canvas and context
     */
    private createCanvas(width: number, height: number): { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D } {
        const { canvas, ctx } = createCanvas(width, height, '2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error("Failed to get 2D context for canvas");
        }
        return { canvas, ctx };
    }

    /**
     * Draws shape points on a canvas context
     */
    private drawShapeOnCanvas(ctx: CanvasRenderingContext2D, points: Point[], fillRule: CanvasFillRule = 'evenodd'): void {
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.fill(fillRule);
    }

    /**
     * Creates binary mask data from shape points
     */
    private createBinaryMaskFromShape(points: Point[], width: number, height: number): Uint8Array {
        const { canvas, ctx } = this.createCanvas(width, height);
        this.drawShapeOnCanvas(ctx, points);
        
        const maskImage = ctx.getImageData(0, 0, width, height);
        const binaryData = new Uint8Array(width * height);
        for (let i = 0; i < binaryData.length; i++) {
            binaryData[i] = maskImage.data[i * 4] > 0 ? 1 : 0;
        }
        return binaryData;
    }

    /**
     * Creates output canvas with image data
     */
    private createOutputCanvasFromImageData(imageData: ImageData, width: number, height: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createCanvas(width, height);
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    /**
     * Creates output canvas from processed pixel data
     */
    private createOutputCanvasFromPixelData(pixelProcessor: (outputData: ImageData) => void, width: number, height: number): HTMLCanvasElement {
        const { canvas, ctx } = this.createCanvas(width, height);
        const outputData = ctx.createImageData(width, height);
        pixelProcessor(outputData);
        ctx.putImageData(outputData, 0, 0);
        return canvas;
    }

    /**
     * Draws contour points on a canvas context with stroke
     */
    private drawContourOnCanvas(ctx: CanvasRenderingContext2D, points: Point[]): void {
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.stroke();
    }

    /**
     * Draws multiple contours on a canvas context for preview
     */
    private drawContoursForPreview(ctx: CanvasRenderingContext2D, contours: Point[][], strokeStyle: string, lineWidth: number, lineDash: number[], globalAlpha: number): void {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(lineDash);
        ctx.globalAlpha = globalAlpha;

        for (const contour of contours) {
            this.drawContourOnCanvas(ctx, contour);
        }
    }

    /**
     * Applies feather effect to distance map and creates ImageData
     */
    private applyFeatherToDistanceMap(distanceMap: Float32Array, binaryData: Uint8Array, featherRadius: number, width: number, height: number): ImageData {
        // Find the maximum distance to normalize
        let maxDistance = 0;
        for (let i = 0; i < distanceMap.length; i++) {
            if (distanceMap[i] > maxDistance) {
                maxDistance = distanceMap[i];
            }
        }

        // Create ImageData with feather effect
        const { canvas: tempCanvas, ctx: tempCtx } = this.createCanvas(width, height);
        const outputData = tempCtx.createImageData(width, height);

        // Use featherRadius as the threshold for the gradient
        const threshold = Math.min(featherRadius, maxDistance);

        for (let i = 0; i < distanceMap.length; i++) {
            const distance = distanceMap[i];
            const isInside = binaryData[i] === 1;
            
            if (!isInside) {
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

        return outputData;
    }

    /**
     * Creates feathered mask canvas from binary data - unified logic for feathering
     * This eliminates duplication between _createFeatheredMaskCanvas and _createFeatheredMaskFromImageData
     */
    private createFeatheredMaskFromBinaryData(binaryData: Uint8Array, featherRadius: number, width: number, height: number): HTMLCanvasElement {
        // Calculate the fast distance transform
        const distanceMap = this._fastDistanceTransform(binaryData, width, height);

        // Find the maximum distance to normalize
        let maxDistance = 0;
        for (let i = 0; i < distanceMap.length; i++) {
            if (distanceMap[i] > maxDistance) {
                maxDistance = distanceMap[i];
            }
        }

        // Create the final output canvas with feather effect
        const featherImageData = this.applyFeatherToDistanceMap(distanceMap, binaryData, featherRadius, width, height);
        return this.createOutputCanvasFromImageData(featherImageData, width, height);
    }

    /**
     * Prepares shape mask configuration data - eliminates duplication between applyShapeMask and removeShapeMask
     * Returns all necessary data for shape mask operations including world coordinates and temporary canvas setup
     * Now uses precise expansion calculation based on actual user values
     */
    private prepareShapeMaskConfiguration(): {
        shape: any,
        bounds: any,
        extensionOffset: { x: number, y: number },
        worldShapePoints: Point[],
        maxExpansion: number,
        tempCanvasWidth: number,
        tempCanvasHeight: number,
        tempOffsetX: number,
        tempOffsetY: number,
        tempShapePoints: Point[]
    } | null {
        // Validate shape
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            return null;
        }

        const shape = this.canvasInstance.outputAreaShape;
        const bounds = this.canvasInstance.outputAreaBounds;

        // Calculate shape points in world coordinates accounting for extensions
        const extensionOffset = this.getExtensionOffset();
        
        const worldShapePoints = shape.points.map(p => ({ 
            x: bounds.x + extensionOffset.x + p.x, 
            y: bounds.y + extensionOffset.y + p.y 
        }));

        // Use precise expansion calculation - only actual user value + small safety margin
        const userExpansionValue = Math.abs(this.canvasInstance.shapeMaskExpansionValue || 0);
        const safetyMargin = 10; // Small safety margin for precise operations
        const preciseExpansion = userExpansionValue + safetyMargin;
        
        const tempCanvasWidth = bounds.width + (preciseExpansion * 2);
        const tempCanvasHeight = bounds.height + (preciseExpansion * 2);
        const tempOffsetX = preciseExpansion;
        const tempOffsetY = preciseExpansion;

        // Adjust shape points for the temporary canvas
        const tempShapePoints = worldShapePoints.map(p => ({
            x: p.x - bounds.x + tempOffsetX,
            y: p.y - bounds.y + tempOffsetY
        }));

        return {
            shape,
            bounds,
            extensionOffset,
            worldShapePoints,
            maxExpansion: preciseExpansion,
            tempCanvasWidth,
            tempCanvasHeight,
            tempOffsetX,
            tempOffsetY,
            tempShapePoints
        };
    }

    /**
     * Updates which chunks are active for drawing operations based on current drawing position
     * Only activates chunks in a radius around the drawing position for performance
     */
    private updateActiveChunksForDrawing(worldCoords: Point): void {
        const currentChunkX = Math.floor(worldCoords.x / this.chunkSize);
        const currentChunkY = Math.floor(worldCoords.y / this.chunkSize);
        
        // Update current drawing chunk
        this.currentDrawingChunk = { x: currentChunkX, y: currentChunkY };
        
        // Deactivate all chunks first
        for (const chunk of this.maskChunks.values()) {
            chunk.isActive = false;
        }
        
        // Activate chunks in radius around current drawing position
        let activatedCount = 0;
        for (let dy = -this.activeChunkRadius; dy <= this.activeChunkRadius; dy++) {
            for (let dx = -this.activeChunkRadius; dx <= this.activeChunkRadius; dx++) {
                const chunkX = currentChunkX + dx;
                const chunkY = currentChunkY + dy;
                const chunkKey = `${chunkX},${chunkY}`;
                
                // Get or create chunk if it doesn't exist
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                chunk.isActive = true;
                chunk.lastAccessTime = Date.now();
                activatedCount++;
                
                // Safety check to prevent too many active chunks
                if (activatedCount >= this.maxActiveChunks) {
                    log.warn(`Reached maximum active chunks limit (${this.maxActiveChunks})`);
                    return;
                }
            }
        }
        
        log.debug(`Activated ${activatedCount} chunks around drawing position (${currentChunkX}, ${currentChunkY})`);
    }

    /**
     * Gets or creates a chunk for the given world coordinates
     */
    private getChunkForPosition(worldX: number, worldY: number): MaskChunk {
        const chunkX = Math.floor(worldX / this.chunkSize);
        const chunkY = Math.floor(worldY / this.chunkSize);
        const chunkKey = `${chunkX},${chunkY}`;
        
        let chunk = this.maskChunks.get(chunkKey);
        if (!chunk) {
            chunk = this.createChunk(chunkX, chunkY);
            this.maskChunks.set(chunkKey, chunk);
        }
        
        return chunk;
    }

    /**
     * Creates a new chunk at the given chunk coordinates
     */
    private createChunk(chunkX: number, chunkY: number): MaskChunk {
        const { canvas, ctx } = this.createCanvas(this.chunkSize, this.chunkSize);
        
        const chunk: MaskChunk = {
            canvas,
            ctx,
            x: chunkX * this.chunkSize,
            y: chunkY * this.chunkSize,
            isDirty: false,
            isEmpty: true,
            isActive: false,
            lastAccessTime: Date.now()
        };
        
        log.debug(`Created chunk at (${chunkX}, ${chunkY}) covering world area (${chunk.x}, ${chunk.y}) to (${chunk.x + this.chunkSize}, ${chunk.y + this.chunkSize})`);
        return chunk;
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
        
        // Activate chunks around the drawing position for performance
        this.updateActiveChunksForDrawing(worldCoords);
        
        this.draw(worldCoords);
        this.clearPreview();
    }

    handleMouseMove(worldCoords: Point, viewCoords: Point): void {
        if (this.isActive) {
            this.drawBrushPreview(viewCoords);
        }
        if (!this.isActive || !this.isDrawing) return;
        
        // Dynamically update active chunks as user moves while drawing
        this.updateActiveChunksForDrawing(worldCoords);
        
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
            this.currentDrawingChunk = null;
            
            // After drawing is complete, update active canvas to show all chunks
            this.updateActiveMaskCanvas(true); // forceShowAll = true
            
            this.completeMaskOperation();
            this.drawBrushPreview(viewCoords);
        }
    }

    draw(worldCoords: Point): void {
        if (!this.lastPosition) {
            this.lastPosition = worldCoords;
        }

        // Draw on chunks instead of single canvas
        this.drawOnChunks(this.lastPosition, worldCoords);
        
        // Only update active canvas if we drew on chunks that are currently visible
        // This prevents unnecessary recomposition during drawing
        this.updateActiveCanvasIfNeeded(this.lastPosition, worldCoords);
    }

    /**
     * Draws a line between two world coordinates on the appropriate chunks
     */
    private drawOnChunks(startWorld: Point, endWorld: Point): void {
        // Calculate all chunks that this line might touch
        const minX = Math.min(startWorld.x, endWorld.x) - this.brushSize;
        const maxX = Math.max(startWorld.x, endWorld.x) + this.brushSize;
        const minY = Math.min(startWorld.y, endWorld.y) - this.brushSize;
        const maxY = Math.max(startWorld.y, endWorld.y) + this.brushSize;
        
        const chunkMinX = Math.floor(minX / this.chunkSize);
        const chunkMinY = Math.floor(minY / this.chunkSize);
        const chunkMaxX = Math.floor(maxX / this.chunkSize);
        const chunkMaxY = Math.floor(maxY / this.chunkSize);
        
        // Draw on all affected chunks
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                this.drawLineOnChunk(chunk, startWorld, endWorld);
            }
        }
    }

    /**
     * Draws a line on a specific chunk
     */
    private drawLineOnChunk(chunk: MaskChunk, startWorld: Point, endWorld: Point): void {
        // Convert world coordinates to chunk-local coordinates
        const startLocal = {
            x: startWorld.x - chunk.x,
            y: startWorld.y - chunk.y
        };
        const endLocal = {
            x: endWorld.x - chunk.x,
            y: endWorld.y - chunk.y
        };
        
        // Check if the line intersects this chunk
        if (!this.lineIntersectsChunk(startLocal, endLocal, this.chunkSize)) {
            return;
        }
        
        // Draw the line on this chunk
        chunk.ctx.beginPath();
        chunk.ctx.moveTo(startLocal.x, startLocal.y);
        chunk.ctx.lineTo(endLocal.x, endLocal.y);
        
        const gradientRadius = this.brushSize / 2;
        
        if (this.brushHardness === 1) {
            chunk.ctx.strokeStyle = `rgba(255, 255, 255, ${this.brushStrength})`;
        } else {
            const innerRadius = gradientRadius * this.brushHardness;
            const gradient = chunk.ctx.createRadialGradient(
                endLocal.x, endLocal.y, innerRadius,
                endLocal.x, endLocal.y, gradientRadius
            );
            gradient.addColorStop(0, `rgba(255, 255, 255, ${this.brushStrength})`);
            gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
            chunk.ctx.strokeStyle = gradient;
        }
        
        chunk.ctx.lineWidth = this.brushSize;
        chunk.ctx.lineCap = 'round';
        chunk.ctx.lineJoin = 'round';
        chunk.ctx.globalCompositeOperation = 'source-over';
        chunk.ctx.stroke();
        
        // Mark chunk as dirty and not empty
        this.markChunkAsModified(chunk);
        
        log.debug(`Drew on chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)})`);
    }

    /**
     * Checks if a line intersects with a chunk bounds
     */
    private lineIntersectsChunk(startLocal: Point, endLocal: Point, chunkSize: number): boolean {
        // Expand bounds by brush size to catch partial intersections
        const margin = this.brushSize / 2;
        const left = -margin;
        const top = -margin;
        const right = chunkSize + margin;
        const bottom = chunkSize + margin;
        
        // Check if either point is inside the expanded bounds
        if ((startLocal.x >= left && startLocal.x <= right && startLocal.y >= top && startLocal.y <= bottom) ||
            (endLocal.x >= left && endLocal.x <= right && endLocal.y >= top && endLocal.y <= bottom)) {
            return true;
        }
        
        // Check if line crosses chunk bounds (simplified check)
        return true; // For now, always draw - more precise intersection can be added later
    }

    /**
     * Updates active canvas when drawing affects chunks with throttling to prevent lag
     * During drawing, only updates the affected active chunks for performance
     */
    private updateActiveCanvasIfNeeded(startWorld: Point, endWorld: Point): void {
        // Calculate which chunks were affected by this drawing operation
        const minX = Math.min(startWorld.x, endWorld.x) - this.brushSize;
        const maxX = Math.max(startWorld.x, endWorld.x) + this.brushSize;
        const minY = Math.min(startWorld.y, endWorld.y) - this.brushSize;
        const maxY = Math.max(startWorld.y, endWorld.y) + this.brushSize;
        
        const affectedChunkMinX = Math.floor(minX / this.chunkSize);
        const affectedChunkMinY = Math.floor(minY / this.chunkSize);
        const affectedChunkMaxX = Math.floor(maxX / this.chunkSize);
        const affectedChunkMaxY = Math.floor(maxY / this.chunkSize);

        // During drawing, only update affected chunks that are active for performance
        if (this.isDrawing) {
            // Use throttled partial update for active chunks only
            this.scheduleThrottledActiveMaskUpdate(affectedChunkMinX, affectedChunkMinY, affectedChunkMaxX, affectedChunkMaxY);
        } else {
            // Not drawing - do full update to show all chunks
            this.updateActiveMaskCanvas(true);
        }
    }

    /**
     * Schedules a throttled update of the active mask canvas to prevent excessive redraws
     * Only updates at most once per ACTIVE_MASK_UPDATE_DELAY milliseconds
     */
    private scheduleThrottledActiveMaskUpdate(chunkMinX: number, chunkMinY: number, chunkMaxX: number, chunkMaxY: number): void {
        // Mark that an update is needed
        this.activeMaskNeedsUpdate = true;

        // If there's already a pending update, don't schedule another one
        if (this.activeMaskUpdateTimeout !== null) {
            return;
        }

        // Schedule the update with throttling
        this.activeMaskUpdateTimeout = window.setTimeout(() => {
            if (this.activeMaskNeedsUpdate) {
                // Perform partial update for the affected chunks
                this.updateActiveCanvasPartial(chunkMinX, chunkMinY, chunkMaxX, chunkMaxY);
                this.activeMaskNeedsUpdate = false;
                log.debug("Performed throttled partial active canvas update");
            }
            this.activeMaskUpdateTimeout = null;
        }, this.ACTIVE_MASK_UPDATE_DELAY);
    }

    /**
     * Partially updates the active canvas by redrawing only specific chunks that are active
     * During drawing, only updates active chunks for performance
     * Now handles dynamic chunk activation by expanding canvas if needed
     */
    private updateActiveCanvasPartial(chunkMinX: number, chunkMinY: number, chunkMaxX: number, chunkMaxY: number): void {
        // Check if any active chunks are outside current canvas bounds
        const activeChunkBounds = this.getActiveChunkBounds();
        const allChunkBounds = this.getAllChunkBounds();
        
        if (!allChunkBounds) {
            return; // No chunks at all
        }
        
        // If active chunks extend beyond current canvas, do full update to resize canvas
        if (activeChunkBounds && this.activeChunkBounds && 
            (activeChunkBounds.minX < this.activeChunkBounds.minX ||
             activeChunkBounds.maxX > this.activeChunkBounds.maxX ||
             activeChunkBounds.minY < this.activeChunkBounds.minY ||
             activeChunkBounds.maxY > this.activeChunkBounds.maxY)) {
            
            log.debug("Active chunks extended beyond canvas bounds - performing full update");
            this.updateActiveMaskCanvas(true);
            return;
        }
        
        if (!this.activeChunkBounds) {
            // No active bounds - do full update
            this.updateActiveMaskCanvas();
            return;
        }

        // Only redraw the affected chunks that are active and within the current active canvas bounds
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                // Check if this chunk is within canvas bounds (all chunks with data)
                if (chunkX >= this.activeChunkBounds.minX && chunkX <= this.activeChunkBounds.maxX &&
                    chunkY >= this.activeChunkBounds.minY && chunkY <= this.activeChunkBounds.maxY) {
                    
                    const chunkKey = `${chunkX},${chunkY}`;
                    const chunk = this.maskChunks.get(chunkKey);
                    
                    // Update if chunk exists and is currently active (regardless of isEmpty for new chunks)
                    if (chunk && chunk.isActive) {
                        // Calculate position on active canvas (relative to all chunks bounds)
                        const destX = (chunkX - this.activeChunkBounds.minX) * this.chunkSize;
                        const destY = (chunkY - this.activeChunkBounds.minY) * this.chunkSize;
                        
                        // Clear the area first, then redraw
                        this.activeMaskCtx.clearRect(destX, destY, this.chunkSize, this.chunkSize);
                        if (!chunk.isEmpty) {
                            this.activeMaskCtx.drawImage(chunk.canvas, destX, destY);
                        }
                        
                        log.debug(`Partial update: refreshed active chunk (${chunkX}, ${chunkY}) - isEmpty: ${chunk.isEmpty}`);
                    }
                }
            }
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
        this.clearShapePreview();
    }

    /**
     * Initialize shape preview canvas for showing blue outline during slider adjustments
     * Canvas is pinned to viewport and covers the entire visible area
     */
    initShapePreviewCanvas(): void {
        if (this.shapePreviewCanvas.parentElement) {
            this.shapePreviewCanvas.parentElement.removeChild(this.shapePreviewCanvas);
        }
        
        // Canvas covers entire viewport - pinned to screen, not world
        this.shapePreviewCanvas.width = this.canvasInstance.canvas.width;
        this.shapePreviewCanvas.height = this.canvasInstance.canvas.height;
        
        // Pin canvas to viewport - no world coordinate positioning
        this.shapePreviewCanvas.style.position = 'absolute';
        this.shapePreviewCanvas.style.left = '0px';
        this.shapePreviewCanvas.style.top = '0px';
        this.shapePreviewCanvas.style.width = '100%';
        this.shapePreviewCanvas.style.height = '100%';
        this.shapePreviewCanvas.style.pointerEvents = 'none';
        this.shapePreviewCanvas.style.zIndex = '15'; // Above regular preview
        this.shapePreviewCanvas.style.imageRendering = 'pixelated'; // Sharp rendering
        
        if (this.canvasInstance.canvas.parentElement) {
            this.canvasInstance.canvas.parentElement.appendChild(this.shapePreviewCanvas);
        }
    }

    /**
     * Show blue outline preview of expansion/contraction during slider adjustment
     */
    showShapePreview(expansionValue: number, featherValue: number = 0): void {
        // Store the parameters for throttled execution
        this.pendingPreviewParams = { expansionValue, featherValue };

        // If there's already a pending preview update, don't schedule another one
        if (this.shapePreviewThrottleTimeout !== null) {
            return;
        }

        // Schedule the preview update with throttling
        this.shapePreviewThrottleTimeout = window.setTimeout(() => {
            if (this.pendingPreviewParams) {
                this.executeShapePreview(this.pendingPreviewParams.expansionValue, this.pendingPreviewParams.featherValue);
                this.pendingPreviewParams = null;
            }
            this.shapePreviewThrottleTimeout = null;
        }, this.SHAPE_PREVIEW_THROTTLE_DELAY);
    }

    /**
     * Executes the actual shape preview rendering - separated from showShapePreview for throttling
     */
    private executeShapePreview(expansionValue: number, featherValue: number = 0): void {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            return;
        }

        if (!this.shapePreviewCanvas.parentElement) this.initShapePreviewCanvas();

        this.isPreviewMode = true;
        this.shapePreviewVisible = true;
        this.shapePreviewCanvas.style.display = 'block';
        this.clearShapePreview();

        const shape = this.canvasInstance.outputAreaShape;
        const viewport = this.canvasInstance.viewport;
        const bounds = this.canvasInstance.outputAreaBounds;

        // Convert shape points to world coordinates first accounting for extensions
        const extensionOffset = this.getExtensionOffset();
        
        const worldShapePoints = shape.points.map(p => ({
            x: bounds.x + extensionOffset.x + p.x,
            y: bounds.y + extensionOffset.y + p.y
        }));

        // Then convert world coordinates to screen coordinates
        const screenPoints = worldShapePoints.map(p => ({
            x: (p.x - viewport.x) * viewport.zoom,
            y: (p.y - viewport.y) * viewport.zoom
        }));
        
        // This function now returns Point[][] to handle islands.
        const allContours = this._calculatePreviewPointsScreen([screenPoints], expansionValue, viewport.zoom);

        // Draw main expansion/contraction preview
        this.drawContoursForPreview(this.shapePreviewCtx, allContours, '#4A9EFF', 2, [4, 4], 0.8);

        // Draw feather preview
        if (featherValue > 0) {
            const allFeatherContours = this._calculatePreviewPointsScreen(allContours, -featherValue, viewport.zoom);
            this.drawContoursForPreview(this.shapePreviewCtx, allFeatherContours, '#4A9EFF', 1, [3, 5], 0.6);
        }

        log.debug(`Shape preview executed with expansion: ${expansionValue}px, feather: ${featherValue}px at bounds (${bounds.x}, ${bounds.y})`);
    }

    /**
     * Hide shape preview and switch back to normal mode
     */
    hideShapePreview(): void {
        this.isPreviewMode = false;
        this.shapePreviewVisible = false;
        this.clearShapePreview();
        this.shapePreviewCanvas.style.display = 'none';
        log.debug("Shape preview hidden");
    }

    /**
     * Clear shape preview canvas
     */
    clearShapePreview(): void {
        if (this.shapePreviewCtx) {
            this.shapePreviewCtx.clearRect(0, 0, this.shapePreviewCanvas.width, this.shapePreviewCanvas.height);
        }
    }

    /**
     * Update shape preview canvas position and scale when viewport changes
     * This ensures the preview stays synchronized with the world coordinates
     */
    updateShapePreviewPosition(): void {
        if (!this.shapePreviewCanvas.parentElement || !this.shapePreviewVisible) {
            return;
        }

        const viewport = this.canvasInstance.viewport;
        const bufferSize = 300;
        
        // Calculate world position (output area + buffer)
        const previewX = -bufferSize; // World coordinates
        const previewY = -bufferSize;
        
        // Convert to screen coordinates
        const screenX = (previewX - viewport.x) * viewport.zoom;
        const screenY = (previewY - viewport.y) * viewport.zoom;
        
        // Update position and scale
        this.shapePreviewCanvas.style.left = `${screenX}px`;
        this.shapePreviewCanvas.style.top = `${screenY}px`;
        
        const previewWidth = this.canvasInstance.width + (bufferSize * 2);
        const previewHeight = this.canvasInstance.height + (bufferSize * 2);
        this.shapePreviewCanvas.style.width = `${previewWidth * viewport.zoom}px`;
        this.shapePreviewCanvas.style.height = `${previewHeight * viewport.zoom}px`;
    }

    /**
     * Universal morphological operation using Distance Transform + thresholding
     * Combines dilation and erosion into one optimized function
     */
    private _fastMorphologyDT(mask: Uint8Array, width: number, height: number, radius: number, isDilation: boolean): Uint8Array {
        const INF = 1e9;
        const dist = new Float32Array(width * height);

        // 1. Initialize based on operation type
        for (let i = 0; i < width * height; ++i) {
            if (isDilation) {
                // Dilation: 0 for foreground, INF for background
                dist[i] = mask[i] ? 0 : INF;
            } else {
                // Erosion: 0 for background, INF for foreground
                dist[i] = mask[i] ? INF : 0;
            }
        }

        // 2. Forward pass: top-left -> bottom-right
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const i = y * width + x;
                // Skip condition based on operation type
                if (isDilation ? mask[i] : !mask[i]) continue;
                
                if (x > 0) dist[i] = Math.min(dist[i], dist[y * width + (x - 1)] + 1);
                if (y > 0) dist[i] = Math.min(dist[i], dist[(y - 1) * width + x] + 1);
            }
        }

        // 3. Backward pass: bottom-right -> top-left
        for (let y = height - 1; y >= 0; --y) {
            for (let x = width - 1; x >= 0; --x) {
                const i = y * width + x;
                // Skip condition based on operation type
                if (isDilation ? mask[i] : !mask[i]) continue;
                
                if (x < width - 1) dist[i] = Math.min(dist[i], dist[y * width + (x + 1)] + 1);
                if (y < height - 1) dist[i] = Math.min(dist[i], dist[(y + 1) * width + x] + 1);
            }
        }

        // 4. Thresholding based on operation type
        const result = new Uint8Array(width * height);
        for (let i = 0; i < width * height; ++i) {
            if (isDilation) {
                // Dilation: if distance <= radius, it's part of the expanded mask
                result[i] = dist[i] <= radius ? 1 : 0;
            } else {
                // Erosion: if distance > radius, it's part of the eroded mask
                result[i] = dist[i] > radius ? 1 : 0;
            }
        }
        return result;
    }

    /**
     * Fast dilation using unified morphology function
     */
    private _fastDilateDT(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
        return this._fastMorphologyDT(mask, width, height, radius, true);
    }

    /**
     * Fast erosion using unified morphology function
     */
    private _fastErodeDT(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
        return this._fastMorphologyDT(mask, width, height, radius, false);
    }

    /**
     * Calculate preview points using screen coordinates for pinned canvas.
     * This version now accepts multiple contours and returns multiple contours.
     */
    private _calculatePreviewPointsScreen(contours: Point[][], expansionValue: number, zoom: number): Point[][] {
        if (contours.length === 0 || expansionValue === 0) return contours;

        const width = this.canvasInstance.canvas.width;
        const height = this.canvasInstance.canvas.height;
        
        const { canvas: tempCanvas, ctx: tempCtx } = this.createCanvas(width, height);
        
        // Draw all contours to create the initial mask
        tempCtx.fillStyle = 'white';
        for (const points of contours) {
            if (points.length < 3) continue;
            tempCtx.beginPath();
            tempCtx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                tempCtx.lineTo(points[i].x, points[i].y);
            }
            tempCtx.closePath();
            tempCtx.fill('evenodd'); // Use evenodd to handle holes correctly
        }
        
        const maskImage = tempCtx.getImageData(0, 0, width, height);
        const binaryData = new Uint8Array(width * height);
        for (let i = 0; i < binaryData.length; i++) {
            binaryData[i] = maskImage.data[i * 4] > 0 ? 1 : 0;
        }
        
        let resultMask: Uint8Array;
        const scaledExpansionValue = Math.round(Math.abs(expansionValue * zoom));
        
        if (expansionValue >= 0) {
            resultMask = this._fastDilateDT(binaryData, width, height, scaledExpansionValue);
        } else {
            resultMask = this._fastErodeDT(binaryData, width, height, scaledExpansionValue);
        }
        
        // Extract all contours (outer and inner) from the resulting mask
        const allResultContours = this._traceAllContours(resultMask, width, height);
        
        return allResultContours.length > 0 ? allResultContours : contours;
    }

    /**
     * Calculate preview points in world coordinates using morphological operations
     * This version works directly with mask canvas coordinates
     */


    /**
     * Traces all contours (outer and inner islands) from a binary mask.
     * @returns An array of contours, where each contour is an array of points.
     */
    private _traceAllContours(mask: Uint8Array, width: number, height: number): Point[][] {
        const contours: Point[][] = [];
        const visited = new Uint8Array(mask.length); // Keep track of visited pixels

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                
                // Check for a potential starting point: a foreground pixel that hasn't been visited
                // and is on a boundary (next to a background pixel).
                if (mask[idx] === 1 && visited[idx] === 0) {
                    // Check if it's a boundary pixel
                    const isBoundary = 
                        mask[idx - 1] === 0 || 
                        mask[idx + 1] === 0 || 
                        mask[idx - width] === 0 || 
                        mask[idx + width] === 0;

                    if (isBoundary) {
                        // Found a new contour, let's trace it.
                        const contour = this._traceSingleContour({x, y}, mask, width, height, visited);
                        if (contour.length > 2) {
                            // --- Path Simplification ---
                            const simplifiedContour: Point[] = [];
                            const simplificationFactor = Math.max(1, Math.floor(contour.length / 200));
                            for (let i = 0; i < contour.length; i += simplificationFactor) {
                                simplifiedContour.push(contour[i]);
                            }
                            contours.push(simplifiedContour);
                        }
                    }
                }
            }
        }
        return contours;
    }

    /**
     * Traces a single contour from a starting point using Moore-Neighbor algorithm.
     */
    private _traceSingleContour(startPoint: Point, mask: Uint8Array, width: number, height: number, visited: Uint8Array): Point[] {
        const contour: Point[] = [];
        let { x, y } = startPoint;

        // Neighbor checking order (clockwise)
        const neighbors = [
            { dx: 0, dy: -1 }, // N
            { dx: 1, dy: -1 }, // NE
            { dx: 1, dy: 0 },  // E
            { dx: 1, dy: 1 },  // SE
            { dx: 0, dy: 1 },  // S
            { dx: -1, dy: 1 }, // SW
            { dx: -1, dy: 0 }, // W
            { dx: -1, dy: -1 } // NW
        ];
        
        let initialNeighborIndex = 0;

        do {
            let foundNext = false;
            for (let i = 0; i < 8; i++) {
                const neighborIndex = (initialNeighborIndex + i) % 8;
                const nx = x + neighbors[neighborIndex].dx;
                const ny = y + neighbors[neighborIndex].dy;
                const nIdx = ny * width + nx;

                if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[nIdx] === 1) {
                    contour.push({ x, y });
                    visited[y * width + x] = 1; // Mark current point as visited
                    
                    x = nx;
                    y = ny;
                    
                    initialNeighborIndex = (neighborIndex + 5) % 8;
                    foundNext = true;
                    break;
                }
            }
            if (!foundNext) break; // End if no next point found
        } while (x !== startPoint.x || y !== startPoint.y);
        
        return contour;
    }

    clear(): void {
        // Clear all mask chunks instead of just the active canvas
        this.clearAllMaskChunks();
        
        // Update active mask canvas to reflect the cleared state
        this.updateActiveMaskCanvas();
        
        if (this.isActive) {
            this.canvasInstance.canvasState.saveMaskState();
        }
        
        // Trigger render to show the cleared mask
        this.canvasInstance.render();
        
        log.info("Cleared all mask data from all chunks");
    }

    getMask(): HTMLCanvasElement {
        // Return the current active mask canvas which shows all chunks
        // Only update if there are pending changes to avoid unnecessary redraws
        if (this.activeMaskNeedsUpdate) {
            this.updateActiveMaskCanvas();
            this.activeMaskNeedsUpdate = false;
        }
        return this.activeMaskCanvas;
    }

    /**
     * Gets mask only for the output area - optimized for performance
     * Returns only the portion of the mask that overlaps with the output area
     * This is much more efficient than returning the entire mask when there are many chunks
     */
    getMaskForOutputArea(): HTMLCanvasElement {
        const bounds = this.canvasInstance.outputAreaBounds;
        
        // Create canvas sized to output area
        const outputMaskCanvas = document.createElement('canvas');
        outputMaskCanvas.width = bounds.width;
        outputMaskCanvas.height = bounds.height;
        const outputMaskCtx = outputMaskCanvas.getContext('2d', { willReadFrequently: true });
        
        if (!outputMaskCtx) {
            throw new Error("Failed to get 2D context for output area mask canvas");
        }
        
        // Calculate which chunks overlap with the output area
        const outputLeft = bounds.x;
        const outputTop = bounds.y;
        const outputRight = bounds.x + bounds.width;
        const outputBottom = bounds.y + bounds.height;
        
        const chunkBounds = this.calculateChunkBounds(outputLeft, outputTop, outputRight, outputBottom);
        
        // Only process chunks that overlap with output area
        for (let chunkY = chunkBounds.minY; chunkY <= chunkBounds.maxY; chunkY++) {
            for (let chunkX = chunkBounds.minX; chunkX <= chunkBounds.maxX; chunkX++) {
                const chunkKey = `${chunkX},${chunkY}`;
                const chunk = this.maskChunks.get(chunkKey);
                
                if (chunk && !chunk.isEmpty) {
                    // Calculate intersection between chunk and output area
                    const intersection = this.calculateChunkIntersection(chunk, outputLeft, outputTop, outputRight, outputBottom);
                    
                    if (intersection) {
                        // Draw only the intersecting portion
                        outputMaskCtx.drawImage(
                            chunk.canvas,
                            intersection.destX, intersection.destY, intersection.destWidth, intersection.destHeight, // Source from chunk
                            intersection.srcX, intersection.srcY, intersection.srcWidth, intersection.srcHeight      // Destination on output canvas
                        );
                    }
                }
            }
        }
        
        log.debug(`Generated output area mask (${bounds.width}x${bounds.height}) from ${chunkBounds.maxX - chunkBounds.minX + 1}x${chunkBounds.maxY - chunkBounds.minY + 1} chunks`);
        return outputMaskCanvas;
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

        this.activeMaskCanvas = document.createElement('canvas');

        const extraSpace = 2000;

        const newWidth = isIncreasingWidth ? width + extraSpace : Math.max(oldWidth, width + extraSpace);
        const newHeight = isIncreasingHeight ? height + extraSpace : Math.max(oldHeight, height + extraSpace);

        this.activeMaskCanvas.width = newWidth;
        this.activeMaskCanvas.height = newHeight;
        const newMaskCtx = this.activeMaskCanvas.getContext('2d', { willReadFrequently: true });
        if (!newMaskCtx) {
            throw new Error("Failed to get 2D context for new mask canvas");
        }
        this.activeMaskCtx = newMaskCtx;

        if (oldMask.width > 0 && oldMask.height > 0) {
            const offsetX = this.x - oldX;
            const offsetY = this.y - oldY;

            this.activeMaskCtx.drawImage(oldMask, offsetX, offsetY);

            log.debug(`Preserved mask content with offset (${offsetX}, ${offsetY})`);
        }

        log.info(`Mask canvas resized to ${this.activeMaskCanvas.width}x${this.activeMaskCanvas.height}, position (${this.x}, ${this.y})`);
        log.info(`Canvas size change: width ${isIncreasingWidth ? 'increased' : 'decreased'}, height ${isIncreasingHeight ? 'increased' : 'decreased'}`);
    }

    /**
     * Updates mask canvas to ensure it covers the current output area
     * This should be called when output area position or size changes
     * Now uses chunked system - just updates the active mask canvas
     */
    updateMaskCanvasForOutputArea(): void {
        log.info(`Updating chunked mask system for output area at (${this.canvasInstance.outputAreaBounds.x}, ${this.canvasInstance.outputAreaBounds.y})`);
        
        // Simply update the active mask canvas to cover the new output area
        // All existing chunks are preserved in the maskChunks Map
        this.updateActiveMaskCanvas();
        
        log.info(`Chunked mask system updated - ${this.maskChunks.size} chunks preserved`);
    }

    toggleOverlayVisibility(): void {
        this.isOverlayVisible = !this.isOverlayVisible;
        log.info(`Mask overlay visibility toggled to: ${this.isOverlayVisible}`);
    }

    setMask(image: HTMLImageElement): void {
        // Clear existing mask chunks in the output area first
        const bounds = this.canvasInstance.outputAreaBounds;
        this.clearMaskInArea(bounds.x, bounds.y, image.width, image.height);
        
        // Add the new mask using the chunk system
        this.addMask(image);
        
        log.info(`MaskTool set new mask using chunk system at bounds (${bounds.x}, ${bounds.y})`);
    }

    /**
     * Clears mask data in a specific area by clearing affected chunks
     */
    private clearMaskInArea(x: number, y: number, width: number, height: number): void {
        const chunkMinX = Math.floor(x / this.chunkSize);
        const chunkMinY = Math.floor(y / this.chunkSize);
        const chunkMaxX = Math.floor((x + width) / this.chunkSize);
        const chunkMaxY = Math.floor((y + height) / this.chunkSize);
        
        // Clear all affected chunks
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                const chunkKey = `${chunkX},${chunkY}`;
                const chunk = this.maskChunks.get(chunkKey);
                
                if (chunk && !chunk.isEmpty) {
                    this.clearMaskFromChunk(chunk, x, y, width, height);
                }
            }
        }
    }

    /**
     * Clears mask data from a specific chunk in a given area
     */
    private clearMaskFromChunk(chunk: MaskChunk, clearX: number, clearY: number, clearWidth: number, clearHeight: number): void {
        const clearLeft = clearX;
        const clearTop = clearY;
        const clearRight = clearX + clearWidth;
        const clearBottom = clearY + clearHeight;
        
        const intersection = this.calculateChunkIntersection(chunk, clearLeft, clearTop, clearRight, clearBottom);
        if (!intersection) {
            return; // No intersection
        }
        
        // Clear the area on this chunk
        chunk.ctx.clearRect(intersection.destX, intersection.destY, intersection.destWidth, intersection.destHeight);
        
        // Update chunk empty status
        this.updateChunkEmptyStatus(chunk);
        
        log.debug(`Cleared area from chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)}) at local position (${intersection.destX}, ${intersection.destY})`);
    }

    /**
     * Clears all mask chunks - used by the clear() function
     */
    private clearAllMaskChunks(): void {
        // Clear all existing chunks
        for (const [chunkKey, chunk] of this.maskChunks) {
            chunk.ctx.clearRect(0, 0, this.chunkSize, this.chunkSize);
            chunk.isEmpty = true;
            chunk.isDirty = true;
        }
        
        // Optionally remove all chunks from memory to free up resources
        this.maskChunks.clear();
        this.activeChunkBounds = null;
        
        log.info(`Cleared all ${this.maskChunks.size} mask chunks`);
    }

    addMask(image: HTMLImageElement): void {
        // Add mask to chunks system instead of directly to active canvas
        const bounds = this.canvasInstance.outputAreaBounds;
        
        // Calculate which chunks this mask will affect
        const maskLeft = bounds.x;
        const maskTop = bounds.y;
        const maskRight = bounds.x + image.width;
        const maskBottom = bounds.y + image.height;
        
        const chunkBounds = this.calculateChunkBounds(maskLeft, maskTop, maskRight, maskBottom);
        
        // Add mask to all affected chunks
        for (let chunkY = chunkBounds.minY; chunkY <= chunkBounds.maxY; chunkY++) {
            for (let chunkX = chunkBounds.minX; chunkX <= chunkBounds.maxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                this.addMaskToChunk(chunk, image, bounds);
            }
        }
        
        // Activate chunks in the area for visibility
        const activatedChunks = this.activateChunksInArea(maskLeft, maskTop, maskRight, maskBottom);
        
        // Update active canvas to show the new mask with activated chunks
        this.updateActiveMaskCanvas(true); // Force full update to show all chunks including newly activated ones

        this.triggerStateChangeAndRender();
        
        log.info(`MaskTool added SAM mask to chunks covering bounds (${bounds.x}, ${bounds.y}) to (${maskRight}, ${maskBottom}) and activated ${activatedChunks} chunks for visibility`);
    }

    /**
     * Adds a mask image to a specific chunk
     */
    private addMaskToChunk(chunk: MaskChunk, maskImage: HTMLImageElement, bounds: { x: number, y: number, width: number, height: number }): void {
        const sourceArea = {
            left: bounds.x,
            top: bounds.y,
            right: bounds.x + maskImage.width,
            bottom: bounds.y + maskImage.height
        };
        
        this.performChunkOperation(chunk, maskImage, sourceArea, 'add', "Added mask to");
    }

    /**
     * Applies a mask canvas to the chunked system at a specific world position
     */
    private applyMaskCanvasToChunks(maskCanvas: HTMLCanvasElement, worldX: number, worldY: number): void {
        // Calculate which chunks this mask will affect
        const maskLeft = worldX;
        const maskTop = worldY;
        const maskRight = worldX + maskCanvas.width;
        const maskBottom = worldY + maskCanvas.height;
        
        const chunkMinX = Math.floor(maskLeft / this.chunkSize);
        const chunkMinY = Math.floor(maskTop / this.chunkSize);
        const chunkMaxX = Math.floor(maskRight / this.chunkSize);
        const chunkMaxY = Math.floor(maskBottom / this.chunkSize);
        
        // First, clear the area where the mask will be applied
        this.clearMaskInArea(maskLeft, maskTop, maskCanvas.width, maskCanvas.height);
        
        // Apply mask to all affected chunks
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                this.applyMaskCanvasToChunk(chunk, maskCanvas, worldX, worldY);
            }
        }
        
        log.info(`Applied mask canvas to chunks covering area (${maskLeft}, ${maskTop}) to (${maskRight}, ${maskBottom})`);
    }

    /**
     * Removes a mask canvas from the chunked system at a specific world position
     */
    private removeMaskCanvasFromChunks(maskCanvas: HTMLCanvasElement, worldX: number, worldY: number): void {
        // Calculate which chunks this mask will affect
        const maskLeft = worldX;
        const maskTop = worldY;
        const maskRight = worldX + maskCanvas.width;
        const maskBottom = worldY + maskCanvas.height;
        
        const chunkMinX = Math.floor(maskLeft / this.chunkSize);
        const chunkMinY = Math.floor(maskTop / this.chunkSize);
        const chunkMaxX = Math.floor(maskRight / this.chunkSize);
        const chunkMaxY = Math.floor(maskBottom / this.chunkSize);
        
        // Remove mask from all affected chunks
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                this.removeMaskCanvasFromChunk(chunk, maskCanvas, worldX, worldY);
            }
        }
        
        log.info(`Removed mask canvas from chunks covering area (${maskLeft}, ${maskTop}) to (${maskRight}, ${maskBottom})`);
    }

    /**
     * Removes a mask canvas from a specific chunk using destination-out composition
     */
    private removeMaskCanvasFromChunk(chunk: MaskChunk, maskCanvas: HTMLCanvasElement, maskWorldX: number, maskWorldY: number): void {
        const sourceArea = {
            left: maskWorldX,
            top: maskWorldY,
            right: maskWorldX + maskCanvas.width,
            bottom: maskWorldY + maskCanvas.height
        };
        
        this.performChunkOperation(chunk, maskCanvas, sourceArea, 'remove', "Removed mask canvas from");
    }

    /**
     * Applies a mask canvas to a specific chunk
     */
    private applyMaskCanvasToChunk(chunk: MaskChunk, maskCanvas: HTMLCanvasElement, maskWorldX: number, maskWorldY: number): void {
        const sourceArea = {
            left: maskWorldX,
            top: maskWorldY,
            right: maskWorldX + maskCanvas.width,
            bottom: maskWorldY + maskCanvas.height
        };
        
        this.performChunkOperation(chunk, maskCanvas, sourceArea, 'apply', "Applied mask canvas to");
    }

    applyShapeMask(saveState: boolean = true): void {
        // Use unified configuration preparation
        const config = this.prepareShapeMaskConfiguration();
        if (!config) {
            log.warn("Cannot apply shape mask: shape is not defined or has too few points.");
            return;
        }
        
        if (saveState) {
            this.canvasInstance.canvasState.saveMaskState();
        }

        // Create the shape mask canvas
        let shapeMaskCanvas: HTMLCanvasElement;
        
        // Check if we need expansion or feathering
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;
        const needsFeather = this.canvasInstance.shapeMaskFeather && this.canvasInstance.shapeMaskFeatherValue > 0;

        if (!needsExpansion && !needsFeather) {
            // Simple case: just draw the original shape
            const { canvas, ctx } = this.createCanvas(config.tempCanvasWidth, config.tempCanvasHeight);
            shapeMaskCanvas = canvas;
            this.drawShapeOnCanvas(ctx, config.tempShapePoints, 'evenodd');
        } else if (needsExpansion && !needsFeather) {
            // Expansion only
            shapeMaskCanvas = this._createExpandedMaskCanvas(config.tempShapePoints, this.canvasInstance.shapeMaskExpansionValue, config.tempCanvasWidth, config.tempCanvasHeight);
        } else if (!needsExpansion && needsFeather) {
            // Feather only
            shapeMaskCanvas = this._createFeatheredMaskCanvas(config.tempShapePoints, this.canvasInstance.shapeMaskFeatherValue, config.tempCanvasWidth, config.tempCanvasHeight);
        } else {
            // Both expansion and feather
            const expandedMaskCanvas = this._createExpandedMaskCanvas(config.tempShapePoints, this.canvasInstance.shapeMaskExpansionValue, config.tempCanvasWidth, config.tempCanvasHeight);
            const tempCtx = expandedMaskCanvas.getContext('2d', { willReadFrequently: true })!;
            const expandedImageData = tempCtx.getImageData(0, 0, expandedMaskCanvas.width, expandedMaskCanvas.height);
            shapeMaskCanvas = this._createFeatheredMaskFromImageData(expandedImageData, this.canvasInstance.shapeMaskFeatherValue, config.tempCanvasWidth, config.tempCanvasHeight);
        }

        // Calculate which chunks will be affected by the shape mask
        const maskWorldX = config.bounds.x - config.tempOffsetX;
        const maskWorldY = config.bounds.y - config.tempOffsetY;
        const maskLeft = maskWorldX;
        const maskTop = maskWorldY;
        const maskRight = maskWorldX + shapeMaskCanvas.width;
        const maskBottom = maskWorldY + shapeMaskCanvas.height;

        // Apply the shape mask to the chunked system
        this.applyMaskCanvasToChunks(shapeMaskCanvas, maskWorldX, maskWorldY);

        // Activate chunks in the area for visibility
        const activatedChunks = this.activateChunksInArea(maskLeft, maskTop, maskRight, maskBottom);

        // Update the active mask canvas to show the changes with activated chunks
        this.updateActiveMaskCanvas(true); // Force full update to show all chunks including newly activated ones

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        
        log.info(`Applied shape mask to chunks with expansion: ${needsExpansion}, feather: ${needsFeather} and activated ${activatedChunks} chunks for visibility`);
    }

    /**
     * Removes mask in the area of the custom output area shape. This must use a hard-edged
     * shape to correctly erase any feathered "glow" that might have been applied.
     * Now works with the chunked mask system.
     */
    removeShapeMask(): void {
        // Use unified configuration preparation
        const config = this.prepareShapeMaskConfiguration();
        if (!config) {
            log.warn("Shape has insufficient points for mask removal");
            return;
        }
        
        this.canvasInstance.canvasState.saveMaskState();

        // Check if we need to account for expansion when removing
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;

        // Create a removal mask canvas - always hard-edged to ensure complete removal
        let removalMaskCanvas: HTMLCanvasElement;

        // Add safety margin to ensure complete removal of antialiasing artifacts
        const safetyMargin = 2; // 2px margin to remove any antialiasing remnants

        if (needsExpansion) {
            // If expansion was active, remove exactly the user's expansion value + safety margin
            const userExpansionValue = this.canvasInstance.shapeMaskExpansionValue;
            const expandedValue = Math.abs(userExpansionValue) + safetyMargin;
            removalMaskCanvas = this._createExpandedMaskCanvas(
                config.tempShapePoints, 
                expandedValue, 
                config.tempCanvasWidth, 
                config.tempCanvasHeight
            );
        } else {
            // If no expansion, remove the base shape with safety margin only
            removalMaskCanvas = this._createExpandedMaskCanvas(
                config.tempShapePoints, 
                safetyMargin, 
                config.tempCanvasWidth, 
                config.tempCanvasHeight
            );
        }

        // Now remove the shape mask from the chunked system
        this.removeMaskCanvasFromChunks(removalMaskCanvas, config.bounds.x - config.tempOffsetX, config.bounds.y - config.tempOffsetY);

        // Update the active mask canvas to show the changes
        this.updateActiveMaskCanvas(true); // Force full update to ensure all chunks are properly updated

        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Removed shape mask from chunks with expansion: ${needsExpansion}.`);
    }

    private _createFeatheredMaskCanvas(points: Point[], featherRadius: number, width: number, height: number): HTMLCanvasElement {
        // 1. Create binary mask data from shape points
        const binaryData = this.createBinaryMaskFromShape(points, width, height);
        
        // 2. Use unified feathering logic
        return this.createFeatheredMaskFromBinaryData(binaryData, featherRadius, width, height);
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
     * Creates an expanded/contracted mask canvas using simple morphological operations
     * This gives SHARP edges without smoothing, unlike distance transform
     */
    private _createExpandedMaskCanvas(points: Point[], expansionValue: number, width: number, height: number): HTMLCanvasElement {
        // 1. Create binary mask data from shape points
        const binaryData = this.createBinaryMaskFromShape(points, width, height);
        
        // 2. Apply fast morphological operations for sharp edges
        let resultMask: Uint8Array;
        const absExpansionValue = Math.abs(expansionValue);
        
        if (expansionValue >= 0) {
            // EXPANSION: Use new fast dilation algorithm
            resultMask = this._fastDilateDT(binaryData, width, height, absExpansionValue);
        } else {
            // CONTRACTION: Use new fast erosion algorithm  
            resultMask = this._fastErodeDT(binaryData, width, height, absExpansionValue);
        }
        
        // 3. Create the final output canvas with sharp edges
        return this.createOutputCanvasFromPixelData((outputData) => {
            for (let i = 0; i < resultMask.length; i++) {
                const alpha = resultMask[i] === 1 ? 255 : 0; // Sharp binary mask - no smoothing
                outputData.data[i * 4] = 255;     // R
                outputData.data[i * 4 + 1] = 255; // G  
                outputData.data[i * 4 + 2] = 255; // B
                outputData.data[i * 4 + 3] = alpha; // A - sharp edges
            }
        }, width, height);
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
        
        // Use unified feathering logic
        return this.createFeatheredMaskFromBinaryData(binaryData, featherRadius, width, height);
    }
}
