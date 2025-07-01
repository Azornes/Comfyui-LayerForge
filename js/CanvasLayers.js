import {saveImage, removeImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {generateUUID, generateUniqueFileName} from "./utils/CommonUtils.js";
import {withErrorHandling, createValidationError} from "./ErrorHandler.js";
import {app, ComfyApp} from "../../scripts/app.js";
import {ClipboardManager} from "./utils/ClipboardManager.js";

const log = createModuleLogger('CanvasLayers');

export class CanvasLayers {
    constructor(canvas) {
        this.canvas = canvas;
        this.clipboardManager = new ClipboardManager(canvas);
        this.blendModes = [
            {name: 'normal', label: 'Normal'},
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
            {name: 'exclusion', label: 'Exclusion'}
        ];
        this.selectedBlendMode = null;
        this.blendOpacity = 100;
        this.isAdjustingOpacity = false;
        this.internalClipboard = [];
        this.clipboardPreference = 'system'; // 'system', 'clipspace'
    }

    async copySelectedLayers() {
        if (this.canvas.selectedLayers.length === 0) return;

        this.internalClipboard = this.canvas.selectedLayers.map(layer => ({...layer}));
        log.info(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);

        const blob = await this.getFlattenedSelectionAsBlob();
        if (!blob) {
            log.warn("Failed to create flattened selection blob");
            return;
        }

        if (this.clipboardPreference === 'clipspace') {
            try {

                const dataURL = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });

                const img = new Image();
                img.onload = () => {

                    if (this.canvas.node.imgs) {
                        this.canvas.node.imgs = [img];
                    } else {
                        this.canvas.node.imgs = [img];
                    }

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
                    const item = new ClipboardItem({'image/png': blob});
                    await navigator.clipboard.write([item]);
                    log.info("Fallback: Flattened selection copied to system clipboard.");
                } catch (fallbackError) {
                    log.error("Failed to copy to system clipboard as fallback:", fallbackError);
                }
            }
        } else {

            try {
                const item = new ClipboardItem({'image/png': blob});
                await navigator.clipboard.write([item]);
                log.info("Flattened selection copied to system clipboard.");
            } catch (error) {
                log.error("Failed to copy image to system clipboard:", error);
            }
        }
    }

    pasteLayers() {
        if (this.internalClipboard.length === 0) return;
        this.canvas.saveState();
        const newLayers = [];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.internalClipboard.forEach(layer => {
            minX = Math.min(minX, layer.x);
            minY = Math.min(minY, layer.y);
            maxX = Math.max(maxX, layer.x + layer.width);
            maxY = Math.max(maxY, layer.y + layer.height);
        });

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const mouseX = this.canvas.lastMousePosition.x;
        const mouseY = this.canvas.lastMousePosition.y;
        const offsetX = mouseX - centerX;
        const offsetY = mouseY - centerY;

        this.internalClipboard.forEach(clipboardLayer => {
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
        log.info(`Pasted ${newLayers.length} layer(s) at mouse position (${mouseX}, ${mouseY}).`);
    }

    async handlePaste(addMode = 'mouse') {
        try {
            log.info(`Paste operation started with preference: ${this.clipboardPreference}`);

            await this.clipboardManager.handlePaste(addMode, this.clipboardPreference);

        } catch (err) {
            log.error("Paste operation failed:", err);
        }
    }


    addLayerWithImage = withErrorHandling(async (image, layerProps = {}, addMode = 'default') => {
        if (!image) {
            throw createValidationError("Image is required for layer creation");
        }

        log.debug("Adding layer with image:", image, "with mode:", addMode);
        const imageId = generateUUID();
        await saveImage(imageId, image.src);
        this.canvas.imageCache.set(imageId, image.src);

        let finalWidth = image.width;
        let finalHeight = image.height;
        let finalX, finalY;

        if (addMode === 'fit') {
            const scale = Math.min(this.canvas.width / image.width, this.canvas.height / image.height);
            finalWidth = image.width * scale;
            finalHeight = image.height * scale;
            finalX = (this.canvas.width - finalWidth) / 2;
            finalY = (this.canvas.height - finalHeight) / 2;
        } else if (addMode === 'mouse') {
            finalX = this.canvas.lastMousePosition.x - finalWidth / 2;
            finalY = this.canvas.lastMousePosition.y - finalHeight / 2;
        } else { // 'center' or 'default'
            finalX = (this.canvas.width - finalWidth) / 2;
            finalY = (this.canvas.height - finalHeight) / 2;
        }

        const layer = {
            image: image,
            imageId: imageId,
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

        log.info("Layer added successfully");
        return layer;
    }, 'CanvasLayers.addLayerWithImage');

    async addLayer(image) {
        return this.addLayerWithImage(image);
    }

    moveLayerUp() {
        if (this.canvas.selectedLayers.length === 0) return;
        const selectedIndicesSet = new Set(this.canvas.selectedLayers.map(layer => this.canvas.layers.indexOf(layer)));

        const sortedIndices = Array.from(selectedIndicesSet).sort((a, b) => b - a);

        sortedIndices.forEach(index => {
            const targetIndex = index + 1;

            if (targetIndex < this.canvas.layers.length && !selectedIndicesSet.has(targetIndex)) {
                [this.canvas.layers[index], this.canvas.layers[targetIndex]] = [this.canvas.layers[targetIndex], this.canvas.layers[index]];
            }
        });
        this.canvas.layers.forEach((layer, i) => layer.zIndex = i);
        this.canvas.render();
        this.canvas.saveState();
    }

    moveLayerDown() {
        if (this.canvas.selectedLayers.length === 0) return;
        const selectedIndicesSet = new Set(this.canvas.selectedLayers.map(layer => this.canvas.layers.indexOf(layer)));

        const sortedIndices = Array.from(selectedIndicesSet).sort((a, b) => a - b);

        sortedIndices.forEach(index => {
            const targetIndex = index - 1;

            if (targetIndex >= 0 && !selectedIndicesSet.has(targetIndex)) {
                [this.canvas.layers[index], this.canvas.layers[targetIndex]] = [this.canvas.layers[targetIndex], this.canvas.layers[index]];
            }
        });
        this.canvas.layers.forEach((layer, i) => layer.zIndex = i);
        this.canvas.render();
        this.canvas.saveState();
    }

    /**
     * Zmienia rozmiar wybranych warstw
     * @param {number} scale - Skala zmiany rozmiaru
     */
    resizeLayer(scale) {
        if (this.canvas.selectedLayers.length === 0) return;

        this.canvas.selectedLayers.forEach(layer => {
            layer.width *= scale;
            layer.height *= scale;
        });
        this.canvas.render();
        this.canvas.saveState();
    }

    /**
     * Obraca wybrane warstwy
     * @param {number} angle - Kąt obrotu w stopniach
     */
    rotateLayer(angle) {
        if (this.canvas.selectedLayers.length === 0) return;

        this.canvas.selectedLayers.forEach(layer => {
            layer.rotation += angle;
        });
        this.canvas.render();
        this.canvas.saveState();
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
                const localX = rotatedX + layer.width / 2;
                const localY = rotatedY + layer.height / 2;

                return {
                    layer: layer,
                    localX: localX,
                    localY: localY
                };
            }
        }
        return null;
    }

    async mirrorHorizontal() {
        if (this.canvas.selectedLayers.length === 0) return;

        const promises = this.canvas.selectedLayers.map(layer => {
            return new Promise(resolve => {
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                tempCanvas.width = layer.image.width;
                tempCanvas.height = layer.image.height;

                tempCtx.translate(tempCanvas.width, 0);
                tempCtx.scale(-1, 1);
                tempCtx.drawImage(layer.image, 0, 0);

                const newImage = new Image();
                newImage.onload = () => {
                    layer.image = newImage;
                    resolve();
                };
                newImage.src = tempCanvas.toDataURL();
            });
        });

        await Promise.all(promises);
        this.canvas.render();
        this.canvas.saveState();
    }

    async mirrorVertical() {
        if (this.canvas.selectedLayers.length === 0) return;

        const promises = this.canvas.selectedLayers.map(layer => {
            return new Promise(resolve => {
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                tempCanvas.width = layer.image.width;
                tempCanvas.height = layer.image.height;

                tempCtx.translate(0, tempCanvas.height);
                tempCtx.scale(1, -1);
                tempCtx.drawImage(layer.image, 0, 0);

                const newImage = new Image();
                newImage.onload = () => {
                    layer.image = newImage;
                    resolve();
                };
                newImage.src = tempCanvas.toDataURL();
            });
        });

        await Promise.all(promises);
        this.canvas.render();
        this.canvas.saveState();
    }

    async getLayerImageData(layer) {
        try {
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

            tempCanvas.width = layer.width;
            tempCanvas.height = layer.height;

            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

            tempCtx.save();
            tempCtx.translate(layer.width / 2, layer.height / 2);
            tempCtx.rotate(layer.rotation * Math.PI / 180);
            tempCtx.drawImage(
                layer.image,
                -layer.width / 2,
                -layer.height / 2,
                layer.width,
                layer.height
            );
            tempCtx.restore();

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
        if (!layer) return {};

        const centerX = layer.x + layer.width / 2;
        const centerY = layer.y + layer.height / 2;
        const rad = layer.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const halfW = layer.width / 2;
        const halfH = layer.height / 2;
        const localHandles = {
            'n': {x: 0, y: -halfH},
            'ne': {x: halfW, y: -halfH},
            'e': {x: halfW, y: 0},
            'se': {x: halfW, y: halfH},
            's': {x: 0, y: halfH},
            'sw': {x: -halfW, y: halfH},
            'w': {x: -halfW, y: 0},
            'nw': {x: -halfW, y: -halfH},
            'rot': {x: 0, y: -halfH - 20 / this.canvas.viewport.zoom}
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
        if (this.canvas.selectedLayers.length === 0) return null;

        const handleRadius = 8 / this.canvas.viewport.zoom;
        for (let i = this.canvas.selectedLayers.length - 1; i >= 0; i--) {
            const layer = this.canvas.selectedLayers[i];
            const handles = this.getHandles(layer);

            for (const key in handles) {
                const handlePos = handles[key];
                const dx = worldX - handlePos.x;
                const dy = worldY - handlePos.y;
                if (dx * dx + dy * dy <= handleRadius * handleRadius) {
                    return {layer: layer, handle: key};
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
        content.style.cssText = `
            padding: 5px;
        `;

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

            dragOffset.x = e.clientX - parseInt(menu.style.left);
            dragOffset.y = e.clientY - parseInt(menu.style.top);
            e.preventDefault();
            e.stopPropagation();

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        this.blendModes.forEach(mode => {
            const container = document.createElement('div');
            container.className = 'blend-mode-container';
            container.style.cssText = `
                margin-bottom: 5px;
            `;

            const option = document.createElement('div');
            option.style.cssText = `
                padding: 5px 10px;
                color: white;
                cursor: pointer;
                transition: background-color 0.2s;
            `;
            option.textContent = `${mode.label} (${mode.name})`;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';

            slider.value = this.canvas.selectedLayer.opacity ? Math.round(this.canvas.selectedLayer.opacity * 100) : 100;
            slider.style.cssText = `
                width: 100%;
                margin: 5px 0;
                display: none;
            `;

            if (this.canvas.selectedLayer.blendMode === mode.name) {
                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';
            }

            option.onclick = () => {
                content.querySelectorAll('input[type="range"]').forEach(s => {
                    s.style.display = 'none';
                });
                content.querySelectorAll('.blend-mode-container div').forEach(d => {
                    d.style.backgroundColor = '';
                });

                slider.style.display = 'block';
                option.style.backgroundColor = '#3a3a3a';

                if (this.canvas.selectedLayer) {
                    this.canvas.selectedLayer.blendMode = mode.name;
                    this.canvas.render();
                }
            };

            slider.addEventListener('input', () => {
                if (this.canvas.selectedLayer) {
                    this.canvas.selectedLayer.opacity = slider.value / 100;
                    this.canvas.render();
                }
            });

            slider.addEventListener('change', async () => {
                if (this.canvas.selectedLayer) {
                    this.canvas.selectedLayer.opacity = slider.value / 100;
                    this.canvas.render();
                    const saveWithFallback = async (fileName) => {
                        try {
                            const uniqueFileName = generateUniqueFileName(fileName, this.canvas.node.id);
                            return await this.canvas.saveToServer(uniqueFileName);
                        } catch (error) {
                            console.warn(`Failed to save with unique name, falling back to original: ${fileName}`, error);
                            return await this.canvas.saveToServer(fileName);
                        }
                    };

                    await saveWithFallback(this.canvas.widget.value);
                    if (this.canvas.node) {
                        app.graph.runStep();
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
            if (!menu.contains(e.target) && !isDragging) {
                this.closeBlendModeMenu();
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu);
        }, 0);
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
        slider.value = this.blendOpacity;
        slider.className = 'blend-opacity-slider';

        slider.addEventListener('input', (e) => {
            this.blendOpacity = parseInt(e.target.value);
        });

        const modeElement = document.querySelector(`[data-blend-mode="${mode}"]`);
        if (modeElement) {
            modeElement.appendChild(slider);
        }
    }

    async getFlattenedCanvasAsBlob() {
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

            const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);

            sortedLayers.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2,
                    -layer.height / 2,
                    layer.width,
                    layer.height
                );

                tempCtx.restore();
            });

            tempCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Canvas toBlob failed.'));
                }
            }, 'image/png');
        });
    }

    async getFlattenedCanvasWithMaskAsBlob() {
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

            const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);

            sortedLayers.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2,
                    -layer.height / 2,
                    layer.width,
                    layer.height
                );

                tempCtx.restore();
            });

            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            const data = imageData.data;

            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {

                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.canvas.width;
                tempMaskCanvas.height = this.canvas.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });

                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);

                const maskX = this.canvas.maskTool.x;
                const maskY = this.canvas.maskTool.y;

                const sourceX = Math.max(0, -maskX);  // Where in the mask canvas to start reading
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);     // Where in the output canvas to start writing
                const destY = Math.max(0, maskY);

                const copyWidth = Math.min(
                    toolMaskCanvas.width - sourceX,   // Available width in source
                    this.canvas.width - destX         // Available width in destination
                );
                const copyHeight = Math.min(
                    toolMaskCanvas.height - sourceY,  // Available height in source
                    this.canvas.height - destY        // Available height in destination
                );

                if (copyWidth > 0 && copyHeight > 0) {
                    tempMaskCtx.drawImage(
                        toolMaskCanvas,
                        sourceX, sourceY, copyWidth, copyHeight,  // Source rectangle
                        destX, destY, copyWidth, copyHeight       // Destination rectangle
                    );
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
                    const maskAlpha = maskData[i + 3] / 255; // Użyj kanału alpha maski


                    const invertedMaskAlpha = 1 - maskAlpha;
                    data[i + 3] = originalAlpha * invertedMaskAlpha;
                }

                tempCtx.putImageData(imageData, 0, 0);
            }

            tempCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Canvas toBlob failed.'));
                }
            }, 'image/png');
        });
    }

    async getFlattenedCanvasForMaskEditor() {
        return new Promise((resolve, reject) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

            const sortedLayers = [...this.canvas.layers].sort((a, b) => a.zIndex - b.zIndex);

            sortedLayers.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2,
                    -layer.height / 2,
                    layer.width,
                    layer.height
                );

                tempCtx.restore();
            });

            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            const data = imageData.data;

            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {

                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.canvas.width;
                tempMaskCanvas.height = this.canvas.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });

                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);

                const maskX = this.canvas.maskTool.x;
                const maskY = this.canvas.maskTool.y;

                const sourceX = Math.max(0, -maskX);
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);
                const destY = Math.max(0, maskY);

                const copyWidth = Math.min(
                    toolMaskCanvas.width - sourceX,
                    this.canvas.width - destX
                );
                const copyHeight = Math.min(
                    toolMaskCanvas.height - sourceY,
                    this.canvas.height - destY
                );

                if (copyWidth > 0 && copyHeight > 0) {
                    tempMaskCtx.drawImage(
                        toolMaskCanvas,
                        sourceX, sourceY, copyWidth, copyHeight,
                        destX, destY, copyWidth, copyHeight
                    );
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
                } else {
                    reject(new Error('Canvas toBlob failed.'));
                }
            }, 'image/png');
        });
    }

    async getFlattenedSelectionAsBlob() {
        if (this.canvas.selectedLayers.length === 0) {
            return null;
        }

        return new Promise((resolve) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.canvas.selectedLayers.forEach(layer => {
                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                const rad = layer.rotation * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                const halfW = layer.width / 2;
                const halfH = layer.height / 2;

                const corners = [
                    {x: -halfW, y: -halfH},
                    {x: halfW, y: -halfH},
                    {x: halfW, y: halfH},
                    {x: -halfW, y: halfH}
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
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

            tempCtx.translate(-minX, -minY);

            const sortedSelection = [...this.canvas.selectedLayers].sort((a, b) => a.zIndex - b.zIndex);

            sortedSelection.forEach(layer => {
                if (!layer.image) return;

                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;

                const centerX = layer.x + layer.width / 2;
                const centerY = layer.y + layer.height / 2;
                tempCtx.translate(centerX, centerY);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(
                    layer.image,
                    -layer.width / 2, -layer.height / 2,
                    layer.width, layer.height
                );
                tempCtx.restore();
            });
            tempCanvas.toBlob((blob) => {
                resolve(blob);
            }, 'image/png');
        });
    }
}
