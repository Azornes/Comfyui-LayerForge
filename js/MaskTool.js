import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('Mask_tool');
export class MaskTool {
    constructor(canvasInstance, callbacks = {}) {
        this.ACTIVE_MASK_UPDATE_DELAY = 16; // ~60fps throttling
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.onStateChange = callbacks.onStateChange || null;
        // Initialize chunked mask system
        this.maskChunks = new Map();
        this.chunkSize = 512;
        this.activeChunkBounds = null;
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
        this.initMaskCanvas();
    }
    // Temporary compatibility getters - will be replaced with chunked system
    get maskCanvas() {
        return this.activeMaskCanvas;
    }
    get maskCtx() {
        return this.activeMaskCtx;
    }
    initPreviewCanvas() {
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
    setBrushHardness(hardness) {
        this.brushHardness = Math.max(0, Math.min(1, hardness));
    }
    initMaskCanvas() {
        // Initialize chunked system
        this.chunkSize = 512;
        this.maskChunks = new Map();
        // Create initial active mask canvas
        this.updateActiveMaskCanvas();
        log.info(`Initialized chunked mask system with chunk size: ${this.chunkSize}x${this.chunkSize}`);
    }
    /**
     * Updates the active mask canvas to show ALL chunks with mask data
     * No longer limited to output area - shows all drawn masks everywhere
     */
    updateActiveMaskCanvas() {
        // Find bounds of all non-empty chunks
        const chunkBounds = this.getAllChunkBounds();
        if (!chunkBounds) {
            // No chunks with data - create minimal canvas
            this.activeMaskCanvas.width = 1;
            this.activeMaskCanvas.height = 1;
            this.x = 0;
            this.y = 0;
            this.activeChunkBounds = null;
            log.info("No mask chunks found - created minimal active canvas");
            return;
        }
        // Calculate canvas size to cover all chunks
        const canvasLeft = chunkBounds.minX * this.chunkSize;
        const canvasTop = chunkBounds.minY * this.chunkSize;
        const canvasWidth = (chunkBounds.maxX - chunkBounds.minX + 1) * this.chunkSize;
        const canvasHeight = (chunkBounds.maxY - chunkBounds.minY + 1) * this.chunkSize;
        // Update active mask canvas size and position
        this.activeMaskCanvas.width = canvasWidth;
        this.activeMaskCanvas.height = canvasHeight;
        this.x = canvasLeft;
        this.y = canvasTop;
        // Clear active canvas
        this.activeMaskCtx.clearRect(0, 0, canvasWidth, canvasHeight);
        this.activeChunkBounds = chunkBounds;
        // Composite ALL chunks with data onto active canvas
        for (let chunkY = chunkBounds.minY; chunkY <= chunkBounds.maxY; chunkY++) {
            for (let chunkX = chunkBounds.minX; chunkX <= chunkBounds.maxX; chunkX++) {
                const chunkKey = `${chunkX},${chunkY}`;
                const chunk = this.maskChunks.get(chunkKey);
                if (chunk && !chunk.isEmpty) {
                    // Calculate position on active canvas
                    const destX = (chunkX - chunkBounds.minX) * this.chunkSize;
                    const destY = (chunkY - chunkBounds.minY) * this.chunkSize;
                    this.activeMaskCtx.drawImage(chunk.canvas, destX, destY);
                }
            }
        }
    }
    /**
     * Finds the bounds of all chunks that contain mask data
     * Returns null if no chunks have data
     */
    getAllChunkBounds() {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let hasData = false;
        for (const [chunkKey, chunk] of this.maskChunks) {
            if (!chunk.isEmpty) {
                const [chunkXStr, chunkYStr] = chunkKey.split(',');
                const chunkX = parseInt(chunkXStr);
                const chunkY = parseInt(chunkYStr);
                minX = Math.min(minX, chunkX);
                minY = Math.min(minY, chunkY);
                maxX = Math.max(maxX, chunkX);
                maxY = Math.max(maxY, chunkY);
                hasData = true;
            }
        }
        return hasData ? { minX, minY, maxX, maxY } : null;
    }
    /**
     * Gets or creates a chunk for the given world coordinates
     */
    getChunkForPosition(worldX, worldY) {
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
    createChunk(chunkX, chunkY) {
        const canvas = document.createElement('canvas');
        canvas.width = this.chunkSize;
        canvas.height = this.chunkSize;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error("Failed to get 2D context for chunk canvas");
        }
        const chunk = {
            canvas,
            ctx,
            x: chunkX * this.chunkSize,
            y: chunkY * this.chunkSize,
            isDirty: false,
            isEmpty: true
        };
        log.debug(`Created chunk at (${chunkX}, ${chunkY}) covering world area (${chunk.x}, ${chunk.y}) to (${chunk.x + this.chunkSize}, ${chunk.y + this.chunkSize})`);
        return chunk;
    }
    activate() {
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
    deactivate() {
        this.isActive = false;
        this.previewCanvas.style.display = 'none';
        this.canvasInstance.interaction.mode = 'none';
        this.canvasInstance.updateHistoryButtons();
        log.info("Mask tool deactivated");
    }
    setBrushSize(size) {
        this.brushSize = Math.max(1, size);
    }
    setBrushStrength(strength) {
        this.brushStrength = Math.max(0, Math.min(1, strength));
    }
    handleMouseDown(worldCoords, viewCoords) {
        if (!this.isActive)
            return;
        this.isDrawing = true;
        this.lastPosition = worldCoords;
        this.draw(worldCoords);
        this.clearPreview();
    }
    handleMouseMove(worldCoords, viewCoords) {
        if (this.isActive) {
            this.drawBrushPreview(viewCoords);
        }
        if (!this.isActive || !this.isDrawing)
            return;
        this.draw(worldCoords);
        this.lastPosition = worldCoords;
    }
    handleMouseLeave() {
        this.previewVisible = false;
        this.clearPreview();
    }
    handleMouseEnter() {
        this.previewVisible = true;
    }
    handleMouseUp(viewCoords) {
        if (!this.isActive)
            return;
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
    draw(worldCoords) {
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
    drawOnChunks(startWorld, endWorld) {
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
    drawLineOnChunk(chunk, startWorld, endWorld) {
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
        }
        else {
            const innerRadius = gradientRadius * this.brushHardness;
            const gradient = chunk.ctx.createRadialGradient(endLocal.x, endLocal.y, innerRadius, endLocal.x, endLocal.y, gradientRadius);
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
        chunk.isDirty = true;
        chunk.isEmpty = false;
        log.debug(`Drew on chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)})`);
    }
    /**
     * Checks if a line intersects with a chunk bounds
     */
    lineIntersectsChunk(startLocal, endLocal, chunkSize) {
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
     * Uses throttling to limit updates to ~60fps during drawing operations
     */
    updateActiveCanvasIfNeeded(startWorld, endWorld) {
        // Calculate which chunks were affected by this drawing operation
        const minX = Math.min(startWorld.x, endWorld.x) - this.brushSize;
        const maxX = Math.max(startWorld.x, endWorld.x) + this.brushSize;
        const minY = Math.min(startWorld.y, endWorld.y) - this.brushSize;
        const maxY = Math.max(startWorld.y, endWorld.y) + this.brushSize;
        const affectedChunkMinX = Math.floor(minX / this.chunkSize);
        const affectedChunkMinY = Math.floor(minY / this.chunkSize);
        const affectedChunkMaxX = Math.floor(maxX / this.chunkSize);
        const affectedChunkMaxY = Math.floor(maxY / this.chunkSize);
        // Check if we drew on any new chunks (outside current active bounds)
        let drewOnNewChunks = false;
        if (!this.activeChunkBounds) {
            drewOnNewChunks = true;
        }
        else {
            drewOnNewChunks =
                affectedChunkMinX < this.activeChunkBounds.minX ||
                    affectedChunkMaxX > this.activeChunkBounds.maxX ||
                    affectedChunkMinY < this.activeChunkBounds.minY ||
                    affectedChunkMaxY > this.activeChunkBounds.maxY;
        }
        if (drewOnNewChunks) {
            // Drawing extended beyond current active bounds - immediate update required
            this.updateActiveMaskCanvas();
            log.debug("Drew on new chunks - performed immediate full active canvas update");
        }
        else {
            // Drawing within existing bounds - use throttled update for performance
            this.scheduleThrottledActiveMaskUpdate(affectedChunkMinX, affectedChunkMinY, affectedChunkMaxX, affectedChunkMaxY);
        }
    }
    /**
     * Schedules a throttled update of the active mask canvas to prevent excessive redraws
     * Only updates at most once per ACTIVE_MASK_UPDATE_DELAY milliseconds
     */
    scheduleThrottledActiveMaskUpdate(chunkMinX, chunkMinY, chunkMaxX, chunkMaxY) {
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
     * Partially updates the active canvas by redrawing only specific chunks
     * Much faster than full recomposition during drawing
     * Now works with the new system that shows ALL chunks
     */
    updateActiveCanvasPartial(chunkMinX, chunkMinY, chunkMaxX, chunkMaxY) {
        if (!this.activeChunkBounds) {
            // No active bounds - do full update
            this.updateActiveMaskCanvas();
            return;
        }
        // Only redraw the affected chunks that are within the current active canvas bounds
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                // Check if this chunk is within active bounds (all chunks with data)
                if (chunkX >= this.activeChunkBounds.minX && chunkX <= this.activeChunkBounds.maxX &&
                    chunkY >= this.activeChunkBounds.minY && chunkY <= this.activeChunkBounds.maxY) {
                    const chunkKey = `${chunkX},${chunkY}`;
                    const chunk = this.maskChunks.get(chunkKey);
                    if (chunk && !chunk.isEmpty) {
                        // Calculate position on active canvas (relative to all chunks bounds)
                        const destX = (chunkX - this.activeChunkBounds.minX) * this.chunkSize;
                        const destY = (chunkY - this.activeChunkBounds.minY) * this.chunkSize;
                        // Clear the area first, then redraw
                        this.activeMaskCtx.clearRect(destX, destY, this.chunkSize, this.chunkSize);
                        this.activeMaskCtx.drawImage(chunk.canvas, destX, destY);
                    }
                }
            }
        }
    }
    drawBrushPreview(viewCoords) {
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
    clearPreview() {
        this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
        this.clearShapePreview();
    }
    /**
     * Initialize shape preview canvas for showing blue outline during slider adjustments
     * Canvas is pinned to viewport and covers the entire visible area
     */
    initShapePreviewCanvas() {
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
    showShapePreview(expansionValue, featherValue = 0) {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            return;
        }
        if (!this.shapePreviewCanvas.parentElement)
            this.initShapePreviewCanvas();
        this.isPreviewMode = true;
        this.shapePreviewVisible = true;
        this.shapePreviewCanvas.style.display = 'block';
        this.clearShapePreview();
        const shape = this.canvasInstance.outputAreaShape;
        const viewport = this.canvasInstance.viewport;
        const bounds = this.canvasInstance.outputAreaBounds;
        // Convert shape points to world coordinates first (relative to output area bounds)
        const worldShapePoints = shape.points.map(p => ({
            x: bounds.x + p.x,
            y: bounds.y + p.y
        }));
        // Then convert world coordinates to screen coordinates
        const screenPoints = worldShapePoints.map(p => ({
            x: (p.x - viewport.x) * viewport.zoom,
            y: (p.y - viewport.y) * viewport.zoom
        }));
        // This function now returns Point[][] to handle islands.
        const allContours = this._calculatePreviewPointsScreen([screenPoints], expansionValue, viewport.zoom);
        // Draw main expansion/contraction preview
        this.shapePreviewCtx.strokeStyle = '#4A9EFF';
        this.shapePreviewCtx.lineWidth = 2;
        this.shapePreviewCtx.setLineDash([4, 4]);
        this.shapePreviewCtx.globalAlpha = 0.8;
        for (const contour of allContours) {
            if (contour.length < 2)
                continue;
            this.shapePreviewCtx.beginPath();
            this.shapePreviewCtx.moveTo(contour[0].x, contour[0].y);
            for (let i = 1; i < contour.length; i++) {
                this.shapePreviewCtx.lineTo(contour[i].x, contour[i].y);
            }
            this.shapePreviewCtx.closePath();
            this.shapePreviewCtx.stroke();
        }
        // Draw feather preview
        if (featherValue > 0) {
            const allFeatherContours = this._calculatePreviewPointsScreen(allContours, -featherValue, viewport.zoom);
            this.shapePreviewCtx.strokeStyle = '#4A9EFF';
            this.shapePreviewCtx.lineWidth = 1;
            this.shapePreviewCtx.setLineDash([3, 5]);
            this.shapePreviewCtx.globalAlpha = 0.6;
            for (const contour of allFeatherContours) {
                if (contour.length < 2)
                    continue;
                this.shapePreviewCtx.beginPath();
                this.shapePreviewCtx.moveTo(contour[0].x, contour[0].y);
                for (let i = 1; i < contour.length; i++) {
                    this.shapePreviewCtx.lineTo(contour[i].x, contour[i].y);
                }
                this.shapePreviewCtx.closePath();
                this.shapePreviewCtx.stroke();
            }
        }
        log.debug(`Shape preview shown with expansion: ${expansionValue}px, feather: ${featherValue}px at bounds (${bounds.x}, ${bounds.y})`);
    }
    /**
     * Hide shape preview and switch back to normal mode
     */
    hideShapePreview() {
        this.isPreviewMode = false;
        this.shapePreviewVisible = false;
        this.clearShapePreview();
        this.shapePreviewCanvas.style.display = 'none';
        log.debug("Shape preview hidden");
    }
    /**
     * Clear shape preview canvas
     */
    clearShapePreview() {
        if (this.shapePreviewCtx) {
            this.shapePreviewCtx.clearRect(0, 0, this.shapePreviewCanvas.width, this.shapePreviewCanvas.height);
        }
    }
    /**
     * Update shape preview canvas position and scale when viewport changes
     * This ensures the preview stays synchronized with the world coordinates
     */
    updateShapePreviewPosition() {
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
     * Ultra-fast dilation using Distance Transform + thresholding (Manhattan distance for speed)
     */
    _fastDilateDT(mask, width, height, radius) {
        const INF = 1e9;
        const dist = new Float32Array(width * height);
        // 1. Initialize: 0 for foreground, INF for background
        for (let i = 0; i < width * height; ++i) {
            dist[i] = mask[i] ? 0 : INF;
        }
        // 2. Forward pass: top-left -> bottom-right
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const i = y * width + x;
                if (mask[i])
                    continue;
                if (x > 0)
                    dist[i] = Math.min(dist[i], dist[y * width + (x - 1)] + 1);
                if (y > 0)
                    dist[i] = Math.min(dist[i], dist[(y - 1) * width + x] + 1);
            }
        }
        // 3. Backward pass: bottom-right -> top-left
        for (let y = height - 1; y >= 0; --y) {
            for (let x = width - 1; x >= 0; --x) {
                const i = y * width + x;
                if (mask[i])
                    continue;
                if (x < width - 1)
                    dist[i] = Math.min(dist[i], dist[y * width + (x + 1)] + 1);
                if (y < height - 1)
                    dist[i] = Math.min(dist[i], dist[(y + 1) * width + x] + 1);
            }
        }
        // 4. Thresholding: if distance <= radius, it's part of the expanded mask
        const expanded = new Uint8Array(width * height);
        for (let i = 0; i < width * height; ++i) {
            expanded[i] = dist[i] <= radius ? 1 : 0;
        }
        return expanded;
    }
    /**
     * Ultra-fast erosion using Distance Transform + thresholding
     */
    _fastErodeDT(mask, width, height, radius) {
        const INF = 1e9;
        const dist = new Float32Array(width * height);
        // 1. Initialize: 0 for background, INF for foreground (inverse of dilation)
        for (let i = 0; i < width * height; ++i) {
            dist[i] = mask[i] ? INF : 0;
        }
        // 2. Forward pass: top-left -> bottom-right
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const i = y * width + x;
                if (!mask[i])
                    continue;
                if (x > 0)
                    dist[i] = Math.min(dist[i], dist[y * width + (x - 1)] + 1);
                if (y > 0)
                    dist[i] = Math.min(dist[i], dist[(y - 1) * width + x] + 1);
            }
        }
        // 3. Backward pass: bottom-right -> top-left
        for (let y = height - 1; y >= 0; --y) {
            for (let x = width - 1; x >= 0; --x) {
                const i = y * width + x;
                if (!mask[i])
                    continue;
                if (x < width - 1)
                    dist[i] = Math.min(dist[i], dist[y * width + (x + 1)] + 1);
                if (y < height - 1)
                    dist[i] = Math.min(dist[i], dist[(y + 1) * width + x] + 1);
            }
        }
        // 4. Thresholding: if distance > radius, it's part of the eroded mask
        const eroded = new Uint8Array(width * height);
        for (let i = 0; i < width * height; ++i) {
            eroded[i] = dist[i] > radius ? 1 : 0;
        }
        return eroded;
    }
    /**
     * Calculate preview points using screen coordinates for pinned canvas.
     * This version now accepts multiple contours and returns multiple contours.
     */
    _calculatePreviewPointsScreen(contours, expansionValue, zoom) {
        if (contours.length === 0 || expansionValue === 0)
            return contours;
        const width = this.canvasInstance.canvas.width;
        const height = this.canvasInstance.canvas.height;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        // Draw all contours to create the initial mask
        tempCtx.fillStyle = 'white';
        for (const points of contours) {
            if (points.length < 3)
                continue;
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
        let resultMask;
        const scaledExpansionValue = Math.round(Math.abs(expansionValue * zoom));
        if (expansionValue >= 0) {
            resultMask = this._fastDilateDT(binaryData, width, height, scaledExpansionValue);
        }
        else {
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
    _traceAllContours(mask, width, height) {
        const contours = [];
        const visited = new Uint8Array(mask.length); // Keep track of visited pixels
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                // Check for a potential starting point: a foreground pixel that hasn't been visited
                // and is on a boundary (next to a background pixel).
                if (mask[idx] === 1 && visited[idx] === 0) {
                    // Check if it's a boundary pixel
                    const isBoundary = mask[idx - 1] === 0 ||
                        mask[idx + 1] === 0 ||
                        mask[idx - width] === 0 ||
                        mask[idx + width] === 0;
                    if (isBoundary) {
                        // Found a new contour, let's trace it.
                        const contour = this._traceSingleContour({ x, y }, mask, width, height, visited);
                        if (contour.length > 2) {
                            // --- Path Simplification ---
                            const simplifiedContour = [];
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
    _traceSingleContour(startPoint, mask, width, height, visited) {
        const contour = [];
        let { x, y } = startPoint;
        // Neighbor checking order (clockwise)
        const neighbors = [
            { dx: 0, dy: -1 }, // N
            { dx: 1, dy: -1 }, // NE
            { dx: 1, dy: 0 }, // E
            { dx: 1, dy: 1 }, // SE
            { dx: 0, dy: 1 }, // S
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
            if (!foundNext)
                break; // End if no next point found
        } while (x !== startPoint.x || y !== startPoint.y);
        return contour;
    }
    clear() {
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
    getMask() {
        // Return the current active mask canvas which shows all chunks
        // Only update if there are pending changes to avoid unnecessary redraws
        if (this.activeMaskNeedsUpdate) {
            this.updateActiveMaskCanvas();
            this.activeMaskNeedsUpdate = false;
        }
        return this.activeMaskCanvas;
    }
    resize(width, height) {
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
    updateMaskCanvasForOutputArea() {
        log.info(`Updating chunked mask system for output area at (${this.canvasInstance.outputAreaBounds.x}, ${this.canvasInstance.outputAreaBounds.y})`);
        // Simply update the active mask canvas to cover the new output area
        // All existing chunks are preserved in the maskChunks Map
        this.updateActiveMaskCanvas();
        log.info(`Chunked mask system updated - ${this.maskChunks.size} chunks preserved`);
    }
    toggleOverlayVisibility() {
        this.isOverlayVisible = !this.isOverlayVisible;
        log.info(`Mask overlay visibility toggled to: ${this.isOverlayVisible}`);
    }
    setMask(image) {
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
    clearMaskInArea(x, y, width, height) {
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
    clearMaskFromChunk(chunk, clearX, clearY, clearWidth, clearHeight) {
        // Calculate the intersection of the clear area with this chunk
        const chunkLeft = chunk.x;
        const chunkTop = chunk.y;
        const chunkRight = chunk.x + this.chunkSize;
        const chunkBottom = chunk.y + this.chunkSize;
        const clearLeft = clearX;
        const clearTop = clearY;
        const clearRight = clearX + clearWidth;
        const clearBottom = clearY + clearHeight;
        // Find intersection
        const intersectLeft = Math.max(chunkLeft, clearLeft);
        const intersectTop = Math.max(chunkTop, clearTop);
        const intersectRight = Math.min(chunkRight, clearRight);
        const intersectBottom = Math.min(chunkBottom, clearBottom);
        // Check if there's actually an intersection
        if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
            return; // No intersection
        }
        // Calculate destination coordinates on the chunk
        const destX = intersectLeft - chunkLeft;
        const destY = intersectTop - chunkTop;
        const destWidth = intersectRight - intersectLeft;
        const destHeight = intersectBottom - intersectTop;
        // Clear the area on this chunk
        chunk.ctx.clearRect(destX, destY, destWidth, destHeight);
        // Check if the entire chunk is now empty
        const imageData = chunk.ctx.getImageData(0, 0, this.chunkSize, this.chunkSize);
        const data = imageData.data;
        let hasData = false;
        for (let i = 3; i < data.length; i += 4) { // Check alpha channel
            if (data[i] > 0) {
                hasData = true;
                break;
            }
        }
        chunk.isEmpty = !hasData;
        chunk.isDirty = true;
        log.debug(`Cleared area from chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)}) at local position (${destX}, ${destY})`);
    }
    /**
     * Clears all mask chunks - used by the clear() function
     */
    clearAllMaskChunks() {
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
    addMask(image) {
        // Add mask to chunks system instead of directly to active canvas
        const bounds = this.canvasInstance.outputAreaBounds;
        // Calculate which chunks this mask will affect
        const maskLeft = bounds.x;
        const maskTop = bounds.y;
        const maskRight = bounds.x + image.width;
        const maskBottom = bounds.y + image.height;
        const chunkMinX = Math.floor(maskLeft / this.chunkSize);
        const chunkMinY = Math.floor(maskTop / this.chunkSize);
        const chunkMaxX = Math.floor(maskRight / this.chunkSize);
        const chunkMaxY = Math.floor(maskBottom / this.chunkSize);
        // Add mask to all affected chunks
        for (let chunkY = chunkMinY; chunkY <= chunkMaxY; chunkY++) {
            for (let chunkX = chunkMinX; chunkX <= chunkMaxX; chunkX++) {
                const chunk = this.getChunkForPosition(chunkX * this.chunkSize, chunkY * this.chunkSize);
                this.addMaskToChunk(chunk, image, bounds);
            }
        }
        // Update active canvas to show the new mask
        this.updateActiveMaskCanvas();
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`MaskTool added SAM mask to chunks covering bounds (${bounds.x}, ${bounds.y}) to (${maskRight}, ${maskBottom})`);
    }
    /**
     * Adds a mask image to a specific chunk
     */
    addMaskToChunk(chunk, maskImage, bounds) {
        // Calculate the intersection of the mask with this chunk
        const chunkLeft = chunk.x;
        const chunkTop = chunk.y;
        const chunkRight = chunk.x + this.chunkSize;
        const chunkBottom = chunk.y + this.chunkSize;
        const maskLeft = bounds.x;
        const maskTop = bounds.y;
        const maskRight = bounds.x + maskImage.width;
        const maskBottom = bounds.y + maskImage.height;
        // Find intersection
        const intersectLeft = Math.max(chunkLeft, maskLeft);
        const intersectTop = Math.max(chunkTop, maskTop);
        const intersectRight = Math.min(chunkRight, maskRight);
        const intersectBottom = Math.min(chunkBottom, maskBottom);
        // Check if there's actually an intersection
        if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
            return; // No intersection
        }
        // Calculate source coordinates on the mask image
        const srcX = intersectLeft - maskLeft;
        const srcY = intersectTop - maskTop;
        const srcWidth = intersectRight - intersectLeft;
        const srcHeight = intersectBottom - intersectTop;
        // Calculate destination coordinates on the chunk
        const destX = intersectLeft - chunkLeft;
        const destY = intersectTop - chunkTop;
        // Draw the mask portion onto this chunk
        chunk.ctx.globalCompositeOperation = 'source-over';
        chunk.ctx.drawImage(maskImage, srcX, srcY, srcWidth, srcHeight, // Source rectangle
        destX, destY, srcWidth, srcHeight // Destination rectangle
        );
        // Mark chunk as dirty and not empty
        chunk.isDirty = true;
        chunk.isEmpty = false;
        log.debug(`Added mask to chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)}) at local position (${destX}, ${destY})`);
    }
    /**
     * Applies a mask canvas to the chunked system at a specific world position
     */
    applyMaskCanvasToChunks(maskCanvas, worldX, worldY) {
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
    removeMaskCanvasFromChunks(maskCanvas, worldX, worldY) {
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
    removeMaskCanvasFromChunk(chunk, maskCanvas, maskWorldX, maskWorldY) {
        // Calculate the intersection of the mask with this chunk
        const chunkLeft = chunk.x;
        const chunkTop = chunk.y;
        const chunkRight = chunk.x + this.chunkSize;
        const chunkBottom = chunk.y + this.chunkSize;
        const maskLeft = maskWorldX;
        const maskTop = maskWorldY;
        const maskRight = maskWorldX + maskCanvas.width;
        const maskBottom = maskWorldY + maskCanvas.height;
        // Find intersection
        const intersectLeft = Math.max(chunkLeft, maskLeft);
        const intersectTop = Math.max(chunkTop, maskTop);
        const intersectRight = Math.min(chunkRight, maskRight);
        const intersectBottom = Math.min(chunkBottom, maskBottom);
        // Check if there's actually an intersection
        if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
            return; // No intersection
        }
        // Calculate source coordinates on the mask canvas
        const srcX = intersectLeft - maskLeft;
        const srcY = intersectTop - maskTop;
        const srcWidth = intersectRight - intersectLeft;
        const srcHeight = intersectBottom - intersectTop;
        // Calculate destination coordinates on the chunk
        const destX = intersectLeft - chunkLeft;
        const destY = intersectTop - chunkTop;
        // Use destination-out to remove the mask portion from this chunk
        chunk.ctx.globalCompositeOperation = 'destination-out';
        chunk.ctx.drawImage(maskCanvas, srcX, srcY, srcWidth, srcHeight, // Source rectangle
        destX, destY, srcWidth, srcHeight // Destination rectangle
        );
        // Restore normal composition mode
        chunk.ctx.globalCompositeOperation = 'source-over';
        // Check if the chunk is now empty
        const imageData = chunk.ctx.getImageData(0, 0, this.chunkSize, this.chunkSize);
        const data = imageData.data;
        let hasData = false;
        for (let i = 3; i < data.length; i += 4) { // Check alpha channel
            if (data[i] > 0) {
                hasData = true;
                break;
            }
        }
        chunk.isEmpty = !hasData;
        chunk.isDirty = true;
        log.debug(`Removed mask canvas from chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)}) at local position (${destX}, ${destY})`);
    }
    /**
     * Applies a mask canvas to a specific chunk
     */
    applyMaskCanvasToChunk(chunk, maskCanvas, maskWorldX, maskWorldY) {
        // Calculate the intersection of the mask with this chunk
        const chunkLeft = chunk.x;
        const chunkTop = chunk.y;
        const chunkRight = chunk.x + this.chunkSize;
        const chunkBottom = chunk.y + this.chunkSize;
        const maskLeft = maskWorldX;
        const maskTop = maskWorldY;
        const maskRight = maskWorldX + maskCanvas.width;
        const maskBottom = maskWorldY + maskCanvas.height;
        // Find intersection
        const intersectLeft = Math.max(chunkLeft, maskLeft);
        const intersectTop = Math.max(chunkTop, maskTop);
        const intersectRight = Math.min(chunkRight, maskRight);
        const intersectBottom = Math.min(chunkBottom, maskBottom);
        // Check if there's actually an intersection
        if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
            return; // No intersection
        }
        // Calculate source coordinates on the mask canvas
        const srcX = intersectLeft - maskLeft;
        const srcY = intersectTop - maskTop;
        const srcWidth = intersectRight - intersectLeft;
        const srcHeight = intersectBottom - intersectTop;
        // Calculate destination coordinates on the chunk
        const destX = intersectLeft - chunkLeft;
        const destY = intersectTop - chunkTop;
        // Draw the mask portion onto this chunk
        chunk.ctx.globalCompositeOperation = 'source-over';
        chunk.ctx.drawImage(maskCanvas, srcX, srcY, srcWidth, srcHeight, // Source rectangle
        destX, destY, srcWidth, srcHeight // Destination rectangle
        );
        // Mark chunk as dirty and not empty
        chunk.isDirty = true;
        chunk.isEmpty = false;
        log.debug(`Applied mask canvas to chunk (${Math.floor(chunk.x / this.chunkSize)}, ${Math.floor(chunk.y / this.chunkSize)}) at local position (${destX}, ${destY})`);
    }
    applyShapeMask(saveState = true) {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            log.warn("Cannot apply shape mask: shape is not defined or has too few points.");
            return;
        }
        if (saveState) {
            this.canvasInstance.canvasState.saveMaskState();
        }
        const shape = this.canvasInstance.outputAreaShape;
        const bounds = this.canvasInstance.outputAreaBounds;
        // Calculate shape points in world coordinates
        // Shape points are relative to the output area bounds
        const worldShapePoints = shape.points.map(p => ({
            x: bounds.x + p.x,
            y: bounds.y + p.y
        }));
        // Create the shape mask canvas
        let shapeMaskCanvas;
        // Check if we need expansion or feathering
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;
        const needsFeather = this.canvasInstance.shapeMaskFeather && this.canvasInstance.shapeMaskFeatherValue > 0;
        // Create a temporary canvas large enough to contain the shape and any expansion
        const maxExpansion = Math.max(300, Math.abs(this.canvasInstance.shapeMaskExpansionValue || 0));
        const tempCanvasWidth = bounds.width + (maxExpansion * 2);
        const tempCanvasHeight = bounds.height + (maxExpansion * 2);
        const tempOffsetX = maxExpansion;
        const tempOffsetY = maxExpansion;
        // Adjust shape points for the temporary canvas
        const tempShapePoints = worldShapePoints.map(p => ({
            x: p.x - bounds.x + tempOffsetX,
            y: p.y - bounds.y + tempOffsetY
        }));
        if (!needsExpansion && !needsFeather) {
            // Simple case: just draw the original shape
            shapeMaskCanvas = document.createElement('canvas');
            shapeMaskCanvas.width = tempCanvasWidth;
            shapeMaskCanvas.height = tempCanvasHeight;
            const ctx = shapeMaskCanvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(tempShapePoints[0].x, tempShapePoints[0].y);
            for (let i = 1; i < tempShapePoints.length; i++) {
                ctx.lineTo(tempShapePoints[i].x, tempShapePoints[i].y);
            }
            ctx.closePath();
            ctx.fill('evenodd');
        }
        else if (needsExpansion && !needsFeather) {
            // Expansion only
            shapeMaskCanvas = this._createExpandedMaskCanvas(tempShapePoints, this.canvasInstance.shapeMaskExpansionValue, tempCanvasWidth, tempCanvasHeight);
        }
        else if (!needsExpansion && needsFeather) {
            // Feather only
            shapeMaskCanvas = this._createFeatheredMaskCanvas(tempShapePoints, this.canvasInstance.shapeMaskFeatherValue, tempCanvasWidth, tempCanvasHeight);
        }
        else {
            // Both expansion and feather
            const expandedMaskCanvas = this._createExpandedMaskCanvas(tempShapePoints, this.canvasInstance.shapeMaskExpansionValue, tempCanvasWidth, tempCanvasHeight);
            const tempCtx = expandedMaskCanvas.getContext('2d', { willReadFrequently: true });
            const expandedImageData = tempCtx.getImageData(0, 0, expandedMaskCanvas.width, expandedMaskCanvas.height);
            shapeMaskCanvas = this._createFeatheredMaskFromImageData(expandedImageData, this.canvasInstance.shapeMaskFeatherValue, tempCanvasWidth, tempCanvasHeight);
        }
        // Now apply the shape mask to the chunked system
        this.applyMaskCanvasToChunks(shapeMaskCanvas, bounds.x - tempOffsetX, bounds.y - tempOffsetY);
        // Update the active mask canvas to show the changes
        this.updateActiveMaskCanvas();
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Applied shape mask to chunks with expansion: ${needsExpansion}, feather: ${needsFeather}.`);
    }
    /**
     * Removes mask in the area of the custom output area shape. This must use a hard-edged
     * shape to correctly erase any feathered "glow" that might have been applied.
     * Now works with the chunked mask system.
     */
    removeShapeMask() {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            log.warn("Shape has insufficient points for mask removal");
            return;
        }
        this.canvasInstance.canvasState.saveMaskState();
        const shape = this.canvasInstance.outputAreaShape;
        const bounds = this.canvasInstance.outputAreaBounds;
        // Calculate shape points in world coordinates (same as applyShapeMask)
        const worldShapePoints = shape.points.map(p => ({
            x: bounds.x + p.x,
            y: bounds.y + p.y
        }));
        // Check if we need to account for expansion when removing
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;
        // Create a removal mask canvas - always hard-edged to ensure complete removal
        let removalMaskCanvas;
        // Create a temporary canvas large enough to contain the shape and any expansion
        const maxExpansion = Math.max(300, Math.abs(this.canvasInstance.shapeMaskExpansionValue || 0));
        const tempCanvasWidth = bounds.width + (maxExpansion * 2);
        const tempCanvasHeight = bounds.height + (maxExpansion * 2);
        const tempOffsetX = maxExpansion;
        const tempOffsetY = maxExpansion;
        // Adjust shape points for the temporary canvas
        const tempShapePoints = worldShapePoints.map(p => ({
            x: p.x - bounds.x + tempOffsetX,
            y: p.y - bounds.y + tempOffsetY
        }));
        if (needsExpansion) {
            // If expansion was active, remove the expanded area with a hard edge
            removalMaskCanvas = this._createExpandedMaskCanvas(tempShapePoints, this.canvasInstance.shapeMaskExpansionValue, tempCanvasWidth, tempCanvasHeight);
        }
        else {
            // If no expansion, just remove the base shape with a hard edge
            removalMaskCanvas = document.createElement('canvas');
            removalMaskCanvas.width = tempCanvasWidth;
            removalMaskCanvas.height = tempCanvasHeight;
            const ctx = removalMaskCanvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(tempShapePoints[0].x, tempShapePoints[0].y);
            for (let i = 1; i < tempShapePoints.length; i++) {
                ctx.lineTo(tempShapePoints[i].x, tempShapePoints[i].y);
            }
            ctx.closePath();
            ctx.fill('evenodd');
        }
        // Now remove the shape mask from the chunked system
        this.removeMaskCanvasFromChunks(removalMaskCanvas, bounds.x - tempOffsetX, bounds.y - tempOffsetY);
        // Update the active mask canvas to show the changes
        this.updateActiveMaskCanvas();
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Removed shape mask from chunks with expansion: ${needsExpansion}.`);
    }
    _createFeatheredMaskCanvas(points, featherRadius, width, height) {
        // 1. Create a binary mask on a temporary canvas.
        const binaryCanvas = document.createElement('canvas');
        binaryCanvas.width = width;
        binaryCanvas.height = height;
        const binaryCtx = binaryCanvas.getContext('2d', { willReadFrequently: true });
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
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
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
            }
            else if (distance <= threshold) {
                // Edge area - apply gradient alpha (from edge inward)
                const gradientValue = distance / threshold;
                const alphaValue = Math.floor(gradientValue * 255);
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = alphaValue;
            }
            else {
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
    _fastDistanceTransform(binaryMask, width, height) {
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
    _createExpandedMaskCanvas(points, expansionValue, width, height) {
        // 1. Create a binary mask on a temporary canvas.
        const binaryCanvas = document.createElement('canvas');
        binaryCanvas.width = width;
        binaryCanvas.height = height;
        const binaryCtx = binaryCanvas.getContext('2d', { willReadFrequently: true });
        binaryCtx.fillStyle = 'white';
        binaryCtx.beginPath();
        binaryCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            binaryCtx.lineTo(points[i].x, points[i].y);
        }
        binaryCtx.closePath();
        binaryCtx.fill('evenodd'); // Use evenodd to handle holes correctly
        const maskImage = binaryCtx.getImageData(0, 0, width, height);
        const binaryData = new Uint8Array(width * height);
        for (let i = 0; i < binaryData.length; i++) {
            binaryData[i] = maskImage.data[i * 4] > 0 ? 1 : 0; // 1 = inside, 0 = outside
        }
        // 2. Apply fast morphological operations for sharp edges
        let resultMask;
        const absExpansionValue = Math.abs(expansionValue);
        if (expansionValue >= 0) {
            // EXPANSION: Use new fast dilation algorithm
            resultMask = this._fastDilateDT(binaryData, width, height, absExpansionValue);
        }
        else {
            // CONTRACTION: Use new fast erosion algorithm  
            resultMask = this._fastErodeDT(binaryData, width, height, absExpansionValue);
        }
        // 3. Create the final output canvas with sharp edges
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
        const outputData = outputCtx.createImageData(width, height);
        for (let i = 0; i < resultMask.length; i++) {
            const alpha = resultMask[i] === 1 ? 255 : 0; // Sharp binary mask - no smoothing
            outputData.data[i * 4] = 255; // R
            outputData.data[i * 4 + 1] = 255; // G  
            outputData.data[i * 4 + 2] = 255; // B
            outputData.data[i * 4 + 3] = alpha; // A - sharp edges
        }
        outputCtx.putImageData(outputData, 0, 0);
        return outputCanvas;
    }
    /**
     * Creates a feathered mask from existing ImageData (used when combining expansion + feather)
     */
    _createFeatheredMaskFromImageData(imageData, featherRadius, width, height) {
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
        const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
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
            }
            else if (distance <= threshold) {
                // Edge area - apply gradient alpha (from edge inward)
                const gradientValue = distance / threshold;
                const alphaValue = Math.floor(gradientValue * 255);
                outputData.data[i * 4] = 255;
                outputData.data[i * 4 + 1] = 255;
                outputData.data[i * 4 + 2] = 255;
                outputData.data[i * 4 + 3] = alphaValue;
            }
            else {
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
