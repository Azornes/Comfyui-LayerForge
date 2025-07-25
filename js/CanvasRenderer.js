import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('CanvasRenderer');
export class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.renderInterval = 1000 / 60;
        this.isDirty = false;
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
        this.drawPendingGenerationAreas(ctx); // Draw snapshot outlines
        const maskImage = this.canvas.maskTool.getMask();
        if (maskImage && this.canvas.maskTool.isOverlayVisible) {
            ctx.save();
            if (this.canvas.maskTool.isActive) {
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 0.5;
            }
            else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1.0;
            }
            ctx.drawImage(maskImage, this.canvas.maskTool.x, this.canvas.maskTool.y);
            ctx.globalAlpha = 1.0;
            ctx.restore();
        }
        this.renderInteractionElements(ctx);
        this.canvas.shapeTool.render(ctx);
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
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.lineWidth = 2 / this.canvas.viewport.zoom;
            ctx.setLineDash([8 / this.canvas.viewport.zoom, 4 / this.canvas.viewport.zoom]);
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.setLineDash([]);
            ctx.restore();
            if (rect.width > 0 && rect.height > 0) {
                const text = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
                const textWorldX = rect.x + rect.width / 2;
                const textWorldY = rect.y + rect.height + (20 / this.canvas.viewport.zoom);
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                const screenX = (textWorldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
                const screenY = (textWorldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;
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
        if (interaction.mode === 'movingCanvas' && interaction.canvasMoveRect) {
            const rect = interaction.canvasMoveRect;
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 150, 255, 0.8)';
            ctx.lineWidth = 2 / this.canvas.viewport.zoom;
            ctx.setLineDash([10 / this.canvas.viewport.zoom, 5 / this.canvas.viewport.zoom]);
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.setLineDash([]);
            ctx.restore();
            const text = `(${Math.round(rect.x)}, ${Math.round(rect.y)})`;
            const textWorldX = rect.x + rect.width / 2;
            const textWorldY = rect.y - (20 / this.canvas.viewport.zoom);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const screenX = (textWorldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
            const screenY = (textWorldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;
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
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                const screenX = (textWorldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
                const screenY = (textWorldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;
                ctx.font = "14px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const lines = text.split('\n');
                const textMetrics = lines.map(line => ctx.measureText(line));
                const textBgWidth = Math.max(...textMetrics.map(m => m.width)) + 10;
                const lineHeight = 18;
                const textBgHeight = lines.length * lineHeight + 4;
                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(screenX - textBgWidth / 2, screenY - textBgHeight / 2, textBgWidth, textBgHeight);
                ctx.fillStyle = "white";
                lines.forEach((line, index) => {
                    const yPos = screenY - (textBgHeight / 2) + (lineHeight / 2) + (index * lineHeight) + 2;
                    ctx.fillText(line, screenX, yPos);
                });
                ctx.restore();
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
    drawCanvasOutline(ctx) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2 / this.canvas.viewport.zoom;
        ctx.setLineDash([10 / this.canvas.viewport.zoom, 5 / this.canvas.viewport.zoom]);
        ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        ctx.stroke();
        ctx.setLineDash([]);
        if (this.canvas.outputAreaShape) {
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
            ctx.lineWidth = 2 / this.canvas.viewport.zoom;
            ctx.setLineDash([]);
            const shape = this.canvas.outputAreaShape;
            ctx.beginPath();
            ctx.moveTo(shape.points[0].x, shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) {
                ctx.lineTo(shape.points[i].x, shape.points[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
    }
    drawSelectionFrame(ctx, layer) {
        const lineWidth = 2 / this.canvas.viewport.zoom;
        const handleRadius = 5 / this.canvas.viewport.zoom;
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -layer.height / 2);
        ctx.lineTo(0, -layer.height / 2 - 20 / this.canvas.viewport.zoom);
        ctx.stroke();
        const handles = this.canvas.canvasLayers.getHandles(layer);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1 / this.canvas.viewport.zoom;
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
    drawPendingGenerationAreas(ctx) {
        const areasToDraw = [];
        // 1. Get areas from active managers
        if (this.canvas.batchPreviewManagers && this.canvas.batchPreviewManagers.length > 0) {
            this.canvas.batchPreviewManagers.forEach((manager) => {
                if (manager.generationArea) {
                    areasToDraw.push(manager.generationArea);
                }
            });
        }
        // 2. Get the area from the pending context (if it exists)
        if (this.canvas.pendingBatchContext && this.canvas.pendingBatchContext.outputArea) {
            areasToDraw.push(this.canvas.pendingBatchContext.outputArea);
        }
        if (areasToDraw.length === 0) {
            return;
        }
        // 3. Draw all collected areas
        areasToDraw.forEach(area => {
            ctx.save();
            ctx.strokeStyle = 'rgba(0, 150, 255, 0.9)'; // Blue color
            ctx.lineWidth = 3 / this.canvas.viewport.zoom;
            ctx.setLineDash([12 / this.canvas.viewport.zoom, 6 / this.canvas.viewport.zoom]);
            ctx.strokeRect(area.x, area.y, area.width, area.height);
            ctx.restore();
        });
    }
}
