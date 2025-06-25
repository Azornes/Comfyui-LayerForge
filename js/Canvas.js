import {saveImage, getImage, removeImage} from "./db.js";
import {MaskTool} from "./Mask_tool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
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
        
        // Po utworzeniu CanvasInteractions, użyj jego interaction state
        this.interaction = this.canvasInteractions.interaction;
        
        this.setupEventListeners();
        this.initNodeData();

        this.blendModes = [
            {name: '.', label: 'Normal'},
            {name: '.', label: 'Multiply'},
            {name: '.', label: 'Screen'},
            {name: '.', label: 'Overlay'},
            {name: '.', label: 'Darken'},
            {name: '.', label: 'Lighten'},
            {name: '.', label: 'Color Dodge'},
            {name: '.', label: 'Color Burn'},
            {name: '.', label: 'Hard Light'},
            {name: '.', label: 'Soft Light'},
            {name: '.', label: 'Difference'},
            {name: '.', label: 'Exclusion'}
        ];
        this.selectedBlendMode = null;
        this.blendOpacity = 100;
        this.isAdjustingOpacity = false;

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


    async copySelectedLayers() {
        if (this.selectedLayers.length === 0) return;
        this.internalClipboard = this.selectedLayers.map(layer => ({...layer}));
        log.info(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);
        try {
            const blob = await this.getFlattenedSelectionAsBlob();
            if (blob) {
                const item = new ClipboardItem({'image/png': blob});
                await navigator.clipboard.write([item]);
                log.info("Flattened selection copied to the system clipboard.");
            }
        } catch (error) {
            log.error("Failed to copy image to system clipboard:", error);
        }
    }


    pasteLayers() {
        if (this.internalClipboard.length === 0) return;
        this.saveState();
        const newLayers = [];
        const pasteOffset = 20;

        this.internalClipboard.forEach(clipboardLayer => {
            const newLayer = {
                ...clipboardLayer,
                x: clipboardLayer.x + pasteOffset / this.viewport.zoom,
                y: clipboardLayer.y + pasteOffset / this.viewport.zoom,
                zIndex: this.layers.length
            };
            this.layers.push(newLayer);
            newLayers.push(newLayer);
        });

        this.updateSelection(newLayers);
        this.render();
        log.info(`Pasted ${newLayers.length} layer(s).`);
    }


    async handlePaste() {
        try {
            if (!navigator.clipboard?.read) {
                log.info("Browser does not support clipboard read API. Falling back to internal paste.");
                this.pasteLayers();
                return;
            }

            const clipboardItems = await navigator.clipboard.read();
            let imagePasted = false;

            for (const item of clipboardItems) {
                const imageType = item.types.find(type => type.startsWith('image/'));

                if (imageType) {
                    const blob = await item.getType(imageType);
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const img = new Image();
                        img.onload = async () => {
                            await this.addLayerWithImage(img, {
                                x: this.lastMousePosition.x - img.width / 2,
                                y: this.lastMousePosition.y - img.height / 2,
                            });
                        };
                        img.src = event.target.result;
                    };
                    reader.readAsDataURL(blob);
                    imagePasted = true;
                    break;
                }
            }
            if (!imagePasted) {
                this.pasteLayers();
            }

        } catch (err) {
            log.error("Paste operation failed, falling back to internal paste. Error:", err);
            this.pasteLayers();
        }
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
        if (!this.selectedLayer) return false;

        const handleX = this.selectedLayer.x + this.selectedLayer.width / 2;
        const handleY = this.selectedLayer.y - 20;
        const handleRadius = 5;

        return Math.sqrt(Math.pow(x - handleX, 2) + Math.pow(y - handleY, 2)) <= handleRadius;
    }

    async addLayerWithImage(image, layerProps = {}) {
        try {
            log.debug("Adding layer with image:", image);

            // Wygeneruj unikalny identyfikator dla obrazu i zapisz go do IndexedDB
            const imageId = this.generateUUID();
            await saveImage(imageId, image.src);
            this.imageCache.set(imageId, image.src); // Zapisz w pamięci podręcznej jako imageSrc

            const layer = {
                image: image,
                imageId: imageId, // Dodaj imageId do warstwy
                x: (this.width - image.width) / 2,
                y: (this.height - image.height) / 2,
                width: image.width,
                height: image.height,
                rotation: 0,
                zIndex: this.layers.length,
                blendMode: 'normal',
                opacity: 1,
                ...layerProps // Nadpisz domyślne właściwości, jeśli podano
            };

            this.layers.push(layer);
            this.updateSelection([layer]);
            this.render();
            this.saveState();

            log.info("Layer added successfully");
            return layer;
        } catch (error) {
            log.error("Error adding layer:", error);
            throw error;
        }
    }

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
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
        return Math.round(value / gridSize) * gridSize;
    }

    getSnapAdjustment(layer, gridSize = 64, snapThreshold = 10) {
        if (!layer) {
            return {dx: 0, dy: 0};
        }

        const layerEdges = {
            left: layer.x,
            right: layer.x + layer.width,
            top: layer.y,
            bottom: layer.y + layer.height
        };
        const x_adjustments = [
            {type: 'x', delta: this.snapToGrid(layerEdges.left, gridSize) - layerEdges.left},
            {type: 'x', delta: this.snapToGrid(layerEdges.right, gridSize) - layerEdges.right}
        ];

        const y_adjustments = [
            {type: 'y', delta: this.snapToGrid(layerEdges.top, gridSize) - layerEdges.top},
            {type: 'y', delta: this.snapToGrid(layerEdges.bottom, gridSize) - layerEdges.bottom}
        ];
        x_adjustments.forEach(adj => adj.abs = Math.abs(adj.delta));
        y_adjustments.forEach(adj => adj.abs = Math.abs(adj.delta));
        const bestXSnap = x_adjustments
            .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
            .sort((a, b) => a.abs - b.abs)[0];
        const bestYSnap = y_adjustments
            .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
            .sort((a, b) => a.abs - b.abs)[0];
        return {
            dx: bestXSnap ? bestXSnap.delta : 0,
            dy: bestYSnap ? bestYSnap.delta : 0
        };
    }

    moveLayer(fromIndex, toIndex) {
        if (fromIndex >= 0 && fromIndex < this.layers.length &&
            toIndex >= 0 && toIndex < this.layers.length) {
            const layer = this.layers.splice(fromIndex, 1)[0];
            this.layers.splice(toIndex, 0, layer);
            this.render();
        }
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
        if (saveHistory) {
            this.saveState();
        }
        this.width = width;
        this.height = height;
        this.maskTool.resize(width, height);

        this.canvas.width = width;
        this.canvas.height = height;

        this.render();

        if (saveHistory) {
            this.saveStateToDB();
        }
    }

    render() {
        if (this.renderAnimationFrame) {
            this.isDirty = true;
            return;
        }
        this.renderAnimationFrame = requestAnimationFrame(() => {
            const now = performance.now();
            if (now - this.lastRenderTime >= this.renderInterval) {
                this.lastRenderTime = now;
                this.actualRender();
                this.isDirty = false;
            }

            if (this.isDirty) {
                this.renderAnimationFrame = null;
                this.render();
            } else {
                this.renderAnimationFrame = null;
            }
        });
    }

    actualRender() {
        if (this.offscreenCanvas.width !== this.canvas.clientWidth ||
            this.offscreenCanvas.height !== this.canvas.clientHeight) {
            const newWidth = Math.max(1, this.canvas.clientWidth);
            const newHeight = Math.max(1, this.canvas.clientHeight);
            this.offscreenCanvas.width = newWidth;
            this.offscreenCanvas.height = newHeight;
        }

        const ctx = this.offscreenCtx;

        ctx.fillStyle = '#606060';
        ctx.fillRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

        ctx.save();
        ctx.scale(this.viewport.zoom, this.viewport.zoom);
        ctx.translate(-this.viewport.x, -this.viewport.y);

        this.drawGrid(ctx);

        const sortedLayers = [...this.layers].sort((a, b) => a.zIndex - b.zIndex);
        sortedLayers.forEach(layer => {
            if (!layer.image) return;
            ctx.save();
            const currentTransform = ctx.getTransform();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = layer.blendMode || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.setTransform(currentTransform);
            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;
            ctx.translate(centerX, centerY);
            ctx.rotate(layer.rotation * Math.PI / 180);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(
                layer.image, -layer.width / 2, -layer.height / 2,
                layer.width,
                layer.height
            );
            if (layer.mask) {
            }
            if (this.selectedLayers.includes(layer)) {
                this.drawSelectionFrame(ctx, layer);
            }
            ctx.restore();
        });

        this.drawCanvasOutline(ctx);

        // Renderowanie maski w zależności od trybu
        const maskImage = this.maskTool.getMask();
        if (this.maskTool.isActive) {
            // W trybie maski pokazuj maskę z przezroczystością 0.5
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.5;
            ctx.drawImage(maskImage, 0, 0);
            ctx.globalAlpha = 1.0;
        } else if (maskImage) {
            // W trybie warstw pokazuj maskę jako widoczną, ale nieedytowalną
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1.0;
            ctx.drawImage(maskImage, 0, 0);
            ctx.globalAlpha = 1.0;
        }

        if (this.interaction.mode === 'resizingCanvas' && this.interaction.canvasResizeRect) {
            const rect = this.interaction.canvasResizeRect;
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.lineWidth = 2 / this.viewport.zoom;
            ctx.setLineDash([8 / this.viewport.zoom, 4 / this.viewport.zoom]);
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.setLineDash([]);
            ctx.restore();
            if (rect.width > 0 && rect.height > 0) {
                const text = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
                const textWorldX = rect.x + rect.width / 2;
                const textWorldY = rect.y + rect.height + (20 / this.viewport.zoom);

                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                const screenX = (textWorldX - this.viewport.x) * this.viewport.zoom;
                const screenY = (textWorldY - this.viewport.y) * this.viewport.zoom;
                ctx.font = "14px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const textMetrics = ctx.measureText(text);
                const bgWidth = textMetrics.width + 10;
                const bgHeight = 22;
                ctx.fillStyle = "rgba(0, 128, 0, 0.7)";
                ctx.fillRect(screenX - bgWidth / 2, screenY - bgHeight / 2, bgWidth, bgHeight);
                ctx.fillStyle = "white";
                ctx.fillText(text, screenX, screenY);
                ctx.restore();
            }
        }
        if (this.interaction.mode === 'movingCanvas' && this.interaction.canvasMoveRect) {
            const rect = this.interaction.canvasMoveRect;
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 150, 255, 0.8)';
            ctx.lineWidth = 2 / this.viewport.zoom;
            ctx.setLineDash([10 / this.viewport.zoom, 5 / this.viewport.zoom]);
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.setLineDash([]);
            ctx.restore();

            const text = `(${Math.round(rect.x)}, ${Math.round(rect.y)})`;
            const textWorldX = rect.x + rect.width / 2;
            const textWorldY = rect.y - (20 / this.viewport.zoom);

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const screenX = (textWorldX - this.viewport.x) * this.viewport.zoom;
            const screenY = (textWorldY - this.viewport.y) * this.viewport.zoom;
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const textMetrics = ctx.measureText(text);
            const bgWidth = textMetrics.width + 10;
            const bgHeight = 22;
            ctx.fillStyle = "rgba(0, 100, 170, 0.7)";
            ctx.fillRect(screenX - bgWidth / 2, screenY - bgHeight / 2, bgWidth, bgHeight);
            ctx.fillStyle = "white";
            ctx.fillText(text, screenX, screenY);
            ctx.restore();
        }

        if (this.selectedLayer) {
            this.selectedLayers.forEach(layer => {
                if (!layer.image) return;

                const layerIndex = this.layers.indexOf(layer);
                const currentWidth = Math.round(layer.width);
                const currentHeight = Math.round(layer.height);
                const rotation = Math.round(layer.rotation % 360);
                const text = `${currentWidth}x${currentHeight} | ${rotation}° | Layer #${layerIndex + 1}`;


                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                const halfW = layer.width / 2;
                const halfH = layer.height / 2;

                const localCorners = [
                    {x: -halfW, y: -halfH},
                    {x: halfW, y: -halfH},
                    {x: halfW, y: halfH},
                    {x: -halfW, y: halfH}
                ];
                const worldCorners = localCorners.map(p => ({
                    x: centerX + p.x * cos - p.y * sin,
                    y: centerY + p.x * sin + p.y * cos
                }));
                let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
                worldCorners.forEach(p => {
                    minX = Math.min(minX, p.x);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                });
                const padding = 20 / this.viewport.zoom;
                const textWorldX = (minX + maxX) / 2;
                const textWorldY = maxY + padding;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);

                const screenX = (textWorldX - this.viewport.x) * this.viewport.zoom;
                const screenY = (textWorldY - this.viewport.y) * this.viewport.zoom;

                ctx.font = "14px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const textMetrics = ctx.measureText(text);
                const textBgWidth = textMetrics.width + 10;
                const textBgHeight = 22;
                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(screenX - textBgWidth / 2, screenY - textBgHeight / 2, textBgWidth, textBgHeight);

                ctx.fillStyle = "white";
                ctx.fillText(text, screenX, screenY);

                ctx.restore();
            });
        }

        ctx.restore();

        if (this.canvas.width !== this.offscreenCanvas.width || this.canvas.height !== this.offscreenCanvas.height) {
            this.canvas.width = this.offscreenCanvas.width;
            this.canvas.height = this.offscreenCanvas.height;
        }
        this.ctx.drawImage(this.offscreenCanvas, 0, 0);
    }

    drawGrid(ctx) {
        const gridSize = 64;
        const lineWidth = 0.5 / this.viewport.zoom;

        const viewLeft = this.viewport.x;
        const viewTop = this.viewport.y;
        const viewRight = this.viewport.x + this.offscreenCanvas.width / this.viewport.zoom;
        const viewBottom = this.viewport.y + this.offscreenCanvas.height / this.viewport.zoom;

        ctx.beginPath();
        ctx.strokeStyle = '#707070';
        ctx.lineWidth = lineWidth;

        for (let x = Math.floor(viewLeft / gridSize) * gridSize; x < viewRight; x += gridSize) {
            ctx.moveTo(x, viewTop);
            ctx.lineTo(x, viewBottom);
        }

        for (let y = Math.floor(viewTop / gridSize) * gridSize; y < viewBottom; y += gridSize) {
            ctx.moveTo(viewLeft, y);
            ctx.lineTo(viewRight, y);
        }

        ctx.stroke();
    }

    drawCanvasOutline(ctx) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2 / this.viewport.zoom;
        ctx.setLineDash([10 / this.viewport.zoom, 5 / this.viewport.zoom]);


        ctx.rect(0, 0, this.width, this.height);

        ctx.stroke();
        ctx.setLineDash([]);
    }

    drawSelectionFrame(ctx, layer) {
        const lineWidth = 2 / this.viewport.zoom;
        const handleRadius = 5 / this.viewport.zoom;
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -layer.height / 2);
        ctx.lineTo(0, -layer.height / 2 - 20 / this.viewport.zoom);
        ctx.stroke();
        const handles = this.getHandles(layer);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1 / this.viewport.zoom;

        for (const key in handles) {
            const point = handles[key];
            ctx.beginPath();
            const localX = point.x - (layer.x + layer.width / 2);
            const localY = point.y - (layer.y + layer.height / 2);

            const rad = -layer.rotation * Math.PI / 180;
            const rotatedX = localX * Math.cos(rad) - localY * Math.sin(rad);
            const rotatedY = localX * Math.sin(rad) + localY * Math.cos(rad);

            ctx.arc(rotatedX, rotatedY, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }


    getHandles(layer) {
        if (!layer) return {};

        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        const rad = layer.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const halfW = layer.width / 2;
        const halfH = layer.height / 2;
        const localHandles = {
            'n': {x: 0, y: -halfH},
            'ne': {x: halfW, y: -halfH},
            'e': {x: halfW, y: 0},
            'se': {x: halfW, y: halfH},
            's': {x: 0, y: halfH},
            'sw': {x: -halfW, y: halfH},
            'w': {x: -halfW, y: 0},
            'nw': {x: -halfW, y: -halfH},
            'rot': {x: 0, y: -halfH - 20 / this.viewport.zoom}
        };

        const worldHandles = {};
        for (const key in localHandles) {
            const p = localHandles[key];
            worldHandles[key] = {
                x: centerX + (p.x * cos - p.y * sin),
                y: centerY + (p.x * sin + p.y * cos)
            };
        }
        return worldHandles;
    }

    getHandleAtPosition(worldX, worldY) {
        if (this.selectedLayers.length === 0) return null;

        const handleRadius = 8 / this.viewport.zoom;
        for (let i = this.selectedLayers.length - 1; i >= 0; i--) {
            const layer = this.selectedLayers[i];
            const handles = this.getHandles(layer);

            for (const key in handles) {
                const handlePos = handles[key];
                const dx = worldX - handlePos.x;
                const dy = worldY - handlePos.y;
                if (dx * dx + dy * dy <= handleRadius * handleRadius) {
                    return {layer: layer, handle: key};
                }
            }
        }
        return null;
    }

    worldToLocal(worldX, worldY, layerProps) {
        const dx = worldX - layerProps.centerX;
        const dy = worldY - layerProps.centerY;
        const rad = -layerProps.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        return {
            x: dx * cos - dy * sin,
            y: dx * sin + dy * cos
        };
    }

    localToWorld(localX, localY, layerProps) {
        const rad = layerProps.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        return {
            x: layerProps.centerX + localX * cos - localY * sin,
            y: layerProps.centerY + localX * sin + localY * cos
        };
    }


    async saveToServer(fileName) {
        // Sprawdź czy już trwa zapis
        if (this._saveInProgress) {
            log.warn(`Save already in progress, waiting...`);
            return this._saveInProgress;
        }

        log.info(`Starting saveToServer with fileName: ${fileName}`);
        log.debug(`Canvas dimensions: ${this.width}x${this.height}`);
        log.debug(`Number of layers: ${this.layers.length}`);
        
        // Utwórz Promise dla aktualnego zapisu
        this._saveInProgress = this._performSave(fileName);
        
        try {
            const result = await this._saveInProgress;
            return result;
        } finally {
            this._saveInProgress = null;
            log.debug(`Save completed, lock released`);
        }
    }

    async _performSave(fileName) {
        // Zapisz stan do IndexedDB przed zapisem na serwer
        await this.saveStateToDB(true);

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

            maskCtx.fillStyle = '#ffffff'; // Białe tło dla wolnych przestrzeni
            maskCtx.fillRect(0, 0, this.width, this.height);
            
            log.debug(`Canvas contexts created, starting layer rendering`);

            // Rysowanie warstw
            const sortedLayers = this.layers.sort((a, b) => a.zIndex - b.zIndex);
            log.debug(`Processing ${sortedLayers.length} layers in order`);
            
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

                maskCtx.save();
                maskCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                maskCtx.rotate(layer.rotation * Math.PI / 180);
                maskCtx.globalCompositeOperation = 'source-over'; // Używamy source-over, aby uwzględnić stopniową przezroczystość

                if (layer.mask) {
                    // Jeśli warstwa ma maskę, używamy jej jako alpha kanału
                    const layerCanvas = document.createElement('canvas');
                    layerCanvas.width = layer.width;
                    layerCanvas.height = layer.height;
                    const layerCtx = layerCanvas.getContext('2d');
                    layerCtx.drawImage(layer.mask, 0, 0, layer.width, layer.height);
                    const imageData = layerCtx.getImageData(0, 0, layer.width, layer.height);

                    const alphaCanvas = document.createElement('canvas');
                    alphaCanvas.width = layer.width;
                    alphaCanvas.height = layer.height;
                    const alphaCtx = alphaCanvas.getContext('2d');
                    const alphaData = alphaCtx.createImageData(layer.width, layer.height);

                    for (let i = 0; i < imageData.data.length; i += 4) {
                        const alpha = imageData.data[i + 3] * (layer.opacity !== undefined ? layer.opacity : 1);
                        // Odwracamy alpha, aby przezroczyste obszary warstwy były nieprzezroczyste na masce
                        alphaData.data[i] = alphaData.data[i + 1] = alphaData.data[i + 2] = 255 - alpha;
                        alphaData.data[i + 3] = 255;
                    }

                    alphaCtx.putImageData(alphaData, 0, 0);
                    maskCtx.drawImage(alphaCanvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                } else {
                    // Jeśli warstwa nie ma maski, używamy jej alpha kanału
                    const layerCanvas = document.createElement('canvas');
                    layerCanvas.width = layer.width;
                    layerCanvas.height = layer.height;
                    const layerCtx = layerCanvas.getContext('2d');
                    layerCtx.drawImage(layer.image, 0, 0, layer.width, layer.height);
                    const imageData = layerCtx.getImageData(0, 0, layer.width, layer.height);

                    const alphaCanvas = document.createElement('canvas');
                    alphaCanvas.width = layer.width;
                    alphaCanvas.height = layer.height;
                    const alphaCtx = alphaCanvas.getContext('2d');
                    const alphaData = alphaCtx.createImageData(layer.width, layer.height);

                    for (let i = 0; i < imageData.data.length; i += 4) {
                        const alpha = imageData.data[i + 3] * (layer.opacity !== undefined ? layer.opacity : 1);
                        // Odwracamy alpha, aby przezroczyste obszary warstwy były nieprzezroczyste na masce
                        alphaData.data[i] = alphaData.data[i + 1] = alphaData.data[i + 2] = 255 - alpha;
                        alphaData.data[i + 3] = 255;
                    }

                    alphaCtx.putImageData(alphaData, 0, 0);
                    maskCtx.drawImage(alphaCanvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                }
                maskCtx.restore();
            });

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
                                    this.widget.value = data.name;
                                    log.info(`All files saved successfully, widget value set to: ${data.name}`);
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
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.width;
            tempCanvas.height = this.height;
            const tempCtx = tempCanvas.getContext('2d');

            const sortedLayers = [...this.layers].sort((a, b) => a.zIndex - b.zIndex);

            sortedLayers.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2,
                    -layer.height / 2,
                    layer.width,
                    layer.height
                );

                tempCtx.restore();
            });

            tempCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Canvas toBlob failed.'));
                }
            }, 'image/png');
        });
    }


    async getFlattenedSelectionAsBlob() {
        if (this.selectedLayers.length === 0) {
            return null;
        }

        return new Promise((resolve) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.selectedLayers.forEach(layer => {
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                const halfW = layer.width / 2;
                const halfH = layer.height / 2;

                const corners = [
                    {x: -halfW, y: -halfH},
                    {x: halfW, y: -halfH},
                    {x: halfW, y: halfH},
                    {x: -halfW, y: halfH}
                ];

                corners.forEach(p => {
                    const worldX = centerX + (p.x * cos - p.y * sin);
                    const worldY = centerY + (p.x * sin + p.y * cos);

                    minX = Math.min(minX, worldX);
                    minY = Math.min(minY, worldY);
                    maxX = Math.max(maxX, worldX);
                    maxY = Math.max(maxY, worldY);
                });
            });

            const newWidth = Math.ceil(maxX - minX);
            const newHeight = Math.ceil(maxY - minY);

            if (newWidth <= 0 || newHeight <= 0) {
                resolve(null);
                return;
            }
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = newWidth;
            tempCanvas.height = newHeight;
            const tempCtx = tempCanvas.getContext('2d');

            tempCtx.translate(-minX, -minY);

            const sortedSelection = [...this.selectedLayers].sort((a, b) => a.zIndex - b.zIndex);

            sortedSelection.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;

                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2, -layer.height / 2,
                    layer.width, layer.height
                );
                tempCtx.restore();
            });
            tempCanvas.toBlob((blob) => {
                resolve(blob);
            }, 'image/png');
        });
    }

    moveLayerUp() {
        if (this.selectedLayers.length === 0) return;
        const selectedIndicesSet = new Set(this.selectedLayers.map(layer => this.layers.indexOf(layer)));

        const sortedIndices = Array.from(selectedIndicesSet).sort((a, b) => b - a);

        sortedIndices.forEach(index => {
            const targetIndex = index + 1;

            if (targetIndex < this.layers.length && !selectedIndicesSet.has(targetIndex)) {
                [this.layers[index], this.layers[targetIndex]] = [this.layers[targetIndex], this.layers[index]];
            }
        });
        this.layers.forEach((layer, i) => layer.zIndex = i);
        this.render();
        this.saveState();
    }

    moveLayerDown() {
        if (this.selectedLayers.length === 0) return;
        const selectedIndicesSet = new Set(this.selectedLayers.map(layer => this.layers.indexOf(layer)));

        const sortedIndices = Array.from(selectedIndicesSet).sort((a, b) => a - b);

        sortedIndices.forEach(index => {
            const targetIndex = index - 1;

            if (targetIndex >= 0 && !selectedIndicesSet.has(targetIndex)) {
                [this.layers[index], this.layers[targetIndex]] = [this.layers[targetIndex], this.layers[index]];
            }
        });
        this.layers.forEach((layer, i) => layer.zIndex = i);
        this.render();
        this.saveState();
    }


    getLayerAtPosition(worldX, worldY) {

        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];

            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;

            const dx = worldX - centerX;
            const dy = worldY - centerY;

            const rad = -layer.rotation * Math.PI / 180;
            const rotatedX = dx * Math.cos(rad) - dy * Math.sin(rad);
            const rotatedY = dx * Math.sin(rad) + dy * Math.cos(rad);

            if (Math.abs(rotatedX) <= layer.width / 2 && Math.abs(rotatedY) <= layer.height / 2) {
                const localX = rotatedX + layer.width / 2;
                const localY = rotatedY + layer.height / 2;

                return {
                    layer: layer,
                    localX: localX,
                    localY: localY
                };
            }
        }
        return null;
    }

    getResizeHandle(x, y) {
        if (!this.selectedLayer) return null;

        const handleRadius = 5;
        const handles = {
            'nw': {x: this.selectedLayer.x, y: this.selectedLayer.y},
            'ne': {x: this.selectedLayer.x + this.selectedLayer.width, y: this.selectedLayer.y},
            'se': {
                x: this.selectedLayer.x + this.selectedLayer.width,
                y: this.selectedLayer.y + this.selectedLayer.height
            },
            'sw': {x: this.selectedLayer.x, y: this.selectedLayer.y + this.selectedLayer.height}
        };

        for (const [position, point] of Object.entries(handles)) {
            if (Math.sqrt(Math.pow(x - point.x, 2) + Math.pow(y - point.y, 2)) <= handleRadius) {
                return position;
            }
        }
        return null;
    }

    async mirrorHorizontal() {
        if (this.selectedLayers.length === 0) return;

        const promises = this.selectedLayers.map(layer => {
            return new Promise(resolve => {
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d');
                tempCanvas.width = layer.image.width;
                tempCanvas.height = layer.image.height;

                tempCtx.translate(tempCanvas.width, 0);
                tempCtx.scale(-1, 1);
                tempCtx.drawImage(layer.image, 0, 0);

                const newImage = new Image();
                newImage.onload = () => {
                    layer.image = newImage;
                    resolve();
                };
                newImage.src = tempCanvas.toDataURL();
            });
        });

        await Promise.all(promises);
        this.render();
        this.saveState();
    }

    async mirrorVertical() {
        if (this.selectedLayers.length === 0) return;

        const promises = this.selectedLayers.map(layer => {
            return new Promise(resolve => {
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d');
                tempCanvas.width = layer.image.width;
                tempCanvas.height = layer.image.height;

                tempCtx.translate(0, tempCanvas.height);
                tempCtx.scale(1, -1);
                tempCtx.drawImage(layer.image, 0, 0);

                const newImage = new Image();
                newImage.onload = () => {
                    layer.image = newImage;
                    resolve();
                };
                newImage.src = tempCanvas.toDataURL();
            });
        });

        await Promise.all(promises);
        this.render();
        this.saveState();
    }

    async getLayerImageData(layer) {
        try {
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');

            tempCanvas.width = layer.width;
            tempCanvas.height = layer.height;

            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

            tempCtx.save();
            tempCtx.translate(layer.width / 2, layer.height / 2);
            tempCtx.rotate(layer.rotation * Math.PI / 180);
            tempCtx.drawImage(
                layer.image,
                -layer.width / 2,
                -layer.height / 2,
                layer.width,
                layer.height
            );
            tempCtx.restore();

            const dataUrl = tempCanvas.toDataURL('image/png');
            if (!dataUrl.startsWith('data:image/png;base64,')) {
                throw new Error("Invalid image data format");
            }

            return dataUrl;
        } catch (error) {
            log.error("Error getting layer image data:", error);
            throw error;
        }
    }

    addMattedLayer(image, mask) {
        const layer = {
            image: image,
            mask: mask,
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
            rotation: 0,
            zIndex: this.layers.length
        };

        this.layers.push(layer);
        this.selectedLayer = layer;
        this.render();
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

        const existingMenu = document.getElementById('blend-mode-menu');
        if (existingMenu) {
            document.body.removeChild(existingMenu);
        }

        const menu = document.createElement('div');
        menu.id = 'blend-mode-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            border-radius: 4px;
            padding: 5px;
            z-index: 1000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;

        this.blendModes.forEach(mode => {
            const container = document.createElement('div');
            container.className = 'blend-mode-container';
            container.style.cssText = `
                margin-bottom: 5px;
            `;

            const option = document.createElement('div');
            option.style.cssText = `
                padding: 5px 10px;
                color: white;
                cursor: pointer;
                transition: background-color 0.2s;
            `;
            option.textContent = `${mode.label} (${mode.name})`;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';

            slider.value = this.selectedLayer.opacity ? Math.round(this.selectedLayer.opacity * 100) : 100;
            slider.style.cssText = `
                width: 100%;
                margin: 5px 0;
                display: none;
            `;

            if (this.selectedLayer.blendMode === mode.name) {
                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';
            }

            option.onclick = () => {

                menu.querySelectorAll('input[type="range"]').forEach(s => {
                    s.style.display = 'none';
                });
                menu.querySelectorAll('.blend-mode-container div').forEach(d => {
                    d.style.backgroundColor = '';
                });

                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';

                if (this.selectedLayer) {
                    this.selectedLayer.blendMode = mode.name;
                    this.render();
                }
            };

            slider.addEventListener('input', () => {
                if (this.selectedLayer) {
                    this.selectedLayer.opacity = slider.value / 100;
                    this.render();
                }
            });

            slider.addEventListener('change', async () => {
                if (this.selectedLayer) {
                    this.selectedLayer.opacity = slider.value / 100;
                    this.render();

                    await this.saveToServer(this.widget.value);
                    if (this.node) {
                        app.graph.runStep();
                    }
                }
            });

            container.appendChild(option);
            container.appendChild(slider);
            menu.appendChild(container);
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu);
        }, 0);
    }

    handleBlendModeSelection(mode) {
        if (this.selectedBlendMode === mode && !this.isAdjustingOpacity) {
            this.applyBlendMode(mode, this.blendOpacity);
            this.closeBlendModeMenu();
        } else {
            this.selectedBlendMode = mode;
            this.isAdjustingOpacity = true;
            this.showOpacitySlider(mode);
        }
    }

    showOpacitySlider(mode) {

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = this.blendOpacity;
        slider.className = 'blend-opacity-slider';

        slider.addEventListener('input', (e) => {
            this.blendOpacity = parseInt(e.target.value);

        });

        const modeElement = document.querySelector(`[data-blend-mode="${mode}"]`);
        if (modeElement) {
            modeElement.appendChild(slider);
        }
    }

    applyBlendMode(mode, opacity) {

        this.currentLayer.style.mixBlendMode = mode;
        this.currentLayer.style.opacity = opacity / 100;

        this.selectedBlendMode = null;
        this.isAdjustingOpacity = false;
    }
}
