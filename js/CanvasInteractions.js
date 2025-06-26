import {createModuleLogger} from "./LoggerUtils.js";
import {snapToGrid, getSnapAdjustment} from "./CommonUtils.js";

// Inicjalizacja loggera dla modułu CanvasInteractions
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

        this.canvas.canvas.addEventListener('mouseenter', () => {
            this.canvas.isMouseOver = true;
        });
        this.canvas.canvas.addEventListener('mouseleave', () => {
            this.canvas.isMouseOver = false;
        });
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

        if (this.canvas.maskTool.isActive) {
            if (e.button === 1) { // Środkowy przycisk myszy (kółko)
                this.startPanning(e);
                this.canvas.render();
                return;
            }
            this.canvas.maskTool.handleMouseDown(worldCoords);
            this.canvas.render();
            return;
        }

        const currentTime = Date.now();
        if (e.shiftKey && e.ctrlKey) {
            this.startCanvasMove(worldCoords);
            this.canvas.render();
            return;
        }

        if (currentTime - this.interaction.lastClickTime < 300) {
            this.canvas.updateSelection([]);
            this.canvas.selectedLayer = null;
            this.resetInteractionState();
            this.canvas.render();
            return;
        }
        this.interaction.lastClickTime = currentTime;

        const transformTarget = this.canvas.getHandleAtPosition(worldCoords.x, worldCoords.y);
        if (transformTarget) {
            this.startLayerTransform(transformTarget.layer, transformTarget.handle, worldCoords);
            return;
        }

        const clickedLayerResult = this.canvas.getLayerAtPosition(worldCoords.x, worldCoords.y);
        if (clickedLayerResult) {
            if (e.shiftKey && this.canvas.selectedLayers.includes(clickedLayerResult.layer)) {
                this.canvas.showBlendModeMenu(e.clientX, e.clientY);
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

        this.canvas.render();
    }

    handleMouseMove(e) {
        const worldCoords = this.canvas.getMouseWorldCoordinates(e);
        this.canvas.lastMousePosition = worldCoords;

        if (this.canvas.maskTool.isActive) {
            if (this.interaction.mode === 'panning') {
                this.panViewport(e);
                return;
            }
            this.canvas.maskTool.handleMouseMove(worldCoords);
            if (this.canvas.maskTool.isDrawing) this.canvas.render();
            return;
        }

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
        if (this.canvas.maskTool.isActive) {
            if (this.interaction.mode === 'panning') {
                this.resetInteractionState();
                this.canvas.render();
                return;
            }
            this.canvas.maskTool.handleMouseUp();
            // Nie wywołujemy saveState - to już jest obsługiwane w MaskTool
            this.canvas.render();
            return;
        }

        const interactionEnded = this.interaction.mode !== 'none' && this.interaction.mode !== 'panning';

        if (this.interaction.mode === 'resizingCanvas') {
            this.finalizeCanvasResize();
        } else if (this.interaction.mode === 'movingCanvas') {
            this.finalizeCanvasMove();
        }
        this.resetInteractionState();
        this.canvas.render();

        if (interactionEnded) {
            this.canvas.saveState();
            this.canvas.saveStateToDB(true);
        }
    }

    handleMouseLeave(e) {
        if (this.canvas.maskTool.isActive) {
            this.canvas.maskTool.handleMouseUp();
            this.canvas.render();
            return;
        }
        if (this.interaction.mode !== 'none') {
            this.resetInteractionState();
            this.canvas.render();
        }
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

            this.canvas.selectedLayers.forEach(layer => {
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
        
        // Nie zapisujemy stanu podczas scrollowania w trybie maski
        if (!this.canvas.maskTool.isActive) {
            this.canvas.saveState(true);
        }
    }

    handleKeyDown(e) {
        if (this.canvas.maskTool.isActive) {
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
                        this.canvas.redo();
                    } else {
                        this.canvas.undo();
                    }
                    return;
                }
                if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.canvas.redo();
                    return;
                }
            }
            return;
        }

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
                    this.canvas.redo();
                } else {
                    this.canvas.undo();
                }
                return;
            }
            if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                e.stopPropagation();
                this.canvas.redo();
                return;
            }
            if (e.key.toLowerCase() === 'c') {
                if (this.canvas.selectedLayers.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.canvas.copySelectedLayers();
                }
                return;
            }
            if (e.key.toLowerCase() === 'v') {
                e.preventDefault();
                e.stopPropagation();
                this.canvas.handlePaste();
                return;
            }
        }

        if (this.canvas.selectedLayer) {
            if (e.key === 'Delete') {
                e.preventDefault();
                e.stopPropagation();
                this.canvas.saveState();
                this.canvas.layers = this.canvas.layers.filter(l => !this.canvas.selectedLayers.includes(l));
                this.canvas.updateSelection([]);
                this.canvas.render();
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

                    if (e.code === 'ArrowLeft') this.canvas.selectedLayers.forEach(l => l.x -= step);
                    if (e.code === 'ArrowRight') this.canvas.selectedLayers.forEach(l => l.x += step);
                    if (e.code === 'ArrowUp') this.canvas.selectedLayers.forEach(l => l.y -= step);
                    if (e.code === 'ArrowDown') this.canvas.selectedLayers.forEach(l => l.y += step);
                    if (e.code === 'BracketLeft') this.canvas.selectedLayers.forEach(l => l.rotation -= step);
                    if (e.code === 'BracketRight') this.canvas.selectedLayers.forEach(l => l.rotation += step);

                    needsRender = true;
                    break;
            }

            if (needsRender) {
                this.canvas.render();
                this.canvas.saveState();
            }
        }
    }

    handleKeyUp(e) {
        if (e.key === 'Control') this.interaction.isCtrlPressed = false;
        if (e.key === 'Alt') this.interaction.isAltPressed = false;
    }

    updateCursor(worldCoords) {
        const transformTarget = this.canvas.getHandleAtPosition(worldCoords.x, worldCoords.y);

        if (transformTarget) {
            const handleName = transformTarget.handle;
            const cursorMap = {
                'n': 'ns-resize', 's': 'ns-resize', 'e': 'ew-resize', 'w': 'ew-resize',
                'nw': 'nwse-resize', 'se': 'nwse-resize', 'ne': 'nesw-resize', 'sw': 'nesw-resize',
                'rot': 'grab'
            };
            this.canvas.canvas.style.cursor = cursorMap[handleName];
        } else if (this.canvas.getLayerAtPosition(worldCoords.x, worldCoords.y)) {
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
            const handles = this.canvas.getHandles(layer);
            const oppositeHandleKey = {
                'n': 's', 's': 'n', 'e': 'w', 'w': 'e',
                'nw': 'se', 'se': 'nw', 'ne': 'sw', 'sw': 'ne'
            }[handle];
            this.interaction.resizeAnchor = handles[oppositeHandleKey];
        }
        this.canvas.render();
    }

    startLayerDrag(layer, worldCoords) {
        this.interaction.mode = 'dragging';
        this.interaction.dragStart = {...worldCoords};

        let currentSelection = [...this.canvas.selectedLayers];

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

        this.canvas.updateSelection(currentSelection);

        this.originalLayerPositions.clear();
        this.canvas.selectedLayers.forEach(l => {
            this.originalLayerPositions.set(l, {x: l.x, y: l.y});
        });
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
            this.canvas.viewport.x -= finalX;
            this.canvas.viewport.y -= finalY;
        }
        this.canvas.render();
    }

    startPanning(e) {
        if (!this.interaction.isCtrlPressed) {
            this.canvas.updateSelection([]);
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
        if (this.interaction.isAltPressed && !this.interaction.hasClonedInDrag && this.canvas.selectedLayers.length > 0) {
            const newLayers = [];
            this.canvas.selectedLayers.forEach(layer => {
                const newLayer = {
                    ...layer,
                    zIndex: this.canvas.layers.length,
                };
                this.canvas.layers.push(newLayer);
                newLayers.push(newLayer);
            });
            this.canvas.updateSelection(newLayers);
            this.canvas.selectedLayer = newLayers.length > 0 ? newLayers[newLayers.length - 1] : null;
            this.originalLayerPositions.clear();
            this.canvas.selectedLayers.forEach(l => {
                this.originalLayerPositions.set(l, {x: l.x, y: l.y});
            });
            this.interaction.hasClonedInDrag = true;
        }
        const totalDx = worldCoords.x - this.interaction.dragStart.x;
        const totalDy = worldCoords.y - this.interaction.dragStart.y;
        let finalDx = totalDx, finalDy = totalDy;

        if (this.interaction.isCtrlPressed && this.canvas.selectedLayer) {
            const originalPos = this.originalLayerPositions.get(this.canvas.selectedLayer);
            if (originalPos) {
                const tempLayerForSnap = {
                    ...this.canvas.selectedLayer,
                    x: originalPos.x + totalDx,
                    y: originalPos.y + totalDy
                };
                const snapAdjustment = getSnapAdjustment(tempLayerForSnap);
                finalDx += snapAdjustment.dx;
                finalDy += snapAdjustment.dy;
            }
        }

        this.canvas.selectedLayers.forEach(layer => {
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
            const rectX = this.interaction.canvasResizeRect.x;
            const rectY = this.interaction.canvasResizeRect.y;

            this.canvas.updateCanvasSize(newWidth, newHeight);

            this.canvas.layers.forEach(layer => {
                layer.x -= rectX;
                layer.y -= rectY;
            });

            this.canvas.viewport.x -= rectX;
            this.canvas.viewport.y -= rectY;
        }
    }
}
