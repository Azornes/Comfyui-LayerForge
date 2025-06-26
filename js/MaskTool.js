import {createModuleLogger} from "./utils/LoggerUtils.js";
const log = createModuleLogger('Mask_tool');

export class MaskTool {
    constructor(canvasInstance) {
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.maskCanvas = document.createElement('canvas');
        this.maskCtx = this.maskCanvas.getContext('2d');

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
        this.maskCanvas.width = this.mainCanvas.width;
        this.maskCanvas.height = this.mainCanvas.height;
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
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
        }
    }

    draw(worldCoords) {
        if (!this.lastPosition) {
            this.lastPosition = worldCoords;
        }

        this.maskCtx.beginPath();
        this.maskCtx.moveTo(this.lastPosition.x, this.lastPosition.y);
        this.maskCtx.lineTo(worldCoords.x, worldCoords.y);
        const gradientRadius = this.brushSize / 2;
        
        if (this.brushSoftness === 0) {
            this.maskCtx.strokeStyle = `rgba(255, 255, 255, ${this.brushStrength})`;
        } else {
            const innerRadius = gradientRadius * this.brushSoftness;
            const gradient = this.maskCtx.createRadialGradient(
                worldCoords.x, worldCoords.y, innerRadius,
                worldCoords.x, worldCoords.y, gradientRadius
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
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = width;
        this.maskCanvas.height = height;
        this.maskCtx = this.maskCanvas.getContext('2d');
        if (oldMask.width > 0 && oldMask.height > 0) {
            this.maskCtx.drawImage(oldMask, 0, 0);
        }
        
        log.info(`Mask canvas resized to ${width}x${height}`);
    }
}
