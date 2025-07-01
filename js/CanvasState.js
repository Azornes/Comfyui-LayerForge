import {getCanvasState, setCanvasState, saveImage, getImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {generateUUID, cloneLayers, getStateSignature, debounce} from "./utils/CommonUtils.js";
import {withErrorHandling} from "./ErrorHandler.js";

const log = createModuleLogger('CanvasState');

export class CanvasState {
    constructor(canvas) {
        this.canvas = canvas;
        this.layersUndoStack = [];
        this.layersRedoStack = [];
        this.maskUndoStack = [];
        this.maskRedoStack = [];
        this.historyLimit = 100;
        this.saveTimeout = null;
        this.lastSavedStateSignature = null;
        this._loadInProgress = null;
    }


    async loadStateFromDB() {
        if (this._loadInProgress) {
            log.warn("Load already in progress, waiting...");
            return this._loadInProgress;
        }

        log.info("Attempting to load state from IndexedDB for node:", this.canvas.node.id);
        if (!this.canvas.node.id) {
            log.error("Node ID is not available for loading state from DB.");
            return false;
        }

        this._loadInProgress = this._performLoad();

        try {
            const result = await this._loadInProgress;
            return result;
        } finally {
            this._loadInProgress = null;
        }
    }

    _performLoad = withErrorHandling(async () => {
        const savedState = await getCanvasState(this.canvas.node.id);
        if (!savedState) {
            log.info("No saved state found in IndexedDB for node:", this.canvas.node.id);
            return false;
        }
        log.info("Found saved state in IndexedDB.");
        this.canvas.width = savedState.width || 512;
        this.canvas.height = savedState.height || 512;
        this.canvas.viewport = savedState.viewport || {
            x: -(this.canvas.width / 4),
            y: -(this.canvas.height / 4),
            zoom: 0.8
        };

        this.canvas.updateOutputAreaSize(this.canvas.width, this.canvas.height, false);
        log.debug(`Output Area resized to ${this.canvas.width}x${this.canvas.height} and viewport set.`);
        const loadedLayers = await this._loadLayers(savedState.layers);
        this.canvas.layers = loadedLayers.filter(l => l !== null);
        log.info(`Loaded ${this.canvas.layers.length} layers.`);

        if (this.canvas.layers.length === 0) {
            log.warn("No valid layers loaded, state may be corrupted.");
            return false;
        }

        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        log.info("Canvas state loaded successfully from IndexedDB for node", this.canvas.node.id);
        return true;
    }, 'CanvasState._performLoad');

    /**
     * Ładuje warstwy z zapisanego stanu
     * @param {Array} layersData - Dane warstw do załadowania
     * @returns {Promise<Array>} Załadowane warstwy
     */
    async _loadLayers(layersData) {
        const imagePromises = layersData.map((layerData, index) =>
            this._loadSingleLayer(layerData, index)
        );
        return Promise.all(imagePromises);
    }

    /**
     * Ładuje pojedynczą warstwę
     * @param {Object} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @returns {Promise<Object|null>} Załadowana warstwa lub null
     */
    async _loadSingleLayer(layerData, index) {
        return new Promise((resolve) => {
            if (layerData.imageId) {
                this._loadLayerFromImageId(layerData, index, resolve);
            } else if (layerData.imageSrc) {
                this._convertLegacyLayer(layerData, index, resolve);
            } else {
                log.error(`Layer ${index}: No imageId or imageSrc found, skipping layer.`);
                resolve(null);
            }
        });
    }

    /**
     * Ładuje warstwę z imageId
     * @param {Object} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @param {Function} resolve - Funkcja resolve
     */
    _loadLayerFromImageId(layerData, index, resolve) {
        log.debug(`Layer ${index}: Loading image with id: ${layerData.imageId}`);

        if (this.canvas.imageCache.has(layerData.imageId)) {
            log.debug(`Layer ${index}: Image found in cache.`);
            const imageSrc = this.canvas.imageCache.get(layerData.imageId);
            this._createLayerFromSrc(layerData, imageSrc, index, resolve);
        } else {
            getImage(layerData.imageId)
                .then(imageSrc => {
                    if (imageSrc) {
                        log.debug(`Layer ${index}: Loading image from data:URL...`);
                        this.canvas.imageCache.set(layerData.imageId, imageSrc);
                        this._createLayerFromSrc(layerData, imageSrc, index, resolve);
                    } else {
                        log.error(`Layer ${index}: Image not found in IndexedDB.`);
                        resolve(null);
                    }
                })
                .catch(err => {
                    log.error(`Layer ${index}: Error loading image from IndexedDB:`, err);
                    resolve(null);
                });
        }
    }

    /**
     * Konwertuje starą warstwę z imageSrc na nowy format
     * @param {Object} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @param {Function} resolve - Funkcja resolve
     */
    _convertLegacyLayer(layerData, index, resolve) {
        log.info(`Layer ${index}: Found imageSrc, converting to new format with imageId.`);
        const imageId = generateUUID();

        saveImage(imageId, layerData.imageSrc)
            .then(() => {
                log.info(`Layer ${index}: Image saved to IndexedDB with id: ${imageId}`);
                this.canvas.imageCache.set(imageId, layerData.imageSrc);
                const newLayerData = {...layerData, imageId};
                delete newLayerData.imageSrc;
                this._createLayerFromSrc(newLayerData, layerData.imageSrc, index, resolve);
            })
            .catch(err => {
                log.error(`Layer ${index}: Error saving image to IndexedDB:`, err);
                resolve(null);
            });
    }

    /**
     * Tworzy warstwę z src obrazu
     * @param {Object} layerData - Dane warstwy
     * @param {string} imageSrc - Źródło obrazu
     * @param {number} index - Indeks warstwy
     * @param {Function} resolve - Funkcja resolve
     */
    _createLayerFromSrc(layerData, imageSrc, index, resolve) {
        const img = new Image();
        img.onload = () => {
            log.debug(`Layer ${index}: Image loaded successfully.`);
            const newLayer = {...layerData, image: img};
            delete newLayer.imageId;
            resolve(newLayer);
        };
        img.onerror = () => {
            log.error(`Layer ${index}: Failed to load image from src.`);
            resolve(null);
        };
        img.src = imageSrc;
    }

    async saveStateToDB(immediate = false) {
        log.info("Preparing to save state to IndexedDB for node:", this.canvas.node.id);
        if (!this.canvas.node.id) {
            log.error("Node ID is not available for saving state to DB.");
            return;
        }

        const currentStateSignature = getStateSignature(this.canvas.layers);
        if (this.lastSavedStateSignature === currentStateSignature) {
            log.debug("State unchanged, skipping save to IndexedDB.");
            return;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        const saveFunction = withErrorHandling(async () => {
            const state = {
                layers: await this._prepareLayers(),
                viewport: this.canvas.viewport,
                width: this.canvas.width,
                height: this.canvas.height,
            };

            state.layers = state.layers.filter(layer => layer !== null);
            if (state.layers.length === 0) {
                log.warn("No valid layers to save, skipping save to IndexedDB.");
                return;
            }

            await setCanvasState(this.canvas.node.id, state);
            log.info("Canvas state saved to IndexedDB.");
            this.lastSavedStateSignature = currentStateSignature;
            this.canvas.render();
        }, 'CanvasState.saveStateToDB');

        if (immediate) {
            await saveFunction();
        } else {
            this.saveTimeout = setTimeout(saveFunction, 1000);
        }
    }

    /**
     * Przygotowuje warstwy do zapisu
     * @returns {Promise<Array>} Przygotowane warstwy
     */
    async _prepareLayers() {
        return Promise.all(this.canvas.layers.map(async (layer, index) => {
            const newLayer = {...layer};
            if (layer.image instanceof HTMLImageElement) {
                log.debug(`Layer ${index}: Using imageId instead of serializing image.`);
                if (!layer.imageId) {
                    layer.imageId = generateUUID();
                    await saveImage(layer.imageId, layer.image.src);
                    this.canvas.imageCache.set(layer.imageId, layer.image.src);
                }
                newLayer.imageId = layer.imageId;
            } else if (!layer.imageId) {
                log.error(`Layer ${index}: No image or imageId found, skipping layer.`);
                return null;
            }
            delete newLayer.image;
            return newLayer;
        }));
    }

    saveState(replaceLast = false) {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.saveMaskState(replaceLast);
        } else {
            this.saveLayersState(replaceLast);
        }
    }

    saveLayersState(replaceLast = false) {
        if (replaceLast && this.layersUndoStack.length > 0) {
            this.layersUndoStack.pop();
        }

        const currentState = cloneLayers(this.canvas.layers);

        if (this.layersUndoStack.length > 0) {
            const lastState = this.layersUndoStack[this.layersUndoStack.length - 1];
            if (getStateSignature(currentState) === getStateSignature(lastState)) {
                return;
            }
        }

        this.layersUndoStack.push(currentState);

        if (this.layersUndoStack.length > this.historyLimit) {
            this.layersUndoStack.shift();
        }
        this.layersRedoStack = [];
        this.canvas.updateHistoryButtons();
        this._debouncedSave = this._debouncedSave || debounce(() => this.saveStateToDB(), 500);
        this._debouncedSave();
    }

    saveMaskState(replaceLast = false) {
        if (!this.canvas.maskTool) return;

        if (replaceLast && this.maskUndoStack.length > 0) {
            this.maskUndoStack.pop();
        }
        const maskCanvas = this.canvas.maskTool.getMask();
        const clonedCanvas = document.createElement('canvas');
        clonedCanvas.width = maskCanvas.width;
        clonedCanvas.height = maskCanvas.height;
        const clonedCtx = clonedCanvas.getContext('2d');
        clonedCtx.drawImage(maskCanvas, 0, 0);

        this.maskUndoStack.push(clonedCanvas);

        if (this.maskUndoStack.length > this.historyLimit) {
            this.maskUndoStack.shift();
        }
        this.maskRedoStack = [];
        this.canvas.updateHistoryButtons();
    }

    undo() {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.undoMaskState();
        } else {
            this.undoLayersState();
        }
    }

    redo() {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.redoMaskState();
        } else {
            this.redoLayersState();
        }
    }

    undoLayersState() {
        if (this.layersUndoStack.length <= 1) return;

        const currentState = this.layersUndoStack.pop();
        this.layersRedoStack.push(currentState);
        const prevState = this.layersUndoStack[this.layersUndoStack.length - 1];
        this.canvas.layers = cloneLayers(prevState);
        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }

    redoLayersState() {
        if (this.layersRedoStack.length === 0) return;

        const nextState = this.layersRedoStack.pop();
        this.layersUndoStack.push(nextState);
        this.canvas.layers = cloneLayers(nextState);
        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }

    undoMaskState() {
        if (!this.canvas.maskTool || this.maskUndoStack.length <= 1) return;

        const currentState = this.maskUndoStack.pop();
        this.maskRedoStack.push(currentState);

        if (this.maskUndoStack.length > 0) {
            const prevState = this.maskUndoStack[this.maskUndoStack.length - 1];
            const maskCanvas = this.canvas.maskTool.getMask();
            const maskCtx = maskCanvas.getContext('2d');
            maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            maskCtx.drawImage(prevState, 0, 0);

            this.canvas.render();
        }

        this.canvas.updateHistoryButtons();
    }

    redoMaskState() {
        if (!this.canvas.maskTool || this.maskRedoStack.length === 0) return;

        const nextState = this.maskRedoStack.pop();
        this.maskUndoStack.push(nextState);
        const maskCanvas = this.canvas.maskTool.getMask();
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(nextState, 0, 0);

        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }

    /**
     * Czyści historię undo/redo
     */
    clearHistory() {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.maskUndoStack = [];
            this.maskRedoStack = [];
        } else {
            this.layersUndoStack = [];
            this.layersRedoStack = [];
        }
        this.canvas.updateHistoryButtons();
        log.info("History cleared");
    }

    /**
     * Zwraca informacje o historii
     * @returns {Object} Informacje o historii
     */
    getHistoryInfo() {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            return {
                undoCount: this.maskUndoStack.length,
                redoCount: this.maskRedoStack.length,
                canUndo: this.maskUndoStack.length > 1,
                canRedo: this.maskRedoStack.length > 0,
                historyLimit: this.historyLimit
            };
        } else {
            return {
                undoCount: this.layersUndoStack.length,
                redoCount: this.layersRedoStack.length,
                canUndo: this.layersUndoStack.length > 1,
                canRedo: this.layersRedoStack.length > 0,
                historyLimit: this.historyLimit
            };
        }
    }
}
