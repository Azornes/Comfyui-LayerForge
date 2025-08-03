import { createModuleLogger } from "./utils/LoggerUtils.js";
import { snapToGrid, getSnapAdjustment } from "./utils/CommonUtils.js";
const log = createModuleLogger('CanvasInteractions');
export class CanvasInteractions {
    constructor(canvas) {
        this.canvas = canvas;
        this.interaction = {
            mode: 'none',
            panStart: { x: 0, y: 0 },
            dragStart: { x: 0, y: 0 },
            transformOrigin: {},
            resizeHandle: null,
            resizeAnchor: { x: 0, y: 0 },
            canvasResizeStart: { x: 0, y: 0 },
            isCtrlPressed: false,
            isAltPressed: false,
            isShiftPressed: false,
            isSPressed: false,
            hasClonedInDrag: false,
            lastClickTime: 0,
            transformingLayer: null,
            keyMovementInProgress: false,
            canvasResizeRect: null,
            canvasMoveRect: null,
        };
        this.originalLayerPositions = new Map();
    }
    // Helper functions to eliminate code duplication
    getMouseCoordinates(e) {
        return {
            world: this.canvas.getMouseWorldCoordinates(e),
            view: this.canvas.getMouseViewCoordinates(e)
        };
    }
    preventEventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    performZoomOperation(worldCoords, zoomFactor) {
        const rect = this.canvas.canvas.getBoundingClientRect();
        const mouseBufferX = (worldCoords.x - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const mouseBufferY = (worldCoords.y - this.canvas.viewport.y) * this.canvas.viewport.zoom;
        const newZoom = Math.max(0.1, Math.min(10, this.canvas.viewport.zoom * zoomFactor));
        this.canvas.viewport.zoom = newZoom;
        this.canvas.viewport.x = worldCoords.x - (mouseBufferX / this.canvas.viewport.zoom);
        this.canvas.viewport.y = worldCoords.y - (mouseBufferY / this.canvas.viewport.zoom);
        this.canvas.onViewportChange?.();
    }
    renderAndSave(shouldSave = false) {
        this.canvas.render();
        if (shouldSave) {
            this.canvas.saveState();
            this.canvas.canvasState.saveStateToDB();
        }
    }
    setDragDropStyling(active) {
        if (active) {
            this.canvas.canvas.style.backgroundColor = 'rgba(45, 90, 160, 0.1)';
            this.canvas.canvas.style.border = '2px dashed #2d5aa0';
        }
        else {
            this.canvas.canvas.style.backgroundColor = '';
            this.canvas.canvas.style.border = '';
        }
    }
    setupEventListeners() {
        this.canvas.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        this.canvas.canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
        this.canvas.canvas.addEventListener('keydown', this.handleKeyDown.bind(this));
        this.canvas.canvas.addEventListener('keyup', this.handleKeyUp.bind(this));
        // Add a blur event listener to the window to reset key states
        window.addEventListener('blur', this.handleBlur.bind(this));
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
    /**
     * Sprawdza czy punkt znajduje się w obszarze któregokolwiek z zaznaczonych layerów
     */
    isPointInSelectedLayers(worldX, worldY) {
        for (const layer of this.canvas.canvasSelection.selectedLayers) {
            if (!layer.visible)
                continue;
            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;
            // Przekształć punkt do lokalnego układu współrzędnych layera
            const dx = worldX - centerX;
            const dy = worldY - centerY;
            const rad = -layer.rotation * Math.PI / 180;
            const rotatedX = dx * Math.cos(rad) - dy * Math.sin(rad);
            const rotatedY = dx * Math.sin(rad) + dy * Math.cos(rad);
            // Sprawdź czy punkt jest wewnątrz prostokąta layera
            if (Math.abs(rotatedX) <= layer.width / 2 &&
                Math.abs(rotatedY) <= layer.height / 2) {
                return true;
            }
        }
        return false;
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
        const coords = this.getMouseCoordinates(e);
        if (this.interaction.mode === 'drawingMask') {
            this.canvas.maskTool.handleMouseDown(coords.world, coords.view);
            this.canvas.render();
            return;
        }
        if (this.canvas.shapeTool.isActive) {
            this.canvas.shapeTool.addPoint(coords.world);
            return;
        }
        // --- Ostateczna, poprawna kolejność sprawdzania ---
        // 1. Akcje globalne z modyfikatorami (mają najwyższy priorytet)
        if (e.shiftKey && e.ctrlKey) {
            this.startCanvasMove(coords.world);
            return;
        }
        if (e.shiftKey) {
            // Clear custom shape when starting canvas resize
            if (this.canvas.outputAreaShape) {
                // If auto-apply shape mask is enabled, remove the mask before clearing the shape
                if (this.canvas.autoApplyShapeMask) {
                    log.info("Removing shape mask before clearing custom shape for canvas resize");
                    this.canvas.maskTool.removeShapeMask();
                }
                this.canvas.outputAreaShape = null;
                this.canvas.render();
            }
            this.startCanvasResize(coords.world);
            return;
        }
        // 2. Inne przyciski myszy
        if (e.button === 2) { // Prawy przycisk myszy
            this.preventEventDefaults(e);
            // Sprawdź czy kliknięto w obszarze któregokolwiek z zaznaczonych layerów (niezależnie od przykrycia)
            if (this.isPointInSelectedLayers(coords.world.x, coords.world.y)) {
                // Nowa logika przekazuje tylko współrzędne świata, menu pozycjonuje się samo
                this.canvas.canvasLayers.showBlendModeMenu(coords.world.x, coords.world.y);
            }
            return;
        }
        if (e.button !== 0) { // Środkowy przycisk
            this.startPanning(e);
            return;
        }
        // 3. Interakcje z elementami na płótnie (lewy przycisk)
        const transformTarget = this.canvas.canvasLayers.getHandleAtPosition(coords.world.x, coords.world.y);
        if (transformTarget) {
            this.startLayerTransform(transformTarget.layer, transformTarget.handle, coords.world);
            return;
        }
        const clickedLayerResult = this.canvas.canvasLayers.getLayerAtPosition(coords.world.x, coords.world.y);
        if (clickedLayerResult) {
            this.prepareForDrag(clickedLayerResult.layer, coords.world);
            return;
        }
        // 4. Domyślna akcja na tle (lewy przycisk bez modyfikatorów)
        this.startPanningOrClearSelection(e);
    }
    handleMouseMove(e) {
        const coords = this.getMouseCoordinates(e);
        this.canvas.lastMousePosition = coords.world; // Zawsze aktualizuj ostatnią pozycję myszy
        // Sprawdź, czy rozpocząć przeciąganie
        if (this.interaction.mode === 'potential-drag') {
            const dx = coords.world.x - this.interaction.dragStart.x;
            const dy = coords.world.y - this.interaction.dragStart.y;
            if (Math.sqrt(dx * dx + dy * dy) > 3) { // Próg 3 pikseli
                this.interaction.mode = 'dragging';
                this.originalLayerPositions.clear();
                this.canvas.canvasSelection.selectedLayers.forEach((l) => {
                    this.originalLayerPositions.set(l, { x: l.x, y: l.y });
                });
            }
        }
        switch (this.interaction.mode) {
            case 'drawingMask':
                this.canvas.maskTool.handleMouseMove(coords.world, coords.view);
                this.canvas.render();
                break;
            case 'panning':
                this.panViewport(e);
                break;
            case 'dragging':
                this.dragLayers(coords.world);
                break;
            case 'resizing':
                this.resizeLayerFromHandle(coords.world, e.shiftKey);
                break;
            case 'rotating':
                this.rotateLayerFromHandle(coords.world, e.shiftKey);
                break;
            case 'resizingCanvas':
                this.updateCanvasResize(coords.world);
                break;
            case 'movingCanvas':
                this.updateCanvasMove(coords.world);
                break;
            default:
                this.updateCursor(coords.world);
                break;
        }
        // --- DYNAMICZNY PODGLĄD LINII CUSTOM SHAPE ---
        if (this.canvas.shapeTool.isActive && !this.canvas.shapeTool.shape.isClosed) {
            this.canvas.render();
        }
    }
    handleMouseUp(e) {
        const coords = this.getMouseCoordinates(e);
        if (this.interaction.mode === 'drawingMask') {
            this.canvas.maskTool.handleMouseUp(coords.view);
            this.canvas.render();
            return;
        }
        if (this.interaction.mode === 'resizingCanvas') {
            this.finalizeCanvasResize();
        }
        if (this.interaction.mode === 'movingCanvas') {
            this.finalizeCanvasMove();
        }
        // Log layer positions when dragging ends
        if (this.interaction.mode === 'dragging' && this.canvas.canvasSelection.selectedLayers.length > 0) {
            this.logDragCompletion(coords);
        }
        // Handle end of crop bounds transformation before resetting interaction state
        if (this.interaction.mode === 'resizing' && this.interaction.transformingLayer?.cropMode) {
            this.canvas.canvasLayers.handleCropBoundsTransformEnd(this.interaction.transformingLayer);
        }
        // Handle end of scale transformation (normal transform mode) before resetting interaction state
        if (this.interaction.mode === 'resizing' && this.interaction.transformingLayer && !this.interaction.transformingLayer.cropMode) {
            this.canvas.canvasLayers.handleScaleTransformEnd(this.interaction.transformingLayer);
        }
        // Zapisz stan tylko, jeśli faktycznie doszło do zmiany (przeciąganie, transformacja, duplikacja)
        const stateChangingInteraction = ['dragging', 'resizing', 'rotating'].includes(this.interaction.mode);
        const duplicatedInDrag = this.interaction.hasClonedInDrag;
        if (stateChangingInteraction || duplicatedInDrag) {
            this.renderAndSave(true);
        }
        this.resetInteractionState();
        this.canvas.render();
    }
    logDragCompletion(coords) {
        const bounds = this.canvas.outputAreaBounds;
        log.info("=== LAYER DRAG COMPLETED ===");
        log.info(`Mouse position: world(${coords.world.x.toFixed(1)}, ${coords.world.y.toFixed(1)}) view(${coords.view.x.toFixed(1)}, ${coords.view.y.toFixed(1)})`);
        log.info(`Output Area Bounds: x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}`);
        log.info(`Viewport: x=${this.canvas.viewport.x.toFixed(1)}, y=${this.canvas.viewport.y.toFixed(1)}, zoom=${this.canvas.viewport.zoom.toFixed(2)}`);
        this.canvas.canvasSelection.selectedLayers.forEach((layer, index) => {
            const relativeToOutput = {
                x: layer.x - bounds.x,
                y: layer.y - bounds.y
            };
            log.info(`Layer ${index + 1} "${layer.name}": world(${layer.x.toFixed(1)}, ${layer.y.toFixed(1)}) relative_to_output(${relativeToOutput.x.toFixed(1)}, ${relativeToOutput.y.toFixed(1)}) size(${layer.width.toFixed(1)}x${layer.height.toFixed(1)})`);
        });
        log.info("=== END LAYER DRAG ===");
    }
    handleMouseLeave(e) {
        const coords = this.getMouseCoordinates(e);
        if (this.canvas.maskTool.isActive) {
            this.canvas.maskTool.handleMouseLeave();
            if (this.canvas.maskTool.isDrawing) {
                this.canvas.maskTool.handleMouseUp(coords.view);
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
        // Always prevent browser context menu - we handle all right-click interactions ourselves
        e.preventDefault();
        e.stopPropagation();
    }
    handleWheel(e) {
        this.preventEventDefaults(e);
        const coords = this.getMouseCoordinates(e);
        if (this.canvas.maskTool.isActive || this.canvas.canvasSelection.selectedLayers.length === 0) {
            // Zoom operation for mask tool or when no layers selected
            const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            this.performZoomOperation(coords.world, zoomFactor);
        }
        else {
            // Layer transformation when layers are selected
            this.handleLayerWheelTransformation(e);
        }
        this.canvas.render();
        if (!this.canvas.maskTool.isActive) {
            this.canvas.requestSaveState();
        }
    }
    handleLayerWheelTransformation(e) {
        const rotationStep = 5 * (e.deltaY > 0 ? -1 : 1);
        const direction = e.deltaY < 0 ? 1 : -1;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            if (e.shiftKey) {
                this.handleLayerRotation(layer, e.ctrlKey, direction, rotationStep);
            }
            else {
                this.handleLayerScaling(layer, e.ctrlKey, e.deltaY);
            }
        });
    }
    handleLayerRotation(layer, isCtrlPressed, direction, rotationStep) {
        if (isCtrlPressed) {
            // Snap to absolute values
            const snapAngle = 5;
            if (direction > 0) {
                layer.rotation = Math.ceil((layer.rotation + 0.1) / snapAngle) * snapAngle;
            }
            else {
                layer.rotation = Math.floor((layer.rotation - 0.1) / snapAngle) * snapAngle;
            }
        }
        else {
            // Fixed step rotation
            layer.rotation += rotationStep;
        }
    }
    handleLayerScaling(layer, isCtrlPressed, deltaY) {
        const oldWidth = layer.width;
        const oldHeight = layer.height;
        let scaleFactor;
        if (isCtrlPressed) {
            const direction = deltaY > 0 ? -1 : 1;
            const baseDimension = Math.max(layer.width, layer.height);
            const newBaseDimension = baseDimension + direction;
            if (newBaseDimension < 10)
                return;
            scaleFactor = newBaseDimension / baseDimension;
        }
        else {
            scaleFactor = this.calculateGridBasedScaling(oldHeight, deltaY);
        }
        if (scaleFactor && isFinite(scaleFactor)) {
            layer.width *= scaleFactor;
            layer.height *= scaleFactor;
            layer.x += (oldWidth - layer.width) / 2;
            layer.y += (oldHeight - layer.height) / 2;
            // Handle wheel scaling end for layers with blend area
            this.canvas.canvasLayers.handleWheelScalingEnd(layer);
        }
    }
    calculateGridBasedScaling(oldHeight, deltaY) {
        const gridSize = 64;
        const direction = deltaY > 0 ? -1 : 1;
        let targetHeight;
        if (direction > 0) {
            targetHeight = (Math.floor(oldHeight / gridSize) + 1) * gridSize;
        }
        else {
            targetHeight = (Math.ceil(oldHeight / gridSize) - 1) * gridSize;
        }
        if (targetHeight < gridSize / 2) {
            targetHeight = gridSize / 2;
        }
        if (Math.abs(oldHeight - targetHeight) < 1) {
            if (direction > 0)
                targetHeight += gridSize;
            else
                targetHeight -= gridSize;
            if (targetHeight < gridSize / 2)
                return 0;
        }
        return targetHeight / oldHeight;
    }
    handleKeyDown(e) {
        if (e.key === 'Control')
            this.interaction.isCtrlPressed = true;
        if (e.key === 'Shift')
            this.interaction.isShiftPressed = true;
        if (e.key === 'Alt') {
            this.interaction.isAltPressed = true;
            e.preventDefault();
        }
        if (e.key.toLowerCase() === 's') {
            this.interaction.isSPressed = true;
            e.preventDefault();
            e.stopPropagation();
        }
        // Check if Shift+S is being held down
        if (this.interaction.isShiftPressed && this.interaction.isSPressed && !this.interaction.isCtrlPressed && !this.canvas.shapeTool.isActive) {
            this.canvas.shapeTool.activate();
            return;
        }
        // Globalne skróty (Undo/Redo/Copy/Paste)
        if (e.ctrlKey || e.metaKey) {
            let handled = true;
            switch (e.key.toLowerCase()) {
                case 'z':
                    if (e.shiftKey) {
                        this.canvas.redo();
                    }
                    else {
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
                if (e.code === 'ArrowLeft')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.x -= step);
                if (e.code === 'ArrowRight')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.x += step);
                if (e.code === 'ArrowUp')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.y -= step);
                if (e.code === 'ArrowDown')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.y += step);
                if (e.code === 'BracketLeft')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.rotation -= step);
                if (e.code === 'BracketRight')
                    this.canvas.canvasSelection.selectedLayers.forEach((l) => l.rotation += step);
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
        if (e.key === 'Control')
            this.interaction.isCtrlPressed = false;
        if (e.key === 'Shift')
            this.interaction.isShiftPressed = false;
        if (e.key === 'Alt')
            this.interaction.isAltPressed = false;
        if (e.key.toLowerCase() === 's')
            this.interaction.isSPressed = false;
        // Deactivate shape tool when Shift or S is released
        if (this.canvas.shapeTool.isActive && (!this.interaction.isShiftPressed || !this.interaction.isSPressed)) {
            this.canvas.shapeTool.deactivate();
        }
        const movementKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'BracketLeft', 'BracketRight'];
        if (movementKeys.includes(e.code) && this.interaction.keyMovementInProgress) {
            this.canvas.requestSaveState(); // Użyj opóźnionego zapisu
            this.interaction.keyMovementInProgress = false;
        }
    }
    handleBlur() {
        log.debug('Window lost focus, resetting key states.');
        this.interaction.isCtrlPressed = false;
        this.interaction.isAltPressed = false;
        this.interaction.isShiftPressed = false;
        this.interaction.isSPressed = false;
        this.interaction.keyMovementInProgress = false;
        // Deactivate shape tool when window loses focus
        if (this.canvas.shapeTool.isActive) {
            this.canvas.shapeTool.deactivate();
        }
        // Also reset any interaction that relies on a key being held down
        if (this.interaction.mode === 'dragging' && this.interaction.hasClonedInDrag) {
            // If we were in the middle of a cloning drag, finalize it
            this.canvas.saveState();
            this.canvas.canvasState.saveStateToDB();
        }
        // Reset interaction mode if it's something that can get "stuck"
        if (this.interaction.mode !== 'none' && this.interaction.mode !== 'drawingMask') {
            this.resetInteractionState();
            this.canvas.render();
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
        }
        else if (this.canvas.canvasLayers.getLayerAtPosition(worldCoords.x, worldCoords.y)) {
            this.canvas.canvas.style.cursor = 'move';
        }
        else {
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
            centerY: layer.y + layer.height / 2,
            originalWidth: layer.originalWidth,
            originalHeight: layer.originalHeight,
            cropBounds: layer.cropBounds ? { ...layer.cropBounds } : undefined
        };
        this.interaction.dragStart = { ...worldCoords };
        if (handle === 'rot') {
            this.interaction.mode = 'rotating';
        }
        else {
            this.interaction.mode = 'resizing';
            this.interaction.resizeHandle = handle;
            const handles = this.canvas.canvasLayers.getHandles(layer);
            const oppositeHandleKey = {
                'n': 's', 's': 'n', 'e': 'w', 'w': 'e',
                'nw': 'se', 'se': 'nw', 'ne': 'sw', 'sw': 'ne'
            };
            this.interaction.resizeAnchor = handles[oppositeHandleKey[handle]];
        }
        this.canvas.render();
    }
    prepareForDrag(layer, worldCoords) {
        // Zaktualizuj zaznaczenie, ale nie zapisuj stanu
        if (this.interaction.isCtrlPressed) {
            const index = this.canvas.canvasSelection.selectedLayers.indexOf(layer);
            if (index === -1) {
                this.canvas.canvasSelection.updateSelection([...this.canvas.canvasSelection.selectedLayers, layer]);
            }
            else {
                const newSelection = this.canvas.canvasSelection.selectedLayers.filter((l) => l !== layer);
                this.canvas.canvasSelection.updateSelection(newSelection);
            }
        }
        else {
            if (!this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                this.canvas.canvasSelection.updateSelection([layer]);
            }
        }
        this.interaction.mode = 'potential-drag';
        this.interaction.dragStart = { ...worldCoords };
    }
    startPanningOrClearSelection(e) {
        // Ta funkcja jest teraz wywoływana tylko gdy kliknięto na tło bez modyfikatorów.
        // Domyślna akcja: wyczyść zaznaczenie i rozpocznij panoramowanie.
        if (!this.interaction.isCtrlPressed) {
            this.canvas.canvasSelection.updateSelection([]);
        }
        this.interaction.mode = 'panning';
        this.interaction.panStart = { x: e.clientX, y: e.clientY };
    }
    startCanvasResize(worldCoords) {
        this.interaction.mode = 'resizingCanvas';
        const startX = snapToGrid(worldCoords.x);
        const startY = snapToGrid(worldCoords.y);
        this.interaction.canvasResizeStart = { x: startX, y: startY };
        this.interaction.canvasResizeRect = { x: startX, y: startY, width: 0, height: 0 };
        this.canvas.render();
    }
    startCanvasMove(worldCoords) {
        this.interaction.mode = 'movingCanvas';
        this.interaction.dragStart = { ...worldCoords };
        this.canvas.canvas.style.cursor = 'grabbing';
        this.canvas.render();
    }
    updateCanvasMove(worldCoords) {
        const dx = worldCoords.x - this.interaction.dragStart.x;
        const dy = worldCoords.y - this.interaction.dragStart.y;
        // Po prostu przesuwamy outputAreaBounds
        const bounds = this.canvas.outputAreaBounds;
        this.interaction.canvasMoveRect = {
            x: snapToGrid(bounds.x + dx),
            y: snapToGrid(bounds.y + dy),
            width: bounds.width,
            height: bounds.height
        };
        this.canvas.render();
    }
    finalizeCanvasMove() {
        const moveRect = this.interaction.canvasMoveRect;
        if (moveRect) {
            // Po prostu aktualizujemy outputAreaBounds na nową pozycję
            this.canvas.outputAreaBounds = {
                x: moveRect.x,
                y: moveRect.y,
                width: moveRect.width,
                height: moveRect.height
            };
            // Update mask canvas to ensure it covers the new output area position
            this.canvas.maskTool.updateMaskCanvasForOutputArea();
        }
        this.canvas.render();
        this.canvas.saveState();
    }
    startPanning(e) {
        if (!this.interaction.isCtrlPressed) {
            this.canvas.canvasSelection.updateSelection([]);
        }
        this.interaction.mode = 'panning';
        this.interaction.panStart = { x: e.clientX, y: e.clientY };
    }
    panViewport(e) {
        const dx = e.clientX - this.interaction.panStart.x;
        const dy = e.clientY - this.interaction.panStart.y;
        this.canvas.viewport.x -= dx / this.canvas.viewport.zoom;
        this.canvas.viewport.y -= dy / this.canvas.viewport.zoom;
        this.interaction.panStart = { x: e.clientX, y: e.clientY };
        this.canvas.render();
        this.canvas.onViewportChange?.();
    }
    dragLayers(worldCoords) {
        if (this.interaction.isAltPressed && !this.interaction.hasClonedInDrag && this.canvas.canvasSelection.selectedLayers.length > 0) {
            // Scentralizowana logika duplikowania
            const newLayers = this.canvas.canvasSelection.duplicateSelectedLayers();
            // Zresetuj pozycje przeciągania dla nowych, zduplikowanych warstw
            this.originalLayerPositions.clear();
            newLayers.forEach((l) => {
                this.originalLayerPositions.set(l, { x: l.x, y: l.y });
            });
            this.interaction.hasClonedInDrag = true;
        }
        const totalDx = worldCoords.x - this.interaction.dragStart.x;
        const totalDy = worldCoords.y - this.interaction.dragStart.y;
        let finalDx = totalDx, finalDy = totalDy;
        if (this.interaction.isCtrlPressed && this.canvas.canvasSelection.selectedLayers.length > 0) {
            const firstLayer = this.canvas.canvasSelection.selectedLayers[0];
            const originalPos = this.originalLayerPositions.get(firstLayer);
            if (originalPos) {
                const tempLayerForSnap = {
                    ...firstLayer,
                    x: originalPos.x + totalDx,
                    y: originalPos.y + totalDy
                };
                const snapAdjustment = getSnapAdjustment(tempLayerForSnap);
                if (snapAdjustment) {
                    finalDx += snapAdjustment.x;
                    finalDy += snapAdjustment.y;
                }
            }
        }
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
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
        if (!layer)
            return;
        let mouseX = worldCoords.x;
        let mouseY = worldCoords.y;
        if (this.interaction.isCtrlPressed) {
            const snapThreshold = 10 / this.canvas.viewport.zoom;
            mouseX = Math.abs(mouseX - snapToGrid(mouseX)) < snapThreshold ? snapToGrid(mouseX) : mouseX;
            mouseY = Math.abs(mouseY - snapToGrid(mouseY)) < snapThreshold ? snapToGrid(mouseY) : mouseY;
        }
        const o = this.interaction.transformOrigin;
        if (o.rotation === undefined || o.width === undefined || o.height === undefined || o.centerX === undefined || o.centerY === undefined)
            return;
        const handle = this.interaction.resizeHandle;
        const anchor = this.interaction.resizeAnchor;
        const rad = o.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        // Vector from anchor to mouse
        const vecX = mouseX - anchor.x;
        const vecY = mouseY - anchor.y;
        // Rotate vector to align with layer's local coordinates
        let localVecX = vecX * cos + vecY * sin;
        let localVecY = vecY * cos - vecX * sin;
        // Determine sign based on handle
        const signX = handle?.includes('e') ? 1 : (handle?.includes('w') ? -1 : 0);
        const signY = handle?.includes('s') ? 1 : (handle?.includes('n') ? -1 : 0);
        localVecX *= signX;
        localVecY *= signY;
        // If not a corner handle, keep original dimension
        if (signX === 0)
            localVecX = o.width;
        if (signY === 0)
            localVecY = o.height;
        if (layer.cropMode && o.cropBounds && o.originalWidth && o.originalHeight) {
            // CROP MODE: Calculate delta based on mouse movement and apply to cropBounds.
            // Calculate mouse movement since drag start, in the layer's local coordinate system.
            const dragStartX_local = this.interaction.dragStart.x - (o.centerX ?? 0);
            const dragStartY_local = this.interaction.dragStart.y - (o.centerY ?? 0);
            const mouseX_local = mouseX - (o.centerX ?? 0);
            const mouseY_local = mouseY - (o.centerY ?? 0);
            // Rotate mouse delta into the layer's unrotated frame
            const deltaX_world = mouseX_local - dragStartX_local;
            const deltaY_world = mouseY_local - dragStartY_local;
            let mouseDeltaX_local = deltaX_world * cos + deltaY_world * sin;
            let mouseDeltaY_local = deltaY_world * cos - deltaX_world * sin;
            if (layer.flipH) {
                mouseDeltaX_local *= -1;
            }
            if (layer.flipV) {
                mouseDeltaY_local *= -1;
            }
            // Convert the on-screen mouse delta to an image-space delta.
            const screenToImageScaleX = o.originalWidth / o.width;
            const screenToImageScaleY = o.originalHeight / o.height;
            const delta_image_x = mouseDeltaX_local * screenToImageScaleX;
            const delta_image_y = mouseDeltaY_local * screenToImageScaleY;
            let newCropBounds = { ...o.cropBounds }; // Start with the bounds from the beginning of the drag
            // Apply the image-space delta to the appropriate edges of the crop bounds
            const isFlippedH = layer.flipH;
            const isFlippedV = layer.flipV;
            if (handle?.includes('w')) {
                if (isFlippedH)
                    newCropBounds.width += delta_image_x;
                else {
                    newCropBounds.x += delta_image_x;
                    newCropBounds.width -= delta_image_x;
                }
            }
            if (handle?.includes('e')) {
                if (isFlippedH) {
                    newCropBounds.x += delta_image_x;
                    newCropBounds.width -= delta_image_x;
                }
                else
                    newCropBounds.width += delta_image_x;
            }
            if (handle?.includes('n')) {
                if (isFlippedV)
                    newCropBounds.height += delta_image_y;
                else {
                    newCropBounds.y += delta_image_y;
                    newCropBounds.height -= delta_image_y;
                }
            }
            if (handle?.includes('s')) {
                if (isFlippedV) {
                    newCropBounds.y += delta_image_y;
                    newCropBounds.height -= delta_image_y;
                }
                else
                    newCropBounds.height += delta_image_y;
            }
            // Clamp crop bounds to stay within the original image and maintain minimum size
            if (newCropBounds.width < 1) {
                if (handle?.includes('w'))
                    newCropBounds.x = o.cropBounds.x + o.cropBounds.width - 1;
                newCropBounds.width = 1;
            }
            if (newCropBounds.height < 1) {
                if (handle?.includes('n'))
                    newCropBounds.y = o.cropBounds.y + o.cropBounds.height - 1;
                newCropBounds.height = 1;
            }
            if (newCropBounds.x < 0) {
                newCropBounds.width += newCropBounds.x;
                newCropBounds.x = 0;
            }
            if (newCropBounds.y < 0) {
                newCropBounds.height += newCropBounds.y;
                newCropBounds.y = 0;
            }
            if (newCropBounds.x + newCropBounds.width > o.originalWidth) {
                newCropBounds.width = o.originalWidth - newCropBounds.x;
            }
            if (newCropBounds.y + newCropBounds.height > o.originalHeight) {
                newCropBounds.height = o.originalHeight - newCropBounds.y;
            }
            layer.cropBounds = newCropBounds;
        }
        else {
            // TRANSFORM MODE: Resize the layer's main transform frame
            let newWidth = localVecX;
            let newHeight = localVecY;
            if (isShiftPressed) {
                const originalAspectRatio = o.width / o.height;
                if (Math.abs(newWidth) > Math.abs(newHeight) * originalAspectRatio) {
                    newHeight = (Math.sign(newHeight) || 1) * Math.abs(newWidth) / originalAspectRatio;
                }
                else {
                    newWidth = (Math.sign(newWidth) || 1) * Math.abs(newHeight) * originalAspectRatio;
                }
            }
            if (newWidth < 10)
                newWidth = 10;
            if (newHeight < 10)
                newHeight = 10;
            layer.width = newWidth;
            layer.height = newHeight;
            // Update position to keep anchor point fixed
            const deltaW = layer.width - o.width;
            const deltaH = layer.height - o.height;
            const shiftX = (deltaW / 2) * signX;
            const shiftY = (deltaH / 2) * signY;
            const worldShiftX = shiftX * cos - shiftY * sin;
            const worldShiftY = shiftX * sin + shiftY * cos;
            const newCenterX = o.centerX + worldShiftX;
            const newCenterY = o.centerY + worldShiftY;
            layer.x = newCenterX - layer.width / 2;
            layer.y = newCenterY - layer.height / 2;
        }
        this.canvas.render();
    }
    rotateLayerFromHandle(worldCoords, isShiftPressed) {
        const layer = this.interaction.transformingLayer;
        if (!layer)
            return;
        const o = this.interaction.transformOrigin;
        if (o.rotation === undefined || o.centerX === undefined || o.centerY === undefined)
            return;
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
        if (!this.interaction.canvasResizeRect)
            return;
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
            // Po prostu aktualizujemy outputAreaBounds na nowy obszar
            this.canvas.outputAreaBounds = {
                x: finalX,
                y: finalY,
                width: newWidth,
                height: newHeight
            };
            this.canvas.updateOutputAreaSize(newWidth, newHeight);
        }
        this.canvas.render();
        this.canvas.saveState();
    }
    handleDragOver(e) {
        this.preventEventDefaults(e);
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = 'copy';
    }
    handleDragEnter(e) {
        this.preventEventDefaults(e);
        this.setDragDropStyling(true);
    }
    handleDragLeave(e) {
        this.preventEventDefaults(e);
        if (!this.canvas.canvas.contains(e.relatedTarget)) {
            this.setDragDropStyling(false);
        }
    }
    async handleDrop(e) {
        this.preventEventDefaults(e);
        log.info("Canvas drag & drop event intercepted - preventing ComfyUI workflow loading");
        this.setDragDropStyling(false);
        if (!e.dataTransfer)
            return;
        const files = Array.from(e.dataTransfer.files);
        const coords = this.getMouseCoordinates(e);
        log.info(`Dropped ${files.length} file(s) onto canvas at position (${coords.world.x}, ${coords.world.y})`);
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                try {
                    await this.loadDroppedImageFile(file, coords.world);
                    log.info(`Successfully loaded dropped image: ${file.name}`);
                }
                catch (error) {
                    log.error(`Failed to load dropped image ${file.name}:`, error);
                }
            }
            else {
                log.warn(`Skipped non-image file: ${file.name} (${file.type})`);
            }
        }
    }
    async loadDroppedImageFile(file, worldCoords) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const img = new Image();
            img.onload = async () => {
                const fitOnAddWidget = this.canvas.node.widgets.find((w) => w.name === "fit_on_add");
                const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
            };
            img.onerror = () => {
                log.error(`Failed to load dropped image: ${file.name}`);
            };
            if (e.target?.result) {
                img.src = e.target.result;
            }
        };
        reader.onerror = () => {
            log.error(`Failed to read dropped file: ${file.name}`);
        };
        reader.readAsDataURL(file);
    }
    defineOutputAreaWithShape(shape) {
        const boundingBox = this.canvas.shapeTool.getBoundingBox();
        if (boundingBox && boundingBox.width > 1 && boundingBox.height > 1) {
            this.canvas.saveState();
            // If there's an existing custom shape and auto-apply shape mask is enabled, remove the previous mask
            if (this.canvas.outputAreaShape && this.canvas.autoApplyShapeMask) {
                log.info("Removing previous shape mask before defining new custom shape");
                this.canvas.maskTool.removeShapeMask();
            }
            this.canvas.outputAreaShape = {
                ...shape,
                points: shape.points.map((p) => ({
                    x: p.x - boundingBox.x,
                    y: p.y - boundingBox.y
                }))
            };
            const newWidth = Math.round(boundingBox.width);
            const newHeight = Math.round(boundingBox.height);
            const newX = Math.round(boundingBox.x);
            const newY = Math.round(boundingBox.y);
            // Store the original canvas size for extension calculations
            this.canvas.originalCanvasSize = { width: newWidth, height: newHeight };
            // Store the original position where custom shape was drawn for extension calculations
            this.canvas.originalOutputAreaPosition = { x: newX, y: newY };
            // If extensions are enabled, we need to recalculate outputAreaBounds with current extensions
            if (this.canvas.outputAreaExtensionEnabled) {
                const ext = this.canvas.outputAreaExtensions;
                const extendedWidth = newWidth + ext.left + ext.right;
                const extendedHeight = newHeight + ext.top + ext.bottom;
                // Update canvas size with extensions
                this.canvas.updateOutputAreaSize(extendedWidth, extendedHeight, false);
                // Set outputAreaBounds accounting for extensions
                this.canvas.outputAreaBounds = {
                    x: newX - ext.left, // Adjust position by left extension
                    y: newY - ext.top, // Adjust position by top extension
                    width: extendedWidth,
                    height: extendedHeight
                };
                log.info(`New custom shape with extensions: original(${newX}, ${newY}) extended(${newX - ext.left}, ${newY - ext.top}) size(${extendedWidth}x${extendedHeight})`);
            }
            else {
                // No extensions - use original size and position
                this.canvas.updateOutputAreaSize(newWidth, newHeight, false);
                this.canvas.outputAreaBounds = {
                    x: newX,
                    y: newY,
                    width: newWidth,
                    height: newHeight
                };
                log.info(`New custom shape without extensions: position(${newX}, ${newY}) size(${newWidth}x${newHeight})`);
            }
            // Update mask canvas to ensure it covers the new output area position
            this.canvas.maskTool.updateMaskCanvasForOutputArea();
            // If auto-apply shape mask is enabled, automatically apply the mask with current settings
            if (this.canvas.autoApplyShapeMask) {
                log.info("Auto-applying shape mask to new custom shape with current settings");
                this.canvas.maskTool.applyShapeMask();
            }
            this.canvas.saveState();
            this.canvas.render();
        }
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
                            if (event.target?.result) {
                                img.src = event.target.result;
                            }
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
