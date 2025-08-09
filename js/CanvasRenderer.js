import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('CanvasRenderer');
export class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.renderInterval = 1000 / 60;
        this.isDirty = false;
        // Initialize overlay canvases
        this.initOverlay();
        this.initStrokeOverlay();
    }
    /**
     * Helper function to draw text with background at world coordinates
     * @param ctx Canvas context
     * @param text Text to display
     * @param worldX World X coordinate
     * @param worldY World Y coordinate
     * @param options Optional styling options
     */
    drawTextWithBackground(ctx, text, worldX, worldY, options = {}) {
        const { font = "14px sans-serif", textColor = "white", backgroundColor = "rgba(0, 0, 0, 0.7)", padding = 10, lineHeight = 18 } = options;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const screenX = (worldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const screenY = (worldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lines = text.split('\n');
        const textMetrics = lines.map(line => ctx.measureText(line));
        const bgWidth = Math.max(...textMetrics.map(m => m.width)) + padding;
        const bgHeight = lines.length * lineHeight + 4;
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(screenX - bgWidth / 2, screenY - bgHeight / 2, bgWidth, bgHeight);
        ctx.fillStyle = textColor;
        lines.forEach((line, index) => {
            const yPos = screenY - (bgHeight / 2) + (lineHeight / 2) + (index * lineHeight) + 2;
            ctx.fillText(line, screenX, yPos);
        });
        ctx.restore();
    }
    /**
     * Helper function to draw rectangle with stroke style
     * @param ctx Canvas context
     * @param rect Rectangle bounds {x, y, width, height}
     * @param options Styling options
     */
    drawStyledRect(ctx, rect, options = {}) {
        const { strokeStyle = "rgba(255, 255, 255, 0.8)", lineWidth = 2, dashPattern = null } = options;
        ctx.save();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth / this.canvas.viewport.zoom;
        if (dashPattern) {
            const scaledDash = dashPattern.map((d) => d / this.canvas.viewport.zoom);
            ctx.setLineDash(scaledDash);
        }
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        if (dashPattern) {
            ctx.setLineDash([]);
        }
        ctx.restore();
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
            }
            else {
                this.renderAnimationFrame = null;
            }
        });
    }
    actualRender() {
        if (this.canvas.offscreenCanvas.width !== this.canvas.canvas.clientWidth ||
            this.canvas.offscreenCanvas.height !== this.canvas.canvas.clientHeight) {
            const newWidth = Math.max(1, this.canvas.canvas.clientWidth);
            const newHeight = Math.max(1, this.canvas.canvas.clientHeight);
            this.canvas.offscreenCanvas.width = newWidth;
            this.canvas.offscreenCanvas.height = newHeight;
        }
        const ctx = this.canvas.offscreenCtx;
        ctx.fillStyle = '#606060';
        ctx.fillRect(0, 0, this.canvas.offscreenCanvas.width, this.canvas.offscreenCanvas.height);
        ctx.save();
        ctx.scale(this.canvas.viewport.zoom, this.canvas.viewport.zoom);
        ctx.translate(-this.canvas.viewport.x, -this.canvas.viewport.y);
        this.drawGrid(ctx);
        // Use CanvasLayers to draw layers with proper blend area support
        this.canvas.canvasLayers.drawLayersToContext(ctx, this.canvas.layers);
        // Draw mask AFTER layers but BEFORE all preview outlines
        const maskImage = this.canvas.maskTool.getMask();
        if (maskImage && this.canvas.maskTool.isOverlayVisible) {
            ctx.save();
            if (this.canvas.maskTool.isActive) {
                // In draw mask mode, use the previewOpacity value from the slider
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = this.canvas.maskTool.previewOpacity;
            }
            else {
                // When not in draw mask mode, show mask at full opacity
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1.0;
            }
            // Renderuj maskę w jej pozycji światowej (bez przesunięcia względem bounds)
            const maskWorldX = this.canvas.maskTool.x;
            const maskWorldY = this.canvas.maskTool.y;
            ctx.drawImage(maskImage, maskWorldX, maskWorldY);
            ctx.globalAlpha = 1.0;
            ctx.restore();
        }
        // Draw selection frames for selected layers
        const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);
        sortedLayers.forEach(layer => {
            if (!layer.image || !layer.visible)
                return;
            if (this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                ctx.save();
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                ctx.translate(centerX, centerY);
                ctx.rotate(layer.rotation * Math.PI / 180);
                const scaleH = layer.flipH ? -1 : 1;
                const scaleV = layer.flipV ? -1 : 1;
                if (layer.flipH || layer.flipV) {
                    ctx.scale(scaleH, scaleV);
                }
                this.drawSelectionFrame(ctx, layer);
                ctx.restore();
            }
        });
        this.drawCanvasOutline(ctx);
        this.drawOutputAreaExtensionPreview(ctx); // Draw extension preview
        this.drawPendingGenerationAreas(ctx); // Draw snapshot outlines
        this.renderInteractionElements(ctx);
        this.canvas.shapeTool.render(ctx);
        this.drawMaskAreaBounds(ctx); // Draw mask area bounds when mask tool is active
        this.renderLayerInfo(ctx);
        // Update custom shape menu position and visibility
        if (this.canvas.outputAreaShape) {
            this.canvas.customShapeMenu.show();
            this.canvas.customShapeMenu.updateScreenPosition();
        }
        else {
            this.canvas.customShapeMenu.hide();
        }
        ctx.restore();
        if (this.canvas.canvas.width !== this.canvas.offscreenCanvas.width ||
            this.canvas.canvas.height !== this.canvas.offscreenCanvas.height) {
            this.canvas.canvas.width = this.canvas.offscreenCanvas.width;
            this.canvas.canvas.height = this.canvas.offscreenCanvas.height;
        }
        this.canvas.ctx.drawImage(this.canvas.offscreenCanvas, 0, 0);
        // Ensure overlay canvases are in DOM and properly sized
        this.addOverlayToDOM();
        this.updateOverlaySize();
        this.addStrokeOverlayToDOM();
        this.updateStrokeOverlaySize();
        // Update Batch Preview UI positions
        if (this.canvas.batchPreviewManagers && this.canvas.batchPreviewManagers.length > 0) {
            this.canvas.batchPreviewManagers.forEach((manager) => {
                manager.updateScreenPosition(this.canvas.viewport);
            });
        }
    }
    renderInteractionElements(ctx) {
        const interaction = this.canvas.interaction;
        if (interaction.mode === 'resizingCanvas' && interaction.canvasResizeRect) {
            const rect = interaction.canvasResizeRect;
            this.drawStyledRect(ctx, rect, {
                strokeStyle: 'rgba(0, 255, 0, 0.8)',
                lineWidth: 2,
                dashPattern: [8, 4]
            });
            if (rect.width > 0 && rect.height > 0) {
                const text = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
                const textWorldX = rect.x + rect.width / 2;
                const textWorldY = rect.y + rect.height + (20 / this.canvas.viewport.zoom);
                this.drawTextWithBackground(ctx, text, textWorldX, textWorldY, {
                    backgroundColor: "rgba(0, 128, 0, 0.7)"
                });
            }
        }
        if (interaction.mode === 'movingCanvas' && interaction.canvasMoveRect) {
            const rect = interaction.canvasMoveRect;
            this.drawStyledRect(ctx, rect, {
                strokeStyle: 'rgba(0, 150, 255, 0.8)',
                lineWidth: 2,
                dashPattern: [10, 5]
            });
            const text = `(${Math.round(rect.x)}, ${Math.round(rect.y)})`;
            const textWorldX = rect.x + rect.width / 2;
            const textWorldY = rect.y - (20 / this.canvas.viewport.zoom);
            this.drawTextWithBackground(ctx, text, textWorldX, textWorldY, {
                backgroundColor: "rgba(0, 100, 170, 0.7)"
            });
        }
    }
    renderLayerInfo(ctx) {
        if (this.canvas.canvasSelection.selectedLayer) {
            this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
                if (!layer.image || !layer.visible)
                    return;
                const layerIndex = this.canvas.layers.indexOf(layer);
                const currentWidth = Math.round(layer.width);
                const currentHeight = Math.round(layer.height);
                const rotation = Math.round(layer.rotation % 360);
                let text = `${currentWidth}x${currentHeight} | ${rotation}° | Layer #${layerIndex + 1}`;
                if (layer.originalWidth && layer.originalHeight) {
                    text += `\nOriginal: ${layer.originalWidth}x${layer.originalHeight}`;
                }
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const halfW = layer.width / 2;
                const halfH = layer.height / 2;
                const localCorners = [
                    { x: -halfW, y: -halfH },
                    { x: halfW, y: -halfH },
                    { x: halfW, y: halfH },
                    { x: -halfW, y: halfH }
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
                const padding = 20 / this.canvas.viewport.zoom;
                const textWorldX = (minX + maxX) / 2;
                const textWorldY = maxY + padding;
                this.drawTextWithBackground(ctx, text, textWorldX, textWorldY);
            });
        }
    }
    drawGrid(ctx) {
        const gridSize = 64;
        const lineWidth = 0.5 / this.canvas.viewport.zoom;
        const viewLeft = this.canvas.viewport.x;
        const viewTop = this.canvas.viewport.y;
        const viewRight = this.canvas.viewport.x + this.canvas.offscreenCanvas.width / this.canvas.viewport.zoom;
        const viewBottom = this.canvas.viewport.y + this.canvas.offscreenCanvas.height / this.canvas.viewport.zoom;
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
    /**
     * Check if custom shape overlaps with any active batch preview areas
     */
    isCustomShapeOverlappingWithBatchAreas() {
        if (!this.canvas.outputAreaShape || !this.canvas.batchPreviewManagers || this.canvas.batchPreviewManagers.length === 0) {
            return false;
        }
        // Get custom shape bounds
        const bounds = this.canvas.outputAreaBounds;
        const ext = this.canvas.outputAreaExtensionEnabled ? this.canvas.outputAreaExtensions : { top: 0, bottom: 0, left: 0, right: 0 };
        const shapeOffsetX = bounds.x + ext.left;
        const shapeOffsetY = bounds.y + ext.top;
        const shape = this.canvas.outputAreaShape;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        // Calculate shape bounding box
        shape.points.forEach((point) => {
            const worldX = shapeOffsetX + point.x;
            const worldY = shapeOffsetY + point.y;
            minX = Math.min(minX, worldX);
            maxX = Math.max(maxX, worldX);
            minY = Math.min(minY, worldY);
            maxY = Math.max(maxY, worldY);
        });
        const shapeBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        // Check overlap with each active batch preview area
        for (const manager of this.canvas.batchPreviewManagers) {
            if (manager.generationArea) {
                const area = manager.generationArea;
                // Check if rectangles overlap
                if (!(shapeBounds.x + shapeBounds.width < area.x ||
                    area.x + area.width < shapeBounds.x ||
                    shapeBounds.y + shapeBounds.height < area.y ||
                    area.y + area.height < shapeBounds.y)) {
                    return true; // Overlap detected
                }
            }
        }
        return false;
    }
    drawCanvasOutline(ctx) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2 / this.canvas.viewport.zoom;
        ctx.setLineDash([10 / this.canvas.viewport.zoom, 5 / this.canvas.viewport.zoom]);
        // Rysuj outline w pozycji outputAreaBounds
        const bounds = this.canvas.outputAreaBounds;
        ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.stroke();
        ctx.setLineDash([]);
        // Display dimensions under outputAreaBounds
        const dimensionsText = `${Math.round(bounds.width)}x${Math.round(bounds.height)}`;
        const textWorldX = bounds.x + bounds.width / 2;
        const textWorldY = bounds.y + bounds.height + (20 / this.canvas.viewport.zoom);
        this.drawTextWithBackground(ctx, dimensionsText, textWorldX, textWorldY);
        // Only draw custom shape if it doesn't overlap with batch preview areas
        if (this.canvas.outputAreaShape && !this.isCustomShapeOverlappingWithBatchAreas()) {
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
            ctx.lineWidth = 2 / this.canvas.viewport.zoom;
            ctx.setLineDash([]);
            const shape = this.canvas.outputAreaShape;
            const bounds = this.canvas.outputAreaBounds;
            // Calculate custom shape position accounting for extensions
            // Custom shape should maintain its relative position within the original canvas area
            const ext = this.canvas.outputAreaExtensionEnabled ? this.canvas.outputAreaExtensions : { top: 0, bottom: 0, left: 0, right: 0 };
            const shapeOffsetX = bounds.x + ext.left; // Add left extension to maintain relative position
            const shapeOffsetY = bounds.y + ext.top; // Add top extension to maintain relative position
            ctx.beginPath();
            // Render custom shape with extension offset to maintain relative position
            ctx.moveTo(shapeOffsetX + shape.points[0].x, shapeOffsetY + shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) {
                ctx.lineTo(shapeOffsetX + shape.points[i].x, shapeOffsetY + shape.points[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
    }
    /**
     * Sprawdza czy punkt w świecie jest przykryty przez warstwy o wyższym zIndex
     */
    isPointCoveredByHigherLayers(worldX, worldY, currentLayer) {
        // Znajdź warstwy o wyższym zIndex niż aktualny layer
        const higherLayers = this.canvas.layers.filter((l) => l.zIndex > currentLayer.zIndex && l.visible && l !== currentLayer);
        for (const higherLayer of higherLayers) {
            // Sprawdź czy punkt jest wewnątrz tego layera
            const centerX = higherLayer.x + higherLayer.width / 2;
            const centerY = higherLayer.y + higherLayer.height / 2;
            // Przekształć punkt do lokalnego układu współrzędnych layera
            const dx = worldX - centerX;
            const dy = worldY - centerY;
            const rad = -higherLayer.rotation * Math.PI / 180;
            const rotatedX = dx * Math.cos(rad) - dy * Math.sin(rad);
            const rotatedY = dx * Math.sin(rad) + dy * Math.cos(rad);
            // Sprawdź czy punkt jest wewnątrz prostokąta layera
            if (Math.abs(rotatedX) <= higherLayer.width / 2 &&
                Math.abs(rotatedY) <= higherLayer.height / 2) {
                // Sprawdź przezroczystość layera - jeśli ma znaczącą nieprzezroczystość, uznaj za przykryty
                if (higherLayer.opacity > 0.1) {
                    return true;
                }
            }
        }
        return false;
    }
    /**
     * Rysuje linię z automatycznym przełączaniem między ciągłą a przerywaną w zależności od przykrycia
     */
    drawAdaptiveLine(ctx, startX, startY, endX, endY, layer) {
        const segmentLength = 8 / this.canvas.viewport.zoom; // Długość segmentu do sprawdzania
        const dashLength = 6 / this.canvas.viewport.zoom;
        const gapLength = 4 / this.canvas.viewport.zoom;
        const totalLength = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
        const segments = Math.max(1, Math.floor(totalLength / segmentLength));
        let currentX = startX;
        let currentY = startY;
        let lastCovered = null;
        let segmentStart = { x: startX, y: startY };
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const x = startX + (endX - startX) * t;
            const y = startY + (endY - startY) * t;
            // Przekształć współrzędne lokalne na światowe
            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;
            const rad = layer.rotation * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const worldX = centerX + (x * cos - y * sin);
            const worldY = centerY + (x * sin + y * cos);
            const isCovered = this.isPointCoveredByHigherLayers(worldX, worldY, layer);
            // Jeśli stan się zmienił lub to ostatni segment, narysuj poprzedni odcinek
            if (lastCovered !== null && (lastCovered !== isCovered || i === segments)) {
                ctx.beginPath();
                ctx.moveTo(segmentStart.x, segmentStart.y);
                ctx.lineTo(currentX, currentY);
                if (lastCovered) {
                    // Przykryty - linia przerywana
                    ctx.setLineDash([dashLength, gapLength]);
                }
                else {
                    // Nie przykryty - linia ciągła
                    ctx.setLineDash([]);
                }
                ctx.stroke();
                segmentStart = { x: currentX, y: currentY };
            }
            lastCovered = isCovered;
            currentX = x;
            currentY = y;
        }
        // Narysuj ostatni segment jeśli potrzeba
        if (lastCovered !== null) {
            ctx.beginPath();
            ctx.moveTo(segmentStart.x, segmentStart.y);
            ctx.lineTo(endX, endY);
            if (lastCovered) {
                ctx.setLineDash([dashLength, gapLength]);
            }
            else {
                ctx.setLineDash([]);
            }
            ctx.stroke();
        }
        // Resetuj dash pattern
        ctx.setLineDash([]);
    }
    drawSelectionFrame(ctx, layer) {
        const lineWidth = 2 / this.canvas.viewport.zoom;
        const handleRadius = 5 / this.canvas.viewport.zoom;
        if (layer.cropMode && layer.cropBounds && layer.originalWidth) {
            // --- CROP MODE ---
            ctx.lineWidth = lineWidth;
            // 1. Draw dashed blue line for the full transform frame (the "original size" container)
            ctx.strokeStyle = '#007bff';
            ctx.setLineDash([8 / this.canvas.viewport.zoom, 8 / this.canvas.viewport.zoom]);
            ctx.strokeRect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
            ctx.setLineDash([]);
            // 2. Draw solid blue line for the crop bounds
            const layerScaleX = layer.width / layer.originalWidth;
            const layerScaleY = layer.height / layer.originalHeight;
            const s = layer.cropBounds;
            const cropRectX = (-layer.width / 2) + (s.x * layerScaleX);
            const cropRectY = (-layer.height / 2) + (s.y * layerScaleY);
            const cropRectW = s.width * layerScaleX;
            const cropRectH = s.height * layerScaleY;
            ctx.strokeStyle = '#007bff'; // Solid blue
            this.drawAdaptiveLine(ctx, cropRectX, cropRectY, cropRectX + cropRectW, cropRectY, layer); // Top
            this.drawAdaptiveLine(ctx, cropRectX + cropRectW, cropRectY, cropRectX + cropRectW, cropRectY + cropRectH, layer); // Right
            this.drawAdaptiveLine(ctx, cropRectX + cropRectW, cropRectY + cropRectH, cropRectX, cropRectY + cropRectH, layer); // Bottom
            this.drawAdaptiveLine(ctx, cropRectX, cropRectY + cropRectH, cropRectX, cropRectY, layer); // Left
        }
        else {
            // --- TRANSFORM MODE ---
            ctx.strokeStyle = '#00ff00'; // Green
            ctx.lineWidth = lineWidth;
            const halfW = layer.width / 2;
            const halfH = layer.height / 2;
            // Draw adaptive solid green line for transform frame
            this.drawAdaptiveLine(ctx, -halfW, -halfH, halfW, -halfH, layer);
            this.drawAdaptiveLine(ctx, halfW, -halfH, halfW, halfH, layer);
            this.drawAdaptiveLine(ctx, halfW, halfH, -halfW, halfH, layer);
            this.drawAdaptiveLine(ctx, -halfW, halfH, -halfW, -halfH, layer);
            // Draw line to rotation handle
            ctx.setLineDash([]);
            ctx.beginPath();
            const startY = layer.flipV ? halfH : -halfH;
            const endY = startY + (layer.flipV ? 1 : -1) * (20 / this.canvas.viewport.zoom);
            ctx.moveTo(0, startY);
            ctx.lineTo(0, endY);
            ctx.stroke();
        }
        // --- DRAW HANDLES (Unified Logic) ---
        const handles = this.canvas.canvasLayers.getHandles(layer);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1 / this.canvas.viewport.zoom;
        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        for (const key in handles) {
            // Skip rotation handle in crop mode
            if (layer.cropMode && key === 'rot')
                continue;
            const point = handles[key];
            // The handle position is already in world space.
            // We need to convert it to the layer's local, un-rotated space.
            const dx = point.x - centerX;
            const dy = point.y - centerY;
            // "Un-rotate" the position to get it in the layer's local, un-rotated space
            const rad = -layer.rotation * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const localX = dx * cos - dy * sin;
            const localY = dx * sin + dy * cos;
            // The context is already flipped. We need to flip the coordinates
            // to match the visual transformation, so the arc is drawn in the correct place.
            const finalX = localX * (layer.flipH ? -1 : 1);
            const finalY = localY * (layer.flipV ? -1 : 1);
            ctx.beginPath();
            ctx.arc(finalX, finalY, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }
    drawOutputAreaExtensionPreview(ctx) {
        if (!this.canvas.outputAreaExtensionPreview) {
            return;
        }
        // Calculate preview bounds based on original canvas size + preview extensions
        const baseWidth = this.canvas.originalCanvasSize ? this.canvas.originalCanvasSize.width : this.canvas.width;
        const baseHeight = this.canvas.originalCanvasSize ? this.canvas.originalCanvasSize.height : this.canvas.height;
        const ext = this.canvas.outputAreaExtensionPreview;
        // Calculate preview bounds relative to original custom shape position, not (0,0)
        const originalPos = this.canvas.originalOutputAreaPosition;
        const previewBounds = {
            x: originalPos.x - ext.left, // ✅ Względem oryginalnej pozycji custom shape
            y: originalPos.y - ext.top, // ✅ Względem oryginalnej pozycji custom shape
            width: baseWidth + ext.left + ext.right,
            height: baseHeight + ext.top + ext.bottom
        };
        this.drawStyledRect(ctx, previewBounds, {
            strokeStyle: 'rgba(255, 255, 0, 0.8)',
            lineWidth: 3,
            dashPattern: [8, 4]
        });
    }
    drawPendingGenerationAreas(ctx) {
        const pendingAreas = [];
        // 1. Get all pending generation areas (from pendingBatchContext)
        if (this.canvas.pendingBatchContext && this.canvas.pendingBatchContext.outputArea) {
            pendingAreas.push(this.canvas.pendingBatchContext.outputArea);
        }
        // 2. Draw only those pending areas, które NIE mają aktywnego batch preview managera dla tego samego obszaru
        const isAreaCoveredByBatch = (area) => {
            if (!this.canvas.batchPreviewManagers)
                return false;
            return this.canvas.batchPreviewManagers.some((manager) => {
                if (!manager.generationArea)
                    return false;
                // Sprawdź czy obszary się pokrywają (prosty overlap AABB)
                const a = area;
                const b = manager.generationArea;
                return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
            });
        };
        pendingAreas.forEach(area => {
            if (!isAreaCoveredByBatch(area)) {
                this.drawStyledRect(ctx, area, {
                    strokeStyle: 'rgba(0, 150, 255, 0.9)',
                    lineWidth: 3,
                    dashPattern: [12, 6]
                });
            }
        });
    }
    drawMaskAreaBounds(ctx) {
        // Only show mask area bounds when mask tool is active
        if (!this.canvas.maskTool.isActive) {
            return;
        }
        const maskTool = this.canvas.maskTool;
        // Get mask canvas bounds in world coordinates
        const maskBounds = {
            x: maskTool.x,
            y: maskTool.y,
            width: maskTool.getMask().width,
            height: maskTool.getMask().height
        };
        this.drawStyledRect(ctx, maskBounds, {
            strokeStyle: 'rgba(255, 100, 100, 0.7)',
            lineWidth: 2,
            dashPattern: [6, 6]
        });
        // Add text label to show this is the mask drawing area
        const textWorldX = maskBounds.x + maskBounds.width / 2;
        const textWorldY = maskBounds.y - (10 / this.canvas.viewport.zoom);
        this.drawTextWithBackground(ctx, "Mask Drawing Area", textWorldX, textWorldY, {
            font: "12px sans-serif",
            backgroundColor: "rgba(255, 100, 100, 0.8)",
            padding: 8
        });
    }
    /**
     * Initialize overlay canvas for lightweight overlays like brush cursor
     */
    initOverlay() {
        // Setup overlay canvas to match main canvas
        this.updateOverlaySize();
        // Position overlay canvas on top of main canvas
        this.canvas.overlayCanvas.style.position = 'absolute';
        this.canvas.overlayCanvas.style.left = '0px';
        this.canvas.overlayCanvas.style.top = '0px';
        this.canvas.overlayCanvas.style.pointerEvents = 'none';
        this.canvas.overlayCanvas.style.zIndex = '20'; // Above other overlays
        // Add overlay to DOM when main canvas is added
        this.addOverlayToDOM();
        log.debug('Overlay canvas initialized');
    }
    /**
     * Add overlay canvas to DOM if main canvas has a parent
     */
    addOverlayToDOM() {
        if (this.canvas.canvas.parentElement && !this.canvas.overlayCanvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.canvas.overlayCanvas);
            log.debug('Overlay canvas added to DOM');
        }
    }
    /**
     * Update overlay canvas size to match main canvas
     */
    updateOverlaySize() {
        if (this.canvas.overlayCanvas.width !== this.canvas.canvas.clientWidth ||
            this.canvas.overlayCanvas.height !== this.canvas.canvas.clientHeight) {
            this.canvas.overlayCanvas.width = Math.max(1, this.canvas.canvas.clientWidth);
            this.canvas.overlayCanvas.height = Math.max(1, this.canvas.canvas.clientHeight);
            log.debug(`Overlay canvas resized to ${this.canvas.overlayCanvas.width}x${this.canvas.overlayCanvas.height}`);
        }
    }
    /**
     * Clear overlay canvas
     */
    clearOverlay() {
        this.canvas.overlayCtx.clearRect(0, 0, this.canvas.overlayCanvas.width, this.canvas.overlayCanvas.height);
    }
    /**
     * Initialize a dedicated overlay for real-time mask stroke preview
     */
    initStrokeOverlay() {
        // Create canvas if not created yet
        if (!this.strokeOverlayCanvas) {
            this.strokeOverlayCanvas = document.createElement('canvas');
            const ctx = this.strokeOverlayCanvas.getContext('2d');
            if (!ctx) {
                throw new Error('Failed to get 2D context for stroke overlay canvas');
            }
            this.strokeOverlayCtx = ctx;
        }
        // Size match main canvas
        this.updateStrokeOverlaySize();
        // Position above main canvas but below cursor overlay
        this.strokeOverlayCanvas.style.position = 'absolute';
        this.strokeOverlayCanvas.style.left = '0px';
        this.strokeOverlayCanvas.style.top = '0px';
        this.strokeOverlayCanvas.style.pointerEvents = 'none';
        this.strokeOverlayCanvas.style.zIndex = '19'; // Below cursor overlay (20)
        // Opacity is now controlled by MaskTool.previewOpacity
        this.strokeOverlayCanvas.style.opacity = String(this.canvas.maskTool.previewOpacity || 0.5);
        // Add to DOM
        this.addStrokeOverlayToDOM();
        log.debug('Stroke overlay canvas initialized');
    }
    /**
     * Add stroke overlay canvas to DOM if needed
     */
    addStrokeOverlayToDOM() {
        if (this.canvas.canvas.parentElement && !this.strokeOverlayCanvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.strokeOverlayCanvas);
            log.debug('Stroke overlay canvas added to DOM');
        }
    }
    /**
     * Ensure stroke overlay size matches main canvas
     */
    updateStrokeOverlaySize() {
        const w = Math.max(1, this.canvas.canvas.clientWidth);
        const h = Math.max(1, this.canvas.canvas.clientHeight);
        if (this.strokeOverlayCanvas.width !== w || this.strokeOverlayCanvas.height !== h) {
            this.strokeOverlayCanvas.width = w;
            this.strokeOverlayCanvas.height = h;
            log.debug(`Stroke overlay resized to ${w}x${h}`);
        }
    }
    /**
     * Clear the stroke overlay
     */
    clearMaskStrokeOverlay() {
        if (!this.strokeOverlayCtx)
            return;
        this.strokeOverlayCtx.clearRect(0, 0, this.strokeOverlayCanvas.width, this.strokeOverlayCanvas.height);
    }
    /**
     * Draw a preview stroke segment onto the stroke overlay in screen space
     * Uses line drawing with gradient to match MaskTool's drawLineOnChunk exactly
     */
    drawMaskStrokeSegment(startWorld, endWorld) {
        // Ensure overlay is present and sized
        this.updateStrokeOverlaySize();
        const zoom = this.canvas.viewport.zoom;
        const toScreen = (p) => ({
            x: (p.x - this.canvas.viewport.x) * zoom,
            y: (p.y - this.canvas.viewport.y) * zoom
        });
        const startScreen = toScreen(startWorld);
        const endScreen = toScreen(endWorld);
        const brushRadius = (this.canvas.maskTool.brushSize / 2) * zoom;
        const hardness = this.canvas.maskTool.brushHardness;
        const strength = this.canvas.maskTool.brushStrength;
        // If strength is 0, don't draw anything
        if (strength <= 0) {
            return;
        }
        this.strokeOverlayCtx.save();
        // Draw line segment exactly as MaskTool does
        this.strokeOverlayCtx.beginPath();
        this.strokeOverlayCtx.moveTo(startScreen.x, startScreen.y);
        this.strokeOverlayCtx.lineTo(endScreen.x, endScreen.y);
        // Match the gradient setup from MaskTool's drawLineOnChunk
        if (hardness === 1) {
            this.strokeOverlayCtx.strokeStyle = `rgba(255, 255, 255, ${strength})`;
        }
        else {
            const innerRadius = brushRadius * hardness;
            const gradient = this.strokeOverlayCtx.createRadialGradient(endScreen.x, endScreen.y, innerRadius, endScreen.x, endScreen.y, brushRadius);
            gradient.addColorStop(0, `rgba(255, 255, 255, ${strength})`);
            gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
            this.strokeOverlayCtx.strokeStyle = gradient;
        }
        // Match line properties from MaskTool
        this.strokeOverlayCtx.lineWidth = this.canvas.maskTool.brushSize * zoom;
        this.strokeOverlayCtx.lineCap = 'round';
        this.strokeOverlayCtx.lineJoin = 'round';
        this.strokeOverlayCtx.globalCompositeOperation = 'source-over';
        this.strokeOverlayCtx.stroke();
        this.strokeOverlayCtx.restore();
    }
    /**
     * Redraws the entire stroke overlay from world coordinates
     * Used when viewport changes during drawing to maintain visual consistency
     */
    redrawMaskStrokeOverlay(strokePoints) {
        if (strokePoints.length < 2)
            return;
        // Clear the overlay first
        this.clearMaskStrokeOverlay();
        // Redraw all segments with current viewport
        for (let i = 1; i < strokePoints.length; i++) {
            this.drawMaskStrokeSegment(strokePoints[i - 1], strokePoints[i]);
        }
    }
    /**
     * Draw mask brush cursor on overlay canvas with visual feedback for size, strength and hardness
     * @param worldPoint World coordinates of cursor
     */
    drawMaskBrushCursor(worldPoint) {
        if (!this.canvas.maskTool.isActive || !this.canvas.isMouseOver) {
            this.clearOverlay();
            return;
        }
        // Update overlay size if needed
        this.updateOverlaySize();
        // Clear previous cursor
        this.clearOverlay();
        // Convert world coordinates to screen coordinates
        const screenX = (worldPoint.x - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const screenY = (worldPoint.y - this.canvas.viewport.y) * this.canvas.viewport.zoom;
        // Get brush properties
        const brushRadius = (this.canvas.maskTool.brushSize / 2) * this.canvas.viewport.zoom;
        const brushStrength = this.canvas.maskTool.brushStrength;
        const brushHardness = this.canvas.maskTool.brushHardness;
        // Save context state
        this.canvas.overlayCtx.save();
        // If strength is 0, just draw outline
        if (brushStrength > 0) {
            // Draw inner fill to visualize brush effect - matches actual brush rendering
            const gradient = this.canvas.overlayCtx.createRadialGradient(screenX, screenY, 0, screenX, screenY, brushRadius);
            // Preview alpha - subtle to not obscure content
            const previewAlpha = brushStrength * 0.15; // Very subtle preview (max 15% opacity)
            if (brushHardness === 1) {
                // Hard brush - uniform fill within radius
                gradient.addColorStop(0, `rgba(255, 255, 255, ${previewAlpha})`);
                gradient.addColorStop(1, `rgba(255, 255, 255, ${previewAlpha})`);
            }
            else {
                // Soft brush - gradient fade matching actual brush
                gradient.addColorStop(0, `rgba(255, 255, 255, ${previewAlpha})`);
                if (brushHardness > 0) {
                    gradient.addColorStop(brushHardness, `rgba(255, 255, 255, ${previewAlpha})`);
                }
                gradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
            }
            this.canvas.overlayCtx.beginPath();
            this.canvas.overlayCtx.arc(screenX, screenY, brushRadius, 0, 2 * Math.PI);
            this.canvas.overlayCtx.fillStyle = gradient;
            this.canvas.overlayCtx.fill();
        }
        // Draw outer circle (SIZE indicator)
        this.canvas.overlayCtx.beginPath();
        this.canvas.overlayCtx.arc(screenX, screenY, brushRadius, 0, 2 * Math.PI);
        // Stroke opacity based on strength (dimmer when strength is 0)
        const strokeOpacity = brushStrength > 0 ? (0.4 + brushStrength * 0.4) : 0.3;
        this.canvas.overlayCtx.strokeStyle = `rgba(255, 255, 255, ${strokeOpacity})`;
        this.canvas.overlayCtx.lineWidth = 1.5;
        // Visual feedback for hardness
        if (brushHardness > 0.8) {
            // Hard brush - solid line
            this.canvas.overlayCtx.setLineDash([]);
        }
        else {
            // Soft brush - dashed line
            const dashLength = 2 + (1 - brushHardness) * 4;
            this.canvas.overlayCtx.setLineDash([dashLength, dashLength]);
        }
        this.canvas.overlayCtx.stroke();
        // Center dot for small brushes
        if (brushRadius < 5) {
            this.canvas.overlayCtx.beginPath();
            this.canvas.overlayCtx.arc(screenX, screenY, 1, 0, 2 * Math.PI);
            this.canvas.overlayCtx.fillStyle = `rgba(255, 255, 255, ${strokeOpacity})`;
            this.canvas.overlayCtx.fill();
        }
        // Restore context state
        this.canvas.overlayCtx.restore();
    }
    /**
     * Update overlay position when viewport changes
     */
    updateOverlayPosition() {
        // Overlay canvas is positioned absolutely, so it doesn't need repositioning
        // Just ensure it's the right size
        this.updateOverlaySize();
    }
}
