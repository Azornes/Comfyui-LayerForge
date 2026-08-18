import {createModuleLogger} from "../log_system/log_funcs.js";
import { createCanvas, getBoundsFromPoints, getLayerWorldBounds, isPointInRotatedLayer, localToWorld, worldToLocal } from "../utils/common_utils.js";

const log = createModuleLogger('CanvasRenderer');

interface ScreenRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface DragRenderState {
    selectionSignature: string;
    bounds: ScreenRect;
    viewport: { x: number; y: number; zoom: number };
    width: number;
    height: number;
}

interface ZoomSnapshotState {
    canvas: HTMLCanvasElement;
    viewport: { x: number; y: number; zoom: number };
    displayWidth: number;
    displayHeight: number;
}

export class CanvasRenderer {
    canvas: any;
    isDirty: any;
    lastRenderTime: any;
    renderAnimationFrame: any;
    renderInterval: any;
    private dragRenderState: DragRenderState | null;
    private zoomInteractionActive: boolean;
    private zoomSnapshot: ZoomSnapshotState | null;
    // Overlay used to preview in-progress mask strokes (separate from cursor overlay)
    strokeOverlayCanvas!: HTMLCanvasElement;
    strokeOverlayCtx!: CanvasRenderingContext2D;
    constructor(canvas: any) {
        this.canvas = canvas;
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.renderInterval = 1000 / 60;
        this.isDirty = false;
        this.dragRenderState = null;
        this.zoomInteractionActive = false;
        this.zoomSnapshot = null;
        
        // Initialize overlay canvases
        this.initOverlay();
        this.initStrokeOverlay();
    }

    /**
     * Starts a short-lived zoom interaction cache. The cache contains the
     * already composited scene, so rapid wheel events can scale one bitmap
     * instead of recompositing every blend layer on every frame.
     */
    public beginZoomInteraction(): void {
        if (this.zoomInteractionActive) return;

        // Mask drawing and other active transforms need live rendering because
        // their scene can change while the viewport is moving.
        const interactionMode = this.canvas.canvasInteractions?.interaction?.mode;
        if (this.canvas.maskTool?.isActive || (interactionMode && interactionMode !== 'none')) {
            return;
        }

        this.zoomInteractionActive = true;
        this.dragRenderState = null;
        this.releaseZoomSnapshot();
        this.zoomSnapshot = this.createZoomSnapshot();
    }

    /**
     * Ends the zoom cache and forces the next frame through the normal,
     * full-quality compositor.
     */
    public endZoomInteraction(): void {
        if (!this.zoomInteractionActive && !this.zoomSnapshot) return;

        this.zoomInteractionActive = false;
        this.dragRenderState = null;
        this.releaseZoomSnapshot();
    }

    private releaseZoomSnapshot(): void {
        if (this.zoomSnapshot) {
            this.zoomSnapshot.canvas.width = 0;
            this.zoomSnapshot.canvas.height = 0;
        }
        this.zoomSnapshot = null;
    }

    private getCanvasFill(): string {
        if (typeof getComputedStyle === 'function') {
            const canvasFill = getComputedStyle(this.canvas.canvas)
                .getPropertyValue('--lf-canvas-fill')
                .trim();
            if (canvasFill) return canvasFill;
        }
        return 'rgba(96, 96, 96, 0.72)';
    }

    private getZoomSnapshotScale(displayWidth: number, displayHeight: number): number {
        // A modest overscan keeps zooming out cached for several wheel steps.
        // Cap the backing surface so a large editor widget cannot allocate an
        // unexpectedly large temporary bitmap.
        const requestedScale = 1.5;
        const maxSnapshotPixels = 16_000_000;
        const requestedPixels = displayWidth * displayHeight * requestedScale * requestedScale;
        if (requestedPixels <= maxSnapshotPixels) return requestedScale;

        return Math.max(1, Math.sqrt(maxSnapshotPixels / (displayWidth * displayHeight)));
    }

