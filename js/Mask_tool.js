import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu Mask_tool
const log = {
    debug: (...args) => logger.debug('Mask_tool', ...args),
    info: (...args) => logger.info('Mask_tool', ...args),
    warn: (...args) => logger.warn('Mask_tool', ...args),
    error: (...args) => logger.error('Mask_tool', ...args)
};

// Konfiguracja loggera dla modułu Mask_tool
logger.setModuleLevel('Mask_tool', LogLevel.DEBUG);

export class MaskTool {
    constructor(canvasInstance) {
        this.canvasInstance = canvasInstance;
        this.mainCanvas = canvasInstance.canvas;
        this.maskCanvas = document.createElement('canvas');
        this.maskCtx = this.maskCanvas.getContext('2d');

        this.isActive = false;
        this.brushSize = 20;
        this.brushStrength = 0.5;
        this.brushSoftness = 0.5; // Domyślna miękkość pędzla (0 - twardy, 1 - bardzo miękki)
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
        this.clear();
    }

    activate() {
        this.isActive = true;
        this.canvasInstance.interaction.mode = 'drawingMask';
        log.info("Mask tool activated");
    }

    deactivate() {
        this.isActive = false;
        this.canvasInstance.interaction.mode = 'none';
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
        this.isDrawing = false;
        this.lastPosition = null;
    }

    draw(worldCoords) {
        if (!this.lastPosition) {
            this.lastPosition = worldCoords;
        }

        this.maskCtx.beginPath();
        this.maskCtx.moveTo(this.lastPosition.x, this.lastPosition.y);
        this.maskCtx.lineTo(worldCoords.x, worldCoords.y);

        // Utwórz gradient radialny dla miękkości pędzla
        const gradientRadius = this.brushSize / 2;
        const softnessFactor = this.brushSoftness * gradientRadius;
        const gradient = this.maskCtx.createRadialGradient(
            worldCoords.x, worldCoords.y, gradientRadius - softnessFactor,
            worldCoords.x, worldCoords.y, gradientRadius
        );
        gradient.addColorStop(0, `rgba(255, 255, 255, ${this.brushStrength})`);
        gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);

        this.maskCtx.strokeStyle = gradient;
        this.maskCtx.lineWidth = this.brushSize;
        this.maskCtx.lineCap = 'round';
        this.maskCtx.lineJoin = 'round';

        this.maskCtx.globalCompositeOperation = 'source-over';
        this.maskCtx.stroke();
    }

    clear() {
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    }

    getMask() {
        return this.maskCanvas;
    }

    getMaskImageWithAlpha() {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.maskCanvas.width;
        tempCanvas.height = this.maskCanvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        // Kopiuj maskę na tymczasowy canvas
        tempCtx.drawImage(this.maskCanvas, 0, 0);

        // Pobierz dane pikseli
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;

        // Modyfikuj kanał alfa, aby zachować zróżnicowaną przezroczystość
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i]; // Wartość alfa (0-255)
            data[i] = 255; // Czerwony
            data[i + 1] = 255; // Zielony
            data[i + 2] = 255; // Niebieski
            data[i + 3] = alpha; // Alfa (zachowaj oryginalną wartość)
        }

        // Zapisz zmodyfikowane dane pikseli
        tempCtx.putImageData(imageData, 0, 0);

        // Utwórz obraz z tymczasowego canvasu
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
        this.maskCtx.drawImage(oldMask, 0, 0);
    }
}