import { createModuleLogger } from "./utils/LoggerUtils.js";
import { snapToGrid, getSnapAdjustment } from "./utils/CommonUtils.js";
const log = createModuleLogger('CanvasInteractions');
export class CanvasInteractions {
    constructor(canvas) {
        // Bound event handlers to enable proper removeEventListener and avoid leaks
        this.onMouseDown = (e) => this.handleMouseDown(e);
        this.onMouseMove = (e) => this.handleMouseMove(e);
        this.onMouseUp = (e) => this.handleMouseUp(e);
        this.onMouseEnter = (e) => { this.canvas.isMouseOver = true; this.handleMouseEnter(e); };
        this.onMouseLeave = (e) => { this.canvas.isMouseOver = false; this.handleMouseLeave(e); };
        this.onWheel = (e) => this.handleWheel(e);
        this.onKeyDown = (e) => this.handleKeyDown(e);
        this.onKeyUp = (e) => this.handleKeyUp(e);
        this.onDragOver = (e) => this.handleDragOver(e);
        this.onDragEnter = (e) => this.handleDragEnter(e);
        this.onDragLeave = (e) => this.handleDragLeave(e);
        this.onDrop = (e) => { this.handleDrop(e); };
        this.onContextMenu = (e) => this.handleContextMenu(e);
        this.onBlur = () => this.handleBlur();
        this.onPaste = (e) => this.handlePasteEvent(e);
        this.canvas = canvas;
        this.interaction = {
            mode: 'none',
            panStart: { x: 0, y: 0 },
            dragStart: { x: 0, y: 0 },
            transformOrigin: null,
            resizeHandle: null,
            resizeAnchor: { x: 0, y: 0 },
            canvasResizeStart: { x: 0, y: 0 },
            isCtrlPressed: false,
            isMetaPressed: false,
            isAltPressed: false,
            isShiftPressed: false,
            isSPressed: false,
            hasClonedInDrag: false,
            lastClickTime: 0,
            transformingLayer: null,
            keyMovementInProgress: false,
            canvasResizeRect: null,
            canvasMoveRect: null,
            outputAreaTransformHandle: null,
            outputAreaTransformAnchor: { x: 0, y: 0 },
            hoveringGrabIcon: false,
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
    getModifierState(e) {
        return {
            ctrl: this.interaction.isCtrlPressed || e?.ctrlKey || false,
            shift: this.interaction.isShiftPressed || e?.shiftKey || false,
            alt: this.interaction.isAltPressed || e?.altKey || false,
            meta: this.interaction.isMetaPressed || e?.metaKey || false,
        };
    }
    preventEventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    performZoomOperation(worldCoords, zoomFactor) {
        const mouseBufferX = (worldCoords.x - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const mouseBufferY = (worldCoords.y - this.canvas.viewport.y) * this.canvas.viewport.zoom;
        const newZoom = Math.max(0.1, Math.min(10, this.canvas.viewport.zoom * zoomFactor));
        this.canvas.viewport.zoom = newZoom;
        this.canvas.viewport.x = worldCoords.x - (mouseBufferX / this.canvas.viewport.zoom);
        this.canvas.viewport.y = worldCoords.y - (mouseBufferY / this.canvas.viewport.zoom);
        // Update stroke overlay if mask tool is drawing during zoom
        if (this.canvas.maskTool.isDrawing) {
            this.canvas.maskTool.handleViewportChange();
        }
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
        this.canvas.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.canvas.addEventListener('mousemove', this.onMouseMove);
        this.canvas.canvas.addEventListener('mouseup', this.onMouseUp);
        this.canvas.canvas.addEventListener('wheel', this.onWheel, { passive: false });
        this.canvas.canvas.addEventListener('keydown', this.onKeyDown);
        this.canvas.canvas.addEventListener('keyup', this.onKeyUp);
        // Add a blur event listener to the window to reset key states
        window.addEventListener('blur', this.onBlur);
        document.addEventListener('paste', this.onPaste);
        // Intercept Ctrl+V during capture phase to handle layer paste before ComfyUI
        document.addEventListener('keydown', this.onKeyDown, { capture: true });
        this.canvas.canvas.addEventListener('mouseenter', this.onMouseEnter);
        this.canvas.canvas.addEventListener('mouseleave', this.onMouseLeave);
        this.canvas.canvas.addEventListener('dragover', this.onDragOver);
        this.canvas.canvas.addEventListener('dragenter', this.onDragEnter);
        this.canvas.canvas.addEventListener('dragleave', this.onDragLeave);
        this.canvas.canvas.addEventListener('drop', this.onDrop);
        this.canvas.canvas.addEventListener('contextmenu', this.onContextMenu);
    }
    teardownEventListeners() {
        this.canvas.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.canvas.removeEventListener('mouseup', this.onMouseUp);
        this.canvas.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.canvas.removeEventListener('keydown', this.onKeyDown);
        this.canvas.canvas.removeEventListener('keyup', this.onKeyUp);
        // Remove document-level capture listener
        document.removeEventListener('keydown', this.onKeyDown, { capture: true });
        window.removeEventListener('blur', this.onBlur);
        document.removeEventListener('paste', this.onPaste);
        this.canvas.canvas.removeEventListener('mouseenter', this.onMouseEnter);
        this.canvas.canvas.removeEventListener('mouseleave', this.onMouseLeave);
        this.canvas.canvas.removeEventListener('dragover', this.onDragOver);
        this.canvas.canvas.removeEventListener('dragenter', this.onDragEnter);
        this.canvas.canvas.removeEventListener('dragleave', this.onDragLeave);
        this.canvas.canvas.removeEventListener('drop', this.onDrop);
        this.canvas.canvas.removeEventListener('contextmenu', this.onContextMenu);
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
    /**
     * Sprawdza czy punkt znajduje się w obszarze ikony "grab" (środek layera)
     * Zwraca layer, jeśli kliknięto w ikonę grab
     */
    getGrabIconAtPosition(worldX, worldY) {
        // Rozmiar ikony grab w pikselach światowych
        const grabIconRadius = 20 / this.canvas.viewport.zoom;
        for (const layer of this.canvas.canvasSelection.selectedLayers) {
            if (!layer.visible)
                continue;
            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;
            // Sprawdź czy punkt jest w obszarze ikony grab (okrąg wokół środka)
            const dx = worldX - centerX;
            const dy = worldY - centerY;
            const distanceSquared = dx * dx + dy * dy;
            const radiusSquared = grabIconRadius * grabIconRadius;
            if (distanceSquared <= radiusSquared) {
                return layer;
            }
        }
        return null;
    }
    resetInteractionState() {
        this.interaction.mode = 'none';
        this.interaction.resizeHandle = null;
        this.originalLayerPositions.clear();
        this.interaction.canvasResizeRect = null;
        this.interaction.canvasMoveRect = null;
        this.interaction.hasClonedInDrag = false;
        this.interaction.transformingLayer = null;
        this.interaction.outputAreaTransformHandle = null;
        this.canvas.canvas.style.cursor = 'default';
    }
    handleMouseDown(e) {
        this.canvas.canvas.focus();
        // Sync modifier states with actual event state to prevent "stuck" modifiers
        // when focus moves between layers panel and canvas
        this.interaction.isCtrlPressed = e.ctrlKey;
        this.interaction.isMetaPressed = e.metaKey;
        this.interaction.isShiftPressed = e.shiftKey;
        this.interaction.isAltPressed = e.altKey;
        const coords = this.getMouseCoordinates(e);
        const mods = this.getModifierState(e);
        if (this.interaction.mode === 'drawingMask') {
            this.canvas.maskTool.handleMouseDown(coords.world, coords.view);
            // Don't render here - mask tool will handle its own drawing
            return;
        }
        if (this.interaction.mode === 'transformingOutputArea') {
            // Check if clicking on output area transform handle
            const handle = this.getOutputAreaHandle(coords.world);
            if (handle) {
                this.startOutputAreaTransform(handle, coords.world);
                return;
            }
            // If clicking outside, exit transform mode
            this.interaction.mode = 'none';
            this.canvas.render();
            return;
        }
        if (this.canvas.shapeTool.isActive) {
            this.canvas.shapeTool.addPoint(coords.world);
            return;
        }
        // --- Ostateczna, poprawna kolejność sprawdzania ---
        // 1. Akcje globalne z modyfikatorami (mają najwyższy priorytet)
        if (mods.shift && mods.ctrl) {
            this.startCanvasMove(coords.world);
            return;
        }
        if (mods.shift) {
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
        if (e.button === 1) { // Środkowy przycisk
            this.startPanning(e);
            return;
        }
        // 3. Interakcje z elementami na płótnie (lewy przycisk)
        const transformTarget = this.canvas.canvasLayers.getHandleAtPosition(coords.world.x, coords.world.y);
        if (transformTarget) {
            this.startLayerTransform(transformTarget.layer, transformTarget.handle, coords.world);
            return;
        }
        // Check if clicking on grab icon of a selected layer
        const grabIconLayer = this.getGrabIconAtPosition(coords.world.x, coords.world.y);
        if (grabIconLayer) {
            // Start dragging the selected layer(s) without changing selection
            this.interaction.mode = 'potential-drag';
            this.interaction.dragStart = { ...coords.world };
            return;
        }
        const clickedLayerResult = this.canvas.canvasLayers.getLayerAtPosition(coords.world.x, coords.world.y);
        if (clickedLayerResult) {
            this.prepareForDrag(clickedLayerResult.layer, coords.world);
            return;
        }
        // 4. Domyślna akcja na tle (lewy przycisk bez modyfikatorów)
        this.startPanning(e, true); // clearSelection = true
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
                // Don't render during mask drawing - it's handled by mask tool internally
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
            case 'transformingOutputArea':
                if (this.interaction.outputAreaTransformHandle) {
                    this.resizeOutputAreaFromHandle(coords.world, e.shiftKey);
                }
                else {
                    this.updateOutputAreaTransformCursor(coords.world);
                }
                break;
            default:
                // Check if hovering over grab icon
                const wasHovering = this.interaction.hoveringGrabIcon;
                this.interaction.hoveringGrabIcon = this.getGrabIconAtPosition(coords.world.x, coords.world.y) !== null;
                // Re-render if hover state changed to show/hide grab icon
                if (wasHovering !== this.interaction.hoveringGrabIcon) {
                    this.canvas.render();
                }
                this.updateCursor(coords.world);
                // Update brush cursor on overlay if mask tool is active
                if (this.canvas.maskTool.isActive) {
                    this.canvas.canvasRenderer.drawMaskBrushCursor(coords.world);
                }
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
            // Render only once after drawing is complete
            this.canvas.render();
            return;
        }
        if (this.interaction.mode === 'resizingCanvas') {
            this.finalizeCanvasResize();
        }
        if (this.interaction.mode === 'movingCanvas') {
            this.finalizeCanvasMove();
        }
        if (this.interaction.mode === 'transformingOutputArea' && this.interaction.outputAreaTransformHandle) {
            this.finalizeOutputAreaTransform();
            return;
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
            // Check if mouse is over any selected layer
            const isOverSelectedLayer = this.isPointInSelectedLayers(coords.world.x, coords.world.y);
            if (isOverSelectedLayer) {
                // Layer transformation when layers are selected and mouse is over selected layer
                this.handleLayerWheelTransformation(e);
            }
            else {
                // Zoom operation when mouse is not over selected layers
                const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
                this.performZoomOperation(coords.world, zoomFactor);
            }
        }
        this.canvas.render();
        if (!this.canvas.maskTool.isActive) {
            this.canvas.requestSaveState();
        }
    }
    handleLayerWheelTransformation(e) {
        const mods = this.getModifierState(e);
        const rotationStep = 5 * (e.deltaY > 0 ? -1 : 1);
        const direction = e.deltaY < 0 ? 1 : -1;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            if (mods.shift) {
                this.handleLayerRotation(layer, mods.ctrl, direction, rotationStep);
            }
            else {
                this.handleLayerScaling(layer, mods.ctrl, e.deltaY);
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
        const gridSize = 64; // Grid size - could be made configurable in the future
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
        // Always track modifier keys regardless of focus
        if (e.key === 'Control')
            this.interaction.isCtrlPressed = true;
        if (e.key === 'Meta')
            this.interaction.isMetaPressed = true;
        if (e.key === 'Shift')
            this.interaction.isShiftPressed = true;
        if (e.key === 'Alt')
            this.interaction.isAltPressed = true;
        // Check if canvas is focused before handling any shortcuts
        const shouldHandle = this.canvas.isMouseOver ||
            this.canvas.canvas.contains(document.activeElement) ||
            document.activeElement === this.canvas.canvas;
        if (!shouldHandle) {
            return;
        }
        // Canvas-specific key handlers (only when focused)
        if (e.key === 'Alt') {
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
        const mods = this.getModifierState(e);
        if (mods.ctrl || mods.meta) {
            let handled = true;
            switch (e.key.toLowerCase()) {
                case 'z':
                    if (mods.shift) {
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
                case 'v':
                    // Only handle internal clipboard paste here.
                    // If internal clipboard is empty, let the paste event bubble
                    // so handlePasteEvent can access e.clipboardData for system images.
                    if (this.canvas.canvasLayers.internalClipboard.length > 0) {
                        this.canvas.canvasLayers.pasteLayers();
                    } else {
                        // Don't preventDefault - let paste event fire for system clipboard
                        handled = false;
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
            const step = mods.shift ? 10 : 1;
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
        if (e.key === 'Meta')
            this.interaction.isMetaPressed = false;
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
        this.interaction.isMetaPressed = false;
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
        // If actively rotating, show grabbing cursor
        if (this.interaction.mode === 'rotating') {
            this.canvas.canvas.style.cursor = 'grabbing';
            return;
        }
        // Check if hovering over grab icon
        if (this.interaction.hoveringGrabIcon) {
            this.canvas.canvas.style.cursor = 'grab';
            return;
        }
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
        // Support both Ctrl (Windows/Linux) and Cmd (macOS) for multi-selection
        const mods = this.getModifierState();
        if (mods.ctrl || mods.meta) {
            const index = this.canvas.canvasSelection.selectedLayers.indexOf(layer);
            if (index === -1) {
                // Ctrl-clicking unselected layer: add to selection
                this.canvas.canvasSelection.updateSelection([...this.canvas.canvasSelection.selectedLayers, layer]);
            }
            // If already selected, do NOT deselect - allows dragging multiple layers with Ctrl held
            // User can use right-click in layers panel to deselect individual layers
        }
        else {
            if (!this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                this.canvas.canvasSelection.updateSelection([layer]);
            }
        }
        this.interaction.mode = 'potential-drag';
        this.interaction.dragStart = { ...worldCoords };
    }
    startPanning(e, clearSelection = true) {
        // Unified panning method - can optionally clear selection
        if (clearSelection && !this.interaction.isCtrlPressed) {
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
    panViewport(e) {
        const dx = e.clientX - this.interaction.panStart.x;
        const dy = e.clientY - this.interaction.panStart.y;
        this.canvas.viewport.x -= dx / this.canvas.viewport.zoom;
        this.canvas.viewport.y -= dy / this.canvas.viewport.zoom;
        this.interaction.panStart = { x: e.clientX, y: e.clientY };
        // Update stroke overlay if mask tool is drawing during pan
        if (this.canvas.maskTool.isDrawing) {
            this.canvas.maskTool.handleViewportChange();
        }
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
        if (!o)
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
        if (!o)
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
        // Check if canvas is connected to DOM and visible
        if (!this.canvas.canvas.isConnected || !document.body.contains(this.canvas.canvas)) {
            return;
        }
        const shouldHandle = this.canvas.isMouseOver ||
            this.canvas.canvas.contains(document.activeElement) ||
            document.activeElement === this.canvas.canvas;
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
    // New methods for output area transformation
    activateOutputAreaTransform() {
        // Clear any existing interaction state before starting transform
        this.resetInteractionState();
        // Deactivate any active tools that might conflict
        if (this.canvas.shapeTool.isActive) {
            this.canvas.shapeTool.deactivate();
        }
        if (this.canvas.maskTool.isActive) {
            this.canvas.maskTool.deactivate();
        }
        // Clear selection to avoid confusion
        this.canvas.canvasSelection.updateSelection([]);
        // Set transform mode
        this.interaction.mode = 'transformingOutputArea';
        this.canvas.render();
    }
    getOutputAreaHandle(worldCoords) {
        const bounds = this.canvas.outputAreaBounds;
        const threshold = 10 / this.canvas.viewport.zoom;
        // Define handle positions
        const handles = {
            'nw': { x: bounds.x, y: bounds.y },
            'n': { x: bounds.x + bounds.width / 2, y: bounds.y },
            'ne': { x: bounds.x + bounds.width, y: bounds.y },
            'e': { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
            'se': { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
            's': { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
            'sw': { x: bounds.x, y: bounds.y + bounds.height },
            'w': { x: bounds.x, y: bounds.y + bounds.height / 2 },
        };
        for (const [name, pos] of Object.entries(handles)) {
            const dx = worldCoords.x - pos.x;
            const dy = worldCoords.y - pos.y;
            if (Math.sqrt(dx * dx + dy * dy) < threshold) {
                return name;
            }
        }
        return null;
    }
    startOutputAreaTransform(handle, worldCoords) {
        this.interaction.outputAreaTransformHandle = handle;
        this.interaction.dragStart = { ...worldCoords };
        const bounds = this.canvas.outputAreaBounds;
        this.interaction.transformOrigin = {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            rotation: 0,
            centerX: bounds.x + bounds.width / 2,
            centerY: bounds.y + bounds.height / 2
        };
        // Set anchor point (opposite corner for resize)
        const anchorMap = {
            'nw': { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
            'n': { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
            'ne': { x: bounds.x, y: bounds.y + bounds.height },
            'e': { x: bounds.x, y: bounds.y + bounds.height / 2 },
            'se': { x: bounds.x, y: bounds.y },
            's': { x: bounds.x + bounds.width / 2, y: bounds.y },
            'sw': { x: bounds.x + bounds.width, y: bounds.y },
            'w': { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
        };
        this.interaction.outputAreaTransformAnchor = anchorMap[handle];
    }
    resizeOutputAreaFromHandle(worldCoords, isShiftPressed) {
        const o = this.interaction.transformOrigin;
        if (!o)
            return;
        const handle = this.interaction.outputAreaTransformHandle;
        const anchor = this.interaction.outputAreaTransformAnchor;
        let newX = o.x;
        let newY = o.y;
        let newWidth = o.width;
        let newHeight = o.height;
        // Calculate new dimensions based on handle
        if (handle?.includes('w')) {
            const deltaX = worldCoords.x - anchor.x;
            newWidth = Math.abs(deltaX);
            newX = Math.min(worldCoords.x, anchor.x);
        }
        if (handle?.includes('e')) {
            const deltaX = worldCoords.x - anchor.x;
            newWidth = Math.abs(deltaX);
            newX = Math.min(worldCoords.x, anchor.x);
        }
        if (handle?.includes('n')) {
            const deltaY = worldCoords.y - anchor.y;
            newHeight = Math.abs(deltaY);
            newY = Math.min(worldCoords.y, anchor.y);
        }
        if (handle?.includes('s')) {
            const deltaY = worldCoords.y - anchor.y;
            newHeight = Math.abs(deltaY);
            newY = Math.min(worldCoords.y, anchor.y);
        }
        // Maintain aspect ratio if shift is held
        if (isShiftPressed && o.width > 0 && o.height > 0) {
            const aspectRatio = o.width / o.height;
            if (handle === 'n' || handle === 's') {
                newWidth = newHeight * aspectRatio;
            }
            else if (handle === 'e' || handle === 'w') {
                newHeight = newWidth / aspectRatio;
            }
            else {
                // Corner handles
                const proposedRatio = newWidth / newHeight;
                if (proposedRatio > aspectRatio) {
                    newHeight = newWidth / aspectRatio;
                }
                else {
                    newWidth = newHeight * aspectRatio;
                }
            }
        }
        // Snap to grid if Ctrl is held
        if (this.interaction.isCtrlPressed) {
            newX = snapToGrid(newX);
            newY = snapToGrid(newY);
            newWidth = snapToGrid(newWidth);
            newHeight = snapToGrid(newHeight);
        }
        // Apply minimum size
        if (newWidth < 10)
            newWidth = 10;
        if (newHeight < 10)
            newHeight = 10;
        // Update output area bounds temporarily for preview
        this.canvas.outputAreaBounds = {
            x: newX,
            y: newY,
            width: newWidth,
            height: newHeight
        };
        this.canvas.render();
    }
    updateOutputAreaTransformCursor(worldCoords) {
        const handle = this.getOutputAreaHandle(worldCoords);
        if (handle) {
            const cursorMap = {
                'n': 'ns-resize', 's': 'ns-resize',
                'e': 'ew-resize', 'w': 'ew-resize',
                'nw': 'nwse-resize', 'se': 'nwse-resize',
                'ne': 'nesw-resize', 'sw': 'nesw-resize',
            };
            this.canvas.canvas.style.cursor = cursorMap[handle] || 'default';
        }
        else {
            this.canvas.canvas.style.cursor = 'default';
        }
    }
    finalizeOutputAreaTransform() {
        const bounds = this.canvas.outputAreaBounds;
        // Update canvas size and mask tool
        this.canvas.updateOutputAreaSize(bounds.width, bounds.height);
        // Update mask canvas for new output area
        this.canvas.maskTool.updateMaskCanvasForOutputArea();
        // Save state
        this.canvas.saveState();
        // Reset transform handle but keep transform mode active
        this.interaction.outputAreaTransformHandle = null;
    }
}
