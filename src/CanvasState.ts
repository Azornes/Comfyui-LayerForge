import {getCanvasState, setCanvasState, saveImage, getImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {showAlertNotification, showAllNotificationTypes} from "./utils/NotificationUtils.js";
import {generateUUID, cloneLayers, getStateSignature, debounce, createCanvas} from "./utils/CommonUtils.js";
import {withErrorHandling} from "./ErrorHandler.js";
import type { Canvas } from './Canvas';
import type { Layer, ComfyNode } from './types';

const log = createModuleLogger('CanvasState');

interface HistoryInfo {
    undoCount: number;
    redoCount: number;
    canUndo: boolean;
    canRedo: boolean;
    historyLimit: number;
}

export class CanvasState {
    private _debouncedSave: (() => void) | null;
    private _loadInProgress: Promise<boolean> | null;
    private canvas: Canvas & { node: ComfyNode, layers: Layer[] };
    private historyLimit: number;
    private lastSavedStateSignature: string | null;
    public layersRedoStack: Layer[][];
    public layersUndoStack: Layer[][];
    public maskRedoStack: HTMLCanvasElement[];
    public maskUndoStack: HTMLCanvasElement[];
    private saveTimeout: number | null;
    private stateSaverWorker: Worker | null;

    constructor(canvas: Canvas & { node: ComfyNode, layers: Layer[] }) {
        this.canvas = canvas;
        this.layersUndoStack = [];
        this.layersRedoStack = [];
        this.maskUndoStack = [];
        this.maskRedoStack = [];
        this.historyLimit = 100;
        this.saveTimeout = null;
        this.lastSavedStateSignature = null;
        this._loadInProgress = null;
        this._debouncedSave = null;

        try {
            // @ts-ignore
            this.stateSaverWorker = new Worker(new URL('./state-saver.worker.js', import.meta.url), { type: 'module' });
            log.info("State saver worker initialized successfully.");
            
            this.stateSaverWorker.onmessage = (e: MessageEvent) => {
                log.info("Message from state saver worker:", e.data);
            };
            this.stateSaverWorker.onerror = (e: ErrorEvent) => {
                log.error("Error in state saver worker:", e.message, e.filename, e.lineno);
                this.stateSaverWorker = null; 
            };
        } catch (e) {
            log.error("Failed to initialize state saver worker:", e);
            this.stateSaverWorker = null;
        }
    }

    async loadStateFromDB(): Promise<boolean> {
        if (this._loadInProgress) {
            log.warn("Load already in progress, waiting...");
            return this._loadInProgress;
        }

        log.info("Attempting to load state from IndexedDB for node:", this.canvas.node.id);
        const loadPromise = this._performLoad();
        this._loadInProgress = loadPromise;

        try {
            const result = await loadPromise;
            this._loadInProgress = null;
            return result;
        } catch (error) {
            this._loadInProgress = null;
            throw error;
        }
    }

    async _performLoad(): Promise<boolean> {
        try {
            if (!this.canvas.node.id) {
                log.error("Node ID is not available for loading state from DB.");
                return false;
            }
            const savedState = await getCanvasState(String(this.canvas.node.id));
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

            // Restore outputAreaBounds if saved, otherwise use default
            if (savedState.outputAreaBounds) {
                this.canvas.outputAreaBounds = savedState.outputAreaBounds;
                log.debug(`Output Area bounds restored: x=${this.canvas.outputAreaBounds.x}, y=${this.canvas.outputAreaBounds.y}, w=${this.canvas.outputAreaBounds.width}, h=${this.canvas.outputAreaBounds.height}`);
            } else {
                // Fallback to default positioning for legacy saves
                this.canvas.outputAreaBounds = {
                    x: -(this.canvas.width / 4),
                    y: -(this.canvas.height / 4),
                    width: this.canvas.width,
                    height: this.canvas.height
                };
                log.debug(`Output Area bounds set to default: x=${this.canvas.outputAreaBounds.x}, y=${this.canvas.outputAreaBounds.y}, w=${this.canvas.outputAreaBounds.width}, h=${this.canvas.outputAreaBounds.height}`);
            }

            this.canvas.canvasLayers.updateOutputAreaSize(this.canvas.width, this.canvas.height, false);
            log.debug(`Output Area resized to ${this.canvas.width}x${this.canvas.height} and viewport set.`);
            const loadedLayers = await this._loadLayers(savedState.layers);
            this.canvas.layers = loadedLayers.filter((l): l is Layer => l !== null);
            log.info(`Loaded ${this.canvas.layers.length} layers from ${savedState.layers.length} saved layers.`);

            if (this.canvas.layers.length === 0 && savedState.layers.length > 0) {
                log.warn(`Failed to load any layers. Saved state had ${savedState.layers.length} layers but all failed to load. This may indicate corrupted IndexedDB data.`);
                // Don't return false - allow empty canvas to be valid
            }

            this.canvas.updateSelectionAfterHistory();
            this.canvas.render();
            log.info("Canvas state loaded successfully from IndexedDB for node", this.canvas.node.id);
            return true;
        } catch (error) {
            log.error("Error during state load:", error);
            return false;
        }
    }

    /**
     * Ładuje warstwy z zapisanego stanu
     * @param {any[]} layersData - Dane warstw do załadowania
     * @returns {Promise<(Layer | null)[]>} Załadowane warstwy
     */
    async _loadLayers(layersData: any[]): Promise<(Layer | null)[]> {
        const imagePromises = layersData.map((layerData: any, index: number) =>
            this._loadSingleLayer(layerData, index)
        );
        return Promise.all(imagePromises);
    }

    /**
     * Ładuje pojedynczą warstwę
     * @param {any} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @returns {Promise<Layer | null>} Załadowana warstwa lub null
     */
    async _loadSingleLayer(layerData: Layer, index: number): Promise<Layer | null> {
        return new Promise((resolve) => {
            if (layerData.imageId) {
                this._loadLayerFromImageId(layerData, index, resolve);
            } else if ((layerData as any).imageSrc) {
                this._convertLegacyLayer(layerData, index, resolve);
            } else {
                log.error(`Layer ${index}: No imageId or imageSrc found, skipping layer.`);
                resolve(null);
            }
        });
    }

    /**
     * Ładuje warstwę z imageId
     * @param {any} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @param {(value: Layer | null) => void} resolve - Funkcja resolve
     */
    _loadLayerFromImageId(layerData: Layer, index: number, resolve: (value: Layer | null) => void): void {
        log.debug(`Layer ${index}: Loading image with id: ${layerData.imageId}`);

        if (this.canvas.imageCache.has(layerData.imageId)) {
            log.debug(`Layer ${index}: Image found in cache.`);
            const imageData = this.canvas.imageCache.get(layerData.imageId);
            if (imageData) {
                const imageSrc = URL.createObjectURL(new Blob([imageData.data]));
                this._createLayerFromSrc(layerData, imageSrc, index, resolve);
            } else {
                resolve(null);
            }
        } else {
            getImage(layerData.imageId)
                .then(imageSrc => {
                    if (imageSrc) {
                        log.debug(`Layer ${index}: Loading image from data:URL...`);
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
     * @param {any} layerData - Dane warstwy
     * @param {number} index - Indeks warstwy
     * @param {(value: Layer | null) => void} resolve - Funkcja resolve
     */
    _convertLegacyLayer(layerData: Layer, index: number, resolve: (value: Layer | null) => void): void {
        log.info(`Layer ${index}: Found imageSrc, converting to new format with imageId.`);
        const imageId = generateUUID();

        saveImage(imageId, (layerData as any).imageSrc)
            .then(() => {
                log.info(`Layer ${index}: Image saved to IndexedDB with id: ${imageId}`);
                const newLayerData = {...layerData, imageId};
                delete (newLayerData as any).imageSrc;
                this._createLayerFromSrc(newLayerData, (layerData as any).imageSrc, index, resolve);
            })
            .catch(err => {
                log.error(`Layer ${index}: Error saving image to IndexedDB:`, err);
                resolve(null);
            });
    }

    /**
     * Tworzy warstwę z src obrazu
     * @param {any} layerData - Dane warstwy
     * @param {string} imageSrc - Źródło obrazu
     * @param {number} index - Indeks warstwy
     * @param {(value: Layer | null) => void} resolve - Funkcja resolve
     */
    _createLayerFromSrc(layerData: Layer, imageSrc: string | ImageBitmap, index: number, resolve: (value: Layer | null) => void): void {
        if (typeof imageSrc === 'string') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                log.debug(`Layer ${index}: Image loaded successfully.`);
                const newLayer: Layer = {...layerData, image: img};
                resolve(newLayer);
            };
            img.onerror = () => {
                log.error(`Layer ${index}: Failed to load image from src.`);
                resolve(null);
            };
            img.src = imageSrc;
        } else {
            const { canvas, ctx } = createCanvas(imageSrc.width, imageSrc.height);
            if (ctx) {
                ctx.drawImage(imageSrc, 0, 0);
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    log.debug(`Layer ${index}: Image loaded successfully from ImageBitmap.`);
                    const newLayer: Layer = {...layerData, image: img};
                    resolve(newLayer);
                };
                img.onerror = () => {
                    log.error(`Layer ${index}: Failed to load image from ImageBitmap.`);
                    resolve(null);
                };
                img.src = canvas.toDataURL();
            } else {
                log.error(`Layer ${index}: Failed to get 2d context from canvas.`);
                resolve(null);
            }
        }
    }

    async saveStateToDB(): Promise<void> {
        if (!this.canvas.node.id) {
            log.error("Node ID is not available for saving state to DB.");
            return;
        }

        // Auto-correct node_id widget if needed before saving state
        if (this.canvas.node && this.canvas.node.widgets) {
            const nodeIdWidget = this.canvas.node.widgets.find((w: any) => w.name === "node_id");
            if (nodeIdWidget) {
                const correctId = String(this.canvas.node.id);
                if (nodeIdWidget.value !== correctId) {
                    const prevValue = nodeIdWidget.value;
                    nodeIdWidget.value = correctId;
                    log.warn(`[CanvasState] node_id widget value (${prevValue}) did not match node.id (${correctId}) - auto-corrected (saveStateToDB).`);
                    showAlertNotification(
                        `The value of node_id (${prevValue}) did not match the node number (${correctId}) and was automatically corrected. 
If you see dark images or masks in the output, make sure node_id is set to ${correctId}.`
                    );
                }
            }
        }

        log.info("Preparing state to be sent to worker...");
        const layers = await this._prepareLayers();
        const state = {
            layers: layers.filter(layer => layer !== null),
            viewport: this.canvas.viewport,
            width: this.canvas.width,
            height: this.canvas.height,
            outputAreaBounds: this.canvas.outputAreaBounds,
        };

        if (state.layers.length === 0) {
            log.warn("No valid layers to save, skipping.");
            return;
        }

        if (this.stateSaverWorker) {
            log.info("Posting state to worker for background saving.");
            this.stateSaverWorker.postMessage({
                nodeId: String(this.canvas.node.id),
                state: state
            });
            this.canvas.render();
        } else {
            log.warn("State saver worker not available. Saving on main thread.");
            await setCanvasState(String(this.canvas.node.id), state);
        }
    }

    /**
     * Przygotowuje warstwy do zapisu
     * @returns {Promise<(Omit<Layer, 'image'> & { imageId: string })[]>} Przygotowane warstwy
     */
    async _prepareLayers(): Promise<(Omit<Layer, 'image'> & { imageId: string })[]> {
        const preparedLayers = await Promise.all(this.canvas.layers.map(async (layer: Layer, index: number) => {
            const newLayer: Omit<Layer, 'image'> & { imageId: string } = { ...layer, imageId: layer.imageId || '' };
            delete (newLayer as any).image;

            if (layer.image instanceof HTMLImageElement) {
                if (layer.imageId) {
                    newLayer.imageId = layer.imageId;
                } else {
                    log.debug(`Layer ${index}: No imageId found, generating new one and saving image.`);
                    newLayer.imageId = generateUUID();
                    const imageBitmap = await createImageBitmap(layer.image);
                    await saveImage(newLayer.imageId, imageBitmap);
                }
            } else if (!layer.imageId) {
                log.error(`Layer ${index}: No image or imageId found, skipping layer.`);
                return null;
            }
            return newLayer;
        }));
        return preparedLayers.filter((layer): layer is Omit<Layer, 'image'> & { imageId: string } => layer !== null);
    }

    saveState(replaceLast = false): void {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.saveMaskState(replaceLast);
        } else {
            this.saveLayersState(replaceLast);
        }
    }

    saveLayersState(replaceLast = false): void {
        if (replaceLast && this.layersUndoStack.length > 0) {
            this.layersUndoStack.pop();
        }

        const currentState = cloneLayers(this.canvas.layers);
        const currentStateSignature = getStateSignature(currentState);

        if (this.layersUndoStack.length > 0) {
            const lastState = this.layersUndoStack[this.layersUndoStack.length - 1];
            if (getStateSignature(lastState) === currentStateSignature) {
                return;
            }
        }
        
        this.layersUndoStack.push(currentState);

        if (this.layersUndoStack.length > this.historyLimit) {
            this.layersUndoStack.shift();
        }
        this.layersRedoStack = [];
        this.canvas.updateHistoryButtons();
        
        if (!this._debouncedSave) {
            this._debouncedSave = debounce(this.saveStateToDB.bind(this), 1000);
        }
        this._debouncedSave();
    }

    saveMaskState(replaceLast = false): void {
        if (!this.canvas.maskTool) return;

        if (replaceLast && this.maskUndoStack.length > 0) {
            this.maskUndoStack.pop();
        }
        const maskCanvas = this.canvas.maskTool.getMask();
        const { canvas: clonedCanvas, ctx: clonedCtx } = createCanvas(maskCanvas.width, maskCanvas.height, '2d', { willReadFrequently: true });
        if (clonedCtx) {
            clonedCtx.drawImage(maskCanvas, 0, 0);
        }

        this.maskUndoStack.push(clonedCanvas);

        if (this.maskUndoStack.length > this.historyLimit) {
            this.maskUndoStack.shift();
        }
        this.maskRedoStack = [];
        this.canvas.updateHistoryButtons();
    }

    undo(): void {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.undoMaskState();
        } else {
            this.undoLayersState();
        }
    }

    redo(): void {
        if (this.canvas.maskTool && this.canvas.maskTool.isActive) {
            this.redoMaskState();
        } else {
            this.redoLayersState();
        }
    }

    undoLayersState(): void {
        if (this.layersUndoStack.length <= 1) return;

        const currentState = this.layersUndoStack.pop();
        if (currentState) {
            this.layersRedoStack.push(currentState);
        }
        const prevState = this.layersUndoStack[this.layersUndoStack.length - 1];
        this.canvas.layers = cloneLayers(prevState);
        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }

    redoLayersState(): void {
        if (this.layersRedoStack.length === 0) return;

        const nextState = this.layersRedoStack.pop();
        if (nextState) {
            this.layersUndoStack.push(nextState);
            this.canvas.layers = cloneLayers(nextState);
            this.canvas.updateSelectionAfterHistory();
            this.canvas.render();
            this.canvas.updateHistoryButtons();
        }
    }

    undoMaskState(): void {
        if (!this.canvas.maskTool || this.maskUndoStack.length <= 1) return;

        const currentState = this.maskUndoStack.pop();
        if (currentState) {
            this.maskRedoStack.push(currentState);
        }

        if (this.maskUndoStack.length > 0) {
            const prevState = this.maskUndoStack[this.maskUndoStack.length - 1];
            
            // Use the new restoreMaskFromSavedState method that properly clears chunks first
            this.canvas.maskTool.restoreMaskFromSavedState(prevState);
            
            // Clear stroke overlay to prevent old drawing previews from persisting
            this.canvas.canvasRenderer.clearMaskStrokeOverlay();
            
            this.canvas.render();
        }

        this.canvas.updateHistoryButtons();
    }

    redoMaskState(): void {
        if (!this.canvas.maskTool || this.maskRedoStack.length === 0) return;

        const nextState = this.maskRedoStack.pop();
        if (nextState) {
            this.maskUndoStack.push(nextState);
            
            // Use the new restoreMaskFromSavedState method that properly clears chunks first
            this.canvas.maskTool.restoreMaskFromSavedState(nextState);
            
            // Clear stroke overlay to prevent old drawing previews from persisting
            this.canvas.canvasRenderer.clearMaskStrokeOverlay();
            
            this.canvas.render();
        }
        this.canvas.updateHistoryButtons();
    }

    /**
     * Czyści historię undo/redo
     */
    clearHistory(): void {
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
     * @returns {HistoryInfo} Informacje o historii
     */
    getHistoryInfo(): HistoryInfo {
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