    private createZoomSnapshot(): ZoomSnapshotState | null {
        const displayWidth = Math.max(
            1,
            this.canvas.offscreenCanvas.width || this.canvas.canvas.clientWidth || 1
        );
        const displayHeight = Math.max(
            1,
            this.canvas.offscreenCanvas.height || this.canvas.canvas.clientHeight || 1
        );
        const zoom = this.canvas.viewport.zoom;
        const snapshotScale = this.getZoomSnapshotScale(displayWidth, displayHeight);
        const snapshotWidth = Math.max(1, Math.ceil(displayWidth * snapshotScale));
        const snapshotHeight = Math.max(1, Math.ceil(displayHeight * snapshotScale));
        const extraWorldWidth = (snapshotWidth - displayWidth) / zoom;
        const extraWorldHeight = (snapshotHeight - displayHeight) / zoom;
        const snapshotViewport = {
            x: this.canvas.viewport.x - extraWorldWidth / 2,
            y: this.canvas.viewport.y - extraWorldHeight / 2,
            zoom,
        };

        const surface = createCanvas(snapshotWidth, snapshotHeight, '2d', {
            alpha: false,
            willReadFrequently: true,
        });
        if (!surface.ctx) return null;

        const ctx = surface.ctx;
        ctx.clearRect(0, 0, snapshotWidth, snapshotHeight);
        ctx.fillStyle = this.getCanvasFill();
        ctx.fillRect(0, 0, snapshotWidth, snapshotHeight);

        ctx.save();
        ctx.scale(snapshotViewport.zoom, snapshotViewport.zoom);
        ctx.translate(-snapshotViewport.x, -snapshotViewport.y);
        this.drawGrid(ctx, snapshotViewport, snapshotWidth, snapshotHeight);
        this.canvas.canvasLayers.drawLayersToContext(ctx, this.canvas.layers);
        this.drawVisibleMask(ctx);
        ctx.restore();

        return {
            canvas: surface.canvas,
            viewport: snapshotViewport,
            displayWidth,
            displayHeight,
        };
    }

    private canUseZoomSnapshot(
        viewport: { x: number; y: number; zoom: number },
        displayWidth: number,
        displayHeight: number
    ): boolean {
        const snapshot = this.zoomSnapshot;
        const interactionMode = this.canvas.canvasInteractions?.interaction?.mode;
        if (!this.zoomInteractionActive || !snapshot || interactionMode !== 'none') return false;
        if (snapshot.displayWidth !== displayWidth || snapshot.displayHeight !== displayHeight) return false;

        const visibleLeft = viewport.x;
        const visibleTop = viewport.y;
        const visibleRight = viewport.x + displayWidth / viewport.zoom;
        const visibleBottom = viewport.y + displayHeight / viewport.zoom;
        const snapshotRight = snapshot.viewport.x + snapshot.canvas.width / snapshot.viewport.zoom;
        const snapshotBottom = snapshot.viewport.y + snapshot.canvas.height / snapshot.viewport.zoom;
        const epsilon = 1 / Math.max(viewport.zoom, snapshot.viewport.zoom, 0.0001);

        return visibleLeft >= snapshot.viewport.x - epsilon &&
            visibleTop >= snapshot.viewport.y - epsilon &&
            visibleRight <= snapshotRight + epsilon &&
            visibleBottom <= snapshotBottom + epsilon;
    }

    private drawZoomSnapshot(
        ctx: CanvasRenderingContext2D,
        viewport: { x: number; y: number; zoom: number }
    ): void {
        const snapshot = this.zoomSnapshot;
        if (!snapshot) return;

        const scale = viewport.zoom / snapshot.viewport.zoom;
        const offsetX = (snapshot.viewport.x - viewport.x) * viewport.zoom;
        const offsetY = (snapshot.viewport.y - viewport.y) * viewport.zoom;

        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.drawImage(
            snapshot.canvas,
            offsetX,
            offsetY,
            snapshot.canvas.width * scale,
            snapshot.canvas.height * scale
        );
        ctx.restore();
    }

    private drawVisibleMask(ctx: CanvasRenderingContext2D): void {
        const maskImage = this.canvas.maskTool?.getMask();
        if (!maskImage || !this.canvas.maskTool.isOverlayVisible) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = this.canvas.maskTool.isActive
            ? this.canvas.maskTool.previewOpacity
            : 1.0;
        ctx.drawImage(maskImage, this.canvas.maskTool.x, this.canvas.maskTool.y);
        ctx.restore();
    }

