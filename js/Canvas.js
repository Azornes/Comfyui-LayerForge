import { getCanvasState, setCanvasState, removeCanvasState } from "./db.js";

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
        this.interaction = {
            mode: 'none',
            panStart: {x: 0, y: 0},
            dragStart: {x: 0, y: 0},
            transformOrigin: {},
            resizeHandle: null,
            resizeAnchor: {x: 0, y: 0},
            canvasResizeStart: {x: 0, y: 0},
            isCtrlPressed: false,
            isAltPressed: false,
            hasClonedInDrag: false,
            lastClickTime: 0,
            transformingLayer: null,
        };
        this.originalLayerPositions = new Map();
        this.interaction.canvasResizeRect = null;
        this.interaction.canvasMoveRect = null;

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
        this.initCanvas();
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

        this.undoStack = [];
        this.redoStack = [];
        this.historyLimit = 100;

        // this.saveState(); // Wywołanie przeniesione do loadInitialState
    }

    async loadStateFromDB() {
        console.log("Attempting to load state from IndexedDB for node:", this.node.id);
        if (!this.node.id) {
            console.error("Node ID is not available for loading state from DB.");
            return false;
        }

        try {
            const savedState = await getCanvasState(this.node.id);
            if (!savedState) {
                console.log("No saved state found in IndexedDB for node:", this.node.id);
                return false;
            }
            console.log("Found saved state in IndexedDB.");

            this.width = savedState.width || 512;
            this.height = savedState.height || 512;
            this.viewport = savedState.viewport || { x: -(this.width / 4), y: -(this.height / 4), zoom: 0.8 };
            
            this.updateCanvasSize(this.width, this.height, false);
            console.log(`Canvas resized to ${this.width}x${this.height} and viewport set.`);

            const imagePromises = savedState.layers.map((layerData, index) => {
                return new Promise((resolve) => {
                    if (layerData.imageSrc) {
                        console.log(`Layer ${index}: Loading image from data:URL...`);
                        const img = new Image();
                        img.onload = () => {
                            console.log(`Layer ${index}: Image loaded successfully.`);
                            const newLayer = { ...layerData, image: img };
                            delete newLayer.imageSrc;
                            resolve(newLayer);
                        };
                        img.onerror = () => {
                            console.error(`Layer ${index}: Failed to load image from src.`);
                            resolve(null);
                        };
                        img.src = layerData.imageSrc;
                    } else {
                        console.log(`Layer ${index}: No imageSrc found, resolving layer data.`);
                        resolve({ ...layerData });
                    }
                });
            });

            const loadedLayers = await Promise.all(imagePromises);
            this.layers = loadedLayers.filter(l => l !== null);
            console.log(`Loaded ${this.layers.length} layers.`);
            
            this.updateSelectionAfterHistory();
            this.render();
            console.log("Canvas state loaded successfully from localStorage for node", this.node.id);
            return true;
        } catch (e) {
            console.error("Error loading canvas state from IndexedDB:", e);
            await removeCanvasState(this.node.id).catch(err => console.error("Failed to remove corrupted state:", err));
            return false;
        }
    }

    async saveStateToDB() {
        console.log("Attempting to save state to IndexedDB for node:", this.node.id);
        if (!this.node.id) {
            console.error("Node ID is not available for saving state to DB.");
            return;
        }

        try {
            const state = {
                layers: this.layers.map((layer, index) => {
                    const newLayer = { ...layer };
                    if (layer.image instanceof HTMLImageElement) {
                        console.log(`Layer ${index}: Serializing image to data:URL.`);
                        newLayer.imageSrc = layer.image.src;
                    } else {
                        console.log(`Layer ${index}: No HTMLImageElement found.`);
                    }
                    delete newLayer.image;
                    return newLayer;
                }),
                viewport: this.viewport,
                width: this.width,
                height: this.height,
            };
            await setCanvasState(this.node.id, state);
            console.log("Canvas state saved to IndexedDB.");
        } catch (e) {
            console.error("Error saving canvas state to IndexedDB:", e);
        }
    }

    async loadInitialState() {
        console.log("Loading initial state for node:", this.node.id);
        const loaded = await this.loadStateFromDB();
        if (!loaded) {
            console.log("No saved state found, initializing from node data.");
            await this.initNodeData();
        }
        this.saveState(); // Save initial state to undo stack
    }

    cloneLayers(layers) {
        return layers.map(layer => {
            const newLayer = { ...layer };
            // Obiekty Image nie są klonowane, aby oszczędzać pamięć.
            // Zakładamy, że same dane obrazu się nie zmieniają.
            return newLayer;
        });
    }

    saveState(replaceLast = false) {
        if (replaceLast && this.undoStack.length > 0) {
            this.undoStack.pop();
        }

        const currentState = this.cloneLayers(this.layers);

        if (this.undoStack.length > 0) {
            const lastState = this.undoStack[this.undoStack.length - 1];
            if (JSON.stringify(currentState) === JSON.stringify(lastState)) {
                return;
            }
        }

        this.undoStack.push(currentState);

        if (this.undoStack.length > this.historyLimit) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.updateHistoryButtons();
        this.saveStateToDB();
    }

    undo() {
        if (this.undoStack.length <= 1) return;
        const currentState = this.undoStack.pop();
        this.redoStack.push(currentState);
        const prevState = this.undoStack[this.undoStack.length - 1];
        this.layers = this.cloneLayers(prevState);
        this.updateSelectionAfterHistory();
        this.render();
        this.updateHistoryButtons();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const nextState = this.redoStack.pop();
        this.undoStack.push(nextState);
        this.layers = this.cloneLayers(nextState);
        this.updateSelectionAfterHistory();
        this.render();
        this.updateHistoryButtons();
    }
    
    updateSelectionAfterHistory() {
        const newSelectedLayers = [];
        if (this.selectedLayers) {
            this.selectedLayers.forEach(sl => {
                const found = this.layers.find(l => l.id === sl.id);
                if(found) newSelectedLayers.push(found);
            });
        }
        this.updateSelection(newSelectedLayers);
    }

    updateHistoryButtons() {
        if (this.onHistoryChange) {
            this.onHistoryChange({
                canUndo: this.undoStack.length > 1,
                canRedo: this.redoStack.length > 0
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
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this), {passive: false});


        this.canvas.addEventListener('keydown', this.handleKeyDown.bind(this));
        this.canvas.addEventListener('keyup', this.handleKeyUp.bind(this));

        this.canvas.addEventListener('mouseenter', () => {
            this.isMouseOver = true;
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.isMouseOver = false;
        });
    }

    updateSelection(newSelection) {
        this.selectedLayers = newSelection || [];
        this.selectedLayer = this.selectedLayers.length > 0 ? this.selectedLayers[this.selectedLayers.length - 1] : null;
        if (this.onSelectionChange) {
            this.onSelectionChange();
        }
    }


    resetInteractionState() {
        this.interaction.mode = 'none';
        this.interaction.resizeHandle = null;
        this.originalLayerPositions.clear();
        this.interaction.canvasResizeRect = null;
        this.interaction.canvasMoveRect = null;
        this.interaction.hasClonedInDrag = false;
        this.interaction.transformingLayer = null;
        this.canvas.style.cursor = 'default';
    }

    handleMouseDown(e) {
        this.canvas.focus();

        const currentTime = Date.now();
        const worldCoords = this.getMouseWorldCoordinates(e);
        if (e.shiftKey && e.ctrlKey) {
            this.startCanvasMove(worldCoords);
            this.render();
            return;
        }

        if (currentTime - this.interaction.lastClickTime < 300) {
            this.updateSelection([]);
            this.selectedLayer = null;
            this.resetInteractionState();
            this.render();
            return;
        }
        this.interaction.lastClickTime = currentTime;

        const transformTarget = this.getHandleAtPosition(worldCoords.x, worldCoords.y);
        if (transformTarget) {
            this.startLayerTransform(transformTarget.layer, transformTarget.handle, worldCoords);
            return;
        }

        const clickedLayerResult = this.getLayerAtPosition(worldCoords.x, worldCoords.y);
        if (clickedLayerResult) {
            if (e.shiftKey && this.selectedLayers.includes(clickedLayerResult.layer)) {
                this.showBlendModeMenu(e.clientX, e.clientY);
                return;
            }
            this.startLayerDrag(clickedLayerResult.layer, worldCoords);
            return;
        }
        if (e.shiftKey) {
            this.startCanvasResize(worldCoords);
        } else {
            this.startPanning(e);
        }

        this.render();
    }


    async copySelectedLayers() {
        if (this.selectedLayers.length === 0) return;
        this.internalClipboard = this.selectedLayers.map(layer => ({...layer}));
        console.log(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);
        try {
            const blob = await this.getFlattenedSelectionAsBlob();
            if (blob) {
                const item = new ClipboardItem({'image/png': blob});
                await navigator.clipboard.write([item]);
                console.log("Flattened selection copied to the system clipboard.");
            }
        } catch (error) {
            console.error("Failed to copy image to system clipboard:", error);
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
        console.log(`Pasted ${newLayers.length} layer(s).`);
    }


    async handlePaste() {
        try {
            if (!navigator.clipboard?.read) {
                console.log("Browser does not support clipboard read API. Falling back to internal paste.");
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
                        img.onload = () => {
                            const newLayer = {
                                image: img,
                                x: this.lastMousePosition.x - img.width / 2,
                                y: this.lastMousePosition.y - img.height / 2,
                                width: img.width,
                                height: img.height,
                                rotation: 0,
                                zIndex: this.layers.length,
                                blendMode: 'normal',
                                opacity: 1
                            };
                            this.layers.push(newLayer);
                            this.updateSelection([newLayer]);
                            this.render();
                            this.saveState();
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
            console.error("Paste operation failed, falling back to internal paste. Error:", err);
            this.pasteLayers();
        }
    }


    handleMouseMove(e) {
        const worldCoords = this.getMouseWorldCoordinates(e);
        this.lastMousePosition = worldCoords;

        switch (this.interaction.mode) {
            case 'panning':
                this.panViewport(e);
                break;
            case 'dragging':
                this.dragLayers(worldCoords);
                break;
            case 'resizing':
                this.resizeLayerFromHandle(worldCoords, e.shiftKey);
                break;
            case 'rotating':
                this.rotateLayerFromHandle(worldCoords, e.shiftKey);
                break;
            case 'resizingCanvas':
                this.updateCanvasResize(worldCoords);
                break;
            case 'movingCanvas':
                this.updateCanvasMove(worldCoords);
                break;
            default:
                this.updateCursor(worldCoords);
                break;
        }
    }


    handleMouseUp(e) {
        const interactionEnded = this.interaction.mode !== 'none' && this.interaction.mode !== 'panning';

        if (this.interaction.mode === 'resizingCanvas') {
            this.finalizeCanvasResize();
        } else if (this.interaction.mode === 'movingCanvas') {
            this.finalizeCanvasMove();
        }
        this.resetInteractionState();
        this.render();

        if (interactionEnded) {
            this.saveState();
        }
    }


    handleMouseLeave(e) {
        if (this.interaction.mode !== 'none') {
            this.resetInteractionState();
            this.render();
        }
    }


    handleWheel(e) {
        e.preventDefault();
        if (this.selectedLayer) {
            const rotationStep = 5 * (e.deltaY > 0 ? -1 : 1);

            this.selectedLayers.forEach(layer => {
                if (e.shiftKey) {
                    layer.rotation += rotationStep;
                } else {
                    const oldWidth = layer.width;
                    const oldHeight = layer.height;
                    let scaleFactor;

                    if (e.ctrlKey) {

                        const direction = e.deltaY > 0 ? -1 : 1;

                        const baseDimension = Math.max(layer.width, layer.height);
                        const newBaseDimension = baseDimension + direction;
                        if (newBaseDimension < 10) {
                            return;
                        }

                        scaleFactor = newBaseDimension / baseDimension;

                    } else {

                        const gridSize = 64;
                        const direction = e.deltaY > 0 ? -1 : 1;
                        let targetHeight;

                        if (direction > 0) {

                            targetHeight = (Math.floor(oldHeight / gridSize) + 1) * gridSize;
                        } else {

                            targetHeight = (Math.ceil(oldHeight / gridSize) - 1) * gridSize;
                        }
                        if (targetHeight < gridSize / 2) {
                            targetHeight = gridSize / 2;
                        }
                        if (Math.abs(oldHeight - targetHeight) < 1) {
                            if (direction > 0) targetHeight += gridSize;
                            else targetHeight -= gridSize;

                            if (targetHeight < gridSize / 2) return;
                        }

                        scaleFactor = targetHeight / oldHeight;
                    }
                    if (scaleFactor && isFinite(scaleFactor)) {
                        layer.width *= scaleFactor;
                        layer.height *= scaleFactor;
                        layer.x += (oldWidth - layer.width) / 2;
                        layer.y += (oldHeight - layer.height) / 2;
                    }
                }
            });
        } else {
            const worldCoords = this.getMouseWorldCoordinates(e);
            const rect = this.canvas.getBoundingClientRect();
            const mouseBufferX = (e.clientX - rect.left) * (this.offscreenCanvas.width / rect.width);
            const mouseBufferY = (e.clientY - rect.top) * (this.offscreenCanvas.height / rect.height);

            const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const newZoom = this.viewport.zoom * zoomFactor;

            this.viewport.zoom = Math.max(0.1, Math.min(10, newZoom));
            this.viewport.x = worldCoords.x - (mouseBufferX / this.viewport.zoom);
            this.viewport.y = worldCoords.y - (mouseBufferY / this.viewport.zoom);
        }
        this.render();
        this.saveState(true);
    }

    handleKeyDown(e) {
        if (e.key === 'Control') this.interaction.isCtrlPressed = true;
        if (e.key === 'Alt') {
            this.interaction.isAltPressed = true;
            e.preventDefault();
        }

        if (e.ctrlKey) {
            if (e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) {
                    this.redo();
                } else {
                    this.undo();
                }
                return;
            }
            if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                e.stopPropagation();
                this.redo();
                return;
            }
            if (e.key.toLowerCase() === 'c') {
                if (this.selectedLayers.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.copySelectedLayers();
                }
                return;
            }
            if (e.key.toLowerCase() === 'v') {
                e.preventDefault();
                e.stopPropagation();
                this.handlePaste();
                return;
            }
        }
        
        if (this.selectedLayer) {
            if (e.key === 'Delete') {
                e.preventDefault();
                e.stopPropagation();
                this.saveState();
                this.layers = this.layers.filter(l => !this.selectedLayers.includes(l));
                this.updateSelection([]);
                this.render();
                return;
            }

            const step = e.shiftKey ? 10 : 1;
            let needsRender = false;
            switch (e.code) {
                case 'ArrowLeft':
                case 'ArrowRight':
                case 'ArrowUp':
                case 'ArrowDown':
                case 'BracketLeft':
                case 'BracketRight':
                    e.preventDefault();
                    e.stopPropagation();

                    if (e.code === 'ArrowLeft') this.selectedLayers.forEach(l => l.x -= step);
                    if (e.code === 'ArrowRight') this.selectedLayers.forEach(l => l.x += step);
                    if (e.code === 'ArrowUp') this.selectedLayers.forEach(l => l.y -= step);
                    if (e.code === 'ArrowDown') this.selectedLayers.forEach(l => l.y += step);
                    if (e.code === 'BracketLeft') this.selectedLayers.forEach(l => l.rotation -= step);
                    if (e.code === 'BracketRight') this.selectedLayers.forEach(l => l.rotation += step);

                    needsRender = true;
                    break;
            }

            if (needsRender) {
                this.render();
                this.saveState();
            }
        }
    }

    handleKeyUp(e) {
        if (e.key === 'Control') this.interaction.isCtrlPressed = false;
        if (e.key === 'Alt') this.interaction.isAltPressed = false;
    }

    updateCursor(worldCoords) {
        const transformTarget = this.getHandleAtPosition(worldCoords.x, worldCoords.y);

        if (transformTarget) {
            const handleName = transformTarget.handle;
            const cursorMap = {
                'n': 'ns-resize', 's': 'ns-resize', 'e': 'ew-resize', 'w': 'ew-resize',
                'nw': 'nwse-resize', 'se': 'nwse-resize', 'ne': 'nesw-resize', 'sw': 'nesw-resize',
                'rot': 'grab'
            };
            this.canvas.style.cursor = cursorMap[handleName];
        } else if (this.getLayerAtPosition(worldCoords.x, worldCoords.y)) {
            this.canvas.style.cursor = 'move';
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    startLayerTransform(layer, handle, worldCoords) {
        this.interaction.transformingLayer = layer;
        this.interaction.transformOrigin = {
            x: layer.x, y: layer.y,
            width: layer.width, height: layer.height,
            rotation: layer.rotation,
            centerX: layer.x + layer.width / 2,
            centerY: layer.y + layer.height / 2
        };
        this.interaction.dragStart = {...worldCoords};

        if (handle === 'rot') {
            this.interaction.mode = 'rotating';
        } else {
            this.interaction.mode = 'resizing';
            this.interaction.resizeHandle = handle;
            const handles = this.getHandles(layer);
            const oppositeHandleKey = {
                'n': 's', 's': 'n', 'e': 'w', 'w': 'e',
                'nw': 'se', 'se': 'nw', 'ne': 'sw', 'sw': 'ne'
            }[handle];
            this.interaction.resizeAnchor = handles[oppositeHandleKey];
        }
        this.render();
    }

    startLayerDrag(layer, worldCoords) {
        this.interaction.mode = 'dragging';
        this.interaction.dragStart = {...worldCoords};

        let currentSelection = [...this.selectedLayers];

        if (this.interaction.isCtrlPressed) {
            const index = currentSelection.indexOf(layer);
            if (index === -1) {
                currentSelection.push(layer);
            } else {
                currentSelection.splice(index, 1);
            }
        } else {
            if (!currentSelection.includes(layer)) {
                currentSelection = [layer];
            }
        }

        this.updateSelection(currentSelection);

        this.originalLayerPositions.clear();
        this.selectedLayers.forEach(l => {
            this.originalLayerPositions.set(l, {x: l.x, y: l.y});
        });
    }

    startCanvasResize(worldCoords) {
        this.interaction.mode = 'resizingCanvas';
        const startX = this.snapToGrid(worldCoords.x);
        const startY = this.snapToGrid(worldCoords.y);
        this.interaction.canvasResizeStart = {x: startX, y: startY};
        this.interaction.canvasResizeRect = {x: startX, y: startY, width: 0, height: 0};
        this.render();
    }

    startCanvasMove(worldCoords) {
        this.interaction.mode = 'movingCanvas';
        this.interaction.dragStart = {...worldCoords};
        const initialX = this.snapToGrid(worldCoords.x - this.width / 2);
        const initialY = this.snapToGrid(worldCoords.y - this.height / 2);

        this.interaction.canvasMoveRect = {
            x: initialX,
            y: initialY,
            width: this.width,
            height: this.height
        };

        this.canvas.style.cursor = 'grabbing';
        this.render();
    }


    updateCanvasMove(worldCoords) {
        if (!this.interaction.canvasMoveRect) return;
        const dx = worldCoords.x - this.interaction.dragStart.x;
        const dy = worldCoords.y - this.interaction.dragStart.y;
        const initialRectX = this.snapToGrid(this.interaction.dragStart.x - this.width / 2);
        const initialRectY = this.snapToGrid(this.interaction.dragStart.y - this.height / 2);
        this.interaction.canvasMoveRect.x = this.snapToGrid(initialRectX + dx);
        this.interaction.canvasMoveRect.y = this.snapToGrid(initialRectY + dy);

        this.render();
    }


    finalizeCanvasMove() {
        const moveRect = this.interaction.canvasMoveRect;

        if (moveRect && (moveRect.x !== 0 || moveRect.y !== 0)) {
            const finalX = moveRect.x;
            const finalY = moveRect.y;

            this.layers.forEach(layer => {
                layer.x -= finalX;
                layer.y -= finalY;
            });
            this.viewport.x -= finalX;
            this.viewport.y -= finalY;
        }
        this.render();
    }

    startPanning(e) {
        if (!this.interaction.isCtrlPressed) {
            this.updateSelection([]);
        }
        this.interaction.mode = 'panning';
        this.interaction.panStart = {x: e.clientX, y: e.clientY};
    }

    panViewport(e) {
        const dx = e.clientX - this.interaction.panStart.x;
        const dy = e.clientY - this.interaction.panStart.y;
        this.viewport.x -= dx / this.viewport.zoom;
        this.viewport.y -= dy / this.viewport.zoom;
        this.interaction.panStart = {x: e.clientX, y: e.clientY};
        this.render();
    }

    dragLayers(worldCoords) {
        if (this.interaction.isAltPressed && !this.interaction.hasClonedInDrag && this.selectedLayers.length > 0) {
            const newLayers = [];
            this.selectedLayers.forEach(layer => {
                const newLayer = {
                    ...layer,
                    zIndex: this.layers.length,
                };
                this.layers.push(newLayer);
                newLayers.push(newLayer);
            });
            this.updateSelection(newLayers);
            this.selectedLayer = newLayers.length > 0 ? newLayers[newLayers.length - 1] : null;
            this.originalLayerPositions.clear();
            this.selectedLayers.forEach(l => {
                this.originalLayerPositions.set(l, {x: l.x, y: l.y});
            });
            this.interaction.hasClonedInDrag = true;
        }
        const totalDx = worldCoords.x - this.interaction.dragStart.x;
        const totalDy = worldCoords.y - this.interaction.dragStart.y;
        let finalDx = totalDx, finalDy = totalDy;

        if (this.interaction.isCtrlPressed && this.selectedLayer) {
            const originalPos = this.originalLayerPositions.get(this.selectedLayer);
            if (originalPos) {
                const tempLayerForSnap = {
                    ...this.selectedLayer,
                    x: originalPos.x + totalDx,
                    y: originalPos.y + totalDy
                };
                const snapAdjustment = this.getSnapAdjustment(tempLayerForSnap);
                finalDx += snapAdjustment.dx;
                finalDy += snapAdjustment.dy;
            }
        }

        this.selectedLayers.forEach(layer => {
            const originalPos = this.originalLayerPositions.get(layer);
            if (originalPos) {
                layer.x = originalPos.x + finalDx;
                layer.y = originalPos.y + finalDy;
            }
        });
        this.render();
    }

    resizeLayerFromHandle(worldCoords, isShiftPressed) {
        const layer = this.interaction.transformingLayer;
        if (!layer) return;

        let mouseX = worldCoords.x;
        let mouseY = worldCoords.y;

        if (this.interaction.isCtrlPressed) {
            const snapThreshold = 10 / this.viewport.zoom;
            const snappedMouseX = this.snapToGrid(mouseX);
            if (Math.abs(mouseX - snappedMouseX) < snapThreshold) mouseX = snappedMouseX;
            const snappedMouseY = this.snapToGrid(mouseY);
            if (Math.abs(mouseY - snappedMouseY) < snapThreshold) mouseY = snappedMouseY;
        }

        const o = this.interaction.transformOrigin;
        const handle = this.interaction.resizeHandle;
        const anchor = this.interaction.resizeAnchor;

        const rad = o.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const vecX = mouseX - anchor.x;
        const vecY = mouseY - anchor.y;

        let newWidth = vecX * cos + vecY * sin;
        let newHeight = vecY * cos - vecX * sin;

        if (isShiftPressed) {
            const originalAspectRatio = o.width / o.height;
            const newAspectRatio = Math.abs(newWidth / newHeight);

            if (Math.abs(newWidth) > Math.abs(newHeight) * originalAspectRatio) {
                 newHeight = (Math.sign(newHeight) || 1) * Math.abs(newWidth) / originalAspectRatio;
            } else {
                 newWidth = (Math.sign(newWidth) || 1) * Math.abs(newHeight) * originalAspectRatio;
            }
        }


        let signX = handle.includes('e') ? 1 : (handle.includes('w') ? -1 : 0);
        let signY = handle.includes('s') ? 1 : (handle.includes('n') ? -1 : 0);

        newWidth *= signX;
        newHeight *= signY;

        if (signX === 0) newWidth = o.width;
        if (signY === 0) newHeight = o.height;

        if (newWidth < 10) newWidth = 10;
        if (newHeight < 10) newHeight = 10;

        layer.width = newWidth;
        layer.height = newHeight;

        const deltaW = newWidth - o.width;
        const deltaH = newHeight - o.height;

        const shiftX = (deltaW / 2) * signX;
        const shiftY = (deltaH / 2) * signY;

        const worldShiftX = shiftX * cos - shiftY * sin;
        const worldShiftY = shiftX * sin + shiftY * cos;

        const newCenterX = o.centerX + worldShiftX;
        const newCenterY = o.centerY + worldShiftY;

        layer.x = newCenterX - layer.width / 2;
        layer.y = newCenterY - layer.height / 2;
        this.render();
    }


    rotateLayerFromHandle(worldCoords, isShiftPressed) {
        const layer = this.interaction.transformingLayer;
        if (!layer) return;

        const o = this.interaction.transformOrigin;
        const startAngle = Math.atan2(this.interaction.dragStart.y - o.centerY, this.interaction.dragStart.x - o.centerX);
        const currentAngle = Math.atan2(worldCoords.y - o.centerY, worldCoords.x - o.centerX);
        let angleDiff = (currentAngle - startAngle) * 180 / Math.PI;
        let newRotation = o.rotation + angleDiff;

        if (isShiftPressed) {
            newRotation = Math.round(newRotation / 15) * 15;
        }

        layer.rotation = newRotation;
        this.render();
    }

    updateCanvasResize(worldCoords) {
        const snappedMouseX = this.snapToGrid(worldCoords.x);
        const snappedMouseY = this.snapToGrid(worldCoords.y);
        const start = this.interaction.canvasResizeStart;

        this.interaction.canvasResizeRect.x = Math.min(snappedMouseX, start.x);
        this.interaction.canvasResizeRect.y = Math.min(snappedMouseY, start.y);
        this.interaction.canvasResizeRect.width = Math.abs(snappedMouseX - start.x);
        this.interaction.canvasResizeRect.height = Math.abs(snappedMouseY - start.y);
        this.render();
    }

    finalizeCanvasResize() {
        if (this.interaction.canvasResizeRect && this.interaction.canvasResizeRect.width > 1 && this.interaction.canvasResizeRect.height > 1) {
            const newWidth = Math.round(this.interaction.canvasResizeRect.width);
            const newHeight = Math.round(this.interaction.canvasResizeRect.height);
            const rectX = this.interaction.canvasResizeRect.x;
            const rectY = this.interaction.canvasResizeRect.y;

            this.updateCanvasSize(newWidth, newHeight);

            this.layers.forEach(layer => {
                layer.x -= rectX;
                layer.y -= rectY;
            });

            this.viewport.x -= rectX;
            this.viewport.y -= rectY;
        }
    }


    isRotationHandle(x, y) {
        if (!this.selectedLayer) return false;

        const handleX = this.selectedLayer.x + this.selectedLayer.width / 2;
        const handleY = this.selectedLayer.y - 20;
        const handleRadius = 5;

        return Math.sqrt(Math.pow(x - handleX, 2) + Math.pow(y - handleY, 2)) <= handleRadius;
    }

    addLayer(image) {
        try {
            console.log("Adding layer with image:", image);

            const layer = {
                image: image,
                x: (this.width - image.width) / 2,
                y: (this.height - image.height) / 2,
                width: image.width,
                height: image.height,
                rotation: 0,
                zIndex: this.layers.length,
                blendMode: 'normal',
                opacity: 1
            };

            this.layers.push(layer);
            this.updateSelection([layer]);
            this.render();
            this.saveState();

            console.log("Layer added successfully");
        } catch (error) {
            console.error("Error adding layer:", error);
            throw error;
        }
    }

    removeLayer(index) {
        if (index >= 0 && index < this.layers.length) {
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

            maskCtx.fillStyle = '#000000';
            maskCtx.fillRect(0, 0, this.width, this.height);

            this.layers.sort((a, b) => a.zIndex - b.zIndex).forEach(layer => {

                tempCtx.save();

                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;

                tempCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2,
                    -layer.height / 2,
                    layer.width,
                    layer.height
                );
                tempCtx.restore();

                maskCtx.save();
                maskCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                maskCtx.rotate(layer.rotation * Math.PI / 180);
                maskCtx.globalCompositeOperation = 'lighter';

                if (layer.mask) {
                    maskCtx.drawImage(layer.mask, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                } else {

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
                        alphaData.data[i] = alphaData.data[i + 1] = alphaData.data[i + 2] = alpha;
                        alphaData.data[i + 3] = 255;
                    }

                    alphaCtx.putImageData(alphaData, 0, 0);
                    maskCtx.drawImage(alphaCanvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                }
                maskCtx.restore();
            });

            const finalMaskData = maskCtx.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < finalMaskData.data.length; i += 4) {
                finalMaskData.data[i] =
                    finalMaskData.data[i + 1] =
                        finalMaskData.data[i + 2] = 255 - finalMaskData.data[i];
                finalMaskData.data[i + 3] = 255;
            }
            maskCtx.putImageData(finalMaskData, 0, 0);

            tempCanvas.toBlob(async (blob) => {
                const formData = new FormData();
                formData.append("image", blob, fileName);
                formData.append("overwrite", "true");

                try {
                    const resp = await fetch("/upload/image", {
                        method: "POST",
                        body: formData,
                    });

                    if (resp.status === 200) {

                        maskCanvas.toBlob(async (maskBlob) => {
                            const maskFormData = new FormData();
                            const maskFileName = fileName.replace('.png', '_mask.png');
                            maskFormData.append("image", maskBlob, maskFileName);
                            maskFormData.append("overwrite", "true");

                            try {
                                const maskResp = await fetch("/upload/image", {
                                    method: "POST",
                                    body: maskFormData,
                                });

                                if (maskResp.status === 200) {
                                    const data = await resp.json();
                                    this.widget.value = data.name;
                                    resolve(true);
                                } else {
                                    console.error("Error saving mask: " + maskResp.status);
                                    resolve(false);
                                }
                            } catch (error) {
                                console.error("Error saving mask:", error);
                                resolve(false);
                            }
                        }, "image/png");
                    } else {
                        console.error(resp.status + " - " + resp.statusText);
                        resolve(false);
                    }
                } catch (error) {
                    console.error(error);
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

    mirrorHorizontal() {
        if (this.selectedLayers.length === 0) return;

        this.selectedLayers.forEach(layer => {
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
                this.render();
                this.saveState();
            };
            newImage.src = tempCanvas.toDataURL();
        });
    }

    mirrorVertical() {
        if (this.selectedLayers.length === 0) return;

        this.selectedLayers.forEach(layer => {
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
                this.render();
                this.saveState();
            };
            newImage.src = tempCanvas.toDataURL();
        });
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
            console.error("Error getting layer image data:", error);
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
            console.log("Adding input to canvas:", {inputImage});

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

            const layer = {
                image: image,
                x: (this.width - inputImage.width * scale) / 2,
                y: (this.height - inputImage.height * scale) / 2,
                width: inputImage.width * scale,
                height: inputImage.height * scale,
                rotation: 0,
                zIndex: this.layers.length
            };

            if (inputMask) {
                layer.mask = inputMask.data;
            }

            this.layers.push(layer);
            this.selectedLayer = layer;

            this.render();
            console.log("Layer added successfully");

            return true;

        } catch (error) {
            console.error("Error in addInputToCanvas:", error);
            throw error;
        }
    }

    async convertTensorToImage(tensor) {
        try {
            console.log("Converting tensor to image:", tensor);

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
            console.error("Error converting tensor to image:", error);
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
            console.log("Starting node data initialization...");

            if (!this.node || !this.node.inputs) {
                console.log("Node or inputs not ready");
                return this.scheduleDataCheck();
            }

            if (this.node.inputs[0] && this.node.inputs[0].link) {
                const imageLinkId = this.node.inputs[0].link;
                const imageData = app.nodeOutputs[imageLinkId];

                if (imageData) {
                    console.log("Found image data:", imageData);
                    await this.processImageData(imageData);
                    this.dataInitialized = true;
                } else {
                    console.log("Image data not available yet");
                    return this.scheduleDataCheck();
                }
            }

            if (this.node.inputs[1] && this.node.inputs[1].link) {
                const maskLinkId = this.node.inputs[1].link;
                const maskData = app.nodeOutputs[maskLinkId];

                if (maskData) {
                    console.log("Found mask data:", maskData);
                    await this.processMaskData(maskData);
                }
            }

        } catch (error) {
            console.error("Error in initNodeData:", error);
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

            console.log("Processing image data:", {
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
                console.log("Image layer added successfully with scale:", scale);
            }
        } catch (error) {
            console.error("Error processing image data:", error);
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

            console.log("Scaled layer added:", {
                originalSize: `${image.width}x${image.height}`,
                scaledSize: `${scaledWidth}x${scaledHeight}`,
                scale: scale
            });
        } catch (error) {
            console.error("Error adding scaled layer:", error);
            throw error;
        }
    }

    convertTensorToImageData(tensor) {
        try {
            const shape = tensor.shape;
            const height = shape[1];
            const width = shape[2];
            const channels = shape[3];

            console.log("Converting tensor:", {
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
            console.error("Error converting tensor:", error);
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
                console.warn(`Retry ${i + 1}/${maxRetries} failed:`, error);
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        console.error("Failed to load data after", maxRetries, "retries");
    }

    async processMaskData(maskData) {
        try {
            if (!maskData) return;

            console.log("Processing mask data:", maskData);

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
                console.log("Mask applied to selected layer");
            }
        } catch (error) {
            console.error("Error processing mask data:", error);
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
            console.log("Starting image import with cache data");
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
            console.error('Error importing image:', error);
        }
    }

    async importLatestImage() {
        try {
            console.log("Fetching latest image from server...");
            const response = await fetch('/ycnode/get_latest_image');
            const result = await response.json();

            if (result.success && result.image_data) {
                console.log("Latest image received, adding to canvas.");
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = result.image_data;
                });

                const layer = {
                    image: img,
                    x: 0,
                    y: 0,
                    width: this.width,
                    height: this.height,
                    rotation: 0,
                    zIndex: this.layers.length,
                    blendMode: 'normal',
                    opacity: 1
                };

                this.layers.push(layer);
                this.selectedLayers = [layer];
                this.selectedLayer = layer;
                this.render();
                console.log("Latest image imported and placed on canvas successfully.");
                return true;
            } else {
                throw new Error(result.error || "Failed to fetch the latest image.");
            }
        } catch (error) {
            console.error("Error importing latest image:", error);
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
