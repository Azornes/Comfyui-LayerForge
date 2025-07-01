import {saveImage, removeImage} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {generateUUID, generateUniqueFileName} from "./utils/CommonUtils.js";
import {withErrorHandling, createValidationError} from "./ErrorHandler.js";
import {app, ComfyApp} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";

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
        this.clipboardPreference = 'system'; // 'system', 'clipspace'
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

            if (this.internalClipboard.length > 0) {
                log.info("Pasting from internal clipboard");
                this.pasteLayers();
                return;
            }

            if (this.clipboardPreference === 'clipspace') {
                log.info("Attempting paste from ComfyUI Clipspace");
                if (!await this.tryClipspacePaste(addMode)) {
                    log.info("No image found in ComfyUI Clipspace");
                }
            } else if (this.clipboardPreference === 'system') {
                log.info("Attempting paste from system clipboard");
                await this.trySystemClipboardPaste(addMode);
            }

        } catch (err) {
            log.error("Paste operation failed:", err);
        }
    }

    async tryClipspacePaste(addMode) {
        try {
            log.info("Attempting to paste from ComfyUI Clipspace");
            const clipspaceResult = ComfyApp.pasteFromClipspace(this.canvas.node);

            if (this.canvas.node.imgs && this.canvas.node.imgs.length > 0) {
                const clipspaceImage = this.canvas.node.imgs[0];
                if (clipspaceImage && clipspaceImage.src) {
                    log.info("Successfully got image from ComfyUI Clipspace");
                    const img = new Image();
                    img.onload = async () => {
                        await this.addLayerWithImage(img, {}, addMode);
                    };
                    img.src = clipspaceImage.src;
                    return true;
                }
            }
            return false;
        } catch (clipspaceError) {
            log.warn("ComfyUI Clipspace paste failed:", clipspaceError);
            return false;
        }
    }

    async trySystemClipboardPaste(addMode) {
        if (!navigator.clipboard?.read) {
            log.info("Browser does not support clipboard read API");
            return false;
        }

        try {
            log.info("Attempting to paste from system clipboard");
            const clipboardItems = await navigator.clipboard.read();

            for (const item of clipboardItems) {
                // First, try to find actual image data
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
                    log.info("Successfully pasted image from system clipboard");
                    return true;
                }

                // If no image data found, check for text that might be a file path
                const textType = item.types.find(type => type === 'text/plain');
                if (textType) {
                    const textBlob = await item.getType(textType);
                    const text = await textBlob.text();
                    
                    if (this.isValidImagePath(text)) {
                        log.info("Found image file path in clipboard:", text);
                        try {
                            // Try to load the image using different methods
                            const success = await this.loadImageFromPath(text, addMode);
                            if (success) {
                                return true;
                            }
                        } catch (pathError) {
                            log.warn("Error loading image from path:", pathError);
                        }
                    }
                }
            }

            log.info("No image or valid image path found in system clipboard");
            return false;
        } catch (error) {
            log.warn("System clipboard paste failed:", error);
            return false;
        }
    }

    /**
     * Validates if a text string is a valid image file path
     * @param {string} text - The text to validate
     * @returns {boolean} - True if the text appears to be a valid image file path
     */
    isValidImagePath(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }

        // Trim whitespace
        text = text.trim();

        // Check if it's empty after trimming
        if (!text) {
            return false;
        }

        // Common image file extensions
        const imageExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', 
            '.svg', '.tiff', '.tif', '.ico', '.avif'
        ];

        // Check if the text ends with a valid image extension (case insensitive)
        const hasImageExtension = imageExtensions.some(ext => 
            text.toLowerCase().endsWith(ext)
        );

        if (!hasImageExtension) {
            return false;
        }

        // Basic path validation - should look like a file path
        // Accept both Windows and Unix style paths, and URLs
        const pathPatterns = [
            /^[a-zA-Z]:[\\\/]/, // Windows absolute path (C:\... or C:/...)
            /^[\\\/]/, // Unix absolute path (/...)
            /^\.{1,2}[\\\/]/, // Relative path (./... or ../...)
            /^https?:\/\//, // HTTP/HTTPS URL
            /^file:\/\//, // File URL
            /^[^\\\/]*[\\\/]/ // Contains path separators
        ];

        const isValidPath = pathPatterns.some(pattern => pattern.test(text)) || 
                           (!text.includes('/') && !text.includes('\\') && text.includes('.')); // Simple filename

        return isValidPath;
    }

    /**
     * Attempts to load an image from a file path using various methods
     * @param {string} filePath - The file path to load
     * @param {string} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async loadImageFromPath(filePath, addMode) {
        // Method 1: Try direct loading for URLs
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                return new Promise((resolve) => {
                    img.onload = async () => {
                        log.info("Successfully loaded image from URL");
                        await this.addLayerWithImage(img, {}, addMode);
                        resolve(true);
                    };
                    img.onerror = () => {
                        log.warn("Failed to load image from URL:", filePath);
                        resolve(false);
                    };
                    img.src = filePath;
                });
            } catch (error) {
                log.warn("Error loading image from URL:", error);
                return false;
            }
        }

        // Method 2: Try to load via ComfyUI's view endpoint for local files
        try {
            log.info("Attempting to load local file via ComfyUI view endpoint");
            const success = await this.loadImageViaComfyUIView(filePath, addMode);
            if (success) {
                return true;
            }
        } catch (error) {
            log.warn("ComfyUI view endpoint method failed:", error);
        }

        // Method 3: Try to prompt user to select the file manually
        try {
            log.info("Attempting to load local file via file picker");
            const success = await this.promptUserForFile(filePath, addMode);
            if (success) {
                return true;
            }
        } catch (error) {
            log.warn("File picker method failed:", error);
        }

        // Method 4: Show user a helpful message about the limitation
        this.showFilePathMessage(filePath);
        return false;
    }

    /**
     * Attempts to load an image using ComfyUI's API methods
     * @param {string} filePath - The file path to load
     * @param {string} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async loadImageViaComfyUIView(filePath, addMode) {
        try {
            // First, try to get folder paths to understand ComfyUI structure
            const folderPaths = await this.getComfyUIFolderPaths();
            log.debug("ComfyUI folder paths:", folderPaths);
            
            // Extract filename from path
            const fileName = filePath.split(/[\\\/]/).pop();
            
            // Method 1: Try to upload the file to ComfyUI first, then load it
            const uploadSuccess = await this.uploadFileToComfyUI(filePath, addMode);
            if (uploadSuccess) {
                return true;
            }
            
            // Method 2: Try different view endpoints if file might already exist in ComfyUI
            const viewConfigs = [
                // Direct filename approach
                { filename: fileName },
                // Full path approach
                { filename: filePath },
                // Input folder approach
                { filename: fileName, type: 'input' },
                // Temp folder approach  
                { filename: fileName, type: 'temp' },
                // Output folder approach
                { filename: fileName, type: 'output' }
            ];

            for (const config of viewConfigs) {
                try {
                    // Build query parameters
                    const params = new URLSearchParams();
                    params.append('filename', config.filename);
                    if (config.type) {
                        params.append('type', config.type);
                    }
                    if (config.subfolder) {
                        params.append('subfolder', config.subfolder);
                    }
                    
                    const viewUrl = api.apiURL(`/view?${params.toString()}`);
                    log.debug("Trying ComfyUI view URL:", viewUrl);
                    
                    const img = new Image();
                    const success = await new Promise((resolve) => {
                        img.onload = async () => {
                            log.info("Successfully loaded image via ComfyUI view endpoint:", viewUrl);
                            await this.addLayerWithImage(img, {}, addMode);
                            resolve(true);
                        };
                        img.onerror = () => {
                            log.debug("Failed to load image via ComfyUI view endpoint:", viewUrl);
                            resolve(false);
                        };
                        
                        // Set a timeout to avoid hanging
                        setTimeout(() => {
                            resolve(false);
                        }, 3000);
                        
                        img.src = viewUrl;
                    });
                    
                    if (success) {
                        return true;
                    }
                } catch (error) {
                    log.debug("Error with view config:", config, error);
                    continue;
                }
            }
            
            return false;
        } catch (error) {
            log.warn("Error in loadImageViaComfyUIView:", error);
            return false;
        }
    }

    /**
     * Gets ComfyUI folder paths using the API
     * @returns {Promise<Object>} - Folder paths object
     */
    async getComfyUIFolderPaths() {
        try {
            return await api.getFolderPaths();
        } catch (error) {
            log.warn("Failed to get ComfyUI folder paths:", error);
            return {};
        }
    }

    /**
     * Attempts to load a file via ComfyUI backend endpoint
     * @param {string} filePath - The file path to load
     * @param {string} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async uploadFileToComfyUI(filePath, addMode) {
        try {
            log.info("Attempting to load file via ComfyUI backend:", filePath);
            
            // Use the new backend endpoint to load image from path
            const response = await api.fetchApi("/ycnode/load_image_from_path", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    file_path: filePath
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                log.debug("Backend failed to load image:", errorData.error);
                return false;
            }
            
            const data = await response.json();
            
            if (!data.success) {
                log.debug("Backend returned error:", data.error);
                return false;
            }
            
            log.info("Successfully loaded image via ComfyUI backend:", filePath);
            
            // Create image from the returned base64 data
            const img = new Image();
            const success = await new Promise((resolve) => {
                img.onload = async () => {
                    log.info("Successfully loaded image from backend response");
                    await this.addLayerWithImage(img, {}, addMode);
                    resolve(true);
                };
                img.onerror = () => {
                    log.warn("Failed to load image from backend response");
                    resolve(false);
                };
                
                img.src = data.image_data;
            });
            
            return success;
            
        } catch (error) {
            log.debug("Error loading file via ComfyUI backend:", error);
            return false;
        }
    }

    /**
     * Prompts the user to select a file when a local path is detected
     * @param {string} originalPath - The original file path from clipboard
     * @param {string} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async promptUserForFile(originalPath, addMode) {
        return new Promise((resolve) => {
            // Create a temporary file input
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';

            // Extract filename from path for user reference
            const fileName = originalPath.split(/[\\\/]/).pop();

            fileInput.onchange = async (event) => {
                const file = event.target.files[0];
                if (file && file.type.startsWith('image/')) {
                    try {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            const img = new Image();
                            img.onload = async () => {
                                log.info("Successfully loaded image from file picker");
                                await this.addLayerWithImage(img, {}, addMode);
                                resolve(true);
                            };
                            img.onerror = () => {
                                log.warn("Failed to load selected image");
                                resolve(false);
                            };
                            img.src = e.target.result;
                        };
                        reader.onerror = () => {
                            log.warn("Failed to read selected file");
                            resolve(false);
                        };
                        reader.readAsDataURL(file);
                    } catch (error) {
                        log.warn("Error processing selected file:", error);
                        resolve(false);
                    }
                } else {
                    log.warn("Selected file is not an image");
                    resolve(false);
                }
                
                // Clean up
                document.body.removeChild(fileInput);
            };

            fileInput.oncancel = () => {
                log.info("File selection cancelled by user");
                document.body.removeChild(fileInput);
                resolve(false);
            };

            // Show a brief notification to the user
            this.showNotification(`Detected image path: ${fileName}. Please select the file to load it.`, 3000);

            // Add to DOM and trigger click
            document.body.appendChild(fileInput);
            fileInput.click();
        });
    }

    /**
     * Shows a message to the user about file path limitations
     * @param {string} filePath - The file path that couldn't be loaded
     */
    showFilePathMessage(filePath) {
        const fileName = filePath.split(/[\\\/]/).pop();
        const message = `Cannot load local file directly due to browser security restrictions. File detected: ${fileName}`;
        this.showNotification(message, 5000);
        log.info("Showed file path limitation message to user");
    }

    /**
     * Shows a temporary notification to the user
     * @param {string} message - The message to show
     * @param {number} duration - Duration in milliseconds
     */
    showNotification(message, duration = 3000) {
        // Create notification element
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #333;
            color: white;
            padding: 12px 16px;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            z-index: 10001;
            max-width: 300px;
            font-size: 14px;
            line-height: 1.4;
        `;
        notification.textContent = message;

        // Add to DOM
        document.body.appendChild(notification);

        // Remove after duration
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
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
