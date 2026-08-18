import { saveImage } from "../persistence/db.js";
import { createModuleLogger } from "../log_system/log_funcs.js";
import { generateUUID, generateUniqueFileName, createCanvas, getBoundsFromPoints, getLayerWorldCorners, isPointInLayerLocalBounds, isPointInRotatedLayer, localToWorld, worldToLayerLocal } from "../utils/common_utils.js";
import { withErrorHandling, createValidationError } from "../shared/error_handler.js";
import { showErrorNotification } from "../utils/notification_utils.js";
import { addStylesheet, getUrl } from "../utils/resource_manager.js";
// @ts-ignore
import { app } from "../../../scripts/app.js";
// @ts-ignore
import { ComfyApp } from "../../../scripts/app.js";
import { ClipboardManager } from "../utils/clipboard_manager.js";
import { createDistanceFieldDataSync, rasterizeDistanceFieldMaskSync } from "../mask/image_analysis.js";
import { fillInverseAlphaMask } from "../mask/mask_pixel_utils.js";
import { blobToDataUrl } from "../media/image_utils.js";
const log = createModuleLogger('CanvasLayers');
export class CanvasLayers {
    constructor(canvas) {
        this._canvasMaskCache = new WeakMap();
        this.cropCanvasCache = new WeakMap();
        this.MAX_CROP_CANVAS_CACHE_ENTRIES = 8;
        this.blendMenuElement = null;
        this.blendMenuWorldX = 0;
        this.blendMenuWorldY = 0;
        // Cache for processed images with effects applied. ImageBitmap avoids the
        // Base64 round-trip used by the old HTMLImageElement path.
        this.processedImageCache = new Map();
        this.processedImageMetadata = new Map();
        this.lastProcessedImageFallbacks = new Map();
        // Reused surface for live blend-area previews. It grows when necessary
        // and is cleared between uses instead of being allocated every frame.
        this.liveBlendCanvas = null;
        this.liveBlendCtx = null;
        this.liveBlendCanvasWidth = 0;
        this.liveBlendCanvasHeight = 0;
        // Layer order changes rarely compared with render frames. Keep the sorted
        // references and rebuild them when order data or a source layer reference
        // changes. The reference check also catches in-place layer replacement
        // (for example, when matting replaces the image but keeps id/zIndex).
        this.renderOrderCache = [];
        this.renderOrderSource = null;
        this.renderOrderSourceEntries = [];
        this.renderOrderSignature = '';
        this.dragSceneCache = null;
        // Debouncing system for processed image creation
        this.processedImageDebounceTimers = new Map();
        this.processedImageBuildTimers = new Map();
        this.processedImageBuilds = new Map();
        this.latestProcessedImageKeys = new Map();
        this.PROCESSED_IMAGE_DEBOUNCE_DELAY = 1000; // 1 second
        this.globalDebounceTimer = null;
        this.lastRenderTime = 0;
        this.layersAdjustingBlendArea = new Set();
        this.layersTransformingCropBounds = new Set();
        this.layersTransformingScale = new Set();
        this.layersWheelScaling = new Set();
        this.addLayerWithImage = withErrorHandling(async (image, layerProps = {}, addMode = 'default', targetArea = null) => {
            if (!image) {
                throw createValidationError("Image is required for layer creation");
            }
            log.debug("Adding layer with image:", image, "with mode:", addMode, "targetArea:", targetArea);
            const imageId = generateUUID();
            await saveImage(imageId, image.src);
            this.canvas.imageCache.set(imageId, image.src);
            let finalWidth = image.width;
            let finalHeight = image.height;
            let finalX, finalY;
            // Use the targetArea if provided, otherwise default to the current output area bounds
            const bounds = this.canvas.outputAreaBounds;
            const area = targetArea || { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
            if (addMode === 'fit') {
                const scale = Math.min(area.width / image.width, area.height / image.height);
                finalWidth = image.width * scale;
                finalHeight = image.height * scale;
                finalX = area.x + (area.width - finalWidth) / 2;
                finalY = area.y + (area.height - finalHeight) / 2;
            }
            else if (addMode === 'mouse') {
                finalX = this.canvas.lastMousePosition.x - finalWidth / 2;
                finalY = this.canvas.lastMousePosition.y - finalHeight / 2;
            }
            else {
                finalX = area.x + (area.width - finalWidth) / 2;
                finalY = area.y + (area.height - finalHeight) / 2;
            }
            // Find the highest zIndex among existing layers
            const maxZIndex = this.canvas.layers.length > 0
                ? Math.max(...this.canvas.layers.map(l => l.zIndex))
                : -1;
            const layer = {
                id: generateUUID(),
                image: image,
                imageId: imageId,
                name: 'Layer',
                x: finalX,
                y: finalY,
                width: finalWidth,
                height: finalHeight,
                originalWidth: image.width,
                originalHeight: image.height,
                rotation: 0,
                zIndex: maxZIndex + 1, // Always add new layer on top
                blendMode: 'normal',
                opacity: 1,
                visible: true,
                ...layerProps
            };
            if (layer.mask) {
                const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(layer.width, layer.height);
                if (tempCtx) {
                    tempCtx.drawImage(layer.image, 0, 0, layer.width, layer.height);
                    const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(layer.width, layer.height);
                    if (maskCtx) {
                        const maskImageData = maskCtx.createImageData(layer.width, layer.height);
                        for (let i = 0; i < layer.mask.length; i++) {
                            maskImageData.data[i * 4] = 255;
                            maskImageData.data[i * 4 + 1] = 255;
                            maskImageData.data[i * 4 + 2] = 255;
                            maskImageData.data[i * 4 + 3] = layer.mask[i] * 255;
                        }
                        maskCtx.putImageData(maskImageData, 0, 0);
                        tempCtx.globalCompositeOperation = 'destination-in';
                        tempCtx.drawImage(maskCanvas, 0, 0);
                        const newImage = new Image();
                        newImage.crossOrigin = 'anonymous';
                        newImage.src = tempCanvas.toDataURL();
                        layer.image = newImage;
                    }
                }
            }
            this.canvas.layers.push(layer);
            this.canvas.updateSelection([layer]);
            this.canvas.render();
            this.canvas.saveState();
            if (this.canvas.canvasLayersPanel) {
                this.canvas.canvasLayersPanel.onLayersChanged();
            }
            log.info("Layer added successfully");
            return layer;
        }, 'CanvasLayers.addLayerWithImage');
        this.currentCloseMenuListener = null;
        this.canvas = canvas;
        this.clipboardManager = new ClipboardManager(canvas);
        this.distanceFieldCache = new WeakMap();
        this.processedImageCache = new Map();
        this.processedImageMetadata = new Map();
        this.lastProcessedImageFallbacks = new Map();
        this.processedImageDebounceTimers = new Map();
        this.processedImageBuildTimers = new Map();
        this.processedImageBuilds = new Map();
        this.latestProcessedImageKeys = new Map();
        this.blendModes = [
            { name: 'normal', label: 'Normal' },
            { name: 'multiply', label: 'Multiply' },
            { name: 'screen', label: 'Screen' },
            { name: 'overlay', label: 'Overlay' },
            { name: 'darken', label: 'Darken' },
            { name: 'lighten', label: 'Lighten' },
            { name: 'color-dodge', label: 'Color Dodge' },
            { name: 'color-burn', label: 'Color Burn' },
            { name: 'hard-light', label: 'Hard Light' },
            { name: 'soft-light', label: 'Soft Light' },
            { name: 'difference', label: 'Difference' },
            { name: 'exclusion', label: 'Exclusion' }
        ];
        this.selectedBlendMode = null;
        this.blendOpacity = 100;
        this.isAdjustingOpacity = false;
        this.internalClipboard = [];
        this.clipboardPreference = 'system';
        // Load CSS for blend mode menu
        addStylesheet(getUrl('./css/blend_mode_menu.css'));
    }
    async copySelectedLayers() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.internalClipboard = this.canvas.canvasSelection.selectedLayers.map((layer) => ({ ...layer }));
        log.info(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);
        const blob = await this.getFlattenedSelectionAsBlob();
        if (!blob) {
            log.warn("Failed to create flattened selection blob");
            return;
        }
        if (this.clipboardPreference === 'clipspace') {
            try {
                const dataURL = await blobToDataUrl(blob);
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    if (!this.canvas.node.imgs) {
                        this.canvas.node.imgs = [];
                    }
                    this.canvas.node.imgs[0] = img;
                    if (ComfyApp.copyToClipspace) {
                        ComfyApp.copyToClipspace(this.canvas.node);
                        log.info("Flattened selection copied to ComfyUI Clipspace.");
                    }
                    else {
                        log.warn("ComfyUI copyToClipspace not available");
                    }
                };
                img.src = dataURL;
            }
            catch (error) {
                log.error("Failed to copy image to ComfyUI Clipspace:", error);
                try {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    log.info("Fallback: Flattened selection copied to system clipboard.");
                }
                catch (fallbackError) {
                    log.error("Failed to copy to system clipboard as fallback:", fallbackError);
                }
            }
        }
        else {
            try {
                const item = new ClipboardItem({ 'image/png': blob });
                await navigator.clipboard.write([item]);
                log.info("Flattened selection copied to system clipboard.");
            }
            catch (error) {
                log.error("Failed to copy image to system clipboard:", error);
            }
        }
    }
    /**
     * Automatically adjust output area to fit selected layers
     * Calculates precise bounding box for all selected layers including rotation and crop mode support
     */
    autoAdjustOutputToSelection() {
        const selectedLayers = this.canvas.canvasSelection.selectedLayers;
        if (selectedLayers.length === 0) {
            return false;
        }
        const bounds = getBoundsFromPoints(selectedLayers.flatMap((layer) => getLayerWorldCorners(layer, { cropAware: true })));
        const { x: minX, y: minY, width: rawWidth, height: rawHeight } = bounds;
        // Calculate new dimensions without padding for precise fit
        const newWidth = Math.ceil(rawWidth);
        const newHeight = Math.ceil(rawHeight);
        if (newWidth <= 0 || newHeight <= 0) {
            log.error("Cannot calculate valid output area dimensions");
            return false;
        }
        // Update output area bounds
        this.canvas.outputAreaBounds = {
            x: minX,
            y: minY,
            width: newWidth,
            height: newHeight
        };
        // Update canvas dimensions
        this.canvas.width = newWidth;
        this.canvas.height = newHeight;
        this.canvas.maskTool.resize(newWidth, newHeight);
        this.canvas.canvas.width = newWidth;
        this.canvas.canvas.height = newHeight;
        // Reset extensions
        this.canvas.outputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        this.canvas.outputAreaExtensionEnabled = false;
        this.canvas.lastOutputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        // Update original canvas size and position
        this.canvas.originalCanvasSize = { width: newWidth, height: newHeight };
        this.canvas.originalOutputAreaPosition = { x: minX, y: minY };
        // Save state and render
        this.canvas.render();
        this.canvas.saveState();
        log.info(`Auto-adjusted output area to fit ${selectedLayers.length} selected layer(s)`, {
            bounds: { x: minX, y: minY, width: newWidth, height: newHeight }
        });
        return true;
    }
    pasteLayers() {
        if (this.internalClipboard.length === 0)
            return;
        this.canvas.saveState();
        const newLayers = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.internalClipboard.forEach((layer) => {
            minX = Math.min(minX, layer.x);
            minY = Math.min(minY, layer.y);
            maxX = Math.max(maxX, layer.x + layer.width);
            maxY = Math.max(maxY, layer.y + layer.height);
        });
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const { x: mouseX, y: mouseY } = this.canvas.lastMousePosition;
        const offsetX = mouseX - centerX;
        const offsetY = mouseY - centerY;
        // Find the highest zIndex among existing layers
        const maxZIndex = this.canvas.layers.length > 0
            ? Math.max(...this.canvas.layers.map(l => l.zIndex))
            : -1;
        this.internalClipboard.forEach((clipboardLayer, index) => {
            const newLayer = {
                ...clipboardLayer,
                x: clipboardLayer.x + offsetX,
                y: clipboardLayer.y + offsetY,
                zIndex: maxZIndex + 1 + index // Ensure pasted layers maintain their relative order
            };
            this.canvas.layers.push(newLayer);
            newLayers.push(newLayer);
        });
        this.canvas.updateSelection(newLayers);
        this.canvas.render();
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }
        log.info(`Pasted ${newLayers.length} layer(s) at mouse position (${mouseX}, ${mouseY}).`);
    }
    async handlePaste(addMode = 'mouse') {
        try {
            log.info(`Paste operation started with preference: ${this.clipboardPreference}`);
            await this.clipboardManager.handlePaste(addMode, this.clipboardPreference);
        }
        catch (err) {
            log.error("Paste operation failed:", err);
        }
    }
    async addLayer(image) {
        return this.addLayerWithImage(image);
    }
    moveLayers(layersToMove, options = {}) {
        if (!layersToMove || layersToMove.length === 0)
            return;
        let finalLayers;
        if (options.direction) {
            const allLayers = [...this.canvas.layers];
            const selectedIndices = new Set(layersToMove.map((l) => allLayers.indexOf(l)));
            if (options.direction === 'up') {
                const sorted = Array.from(selectedIndices).sort((a, b) => b - a);
                sorted.forEach((index) => {
                    const targetIndex = index + 1;
                    if (targetIndex < allLayers.length && !selectedIndices.has(targetIndex)) {
                        [allLayers[index], allLayers[targetIndex]] = [allLayers[targetIndex], allLayers[index]];
                    }
                });
            }
            else if (options.direction === 'down') {
                const sorted = Array.from(selectedIndices).sort((a, b) => a - b);
                sorted.forEach((index) => {
                    const targetIndex = index - 1;
                    if (targetIndex >= 0 && !selectedIndices.has(targetIndex)) {
                        [allLayers[index], allLayers[targetIndex]] = [allLayers[targetIndex], allLayers[index]];
                    }
                });
            }
            finalLayers = allLayers;
        }
        else if (options.toIndex !== undefined) {
            const displayedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);
            const reorderedFinal = [];
            let inserted = false;
            for (let i = 0; i < displayedLayers.length; i++) {
                if (i === options.toIndex) {
                    reorderedFinal.push(...layersToMove);
                    inserted = true;
                }
                const currentLayer = displayedLayers[i];
                if (!layersToMove.includes(currentLayer)) {
                    reorderedFinal.push(currentLayer);
                }
            }
            if (!inserted) {
                reorderedFinal.push(...layersToMove);
            }
            finalLayers = reorderedFinal;
        }
        else {
            log.warn("Invalid options for moveLayers", options);
            return;
        }
        const totalLayers = finalLayers.length;
        finalLayers.forEach((layer, index) => {
            const zIndex = (options.toIndex !== undefined) ? (totalLayers - 1 - index) : index;
            layer.zIndex = zIndex;
        });
        this.canvas.layers = finalLayers;
        this.canvas.layers.sort((a, b) => a.zIndex - b.zIndex);
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }
        this.canvas.render();
        this.canvas.requestSaveState();
        log.info(`Moved ${layersToMove.length} layer(s).`);
    }
    moveLayerUp() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.moveLayers(this.canvas.canvasSelection.selectedLayers, { direction: 'up' });
    }
    moveLayerDown() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.moveLayers(this.canvas.canvasSelection.selectedLayers, { direction: 'down' });
    }
    resizeLayer(scale) {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            layer.width *= scale;
            layer.height *= scale;
            // Invalidate processed image cache when layer dimensions change
            this.invalidateProcessedImageCache(layer.id);
            // Handle wheel scaling end for layers with blend area
            this.handleWheelScalingEnd(layer);
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }
    rotateLayer(angle) {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            layer.rotation += angle;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }
    getLayerAtPosition(worldX, worldY) {
        // Always sort by zIndex so topmost is checked first
        this.canvas.layers.sort((a, b) => a.zIndex - b.zIndex);
        for (let i = this.canvas.layers.length - 1; i >= 0; i--) {
            const layer = this.canvas.layers[i];
            // Skip invisible layers
            if (!layer.visible)
                continue;
            const localPoint = worldToLayerLocal(worldX, worldY, layer);
            if (isPointInLayerLocalBounds(localPoint, layer.width, layer.height)) {
                return {
                    layer: layer,
                    localX: localPoint.x + layer.width / 2,
                    localY: localPoint.y + layer.height / 2
                };
            }
        }
        return null;
    }
    _drawLayer(ctx, layer, options = {}) {
        if (!layer.image)
            return;
        const { offsetX = 0, offsetY = 0 } = options;
        ctx.save();
        const centerX = layer.x + layer.width / 2 - offsetX;
        const centerY = layer.y + layer.height / 2 - offsetY;
        ctx.translate(centerX, centerY);
        ctx.rotate(layer.rotation * Math.PI / 180);
        const scaleH = layer.flipH ? -1 : 1;
        const scaleV = layer.flipV ? -1 : 1;
        if (layer.flipH || layer.flipV) {
            ctx.scale(scaleH, scaleV);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;
        const interactionMode = this.canvas.canvasInteractions?.interaction?.mode;
        const isDraggingLayers = interactionMode === 'dragging';
        // Check if we should render blend area live only in specific cases:
        // 1. When user is actively resizing in crop mode (transforming crop bounds) - only for the specific layer being transformed
        // 2. When user is actively resizing in transform mode (scaling layer) - only for the specific layer being transformed
        // 3. When blend area slider is being adjusted - only for the layer that has the menu open
        // 4. When layer is in the transforming crop bounds set (continues live rendering until cache is ready)
        // 5. When layer is in the transforming scale set (continues live rendering until cache is ready)
        const isTransformingCropBounds = this.canvas.canvasInteractions?.interaction?.mode === 'resizing' &&
            this.canvas.canvasInteractions?.interaction?.transformingLayer?.id === layer.id &&
            layer.cropMode;
        // Check if user is actively scaling this layer in transform mode (not crop mode)
        const isTransformingScale = this.canvas.canvasInteractions?.interaction?.mode === 'resizing' &&
            this.canvas.canvasInteractions?.interaction?.transformingLayer?.id === layer.id &&
            !layer.cropMode;
        // Check if this specific layer is the one being adjusted in blend area slider
        const isThisLayerBeingAdjusted = this.layersAdjustingBlendArea.has(layer.id);
        // Check if this layer is in the transforming crop bounds set (continues live rendering until cache is ready)
        const isTransformingCropBoundsSet = this.layersTransformingCropBounds.has(layer.id);
        // Check if this layer is in the transforming scale set (continues live rendering until cache is ready)
        const isTransformingScaleSet = this.layersTransformingScale.has(layer.id);
        // Check if this layer is being scaled by wheel or buttons (continues live rendering until cache is ready)
        const isWheelScaling = this.layersWheelScaling.has(layer.id);
        const shouldRenderLive = !isDraggingLayers && (isTransformingCropBounds || isTransformingScale || isThisLayerBeingAdjusted || isTransformingCropBoundsSet || isTransformingScaleSet || isWheelScaling);
        const deferProcessedImage = isDraggingLayers || isTransformingCropBounds || isTransformingScale || isTransformingCropBoundsSet || isTransformingScaleSet || isWheelScaling;
        // Check if we should use cached processed image or render live
        const processedImage = this.getProcessedImage(layer, {
            // Resize/crop changes create a new cache key every frame. Do not
            // enqueue intermediate full-resolution builds; the transform-end
            // path will request the final state once.
            cacheOnly: deferProcessedImage,
            allowCacheWhileAdjusting: isDraggingLayers,
            allowStaleCacheWhileDragging: isDraggingLayers,
        });
        // For scaling operations, try to find the BEST matching cache for this layer
        let bestMatchingCache = null;
        if (isTransformingScale || isTransformingScaleSet || isWheelScaling) {
            // Look for cache entries that match the current layer state as closely as possible
            const currentCacheKey = this.getProcessedImageCacheKey(layer);
            const currentBlendArea = layer.blendArea ?? 0;
            const currentCropKey = layer.cropBounds ?
                `${layer.cropBounds.x},${layer.cropBounds.y},${layer.cropBounds.width},${layer.cropBounds.height}` :
                'nocrop';
            // Score each cache entry to find the best match
            let bestScore = -1;
            for (const [key, image] of this.processedImageCache.entries()) {
                if (key.startsWith(layer.id + '_')) {
                    let score = 0;
                    // Extract blend area and crop info from cache key
                    const keyParts = key.split('_');
                    if (keyParts.length >= 3) {
                        const cacheBlendArea = parseInt(keyParts[1]);
                        const cacheCropKey = keyParts[2];
                        // Score based on blend area match (higher priority)
                        if (cacheBlendArea === currentBlendArea) {
                            score += 100;
                        }
                        else {
                            score -= Math.abs(cacheBlendArea - currentBlendArea);
                        }
                        // Score based on crop match (high priority)
                        if (cacheCropKey === currentCropKey) {
                            score += 200;
                        }
                        else {
                            // Penalize mismatched crop states heavily
                            score -= 150;
                        }
                        // Small bonus for exact match
                        if (key === currentCacheKey) {
                            score += 50;
                        }
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatchingCache = image;
                        log.debug(`Better cache found for layer ${layer.id}: ${key} (score: ${score})`);
                    }
                }
            }
            if (bestMatchingCache) {
                log.debug(`Using best matching cache for layer ${layer.id} during scaling`);
            }
        }
        if (processedImage && !shouldRenderLive) {
            // Use cached processed image for all cases except specific live rendering scenarios
            ctx.globalCompositeOperation = layer.blendMode || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(processedImage, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        }
        else if (bestMatchingCache && (isTransformingScale || isTransformingScaleSet || isWheelScaling)) {
            // During scaling operations: use the BEST matching processed image (more efficient)
            // This ensures we always use the most appropriate blend area image during scaling
            ctx.globalCompositeOperation = layer.blendMode || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(bestMatchingCache, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        }
        else if (needsBlendAreaEffect && shouldRenderLive && !isWheelScaling) {
            // Render blend area live only when transforming crop bounds or adjusting blend area slider
            // BUT NOT during wheel scaling - that should use cached image
            this._drawLayerWithLiveBlendArea(ctx, layer);
        }
        else {
            // Normal drawing without blend area effect
            this._drawLayerImage(ctx, layer);
        }
        ctx.restore();
    }
    /**
     * Zunifikowana funkcja do rysowania obrazu warstwy z crop
     * @param ctx Canvas context
     * @param layer Warstwa do narysowania
     * @param offsetX Przesunięcie X względem środka warstwy (domyślnie -width/2)
     * @param offsetY Przesunięcie Y względem środka warstwy (domyślnie -height/2)
     */
    drawLayerImageWithCrop(ctx, layer, offsetX = -layer.width / 2, offsetY = -layer.height / 2) {
        // Use cropBounds if they exist, otherwise use the full image dimensions as the source
        const s = layer.cropBounds || { x: 0, y: 0, width: layer.originalWidth, height: layer.originalHeight };
        if (!layer.originalWidth || !layer.originalHeight) {
            // Fallback for older layers without original dimensions or if data is missing
            ctx.drawImage(layer.image, offsetX, offsetY, layer.width, layer.height);
            return;
        }
        // Calculate the on-screen scale of the layer's transform frame
        const layerScaleX = layer.width / layer.originalWidth;
        const layerScaleY = layer.height / layer.originalHeight;
        // Calculate the on-screen size of the cropped portion
        const dWidth = s.width * layerScaleX;
        const dHeight = s.height * layerScaleY;
        // Calculate the on-screen position of the top-left of the cropped portion
        const dX = offsetX + (s.x * layerScaleX);
        const dY = offsetY + (s.y * layerScaleY);
        ctx.drawImage(layer.image, s.x, s.y, s.width, s.height, // source rect (from original image)
        dX, dY, dWidth, dHeight // destination rect (scaled and positioned)
        );
    }
    _drawLayerImage(ctx, layer) {
        ctx.globalCompositeOperation = layer.blendMode || 'normal';
        ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
        this.drawLayerImageWithCrop(ctx, layer);
    }
    getOrCreateCropCanvas(image, cropBounds) {
        const cacheKey = `${cropBounds.x},${cropBounds.y},${cropBounds.width},${cropBounds.height}`;
        let imageCache = this.cropCanvasCache.get(image);
        if (!imageCache) {
            imageCache = new Map();
            this.cropCanvasCache.set(image, imageCache);
        }
        const cachedCanvas = imageCache.get(cacheKey);
        if (cachedCanvas) {
            // Promote the entry so the small cache behaves as an LRU cache.
            imageCache.delete(cacheKey);
            imageCache.set(cacheKey, cachedCanvas);
            return cachedCanvas;
        }
        const { canvas, ctx } = createCanvas(cropBounds.width, cropBounds.height);
        if (!ctx)
            return null;
        ctx.drawImage(image, cropBounds.x, cropBounds.y, cropBounds.width, cropBounds.height, 0, 0, cropBounds.width, cropBounds.height);
        imageCache.set(cacheKey, canvas);
        while (imageCache.size > this.MAX_CROP_CANVAS_CACHE_ENTRIES) {
            const oldestKey = imageCache.keys().next().value;
            if (oldestKey === undefined)
                break;
            const oldestCanvas = imageCache.get(oldestKey);
            imageCache.delete(oldestKey);
            if (oldestCanvas) {
                this._canvasMaskCache.delete(oldestCanvas);
            }
        }
        return canvas;
    }
    /**
     * Zunifikowana funkcja do tworzenia maski blend area dla warstwy
     * @param layer Warstwa dla której tworzymy maskę
     * @returns Obiekt zawierający maskę i jej wymiary lub null
     */
    createBlendAreaMask(layer) {
        const blendArea = layer.blendArea ?? 0;
        if (layer.cropBounds && layer.originalWidth && layer.originalHeight) {
            const s = layer.cropBounds;
            const cropCanvas = this.getOrCreateCropCanvas(layer.image, s);
            if (cropCanvas) {
                // Generate distance field mask for the cropped region
                const maskCanvas = this.getDistanceFieldMaskSync(cropCanvas, blendArea);
                if (maskCanvas) {
                    return {
                        maskCanvas,
                        maskWidth: s.width,
                        maskHeight: s.height
                    };
                }
            }
        }
        else {
            // No crop, use full image
            const maskCanvas = this.getDistanceFieldMaskSync(layer.image, blendArea);
            if (maskCanvas) {
                return {
                    maskCanvas,
                    maskWidth: layer.originalWidth || layer.width,
                    maskHeight: layer.originalHeight || layer.height
                };
            }
        }
        return null;
    }
    /**
     * Zunifikowana funkcja do rysowania warstwy z blend area na canvas
     * @param ctx Canvas context
     * @param layer Warstwa do narysowania
     * @param offsetX Przesunięcie X (domyślnie -width/2)
     * @param offsetY Przesunięcie Y (domyślnie -height/2)
     */
    drawLayerWithBlendArea(ctx, layer, offsetX = -layer.width / 2, offsetY = -layer.height / 2) {
        const maskInfo = this.createBlendAreaMask(layer);
        if (maskInfo) {
            const { maskCanvas, maskWidth, maskHeight } = maskInfo;
            const s = layer.cropBounds || { x: 0, y: 0, width: layer.originalWidth, height: layer.originalHeight };
            if (!layer.originalWidth || !layer.originalHeight) {
                // Fallback - just draw the image normally
                ctx.drawImage(layer.image, offsetX, offsetY, layer.width, layer.height);
            }
            else {
                const layerScaleX = layer.width / layer.originalWidth;
                const layerScaleY = layer.height / layer.originalHeight;
                const dWidth = s.width * layerScaleX;
                const dHeight = s.height * layerScaleY;
                const dX = offsetX + (s.x * layerScaleX);
                const dY = offsetY + (s.y * layerScaleY);
                // Draw the image
                ctx.drawImage(layer.image, s.x, s.y, s.width, s.height, dX, dY, dWidth, dHeight);
                // Apply the distance field mask
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(maskCanvas, 0, 0, maskWidth, maskHeight, dX, dY, dWidth, dHeight);
            }
        }
        else {
            // Fallback - just draw the image normally
            this.drawLayerImageWithCrop(ctx, layer, offsetX, offsetY);
        }
    }
    /**
     * Draw layer with live blend area effect during user activity (original behavior)
     */
    _drawLayerWithLiveBlendArea(ctx, layer) {
        const targetWidth = Math.max(1, Math.ceil(layer.width));
        const targetHeight = Math.max(1, Math.ceil(layer.height));
        if (!this.liveBlendCanvas || !this.liveBlendCtx) {
            const surface = createCanvas(targetWidth, targetHeight);
            this.liveBlendCanvas = surface.canvas;
            this.liveBlendCtx = surface.ctx;
            this.liveBlendCanvasWidth = targetWidth;
            this.liveBlendCanvasHeight = targetHeight;
        }
        else if (targetWidth > this.liveBlendCanvasWidth || targetHeight > this.liveBlendCanvasHeight) {
            // Grow only when needed. Shrinking the canvas would force a new
            // backing store during every interactive scale step.
            this.liveBlendCanvasWidth = Math.max(this.liveBlendCanvasWidth, targetWidth);
            this.liveBlendCanvasHeight = Math.max(this.liveBlendCanvasHeight, targetHeight);
            this.liveBlendCanvas.width = this.liveBlendCanvasWidth;
            this.liveBlendCanvas.height = this.liveBlendCanvasHeight;
        }
        const tempCtx = this.liveBlendCtx;
        if (!tempCtx) {
            this._drawLayerImage(ctx, layer);
            return;
        }
        // Reset state left by destination-in and clear only the area used by
        // this layer. The reusable canvas may be larger than the current one.
        tempCtx.setTransform(1, 0, 0, 1, 0, 0);
        tempCtx.globalCompositeOperation = 'source-over';
        tempCtx.globalAlpha = 1;
        tempCtx.clearRect(0, 0, targetWidth, targetHeight);
        // Draw the layer with blend area to the reusable surface.
        this.drawLayerWithBlendArea(tempCtx, layer, 0, 0);
        // Draw only the current surface region with blend mode and opacity.
        ctx.globalCompositeOperation = layer.blendMode || 'normal';
        ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
        ctx.drawImage(this.liveBlendCanvas, 0, 0, targetWidth, targetHeight, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
    }
    /**
     * Generate a cache key for processed images based on layer properties
     */
    getProcessedImageGeometryKey(layer) {
        const cropKey = layer.cropBounds ?
            `${layer.cropBounds.x},${layer.cropBounds.y},${layer.cropBounds.width},${layer.cropBounds.height}` :
            'nocrop';
        // Blend Area changes alter pixels, but not the image layout. Keeping
        // that value out of this compatibility key lets the last valid mask
        // remain visible while a new blend-area cache is being built.
        return `${cropKey}_${layer.width}_${layer.height}`;
    }
    getProcessedImageCacheKey(layer) {
        return `${layer.id}_${this.getProcessedImageGeometryKey(layer)}`;
    }
    isUserInteractionActive() {
        const mode = this.canvas.canvasInteractions?.interaction?.mode;
        return mode !== undefined && mode !== 'none';
    }
    isLatestProcessedImageKey(layerId, cacheKey) {
        return this.latestProcessedImageKeys.get(layerId) === cacheKey;
    }
    isProcessedImageReferenced(image) {
        for (const cachedImage of this.processedImageCache.values()) {
            if (cachedImage === image)
                return true;
        }
        for (const fallback of this.lastProcessedImageFallbacks.values()) {
            if (fallback.image === image)
                return true;
        }
        return false;
    }
    releaseProcessedImageIfUnreferenced(image) {
        if (!image || this.isProcessedImageReferenced(image))
            return;
        this.releaseProcessedImage(image);
    }
    rememberProcessedImageFallback(layerId, cacheKey, image) {
        const metadata = this.processedImageMetadata.get(cacheKey);
        if (!metadata)
            return;
        const previousFallback = this.lastProcessedImageFallbacks.get(layerId);
        if (previousFallback?.image === image) {
            this.lastProcessedImageFallbacks.set(layerId, {
                cacheKey,
                image,
                sourceImage: metadata.sourceImage,
                geometryKey: metadata.geometryKey
            });
            return;
        }
        this.lastProcessedImageFallbacks.delete(layerId);
        this.releaseProcessedImageIfUnreferenced(previousFallback?.image);
        this.lastProcessedImageFallbacks.set(layerId, {
            cacheKey,
            image,
            sourceImage: metadata.sourceImage,
            geometryKey: metadata.geometryKey
        });
    }
    setLatestProcessedImageKey(layer, cacheKey) {
        const layerId = layer.id;
        this.latestProcessedImageKeys.set(layerId, cacheKey);
        // Keep only the newest pending timer and processed bitmap for this
        // layer. In-flight promises cannot be cancelled, so their result is
        // discarded by buildProcessedImage when it becomes stale.
        for (const [pendingKey, timer] of this.processedImageBuildTimers.entries()) {
            if (pendingKey.startsWith(`${layerId}_`) && pendingKey !== cacheKey) {
                clearTimeout(timer);
                this.processedImageBuildTimers.delete(pendingKey);
            }
        }
        for (const cachedKey of this.processedImageCache.keys()) {
            if (cachedKey.startsWith(`${layerId}_`) && cachedKey !== cacheKey) {
                const cachedImage = this.processedImageCache.get(cachedKey);
                this.processedImageCache.delete(cachedKey);
                if (cachedImage) {
                    this.rememberProcessedImageFallback(layerId, cachedKey, cachedImage);
                }
                this.processedImageMetadata.delete(cachedKey);
                this.releaseProcessedImageIfUnreferenced(cachedImage);
            }
        }
    }
    /**
     * Get processed image with all effects applied (blend area, crop, etc.)
     * Uses live rendering for layers being actively adjusted, debounced processing for others
     */
    getProcessedImage(layer, options = {}) {
        const { cacheOnly = false, allowCacheWhileAdjusting = false, allowStaleCacheWhileDragging = false } = options;
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;
        const needsCropEffect = layer.cropBounds && layer.originalWidth && layer.originalHeight;
        // If no effects needed, return null to use normal drawing
        if (!needsBlendAreaEffect && !needsCropEffect) {
            return null;
        }
        // If this layer is being actively adjusted (blend area slider), don't use cache
        if (this.layersAdjustingBlendArea.has(layer.id) && !allowCacheWhileAdjusting) {
            return null; // Force live rendering
        }
        // If this layer is being scaled (wheel/buttons), don't schedule new cache creation
        if (this.layersWheelScaling.has(layer.id)) {
            const cacheKey = this.getProcessedImageCacheKey(layer);
            // Only return existing cache, don't create new one
            if (this.processedImageCache.has(cacheKey)) {
                log.debug(`Using cached processed image for layer ${layer.id} during wheel scaling`);
                return this.processedImageCache.get(cacheKey) || null;
            }
            // No cache available and we're scaling - return null to use normal drawing
            return null;
        }
        const cacheKey = this.getProcessedImageCacheKey(layer);
        // Check if we have cached processed image
        if (this.processedImageCache.has(cacheKey)) {
            log.debug(`Using cached processed image for layer ${layer.id}`);
            return this.processedImageCache.get(cacheKey) || null;
        }
        if (cacheOnly && allowStaleCacheWhileDragging) {
            const fallback = this.lastProcessedImageFallbacks.get(layer.id);
            if (fallback &&
                fallback.sourceImage === layer.image &&
                fallback.geometryKey === this.getProcessedImageGeometryKey(layer)) {
                log.debug(`Using last valid processed image for layer ${layer.id} while cache is rebuilding`);
                return fallback.image;
            }
        }
        // During a layer drag, never start full-resolution blend processing
        // from the render loop. Use the source image until a cache is ready;
        // the interaction-end path will schedule the processed cache later.
        if (cacheOnly) {
            return null;
        }
        // Use debounced processing - schedule creation but don't create immediately
        this.scheduleProcessedImageCreation(layer, cacheKey);
        return null; // Use original image for now until processed image is ready
    }
    /**
     * Schedule processed image creation after debounce delay
     */
    scheduleProcessedImageCreation(layer, cacheKey) {
        this.setLatestProcessedImageKey(layer, cacheKey);
        // A render can request the same missing cache many times. Keep one
        // timer/build per cache key instead of resetting the delay each frame.
        if (this.processedImageCache.has(cacheKey) ||
            this.processedImageBuildTimers.has(cacheKey) ||
            this.processedImageBuilds.has(cacheKey)) {
            return;
        }
        // Schedule new timer
        const timer = window.setTimeout(() => {
            this.processedImageBuildTimers.delete(cacheKey);
            if (!this.isLatestProcessedImageKey(layer.id, cacheKey)) {
                return;
            }
            // Distance-field generation is synchronous and can block for a
            // large image. Never start it while pointer/key interaction is in
            // progress; retry after the interaction has been idle.
            if (this.isUserInteractionActive()) {
                this.scheduleProcessedImageCreation(layer, cacheKey);
                return;
            }
            void this.buildProcessedImage(layer, cacheKey, 'debounced processed image');
        }, this.PROCESSED_IMAGE_DEBOUNCE_DELAY);
        this.processedImageBuildTimers.set(cacheKey, timer);
    }
    /**
     * Queue full-resolution processed images after a layer drag has finished.
     * Drag rendering is intentionally cache-only; this is the hand-off point
     * that restores the final Blend Area/crop result without doing the work
     * on every pointer frame.
     */
    handleLayerDragEnd(layers) {
        for (const layer of layers) {
            if (!layer.image)
                continue;
            const hasBlendArea = (layer.blendArea ?? 0) > 0;
            const hasCropEffect = Boolean(layer.cropBounds && layer.originalWidth && layer.originalHeight);
            if (!hasBlendArea && !hasCropEffect)
                continue;
            const cacheKey = this.getProcessedImageCacheKey(layer);
            if (!this.processedImageCache.has(cacheKey)) {
                this.scheduleProcessedImageCreation(layer, cacheKey);
            }
        }
    }
    /**
     * Update last render time to track activity for debouncing
     */
    updateLastRenderTime() {
        this.lastRenderTime = Date.now();
        log.debug(`Updated last render time for debouncing: ${this.lastRenderTime}`);
    }
    /**
     * Process all pending images immediately when user stops interacting
     */
    async processPendingImages() {
        // Clear all pending processed-image timers and process them immediately.
        const pendingKeys = [...this.processedImageBuildTimers.keys()];
        for (const cacheKey of pendingKeys) {
            const timer = this.processedImageBuildTimers.get(cacheKey);
            if (timer === undefined)
                continue;
            clearTimeout(timer);
            this.processedImageBuildTimers.delete(cacheKey);
            const layer = this.canvas.layers.find(l => this.getProcessedImageCacheKey(l) === cacheKey);
            if (layer) {
                await this.buildProcessedImage(layer, cacheKey, 'pending processed image');
            }
        }
        if (pendingKeys.length > 0) {
            this.canvas.render();
        }
    }
    /**
     * Create a new processed image with all effects applied
     */
    async createProcessedImage(layer) {
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;
        // Create a canvas for the processed image
        const { canvas: processedCanvas, ctx: processedCtx } = createCanvas(layer.width, layer.height);
        if (!processedCtx)
            return null;
        if (needsBlendAreaEffect) {
            // Use the unified blend area drawing function
            this.drawLayerWithBlendArea(processedCtx, layer, 0, 0);
        }
        else {
            // Just apply crop effect without blend area
            this.drawLayerImageWithCrop(processedCtx, layer, 0, 0);
        }
        // Keep the processed pixels in a browser-native bitmap. This avoids
        // encoding to PNG and decoding a Base64 data URL on the interaction
        // path. The fallback preserves compatibility with older browsers.
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(processedCanvas);
            }
            catch (error) {
                log.debug('ImageBitmap cache creation failed, using image fallback.', error);
            }
        }
        // Convert canvas to image as a compatibility fallback.
        const processedImage = new Image();
        processedImage.crossOrigin = 'anonymous';
        processedImage.src = processedCanvas.toDataURL();
        return processedImage;
    }
    buildProcessedImage(layer, cacheKey, operationName) {
        const latestKey = this.latestProcessedImageKeys.get(layer.id);
        if (latestKey && latestKey !== cacheKey) {
            return Promise.resolve(false);
        }
        this.setLatestProcessedImageKey(layer, cacheKey);
        if (this.processedImageCache.has(cacheKey)) {
            return Promise.resolve(true);
        }
        const existingBuild = this.processedImageBuilds.get(cacheKey);
        if (existingBuild) {
            return existingBuild;
        }
        const build = (async () => {
            try {
                log.info(`Creating ${operationName} for layer ${layer.id}`);
                const processedImage = await this.createProcessedImage(layer);
                if (!processedImage)
                    return false;
                // The layer may have changed while the async bitmap was
                // being created. Do not retain or display a stale result.
                if (!this.isLatestProcessedImageKey(layer.id, cacheKey)) {
                    this.releaseProcessedImage(processedImage);
                    return false;
                }
                this.setProcessedImageCache(layer, cacheKey, processedImage);
                log.debug(`Cached ${operationName} for layer ${layer.id}`);
                this.canvas.render();
                return true;
            }
            catch (error) {
                log.error(`Failed to create ${operationName}:`, error);
                return false;
            }
        })();
        this.processedImageBuilds.set(cacheKey, build);
        void build.then(() => {
            if (this.processedImageBuilds.get(cacheKey) === build) {
                this.processedImageBuilds.delete(cacheKey);
            }
        }, () => {
            if (this.processedImageBuilds.get(cacheKey) === build) {
                this.processedImageBuilds.delete(cacheKey);
            }
        });
        return build;
    }
    /**
     * Helper method to draw layer image to a specific canvas context (position 0,0)
     * Uses the unified drawLayerImageWithCrop function
     */
    _drawLayerImageToCanvas(ctx, layer) {
        this.drawLayerImageWithCrop(ctx, layer, 0, 0);
    }
    releaseProcessedImage(image) {
        if (!image || typeof image !== 'object')
            return;
        const closableImage = image;
        if (typeof closableImage.close === 'function') {
            closableImage.close();
        }
    }
    setProcessedImageCache(layer, key, image) {
        const previousImage = this.processedImageCache.get(key);
        if (previousImage && previousImage !== image) {
            this.processedImageCache.delete(key);
            this.processedImageMetadata.delete(key);
            this.releaseProcessedImageIfUnreferenced(previousImage);
        }
        this.processedImageCache.set(key, image);
        this.processedImageMetadata.set(key, {
            sourceImage: layer.image,
            geometryKey: this.getProcessedImageGeometryKey(layer)
        });
        this.rememberProcessedImageFallback(layer.id, key, image);
    }
    /**
     * Invalidate processed image cache for a specific layer
     */
    invalidateProcessedImageCache(layerId) {
        this.latestProcessedImageKeys.delete(layerId);
        const keysToDelete = [];
        for (const key of this.processedImageCache.keys()) {
            if (key.startsWith(`${layerId}_`)) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => {
            const cachedImage = this.processedImageCache.get(key);
            this.processedImageCache.delete(key);
            if (cachedImage) {
                this.rememberProcessedImageFallback(layerId, key, cachedImage);
            }
            this.processedImageMetadata.delete(key);
            this.releaseProcessedImageIfUnreferenced(cachedImage);
            log.debug(`Invalidated processed image cache for key: ${key}`);
        });
        // Also clear pending processed-image and transform timers for this layer.
        for (const [cacheKey, timer] of this.processedImageBuildTimers.entries()) {
            if (cacheKey.startsWith(`${layerId}_`)) {
                clearTimeout(timer);
                this.processedImageBuildTimers.delete(cacheKey);
                log.debug(`Cleared pending processed-image timer for layer ${layerId}`);
            }
        }
        for (const [timerKey, timer] of this.processedImageDebounceTimers.entries()) {
            if (timerKey === layerId || timerKey.startsWith(`${layerId}_`)) {
                clearTimeout(timer);
                this.processedImageDebounceTimers.delete(timerKey);
                log.debug(`Cleared pending transform timer for layer ${layerId}`);
            }
        }
    }
    /**
     * Clear all processed image cache
     */
    clearProcessedImageCache() {
        this.latestProcessedImageKeys.clear();
        const images = new Set([
            ...this.processedImageCache.values(),
            ...Array.from(this.lastProcessedImageFallbacks.values(), fallback => fallback.image)
        ]);
        this.processedImageCache.clear();
        this.processedImageMetadata.clear();
        this.lastProcessedImageFallbacks.clear();
        for (const image of images) {
            this.releaseProcessedImage(image);
        }
        for (const timer of this.processedImageBuildTimers.values()) {
            clearTimeout(timer);
        }
        this.processedImageBuildTimers.clear();
        // Clear all pending timers
        for (const timer of this.processedImageDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this.processedImageDebounceTimers.clear();
        log.info('Cleared all processed image cache and pending timers');
    }
    /**
     * Zunifikowana funkcja do obsługi transformacji końcowych
     * @param layer Warstwa do przetworzenia
     * @param transformType Typ transformacji (crop, scale, wheel)
     * @param delay Opóźnienie w ms (domyślnie 0)
     */
    handleTransformEnd(layer, transformType, delay = 0) {
        if (!layer.blendArea)
            return;
        const layerId = layer.id;
        const cacheKey = this.getProcessedImageCacheKey(layer);
        // Add to appropriate transforming set to continue live rendering
        let transformingSet;
        let transformName;
        switch (transformType) {
            case 'crop':
                transformingSet = this.layersTransformingCropBounds;
                transformName = 'crop bounds';
                break;
            case 'scale':
                transformingSet = this.layersTransformingScale;
                transformName = 'scale';
                break;
            case 'wheel':
                transformingSet = this.layersWheelScaling;
                transformName = 'wheel';
                break;
        }
        transformingSet.add(layerId);
        // Create processed image asynchronously with optional delay
        const executeTransform = async () => {
            const built = await this.buildProcessedImage(layer, cacheKey, `${transformName} transform`);
            // Fallback: remove from live rendering even if cache creation failed.
            transformingSet.delete(layerId);
            if (!built)
                this.canvas.render();
        };
        if (delay > 0) {
            // For wheel scaling, use debounced approach
            const timerKey = `${layerId}_${transformType}scaling`;
            const existingTimer = this.processedImageDebounceTimers.get(timerKey);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            const timer = window.setTimeout(() => {
                log.debug(`Creating new cache for layer ${layerId} after ${transformName} scaling stopped`);
                void executeTransform();
                this.processedImageDebounceTimers.delete(timerKey);
            }, delay);
            this.processedImageDebounceTimers.set(timerKey, timer);
        }
        else {
            // For crop and scale, use immediate async approach
            setTimeout(() => void executeTransform(), 0);
        }
    }
    /**
     * Handle end of crop bounds transformation - create cache asynchronously but keep live rendering until ready
     */
    handleCropBoundsTransformEnd(layer) {
        if (!layer.cropMode || !layer.blendArea)
            return;
        this.handleTransformEnd(layer, 'crop', 0);
    }
    /**
     * Handle end of scale transformation - create cache asynchronously but keep live rendering until ready
     */
    handleScaleTransformEnd(layer) {
        if (!layer.blendArea)
            return;
        this.handleTransformEnd(layer, 'scale', 0);
    }
    /**
     * Handle end of wheel/button scaling - use debounced cache creation
     */
    handleWheelScalingEnd(layer) {
        if (!layer.blendArea)
            return;
        this.handleTransformEnd(layer, 'wheel', 500);
    }
    getOrCreateDistanceFieldMask(imageOrCanvas, cache, blendArea, logSuffix = '') {
        let cacheEntry = cache.get(imageOrCanvas);
        if (!cacheEntry) {
            try {
                log.info(`Creating distance field data${logSuffix}`);
                const data = createDistanceFieldDataSync(imageOrCanvas);
                if (!data)
                    return null;
                cacheEntry = {
                    data,
                    lastBlendArea: null
                };
                cache.set(imageOrCanvas, cacheEntry);
            }
            catch (error) {
                log.error(`Failed to create distance field data${logSuffix}:`, error);
                return null;
            }
        }
        if (cacheEntry.lastBlendArea === blendArea) {
            log.info(`Using cached distance field mask for blendArea: ${blendArea}%${logSuffix}`);
            return cacheEntry.data.maskCanvas;
        }
        try {
            log.info(`Rasterizing distance field mask for blendArea: ${blendArea}%${logSuffix}`);
            const maskCanvas = rasterizeDistanceFieldMaskSync(cacheEntry.data, blendArea);
            cacheEntry.lastBlendArea = blendArea;
            return maskCanvas;
        }
        catch (error) {
            log.error(`Failed to rasterize distance field mask${logSuffix}:`, error);
            return null;
        }
    }
    getDistanceFieldMaskSync(imageOrCanvas, blendArea) {
        // Use WeakMaps so cached masks do not keep image/crop resources alive.
        if (imageOrCanvas instanceof HTMLCanvasElement) {
            if (!this._canvasMaskCache)
                this._canvasMaskCache = new WeakMap();
            return this.getOrCreateDistanceFieldMask(imageOrCanvas, this._canvasMaskCache, blendArea, ' (canvas)');
        }
        else {
            // For images, use the original WeakMap cache
            return this.getOrCreateDistanceFieldMask(imageOrCanvas, this.distanceFieldCache, blendArea);
        }
    }
    getDragSceneCacheKey(sortedLayers, selectedIds, viewport, width, height) {
        const selectedSignature = sortedLayers
            .filter(layer => selectedIds.has(layer.id))
            .map(layer => `${layer.id}:${layer.zIndex}`)
            .join(',');
        const staticSignature = sortedLayers
            .filter(layer => !selectedIds.has(layer.id))
            .map(layer => {
            const cropKey = layer.cropBounds ?
                `${layer.cropBounds.x},${layer.cropBounds.y},${layer.cropBounds.width},${layer.cropBounds.height}` :
                'nocrop';
            return [
                layer.id,
                layer.imageId,
                layer.zIndex,
                layer.visible ? 1 : 0,
                layer.x,
                layer.y,
                layer.width,
                layer.height,
                layer.rotation,
                layer.originalWidth,
                layer.originalHeight,
                layer.flipH ? 1 : 0,
                layer.flipV ? 1 : 0,
                layer.cropMode ? 1 : 0,
                layer.blendMode || 'normal',
                layer.opacity,
                layer.blendArea ?? 0,
                cropKey
            ].join(':');
        })
            .join('|');
        return `${width}x${height}|${viewport.x},${viewport.y},${viewport.zoom}|${selectedSignature}|${staticSignature}`;
    }
    isSourceOverBlendMode(layer) {
        return !layer.blendMode || layer.blendMode === 'normal' || layer.blendMode === 'source-over';
    }
    getDragCanvasBlendMode(layer) {
        return this.isSourceOverBlendMode(layer) ? 'source-over' : layer.blendMode;
    }
    drawLayerContentForDrag(ctx, layer, applyLayerOpacity) {
        if (!layer.image)
            return;
        ctx.save();
        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate(layer.rotation * Math.PI / 180);
        if (layer.flipH || layer.flipV) {
            ctx.scale(layer.flipH ? -1 : 1, layer.flipV ? -1 : 1);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = applyLayerOpacity ? (layer.opacity !== undefined ? layer.opacity : 1) : 1;
        const processedImage = this.getProcessedImage(layer, {
            cacheOnly: true,
            allowStaleCacheWhileDragging: true
        });
        if (processedImage) {
            ctx.drawImage(processedImage, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        }
        else if ((layer.blendArea ?? 0) > 0) {
            // Isolate the destination-in mask from earlier layers in the
            // source-over segment. The layer's blend mode is still deferred
            // to playback so it is evaluated against the real backdrop.
            const surface = createCanvas(Math.max(1, Math.ceil(layer.width)), Math.max(1, Math.ceil(layer.height)));
            if (surface.ctx) {
                surface.ctx.globalCompositeOperation = 'source-over';
                surface.ctx.globalAlpha = 1;
                this.drawLayerWithBlendArea(surface.ctx, layer, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = applyLayerOpacity ? (layer.opacity !== undefined ? layer.opacity : 1) : 1;
                ctx.drawImage(surface.canvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
            }
            else {
                this.drawLayerImageWithCrop(ctx, layer);
            }
        }
        else {
            this.drawLayerImageWithCrop(ctx, layer);
        }
        ctx.restore();
    }
    createDragStaticCanvas(segment, viewport, width, height) {
        const surface = createCanvas(width, height);
        if (!surface.ctx)
            return null;
        surface.ctx.save();
        surface.ctx.scale(viewport.zoom, viewport.zoom);
        surface.ctx.translate(-viewport.x, -viewport.y);
        for (const layer of segment.layers) {
            if (layer.visible) {
                this.drawLayerContentForDrag(surface.ctx, layer, segment.applyLayerOpacity);
            }
        }
        surface.ctx.restore();
        return surface.canvas;
    }
    createDragStaticSegments(layers) {
        const segments = [];
        let sourceOverLayers = [];
        const flushSourceOverLayers = () => {
            if (sourceOverLayers.length === 0)
                return;
            segments.push({
                layers: sourceOverLayers,
                canvas: null,
                blendMode: 'source-over',
                opacity: 1,
                applyLayerOpacity: true
            });
            sourceOverLayers = [];
        };
        for (const layer of layers) {
            if (this.isSourceOverBlendMode(layer)) {
                sourceOverLayers.push(layer);
                continue;
            }
            flushSourceOverLayers();
            segments.push({
                layers: [layer],
                canvas: null,
                blendMode: this.getDragCanvasBlendMode(layer),
                opacity: layer.opacity !== undefined ? layer.opacity : 1,
                // The non-source-over operation must be replayed against the
                // actual backdrop, so opacity is applied during playback too.
                applyLayerOpacity: false
            });
        }
        flushSourceOverLayers();
        return segments;
    }
    buildDragSceneCache(sortedLayers, selectedIds, selectedLayers, key, viewport, width, height) {
        const parts = [];
        let staticLayers = [];
        let currentPart = {
            staticSegments: [],
            dynamicLayers: []
        };
        const flushStaticLayers = () => {
            if (staticLayers.length === 0)
                return;
            currentPart.staticSegments.push(...this.createDragStaticSegments(staticLayers));
            staticLayers = [];
        };
        for (const layer of sortedLayers) {
            if (selectedIds.has(layer.id)) {
                flushStaticLayers();
                currentPart.dynamicLayers.push(layer);
                parts.push(currentPart);
                currentPart = {
                    staticSegments: [],
                    dynamicLayers: []
                };
            }
            else {
                staticLayers.push(layer);
            }
        }
        flushStaticLayers();
        parts.push(currentPart);
        for (const part of parts) {
            for (const segment of part.staticSegments) {
                segment.canvas = this.createDragStaticCanvas(segment, viewport, width, height);
                if (!segment.canvas)
                    return null;
            }
        }
        const cachedStaticLayers = sortedLayers.filter(layer => !selectedIds.has(layer.id));
        return {
            key,
            staticLayers: cachedStaticLayers,
            staticImages: cachedStaticLayers.map(layer => layer.image),
            selectedLayers: [...selectedLayers],
            parts
        };
    }
    drawDragStaticSegment(ctx, segment) {
        if (!segment.canvas)
            return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = segment.blendMode;
        ctx.globalAlpha = segment.opacity;
        ctx.drawImage(segment.canvas, 0, 0);
        ctx.restore();
    }
    clearDragSceneCache() {
        if (!this.dragSceneCache)
            return;
        for (const part of this.dragSceneCache.parts) {
            for (const segment of part.staticSegments) {
                if (segment.canvas) {
                    segment.canvas.width = 0;
                    segment.canvas.height = 0;
                }
            }
        }
        this.dragSceneCache = null;
    }
    drawLayersDuringDrag(ctx, layers, selectedLayers, viewport, width, height) {
        if (selectedLayers.length === 0) {
            this._drawLayers(ctx, layers);
            return;
        }
        const sortedLayers = this.getRenderOrder(layers);
        const selectedIds = new Set(selectedLayers.map(layer => layer.id));
        const key = this.getDragSceneCacheKey(sortedLayers, selectedIds, viewport, width, height);
        const staticLayers = sortedLayers.filter(layer => !selectedIds.has(layer.id));
        const selectedReferencesChanged = !this.dragSceneCache ||
            this.dragSceneCache.selectedLayers.length !== selectedLayers.length ||
            selectedLayers.some((layer, index) => this.dragSceneCache?.selectedLayers[index] !== layer);
        const staticReferencesChanged = !this.dragSceneCache ||
            this.dragSceneCache.staticLayers.length !== staticLayers.length ||
            staticLayers.some((layer, index) => {
                return this.dragSceneCache?.staticLayers[index] !== layer ||
                    this.dragSceneCache?.staticImages[index] !== layer.image;
            });
        if (!this.dragSceneCache || this.dragSceneCache.key !== key || selectedReferencesChanged || staticReferencesChanged) {
            this.clearDragSceneCache();
            this.dragSceneCache = this.buildDragSceneCache(sortedLayers, selectedIds, selectedLayers, key, viewport, width, height);
        }
        if (!this.dragSceneCache) {
            this._drawLayers(ctx, layers);
            return;
        }
        for (const part of this.dragSceneCache.parts) {
            for (const segment of part.staticSegments) {
                this.drawDragStaticSegment(ctx, segment);
            }
            if (part.dynamicLayers.length > 0) {
                this._drawLayers(ctx, part.dynamicLayers);
            }
        }
    }
    _drawLayers(ctx, layers, options = {}) {
        const sortedLayers = this.getRenderOrder(layers);
        sortedLayers.forEach(layer => {
            if (layer.visible) {
                this._drawLayer(ctx, layer, options);
            }
        });
    }
    getRenderOrder(layers = this.canvas.layers) {
        const signature = layers
            .map((layer, index) => `${layer.id ?? index}:${layer.zIndex}`)
            .join('|');
        const sourceReferencesChanged = layers.length !== this.renderOrderSourceEntries.length ||
            layers.some((layer, index) => layer !== this.renderOrderSourceEntries[index]);
        if (layers !== this.renderOrderSource || sourceReferencesChanged || signature !== this.renderOrderSignature) {
            this.renderOrderCache = [...layers].sort((a, b) => a.zIndex - b.zIndex);
            this.renderOrderSource = layers;
            this.renderOrderSourceEntries = [...layers];
            this.renderOrderSignature = signature;
        }
        return this.renderOrderCache;
    }
    drawLayersToContext(ctx, layers, options = {}) {
        this._drawLayers(ctx, layers, options);
    }
    renderLayersToCanvas(bounds, layers = this.canvas.layers, contextOptions = {}) {
        const { canvas, ctx } = createCanvas(bounds.width, bounds.height, '2d', contextOptions);
        if (!ctx) {
            throw new Error("Could not create canvas context");
        }
        ctx.translate(-bounds.x, -bounds.y);
        this._drawLayers(ctx, layers);
        return { canvas, ctx };
    }
    renderLayerVisibilityMask(bounds, layers = this.canvas.layers, options = {}) {
        const { maskContextOptions = { willReadFrequently: true }, visibilityContextOptions = { alpha: true } } = options;
        const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(bounds.width, bounds.height, '2d', maskContextOptions);
        if (!maskCtx) {
            throw new Error("Could not create mask context");
        }
        maskCtx.fillStyle = '#ffffff';
        maskCtx.fillRect(0, 0, bounds.width, bounds.height);
        const { ctx: visibilityCtx } = this.renderLayersToCanvas(bounds, layers, visibilityContextOptions);
        const visibilityData = visibilityCtx.getImageData(0, 0, bounds.width, bounds.height);
        const maskData = maskCtx.getImageData(0, 0, bounds.width, bounds.height);
        fillInverseAlphaMask(visibilityData, maskData);
        maskCtx.putImageData(maskData, 0, 0);
        return { canvas: maskCanvas, ctx: maskCtx };
    }
    toggleSelectedFlip(axis) {
        const selectedLayers = this.canvas.canvasSelection.selectedLayers;
        if (selectedLayers.length === 0)
            return;
        selectedLayers.forEach((layer) => {
            layer[axis] = !layer[axis];
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }
    async mirrorHorizontal() {
        this.toggleSelectedFlip('flipH');
    }
    async mirrorVertical() {
        this.toggleSelectedFlip('flipV');
    }
    async getLayerImageData(layer) {
        try {
            const width = layer.originalWidth || layer.width;
            const height = layer.originalHeight || layer.height;
            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(width, height, '2d', { willReadFrequently: true });
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            // Use original image directly to ensure full quality
            tempCtx.drawImage(layer.image, 0, 0, width, height);
            const dataUrl = tempCanvas.toDataURL('image/png');
            if (!dataUrl.startsWith('data:image/png;base64,')) {
                throw new Error("Invalid image data format");
            }
            return dataUrl;
        }
        catch (error) {
            log.error("Error getting layer image data:", error);
            throw error;
        }
    }
    updateOutputAreaSize(width, height, saveHistory = true) {
        if (saveHistory) {
            this.canvas.saveState();
        }
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.maskTool.resize(width, height);
        // Don't set canvas.width/height - the render loop will handle display size
        // this.canvas.width/height are for OUTPUT AREA dimensions, not display canvas
        this.canvas.render();
        if (saveHistory) {
            this.canvas.canvasState.saveStateToDB();
        }
    }
    /**
     * Ustawia nowy rozmiar output area względem środka, resetuje rozszerzenia.
     */
    setOutputAreaSize(width, height) {
        // Reset rozszerzeń
        this.canvas.outputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        this.canvas.outputAreaExtensionEnabled = false;
        this.canvas.lastOutputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        // Oblicz środek obecnego output area
        const prevBounds = this.canvas.outputAreaBounds;
        const centerX = prevBounds.x + prevBounds.width / 2;
        const centerY = prevBounds.y + prevBounds.height / 2;
        // Nowa pozycja lewego górnego rogu, by środek pozostał w miejscu
        const newX = centerX - width / 2;
        const newY = centerY - height / 2;
        // Ustaw nowy rozmiar bazowy i pozycję
        this.canvas.originalCanvasSize = { width, height };
        this.canvas.originalOutputAreaPosition = { x: newX, y: newY };
        // Ustaw outputAreaBounds na nowy rozmiar i pozycję
        this.canvas.outputAreaBounds = {
            x: newX,
            y: newY,
            width,
            height
        };
        // Zaktualizuj rozmiar przez istniejącą metodę (ustawia maskę, itp.)
        this.updateOutputAreaSize(width, height, true);
        this.canvas.render();
        this.canvas.saveState();
    }
    getHandles(layer) {
        const layerCenterX = layer.x + layer.width / 2;
        const layerCenterY = layer.y + layer.height / 2;
        let handleCenterX, handleCenterY, halfW, halfH;
        if (layer.cropMode && layer.cropBounds && layer.originalWidth) {
            // CROP MODE: Handles are relative to the cropped area
            const layerScaleX = layer.width / layer.originalWidth;
            const layerScaleY = layer.height / layer.originalHeight;
            const cropRectW = layer.cropBounds.width * layerScaleX;
            const cropRectH = layer.cropBounds.height * layerScaleY;
            // Effective crop bounds start position, accounting for flips.
            const effectiveCropX = layer.flipH
                ? layer.originalWidth - (layer.cropBounds.x + layer.cropBounds.width)
                : layer.cropBounds.x;
            const effectiveCropY = layer.flipV
                ? layer.originalHeight - (layer.cropBounds.y + layer.cropBounds.height)
                : layer.cropBounds.y;
            // Center of the CROP rectangle in the layer's local, un-rotated space
            const cropCenterX_local = (-layer.width / 2) + ((effectiveCropX + layer.cropBounds.width / 2) * layerScaleX);
            const cropCenterY_local = (-layer.height / 2) + ((effectiveCropY + layer.cropBounds.height / 2) * layerScaleY);
            // Rotate this local center to find the world-space center of the crop rect
            const cropCenter = localToWorld(cropCenterX_local, cropCenterY_local, {
                centerX: layerCenterX,
                centerY: layerCenterY,
                rotation: layer.rotation
            });
            handleCenterX = cropCenter.x;
            handleCenterY = cropCenter.y;
            halfW = cropRectW / 2;
            halfH = cropRectH / 2;
        }
        else {
            // TRANSFORM MODE: Handles are relative to the full layer transform frame
            handleCenterX = layerCenterX;
            handleCenterY = layerCenterY;
            halfW = layer.width / 2;
            halfH = layer.height / 2;
        }
        const localHandles = {
            'n': { x: 0, y: -halfH }, 'ne': { x: halfW, y: -halfH },
            'e': { x: halfW, y: 0 }, 'se': { x: halfW, y: halfH },
            's': { x: 0, y: halfH }, 'sw': { x: -halfW, y: halfH },
            'w': { x: -halfW, y: 0 }, 'nw': { x: -halfW, y: -halfH },
            'rot': { x: 0, y: -halfH - 20 / this.canvas.viewport.zoom }
        };
        const worldHandles = {};
        const handleTransform = {
            centerX: handleCenterX,
            centerY: handleCenterY,
            rotation: layer.rotation
        };
        for (const key in localHandles) {
            const p = localHandles[key];
            worldHandles[key] = localToWorld(p.x, p.y, handleTransform);
        }
        return worldHandles;
    }
    getHandleAtPosition(worldX, worldY) {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return null;
        const handleRadius = 8 / this.canvas.viewport.zoom;
        for (let i = this.canvas.canvasSelection.selectedLayers.length - 1; i >= 0; i--) {
            const layer = this.canvas.canvasSelection.selectedLayers[i];
            const handles = this.getHandles(layer);
            for (const key in handles) {
                const handlePos = handles[key];
                const dx = worldX - handlePos.x;
                const dy = worldY - handlePos.y;
                if (dx * dx + dy * dy <= handleRadius * handleRadius) {
                    return { layer: layer, handle: key };
                }
            }
        }
        return null;
    }
    updateBlendModeMenuPosition() {
        if (!this.blendMenuElement)
            return;
        const screenX = (this.blendMenuWorldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const screenY = (this.blendMenuWorldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;
        this.blendMenuElement.style.transform = `translate(${screenX}px, ${screenY}px)`;
    }
    showBlendModeMenu(worldX, worldY) {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            return;
        }
        // Find which selected layer is at the click position (topmost visible layer at that position)
        let selectedLayer = null;
        const visibleSelectedLayers = this.canvas.canvasSelection.selectedLayers.filter((layer) => layer.visible);
        if (visibleSelectedLayers.length === 0) {
            return;
        }
        // Sort by zIndex descending and find the first one that contains the click point
        const sortedLayers = visibleSelectedLayers.sort((a, b) => b.zIndex - a.zIndex);
        for (const layer of sortedLayers) {
            // Check if click is within layer bounds
            if (isPointInRotatedLayer(worldX, worldY, layer)) {
                selectedLayer = layer;
                break;
            }
        }
        // If no layer found at click position, fall back to topmost visible selected layer
        if (!selectedLayer) {
            selectedLayer = sortedLayers[0];
        }
        // At this point selectedLayer is guaranteed to be non-null
        if (!selectedLayer) {
            return;
        }
        // Remove any existing event listener first
        if (this.currentCloseMenuListener) {
            document.removeEventListener('mousedown', this.currentCloseMenuListener);
            this.currentCloseMenuListener = null;
        }
        this.closeBlendModeMenu();
        // Calculate position in WORLD coordinates (top-right of viewport)
        const viewLeft = this.canvas.viewport.x;
        const viewTop = this.canvas.viewport.y;
        const viewWidth = this.canvas.canvas.width / this.canvas.viewport.zoom;
        // Position near top-right corner
        this.blendMenuWorldX = viewLeft + viewWidth - (250 / this.canvas.viewport.zoom); // 250px from right edge
        this.blendMenuWorldY = viewTop + (10 / this.canvas.viewport.zoom); // 10px from top edge
        const menu = document.createElement('div');
        this.blendMenuElement = menu;
        menu.id = 'lf-blend-mode-menu';
        const titleBar = document.createElement('div');
        titleBar.className = 'lf-blend-menu-title-bar';
        const titleText = document.createElement('span');
        titleText.textContent = `Blend Mode: ${selectedLayer.name}`;
        titleText.className = 'lf-blend-menu-title-text';
        const closeButton = document.createElement('button');
        closeButton.textContent = '×';
        closeButton.className = 'lf-blend-menu-close-button';
        closeButton.onclick = (e) => {
            e.stopPropagation();
            this.closeBlendModeMenu();
        };
        titleBar.appendChild(titleText);
        titleBar.appendChild(closeButton);
        const content = document.createElement('div');
        content.className = 'lf-blend-menu-content';
        menu.appendChild(titleBar);
        menu.appendChild(content);
        const blendAreaContainer = document.createElement('div');
        blendAreaContainer.className = 'lf-blend-area-container';
        const blendAreaLabel = document.createElement('label');
        blendAreaLabel.textContent = 'Blend Area';
        blendAreaLabel.className = 'lf-blend-area-label';
        const blendAreaSlider = document.createElement('input');
        blendAreaSlider.type = 'range';
        blendAreaSlider.min = '0';
        blendAreaSlider.max = '100';
        blendAreaSlider.className = 'lf-blend-area-slider';
        blendAreaSlider.value = selectedLayer?.blendArea?.toString() ?? '0';
        blendAreaSlider.oninput = () => {
            if (selectedLayer) {
                const newValue = parseInt(blendAreaSlider.value, 10);
                selectedLayer.blendArea = newValue;
                // Set flag to enable live blend area rendering for this specific layer
                this.layersAdjustingBlendArea.add(selectedLayer.id);
                // Invalidate processed image cache when blend area changes
                this.invalidateProcessedImageCache(selectedLayer.id);
                this.canvas.render();
            }
        };
        blendAreaSlider.addEventListener('change', () => {
            // When user stops adjusting, create cache asynchronously but keep live rendering until cache is ready
            if (selectedLayer) {
                const layerId = selectedLayer.id;
                const cacheKey = this.getProcessedImageCacheKey(selectedLayer);
                // Create the processed image asynchronously and deduplicate it
                // with any request made by the render loop.
                void this.buildProcessedImage(selectedLayer, cacheKey, 'slider processed image')
                    .then((built) => {
                    this.layersAdjustingBlendArea.delete(layerId);
                    // A successful build already rendered the new cache.
                    if (!built)
                        this.canvas.render();
                });
            }
            this.canvas.saveState();
        });
        blendAreaContainer.appendChild(blendAreaLabel);
        blendAreaContainer.appendChild(blendAreaSlider);
        content.appendChild(blendAreaContainer);
        let isDragging = false;
        // Drag logic needs to update world coordinates, not screen coordinates
        const handleMouseMove = (e) => {
            if (isDragging) {
                const dx = e.movementX / this.canvas.viewport.zoom;
                const dy = e.movementY / this.canvas.viewport.zoom;
                this.blendMenuWorldX += dx;
                this.blendMenuWorldY += dy;
                this.updateBlendModeMenuPosition();
            }
        };
        const handleMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            }
        };
        titleBar.addEventListener('mousedown', (e) => {
            isDragging = true;
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
        this.blendModes.forEach((mode) => {
            const container = document.createElement('div');
            container.className = 'lf-blend-mode-container';
            const option = document.createElement('div');
            option.className = 'lf-blend-mode-option';
            option.textContent = `${mode.label} (${mode.name})`;
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.className = 'lf-blend-opacity-slider';
            const selectedLayer = this.canvas.canvasSelection.selectedLayers[0];
            slider.value = selectedLayer ? String(Math.round(selectedLayer.opacity * 100)) : '100';
            if (selectedLayer && selectedLayer.blendMode === mode.name) {
                container.classList.add('lf-active');
                option.classList.add('lf-active');
            }
            option.onclick = () => {
                // Re-check selected layer at the time of click
                const currentSelectedLayer = this.canvas.canvasSelection.selectedLayers[0];
                if (!currentSelectedLayer) {
                    return;
                }
                // Remove active class from all containers and options
                content.querySelectorAll('.lf-blend-mode-container').forEach(c => {
                    c.classList.remove('lf-active');
                    const optionDiv = c.querySelector('.lf-blend-mode-option');
                    if (optionDiv) {
                        optionDiv.classList.remove('lf-active');
                    }
                });
                // Add active class to current container and option
                container.classList.add('lf-active');
                option.classList.add('lf-active');
                currentSelectedLayer.blendMode = mode.name;
                this.canvas.render();
            };
            slider.addEventListener('input', () => {
                // Re-check selected layer at the time of slider input
                const currentSelectedLayer = this.canvas.canvasSelection.selectedLayers[0];
                if (!currentSelectedLayer) {
                    return;
                }
                const newOpacity = parseInt(slider.value, 10) / 100;
                currentSelectedLayer.opacity = newOpacity;
                this.canvas.render();
            });
            slider.addEventListener('change', async () => {
                if (selectedLayer) {
                    selectedLayer.opacity = parseInt(slider.value, 10) / 100;
                    this.canvas.render();
                    const saveWithFallback = async (fileName) => {
                        try {
                            const uniqueFileName = generateUniqueFileName(fileName, this.canvas.node.id);
                            return await this.canvas.canvasIO.saveToServer(uniqueFileName);
                        }
                        catch (error) {
                            console.warn(`Failed to save with unique name, falling back to original: ${fileName}`, error);
                            return await this.canvas.canvasIO.saveToServer(fileName);
                        }
                    };
                    if (this.canvas.widget) {
                        await saveWithFallback(this.canvas.widget.value);
                        if (this.canvas.node) {
                            app.graph.runStep();
                        }
                    }
                }
            });
            container.appendChild(option);
            container.appendChild(slider);
            content.appendChild(container);
        });
        // Add contextmenu event listener to the menu itself to prevent browser context menu
        menu.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        if (!this.canvas.canvasContainer) {
            log.error("Canvas container not found, cannot append blend mode menu.");
            return;
        }
        this.canvas.canvasContainer.appendChild(menu);
        this.updateBlendModeMenuPosition();
        // Add listener for viewport changes
        this.canvas.onViewportChange = () => this.updateBlendModeMenuPosition();
        const closeMenu = (e) => {
            if (e.target instanceof Node && !menu.contains(e.target) && !isDragging) {
                this.closeBlendModeMenu();
                if (this.currentCloseMenuListener) {
                    document.removeEventListener('mousedown', this.currentCloseMenuListener);
                    this.currentCloseMenuListener = null;
                }
            }
        };
        // Store the listener reference so we can remove it later
        this.currentCloseMenuListener = closeMenu;
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu);
        }, 0);
    }
    closeBlendModeMenu() {
        log.info("=== BLEND MODE MENU CLOSING ===");
        if (this.blendMenuElement && this.blendMenuElement.parentNode) {
            log.info("Removing blend mode menu from DOM");
            this.blendMenuElement.parentNode.removeChild(this.blendMenuElement);
            this.blendMenuElement = null;
        }
        else {
            log.info("Blend mode menu not found or already removed");
        }
        // Remove viewport change listener
        if (this.canvas.onViewportChange) {
            this.canvas.onViewportChange = null;
        }
    }
    /**
     * Zunifikowana funkcja do generowania blob z canvas
     * @param options Opcje renderowania
     */
    async _generateCanvasBlob(options = {}) {
        const { layers = this.canvas.layers, useOutputBounds = true, applyMask = false, enableLogging = false, customBounds } = options;
        return new Promise((resolve) => {
            let bounds;
            if (customBounds) {
                bounds = customBounds;
            }
            else if (useOutputBounds) {
                bounds = this.canvas.outputAreaBounds;
            }
            else {
                const layerBounds = getBoundsFromPoints(layers.flatMap((layer) => getLayerWorldCorners(layer)));
                const newWidth = Math.ceil(layerBounds.width);
                const newHeight = Math.ceil(layerBounds.height);
                if (newWidth <= 0 || newHeight <= 0) {
                    resolve(null);
                    return;
                }
                bounds = { x: layerBounds.x, y: layerBounds.y, width: newWidth, height: newHeight };
            }
            if (enableLogging) {
                log.info("=== GENERATING OUTPUT CANVAS ===");
                log.info(`Bounds: x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}`);
                log.info(`Canvas Size: ${bounds.width}x${bounds.height}`);
                log.info(`Context Translation: translate(${-bounds.x}, ${-bounds.y})`);
                log.info(`Apply Mask: ${applyMask}`);
                // Log layer positions before rendering
                layers.forEach((layer, index) => {
                    if (layer.visible) {
                        const relativeToOutput = {
                            x: layer.x - bounds.x,
                            y: layer.y - bounds.y
                        };
                        log.info(`Layer ${index + 1} "${layer.name}": world(${layer.x.toFixed(1)}, ${layer.y.toFixed(1)}) relative_to_bounds(${relativeToOutput.x.toFixed(1)}, ${relativeToOutput.y.toFixed(1)}) size(${layer.width.toFixed(1)}x${layer.height.toFixed(1)})`);
                    }
                });
            }
            const { canvas: tempCanvas, ctx: tempCtx } = this.renderLayersToCanvas(bounds, layers, { willReadFrequently: true });
            // Aplikuj maskę jeśli wymagana
            if (applyMask) {
                const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
                const data = imageData.data;
                // Use optimized getMaskForOutputArea() for better performance
                // This only processes chunks that overlap with the output area
                const toolMaskCanvas = this.canvas.maskTool.getMaskForOutputArea();
                if (toolMaskCanvas) {
                    log.debug(`Using optimized output area mask (${toolMaskCanvas.width}x${toolMaskCanvas.height}) for _generateCanvasBlob`);
                    // The optimized mask is already sized and positioned for the output area
                    // So we can apply it directly without complex positioning calculations
                    const maskImageData = toolMaskCanvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, toolMaskCanvas.width, toolMaskCanvas.height);
                    if (maskImageData) {
                        const maskData = maskImageData.data;
                        for (let i = 0; i < data.length; i += 4) {
                            const originalAlpha = data[i + 3];
                            const maskAlpha = maskData[i + 3] / 255;
                            const invertedMaskAlpha = 1 - maskAlpha;
                            data[i + 3] = originalAlpha * invertedMaskAlpha;
                        }
                        tempCtx.putImageData(imageData, 0, 0);
                    }
                }
            }
            tempCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                }
                else {
                    resolve(null);
                }
            }, 'image/png');
        });
    }
    // Publiczne metody używające zunifikowanej funkcji
    async getFlattenedCanvasWithMaskAsBlob() {
        return this._generateCanvasBlob({
            layers: this.canvas.layers,
            useOutputBounds: true,
            applyMask: true,
            enableLogging: true
        });
    }
    async getFlattenedCanvasAsBlob() {
        return this._generateCanvasBlob({
            layers: this.canvas.layers,
            useOutputBounds: true,
            applyMask: false,
            enableLogging: true
        });
    }
    async getFlattenedSelectionAsBlob() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            return null;
        }
        return this._generateCanvasBlob({
            layers: this.canvas.canvasSelection.selectedLayers,
            useOutputBounds: false,
            applyMask: false,
            enableLogging: false
        });
    }
    async getFlattenedMaskAsBlob() {
        return new Promise((resolve) => {
            const bounds = this.canvas.outputAreaBounds;
            log.info("=== GENERATING MASK BLOB ===");
            log.info(`Mask Canvas Size: ${bounds.width}x${bounds.height}`);
            const { canvas: maskCanvas, ctx: maskCtx } = this.renderLayerVisibilityMask(bounds, this.canvas.layers, {
                maskContextOptions: { willReadFrequently: true },
                visibilityContextOptions: { alpha: true }
            });
            // Aplikuj maskę narzędzia jeśli istnieje - używaj zoptymalizowanej metody
            const toolMaskCanvas = this.canvas.maskTool.getMaskForOutputArea();
            if (toolMaskCanvas) {
                log.debug(`[getFlattenedMaskAsBlob] Using optimized output area mask (${toolMaskCanvas.width}x${toolMaskCanvas.height})`);
                // Zoptymalizowana maska jest już odpowiednio pozycjonowana dla output area
                // Możemy ją zastosować bezpośrednio
                const tempMaskData = toolMaskCanvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, toolMaskCanvas.width, toolMaskCanvas.height);
                if (tempMaskData) {
                    // Konwertuj dane maski do odpowiedniego formatu
                    for (let i = 0; i < tempMaskData.data.length; i += 4) {
                        const alpha = tempMaskData.data[i + 3];
                        tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = alpha;
                        tempMaskData.data[i + 3] = 255; // Solidna alpha
                    }
                    // Stwórz tymczasowy canvas dla przetworzonej maski
                    const { canvas: tempMaskCanvas, ctx: tempMaskCtx } = createCanvas(toolMaskCanvas.width, toolMaskCanvas.height, '2d', { willReadFrequently: true });
                    if (tempMaskCtx) {
                        tempMaskCtx.putImageData(tempMaskData, 0, 0);
                        maskCtx.globalCompositeOperation = 'screen';
                        maskCtx.drawImage(tempMaskCanvas, 0, 0);
                    }
                }
            }
            log.info("=== MASK BLOB GENERATED ===");
            maskCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                }
                else {
                    resolve(null);
                }
            }, 'image/png');
        });
    }
    async fuseLayers() {
        if (this.canvas.canvasSelection.selectedLayers.length < 2) {
            showErrorNotification("Please select at least 2 layers to fuse.");
            return;
        }
        log.info(`Fusing ${this.canvas.canvasSelection.selectedLayers.length} selected layers`);
        try {
            this.canvas.saveState();
            const bounds = getBoundsFromPoints(this.canvas.canvasSelection.selectedLayers.flatMap((layer) => getLayerWorldCorners(layer)));
            const fusedWidth = Math.ceil(bounds.width);
            const fusedHeight = Math.ceil(bounds.height);
            if (fusedWidth <= 0 || fusedHeight <= 0) {
                log.warn("Calculated fused layer dimensions are invalid");
                showErrorNotification("Cannot fuse layers: invalid dimensions calculated.");
                return;
            }
            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(fusedWidth, fusedHeight, '2d', { willReadFrequently: true });
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            tempCtx.translate(-bounds.x, -bounds.y);
            this._drawLayers(tempCtx, this.canvas.canvasSelection.selectedLayers);
            const fusedImage = new Image();
            fusedImage.crossOrigin = 'anonymous';
            fusedImage.src = tempCanvas.toDataURL();
            await new Promise((resolve, reject) => {
                fusedImage.onload = resolve;
                fusedImage.onerror = reject;
            });
            const minZIndex = Math.min(...this.canvas.canvasSelection.selectedLayers.map((layer) => layer.zIndex));
            const imageId = generateUUID();
            await saveImage(imageId, fusedImage.src);
            this.canvas.imageCache.set(imageId, fusedImage.src);
            const fusedLayer = {
                id: generateUUID(),
                image: fusedImage,
                imageId: imageId,
                name: 'Fused Layer',
                x: bounds.x,
                y: bounds.y,
                width: fusedWidth,
                height: fusedHeight,
                originalWidth: fusedWidth,
                originalHeight: fusedHeight,
                rotation: 0,
                zIndex: minZIndex,
                blendMode: 'normal',
                opacity: 1,
                visible: true
            };
            this.canvas.layers = this.canvas.layers.filter((layer) => !this.canvas.canvasSelection.selectedLayers.includes(layer));
            this.canvas.layers.push(fusedLayer);
            this.canvas.layers.sort((a, b) => a.zIndex - b.zIndex);
            this.canvas.layers.forEach((layer, index) => {
                layer.zIndex = index;
            });
            this.canvas.updateSelection([fusedLayer]);
            this.canvas.render();
            this.canvas.saveState();
            if (this.canvas.canvasLayersPanel) {
                this.canvas.canvasLayersPanel.onLayersChanged();
            }
            log.info("Layers fused successfully", {
                originalLayerCount: this.canvas.canvasSelection.selectedLayers.length,
                fusedDimensions: { width: fusedWidth, height: fusedHeight },
                fusedPosition: { x: bounds.x, y: bounds.y }
            });
        }
        catch (error) {
            log.error("Error during layer fusion:", error);
            showErrorNotification(`Error fusing layers: ${error.message}`);
        }
    }
}
