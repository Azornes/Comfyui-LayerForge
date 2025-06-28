import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('Mask_tool');

export class MaskTool {
    constructor(canvasInstance, callbacks = {}) {
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.onStateChange = callbacks.onStateChange || null;
        this.maskCanvas = document.createElement('canvas');
        this.maskCtx = this.maskCanvas.getContext('2d');

        this.x = 0;
        this.y = 0;

        this.isActive = false;
        this.brushSize = 20;
        this.brushStrength = 0.5;
        this.brushSoftness = 0.5;
        this.isDrawing = false;
        this.lastPosition = null;

        this.initMaskCanvas();
    }

    setBrushSoftness(softness) {
        this.brushSoftness = Math.max(0, Math.min(1, softness));
    }

    initMaskCanvas() {

        const extraSpace = 2000; // Allow for a generous drawing area outside the output area
        this.maskCanvas.width = this.canvasInstance.width + extraSpace;
        this.maskCanvas.height = this.canvasInstance.height + extraSpace;


        this.x = -extraSpace / 2;
        this.y = -extraSpace / 2;

        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        log.info(`Initialized mask canvas with extended size: ${this.maskCanvas.width}x${this.maskCanvas.height}, origin at (${this.x}, ${this.y})`);
    }

    activate() {
        this.isActive = true;
        this.canvasInstance.interaction.mode = 'drawingMask';
        if (this.canvasInstance.canvasState && this.canvasInstance.canvasState.maskUndoStack.length === 0) {
            this.canvasInstance.canvasState.saveMaskState();
        }
        this.canvasInstance.updateHistoryButtons();

        log.info("Mask tool activated");
    }

    deactivate() {
        this.isActive = false;
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

    handleMouseDown(worldCoords) {
        if (!this.isActive) return;
        this.isDrawing = true;
        this.lastPosition = worldCoords;
        this.draw(worldCoords);
    }

    handleMouseMove(worldCoords) {
        if (!this.isActive || !this.isDrawing) return;
        this.draw(worldCoords);
        this.lastPosition = worldCoords;
    }

    handleMouseUp() {
        if (!this.isActive) return;
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastPosition = null;
            if (this.canvasInstance.canvasState) {
                this.canvasInstance.canvasState.saveMaskState();
            }
            if (this.onStateChange) {
                this.onStateChange();
            }
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

            if (this.brushSoftness === 0) {
                this.maskCtx.strokeStyle = `rgba(255, 255, 255, ${this.brushStrength})`;
            } else {
                const innerRadius = gradientRadius * this.brushSoftness;
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

    clear() {
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        if (this.isActive && this.canvasInstance.canvasState) {
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
        const tempCtx = tempCanvas.getContext('2d');
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
        const oldMask = this.maskCanvas;
        const oldX = this.x;
        const oldY = this.y;
        const oldWidth = oldMask.width;
        const oldHeight = oldMask.height;

        const isIncreasingWidth = width > (this.canvasInstance.width);
        const isIncreasingHeight = height > (this.canvasInstance.height);

        this.maskCanvas = document.createElement('canvas');

        const extraSpace = 2000;


        const newWidth = isIncreasingWidth ? width + extraSpace : Math.max(oldWidth, width + extraSpace);
        const newHeight = isIncreasingHeight ? height + extraSpace : Math.max(oldHeight, height + extraSpace);

        this.maskCanvas.width = newWidth;
        this.maskCanvas.height = newHeight;
        this.maskCtx = this.maskCanvas.getContext('2d');

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
}
