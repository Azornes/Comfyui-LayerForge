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

    get maskContext(): CanvasRenderingContext2D {
        return this.maskCtx;
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
}
