import { saveImage } from "./db.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { generateUUID, generateUniqueFileName } from "./utils/CommonUtils.js";
import { withErrorHandling, createValidationError } from "./ErrorHandler.js";
// @ts-ignore
import { app } from "../../scripts/app.js";
// @ts-ignore
import { ComfyApp } from "../../scripts/app.js";
import { ClipboardManager } from "./utils/ClipboardManager.js";
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
            // Use the targetArea if provided, otherwise default to the current canvas dimensions
            const area = targetArea || { width: this.canvas.width, height: this.canvas.height, x: 0, y: 0 };
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
                zIndex: this.canvas.layers.length,
                blendMode: 'normal',
                opacity: 1,
                ...layerProps
            };
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
        this.internalClipboard.forEach((clipboardLayer) => {
            const newLayer = {
                ...clipboardLayer,
                x: clipboardLayer.x + offsetX,
                y: clipboardLayer.y + offsetY,
                zIndex: this.canvas.layers.length
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
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            tempCanvas.width = layer.width;
            tempCanvas.height = layer.height;
            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
            tempCtx.save();
            tempCtx.translate(layer.width / 2, layer.height / 2);
            tempCtx.rotate(layer.rotation * Math.PI / 180);
            tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
            tempCtx.restore();
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
        `;
        titleBar.textContent = 'Blend Mode';
        const content = document.createElement('div');
        content.style.cssText = `padding: 5px;`;
        menu.appendChild(titleBar);
        menu.appendChild(content);
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
                content.querySelectorAll('input[type="range"]').forEach(s => s.style.display = 'none');
                content.querySelectorAll('.blend-mode-container div').forEach(d => d.style.backgroundColor = '');
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
    showOpacitySlider(mode) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = String(this.blendOpacity);
        slider.className = 'blend-opacity-slider';
        slider.addEventListener('input', (e) => {
            this.blendOpacity = parseInt(e.target.value, 10);
        });
        const modeElement = document.querySelector(`[data-blend-mode="${mode}"]`);
        if (modeElement) {
            modeElement.appendChild(slider);
        }
    }
    async getFlattenedCanvasWithMaskAsBlob() {
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) {
                reject(new Error("Could not create canvas context"));
                return;
            }
            const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);
            sortedLayers.forEach((layer) => {
                if (!layer.image)
                    return;
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
            });
            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            const data = imageData.data;
            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {
                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.canvas.width;
                tempMaskCanvas.height = this.canvas.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d');
                if (!tempMaskCtx) {
                    reject(new Error("Could not create mask canvas context"));
                    return;
                }
                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);
                const maskX = this.canvas.maskTool.x;
                const maskY = this.canvas.maskTool.y;
                const sourceX = Math.max(0, -maskX);
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);
                const destY = Math.max(0, maskY);
                const copyWidth = Math.min(toolMaskCanvas.width - sourceX, this.canvas.width - destX);
                const copyHeight = Math.min(toolMaskCanvas.height - sourceY, this.canvas.height - destY);
                if (copyWidth > 0 && copyHeight > 0) {
                    tempMaskCtx.drawImage(toolMaskCanvas, sourceX, sourceY, copyWidth, copyHeight, destX, destY, copyWidth, copyHeight);
                }
                const tempMaskData = tempMaskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                for (let i = 0; i < tempMaskData.data.length; i += 4) {
                    const alpha = tempMaskData.data[i + 3];
                    tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = 255;
                    tempMaskData.data[i + 3] = alpha;
                }
                tempMaskCtx.putImageData(tempMaskData, 0, 0);
                const maskImageData = tempMaskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                const maskData = maskImageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const originalAlpha = data[i + 3];
                    const maskAlpha = maskData[i + 3] / 255;
                    const invertedMaskAlpha = 1 - maskAlpha;
                    data[i + 3] = originalAlpha * invertedMaskAlpha;
                }
                tempCtx.putImageData(imageData, 0, 0);
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
    async getFlattenedCanvasAsBlob() {
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) {
                reject(new Error("Could not create canvas context"));
                return;
            }
            const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);
            sortedLayers.forEach((layer) => {
                if (!layer.image)
                    return;
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
            });
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
    async getFlattenedCanvasForMaskEditor() {
        return this.getFlattenedCanvasWithMaskAsBlob();
    }
    async getFlattenedSelectionAsBlob() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            return null;
        }
        return new Promise((resolve, reject) => {
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
            const newWidth = Math.ceil(maxX - minX);
            const newHeight = Math.ceil(maxY - minY);
            if (newWidth <= 0 || newHeight <= 0) {
                resolve(null);
                return;
            }
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = newWidth;
            tempCanvas.height = newHeight;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) {
                reject(new Error("Could not create canvas context"));
                return;
            }
            tempCtx.translate(-minX, -minY);
            const sortedSelection = [...this.canvas.canvasSelection.selectedLayers].sort((a, b) => a.zIndex - b.zIndex);
            sortedSelection.forEach((layer) => {
                if (!layer.image)
                    return;
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                const scaleH = layer.flipH ? -1 : 1;
                const scaleV = layer.flipV ? -1 : 1;
                if (layer.flipH || layer.flipV) {
                    tempCtx.scale(scaleH, scaleV);
                }
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
            });
            tempCanvas.toBlob((blob) => {
                resolve(blob);
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
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx)
                throw new Error("Could not create canvas context");
            tempCtx.translate(-minX, -minY);
            const sortedSelection = [...this.canvas.canvasSelection.selectedLayers].sort((a, b) => a.zIndex - b.zIndex);
            sortedSelection.forEach((layer) => {
                if (!layer.image)
                    return;
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                const scaleH = layer.flipH ? -1 : 1;
                const scaleV = layer.flipV ? -1 : 1;
                if (layer.flipH || layer.flipV) {
                    tempCtx.scale(scaleH, scaleV);
                }
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
            });
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
                opacity: 1
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
                originalLayerCount: sortedSelection.length,
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
