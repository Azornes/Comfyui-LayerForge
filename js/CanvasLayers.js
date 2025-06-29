import {saveImage, removeImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {generateUUID, generateUniqueFileName} from "./utils/CommonUtils.js";
import {withErrorHandling, createValidationError} from "./ErrorHandler.js";

const log = createModuleLogger('CanvasLayers');

export class CanvasLayers {
    constructor(canvas) {
        this.canvas = canvas;
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
    }

    async copySelectedLayers() {
        if (this.canvas.selectedLayers.length === 0) return;
        this.internalClipboard = this.canvas.selectedLayers.map(layer => ({...layer}));
        log.info(`Copied ${this.internalClipboard.length} layer(s) to internal clipboard.`);
        try {
            const blob = await this.getFlattenedSelectionAsBlob();
            if (blob) {
                const item = new ClipboardItem({'image/png': blob});
                await navigator.clipboard.write([item]);
                log.info("Flattened selection copied to the system clipboard.");
            }
        } catch (error) {
            log.error("Failed to copy image to system clipboard:", error);
        }
    }

    pasteLayers() {
        if (this.internalClipboard.length === 0) return;
        this.canvas.saveState();
        const newLayers = [];
        const pasteOffset = 20;

        this.internalClipboard.forEach(clipboardLayer => {
            const newLayer = {
                ...clipboardLayer,
                x: clipboardLayer.x + pasteOffset / this.canvas.viewport.zoom,
                y: clipboardLayer.y + pasteOffset / this.canvas.viewport.zoom,
                zIndex: this.canvas.layers.length
            };
            this.canvas.layers.push(newLayer);
            newLayers.push(newLayer);
        });

        this.canvas.updateSelection(newLayers);
        this.canvas.render();
        log.info(`Pasted ${newLayers.length} layer(s).`);
    }

    async handlePaste(addMode = 'mouse') {
        try {
            if (!navigator.clipboard?.read) {
                log.info("Browser does not support clipboard read API. Falling back to internal paste.");
                this.pasteLayers();
                return;
            }

            const clipboardItems = await navigator.clipboard.read();
            let imagePasted = false;

            for (const item of clipboardItems) {
                const imageType = item.types.find(type => type.startsWith('image/'));

                if (imageType) {
                    const blob = await item.getType(imageType);
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const img = new Image();
                        img.onload = async () => {
                            await this.addLayerWithImage(img, {}, addMode);
                        };
                        img.src = event.target.result;
                    };
                    reader.readAsDataURL(blob);
                    imagePasted = true;
                    break;
                }
            }
            if (!imagePasted) {
                this.pasteLayers();
            }

        } catch (err) {
            log.error("Paste operation failed, falling back to internal paste. Error:", err);
            this.pasteLayers();
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
                const tempCtx = tempCanvas.getContext('2d');
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
                const tempCtx = tempCanvas.getContext('2d');
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
            const tempCtx = tempCanvas.getContext('2d');

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
            padding: 5px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;

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
                menu.querySelectorAll('input[type="range"]').forEach(s => {
                    s.style.display = 'none';
                });
                menu.querySelectorAll('.blend-mode-container div').forEach(d => {
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
            menu.appendChild(container);
        });

        const container = this.canvas.canvas.parentElement || document.body;
        container.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
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
            const tempCtx = tempCanvas.getContext('2d');

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
            const tempCtx = tempCanvas.getContext('2d');

            // Najpierw renderuj wszystkie warstwy
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

            // Pobierz dane obrazu
            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            const data = imageData.data;

            // Pobierz maskę
            const maskCanvas = this.canvas.maskTool.getMask();
            
            if (maskCanvas && maskCanvas.width > 0 && maskCanvas.height > 0) {
                // Stwórz tymczasowy canvas dla maski w rozmiarze output area
                const maskTempCanvas = document.createElement('canvas');
                maskTempCanvas.width = this.canvas.width;
                maskTempCanvas.height = this.canvas.height;
                const maskTempCtx = maskTempCanvas.getContext('2d');

                // Narysuj odpowiedni fragment maski (uwzględniając pozycję maskTool)
                const maskX = -this.canvas.maskTool.x;
                const maskY = -this.canvas.maskTool.y;
                maskTempCtx.drawImage(maskCanvas, maskX, maskY);

                // Pobierz dane maski
                const maskImageData = maskTempCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                const maskData = maskImageData.data;

                // Zastosuj maskę jako kanał alpha
                for (let i = 0; i < data.length; i += 4) {
                    // Pobierz wartość maski (używamy czerwonego kanału, bo maska jest biała)
                    const maskValue = maskData[i]; // R kanał maski
                    
                    // Maska biała (255) = pełna przezroczystość (alpha = 255)
                    // Maska czarna (0) = brak przezroczystości (alpha = 0)
                    data[i + 3] = maskValue; // Ustaw alpha na wartość maski
                }

                // Zapisz zmodyfikowane dane obrazu
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
            const tempCtx = tempCanvas.getContext('2d');

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