    private getDragSelectionSignature(selectedLayers: any[]): string {
        return selectedLayers
            .map(layer => layer.id)
            .sort()
            .join('|');
    }

    private getLayerScreenBounds(
        layer: any,
        viewport: { x: number; y: number; zoom: number },
        width: number,
        height: number
    ): ScreenRect {
        // The drag path can draw a full-size processed image even when the
        // visible crop is smaller. Use the full transform bounds here so a
        // previous frame can never leave processed/blended pixels behind.
        const worldBounds = getLayerWorldBounds(layer);
        const padding = 32;
        const x = Math.floor((worldBounds.x - viewport.x) * viewport.zoom) - padding;
        const y = Math.floor((worldBounds.y - viewport.y) * viewport.zoom) - padding;
        const right = Math.ceil((worldBounds.x + worldBounds.width - viewport.x) * viewport.zoom) + padding;
        const bottom = Math.ceil((worldBounds.y + worldBounds.height - viewport.y) * viewport.zoom) + padding;

        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const clampedRight = Math.min(width, right);
        const clampedBottom = Math.min(height, bottom);
        return {
            x: left,
            y: top,
            width: Math.max(0, clampedRight - left),
            height: Math.max(0, clampedBottom - top)
        };
    }

    private getLayerInfoScreenBounds(
        layer: any,
        viewport: { x: number; y: number; zoom: number },
        width: number,
        height: number
    ): ScreenRect {
        const bounds = getLayerWorldBounds(layer);
        const layerIndex = this.canvas.layers.indexOf(layer);
        const lines = [
            `${Math.round(layer.width)}x${Math.round(layer.height)} | ${Math.round(layer.rotation % 360)}° | Layer #${layerIndex + 1}`
        ];
        if (layer.originalWidth && layer.originalHeight) {
            lines.push(`Original: ${layer.originalWidth}x${layer.originalHeight}`);
        }

        // drawTextWithBackground uses a fixed screen-space font and line
        // height. Measure the same text so narrow layers are invalidated far
        // enough horizontally as well as below the image.
        const textContext = this.canvas.offscreenCtx;
        let textWidth = 320;
        if (textContext) {
            textContext.save();
            textContext.setTransform(1, 0, 0, 1, 0, 0);
            textContext.font = "14px sans-serif";
            textWidth = Math.max(...lines.map(line => textContext.measureText(line).width));
            textContext.restore();
        }

        const backgroundWidth = textWidth + 10;
        const backgroundHeight = lines.length * 18 + 4;
        const centerX = (bounds.x + bounds.width / 2 - viewport.x) * viewport.zoom;
        const centerY = (bounds.y + bounds.height - viewport.y) * viewport.zoom + 20;
        const x = Math.floor(centerX - backgroundWidth / 2);
        const y = Math.floor(centerY - backgroundHeight / 2);
        const right = Math.ceil(centerX + backgroundWidth / 2);
        const bottom = Math.ceil(centerY + backgroundHeight / 2);

        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const clampedRight = Math.min(width, right);
        const clampedBottom = Math.min(height, bottom);
        return {
            x: left,
            y: top,
            width: Math.max(0, clampedRight - left),
            height: Math.max(0, clampedBottom - top)
        };
    }

