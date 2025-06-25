import {saveImage, getImage, removeImage} from "./db.js";
import {MaskTool} from "./Mask_tool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
import {CanvasIO} from "./CanvasIO.js";
import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu Canvas
const log = {
    debug: (...args) => logger.debug('Canvas', ...args),
    info: (...args) => logger.info('Canvas', ...args),
    warn: (...args) => logger.warn('Canvas', ...args),
    error: (...args) => logger.error('Canvas', ...args)
};

// Konfiguracja loggera dla modułu Canvas
logger.setModuleLevel('Canvas', LogLevel.DEBUG); // Domyślnie INFO, można zmienić na DEBUG dla szczegółowych logów

export class Canvas {
    constructor(node, widget) {
        this.node = node;
        this.widget = widget;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.width = 512;
        this.height = 512;
        this.layers = [];
        this.selectedLayer = null;
        this.selectedLayers = [];
        this.onSelectionChange = null;
        this.lastMousePosition = {x: 0, y: 0};

        this.viewport = {
            x: -(this.width / 4),
            y: -(this.height / 4),
            zoom: 0.8,
        };
        // Interaction state will be managed by CanvasInteractions module

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', {
            alpha: false
        });
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.internalClipboard = [];
        this.isMouseOver = false;
        this.renderInterval = 1000 / 60;
        this.isDirty = false;

        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.maskTool = new MaskTool(this);
        this.initCanvas();
        this.canvasState = new CanvasState(this); // Nowy moduł zarządzania stanem
        this.canvasInteractions = new CanvasInteractions(this); // Nowy moduł obsługi interakcji
        this.canvasLayers = new CanvasLayers(this); // Nowy moduł operacji na warstwach
        this.canvasRenderer = new CanvasRenderer(this); // Nowy moduł renderowania
        this.canvasIO = new CanvasIO(this); // Nowy moduł operacji I/O
        
        // Po utworzeniu CanvasInteractions, użyj jego interaction state
        this.interaction = this.canvasInteractions.interaction;
        
        this.setupEventListeners();
        this.initNodeData();

        // Przeniesione do CanvasLayers
        this.blendModes = this.canvasLayers.blendModes;
        this.selectedBlendMode = this.canvasLayers.selectedBlendMode;
        this.blendOpacity = this.canvasLayers.blendOpacity;
        this.isAdjustingOpacity = this.canvasLayers.isAdjustingOpacity;

        this.layers = this.layers.map(layer => ({
            ...layer,
            opacity: 1
        }));

        this.imageCache = new Map(); // Pamięć podręczna dla obrazów (imageId -> imageSrc)

        // this.saveState(); // Wywołanie przeniesione do loadInitialState
    }

    async loadStateFromDB() {
        return this.canvasState.loadStateFromDB();
    }

    async saveStateToDB(immediate = false) {
        return this.canvasState.saveStateToDB(immediate);
    }

    async loadInitialState() {
        log.info("Loading initial state for node:", this.node.id);
        const loaded = await this.loadStateFromDB();
        if (!loaded) {
            log.info("No saved state found, initializing from node data.");
            await this.initNodeData();
        }
        this.saveState(); // Save initial state to undo stack
    }

    saveState(replaceLast = false) {
        this.canvasState.saveState(replaceLast);
    }

    undo() {
        this.canvasState.undo();
    }

    redo() {
        this.canvasState.redo();
    }

    updateSelectionAfterHistory() {
        const newSelectedLayers = [];
        if (this.selectedLayers) {
            this.selectedLayers.forEach(sl => {
                const found = this.layers.find(l => l.id === sl.id);
                if (found) newSelectedLayers.push(found);
            });
        }
        this.updateSelection(newSelectedLayers);
    }

    updateHistoryButtons() {
        if (this.onHistoryChange) {
            this.onHistoryChange({
                canUndo: this.canvasState.undoStack.length > 1,
                canRedo: this.canvasState.redoStack.length > 0
            });
        }
    }

    initCanvas() {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.border = '1px solid black';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.backgroundColor = '#606060';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';


        this.canvas.tabIndex = 0;
        this.canvas.style.outline = 'none';
    }

    setupEventListeners() {
        this.canvasInteractions.setupEventListeners();
    }

    updateSelection(newSelection) {
        this.selectedLayers = newSelection || [];
        this.selectedLayer = this.selectedLayers.length > 0 ? this.selectedLayers[this.selectedLayers.length - 1] : null;
        if (this.onSelectionChange) {
            this.onSelectionChange();
        }
    }


    // Interaction methods moved to CanvasInteractions module


    // Delegacja metod operacji na warstwach do CanvasLayers
    async copySelectedLayers() {
        return this.canvasLayers.copySelectedLayers();
    }

    pasteLayers() {
        return this.canvasLayers.pasteLayers();
    }

    async handlePaste() {
        return this.canvasLayers.handlePaste();
    }


    handleMouseMove(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleMouseMove(e);
    }


    handleMouseUp(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleMouseUp(e);
    }


    handleMouseLeave(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleMouseLeave(e);
    }


    handleWheel(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleWheel(e);
    }

    handleKeyDown(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleKeyDown(e);
    }

    handleKeyUp(e) {
        // Deleguj do CanvasInteractions
        this.canvasInteractions.handleKeyUp(e);
    }

    // Wszystkie metody interakcji zostały przeniesione do CanvasInteractions
    // Pozostawiamy tylko metody pomocnicze używane przez CanvasInteractions


    isRotationHandle(x, y) {
        return this.canvasLayers.isRotationHandle(x, y);
    }

    async addLayerWithImage(image, layerProps = {}) {
        return this.canvasLayers.addLayerWithImage(image, layerProps);
    }

    generateUUID() {
        return this.canvasLayers.generateUUID();
    }

    async addLayer(image) {
        return this.addLayerWithImage(image);
    }

    async removeLayer(index) {
        if (index >= 0 && index < this.layers.length) {
            const layer = this.layers[index];
            if (layer.imageId) {
                // Usuń obraz z IndexedDB, jeśli nie jest używany przez inne warstwy
                const isImageUsedElsewhere = this.layers.some((l, i) => i !== index && l.imageId === layer.imageId);
                if (!isImageUsedElsewhere) {
                    await removeImage(layer.imageId);
                    this.imageCache.delete(layer.imageId); // Usuń z pamięci podręcznej
                }
            }
            this.layers.splice(index, 1);
            this.selectedLayer = this.layers[this.layers.length - 1] || null;
            this.render();
        }
    }

    getMouseWorldCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();

        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        const scaleX = this.offscreenCanvas.width / rect.width;
        const scaleY = this.offscreenCanvas.height / rect.height;

        const mouseX_Buffer = mouseX_DOM * scaleX;
        const mouseY_Buffer = mouseY_DOM * scaleY;

        const worldX = (mouseX_Buffer / this.viewport.zoom) + this.viewport.x;
        const worldY = (mouseY_Buffer / this.viewport.zoom) + this.viewport.y;

        return {x: worldX, y: worldY};
    }

    snapToGrid(value, gridSize = 64) {
        return this.canvasLayers.snapToGrid(value, gridSize);
    }

    getSnapAdjustment(layer, gridSize = 64, snapThreshold = 10) {
        return this.canvasLayers.getSnapAdjustment(layer, gridSize, snapThreshold);
    }

    moveLayer(fromIndex, toIndex) {
        return this.canvasLayers.moveLayer(fromIndex, toIndex);
    }

    resizeLayer(scale) {
        this.selectedLayers.forEach(layer => {
            layer.width *= scale;
            layer.height *= scale;
        });
        this.render();
        this.saveState();
    }

    rotateLayer(angle) {
        this.selectedLayers.forEach(layer => {
            layer.rotation += angle;
        });
        this.render();
        this.saveState();
    }

    updateCanvasSize(width, height, saveHistory = true) {
        return this.canvasLayers.updateCanvasSize(width, height, saveHistory);
    }

    render() {
        this.canvasRenderer.render();
    }

    // Rendering methods moved to CanvasRenderer


    getHandles(layer) {
        return this.canvasLayers.getHandles(layer);
    }

    getHandleAtPosition(worldX, worldY) {
        return this.canvasLayers.getHandleAtPosition(worldX, worldY);
    }

    worldToLocal(worldX, worldY, layerProps) {
        return this.canvasLayers.worldToLocal(worldX, worldY, layerProps);
    }

    localToWorld(localX, localY, layerProps) {
        return this.canvasLayers.localToWorld(localX, localY, layerProps);
    }


    async saveToServer(fileName) {
        return this.canvasIO.saveToServer(fileName);
    }

    async getFlattenedCanvasAsBlob() {
        return this.canvasLayers.getFlattenedCanvasAsBlob();
    }

    async getFlattenedSelectionAsBlob() {
        return this.canvasLayers.getFlattenedSelectionAsBlob();
    }

    moveLayerUp() {
        return this.canvasLayers.moveLayerUp();
    }

    moveLayerDown() {
        return this.canvasLayers.moveLayerDown();
    }


    getLayerAtPosition(worldX, worldY) {
        return this.canvasLayers.getLayerAtPosition(worldX, worldY);
    }

    getResizeHandle(x, y) {
        return this.canvasLayers.getResizeHandle(x, y);
    }

    async mirrorHorizontal() {
        return this.canvasLayers.mirrorHorizontal();
    }

    async mirrorVertical() {
        return this.canvasLayers.mirrorVertical();
    }

    async getLayerImageData(layer) {
        return this.canvasLayers.getLayerImageData(layer);
    }

    addMattedLayer(image, mask) {
        return this.canvasLayers.addMattedLayer(image, mask);
    }

    processInputData(nodeData) {
        if (nodeData.input_image) {
            this.addInputImage(nodeData.input_image);
        }
        if (nodeData.input_mask) {
            this.addInputMask(nodeData.input_mask);
        }
    }

    addInputImage(imageData) {
        const layer = new ImageLayer(imageData);
        this.layers.push(layer);
        this.updateCanvas();
    }

    addInputMask(maskData) {
        if (this.inputImage) {
            const mask = new MaskLayer(maskData);
            mask.linkToLayer(this.inputImage);
            this.masks.push(mask);
            this.updateCanvas();
        }
    }

    async addInputToCanvas(inputImage, inputMask) {
        return this.canvasIO.addInputToCanvas(inputImage, inputMask);
    }

    async convertTensorToImage(tensor) {
        return this.canvasIO.convertTensorToImage(tensor);
    }

    async convertTensorToMask(tensor) {
        return this.canvasIO.convertTensorToMask(tensor);
    }

    async initNodeData() {
        return this.canvasIO.initNodeData();
    }

    scheduleDataCheck() {
        return this.canvasIO.scheduleDataCheck();
    }

    async processImageData(imageData) {
        return this.canvasIO.processImageData(imageData);
    }

    addScaledLayer(image, scale) {
        return this.canvasIO.addScaledLayer(image, scale);
    }

    convertTensorToImageData(tensor) {
        return this.canvasIO.convertTensorToImageData(tensor);
    }

    async createImageFromData(imageData) {
        return this.canvasIO.createImageFromData(imageData);
    }

    async retryDataLoad(maxRetries = 3, delay = 1000) {
        return this.canvasIO.retryDataLoad(maxRetries, delay);
    }

    async processMaskData(maskData) {
        return this.canvasIO.processMaskData(maskData);
    }

    async loadImageFromCache(base64Data) {
        return this.canvasIO.loadImageFromCache(base64Data);
    }

    async importImage(cacheData) {
        return this.canvasIO.importImage(cacheData);
    }

    async importLatestImage() {
        return this.canvasIO.importLatestImage();
    }

    showBlendModeMenu(x, y) {
        return this.canvasLayers.showBlendModeMenu(x, y);
    }

    handleBlendModeSelection(mode) {
        return this.canvasLayers.handleBlendModeSelection(mode);
    }

    showOpacitySlider(mode) {
        return this.canvasLayers.showOpacitySlider(mode);
    }

    applyBlendMode(mode, opacity) {
        return this.canvasLayers.applyBlendMode(mode, opacity);
    }
}
