import { saveImage } from "./db.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { generateUUID, generateUniqueFileName } from "./utils/CommonUtils.js";
import { withErrorHandling, createValidationError } from "./ErrorHandler.js";
// @ts-ignore
import { app } from "../../scripts/app.js";
// @ts-ignore
import { ComfyApp } from "../../scripts/app.js";
import { ClipboardManager } from "./utils/ClipboardManager.js";
import { createDistanceFieldMask } from "./utils/ImageAnalysis.js";
const log = createModuleLogger('CanvasLayers');
export class CanvasLayers {
    constructor(canvas) {
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
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d');
                if (tempCtx) {
                    tempCanvas.width = layer.width;
                    tempCanvas.height = layer.height;
                    tempCtx.drawImage(layer.image, 0, 0, layer.width, layer.height);
                    const maskCanvas = document.createElement('canvas');
                    const maskCtx = maskCanvas.getContext('2d');
                    if (maskCtx) {
                        maskCanvas.width = layer.width;
                        maskCanvas.height = layer.height;
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
        this.canvas = canvas;
        this.clipboardManager = new ClipboardManager(canvas);
        this.distanceFieldCache = new WeakMap();
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
                const dataURL = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                const img = new Image();
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
        for (let i = this.canvas.layers.length - 1; i >= 0; i--) {
            const layer = this.canvas.layers[i];
            // Skip invisible layers
            if (!layer.visible)
                continue;
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
        // Check if we need to apply blend area effect
        const blendArea = layer.blendArea ?? 0;
        const needsBlendAreaEffect = blendArea > 0;
        log.info(`Drawing layer ${layer.id}: blendArea=${blendArea}, needsBlendAreaEffect=${needsBlendAreaEffect}`);
        if (needsBlendAreaEffect) {
            log.info(`Applying blend area effect for layer ${layer.id}`);
            // Get or create distance field mask
            let maskCanvas = this.getDistanceFieldMask(layer.image, blendArea);
            if (maskCanvas) {
                // Create a temporary canvas for the masked layer
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = layer.width;
                tempCanvas.height = layer.height;
                const tempCtx = tempCanvas.getContext('2d');
                if (tempCtx) {
                    // Draw the original image
                    tempCtx.drawImage(layer.image, 0, 0, layer.width, layer.height);
                    // Apply the distance field mask using destination-in for transparency effect
                    tempCtx.globalCompositeOperation = 'destination-in';
                    tempCtx.drawImage(maskCanvas, 0, 0, layer.width, layer.height);
                    // Draw the result
                    ctx.globalCompositeOperation = layer.blendMode || 'normal';
                    ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                    ctx.drawImage(tempCanvas, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                }
                else {
                    // Fallback to normal drawing
                    ctx.globalCompositeOperation = layer.blendMode || 'normal';
                    ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                    ctx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                }
            }
            else {
                // Fallback to normal drawing
                ctx.globalCompositeOperation = layer.blendMode || 'normal';
                ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                ctx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
            }
        }
        else {
            // Normal drawing without blend area effect
            ctx.globalCompositeOperation = layer.blendMode || 'normal';
            ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
            ctx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
        }
        ctx.restore();
    }
    getDistanceFieldMask(image, blendArea) {
        // Check cache first
        let imageCache = this.distanceFieldCache.get(image);
        if (!imageCache) {
            imageCache = new Map();
            this.distanceFieldCache.set(image, imageCache);
        }
        let maskCanvas = imageCache.get(blendArea);
        if (!maskCanvas) {
            try {
                log.info(`Creating distance field mask for blendArea: ${blendArea}%`);
                maskCanvas = createDistanceFieldMask(image, blendArea);
                log.info(`Distance field mask created successfully, size: ${maskCanvas.width}x${maskCanvas.height}`);
                imageCache.set(blendArea, maskCanvas);
            }
            catch (error) {
                log.error('Failed to create distance field mask:', error);
                return null;
            }
        }
        else {
            log.info(`Using cached distance field mask for blendArea: ${blendArea}%`);
        }
        return maskCanvas;
    }
    _drawLayers(ctx, layers, options = {}) {
        const sortedLayers = [...layers].sort((a, b) => a.zIndex - b.zIndex);
        sortedLayers.forEach(layer => {
            if (layer.visible) {
                this._drawLayer(ctx, layer, options);
            }
        });
    }
    drawLayersToContext(ctx, layers, options = {}) {
        this._drawLayers(ctx, layers, options);
    }
    async mirrorHorizontal() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            layer.flipH = !layer.flipH;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }
    async mirrorVertical() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0)
            return;
        this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
            layer.flipV = !layer.flipV;
        });
        this.canvas.render();
        this.canvas.requestSaveState();
    }
    async getLayerImageData(layer) {
        try {
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            tempCanvas.width = layer.width;
            tempCanvas.height = layer.height;
            // We need to draw the layer relative to the new canvas, so we "move" it to 0,0
            // by creating a temporary layer object for drawing.
            const layerToDraw = {
                ...layer,
                x: 0,
                y: 0,
            };
            this._drawLayer(tempCtx, layerToDraw);
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
        this.canvas.canvas.width = width;
        this.canvas.canvas.height = height;
        this.canvas.render();
        if (saveHistory) {
            this.canvas.canvasState.saveStateToDB();
        }
    }
    getHandles(layer) {
        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        const rad = layer.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const halfW = layer.width / 2;
        const halfH = layer.height / 2;
        const localHandles = {
            'n': { x: 0, y: -halfH },
            'ne': { x: halfW, y: -halfH },
            'e': { x: halfW, y: 0 },
            'se': { x: halfW, y: halfH },
            's': { x: 0, y: halfH },
            'sw': { x: -halfW, y: halfH },
            'w': { x: -halfW, y: 0 },
            'nw': { x: -halfW, y: -halfH },
            'rot': { x: 0, y: -halfH - 20 / this.canvas.viewport.zoom }
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
    showBlendModeMenu(x, y) {
        this.closeBlendModeMenu();
        const menu = document.createElement('div');
        menu.id = 'blend-mode-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            border-radius: 4px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            min-width: 200px;
        `;
        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            background: #3a3a3a;
            color: white;
            padding: 8px 10px;
            cursor: move;
            user-select: none;
            border-radius: 3px 3px 0 0;
            font-size: 12px;
            font-weight: bold;
            border-bottom: 1px solid #4a4a4a;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        const titleText = document.createElement('span');
        titleText.textContent = 'Blend Mode';
        titleText.style.cssText = `
            flex: 1;
            cursor: move;
        `;
        const closeButton = document.createElement('button');
        closeButton.textContent = '×';
        closeButton.style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 18px;
            cursor: pointer;
            padding: 0;
            margin: 0;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            transition: background-color 0.2s;
        `;
        closeButton.onmouseover = () => {
            closeButton.style.backgroundColor = '#4a4a4a';
        };
        closeButton.onmouseout = () => {
            closeButton.style.backgroundColor = 'transparent';
        };
        closeButton.onclick = (e) => {
            e.stopPropagation();
            this.closeBlendModeMenu();
        };
        titleBar.appendChild(titleText);
        titleBar.appendChild(closeButton);
        const content = document.createElement('div');
        content.style.cssText = `padding: 5px;`;
        menu.appendChild(titleBar);
        menu.appendChild(content);
        const blendAreaContainer = document.createElement('div');
        blendAreaContainer.style.cssText = `padding: 5px 10px; border-bottom: 1px solid #4a4a4a;`;
        const blendAreaLabel = document.createElement('label');
        blendAreaLabel.textContent = 'Blend Area';
        blendAreaLabel.style.color = 'white';
        const blendAreaSlider = document.createElement('input');
        blendAreaSlider.type = 'range';
        blendAreaSlider.min = '0';
        blendAreaSlider.max = '100';
        const selectedLayerForBlendArea = this.canvas.canvasSelection.selectedLayers[0];
        blendAreaSlider.value = selectedLayerForBlendArea?.blendArea?.toString() ?? '0';
        blendAreaSlider.oninput = () => {
            if (selectedLayerForBlendArea) {
                const newValue = parseInt(blendAreaSlider.value, 10);
                selectedLayerForBlendArea.blendArea = newValue;
                log.info(`Blend Area changed to: ${newValue}% for layer: ${selectedLayerForBlendArea.id}`);
                this.canvas.render();
            }
        };
        blendAreaSlider.addEventListener('change', () => {
            this.canvas.saveState();
        });
        blendAreaContainer.appendChild(blendAreaLabel);
        blendAreaContainer.appendChild(blendAreaSlider);
        content.appendChild(blendAreaContainer);
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        const handleMouseMove = (e) => {
            if (isDragging) {
                const newX = e.clientX - dragOffset.x;
                const newY = e.clientY - dragOffset.y;
                const maxX = window.innerWidth - menu.offsetWidth;
                const maxY = window.innerHeight - menu.offsetHeight;
                menu.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
                menu.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
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
            dragOffset.x = e.clientX - parseInt(menu.style.left, 10);
            dragOffset.y = e.clientY - parseInt(menu.style.top, 10);
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
        this.blendModes.forEach((mode) => {
            const container = document.createElement('div');
            container.className = 'blend-mode-container';
            container.style.cssText = `margin-bottom: 5px;`;
            const option = document.createElement('div');
            option.style.cssText = `padding: 5px 10px; color: white; cursor: pointer; transition: background-color 0.2s;`;
            option.textContent = `${mode.label} (${mode.name})`;
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            const selectedLayer = this.canvas.canvasSelection.selectedLayers[0];
            slider.value = selectedLayer ? String(Math.round(selectedLayer.opacity * 100)) : '100';
            slider.style.cssText = `width: 100%; margin: 5px 0; display: none;`;
            if (selectedLayer && selectedLayer.blendMode === mode.name) {
                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';
            }
            option.onclick = () => {
                // Hide only the opacity sliders within other blend mode containers
                content.querySelectorAll('.blend-mode-container').forEach(c => {
                    const opacitySlider = c.querySelector('input[type="range"]');
                    if (opacitySlider) {
                        opacitySlider.style.display = 'none';
                    }
                    const optionDiv = c.querySelector('div');
                    if (optionDiv) {
                        optionDiv.style.backgroundColor = '';
                    }
                });
                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';
                if (selectedLayer) {
                    selectedLayer.blendMode = mode.name;
                    this.canvas.render();
                }
            };
            slider.addEventListener('input', () => {
                if (selectedLayer) {
                    selectedLayer.opacity = parseInt(slider.value, 10) / 100;
                    this.canvas.render();
                }
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
        const container = this.canvas.canvas.parentElement || document.body;
        container.appendChild(menu);
        const closeMenu = (e) => {
            if (e.target instanceof Node && !menu.contains(e.target) && !isDragging) {
                this.closeBlendModeMenu();
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
    }
    closeBlendModeMenu() {
        const menu = document.getElementById('blend-mode-menu');
        if (menu && menu.parentNode) {
            menu.parentNode.removeChild(menu);
        }
    }
    /**
     * Zunifikowana funkcja do generowania blob z canvas
     * @param options Opcje renderowania
     */
    async _generateCanvasBlob(options = {}) {
        const { layers = this.canvas.layers, useOutputBounds = true, applyMask = false, enableLogging = false, customBounds } = options;
        return new Promise((resolve, reject) => {
            let bounds;
            if (customBounds) {
                bounds = customBounds;
            }
            else if (useOutputBounds) {
                bounds = this.canvas.outputAreaBounds;
            }
            else {
                // Oblicz bounding box dla wybranych warstw
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                layers.forEach((layer) => {
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
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = bounds.width;
            tempCanvas.height = bounds.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
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
            // Renderuj fragment świata zdefiniowany przez bounds
            tempCtx.translate(-bounds.x, -bounds.y);
            this._drawLayers(tempCtx, layers);
            // Aplikuj maskę jeśli wymagana
            if (applyMask) {
                const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
                const data = imageData.data;
                const toolMaskCanvas = this.canvas.maskTool.getMask();
                if (toolMaskCanvas) {
                    const tempMaskCanvas = document.createElement('canvas');
                    tempMaskCanvas.width = bounds.width;
                    tempMaskCanvas.height = bounds.height;
                    const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });
                    if (!tempMaskCtx) {
                        reject(new Error("Could not create mask canvas context"));
                        return;
                    }
                    tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);
                    // Pozycja maski w świecie (bez przesunięcia względem bounds)
                    const maskWorldX = this.canvas.maskTool.x;
                    const maskWorldY = this.canvas.maskTool.y;
                    // Pozycja maski względem output bounds (gdzie ma być narysowana w output canvas)
                    const maskX = maskWorldX - bounds.x;
                    const maskY = maskWorldY - bounds.y;
                    const sourceX = Math.max(0, -maskX);
                    const sourceY = Math.max(0, -maskY);
                    const destX = Math.max(0, maskX);
                    const destY = Math.max(0, maskY);
                    const copyWidth = Math.min(toolMaskCanvas.width - sourceX, bounds.width - destX);
                    const copyHeight = Math.min(toolMaskCanvas.height - sourceY, bounds.height - destY);
                    if (copyWidth > 0 && copyHeight > 0) {
                        tempMaskCtx.drawImage(toolMaskCanvas, sourceX, sourceY, copyWidth, copyHeight, destX, destY, copyWidth, copyHeight);
                    }
                    const tempMaskData = tempMaskCtx.getImageData(0, 0, bounds.width, bounds.height);
                    for (let i = 0; i < tempMaskData.data.length; i += 4) {
                        const alpha = tempMaskData.data[i + 3];
                        tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = 255;
                        tempMaskData.data[i + 3] = alpha;
                    }
                    tempMaskCtx.putImageData(tempMaskData, 0, 0);
                    const maskImageData = tempMaskCtx.getImageData(0, 0, bounds.width, bounds.height);
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
        return new Promise((resolve, reject) => {
            const bounds = this.canvas.outputAreaBounds;
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = bounds.width;
            maskCanvas.height = bounds.height;
            const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
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
            const visibilityCanvas = document.createElement('canvas');
            visibilityCanvas.width = bounds.width;
            visibilityCanvas.height = bounds.height;
            const visibilityCtx = visibilityCanvas.getContext('2d', { alpha: true });
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
            // Aplikuj maskę narzędzia jeśli istnieje
            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {
                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = bounds.width;
                tempMaskCanvas.height = bounds.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });
                if (!tempMaskCtx) {
                    reject(new Error("Could not create temp mask context"));
                    return;
                }
                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);
                // Pozycja maski w świecie (bez przesunięcia względem bounds)
                const maskWorldX = this.canvas.maskTool.x;
                const maskWorldY = this.canvas.maskTool.y;
                // Pozycja maski względem output bounds (gdzie ma być narysowana w output canvas)
                const maskX = maskWorldX - bounds.x;
                const maskY = maskWorldY - bounds.y;
                log.debug(`[getFlattenedMaskAsBlob] Mask world position (${maskWorldX}, ${maskWorldY}) relative to bounds (${maskX}, ${maskY})`);
                const sourceX = Math.max(0, -maskX);
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);
                const destY = Math.max(0, maskY);
                const copyWidth = Math.min(toolMaskCanvas.width - sourceX, bounds.width - destX);
                const copyHeight = Math.min(toolMaskCanvas.height - sourceY, bounds.height - destY);
                if (copyWidth > 0 && copyHeight > 0) {
                    tempMaskCtx.drawImage(toolMaskCanvas, sourceX, sourceY, copyWidth, copyHeight, destX, destY, copyWidth, copyHeight);
                }
                const tempMaskData = tempMaskCtx.getImageData(0, 0, bounds.width, bounds.height);
                for (let i = 0; i < tempMaskData.data.length; i += 4) {
                    const alpha = tempMaskData.data[i + 3];
                    tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = alpha;
                    tempMaskData.data[i + 3] = 255; // Solidna alpha
                }
                tempMaskCtx.putImageData(tempMaskData, 0, 0);
                maskCtx.globalCompositeOperation = 'screen';
                maskCtx.drawImage(tempMaskCanvas, 0, 0);
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
            alert("Please select at least 2 layers to fuse.");
            return;
        }
        log.info(`Fusing ${this.canvas.canvasSelection.selectedLayers.length} selected layers`);
        try {
            this.canvas.saveState();
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.canvas.canvasSelection.selectedLayers.forEach((layer) => {
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
                alert("Cannot fuse layers: invalid dimensions calculated.");
                return;
            }
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = fusedWidth;
            tempCanvas.height = fusedHeight;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            tempCtx.translate(-minX, -minY);
            this._drawLayers(tempCtx, this.canvas.canvasSelection.selectedLayers);
            const fusedImage = new Image();
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
                fusedPosition: { x: minX, y: minY }
            });
        }
        catch (error) {
            log.error("Error during layer fusion:", error);
            alert(`Error fusing layers: ${error.message}`);
        }
    }
}
