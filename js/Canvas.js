import {saveImage, getImage, removeImage} from "./db.js";
import {MaskTool} from "./Mask_tool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
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
        // Globalna mapa do śledzenia zapisów dla wszystkich node-ów
        if (!window.canvasSaveStates) {
            window.canvasSaveStates = new Map();
        }
        
        const nodeId = this.node.id;
        const saveKey = `${nodeId}_${fileName}`;
        
        // Sprawdź czy już trwa zapis dla tego node-a i pliku
        if (this._saveInProgress || window.canvasSaveStates.get(saveKey)) {
            log.warn(`Save already in progress for node ${nodeId}, waiting...`);
            return this._saveInProgress || window.canvasSaveStates.get(saveKey);
        }

        log.info(`Starting saveToServer with fileName: ${fileName} for node: ${nodeId}`);
        log.debug(`Canvas dimensions: ${this.width}x${this.height}`);
        log.debug(`Number of layers: ${this.layers.length}`);
        
        // Utwórz Promise dla aktualnego zapisu
        this._saveInProgress = this._performSave(fileName);
        window.canvasSaveStates.set(saveKey, this._saveInProgress);
        
        try {
            const result = await this._saveInProgress;
            return result;
        } finally {
            this._saveInProgress = null;
            window.canvasSaveStates.delete(saveKey);
            log.debug(`Save completed for node ${nodeId}, lock released`);
        }
    }

    async _performSave(fileName) {
        // Sprawdź czy są warstwy do zapisania
        if (this.layers.length === 0) {
            log.warn(`Node ${this.node.id} has no layers, creating empty canvas`);
            // Zwróć sukces ale nie zapisuj pustego canvas-a na serwer
            return Promise.resolve(true);
        }

        // Zapisz stan do IndexedDB przed zapisem na serwer
        await this.saveStateToDB(true);

        // Dodaj krótkie opóźnienie dla różnych node-ów, aby uniknąć konfliktów
        const nodeId = this.node.id;
        const delay = (nodeId % 10) * 50; // 0-450ms opóźnienia w zależności od ID node-a
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return new Promise((resolve) => {
            const tempCanvas = document.createElement('canvas');
            const maskCanvas = document.createElement('canvas');
            tempCanvas.width = this.width;
            tempCanvas.height = this.height;
            maskCanvas.width = this.width;
            maskCanvas.height = this.height;

            const tempCtx = tempCanvas.getContext('2d');
            const maskCtx = maskCanvas.getContext('2d');

            tempCtx.fillStyle = '#ffffff';
            tempCtx.fillRect(0, 0, this.width, this.height);

            // Tworzymy tymczasowy canvas do renderowania warstw i maski
            const visibilityCanvas = document.createElement('canvas');
            visibilityCanvas.width = this.width;
            visibilityCanvas.height = this.height;
            const visibilityCtx = visibilityCanvas.getContext('2d', { alpha: true });
            
            // Czarne tło (całkowicie przezroczyste w masce)
            maskCtx.fillStyle = '#ffffff'; // Białe tło dla wolnych przestrzeni
            maskCtx.fillRect(0, 0, this.width, this.height);
            
            log.debug(`Canvas contexts created, starting layer rendering`);

            // Rysowanie warstw
            const sortedLayers = this.layers.sort((a, b) => a.zIndex - b.zIndex);
            log.debug(`Processing ${sortedLayers.length} layers in order`);
            
            // Najpierw renderujemy wszystkie warstwy do głównego obrazu
            sortedLayers.forEach((layer, index) => {
                log.debug(`Processing layer ${index}: zIndex=${layer.zIndex}, size=${layer.width}x${layer.height}, pos=(${layer.x},${layer.y})`);
                log.debug(`Layer ${index}: blendMode=${layer.blendMode || 'normal'}, opacity=${layer.opacity !== undefined ? layer.opacity : 1}`);
                
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                tempCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
                
                log.debug(`Layer ${index} rendered successfully`);

                // Renderujemy również do canvas widoczności, aby śledzić, które piksele są widoczne
                visibilityCtx.save();
                visibilityCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                visibilityCtx.rotate(layer.rotation * Math.PI / 180);
                visibilityCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                visibilityCtx.restore();
            });
            
            // Teraz tworzymy maskę na podstawie widoczności pikseli, zachowując stopień przezroczystości
            const visibilityData = visibilityCtx.getImageData(0, 0, this.width, this.height);
            const maskData = maskCtx.getImageData(0, 0, this.width, this.height);
            
            // Używamy wartości alpha do określenia stopnia przezroczystości w masce
            for (let i = 0; i < visibilityData.data.length; i += 4) {
                const alpha = visibilityData.data[i + 3];
                // Odwracamy wartość alpha (255 - alpha), aby zachować logikę maski:
                // - Przezroczyste piksele w obrazie (alpha = 0) -> białe w masce (255)
                // - Nieprzezroczyste piksele w obrazie (alpha = 255) -> czarne w masce (0)
                // - Częściowo przezroczyste piksele zachowują proporcjonalną wartość
                const maskValue = 255 - alpha;
                maskData.data[i] = maskData.data[i + 1] = maskData.data[i + 2] = maskValue;
                maskData.data[i + 3] = 255; // Maska zawsze ma pełną nieprzezroczystość
            }
            
            maskCtx.putImageData(maskData, 0, 0);

            // Nałóż maskę z narzędzia MaskTool, uwzględniając przezroczystość pędzla
            const toolMaskCanvas = this.maskTool.getMask();
            if (toolMaskCanvas) {
                // Utwórz tymczasowy canvas, aby zachować wartości alpha maski z MaskTool
                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.width;
                tempMaskCanvas.height = this.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d');
                tempMaskCtx.drawImage(toolMaskCanvas, 0, 0);
                const tempMaskData = tempMaskCtx.getImageData(0, 0, this.width, this.height);

                // Zachowaj wartości alpha, aby obszary narysowane pędzlem były nieprzezroczyste na masce
                for (let i = 0; i < tempMaskData.data.length; i += 4) {
                    const alpha = tempMaskData.data[i + 3];
                    tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = 255;
                    tempMaskData.data[i + 3] = alpha; // Zachowaj oryginalną przezroczystość pędzla
                }
                tempMaskCtx.putImageData(tempMaskData, 0, 0);

                // Nałóż maskę z MaskTool na maskę główną
                maskCtx.globalCompositeOperation = 'source-over'; // Dodaje nieprzezroczystość tam, gdzie pędzel był użyty
                maskCtx.drawImage(tempMaskCanvas, 0, 0);
            }

            // Zapisz obraz bez maski
            const fileNameWithoutMask = fileName.replace('.png', '_without_mask.png');
            log.info(`Saving image without mask as: ${fileNameWithoutMask}`);
            
            tempCanvas.toBlob(async (blobWithoutMask) => {
                log.debug(`Created blob for image without mask, size: ${blobWithoutMask.size} bytes`);
                const formDataWithoutMask = new FormData();
                formDataWithoutMask.append("image", blobWithoutMask, fileNameWithoutMask);
                formDataWithoutMask.append("overwrite", "true");

                try {
                    const response = await fetch("/upload/image", {
                        method: "POST",
                        body: formDataWithoutMask,
                    });
                    log.debug(`Image without mask upload response: ${response.status}`);
                } catch (error) {
                    log.error(`Error uploading image without mask:`, error);
                }
            }, "image/png");

            // Zapisz obraz z maską
            log.info(`Saving main image as: ${fileName}`);
            tempCanvas.toBlob(async (blob) => {
                log.debug(`Created blob for main image, size: ${blob.size} bytes`);
                const formData = new FormData();
                formData.append("image", blob, fileName);
                formData.append("overwrite", "true");

                try {
                    const resp = await fetch("/upload/image", {
                        method: "POST",
                        body: formData,
                    });
                    log.debug(`Main image upload response: ${resp.status}`);

                    if (resp.status === 200) {
                        const maskFileName = fileName.replace('.png', '_mask.png');
                        log.info(`Saving mask as: ${maskFileName}`);
                        
                        maskCanvas.toBlob(async (maskBlob) => {
                            log.debug(`Created blob for mask, size: ${maskBlob.size} bytes`);
                            const maskFormData = new FormData();
                            maskFormData.append("image", maskBlob, maskFileName);
                            maskFormData.append("overwrite", "true");

                            try {
                                const maskResp = await fetch("/upload/image", {
                                    method: "POST",
                                    body: maskFormData,
                                });
                                log.debug(`Mask upload response: ${maskResp.status}`);

                                if (maskResp.status === 200) {
                                    const data = await resp.json();
                                    // Ustaw widget.value na rzeczywistą nazwę zapisanego pliku (unikalną)
                                    // aby node zwracał właściwy plik
                                    this.widget.value = fileName;
                                    log.info(`All files saved successfully, widget value set to: ${fileName}`);
                                    resolve(true);
                                } else {
                                    log.error(`Error saving mask: ${maskResp.status}`);
                                    resolve(false);
                                }
                            } catch (error) {
                                log.error(`Error saving mask:`, error);
                                resolve(false);
                            }
                        }, "image/png");
                    } else {
                        log.error(`Main image upload failed: ${resp.status} - ${resp.statusText}`);
                        resolve(false);
                    }
                } catch (error) {
                    log.error(`Error uploading main image:`, error);
                    resolve(false);
                }
            }, "image/png");
        });
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
        try {
            log.debug("Adding input to canvas:", {inputImage});

            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = inputImage.width;
            tempCanvas.height = inputImage.height;

            const imgData = new ImageData(
                inputImage.data,
                inputImage.width,
                inputImage.height
            );
            tempCtx.putImageData(imgData, 0, 0);

            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
                image.src = tempCanvas.toDataURL();
            });

            const scale = Math.min(
                this.width / inputImage.width * 0.8,
                this.height / inputImage.height * 0.8
            );

            const layer = await this.addLayerWithImage(image, {
                x: (this.width - inputImage.width * scale) / 2,
                y: (this.height - inputImage.height * scale) / 2,
                width: inputImage.width * scale,
                height: inputImage.height * scale,
            });

            if (inputMask) {
                layer.mask = inputMask.data;
            }

            log.info("Layer added successfully");
            return true;

        } catch (error) {
            log.error("Error in addInputToCanvas:", error);
            throw error;
        }
    }

    async convertTensorToImage(tensor) {
        try {
            log.debug("Converting tensor to image:", tensor);

            if (!tensor || !tensor.data || !tensor.width || !tensor.height) {
                throw new Error("Invalid tensor data");
            }

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = tensor.width;
            canvas.height = tensor.height;

            const imageData = new ImageData(
                new Uint8ClampedArray(tensor.data),
                tensor.width,
                tensor.height
            );

            ctx.putImageData(imageData, 0, 0);

            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = (e) => reject(new Error("Failed to load image: " + e));
                img.src = canvas.toDataURL();
            });
        } catch (error) {
            log.error("Error converting tensor to image:", error);
            throw error;
        }
    }

    async convertTensorToMask(tensor) {
        if (!tensor || !tensor.data) {
            throw new Error("Invalid mask tensor");
        }

        try {

            return new Float32Array(tensor.data);
        } catch (error) {
            throw new Error(`Mask conversion failed: ${error.message}`);
        }
    }

    async initNodeData() {
        try {
            log.info("Starting node data initialization...");

            if (!this.node || !this.node.inputs) {
                log.debug("Node or inputs not ready");
                return this.scheduleDataCheck();
            }

            if (this.node.inputs[0] && this.node.inputs[0].link) {
                const imageLinkId = this.node.inputs[0].link;
                const imageData = app.nodeOutputs[imageLinkId];

                if (imageData) {
                    log.debug("Found image data:", imageData);
                    await this.processImageData(imageData);
                    this.dataInitialized = true;
                } else {
                    log.debug("Image data not available yet");
                    return this.scheduleDataCheck();
                }
            }

            if (this.node.inputs[1] && this.node.inputs[1].link) {
                const maskLinkId = this.node.inputs[1].link;
                const maskData = app.nodeOutputs[maskLinkId];

                if (maskData) {
                    log.debug("Found mask data:", maskData);
                    await this.processMaskData(maskData);
                }
            }

        } catch (error) {
            log.error("Error in initNodeData:", error);
            return this.scheduleDataCheck();
        }
    }

    scheduleDataCheck() {
        if (this.pendingDataCheck) {
            clearTimeout(this.pendingDataCheck);
        }

        this.pendingDataCheck = setTimeout(() => {
            this.pendingDataCheck = null;
            if (!this.dataInitialized) {
                this.initNodeData();
            }
        }, 1000);
    }

    async processImageData(imageData) {
        try {
            if (!imageData) return;

            log.debug("Processing image data:", {
                type: typeof imageData,
                isArray: Array.isArray(imageData),
                shape: imageData.shape,
                hasData: !!imageData.data
            });

            if (Array.isArray(imageData)) {
                imageData = imageData[0];
            }

            if (!imageData.shape || !imageData.data) {
                throw new Error("Invalid image data format");
            }

            const originalWidth = imageData.shape[2];
            const originalHeight = imageData.shape[1];

            const scale = Math.min(
                this.width / originalWidth * 0.8,
                this.height / originalHeight * 0.8
            );

            const convertedData = this.convertTensorToImageData(imageData);
            if (convertedData) {
                const image = await this.createImageFromData(convertedData);

                this.addScaledLayer(image, scale);
                log.info("Image layer added successfully with scale:", scale);
            }
        } catch (error) {
            log.error("Error processing image data:", error);
            throw error;
        }
    }

    addScaledLayer(image, scale) {
        try {
            const scaledWidth = image.width * scale;
            const scaledHeight = image.height * scale;

            const layer = {
                image: image,
                x: (this.width - scaledWidth) / 2,
                y: (this.height - scaledHeight) / 2,
                width: scaledWidth,
                height: scaledHeight,
                rotation: 0,
                zIndex: this.layers.length,
                originalWidth: image.width,
                originalHeight: image.height
            };

            this.layers.push(layer);
            this.selectedLayer = layer;
            this.render();

            log.debug("Scaled layer added:", {
                originalSize: `${image.width}x${image.height}`,
                scaledSize: `${scaledWidth}x${scaledHeight}`,
                scale: scale
            });
        } catch (error) {
            log.error("Error adding scaled layer:", error);
            throw error;
        }
    }

    convertTensorToImageData(tensor) {
        try {
            const shape = tensor.shape;
            const height = shape[1];
            const width = shape[2];
            const channels = shape[3];

            log.debug("Converting tensor:", {
                shape: shape,
                dataRange: {
                    min: tensor.min_val,
                    max: tensor.max_val
                }
            });

            const imageData = new ImageData(width, height);
            const data = new Uint8ClampedArray(width * height * 4);

            const flatData = tensor.data;
            const pixelCount = width * height;

            for (let i = 0; i < pixelCount; i++) {
                const pixelIndex = i * 4;
                const tensorIndex = i * channels;

                for (let c = 0; c < channels; c++) {
                    const value = flatData[tensorIndex + c];

                    const normalizedValue = (value - tensor.min_val) / (tensor.max_val - tensor.min_val);
                    data[pixelIndex + c] = Math.round(normalizedValue * 255);
                }

                data[pixelIndex + 3] = 255;
            }

            imageData.data.set(data);
            return imageData;
        } catch (error) {
            log.error("Error converting tensor:", error);
            return null;
        }
    }

    async createImageFromData(imageData) {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = imageData.width;
            canvas.height = imageData.height;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imageData, 0, 0);

            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = canvas.toDataURL();
        });
    }

    async retryDataLoad(maxRetries = 3, delay = 1000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.initNodeData();
                return;
            } catch (error) {
                log.warn(`Retry ${i + 1}/${maxRetries} failed:`, error);
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        log.error("Failed to load data after", maxRetries, "retries");
    }

    async processMaskData(maskData) {
        try {
            if (!maskData) return;

            log.debug("Processing mask data:", maskData);

            if (Array.isArray(maskData)) {
                maskData = maskData[0];
            }

            if (!maskData.shape || !maskData.data) {
                throw new Error("Invalid mask data format");
            }

            if (this.selectedLayer) {
                const maskTensor = await this.convertTensorToMask(maskData);
                this.selectedLayer.mask = maskTensor;
                this.render();
                log.info("Mask applied to selected layer");
            }
        } catch (error) {
            log.error("Error processing mask data:", error);
        }
    }

    async loadImageFromCache(base64Data) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = base64Data;
        });
    }

    async importImage(cacheData) {
        try {
            log.info("Starting image import with cache data");
            const img = await this.loadImageFromCache(cacheData.image);
            const mask = cacheData.mask ? await this.loadImageFromCache(cacheData.mask) : null;

            const scale = Math.min(
                this.width / img.width * 0.8,
                this.height / img.height * 0.8
            );

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');

            tempCtx.drawImage(img, 0, 0);

            if (mask) {
                const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = img.width;
                maskCanvas.height = img.height;
                const maskCtx = maskCanvas.getContext('2d');
                maskCtx.drawImage(mask, 0, 0);
                const maskData = maskCtx.getImageData(0, 0, img.width, img.height);

                for (let i = 0; i < imageData.data.length; i += 4) {
                    imageData.data[i + 3] = maskData.data[i];
                }

                tempCtx.putImageData(imageData, 0, 0);
            }

            const finalImage = new Image();
            await new Promise((resolve) => {
                finalImage.onload = resolve;
                finalImage.src = tempCanvas.toDataURL();
            });

            const layer = {
                image: finalImage,
                x: (this.width - img.width * scale) / 2,
                y: (this.height - img.height * scale) / 2,
                width: img.width * scale,
                height: img.height * scale,
                rotation: 0,
                zIndex: this.layers.length
            };

            this.layers.push(layer);
            this.selectedLayer = layer;
            this.render();

        } catch (error) {
            log.error('Error importing image:', error);
        }
    }

    async importLatestImage() {
        try {
            log.info("Fetching latest image from server...");
            const response = await fetch('/ycnode/get_latest_image');
            const result = await response.json();

            if (result.success && result.image_data) {
                log.info("Latest image received, adding to canvas.");
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = result.image_data;
                });

                await this.addLayerWithImage(img, {
                    x: 0,
                    y: 0,
                    width: this.width,
                    height: this.height,
                });
                log.info("Latest image imported and placed on canvas successfully.");
                return true;
            } else {
                throw new Error(result.error || "Failed to fetch the latest image.");
            }
        } catch (error) {
            log.error("Error importing latest image:", error);
            alert(`Failed to import latest image: ${error.message}`);
            return false;
        }
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
