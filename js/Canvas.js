import { app, ComfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {removeImage} from "./db.js";
import {MaskTool} from "./MaskTool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
import {CanvasIO} from "./CanvasIO.js";
import {ImageReferenceManager} from "./ImageReferenceManager.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import { mask_editor_showing } from "./utils/mask_utils.js";

const log = createModuleLogger('Canvas');

export class Canvas {
    constructor(node, widget, callbacks = {}) {
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
        this.onStateChange = callbacks.onStateChange || null;
        this.lastMousePosition = {x: 0, y: 0};

        this.viewport = {
            x: -(this.width / 4),
            y: -(this.height / 4),
            zoom: 0.8,
        };

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', {
            alpha: false
        });

        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.maskTool = new MaskTool(this, {onStateChange: this.onStateChange});
        this.initCanvas();
        this.canvasState = new CanvasState(this);
        this.canvasInteractions = new CanvasInteractions(this);
        this.canvasLayers = new CanvasLayers(this);
        this.canvasRenderer = new CanvasRenderer(this);
        this.canvasIO = new CanvasIO(this);
        this.imageReferenceManager = new ImageReferenceManager(this);
        this.interaction = this.canvasInteractions.interaction;

        this.setupEventListeners();
        this.initNodeData();

        this.layers = this.layers.map(layer => ({
            ...layer,
            opacity: 1
        }));

        this.imageCache = new Map();
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
        this.saveState();
        this.render();
    }

    _notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange();
        }
    }

    saveState(replaceLast = false) {
        this.canvasState.saveState(replaceLast);
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    undo() {
        this.canvasState.undo();
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    redo() {
        this.canvasState.redo();
        this.incrementOperationCount();
        this._notifyStateChange();
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
            const historyInfo = this.canvasState.getHistoryInfo();
            this.onHistoryChange({
                canUndo: historyInfo.canUndo,
                canRedo: historyInfo.canRedo
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

    async copySelectedLayers() {
        return this.canvasLayers.copySelectedLayers();
    }

    pasteLayers() {
        return this.canvasLayers.pasteLayers();
    }

    async handlePaste(addMode) {
        return this.canvasLayers.handlePaste(addMode);
    }


    handleMouseMove(e) {
        this.canvasInteractions.handleMouseMove(e);
    }


    handleMouseUp(e) {
        this.canvasInteractions.handleMouseUp(e);
    }


    handleMouseLeave(e) {
        this.canvasInteractions.handleMouseLeave(e);
    }


    handleWheel(e) {
        this.canvasInteractions.handleWheel(e);
    }

    handleKeyDown(e) {
        this.canvasInteractions.handleKeyDown(e);
    }

    handleKeyUp(e) {
        this.canvasInteractions.handleKeyUp(e);
    }


    isRotationHandle(x, y) {
        return this.canvasLayers.isRotationHandle(x, y);
    }

    async addLayerWithImage(image, layerProps = {}, addMode = 'default') {
        return this.canvasLayers.addLayerWithImage(image, layerProps, addMode);
    }


    async addLayer(image, addMode = 'default') {
        return this.addLayerWithImage(image, {}, addMode);
    }

    async removeLayer(index) {
        if (index >= 0 && index < this.layers.length) {
            const layer = this.layers[index];
            if (layer.imageId) {
                const isImageUsedElsewhere = this.layers.some((l, i) => i !== index && l.imageId === layer.imageId);
                if (!isImageUsedElsewhere) {
                    await removeImage(layer.imageId);
                    this.imageCache.delete(layer.imageId);
                }
            }
            this.layers.splice(index, 1);
            this.selectedLayer = this.layers[this.layers.length - 1] || null;
            this.render();
        }
    }

    removeSelectedLayers() {
        if (this.selectedLayers.length > 0) {
            this.saveState();
            this.layers = this.layers.filter(l => !this.selectedLayers.includes(l));
            this.updateSelection([]);
            this.render();
            this.saveState();
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

    getMouseViewCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        const mouseX_Canvas = mouseX_DOM * scaleX;
        const mouseY_Canvas = mouseY_DOM * scaleY;

        return { x: mouseX_Canvas, y: mouseY_Canvas };
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

    updateOutputAreaSize(width, height, saveHistory = true) {
        return this.canvasLayers.updateOutputAreaSize(width, height, saveHistory);
    }

    render() {
        this.canvasRenderer.render();
    }


    getHandles(layer) {
        return this.canvasLayers.getHandles(layer);
    }

    getHandleAtPosition(worldX, worldY) {
        return this.canvasLayers.getHandleAtPosition(worldX, worldY);
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

    /**
     * Zwiększa licznik operacji (wywoływane przy każdej operacji na canvas)
     */
    incrementOperationCount() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.incrementOperationCount();
        }
    }

    /**
     * Ręczne uruchomienie garbage collection
     */
    async runGarbageCollection() {
        if (this.imageReferenceManager) {
            await this.imageReferenceManager.manualGarbageCollection();
        }
    }

    /**
     * Zwraca statystyki garbage collection
     */
    getGarbageCollectionStats() {
        if (this.imageReferenceManager) {
            const stats = this.imageReferenceManager.getStats();
            return {
                ...stats,
                operationCount: this.imageReferenceManager.operationCount,
                operationThreshold: this.imageReferenceManager.operationThreshold
            };
        }
        return null;
    }

    /**
     * Ustawia próg operacji dla automatycznego GC
     */
    setGarbageCollectionThreshold(threshold) {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.setOperationThreshold(threshold);
        }
    }

    /**
     * Czyści zasoby canvas (wywoływane przy usuwaniu)
     */
    destroy() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.destroy();
        }
        log.info("Canvas destroyed");
    }

    async startMaskEditor() {
        const blob = await this.canvasLayers.getFlattenedCanvasAsBlob();
        if (!blob) {
            log.warn("Canvas is empty, cannot open mask editor.");
            return;
        }

        try {
            const formData = new FormData();
            const filename = `layerforge-mask-edit-${+new Date()}.png`;
            formData.append("image", blob, filename);
            formData.append("overwrite", "true");
            formData.append("type", "temp");

            const response = await api.fetchApi("/upload/image", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`Failed to upload image: ${response.statusText}`);
            }
            const data = await response.json();
            
            const img = new Image();
            img.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
            await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = rej;
            });
            
            this.node.imgs = [img];

            ComfyApp.copyToClipspace(this.node);
            ComfyApp.clipspace_return_node = this.node;
            ComfyApp.open_maskeditor();
            
            this.editorWasShowing = false;
            this.waitWhileMaskEditing();

        } catch (error) {
            log.error("Error preparing image for mask editor:", error);
            alert(`Error: ${error.message}`);
        }
    }

    waitWhileMaskEditing() {
        // Czekamy, aż edytor się pojawi, a potem zniknie.
        if (mask_editor_showing(app)) {
            this.editorWasShowing = true;
        }
        
        if (!mask_editor_showing(app) && this.editorWasShowing) {
             // Edytor był widoczny i już go nie ma
             this.editorWasShowing = false;
             setTimeout(() => this.handleMaskEditorClose(), 100); // Dajemy chwilę na aktualizację
        } else {
            setTimeout(this.waitWhileMaskEditing.bind(this), 100);
        }
    }

    async handleMaskEditorClose() {
        console.log("Node object after mask editor close:", this.node);
        if (!this.node.imgs || !this.node.imgs.length === 0 || !this.node.imgs[0].src) {
            log.warn("Mask editor was closed without a result.");
            return;
        }

        const resultImage = new Image();
        resultImage.src = this.node.imgs[0].src;

        try {
            await new Promise((resolve, reject) => {
                resultImage.onload = resolve;
                resultImage.onerror = reject;
            });
        } catch (error) {
            log.error("Failed to load image from mask editor.", error);
            this.node.imgs = [];
            return;
        }

        // Używamy wymiarów naszego płótna, aby zapewnić spójność
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d');
        
        // Rysujemy obrazek z edytora, który zawiera maskę w kanale alfa
        tempCtx.drawImage(resultImage, 0, 0, this.width, this.height);

        const imageData = tempCtx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
        const originalAlpha = data[i + 3];

        // Ustawiamy biały kolor
        data[i]     = 255; // R
        data[i + 1] = 255; // G
        data[i + 2] = 255; // B

        // Odwracamy kanał alfa
        data[i + 3] = 255 - originalAlpha;
        }

        tempCtx.putImageData(imageData, 0, 0);

        const maskAsImage = new Image();
        maskAsImage.src = tempCanvas.toDataURL();
        await new Promise(resolve => maskAsImage.onload = resolve);
        
        // Łączymy nową maskę z istniejącą, zamiast ją nadpisywać
        const maskCtx = this.maskTool.maskCtx;
        const destX = -this.maskTool.x;
        const destY = -this.maskTool.y;
        
        maskCtx.globalCompositeOperation = 'screen';
        maskCtx.drawImage(maskAsImage, destX, destY);
        maskCtx.globalCompositeOperation = 'source-over'; // Przywracamy domyślny tryb
        
        this.render();
        this.saveState();
        
        // Zaktualizuj podgląd węzła nowym, spłaszczonym obrazem
        const new_preview = new Image();
        const blob = await this.canvasLayers.getFlattenedCanvasAsBlob();
        if (blob) {
            new_preview.src = URL.createObjectURL(blob);
            await new Promise(r => new_preview.onload = r);
            this.node.imgs = [new_preview];
        } else {
            this.node.imgs = [];
        }

        this.render();
    }
}
