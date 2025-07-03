import {createModuleLogger} from "./utils/LoggerUtils.js";
import {snapToGrid, getSnapAdjustment} from "./utils/CommonUtils.js";

const log = createModuleLogger('CanvasInteractions');

export class CanvasInteractions {
    constructor(canvas) {
        this.canvas = canvas;
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
            keyMovementInProgress: false, // Flaga do śledzenia ruchu klawiszami
        };
        this.originalLayerPositions = new Map();
        this.interaction.canvasResizeRect = null;
        this.interaction.canvasMoveRect = null;
    }

    setupEventListeners() {
        this.canvas.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        this.canvas.canvas.addEventListener('wheel', this.handleWheel.bind(this), {passive: false});
        this.canvas.canvas.addEventListener('keydown', this.handleKeyDown.bind(this));
        this.canvas.canvas.addEventListener('keyup', this.handleKeyUp.bind(this));

        document.addEventListener('paste', this.handlePasteEvent.bind(this));

        this.canvas.canvas.addEventListener('mouseenter', (e) => {
            this.canvas.isMouseOver = true;
            this.handleMouseEnter(e);
        });
        this.canvas.canvas.addEventListener('mouseleave', (e) => {
            this.canvas.isMouseOver = false;
            this.handleMouseLeave(e);
        });

        this.canvas.canvas.addEventListener('dragover', this.handleDragOver.bind(this));
        this.canvas.canvas.addEventListener('dragenter', this.handleDragEnter.bind(this));
        this.canvas.canvas.addEventListener('dragleave', this.handleDragLeave.bind(this));
        this.canvas.canvas.addEventListener('drop', this.handleDrop.bind(this));

        this.canvas.canvas.addEventListener('contextmenu', this.handleContextMenu.bind(this));
    }

    resetInteractionState() {
        this.interaction.mode = 'none';
        this.interaction.resizeHandle = null;
        this.originalLayerPositions.clear();
        this.interaction.canvasResizeRect = null;
        this.interaction.canvasMoveRect = null;
        this.interaction.hasClonedInDrag = false;
        this.interaction.transformingLayer = null;
        this.canvas.canvas.style.cursor = 'default';
    }

    handleMouseDown(e) {
        this.canvas.canvas.focus();
        const worldCoords = this.canvas.getMouseWorldCoordinates(e);
        const viewCoords = this.canvas.getMouseViewCoordinates(e);

        if (this.interaction.mode === 'drawingMask') {
            this.canvas.maskTool.handleMouseDown(worldCoords, viewCoords);
            this.canvas.render();
            return;
        }

        // --- Ostateczna, poprawna kolejność sprawdzania ---

        // 1. Akcje globalne z modyfikatorami (mają najwyższy priorytet)
        if (e.shiftKey && e.ctrlKey) {
            this.startCanvasMove(worldCoords);
            return;
        }
        if (e.shiftKey) {
            this.startCanvasResize(worldCoords);
            return;
        }
        
        // 2. Inne przyciski myszy
        if (e.button === 2) { // Prawy przycisk myszy
            const clickedLayerResult = this.canvas.canvasLayers.getLayerAtPosition(worldCoords.x, worldCoords.y);
            if (clickedLayerResult && this.canvas.canvasSelection.selectedLayers.includes(clickedLayerResult.layer)) {
                e.preventDefault();
                this.canvas.canvasLayers.showBlendModeMenu(viewCoords.x, viewCoords.y);
            }
            return; 
        }
        if (e.button !== 0) { // Środkowy przycisk
            this.startPanning(e);
            return;
        }

        // 3. Interakcje z elementami na płótnie (lewy przycisk)
        const transformTarget = this.canvas.canvasLayers.getHandleAtPosition(worldCoords.x, worldCoords.y);
        if (transformTarget) {
            this.startLayerTransform(transformTarget.layer, transformTarget.handle, worldCoords);
            return;
        }

        const clickedLayerResult = this.canvas.canvasLayers.getLayerAtPosition(worldCoords.x, worldCoords.y);
        if (clickedLayerResult) {
            this.prepareForDrag(clickedLayerResult.layer, worldCoords);
            return;
        }
        
        // 4. Domyślna akcja na tle (lewy przycisk bez modyfikatorów)
        this.startPanningOrClearSelection(e);
    }

    handleMouseMove(e) {
        const worldCoords = this.canvas.getMouseWorldCoordinates(e);
        const viewCoords = this.canvas.getMouseViewCoordinates(e);
        this.canvas.lastMousePosition = worldCoords; // Zawsze aktualizuj ostatnią pozycję myszy
        
        // Sprawdź, czy rozpocząć przeciąganie
        if (this.interaction.mode === 'potential-drag') {
            const dx = worldCoords.x - this.interaction.dragStart.x;
            const dy = worldCoords.y - this.interaction.dragStart.y;
            if (Math.sqrt(dx * dx + dy * dy) > 3) { // Próg 3 pikseli
                this.interaction.mode = 'dragging';
                this.originalLayerPositions.clear();
                this.canvas.canvasSelection.selectedLayers.forEach(l => {
                    this.originalLayerPositions.set(l, {x: l.x, y: l.y});
                });
            }
        }
        
        switch (this.interaction.mode) {
            case 'drawingMask':
                this.canvas.maskTool.handleMouseMove(worldCoords, viewCoords);
                this.canvas.render();
                break;
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
        const viewCoords = this.canvas.getMouseViewCoordinates(e);
        if (this.interaction.mode === 'drawingMask') {
            this.canvas.maskTool.handleMouseUp(viewCoords);
            this.canvas.render();
            return;
        }

        if (this.interaction.mode === 'resizingCanvas') {
            this.finalizeCanvasResize();
        }
        if (this.interaction.mode === 'movingCanvas') {
            this.finalizeCanvasMove();
        }

        // Zapisz stan tylko, jeśli faktycznie doszło do zmiany (przeciąganie, transformacja, duplikacja)
        const stateChangingInteraction = ['dragging', 'resizing', 'rotating'].includes(this.interaction.mode);
        const duplicatedInDrag = this.interaction.hasClonedInDrag;

        if (stateChangingInteraction || duplicatedInDrag) {
            this.canvas.saveState();
            this.canvas.canvasState.saveStateToDB(true);
        }

        this.resetInteractionState();
        this.canvas.render();
    }

    handleMouseLeave(e) {
        const viewCoords = this.canvas.getMouseViewCoordinates(e);
        if (this.canvas.maskTool.isActive) {
            this.canvas.maskTool.handleMouseLeave();
            if (this.canvas.maskTool.isDrawing) {
                this.canvas.maskTool.handleMouseUp(viewCoords);
            }
            this.canvas.render();
            return;
        }
        if (this.interaction.mode !== 'none') {
            this.resetInteractionState();
            this.canvas.render();
        }

        if (this.canvas.canvasLayers.internalClipboard.length > 0) {
            this.canvas.canvasLayers.internalClipboard = [];
            log.info("Internal clipboard cleared - mouse left canvas");
        }
    }

    handleMouseEnter(e) {
        if (this.canvas.maskTool.isActive) {
            this.canvas.maskTool.handleMouseEnter();
        }
    }

    handleContextMenu(e) {

        e.preventDefault();
    }

    handleWheel(e) {
        e.preventDefault();
        if (this.canvas.maskTool.isActive) {
            const worldCoords = this.canvas.getMouseWorldCoordinates(e);
            const rect = this.canvas.canvas.getBoundingClientRect();
            const mouseBufferX = (e.clientX - rect.left) * (this.canvas.offscreenCanvas.width / rect.width);
            const mouseBufferY = (e.clientY - rect.top) * (this.canvas.offscreenCanvas.height / rect.height);

            const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const newZoom = this.canvas.viewport.zoom * zoomFactor;

            this.canvas.viewport.zoom = Math.max(0.1, Math.min(10, newZoom));
            this.canvas.viewport.x = worldCoords.x - (mouseBufferX / this.canvas.viewport.zoom);
            this.canvas.viewport.y = worldCoords.y - (mouseBufferY / this.canvas.viewport.zoom);
        } else if (this.canvas.selectedLayer) {
            const rotationStep = 5 * (e.deltaY > 0 ? -1 : 1);
            const direction = e.deltaY < 0 ? 1 : -1; // 1 = up/right, -1 = down/left

            this.canvas.canvasSelection.selectedLayers.forEach(layer => {
                if (e.shiftKey) {
                    // Nowy skrót: Shift + Ctrl + Kółko do przyciągania do absolutnych wartości
                    if (e.ctrlKey) {
                        const snapAngle = 5;
                        if (direction > 0) { // Obrót w górę/prawo
                            layer.rotation = Math.ceil((layer.rotation + 0.1) / snapAngle) * snapAngle;
                        } else { // Obrót w dół/lewo
                            layer.rotation = Math.floor((layer.rotation - 0.1) / snapAngle) * snapAngle;
                        }
                    } else {
                        // Stara funkcjonalność: Shift + Kółko obraca o stały krok
                        layer.rotation += rotationStep;
                    }
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
            const worldCoords = this.canvas.getMouseWorldCoordinates(e);
            const rect = this.canvas.canvas.getBoundingClientRect();
            const mouseBufferX = (e.clientX - rect.left) * (this.canvas.offscreenCanvas.width / rect.width);
            const mouseBufferY = (e.clientY - rect.top) * (this.canvas.offscreenCanvas.height / rect.height);

            const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            const newZoom = this.canvas.viewport.zoom * zoomFactor;

            this.canvas.viewport.zoom = Math.max(0.1, Math.min(10, newZoom));
            this.canvas.viewport.x = worldCoords.x - (mouseBufferX / this.canvas.viewport.zoom);
            this.canvas.viewport.y = worldCoords.y - (mouseBufferY / this.canvas.viewport.zoom);
        }
        this.canvas.render();
        if (!this.canvas.maskTool.isActive) {
            this.canvas.requestSaveState(true); // Użyj opóźnionego zapisu
        }
    }

    handleKeyDown(e) {
        if (e.key === 'Control') this.interaction.isCtrlPressed = true;
        if (e.key === 'Alt') {
            this.interaction.isAltPressed = true;
            e.preventDefault();
        }

        // Globalne skróty (Undo/Redo/Copy/Paste)
        if (e.ctrlKey || e.metaKey) {
            let handled = true;
            switch (e.key.toLowerCase()) {
                case 'z':
                    if (e.shiftKey) {
                        this.canvas.redo();
                    } else {
                        this.canvas.undo();
                    }
                    break;
                case 'y':
                    this.canvas.redo();
                    break;
                case 'c':
                    if (this.canvas.canvasSelection.selectedLayers.length > 0) {
                        this.canvas.canvasLayers.copySelectedLayers();
                    }
                    break;
                case 'v':
                     this.canvas.canvasLayers.handlePaste('mouse');
                    break;
                default:
                    handled = false;
                    break;
            }
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        // Skróty kontekstowe (zależne od zaznaczenia)
        if (this.canvas.canvasSelection.selectedLayers.length > 0) {
            const step = e.shiftKey ? 10 : 1;
            let needsRender = false;
            
            // Używamy e.code dla spójności i niezależności od układu klawiatury
            const movementKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'BracketLeft', 'BracketRight'];
            if (movementKeys.includes(e.code)) {
                e.preventDefault();
                e.stopPropagation();
                this.interaction.keyMovementInProgress = true;

                if (e.code === 'ArrowLeft') this.canvas.canvasSelection.selectedLayers.forEach(l => l.x -= step);
                if (e.code === 'ArrowRight') this.canvas.canvasSelection.selectedLayers.forEach(l => l.x += step);
                if (e.code === 'ArrowUp') this.canvas.canvasSelection.selectedLayers.forEach(l => l.y -= step);
                if (e.code === 'ArrowDown') this.canvas.canvasSelection.selectedLayers.forEach(l => l.y += step);
                if (e.code === 'BracketLeft') this.canvas.canvasSelection.selectedLayers.forEach(l => l.rotation -= step);
                if (e.code === 'BracketRight') this.canvas.canvasSelection.selectedLayers.forEach(l => l.rotation += step);
                
                needsRender = true;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                this.canvas.canvasSelection.removeSelectedLayers();
                return;
            }
            
            if (needsRender) {
                this.canvas.render();
            }
        }
    }

    handleKeyUp(e) {
        if (e.key === 'Control') this.interaction.isCtrlPressed = false;
        if (e.key === 'Alt') this.interaction.isAltPressed = false;

        const movementKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'BracketLeft', 'BracketRight'];
        if (movementKeys.includes(e.code) && this.interaction.keyMovementInProgress) {
            this.canvas.requestSaveState(); // Użyj opóźnionego zapisu
            this.interaction.keyMovementInProgress = false;
        }
    }

    updateCursor(worldCoords) {
        const transformTarget = this.canvas.canvasLayers.getHandleAtPosition(worldCoords.x, worldCoords.y);

        if (transformTarget) {
            const handleName = transformTarget.handle;
            const cursorMap = {
                'n': 'ns-resize', 's': 'ns-resize', 'e': 'ew-resize', 'w': 'ew-resize',
                'nw': 'nwse-resize', 'se': 'nwse-resize', 'ne': 'nesw-resize', 'sw': 'nesw-resize',
                'rot': 'grab'
            };
            this.canvas.canvas.style.cursor = cursorMap[handleName];
        } else if (this.canvas.canvasLayers.getLayerAtPosition(worldCoords.x, worldCoords.y)) {
            this.canvas.canvas.style.cursor = 'move';
        } else {
            this.canvas.canvas.style.cursor = 'default';
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
            const handles = this.canvas.canvasLayers.getHandles(layer);
            const oppositeHandleKey = {
                'n': 's', 's': 'n', 'e': 'w', 'w': 'e',
                'nw': 'se', 'se': 'nw', 'ne': 'sw', 'sw': 'ne'
            }[handle];
            this.interaction.resizeAnchor = handles[oppositeHandleKey];
        }
        this.canvas.render();
    }

    prepareForDrag(layer, worldCoords) {
        // Zaktualizuj zaznaczenie, ale nie zapisuj stanu
        if (this.interaction.isCtrlPressed) {
            const index = this.canvas.canvasSelection.selectedLayers.indexOf(layer);
            if (index === -1) {
                this.canvas.canvasSelection.updateSelection([...this.canvas.canvasSelection.selectedLayers, layer]);
            } else {
                const newSelection = this.canvas.canvasSelection.selectedLayers.filter(l => l !== layer);
                this.canvas.canvasSelection.updateSelection(newSelection);
            }
        } else {
            if (!this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                this.canvas.canvasSelection.updateSelection([layer]);
            }
        }
        
        this.interaction.mode = 'potential-drag';
        this.interaction.dragStart = {...worldCoords};
    }

    startPanningOrClearSelection(e) {
        // Ta funkcja jest teraz wywoływana tylko gdy kliknięto na tło bez modyfikatorów.
        // Domyślna akcja: wyczyść zaznaczenie i rozpocznij panoramowanie.
        if (!this.interaction.isCtrlPressed) {
            this.canvas.canvasSelection.updateSelection([]);
        }
        this.interaction.mode = 'panning';
        this.interaction.panStart = {x: e.clientX, y: e.clientY};
    }

    startCanvasResize(worldCoords) {
        this.interaction.mode = 'resizingCanvas';
        const startX = snapToGrid(worldCoords.x);
        const startY = snapToGrid(worldCoords.y);
        this.interaction.canvasResizeStart = {x: startX, y: startY};
        this.interaction.canvasResizeRect = {x: startX, y: startY, width: 0, height: 0};
        this.canvas.render();
    }

    startCanvasMove(worldCoords) {
        this.interaction.mode = 'movingCanvas';
        this.interaction.dragStart = {...worldCoords};
        const initialX = snapToGrid(worldCoords.x - this.canvas.width / 2);
        const initialY = snapToGrid(worldCoords.y - this.canvas.height / 2);

        this.interaction.canvasMoveRect = {
            x: initialX,
            y: initialY,
            width: this.canvas.width,
            height: this.canvas.height
        };

        this.canvas.canvas.style.cursor = 'grabbing';
        this.canvas.render();
    }

    updateCanvasMove(worldCoords) {
        if (!this.interaction.canvasMoveRect) return;
        const dx = worldCoords.x - this.interaction.dragStart.x;
        const dy = worldCoords.y - this.interaction.dragStart.y;
        const initialRectX = snapToGrid(this.interaction.dragStart.x - this.canvas.width / 2);
        const initialRectY = snapToGrid(this.interaction.dragStart.y - this.canvas.height / 2);
        this.interaction.canvasMoveRect.x = snapToGrid(initialRectX + dx);
        this.interaction.canvasMoveRect.y = snapToGrid(initialRectY + dy);

        this.canvas.render();
    }

    finalizeCanvasMove() {
        const moveRect = this.interaction.canvasMoveRect;

        if (moveRect && (moveRect.x !== 0 || moveRect.y !== 0)) {
            const finalX = moveRect.x;
            const finalY = moveRect.y;

            this.canvas.layers.forEach(layer => {
                layer.x -= finalX;
                layer.y -= finalY;
            });

            this.canvas.maskTool.updatePosition(-finalX, -finalY);

            // If a batch generation is in progress, update the captured context as well
            if (this.canvas.pendingBatchContext) {
                this.canvas.pendingBatchContext.outputArea.x -= finalX;
                this.canvas.pendingBatchContext.outputArea.y -= finalY;
                
                // Also update the menu spawn position to keep it relative
                this.canvas.pendingBatchContext.spawnPosition.x -= finalX;
                this.canvas.pendingBatchContext.spawnPosition.y -= finalY;
                log.debug("Updated pending batch context during canvas move:", this.canvas.pendingBatchContext);
            }

            // Also move any active batch preview menus
            if (this.canvas.batchPreviewManagers && this.canvas.batchPreviewManagers.length > 0) {
                this.canvas.batchPreviewManagers.forEach(manager => {
                    manager.worldX -= finalX;
                    manager.worldY -= finalY;
                    if (manager.generationArea) {
                        manager.generationArea.x -= finalX;
                        manager.generationArea.y -= finalY;
                    }
                });
            }

            this.canvas.viewport.x -= finalX;
            this.canvas.viewport.y -= finalY;
        }
        this.canvas.render();
        this.canvas.saveState();
    }

    startPanning(e) {
        if (!this.interaction.isCtrlPressed) {
            this.canvas.canvasSelection.updateSelection([]);
        }
        this.interaction.mode = 'panning';
        this.interaction.panStart = {x: e.clientX, y: e.clientY};
    }

    panViewport(e) {
        const dx = e.clientX - this.interaction.panStart.x;
        const dy = e.clientY - this.interaction.panStart.y;
        this.canvas.viewport.x -= dx / this.canvas.viewport.zoom;
        this.canvas.viewport.y -= dy / this.canvas.viewport.zoom;
        this.interaction.panStart = {x: e.clientX, y: e.clientY};
        this.canvas.render();
    }

    dragLayers(worldCoords) {
        if (this.interaction.isAltPressed && !this.interaction.hasClonedInDrag && this.canvas.canvasSelection.selectedLayers.length > 0) {
            // Scentralizowana logika duplikowania
            const newLayers = this.canvas.canvasSelection.duplicateSelectedLayers();
            
            // Zresetuj pozycje przeciągania dla nowych, zduplikowanych warstw
            this.originalLayerPositions.clear();
            newLayers.forEach(l => {
                this.originalLayerPositions.set(l, {x: l.x, y: l.y});
            });
            this.interaction.hasClonedInDrag = true;
        }
        const totalDx = worldCoords.x - this.interaction.dragStart.x;
        const totalDy = worldCoords.y - this.interaction.dragStart.y;
        let finalDx = totalDx, finalDy = totalDy;

        if (this.interaction.isCtrlPressed && this.canvas.canvasSelection.selectedLayer) {
            const originalPos = this.originalLayerPositions.get(this.canvas.canvasSelection.selectedLayer);
            if (originalPos) {
                const tempLayerForSnap = {
                    ...this.canvas.canvasSelection.selectedLayer,
                    x: originalPos.x + totalDx,
                    y: originalPos.y + totalDy
                };
                const snapAdjustment = getSnapAdjustment(tempLayerForSnap);
                finalDx += snapAdjustment.dx;
                finalDy += snapAdjustment.dy;
            }
        }

        this.canvas.canvasSelection.selectedLayers.forEach(layer => {
            const originalPos = this.originalLayerPositions.get(layer);
            if (originalPos) {
                layer.x = originalPos.x + finalDx;
                layer.y = originalPos.y + finalDy;
            }
        });
        this.canvas.render();
    }

    resizeLayerFromHandle(worldCoords, isShiftPressed) {
        const layer = this.interaction.transformingLayer;
        if (!layer) return;

        let mouseX = worldCoords.x;
        let mouseY = worldCoords.y;

        if (this.interaction.isCtrlPressed) {
            const snapThreshold = 10 / this.canvas.viewport.zoom;
            const snappedMouseX = snapToGrid(mouseX);
            if (Math.abs(mouseX - snappedMouseX) < snapThreshold) mouseX = snappedMouseX;
            const snappedMouseY = snapToGrid(mouseY);
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
        this.canvas.render();
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
        this.canvas.render();
    }

    updateCanvasResize(worldCoords) {
        const snappedMouseX = snapToGrid(worldCoords.x);
        const snappedMouseY = snapToGrid(worldCoords.y);
        const start = this.interaction.canvasResizeStart;

        this.interaction.canvasResizeRect.x = Math.min(snappedMouseX, start.x);
        this.interaction.canvasResizeRect.y = Math.min(snappedMouseY, start.y);
        this.interaction.canvasResizeRect.width = Math.abs(snappedMouseX - start.x);
        this.interaction.canvasResizeRect.height = Math.abs(snappedMouseY - start.y);
        this.canvas.render();
    }

    finalizeCanvasResize() {
        if (this.interaction.canvasResizeRect && this.interaction.canvasResizeRect.width > 1 && this.interaction.canvasResizeRect.height > 1) {
            const newWidth = Math.round(this.interaction.canvasResizeRect.width);
            const newHeight = Math.round(this.interaction.canvasResizeRect.height);
            const finalX = this.interaction.canvasResizeRect.x;
            const finalY = this.interaction.canvasResizeRect.y;

            this.canvas.updateOutputAreaSize(newWidth, newHeight);

            this.canvas.layers.forEach(layer => {
                layer.x -= finalX;
                layer.y -= finalY;
            });

            this.canvas.maskTool.updatePosition(-finalX, -finalY);

            // If a batch generation is in progress, update the captured context as well
            if (this.canvas.pendingBatchContext) {
                this.canvas.pendingBatchContext.outputArea.x -= finalX;
                this.canvas.pendingBatchContext.outputArea.y -= finalY;
                
                // Also update the menu spawn position to keep it relative
                this.canvas.pendingBatchContext.spawnPosition.x -= finalX;
                this.canvas.pendingBatchContext.spawnPosition.y -= finalY;
                log.debug("Updated pending batch context during canvas resize:", this.canvas.pendingBatchContext);
            }

            // Also move any active batch preview menus
            if (this.canvas.batchPreviewManagers && this.canvas.batchPreviewManagers.length > 0) {
                this.canvas.batchPreviewManagers.forEach(manager => {
                    manager.worldX -= finalX;
                    manager.worldY -= finalY;
                    if (manager.generationArea) {
                        manager.generationArea.x -= finalX;
                        manager.generationArea.y -= finalY;
                    }
                });
            }

            this.canvas.viewport.x -= finalX;
            this.canvas.viewport.y -= finalY;
        }
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation(); // Prevent ComfyUI from handling this event
        e.dataTransfer.dropEffect = 'copy';
    }

    handleDragEnter(e) {
        e.preventDefault();
        e.stopPropagation(); // Prevent ComfyUI from handling this event
        this.canvas.canvas.style.backgroundColor = 'rgba(45, 90, 160, 0.1)';
        this.canvas.canvas.style.border = '2px dashed #2d5aa0';
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation(); // Prevent ComfyUI from handling this event

        if (!this.canvas.canvas.contains(e.relatedTarget)) {
            this.canvas.canvas.style.backgroundColor = '';
            this.canvas.canvas.style.border = '';
        }
    }

    async handleDrop(e) {
        e.preventDefault();
        e.stopPropagation(); // CRITICAL: Prevent ComfyUI from handling this event and loading workflow
        
        log.info("Canvas drag & drop event intercepted - preventing ComfyUI workflow loading");

        this.canvas.canvas.style.backgroundColor = '';
        this.canvas.canvas.style.border = '';

        const files = Array.from(e.dataTransfer.files);
        const worldCoords = this.canvas.getMouseWorldCoordinates(e);
        
        log.info(`Dropped ${files.length} file(s) onto canvas at position (${worldCoords.x}, ${worldCoords.y})`);

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                try {
                    await this.loadDroppedImageFile(file, worldCoords);
                    log.info(`Successfully loaded dropped image: ${file.name}`);
                } catch (error) {
                    log.error(`Failed to load dropped image ${file.name}:`, error);
                }
            } else {
                log.warn(`Skipped non-image file: ${file.name} (${file.type})`);
            }
        }
    }

    async loadDroppedImageFile(file, worldCoords) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const img = new Image();
            img.onload = async () => {

                const fitOnAddWidget = this.canvas.node.widgets.find(w => w.name === "fit_on_add");
                const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';

                await this.canvas.addLayer(img, {}, addMode);
            };
            img.onerror = () => {
                log.error(`Failed to load dropped image: ${file.name}`);
            };
            img.src = e.target.result;
        };
        reader.onerror = () => {
            log.error(`Failed to read dropped file: ${file.name}`);
        };
        reader.readAsDataURL(file);
    }

    async handlePasteEvent(e) {

        const shouldHandle = this.canvas.isMouseOver || 
                           this.canvas.canvas.contains(document.activeElement) ||
                           document.activeElement === this.canvas.canvas ||
                           document.activeElement === document.body;
        
        if (!shouldHandle) {
            log.debug("Paste event ignored - not focused on canvas");
            return;
        }

        log.info("Paste event detected, checking clipboard preference");

        const preference = this.canvas.canvasLayers.clipboardPreference;
        
        if (preference === 'clipspace') {

            log.info("Clipboard preference is clipspace, delegating to ClipboardManager");
            e.preventDefault();
            e.stopPropagation();
            await this.canvas.canvasLayers.clipboardManager.handlePaste('mouse', preference);
            return;
        }

        const clipboardData = e.clipboardData;
        if (clipboardData && clipboardData.items) {
            for (const item of clipboardData.items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const file = item.getAsFile();
                    if (file) {
                        log.info("Found direct image data in paste event");
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                            const img = new Image();
                            img.onload = async () => {
                                await this.canvas.canvasLayers.addLayerWithImage(img, {}, 'mouse');
                            };
                            img.src = event.target.result;
                        };
                        reader.readAsDataURL(file);
                        return;
                    }
                }
            }
        }

        await this.canvas.canvasLayers.clipboardManager.handlePaste('mouse', preference);
    }
}