    private getDragSelectionBounds(
        selectedLayers: any[],
        viewport: { x: number; y: number; zoom: number },
        width: number,
        height: number
    ): ScreenRect | null {
        if (selectedLayers.length === 0) return null;

        const renderBounds = selectedLayers.map(layer => this.getLayerScreenBounds(layer, viewport, width, height));
        const infoBounds = selectedLayers.map(layer => this.getLayerInfoScreenBounds(layer, viewport, width, height));
        const allBounds = [...renderBounds, ...infoBounds];
        const left = Math.min(...allBounds.map(bounds => bounds.x));
        const top = Math.min(...allBounds.map(bounds => bounds.y));
        const right = Math.max(...allBounds.map(bounds => bounds.x + bounds.width));
        const bottom = Math.max(...allBounds.map(bounds => bounds.y + bounds.height));
        return {
            x: left,
            y: top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top)
        };
    }

    private getDragDirtyRects(currentBounds: ScreenRect, width: number, height: number): ScreenRect[] {
        const previousBounds = this.dragRenderState?.bounds;
        if (!previousBounds) return [{ x: 0, y: 0, width, height }];

        // Keep the old and new areas separate. A single bounding rectangle
        // would redraw the whole strip between them when the pointer jumps
        // across multiple frames.
        return [previousBounds, currentBounds];
    }

    /**
     * Helper function to draw text with background at world coordinates
     * @param ctx Canvas context
     * @param text Text to display
     * @param worldX World X coordinate
     * @param worldY World Y coordinate
     * @param options Optional styling options
     */
    drawTextWithBackground(ctx: any, text: string, worldX: number, worldY: number, options: any = {}) {
        const {
            font = "14px sans-serif",
            textColor = "white",
            backgroundColor = "rgba(0, 0, 0, 0.7)",
            padding = 10,
            lineHeight = 18
        } = options;

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
    drawStyledRect(ctx: any, rect: any, options: any = {}) {
        const {
            strokeStyle = "rgba(255, 255, 255, 0.8)",
            lineWidth = 2,
            dashPattern = null
        } = options;

        ctx.save();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth / this.canvas.viewport.zoom;
        
        if (dashPattern) {
            const scaledDash = dashPattern.map((d: number) => d / this.canvas.viewport.zoom);
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
            } else {
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
        const canvasWidth = this.canvas.offscreenCanvas.width;
        const canvasHeight = this.canvas.offscreenCanvas.height;
        const isDraggingLayers = this.canvas.canvasInteractions?.interaction?.mode === 'dragging';
        const selectedLayers = this.canvas.canvasSelection.selectedLayers;
        const selectionSignature = this.getDragSelectionSignature(selectedLayers);
        const currentDragBounds = isDraggingLayers
            ? this.getDragSelectionBounds(selectedLayers, this.canvas.viewport, canvasWidth, canvasHeight)
            : null;
        const canReuseDragFrame = Boolean(
            isDraggingLayers &&
            currentDragBounds &&
            this.dragRenderState &&
            this.dragRenderState.selectionSignature === selectionSignature &&
            this.dragRenderState.width === canvasWidth &&
            this.dragRenderState.height === canvasHeight &&
            this.dragRenderState.viewport.x === this.canvas.viewport.x &&
            this.dragRenderState.viewport.y === this.canvas.viewport.y &&
            this.dragRenderState.viewport.zoom === this.canvas.viewport.zoom
        );
        const dirtyRects = canReuseDragFrame && currentDragBounds
            ? this.getDragDirtyRects(currentDragBounds, canvasWidth, canvasHeight)
            : [{ x: 0, y: 0, width: canvasWidth, height: canvasHeight }];

        // Keep the canvas readable while allowing the node's native color to
        // tint the editor underneath it. Clear first so alpha does not build
        // up on every render frame.
        const canvasFill = this.getCanvasFill();
        if (canReuseDragFrame) {
            // Preserve unchanged pixels from the previous drag frame. Every
            // layer, mask, grid line, and interaction overlay is redrawn only
            // inside the old and new selection bounds below.
            ctx.save();
            ctx.beginPath();
            dirtyRects.forEach(rect => {
                ctx.rect(rect.x, rect.y, rect.width, rect.height);
            });
            ctx.clip();
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);
            ctx.fillStyle = canvasFill;
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        } else {
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);
            ctx.fillStyle = canvasFill;
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        }

        const canUseZoomSnapshot = this.canUseZoomSnapshot(
            this.canvas.viewport,
            canvasWidth,
            canvasHeight
        );

        ctx.save();
        ctx.scale(this.canvas.viewport.zoom, this.canvas.viewport.zoom);
        ctx.translate(-this.canvas.viewport.x, -this.canvas.viewport.y);

        if (canUseZoomSnapshot) {
            // The snapshot already contains the background, grid, mask, and
            // all composited layers. Restore the screen transform for one
            // inexpensive bitmap scale, then restore the world transform so
            // selection and interaction overlays remain live.
            ctx.restore();
            this.drawZoomSnapshot(ctx, this.canvas.viewport);
            ctx.save();
            ctx.scale(this.canvas.viewport.zoom, this.canvas.viewport.zoom);
            ctx.translate(-this.canvas.viewport.x, -this.canvas.viewport.y);
        } else {
            this.drawGrid(ctx);

            // Use a screen-space cache for stationary layer groups while moving
            // selected layers. The cache replays non-source-over modes in z-order.
            if (isDraggingLayers && selectedLayers.length > 0) {
                this.canvas.canvasLayers.drawLayersDuringDrag(
                    ctx,
                    this.canvas.layers,
                    selectedLayers,
                    this.canvas.viewport,
                    canvasWidth,
                    canvasHeight
                );
            } else {
                this.canvas.canvasLayers.clearDragSceneCache();
                this.canvas.canvasLayers.drawLayersToContext(ctx, this.canvas.layers);
            }

            // Draw mask AFTER layers but BEFORE all preview outlines.
            this.drawVisibleMask(ctx);
        }
        
        // Draw selection frames for selected layers
        const sortedLayers = this.canvas.canvasLayers.getRenderOrder(this.canvas.layers);
        sortedLayers.forEach((layer: any) => {
            if (!layer.image || !layer.visible) return;
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

        // Draw grab icons for selected layers when hovering
        if (this.canvas.canvasInteractions.interaction.hoveringGrabIcon) {
            this.drawGrabIcons(ctx);
        }

        this.drawCanvasOutline(ctx);
        this.drawOutputAreaExtensionPreview(ctx); // Draw extension preview
        this.drawPendingGenerationAreas(ctx); // Draw snapshot outlines

        this.renderInteractionElements(ctx);
        this.canvas.shapeTool.render(ctx);
        this.drawMaskAreaBounds(ctx); // Draw mask area bounds when mask tool is active
        this.renderOutputAreaTransformHandles(ctx); // Draw output area transform handles
        this.renderLayerInfo(ctx);
        
        // Update custom shape menu position and visibility
        if (this.canvas.outputAreaShape) {
            this.canvas.customShapeMenu.show();
            this.canvas.customShapeMenu.updateScreenPosition();
        } else {
            this.canvas.customShapeMenu.hide();
        }

        ctx.restore();
        if (canReuseDragFrame) {
            ctx.restore();
        }

        if (isDraggingLayers && currentDragBounds) {
            this.dragRenderState = {
                selectionSignature,
                bounds: currentDragBounds,
                viewport: { ...this.canvas.viewport },
                width: canvasWidth,
                height: canvasHeight
            };
        } else {
            this.dragRenderState = null;
        }

        if (this.canvas.canvas.width !== this.canvas.offscreenCanvas.width ||
            this.canvas.canvas.height !== this.canvas.offscreenCanvas.height) {
            this.canvas.canvas.width = this.canvas.offscreenCanvas.width;
            this.canvas.canvas.height = this.canvas.offscreenCanvas.height;
        }
        if (canReuseDragFrame) {
            // The offscreen canvas already contains the unchanged pixels. A
            // partial blit keeps the visible canvas from copying the entire
            // viewport on every drag frame.
            this.canvas.ctx.save();
            this.canvas.ctx.globalCompositeOperation = 'source-over';
            this.canvas.ctx.globalAlpha = 1;
            dirtyRects.forEach(rect => {
                this.canvas.ctx.drawImage(
                    this.canvas.offscreenCanvas,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height
                );
            });
            this.canvas.ctx.restore();
        } else {
            this.canvas.ctx.clearRect(0, 0, this.canvas.canvas.width, this.canvas.canvas.height);
            this.canvas.ctx.drawImage(this.canvas.offscreenCanvas, 0, 0);
        }

        // Ensure overlay canvases are in DOM and properly sized
        this.addOverlayToDOM();
        this.updateOverlaySize();
        this.addStrokeOverlayToDOM();
        this.updateStrokeOverlaySize();

        // Update Batch Preview UI positions
        if (this.canvas.batchPreviewManagers && this.canvas.batchPreviewManagers.length > 0) {
            this.canvas.batchPreviewManagers.forEach((manager: any) => {
                manager.updateScreenPosition(this.canvas.viewport);
            });
        }
    }

    renderInteractionElements(ctx: any) {
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

    renderLayerInfo(ctx: any) {
        if (this.canvas.canvasSelection.selectedLayer) {
            this.canvas.canvasSelection.selectedLayers.forEach((layer: any) => {
                if (!layer.image || !layer.visible) return;

                const layerIndex = this.canvas.layers.indexOf(layer);
                const currentWidth = Math.round(layer.width);
                const currentHeight = Math.round(layer.height);
                const rotation = Math.round(layer.rotation % 360);
                let text = `${currentWidth}x${currentHeight} | ${rotation}° | Layer #${layerIndex + 1}`;
                if (layer.originalWidth && layer.originalHeight) {
                    text += `\nOriginal: ${layer.originalWidth}x${layer.originalHeight}`;
                }
                const bounds = getLayerWorldBounds(layer);
                const padding = 20 / this.canvas.viewport.zoom;
                const textWorldX = bounds.x + bounds.width / 2;
                const textWorldY = bounds.y + bounds.height + padding;
                
                this.drawTextWithBackground(ctx, text, textWorldX, textWorldY);
            });
        }
    }

    drawGrid(
        ctx: any,
        viewport: { x: number; y: number; zoom: number } = this.canvas.viewport,
        width: number = this.canvas.offscreenCanvas.width,
        height: number = this.canvas.offscreenCanvas.height
    ) {
        const gridSize = 64;
        const lineWidth = 0.5 / viewport.zoom;

        const viewLeft = viewport.x;
        const viewTop = viewport.y;
        const viewRight = viewport.x + width / viewport.zoom;
        const viewBottom = viewport.y + height / viewport.zoom;

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
    isCustomShapeOverlappingWithBatchAreas(): boolean {
        if (!this.canvas.outputAreaShape || !this.canvas.batchPreviewManagers || this.canvas.batchPreviewManagers.length === 0) {
            return false;
        }

        // Get custom shape bounds
        const bounds = this.canvas.outputAreaBounds;
        const ext = this.canvas.outputAreaExtensionEnabled ? this.canvas.outputAreaExtensions : { top: 0, bottom: 0, left: 0, right: 0 };
        const shapeOffsetX = bounds.x + ext.left;
        const shapeOffsetY = bounds.y + ext.top;
        
        const shape = this.canvas.outputAreaShape;
        const worldPoints = shape.points.map((point: { x: number; y: number }) => ({
            x: shapeOffsetX + point.x,
            y: shapeOffsetY + point.y,
        }));
        // Preserve the existing empty-shape bounds while using the shared point helper for valid shapes.
        const shapeBounds = worldPoints.length === 0
            ? { x: Infinity, y: Infinity, width: -Infinity, height: -Infinity }
            : getBoundsFromPoints(worldPoints);

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

    drawCanvasOutline(ctx: any) {
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
            const shapeOffsetX = bounds.x + ext.left;  // Add left extension to maintain relative position
            const shapeOffsetY = bounds.y + ext.top;   // Add top extension to maintain relative position
            
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
    isPointCoveredByHigherLayers(worldX: number, worldY: number, currentLayer: any): boolean {
        // Znajdź warstwy o wyższym zIndex niż aktualny layer
        const higherLayers = this.canvas.layers.filter((l: any) => 
            l.zIndex > currentLayer.zIndex && l.visible && l !== currentLayer
        );

        for (const higherLayer of higherLayers) {
            if (isPointInRotatedLayer(worldX, worldY, higherLayer)) {
                
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
    drawAdaptiveLine(ctx: any, startX: number, startY: number, endX: number, endY: number, layer: any) {
        const segmentLength = 8 / this.canvas.viewport.zoom; // Długość segmentu do sprawdzania
        const dashLength = 6 / this.canvas.viewport.zoom;
        const gapLength = 4 / this.canvas.viewport.zoom;
        
        const totalLength = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
        const segments = Math.max(1, Math.floor(totalLength / segmentLength));
        
        let currentX = startX;
        let currentY = startY;
        let lastCovered = null;
        let segmentStart = { x: startX, y: startY };
        const layerTransform = {
            centerX: layer.x + layer.width / 2,
            centerY: layer.y + layer.height / 2,
            rotation: layer.rotation
        };
        
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const x = startX + (endX - startX) * t;
            const y = startY + (endY - startY) * t;
            
            // Przekształć współrzędne lokalne na światowe
            const worldPoint = localToWorld(x, y, layerTransform);
            const worldX = worldPoint.x;
            const worldY = worldPoint.y;
            
            const isCovered = this.isPointCoveredByHigherLayers(worldX, worldY, layer);
            
            // Jeśli stan się zmienił lub to ostatni segment, narysuj poprzedni odcinek
            if (lastCovered !== null && (lastCovered !== isCovered || i === segments)) {
                ctx.beginPath();
                ctx.moveTo(segmentStart.x, segmentStart.y);
                ctx.lineTo(currentX, currentY);
                
                if (lastCovered) {
                    // Przykryty - linia przerywana
                    ctx.setLineDash([dashLength, gapLength]);
                } else {
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
            } else {
                ctx.setLineDash([]);
            }
            
            ctx.stroke();
        }
        
        // Resetuj dash pattern
        ctx.setLineDash([]);
    }

    drawSelectionFrame(ctx: any, layer: any) {
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

        } else {
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
        const layerTransform = {
            centerX,
            centerY,
            rotation: layer.rotation
        };

        for (const key in handles) {
            // Skip rotation handle in crop mode
            if (layer.cropMode && key === 'rot') continue;
            
            const point = handles[key];
            // The handle position is already in world space.
            // We need to convert it to the layer's local, un-rotated space.
            const localPoint = worldToLocal(point.x, point.y, layerTransform);

            // The context is already flipped. We need to flip the coordinates
            // to match the visual transformation, so the arc is drawn in the correct place.
            const finalX = localPoint.x * (layer.flipH ? -1 : 1);
            const finalY = localPoint.y * (layer.flipV ? -1 : 1);

            ctx.beginPath();
            ctx.arc(finalX, finalY, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    drawOutputAreaExtensionPreview(ctx: any) {
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
            x: originalPos.x - ext.left,  // ✅ Względem oryginalnej pozycji custom shape
            y: originalPos.y - ext.top,   // ✅ Względem oryginalnej pozycji custom shape
            width: baseWidth + ext.left + ext.right,
            height: baseHeight + ext.top + ext.bottom
        };

        this.drawStyledRect(ctx, previewBounds, {
            strokeStyle: 'rgba(255, 255, 0, 0.8)',
            lineWidth: 3,
            dashPattern: [8, 4]
        });
    }

    drawPendingGenerationAreas(ctx: any) {
        const pendingAreas = [];

        // 1. Get all pending generation areas (from pendingBatchContext)
        if (this.canvas.pendingBatchContext && this.canvas.pendingBatchContext.outputArea) {
            pendingAreas.push(this.canvas.pendingBatchContext.outputArea);
        }

        // 2. Draw only those pending areas, które NIE mają aktywnego batch preview managera dla tego samego obszaru
        const isAreaCoveredByBatch = (area: any) => {
            if (!this.canvas.batchPreviewManagers) return false;
            return this.canvas.batchPreviewManagers.some((manager: any) => {
                if (!manager.generationArea) return false;
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

    drawMaskAreaBounds(ctx: any) {
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
    initOverlay(): void {
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
    addOverlayToDOM(): void {
        if (this.canvas.canvas.parentElement && !this.canvas.overlayCanvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.canvas.overlayCanvas);
            log.debug('Overlay canvas added to DOM');
        }
    }

    /**
     * Update overlay canvas size to match main canvas
     */
    updateOverlaySize(): void {
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
    clearOverlay(): void {
        this.canvas.overlayCtx.clearRect(0, 0, this.canvas.overlayCanvas.width, this.canvas.overlayCanvas.height);
    }

    /**
     * Initialize a dedicated overlay for real-time mask stroke preview
     */
    initStrokeOverlay(): void {
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
        this.strokeOverlayCanvas.style.left = '1px';
        this.strokeOverlayCanvas.style.top = '1px';
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
    addStrokeOverlayToDOM(): void {
        if (this.canvas.canvas.parentElement && !this.strokeOverlayCanvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.strokeOverlayCanvas);
            log.debug('Stroke overlay canvas added to DOM');
        }
    }

    /**
     * Ensure stroke overlay size matches main canvas
     */
    updateStrokeOverlaySize(): void {
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
    clearMaskStrokeOverlay(): void {
        if (!this.strokeOverlayCtx) return;
        this.strokeOverlayCtx.clearRect(0, 0, this.strokeOverlayCanvas.width, this.strokeOverlayCanvas.height);
    }

    /**
     * Draw a preview stroke segment onto the stroke overlay in screen space
     * Uses line drawing with gradient to match MaskTool's drawLineOnChunk exactly
     */
    drawMaskStrokeSegment(startWorld: { x: number; y: number }, endWorld: { x: number; y: number }): void {
        // Ensure overlay is present and sized
        this.updateStrokeOverlaySize();

        const zoom = this.canvas.viewport.zoom;
        const toScreen = (p: { x: number; y: number }) => ({
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
        } else {
            const innerRadius = brushRadius * hardness;
            const gradient = this.strokeOverlayCtx.createRadialGradient(
                endScreen.x, endScreen.y, innerRadius,
                endScreen.x, endScreen.y, brushRadius
            );
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
    redrawMaskStrokeOverlay(strokePoints: { x: number; y: number }[]): void {
        if (strokePoints.length < 2) return;

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
    drawMaskBrushCursor(worldPoint: { x: number, y: number }): void {
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
            const gradient = this.canvas.overlayCtx.createRadialGradient(
                screenX, screenY, 0,
                screenX, screenY, brushRadius
            );
            
            // Preview alpha - subtle to not obscure content
            const previewAlpha = brushStrength * 0.15; // Very subtle preview (max 15% opacity)
            
            if (brushHardness === 1) {
                // Hard brush - uniform fill within radius
                gradient.addColorStop(0, `rgba(255, 255, 255, ${previewAlpha})`);
                gradient.addColorStop(1, `rgba(255, 255, 255, ${previewAlpha})`);
            } else {
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
        } else {
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
    updateOverlayPosition(): void {
        // Overlay canvas is positioned absolutely, so it doesn't need repositioning
        // Just ensure it's the right size
        this.updateOverlaySize();
    }

    /**
     * Draw grab icons in the center of selected layers
     */
    drawGrabIcons(ctx: any): void {
        const selectedLayers = this.canvas.canvasSelection.selectedLayers;
        if (selectedLayers.length === 0) return;

        const iconRadius = 20 / this.canvas.viewport.zoom;
        selectedLayers.forEach((layer: any) => {
            if (!layer.visible) return;

            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;

            ctx.save();

            // Draw outer circle (background)
            ctx.beginPath();
            ctx.arc(centerX, centerY, iconRadius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 150, 255, 0.7)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 2 / this.canvas.viewport.zoom;
            ctx.stroke();

            // Draw hand/grab icon (simplified)
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.lineWidth = 1.5 / this.canvas.viewport.zoom;

            // Draw four dots representing grab points
            const dotRadius = 2 / this.canvas.viewport.zoom;
            const dotDistance = 6 / this.canvas.viewport.zoom;

            // Top-left
            ctx.beginPath();
            ctx.arc(centerX - dotDistance, centerY - dotDistance, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            // Top-right
            ctx.beginPath();
            ctx.arc(centerX + dotDistance, centerY - dotDistance, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            // Bottom-left
            ctx.beginPath();
            ctx.arc(centerX - dotDistance, centerY + dotDistance, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            // Bottom-right
            ctx.beginPath();
            ctx.arc(centerX + dotDistance, centerY + dotDistance, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        });
    }

    /**
     * Draw transform handles for output area when in transform mode
     */
    renderOutputAreaTransformHandles(ctx: any): void {
        if (this.canvas.canvasInteractions.interaction.mode !== 'transformingOutputArea') {
            return;
        }

        const bounds = this.canvas.outputAreaBounds;
        const handleRadius = 5 / this.canvas.viewport.zoom;
        
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

        // Draw handles
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1 / this.canvas.viewport.zoom;

        for (const pos of Object.values(handles)) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Draw a highlight around the output area
        ctx.strokeStyle = 'rgba(0, 150, 255, 0.8)';
        ctx.lineWidth = 3 / this.canvas.viewport.zoom;
        ctx.setLineDash([]);
        ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
}
