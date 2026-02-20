import {saveImage, removeImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {generateUUID, generateUniqueFileName, createCanvas} from "./utils/CommonUtils.js";
import {withErrorHandling, createValidationError} from "./ErrorHandler.js";
import {showErrorNotification, showSuccessNotification} from "./utils/NotificationUtils.js";
import { addStylesheet, getUrl } from "./utils/ResourceManager.js";
// @ts-ignore
import {app} from "../../scripts/app.js";
// @ts-ignore
import {ComfyApp} from "../../scripts/app.js";
import { ClipboardManager } from "./utils/ClipboardManager.js";
import { createDistanceFieldMaskSync } from "./utils/ImageAnalysis.js";
import type { Canvas } from './Canvas';
import type { Layer, Point, AddMode, ClipboardPreference } from './types';

const log = createModuleLogger('CanvasLayers');

interface BlendMode {
    name: string;
    label: string;
}

export class CanvasLayers {
    private canvas: Canvas;
    private _canvasMaskCache: Map<HTMLCanvasElement, Map<number, HTMLCanvasElement>> = new Map();
    public clipboardManager: ClipboardManager;
    private blendModes: BlendMode[];
    private selectedBlendMode: string | null;
    private blendOpacity: number;
    private isAdjustingOpacity: boolean;
    public internalClipboard: Layer[];
    public clipboardPreference: ClipboardPreference;
    private distanceFieldCache: WeakMap<HTMLImageElement, Map<number, HTMLCanvasElement>>;
    private blendMenuElement: HTMLDivElement | null = null;
    private blendMenuWorldX: number = 0;
    private blendMenuWorldY: number = 0;
    
    // Cache for processed images with effects applied
    private processedImageCache: Map<string, HTMLImageElement> = new Map();
    
    // Debouncing system for processed image creation
    private processedImageDebounceTimers: Map<string, number> = new Map();
    private readonly PROCESSED_IMAGE_DEBOUNCE_DELAY = 1000; // 1 second
    private globalDebounceTimer: number | null = null;
    private lastRenderTime: number = 0;
    private layersAdjustingBlendArea: Set<string> = new Set();
    private layersTransformingCropBounds: Set<string> = new Set();
    private layersTransformingScale: Set<string> = new Set();
    private layersWheelScaling: Set<string> = new Set();

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this.clipboardManager = new ClipboardManager(canvas as any);
        this.distanceFieldCache = new WeakMap();
        this.processedImageCache = new Map();
        this.processedImageDebounceTimers = new Map();
        this.blendModes = [
            { name: 'normal', label: 'Normal' },
            {name: 'multiply', label: 'Multiply'},
            {name: 'screen', label: 'Screen'},
            {name: 'overlay', label: 'Overlay'},
            {name: 'darken', label: 'Darken'},
            {name: 'lighten', label: 'Lighten'},
            {name: 'color-dodge', label: 'Color Dodge'},
            {name: 'color-burn', label: 'Color Burn'},
            {name: 'hard-light', label: 'Hard Light'},
            {name: 'soft-light', label: 'Soft Light'},
            {name: 'difference', label: 'Difference'},
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

    async copySelectedLayers(): Promise<void> {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;

        this.internalClipboard = this.canvas.canvasSelection.selectedLayers.map((layer: Layer) => ({ ...layer }));
        log.info(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);

        const blob = await this.getFlattenedSelectionAsBlob();
        if (!blob) {
            log.warn("Failed to create flattened selection blob");
            return;
        }

        if (this.clipboardPreference === 'clipspace') {
            try {
                const dataURL = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });

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
                    } else {
                        log.warn("ComfyUI copyToClipspace not available");
                    }
                };
                img.src = dataURL;
            } catch (error) {
                log.error("Failed to copy image to ComfyUI Clipspace:", error);
                try {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    log.info("Fallback: Flattened selection copied to system clipboard.");
                } catch (fallbackError) {
                    log.error("Failed to copy to system clipboard as fallback:", fallbackError);
                }
            }
        } else {
            try {
                const item = new ClipboardItem({ 'image/png': blob });
                await navigator.clipboard.write([item]);
                log.info("Flattened selection copied to system clipboard.");
            } catch (error) {
                log.error("Failed to copy image to system clipboard:", error);
            }
        }
    }

    /**
     * Automatically adjust output area to fit selected layers
     * Calculates precise bounding box for all selected layers including rotation and crop mode support
     */
    autoAdjustOutputToSelection(): boolean {
        const selectedLayers = this.canvas.canvasSelection.selectedLayers;
        if (selectedLayers.length === 0) {
            return false;
        }
        
        // Calculate bounding box of selected layers
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        selectedLayers.forEach((layer: Layer) => {
            // For crop mode layers, use the visible crop bounds
            if (layer.cropMode && layer.cropBounds && layer.originalWidth && layer.originalHeight) {
                const layerScaleX = layer.width / layer.originalWidth;
                const layerScaleY = layer.height / layer.originalHeight;
                
                const cropWidth = layer.cropBounds.width * layerScaleX;
                const cropHeight = layer.cropBounds.height * layerScaleY;
                
                const effectiveCropX = layer.flipH 
                    ? layer.originalWidth - (layer.cropBounds.x + layer.cropBounds.width) 
                    : layer.cropBounds.x;
                const effectiveCropY = layer.flipV 
                    ? layer.originalHeight - (layer.cropBounds.y + layer.cropBounds.height) 
                    : layer.cropBounds.y;
                
                const cropOffsetX = effectiveCropX * layerScaleX;
                const cropOffsetY = effectiveCropY * layerScaleY;
                
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                
                // Calculate corners of the crop rectangle
                const corners = [
                    { x: cropOffsetX, y: cropOffsetY },
                    { x: cropOffsetX + cropWidth, y: cropOffsetY },
                    { x: cropOffsetX + cropWidth, y: cropOffsetY + cropHeight },
                    { x: cropOffsetX, y: cropOffsetY + cropHeight }
                ];
                
                corners.forEach(p => {
                    // Transform to layer space (centered)
                    const localX = p.x - layer.width / 2;
                    const localY = p.y - layer.height / 2;
                    
                    // Apply rotation
                    const worldX = centerX + (localX * cos - localY * sin);
                    const worldY = centerY + (localX * sin + localY * cos);
                    
                    minX = Math.min(minX, worldX);
                    minY = Math.min(minY, worldY);
                    maxX = Math.max(maxX, worldX);
                    maxY = Math.max(maxY, worldY);
                });
            } else {
                // For normal layers, use the full layer bounds
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                
                const halfW = layer.width / 2;
                const halfH = layer.height / 2;
                
                const corners = [
                    { x: -halfW, y: -halfH },
                    { x: halfW, y: -halfH },
                    { x: halfW, y: halfH },
                    { x: -halfW, y: halfH }
                ];
                
                corners.forEach(p => {
                    const worldX = centerX + (p.x * cos - p.y * sin);
                    const worldY = centerY + (p.x * sin + p.y * cos);
                    
                    minX = Math.min(minX, worldX);
                    minY = Math.min(minY, worldY);
                    maxX = Math.max(maxX, worldX);
                    maxY = Math.max(maxY, worldY);
                });
            }
        });
        
        // Calculate new dimensions without padding for precise fit
        const newWidth = Math.ceil(maxX - minX);
        const newHeight = Math.ceil(maxY - minY);
        
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

    pasteLayers(): void {
        if (this.internalClipboard.length === 0) return;
        this.canvas.saveState();
        const newLayers: Layer[] = [];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.internalClipboard.forEach((layer: Layer) => {
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

        this.internalClipboard.forEach((clipboardLayer: Layer, index: number) => {
            const newLayer: Layer = {
                ...clipboardLayer,
                x: clipboardLayer.x + offsetX,
                y: clipboardLayer.y + offsetY,
                zIndex: maxZIndex + 1 + index  // Ensure pasted layers maintain their relative order
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

    async handlePaste(addMode: AddMode = 'mouse'): Promise<void> {
        try {
            log.info(`Paste operation started with preference: ${this.clipboardPreference}`);
            await this.clipboardManager.handlePaste(addMode, this.clipboardPreference);
        } catch (err) {
            log.error("Paste operation failed:", err);
        }
    }

    addLayerWithImage = withErrorHandling(async (image: HTMLImageElement, layerProps: Partial<Layer> = {}, addMode: AddMode = 'default', targetArea: { x: number, y: number, width: number, height: number } | null = null): Promise<Layer> => {
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
        } else if (addMode === 'mouse') {
            finalX = this.canvas.lastMousePosition.x - finalWidth / 2;
            finalY = this.canvas.lastMousePosition.y - finalHeight / 2;
        } else {
            finalX = area.x + (area.width - finalWidth) / 2;
            finalY = area.y + (area.height - finalHeight) / 2;
        }

        // Find the highest zIndex among existing layers
        const maxZIndex = this.canvas.layers.length > 0 
            ? Math.max(...this.canvas.layers.map(l => l.zIndex)) 
            : -1;

        const layer: Layer = {
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
            zIndex: maxZIndex + 1,  // Always add new layer on top
            blendMode: 'normal',
            opacity: 1,
            visible: true,
            ...layerProps
        };

        if (layer.mask) {
            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(layer.width, layer.height);
            if(tempCtx) {
                tempCtx.drawImage(layer.image, 0, 0, layer.width, layer.height);
    
                const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(layer.width, layer.height);
                if(maskCtx) {
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

    async addLayer(image: HTMLImageElement): Promise<Layer> {
        return this.addLayerWithImage(image);
    }

    moveLayers(layersToMove: Layer[], options: { direction?: 'up' | 'down', toIndex?: number } = {}): void {
        if (!layersToMove || layersToMove.length === 0) return;

        let finalLayers: Layer[];

        if (options.direction) {
            const allLayers = [...this.canvas.layers];
            const selectedIndices = new Set(layersToMove.map((l: Layer) => allLayers.indexOf(l)));

            if (options.direction === 'up') {
                const sorted = Array.from(selectedIndices).sort((a, b) => b - a);
                sorted.forEach((index: number) => {
                    const targetIndex = index + 1;
                    if (targetIndex < allLayers.length && !selectedIndices.has(targetIndex)) {
                        [allLayers[index], allLayers[targetIndex]] = [allLayers[targetIndex], allLayers[index]];
                    }
                });
            } else if (options.direction === 'down') {
                const sorted = Array.from(selectedIndices).sort((a, b) => a - b);
                sorted.forEach((index: number) => {
                    const targetIndex = index - 1;
                    if (targetIndex >= 0 && !selectedIndices.has(targetIndex)) {
                        [allLayers[index], allLayers[targetIndex]] = [allLayers[targetIndex], allLayers[index]];
                    }
                });
            }
            finalLayers = allLayers;
        } else if (options.toIndex !== undefined) {
            const displayedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);
            const reorderedFinal: Layer[] = [];
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
        } else {
            log.warn("Invalid options for moveLayers", options);
            return;
        }

        const totalLayers = finalLayers.length;
        finalLayers.forEach((layer, index) => {
            const zIndex = (options.toIndex !== undefined) ? (totalLayers - 1 - index) : index;
            layer.zIndex = zIndex;
        });

        this.canvas.layers = finalLayers;
        this.canvas.layers.sort((a: Layer, b: Layer) => a.zIndex - b.zIndex);

        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }

        this.canvas.render();
        this.canvas.requestSaveState();
        log.info(`Moved ${layersToMove.length} layer(s).`);
    }

    moveLayerUp(): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;
        this.moveLayers(this.canvas.canvasSelection.selectedLayers, { direction: 'up' });
    }

    moveLayerDown(): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;
        this.moveLayers(this.canvas.canvasSelection.selectedLayers, { direction: 'down' });
    }

    resizeLayer(scale: number): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;

        this.canvas.canvasSelection.selectedLayers.forEach((layer: Layer) => {
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

    rotateLayer(angle: number): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;

        this.canvas.canvasSelection.selectedLayers.forEach((layer: Layer) => {
            layer.rotation += angle;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }

    getLayerAtPosition(worldX: number, worldY: number): { layer: Layer, localX: number, localY: number } | null {
        // Always sort by zIndex so topmost is checked first
        this.canvas.layers.sort((a, b) => a.zIndex - b.zIndex);

        for (let i = this.canvas.layers.length - 1; i >= 0; i--) {
            const layer = this.canvas.layers[i];

            // Skip invisible layers
            if (!layer.visible) continue;

            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;

            const dx = worldX - centerX;
            const dy = worldY - centerY;

            const rad = -layer.rotation * Math.PI / 180;
            const rotatedX = dx * Math.cos(rad) - dy * Math.sin(rad);
            const rotatedY = dx * Math.sin(rad) + dy * Math.cos(rad);

            if (Math.abs(rotatedX) <= layer.width / 2 && Math.abs(rotatedY) <= layer.height / 2) {
                return {
                    layer: layer,
                    localX: rotatedX + layer.width / 2,
                    localY: rotatedY + layer.height / 2
                };
            }
        }
        return null;
    }

    private _drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, options: { offsetX?: number, offsetY?: number } = {}): void {
        if (!layer.image) return;

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
        
        const shouldRenderLive = isTransformingCropBounds || isTransformingScale || isThisLayerBeingAdjusted || isTransformingCropBoundsSet || isTransformingScaleSet || isWheelScaling;
        
        // Check if we should use cached processed image or render live
        const processedImage = this.getProcessedImage(layer);
        
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
                        } else {
                            score -= Math.abs(cacheBlendArea - currentBlendArea);
                        }
                        
                        // Score based on crop match (high priority)
                        if (cacheCropKey === currentCropKey) {
                            score += 200;
                        } else {
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
            ctx.globalCompositeOperation = layer.blendMode as any || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(processedImage, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        } else if (bestMatchingCache && (isTransformingScale || isTransformingScaleSet || isWheelScaling)) {
            // During scaling operations: use the BEST matching processed image (more efficient)
            // This ensures we always use the most appropriate blend area image during scaling
            ctx.globalCompositeOperation = layer.blendMode as any || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(bestMatchingCache, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        } else if (needsBlendAreaEffect && shouldRenderLive && !isWheelScaling) {
            // Render blend area live only when transforming crop bounds or adjusting blend area slider
            // BUT NOT during wheel scaling - that should use cached image
            this._drawLayerWithLiveBlendArea(ctx, layer);
        } else {
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
    private drawLayerImageWithCrop(ctx: CanvasRenderingContext2D, layer: Layer, offsetX = -layer.width / 2, offsetY = -layer.height / 2): void {
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

        ctx.drawImage(
            layer.image,
            s.x, s.y, s.width, s.height, // source rect (from original image)
            dX, dY, dWidth, dHeight      // destination rect (scaled and positioned)
        );
    }

    private _drawLayerImage(ctx: CanvasRenderingContext2D, layer: Layer): void {
        ctx.globalCompositeOperation = layer.blendMode as any || 'normal';
        ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
        this.drawLayerImageWithCrop(ctx, layer);
    }

    /**
     * Zunifikowana funkcja do tworzenia maski blend area dla warstwy
     * @param layer Warstwa dla której tworzymy maskę
     * @returns Obiekt zawierający maskę i jej wymiary lub null
     */
    private createBlendAreaMask(layer: Layer): { maskCanvas: HTMLCanvasElement, maskWidth: number, maskHeight: number } | null {
        const blendArea = layer.blendArea ?? 0;
        
        if (layer.cropBounds && layer.originalWidth && layer.originalHeight) {
            // Create a cropped canvas
            const s = layer.cropBounds;
            const { canvas: cropCanvas, ctx: cropCtx } = createCanvas(s.width, s.height);
            if (cropCtx) {
                cropCtx.drawImage(
                    layer.image,
                    s.x, s.y, s.width, s.height,
                    0, 0, s.width, s.height
                );
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
        } else {
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
    private drawLayerWithBlendArea(ctx: CanvasRenderingContext2D, layer: Layer, offsetX = -layer.width / 2, offsetY = -layer.height / 2): void {
        const maskInfo = this.createBlendAreaMask(layer);
        
        if (maskInfo) {
            const { maskCanvas, maskWidth, maskHeight } = maskInfo;
            const s = layer.cropBounds || { x: 0, y: 0, width: layer.originalWidth, height: layer.originalHeight };

            if (!layer.originalWidth || !layer.originalHeight) {
                // Fallback - just draw the image normally
                ctx.drawImage(layer.image, offsetX, offsetY, layer.width, layer.height);
            } else {
                const layerScaleX = layer.width / layer.originalWidth;
                const layerScaleY = layer.height / layer.originalHeight;

                const dWidth = s.width * layerScaleX;
                const dHeight = s.height * layerScaleY;
                const dX = offsetX + (s.x * layerScaleX);
                const dY = offsetY + (s.y * layerScaleY);

                // Draw the image
                ctx.drawImage(
                    layer.image,
                    s.x, s.y, s.width, s.height,
                    dX, dY, dWidth, dHeight
                );

                // Apply the distance field mask
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(
                    maskCanvas,
                    0, 0, maskWidth, maskHeight,
                    dX, dY, dWidth, dHeight
                );
            }
        } else {
            // Fallback - just draw the image normally
            this.drawLayerImageWithCrop(ctx, layer, offsetX, offsetY);
        }
    }

    /**
     * Draw layer with live blend area effect during user activity (original behavior)
     */
    private _drawLayerWithLiveBlendArea(ctx: CanvasRenderingContext2D, layer: Layer): void {
        // Create a temporary canvas for the masked layer
        const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(layer.width, layer.height);
        
        if (tempCtx) {
            // Draw the layer with blend area to temp canvas
            this.drawLayerWithBlendArea(tempCtx, layer, 0, 0);
            
            // Draw the result with blend mode and opacity
            ctx.globalCompositeOperation = layer.blendMode as any || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(tempCanvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        } else {
            // Fallback to normal drawing
            this._drawLayerImage(ctx, layer);
        }
    }

    /**
     * Generate a cache key for processed images based on layer properties
     */
    private getProcessedImageCacheKey(layer: Layer): string {
        const blendArea = layer.blendArea ?? 0;
        const cropKey = layer.cropBounds ? 
            `${layer.cropBounds.x},${layer.cropBounds.y},${layer.cropBounds.width},${layer.cropBounds.height}` : 
            'nocrop';
        return `${layer.id}_${blendArea}_${cropKey}_${layer.width}_${layer.height}`;
    }

    /**
     * Get processed image with all effects applied (blend area, crop, etc.)
     * Uses live rendering for layers being actively adjusted, debounced processing for others
     */
    private getProcessedImage(layer: Layer): HTMLImageElement | null {
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;
        const needsCropEffect = layer.cropBounds && layer.originalWidth && layer.originalHeight;

        // If no effects needed, return null to use normal drawing
        if (!needsBlendAreaEffect && !needsCropEffect) {
            return null;
        }

        // If this layer is being actively adjusted (blend area slider), don't use cache
        if (this.layersAdjustingBlendArea.has(layer.id)) {
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

        // Use debounced processing - schedule creation but don't create immediately
        this.scheduleProcessedImageCreation(layer, cacheKey);
        return null; // Use original image for now until processed image is ready
    }

    /**
     * Schedule processed image creation after debounce delay
     */
    private scheduleProcessedImageCreation(layer: Layer, cacheKey: string): void {
        // Clear existing timer for this layer
        const existingTimer = this.processedImageDebounceTimers.get(layer.id);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Schedule new timer
        const timer = window.setTimeout(() => {
            log.info(`Creating debounced processed image for layer ${layer.id}`);
            try {
                const processedImage = this.createProcessedImage(layer);
                if (processedImage) {
                    this.processedImageCache.set(cacheKey, processedImage);
                    log.debug(`Cached debounced processed image for layer ${layer.id}`);
                    // Trigger re-render to show the processed image
                    this.canvas.render();
                }
            } catch (error) {
                log.error('Failed to create debounced processed image:', error);
            }
            
            // Clean up timer
            this.processedImageDebounceTimers.delete(layer.id);
        }, this.PROCESSED_IMAGE_DEBOUNCE_DELAY);

        this.processedImageDebounceTimers.set(layer.id, timer);
    }

    /**
     * Update last render time to track activity for debouncing
     */
    public updateLastRenderTime(): void {
        this.lastRenderTime = Date.now();
        log.debug(`Updated last render time for debouncing: ${this.lastRenderTime}`);
    }

    /**
     * Process all pending images immediately when user stops interacting
     */
    private processPendingImages(): void {
        // Clear all pending timers and process immediately
        for (const [layerId, timer] of this.processedImageDebounceTimers.entries()) {
            clearTimeout(timer);
            
            // Find the layer and process it
            const layer = this.canvas.layers.find(l => l.id === layerId);
            if (layer) {
                const cacheKey = this.getProcessedImageCacheKey(layer);
                if (!this.processedImageCache.has(cacheKey)) {
                    try {
                        const processedImage = this.createProcessedImage(layer);
                        if (processedImage) {
                            this.processedImageCache.set(cacheKey, processedImage);
                            log.debug(`Processed pending image for layer ${layer.id}`);
                        }
                    } catch (error) {
                        log.error(`Failed to process pending image for layer ${layer.id}:`, error);
                    }
                }
            }
        }
        
        this.processedImageDebounceTimers.clear();
        
        // Trigger re-render to show all processed images
        if (this.processedImageDebounceTimers.size > 0) {
            this.canvas.render();
        }
    }

    /**
     * Create a new processed image with all effects applied
     */
    private createProcessedImage(layer: Layer): HTMLImageElement | null {
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;

        // Create a canvas for the processed image
        const { canvas: processedCanvas, ctx: processedCtx } = createCanvas(layer.width, layer.height);
        if (!processedCtx) return null;

        if (needsBlendAreaEffect) {
            // Use the unified blend area drawing function
            this.drawLayerWithBlendArea(processedCtx, layer, 0, 0);
        } else {
            // Just apply crop effect without blend area
            this.drawLayerImageWithCrop(processedCtx, layer, 0, 0);
        }

        // Convert canvas to image
        const processedImage = new Image();
        processedImage.crossOrigin = 'anonymous';
        processedImage.src = processedCanvas.toDataURL();
        return processedImage;
    }

    /**
     * Helper method to draw layer image to a specific canvas context (position 0,0)
     * Uses the unified drawLayerImageWithCrop function
     */
    private _drawLayerImageToCanvas(ctx: CanvasRenderingContext2D, layer: Layer): void {
        this.drawLayerImageWithCrop(ctx, layer, 0, 0);
    }

    /**
     * Invalidate processed image cache for a specific layer
     */
    public invalidateProcessedImageCache(layerId: string): void {
        const keysToDelete: string[] = [];
        for (const key of this.processedImageCache.keys()) {
            if (key.startsWith(`${layerId}_`)) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => {
            this.processedImageCache.delete(key);
            log.debug(`Invalidated processed image cache for key: ${key}`);
        });

        // Also clear any pending timers for this layer
        const existingTimer = this.processedImageDebounceTimers.get(layerId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.processedImageDebounceTimers.delete(layerId);
            log.debug(`Cleared pending timer for layer ${layerId}`);
        }
    }

    /**
     * Clear all processed image cache
     */
    public clearProcessedImageCache(): void {
        this.processedImageCache.clear();
        
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
    private handleTransformEnd(layer: Layer, transformType: 'crop' | 'scale' | 'wheel', delay = 0): void {
        if (!layer.blendArea) return;
        
        const layerId = layer.id;
        const cacheKey = this.getProcessedImageCacheKey(layer);
        
        // Add to appropriate transforming set to continue live rendering
        let transformingSet: Set<string>;
        let transformName: string;
        
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
        const executeTransform = () => {
            try {
                const processedImage = this.createProcessedImage(layer);
                if (processedImage) {
                    this.processedImageCache.set(cacheKey, processedImage);
                    log.debug(`Cached processed image for layer ${layerId} after ${transformName} transform`);
                    
                    // Only now remove from live rendering set and trigger re-render
                    transformingSet.delete(layerId);
                    this.canvas.render();
                }
            } catch (error) {
                log.error(`Failed to create processed image after ${transformName} transform:`, error);
                // Fallback: remove from live rendering even if cache creation failed
                transformingSet.delete(layerId);
            }
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
                executeTransform();
                this.processedImageDebounceTimers.delete(timerKey);
            }, delay);
            
            this.processedImageDebounceTimers.set(timerKey, timer);
        } else {
            // For crop and scale, use immediate async approach
            setTimeout(executeTransform, 0);
        }
    }

    /**
     * Handle end of crop bounds transformation - create cache asynchronously but keep live rendering until ready
     */
    public handleCropBoundsTransformEnd(layer: Layer): void {
        if (!layer.cropMode || !layer.blendArea) return;
        this.handleTransformEnd(layer, 'crop', 0);
    }

    /**
     * Handle end of scale transformation - create cache asynchronously but keep live rendering until ready
     */
    public handleScaleTransformEnd(layer: Layer): void {
        if (!layer.blendArea) return;
        this.handleTransformEnd(layer, 'scale', 0);
    }

    /**
     * Handle end of wheel/button scaling - use debounced cache creation
     */
    public handleWheelScalingEnd(layer: Layer): void {
        if (!layer.blendArea) return;
        this.handleTransformEnd(layer, 'wheel', 500);
    }

    private getDistanceFieldMaskSync(imageOrCanvas: HTMLImageElement | HTMLCanvasElement, blendArea: number): HTMLCanvasElement | null {
        // Use a WeakMap for images, and a Map for canvases (since canvases are not always stable references)
        let cacheKey: any = imageOrCanvas;
        if (imageOrCanvas instanceof HTMLCanvasElement) {
            // For canvases, use a Map on this instance (not WeakMap)
            if (!this._canvasMaskCache) this._canvasMaskCache = new Map();
            let canvasCache = this._canvasMaskCache.get(imageOrCanvas);
            if (!canvasCache) {
                canvasCache = new Map();
                this._canvasMaskCache.set(imageOrCanvas, canvasCache);
            }
            if (canvasCache.has(blendArea)) {
                log.info(`Using cached distance field mask for blendArea: ${blendArea}% (canvas)`);
                return canvasCache.get(blendArea) || null;
            }
            try {
                log.info(`Creating distance field mask for blendArea: ${blendArea}% (canvas)`);
                const maskCanvas = createDistanceFieldMaskSync(imageOrCanvas as any, blendArea);
                log.info(`Distance field mask created successfully, size: ${maskCanvas.width}x${maskCanvas.height}`);
                canvasCache.set(blendArea, maskCanvas);
                return maskCanvas;
            } catch (error) {
                log.error('Failed to create distance field mask (canvas):', error);
                return null;
            }
        } else {
            // For images, use the original WeakMap cache
            let imageCache = this.distanceFieldCache.get(imageOrCanvas);
            if (!imageCache) {
                imageCache = new Map();
                this.distanceFieldCache.set(imageOrCanvas, imageCache);
            }
            let maskCanvas = imageCache.get(blendArea);
            if (!maskCanvas) {
                try {
                    log.info(`Creating distance field mask for blendArea: ${blendArea}%`);
                    maskCanvas = createDistanceFieldMaskSync(imageOrCanvas, blendArea);
                    log.info(`Distance field mask created successfully, size: ${maskCanvas.width}x${maskCanvas.height}`);
                    imageCache.set(blendArea, maskCanvas);
                } catch (error) {
                    log.error('Failed to create distance field mask:', error);
                    return null;
                }
            } else {
                log.info(`Using cached distance field mask for blendArea: ${blendArea}%`);
            }
            return maskCanvas;
        }
    }

    private _drawLayers(ctx: CanvasRenderingContext2D, layers: Layer[], options: { offsetX?: number, offsetY?: number } = {}): void {
        const sortedLayers = [...layers].sort((a: Layer, b: Layer) => a.zIndex - b.zIndex);
        sortedLayers.forEach(layer => {
            if (layer.visible) {
                this._drawLayer(ctx, layer, options);
            }
        });
    }

    public drawLayersToContext(ctx: CanvasRenderingContext2D, layers: Layer[], options: { offsetX?: number, offsetY?: number } = {}): void {
        this._drawLayers(ctx, layers, options);
    }

    async mirrorHorizontal(): Promise<void> {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer: Layer) => {
            layer.flipH = !layer.flipH;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }

    async mirrorVertical(): Promise<void> {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer: Layer) => {
            layer.flipV = !layer.flipV;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }

    async getLayerImageData(layer: Layer): Promise<string> {
        try {
            const width = layer.originalWidth || layer.width;
            const height = layer.originalHeight || layer.height;

            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(width, height, '2d', { willReadFrequently: true });
            if (!tempCtx) throw new Error("Could not create canvas context");

            // Use original image directly to ensure full quality
            tempCtx.drawImage(layer.image, 0, 0, width, height);
            
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

    updateOutputAreaSize(width: number, height: number, saveHistory = true): void {
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
    setOutputAreaSize(width: number, height: number): void {
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

    getHandles(layer: Layer): Record<string, Point> {
        const layerCenterX = layer.x + layer.width / 2;
        const layerCenterY = layer.y + layer.height / 2;
        const rad = layer.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

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
            handleCenterX = layerCenterX + (cropCenterX_local * cos - cropCenterY_local * sin);
            handleCenterY = layerCenterY + (cropCenterX_local * sin + cropCenterY_local * cos);
            
            halfW = cropRectW / 2;
            halfH = cropRectH / 2;
        } else {
            // TRANSFORM MODE: Handles are relative to the full layer transform frame
            handleCenterX = layerCenterX;
            handleCenterY = layerCenterY;
            halfW = layer.width / 2;
            halfH = layer.height / 2;
        }

    const localHandles: Record<string, Point> = {
        'n': { x: 0, y: -halfH }, 'ne': { x: halfW, y: -halfH },
        'e': { x: halfW, y: 0 }, 'se': { x: halfW, y: halfH },
        's': { x: 0, y: halfH }, 'sw': { x: -halfW, y: halfH },
        'w': { x: -halfW, y: 0 }, 'nw': { x: -halfW, y: -halfH },
        'rot': { x: 0, y: -halfH - 20 / this.canvas.viewport.zoom }
    };

        const worldHandles: Record<string, Point> = {};
        for (const key in localHandles) {
            const p = localHandles[key];
            worldHandles[key] = {
                x: handleCenterX + (p.x * cos - p.y * sin),
                y: handleCenterY + (p.x * sin + p.y * cos)
            };
        }
        return worldHandles;
    }

    getHandleAtPosition(worldX: number, worldY: number): { layer: Layer, handle: string } | null {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) return null;

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

    private currentCloseMenuListener: ((e: MouseEvent) => void) | null = null;
    
    updateBlendModeMenuPosition(): void {
        if (!this.blendMenuElement) return;

        const screenX = (this.blendMenuWorldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const screenY = (this.blendMenuWorldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;

        this.blendMenuElement.style.transform = `translate(${screenX}px, ${screenY}px)`;
    }

    showBlendModeMenu(worldX: number, worldY: number): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            return;
        }
        
        // Find which selected layer is at the click position (topmost visible layer at that position)
        let selectedLayer: Layer | null = null;
        const visibleSelectedLayers = this.canvas.canvasSelection.selectedLayers.filter((layer: Layer) => layer.visible);
        
        if (visibleSelectedLayers.length === 0) {
            return;
        }
        
        // Sort by zIndex descending and find the first one that contains the click point
        const sortedLayers = visibleSelectedLayers.sort((a: Layer, b: Layer) => b.zIndex - a.zIndex);
        
        for (const layer of sortedLayers) {
            const centerX = layer.x + layer.width / 2;
            const centerY = layer.y + layer.height / 2;
            
            // Transform click point to layer's local coordinates
            const dx = worldX - centerX;
            const dy = worldY - centerY;
            
            const rad = -layer.rotation * Math.PI / 180;
            const rotatedX = dx * Math.cos(rad) - dy * Math.sin(rad);
            const rotatedY = dx * Math.sin(rad) + dy * Math.cos(rad);
            
            const withinX = Math.abs(rotatedX) <= layer.width / 2;
            const withinY = Math.abs(rotatedY) <= layer.height / 2;
            
            // Check if click is within layer bounds
            if (withinX && withinY) {
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
        menu.id = 'blend-mode-menu';

        const titleBar = document.createElement('div');
        titleBar.className = 'blend-menu-title-bar';
        
        const titleText = document.createElement('span');
        titleText.textContent = `Blend Mode: ${selectedLayer.name}`;
        titleText.className = 'blend-menu-title-text';
        
        const closeButton = document.createElement('button');
        closeButton.textContent = '×';
        closeButton.className = 'blend-menu-close-button';
        
        closeButton.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            this.closeBlendModeMenu();
        };
        
        titleBar.appendChild(titleText);
        titleBar.appendChild(closeButton);

        const content = document.createElement('div');
        content.className = 'blend-menu-content';

        menu.appendChild(titleBar);
        menu.appendChild(content);

        const blendAreaContainer = document.createElement('div');
        blendAreaContainer.className = 'blend-area-container';
    
        const blendAreaLabel = document.createElement('label');
        blendAreaLabel.textContent = 'Blend Area';
        blendAreaLabel.className = 'blend-area-label';
        
        const blendAreaSlider = document.createElement('input');
        blendAreaSlider.type = 'range';
        blendAreaSlider.min = '0';
        blendAreaSlider.max = '100';
        blendAreaSlider.className = 'blend-area-slider';
        
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
                
                // Create processed image asynchronously
                setTimeout(() => {
                    try {
                        const processedImage = this.createProcessedImage(selectedLayer);
                        if (processedImage) {
                            this.processedImageCache.set(cacheKey, processedImage);
                            log.debug(`Cached processed image for layer ${layerId} after slider change`);
                            
                            // Only now remove from live rendering set and trigger re-render
                            this.layersAdjustingBlendArea.delete(layerId);
                            this.canvas.render();
                        }
                    } catch (error) {
                        log.error('Failed to create processed image after slider change:', error);
                        // Fallback: remove from live rendering even if cache creation failed
                        this.layersAdjustingBlendArea.delete(layerId);
                    }
                }, 0); // Use setTimeout to make it asynchronous
            }
            this.canvas.saveState();
        });
        
        blendAreaContainer.appendChild(blendAreaLabel);
        blendAreaContainer.appendChild(blendAreaSlider);
        content.appendChild(blendAreaContainer);

        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };

        // Drag logic needs to update world coordinates, not screen coordinates
        const handleMouseMove = (e: MouseEvent) => {
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
        
        titleBar.addEventListener('mousedown', (e: MouseEvent) => {
            isDragging = true;
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        this.blendModes.forEach((mode: BlendMode) => {
            const container = document.createElement('div');
            container.className = 'blend-mode-container';

            const option = document.createElement('div');
            option.className = 'blend-mode-option';
            option.textContent = `${mode.label} (${mode.name})`;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.className = 'blend-opacity-slider';
            const selectedLayer = this.canvas.canvasSelection.selectedLayers[0];
            slider.value = selectedLayer ? String(Math.round(selectedLayer.opacity * 100)) : '100';

            if (selectedLayer && selectedLayer.blendMode === mode.name) {
                container.classList.add('active');
                option.classList.add('active');
            }

            option.onclick = () => {
                // Re-check selected layer at the time of click
                const currentSelectedLayer = this.canvas.canvasSelection.selectedLayers[0];
                if (!currentSelectedLayer) {
                    return;
                }
                
                // Remove active class from all containers and options
                content.querySelectorAll<HTMLDivElement>('.blend-mode-container').forEach(c => {
                    c.classList.remove('active');
                    const optionDiv = c.querySelector<HTMLDivElement>('.blend-mode-option');
                    if (optionDiv) {
                        optionDiv.classList.remove('active');
                    }
                });

                // Add active class to current container and option
                container.classList.add('active');
                option.classList.add('active');

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
                    const saveWithFallback = async (fileName: string) => {
                        try {
                            const uniqueFileName = generateUniqueFileName(fileName, this.canvas.node.id);
                            return await this.canvas.canvasIO.saveToServer(uniqueFileName);
                        } catch (error) {
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
        menu.addEventListener('contextmenu', (e: MouseEvent) => {
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

        const closeMenu = (e: MouseEvent) => {
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

    closeBlendModeMenu(): void {
        log.info("=== BLEND MODE MENU CLOSING ===");
        if (this.blendMenuElement && this.blendMenuElement.parentNode) {
            log.info("Removing blend mode menu from DOM");
            this.blendMenuElement.parentNode.removeChild(this.blendMenuElement);
            this.blendMenuElement = null;
        } else {
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
    private async _generateCanvasBlob(options: {
        layers?: Layer[];           // Które warstwy renderować (domyślnie wszystkie)
        useOutputBounds?: boolean;  // Czy używać output area bounds (domyślnie true)
        applyMask?: boolean;        // Czy aplikować maskę (domyślnie false)
        enableLogging?: boolean;    // Czy włączyć szczegółowe logi (domyślnie false)
        customBounds?: { x: number, y: number, width: number, height: number }; // Niestandardowe bounds
    } = {}): Promise<Blob | null> {
        const {
            layers = this.canvas.layers,
            useOutputBounds = true,
            applyMask = false,
            enableLogging = false,
            customBounds
        } = options;

        return new Promise((resolve, reject) => {
            let bounds: { x: number, y: number, width: number, height: number };

            if (customBounds) {
                bounds = customBounds;
            } else if (useOutputBounds) {
                bounds = this.canvas.outputAreaBounds;
            } else {
                // Oblicz bounding box dla wybranych warstw
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                layers.forEach((layer: Layer) => {
                    const centerX = layer.x + layer.width / 2;
                    const centerY = layer.y + layer.height / 2;
                    const rad = layer.rotation * Math.PI / 180;
                    const cos = Math.cos(rad);
                    const sin = Math.sin(rad);

                    const halfW = layer.width / 2;
                    const halfH = layer.height / 2;

                    const corners = [
                        { x: -halfW, y: -halfH },
                        { x: halfW, y: -halfH },
                        { x: halfW, y: halfH },
                        { x: -halfW, y: halfH }
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

                bounds = { x: minX, y: minY, width: newWidth, height: newHeight };
            }

            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(bounds.width, bounds.height, '2d', { willReadFrequently: true });
            if (!tempCtx) {
                reject(new Error("Could not create canvas context"));
                return;
            }

            if (enableLogging) {
                log.info("=== GENERATING OUTPUT CANVAS ===");
                log.info(`Bounds: x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}`);
                log.info(`Canvas Size: ${tempCanvas.width}x${tempCanvas.height}`);
                log.info(`Context Translation: translate(${-bounds.x}, ${-bounds.y})`);
                log.info(`Apply Mask: ${applyMask}`);
                
                // Log layer positions before rendering
                layers.forEach((layer: Layer, index: number) => {
                    if (layer.visible) {
                        const relativeToOutput = {
                            x: layer.x - bounds.x,
                            y: layer.y - bounds.y
                        };
                        log.info(`Layer ${index + 1} "${layer.name}": world(${layer.x.toFixed(1)}, ${layer.y.toFixed(1)}) relative_to_bounds(${relativeToOutput.x.toFixed(1)}, ${relativeToOutput.y.toFixed(1)}) size(${layer.width.toFixed(1)}x${layer.height.toFixed(1)})`);
                    }
                });
            }

            // Renderuj fragment świata zdefiniowany przez bounds
            tempCtx.translate(-bounds.x, -bounds.y);
            this._drawLayers(tempCtx, layers);

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
                } else {
                    resolve(null);
                }
            }, 'image/png');
        });
    }

    // Publiczne metody używające zunifikowanej funkcji
    async getFlattenedCanvasWithMaskAsBlob(): Promise<Blob | null> {
        return this._generateCanvasBlob({
            layers: this.canvas.layers,
            useOutputBounds: true,
            applyMask: true,
            enableLogging: true
        });
    }
    
    async getFlattenedCanvasAsBlob(): Promise<Blob | null> {
        return this._generateCanvasBlob({
            layers: this.canvas.layers,
            useOutputBounds: true,
            applyMask: false,
            enableLogging: true
        });
    }
    
    async getFlattenedSelectionAsBlob(): Promise<Blob | null> {
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

    async getFlattenedMaskAsBlob(): Promise<Blob | null> {
        return new Promise((resolve, reject) => {
            const bounds = this.canvas.outputAreaBounds;
            const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(bounds.width, bounds.height, '2d', { willReadFrequently: true });
            
            if (!maskCtx) {
                reject(new Error("Could not create mask context"));
                return;
            }
            
            log.info("=== GENERATING MASK BLOB ===");
            log.info(`Mask Canvas Size: ${maskCanvas.width}x${maskCanvas.height}`);
            
            // Rozpocznij z białą maską (nic nie zamaskowane)
            maskCtx.fillStyle = '#ffffff';
            maskCtx.fillRect(0, 0, bounds.width, bounds.height);

            // Stwórz canvas do sprawdzenia przezroczystości warstw
            const { canvas: visibilityCanvas, ctx: visibilityCtx } = createCanvas(bounds.width, bounds.height, '2d', { alpha: true });
            if (!visibilityCtx) {
                reject(new Error("Could not create visibility context"));
                return;
            }
            
            // Renderuj warstwy z przesunięciem dla output bounds
            visibilityCtx.translate(-bounds.x, -bounds.y);
            this._drawLayers(visibilityCtx, this.canvas.layers);

            // Konwertuj przezroczystość warstw na maskę
            const visibilityData = visibilityCtx.getImageData(0, 0, bounds.width, bounds.height);
            const maskData = maskCtx.getImageData(0, 0, bounds.width, bounds.height);
            for (let i = 0; i < visibilityData.data.length; i += 4) {
                const alpha = visibilityData.data[i + 3];
                const maskValue = 255 - alpha; // Odwróć alpha żeby stworzyć maskę
                maskData.data[i] = maskData.data[i + 1] = maskData.data[i + 2] = maskValue;
                maskData.data[i + 3] = 255; // Solidna maska
            }
            maskCtx.putImageData(maskData, 0, 0);

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
                } else {
                    resolve(null);
                }
            }, 'image/png');
        });
    }

    async fuseLayers(): Promise<void> {
        if (this.canvas.canvasSelection.selectedLayers.length < 2) {
            showErrorNotification("Please select at least 2 layers to fuse.");
            return;
        }

        log.info(`Fusing ${this.canvas.canvasSelection.selectedLayers.length} selected layers`);

        try {
            this.canvas.saveState();

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.canvas.canvasSelection.selectedLayers.forEach((layer: Layer) => {
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                const halfW = layer.width / 2;
                const halfH = layer.height / 2;

                const corners = [
                    { x: -halfW, y: -halfH },
                    { x: halfW, y: -halfH },
                    { x: halfW, y: halfH },
                    { x: -halfW, y: halfH }
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

            const fusedWidth = Math.ceil(maxX - minX);
            const fusedHeight = Math.ceil(maxY - minY);

            if (fusedWidth <= 0 || fusedHeight <= 0) {
                log.warn("Calculated fused layer dimensions are invalid");
                showErrorNotification("Cannot fuse layers: invalid dimensions calculated.");
                return;
            }

            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(fusedWidth, fusedHeight, '2d', { willReadFrequently: true });
            if (!tempCtx) throw new Error("Could not create canvas context");

            tempCtx.translate(-minX, -minY);

            this._drawLayers(tempCtx, this.canvas.canvasSelection.selectedLayers);

            const fusedImage = new Image();
            fusedImage.crossOrigin = 'anonymous';
            fusedImage.src = tempCanvas.toDataURL();
            await new Promise((resolve, reject) => {
                fusedImage.onload = resolve;
                fusedImage.onerror = reject;
            });

            const minZIndex = Math.min(...this.canvas.canvasSelection.selectedLayers.map((layer: Layer) => layer.zIndex));
            const imageId = generateUUID();
            await saveImage(imageId, fusedImage.src);
            this.canvas.imageCache.set(imageId, fusedImage.src);

            const fusedLayer: Layer = {
                id: generateUUID(),
                image: fusedImage,
                imageId: imageId,
                name: 'Fused Layer',
                x: minX,
                y: minY,
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

            this.canvas.layers = this.canvas.layers.filter((layer: Layer) => !this.canvas.canvasSelection.selectedLayers.includes(layer));
            this.canvas.layers.push(fusedLayer);
            this.canvas.layers.sort((a: Layer, b: Layer) => a.zIndex - b.zIndex);
            this.canvas.layers.forEach((layer: Layer, index: number) => {
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
                fusedPosition: { x: minX, y: minY }
            });

        } catch (error: any) {
            log.error("Error during layer fusion:", error);
            showErrorNotification(`Error fusing layers: ${error.message}`);
        }
    }
}
