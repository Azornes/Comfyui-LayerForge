import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('Mask_tool');
export class MaskTool {
    constructor(canvasInstance, callbacks = {}) {
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
        // Initialize shape preview system
        this.shapePreviewCanvas = document.createElement('canvas');
        const shapePreviewCtx = this.shapePreviewCanvas.getContext('2d', { willReadFrequently: true });
        if (!shapePreviewCtx) {
            throw new Error("Failed to get 2D context for shape preview canvas");
        }
        this.shapePreviewCtx = shapePreviewCtx;
        this.shapePreviewVisible = false;
        this.isPreviewMode = false;
        this.initMaskCanvas();
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
        const extraSpace = 2000; // Allow for a generous drawing area outside the output area
        const bounds = this.canvasInstance.outputAreaBounds;
        // Mask canvas should cover output area + extra space around it
        const maskLeft = bounds.x - extraSpace / 2;
        const maskTop = bounds.y - extraSpace / 2;
        const maskWidth = bounds.width + extraSpace;
        const maskHeight = bounds.height + extraSpace;
        this.maskCanvas.width = maskWidth;
        this.maskCanvas.height = maskHeight;
        this.x = maskLeft;
        this.y = maskTop;
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        log.info(`Initialized mask canvas with size: ${this.maskCanvas.width}x${this.maskCanvas.height}, positioned at (${this.x}, ${this.y}) to cover output area at (${bounds.x}, ${bounds.y})`);
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
            }
            else {
                const innerRadius = gradientRadius * this.brushHardness;
                const gradient = this.maskCtx.createRadialGradient(canvasX, canvasY, innerRadius, canvasX, canvasY, gradientRadius);
                gradient.addColorStop(0, `rgba(255, 255, 255, ${this.brushStrength})`);
                gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
                this.maskCtx.strokeStyle = gradient;
            }
            this.maskCtx.lineWidth = this.brushSize;
            this.maskCtx.lineCap = 'round';
            this.maskCtx.lineJoin = 'round';
            this.maskCtx.globalCompositeOperation = 'source-over';
            this.maskCtx.stroke();
        }
        else {
            log.debug(`Drawing outside mask canvas bounds: (${canvasX}, ${canvasY})`);
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
        const screenPoints = shape.points.map(p => ({
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
        log.debug(`Shape preview shown with expansion: ${expansionValue}px, feather: ${featherValue}px`);
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
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        if (this.isActive) {
            this.canvasInstance.canvasState.saveMaskState();
        }
    }
    getMask() {
        return this.maskCanvas;
    }
    getMaskImageWithAlpha() {
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
    resize(width, height) {
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
    updatePosition(dx, dy) {
        this.x += dx;
        this.y += dy;
        log.info(`Mask position updated to (${this.x}, ${this.y})`);
    }
    /**
     * Updates mask canvas to ensure it covers the current output area
     * This should be called when output area position or size changes
     */
    updateMaskCanvasForOutputArea() {
        const extraSpace = 2000;
        const bounds = this.canvasInstance.outputAreaBounds;
        // Calculate required mask canvas bounds
        const requiredLeft = bounds.x - extraSpace / 2;
        const requiredTop = bounds.y - extraSpace / 2;
        const requiredWidth = bounds.width + extraSpace;
        const requiredHeight = bounds.height + extraSpace;
        // Check if current mask canvas covers the required area
        const currentRight = this.x + this.maskCanvas.width;
        const currentBottom = this.y + this.maskCanvas.height;
        const requiredRight = requiredLeft + requiredWidth;
        const requiredBottom = requiredTop + requiredHeight;
        const needsResize = requiredLeft < this.x ||
            requiredTop < this.y ||
            requiredRight > currentRight ||
            requiredBottom > currentBottom;
        if (needsResize) {
            log.info(`Updating mask canvas to cover output area at (${bounds.x}, ${bounds.y})`);
            // Save current mask content
            const oldMask = this.maskCanvas;
            const oldX = this.x;
            const oldY = this.y;
            // Create new mask canvas with proper size and position
            this.maskCanvas = document.createElement('canvas');
            this.maskCanvas.width = requiredWidth;
            this.maskCanvas.height = requiredHeight;
            this.x = requiredLeft;
            this.y = requiredTop;
            const newMaskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
            if (!newMaskCtx) {
                throw new Error("Failed to get 2D context for new mask canvas");
            }
            this.maskCtx = newMaskCtx;
            // Copy old mask content to new position
            if (oldMask.width > 0 && oldMask.height > 0) {
                const offsetX = oldX - this.x;
                const offsetY = oldY - this.y;
                this.maskCtx.drawImage(oldMask, offsetX, offsetY);
                log.debug(`Preserved mask content with offset (${offsetX}, ${offsetY})`);
            }
            log.info(`Mask canvas updated to ${this.maskCanvas.width}x${this.maskCanvas.height} at (${this.x}, ${this.y})`);
        }
    }
    toggleOverlayVisibility() {
        this.isOverlayVisible = !this.isOverlayVisible;
        log.info(`Mask overlay visibility toggled to: ${this.isOverlayVisible}`);
    }
    setMask(image) {
        // Pozycja gdzie ma być aplikowana maska na canvas MaskTool
        // MaskTool canvas ma pozycję (this.x, this.y) w świecie
        // Maska reprezentuje output bounds, więc musimy ją umieścić
        // w pozycji bounds względem pozycji MaskTool
        const bounds = this.canvasInstance.outputAreaBounds;
        const destX = bounds.x - this.x;
        const destY = bounds.y - this.y;
        this.maskCtx.clearRect(destX, destY, this.canvasInstance.width, this.canvasInstance.height);
        this.maskCtx.drawImage(image, destX, destY);
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`MaskTool updated with a new mask image at position (${destX}, ${destY}) relative to bounds (${bounds.x}, ${bounds.y}).`);
    }
    addMask(image) {
        // Pozycja gdzie ma być aplikowana maska na canvas MaskTool
        // MaskTool canvas ma pozycję (this.x, this.y) w świecie
        // Maska z SAM reprezentuje output bounds, więc musimy ją umieścić
        // w pozycji bounds względem pozycji MaskTool
        const bounds = this.canvasInstance.outputAreaBounds;
        const destX = bounds.x - this.x;
        const destY = bounds.y - this.y;
        // Don't clear existing mask - just add to it
        this.maskCtx.globalCompositeOperation = 'source-over';
        this.maskCtx.drawImage(image, destX, destY);
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`MaskTool added SAM mask overlay at position (${destX}, ${destY}) relative to bounds (${bounds.x}, ${bounds.y}) without clearing existing mask.`);
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
        const destX = -this.x;
        const destY = -this.y;
        const maskPoints = shape.points.map(p => ({ x: p.x + destX, y: p.y + destY }));
        // --- Clear Previous State ---
        // To prevent artifacts from previous slider values, we first clear the maximum
        // possible area the shape could have occupied.
        const maxExpansion = 300; // The maximum value of the expansion slider
        const clearingMaskCanvas = this._createExpandedMaskCanvas(maskPoints, maxExpansion, this.maskCanvas.width, this.maskCanvas.height);
        this.maskCtx.globalCompositeOperation = 'destination-out';
        this.maskCtx.drawImage(clearingMaskCanvas, 0, 0);
        // --- Apply Current State ---
        // Now, apply the new, correct mask additively.
        this.maskCtx.globalCompositeOperation = 'source-over';
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
            this.maskCtx.fill('evenodd'); // Use evenodd to handle holes correctly
        }
        else if (needsExpansion && !needsFeather) {
            // Expansion only: use the new distance transform expansion
            const expandedMaskCanvas = this._createExpandedMaskCanvas(maskPoints, this.canvasInstance.shapeMaskExpansionValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(expandedMaskCanvas, 0, 0);
        }
        else if (!needsExpansion && needsFeather) {
            // Feather only: apply feathering to the original shape
            const featheredMaskCanvas = this._createFeatheredMaskCanvas(maskPoints, this.canvasInstance.shapeMaskFeatherValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(featheredMaskCanvas, 0, 0);
        }
        else {
            // Both expansion and feather: first expand, then apply feather to the expanded shape
            // Step 1: Create expanded shape
            const expandedMaskCanvas = this._createExpandedMaskCanvas(maskPoints, this.canvasInstance.shapeMaskExpansionValue, this.maskCanvas.width, this.maskCanvas.height);
            // Step 2: Extract points from the expanded canvas and apply feathering
            // For now, we'll apply feathering to the expanded canvas directly
            // This is a simplified approach - we could extract the outline points for more precision
            const tempCtx = expandedMaskCanvas.getContext('2d', { willReadFrequently: true });
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
     * Removes mask in the area of the custom output area shape. This must use a hard-edged
     * shape to correctly erase any feathered "glow" that might have been applied.
     */
    removeShapeMask() {
        if (!this.canvasInstance.outputAreaShape?.points || this.canvasInstance.outputAreaShape.points.length < 3) {
            log.warn("Shape has insufficient points for mask removal");
            return;
        }
        this.canvasInstance.canvasState.saveMaskState();
        const shape = this.canvasInstance.outputAreaShape;
        const destX = -this.x;
        const destY = -this.y;
        // Use 'destination-out' to erase the shape area
        this.maskCtx.globalCompositeOperation = 'destination-out';
        const maskPoints = shape.points.map(p => ({ x: p.x + destX, y: p.y + destY }));
        const needsExpansion = this.canvasInstance.shapeMaskExpansion && this.canvasInstance.shapeMaskExpansionValue !== 0;
        // IMPORTANT: Removal should always be hard-edged, even if feather was on.
        // This ensures the feathered "glow" is completely removed. We only care about expansion.
        if (needsExpansion) {
            // If expansion was active, remove the expanded area with a hard edge.
            const expandedMaskCanvas = this._createExpandedMaskCanvas(maskPoints, this.canvasInstance.shapeMaskExpansionValue, this.maskCanvas.width, this.maskCanvas.height);
            this.maskCtx.drawImage(expandedMaskCanvas, 0, 0);
        }
        else {
            // If no expansion, just remove the base shape with a hard edge.
            this.maskCtx.beginPath();
            this.maskCtx.moveTo(maskPoints[0].x, maskPoints[0].y);
            for (let i = 1; i < maskPoints.length; i++) {
                this.maskCtx.lineTo(maskPoints[i].x, maskPoints[i].y);
            }
            this.maskCtx.closePath();
            this.maskCtx.fill('evenodd');
        }
        // Restore default composite operation
        this.maskCtx.globalCompositeOperation = 'source-over';
        if (this.onStateChange) {
            this.onStateChange();
        }
        this.canvasInstance.render();
        log.info(`Removed shape mask area (hard-edged) with expansion: ${needsExpansion}.`);
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
     * Creates an expanded mask using distance transform - much better for complex shapes
     * than the centroid-based approach. This version only does expansion without transparency calculations.
     */
    _calculateExpandedPoints(points, expansionValue) {
        if (points.length < 3 || expansionValue === 0)
            return points;
        // For expansion, we need to create a temporary canvas to use the distance transform approach
        // This will give us much better results for complex shapes than the centroid method
        const tempCanvas = this._createExpandedMaskCanvas(points, expansionValue, this.maskCanvas.width, this.maskCanvas.height);
        // Extract the expanded shape outline from the canvas
        // For now, return the original points as a fallback - the real expansion happens in the canvas
        // The calling code will use the canvas directly instead of these points
        return points;
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
