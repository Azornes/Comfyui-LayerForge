import {getCanvasState, setCanvasState, removeCanvasState, saveImage, getImage, removeImage} from "./db.js";
import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu CanvasState
const log = {
    debug: (...args) => logger.debug('CanvasState', ...args),
    info: (...args) => logger.info('CanvasState', ...args),
    warn: (...args) => logger.warn('CanvasState', ...args),
    error: (...args) => logger.error('CanvasState', ...args)
};

// Konfiguracja loggera dla modułu CanvasState
logger.setModuleLevel('CanvasState', LogLevel.DEBUG);

// Prosta funkcja generująca UUID
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export class CanvasState {
    constructor(canvas) {
        this.canvas = canvas;
        this.undoStack = [];
        this.redoStack = [];
        this.historyLimit = 100;
        this.saveTimeout = null;
        this.lastSavedStateSignature = null;
        this._loadInProgress = null;
    }

    cloneLayers(layers) {
        return layers.map(layer => {
            const newLayer = {...layer};
            // Obiekty Image nie są klonowane, aby oszczędzać pamięć
            return newLayer;
        });
    }

    getStateSignature(layers) {
        return JSON.stringify(layers.map(layer => {
            const sig = {...layer};
            if (sig.imageId) {
                sig.imageId = sig.imageId;
            }
            delete sig.image;
            return sig;
        }));
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

    async _performLoad() {
        try {
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

            this.canvas.updateCanvasSize(this.canvas.width, this.canvas.height, false);
            log.debug(`Canvas resized to ${this.canvas.width}x${this.canvas.height} and viewport set.`);

            const imagePromises = savedState.layers.map((layerData, index) => {
                return new Promise((resolve) => {
                    if (layerData.imageId) {
                        log.debug(`Layer ${index}: Loading image with id: ${layerData.imageId}`);
                        if (this.canvas.imageCache.has(layerData.imageId)) {
                            log.debug(`Layer ${index}: Image found in cache.`);
                            const imageSrc = this.canvas.imageCache.get(layerData.imageId);
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
                        } else {
                            getImage(layerData.imageId).then(imageSrc => {
                                if (imageSrc) {
                                    log.debug(`Layer ${index}: Loading image from data:URL...`);
                                    const img = new Image();
                                    img.onload = () => {
                                        log.debug(`Layer ${index}: Image loaded successfully.`);
                                        this.canvas.imageCache.set(layerData.imageId, imageSrc);
                                        const newLayer = {...layerData, image: img};
                                        delete newLayer.imageId;
                                        resolve(newLayer);
                                    };
                                    img.onerror = () => {
                                        log.error(`Layer ${index}: Failed to load image from src.`);
                                        resolve(null);
                                    };
                                    img.src = imageSrc;
                                } else {
                                    log.error(`Layer ${index}: Image not found in IndexedDB.`);
                                    resolve(null);
                                }
                            }).catch(err => {
                                log.error(`Layer ${index}: Error loading image from IndexedDB:`, err);
                                resolve(null);
                            });
                        }
                    } else if (layerData.imageSrc) {
                        log.info(`Layer ${index}: Found imageSrc, converting to new format with imageId.`);
                        const imageId = generateUUID();
                        saveImage(imageId, layerData.imageSrc).then(() => {
                            log.info(`Layer ${index}: Image saved to IndexedDB with id: ${imageId}`);
                            this.canvas.imageCache.set(imageId, layerData.imageSrc);
                            const img = new Image();
                            img.onload = () => {
                                log.debug(`Layer ${index}: Image loaded successfully from imageSrc.`);
                                const newLayer = {...layerData, image: img, imageId};
                                delete newLayer.imageSrc;
                                resolve(newLayer);
                            };
                            img.onerror = () => {
                                log.error(`Layer ${index}: Failed to load image from imageSrc.`);
                                resolve(null);
                            };
                            img.src = layerData.imageSrc;
                        }).catch(err => {
                            log.error(`Layer ${index}: Error saving image to IndexedDB:`, err);
                            resolve(null);
                        });
                    } else {
                        log.error(`Layer ${index}: No imageId or imageSrc found, skipping layer.`);
                        resolve(null);
                    }
                });
            });

            const loadedLayers = await Promise.all(imagePromises);
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
        } catch (e) {
            log.error("Error loading canvas state from IndexedDB:", e);
            await removeCanvasState(this.canvas.node.id).catch(err => log.error("Failed to remove corrupted state:", err));
            return false;
        }
    }

    async saveStateToDB(immediate = false) {
        log.info("Preparing to save state to IndexedDB for node:", this.canvas.node.id);
        if (!this.canvas.node.id) {
            log.error("Node ID is not available for saving state to DB.");
            return;
        }

        const currentStateSignature = this.getStateSignature(this.canvas.layers);
        if (this.lastSavedStateSignature === currentStateSignature) {
            log.debug("State unchanged, skipping save to IndexedDB.");
            return;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        const saveFunction = async () => {
            try {
                const state = {
                    layers: await Promise.all(this.canvas.layers.map(async (layer, index) => {
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
                    })),
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
            } catch (e) {
                log.error("Error saving canvas state to IndexedDB:", e);
            }
        };

        if (immediate) {
            await saveFunction();
        } else {
            this.saveTimeout = setTimeout(saveFunction, 1000);
        }
    }

    saveState(replaceLast = false) {
        if (replaceLast && this.undoStack.length > 0) {
            this.undoStack.pop();
        }

        const currentState = this.cloneLayers(this.canvas.layers);

        if (this.undoStack.length > 0) {
            const lastState = this.undoStack[this.undoStack.length - 1];
            if (this.getStateSignature(currentState) === this.getStateSignature(lastState)) {
                return;
            }
        }

        this.undoStack.push(currentState);

        if (this.undoStack.length > this.historyLimit) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.canvas.updateHistoryButtons();
        this.saveStateToDB();
    }

    undo() {
        if (this.undoStack.length <= 1) return;
        const currentState = this.undoStack.pop();
        this.redoStack.push(currentState);
        const prevState = this.undoStack[this.undoStack.length - 1];
        this.canvas.layers = this.cloneLayers(prevState);
        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const nextState = this.redoStack.pop();
        this.undoStack.push(nextState);
        this.canvas.layers = this.cloneLayers(nextState);
        this.canvas.updateSelectionAfterHistory();
        this.canvas.render();
        this.canvas.updateHistoryButtons();
    }
}