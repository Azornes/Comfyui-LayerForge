import { createModuleLogger } from "./LoggerUtils.js";
// @ts-ignore
import { api } from "../../../scripts/api.js";
// @ts-ignore
import { ComfyApp } from "../../../scripts/app.js";
const log = createModuleLogger('ClipboardManager');
export class ClipboardManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.clipboardPreference = 'system'; // 'system', 'clipspace'
    }
    /**
     * Main paste handler that delegates to appropriate methods
     * @param {AddMode} addMode - The mode for adding the layer
     * @param {ClipboardPreference} preference - Clipboard preference ('system' or 'clipspace')
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async handlePaste(addMode = 'mouse', preference = 'system') {
        try {
            log.info(`ClipboardManager handling paste with preference: ${preference}`);
            if (this.canvas.canvasLayers.internalClipboard.length > 0) {
                log.info("Found layers in internal clipboard, pasting layers");
                this.canvas.canvasLayers.pasteLayers();
                return true;
            }
            if (preference === 'clipspace') {
                log.info("Attempting paste from ComfyUI Clipspace");
                const success = await this.tryClipspacePaste(addMode);
                if (success) {
                    return true;
                }
                log.info("No image found in ComfyUI Clipspace");
            }
            log.info("Attempting paste from system clipboard");
            return await this.trySystemClipboardPaste(addMode);
        }
        catch (err) {
            log.error("ClipboardManager paste operation failed:", err);
            return false;
        }
    }
    /**
     * Attempts to paste from ComfyUI Clipspace
     * @param {AddMode} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async tryClipspacePaste(addMode) {
        try {
            log.info("Attempting to paste from ComfyUI Clipspace");
            ComfyApp.pasteFromClipspace(this.canvas.node);
            if (this.canvas.node.imgs && this.canvas.node.imgs.length > 0) {
                const clipspaceImage = this.canvas.node.imgs[0];
                if (clipspaceImage && clipspaceImage.src) {
                    log.info("Successfully got image from ComfyUI Clipspace");
                    const img = new Image();
                    img.onload = async () => {
                        await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
                    };
                    img.src = clipspaceImage.src;
                    return true;
                }
            }
            return false;
        }
        catch (clipspaceError) {
            log.warn("ComfyUI Clipspace paste failed:", clipspaceError);
            return false;
        }
    }
    /**
     * System clipboard paste - handles both image data and text paths
     * @param {AddMode} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async trySystemClipboardPaste(addMode) {
        log.info("ClipboardManager: Checking system clipboard for images and paths");
        if (navigator.clipboard?.read) {
            try {
                const clipboardItems = await navigator.clipboard.read();
                for (const item of clipboardItems) {
                    log.debug("Clipboard item types:", item.types);
                    const imageType = item.types.find(type => type.startsWith('image/'));
                    if (imageType) {
                        try {
                            const blob = await item.getType(imageType);
                            const reader = new FileReader();
                            reader.onload = (event) => {
                                const img = new Image();
                                img.onload = async () => {
                                    log.info("Successfully loaded image from system clipboard");
                                    await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
                                };
                                if (event.target?.result) {
                                    img.src = event.target.result;
                                }
                            };
                            reader.readAsDataURL(blob);
                            log.info("Found image data in system clipboard");
                            return true;
                        }
                        catch (error) {
                            log.debug("Error reading image data:", error);
                        }
                    }
                    const textTypes = ['text/plain', 'text/uri-list'];
                    for (const textType of textTypes) {
                        if (item.types.includes(textType)) {
                            try {
                                const textBlob = await item.getType(textType);
                                const text = await textBlob.text();
                                if (this.isValidImagePath(text)) {
                                    log.info("Found image path in clipboard:", text);
                                    const success = await this.loadImageFromPath(text, addMode);
                                    if (success) {
                                        return true;
                                    }
                                }
                            }
                            catch (error) {
                                log.debug(`Error reading ${textType}:`, error);
                            }
                        }
                    }
                }
            }
            catch (error) {
                log.debug("Modern clipboard API failed:", error);
            }
        }
        if (navigator.clipboard?.readText) {
            try {
                const text = await navigator.clipboard.readText();
                log.debug("Found text in clipboard:", text);
                if (text && this.isValidImagePath(text)) {
                    log.info("Found valid image path in clipboard:", text);
                    const success = await this.loadImageFromPath(text, addMode);
                    if (success) {
                        return true;
                    }
                }
            }
            catch (error) {
                log.debug("Could not read text from clipboard:", error);
            }
        }
        log.debug("No images or valid image paths found in system clipboard");
        return false;
    }
    /**
     * Validates if a text string is a valid image file path or URL
     * @param {string} text - The text to validate
     * @returns {boolean} - True if the text appears to be a valid image file path or URL
     */
    isValidImagePath(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }
        text = text.trim();
        if (!text) {
            return false;
        }
        if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('file://')) {
            try {
                new URL(text);
                log.debug("Detected valid URL:", text);
                return true;
            }
            catch (e) {
                log.debug("Invalid URL format:", text);
                return false;
            }
        }
        const imageExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp',
            '.svg', '.tiff', '.tif', '.ico', '.avif'
        ];
        const hasImageExtension = imageExtensions.some(ext => text.toLowerCase().endsWith(ext));
        if (!hasImageExtension) {
            log.debug("No valid image extension found in:", text);
            return false;
        }
        const pathPatterns = [
            /^[a-zA-Z]:[\\\/]/, // Windows absolute path (C:\... or C:/...)
            /^[\\\/]/, // Unix absolute path (/...)
            /^\.{1,2}[\\\/]/, // Relative path (./... or ../...)
            /^[^\\\/]*[\\\/]/ // Contains path separators
        ];
        const isValidPath = pathPatterns.some(pattern => pattern.test(text)) ||
            (!text.includes('/') && !text.includes('\\') && text.includes('.')); // Simple filename
        if (isValidPath) {
            log.debug("Detected valid local file path:", text);
        }
        else {
            log.debug("Invalid local file path format:", text);
        }
        return isValidPath;
    }
    /**
     * Attempts to load an image from a file path using simplified methods
     * @param {string} filePath - The file path to load
     * @param {AddMode} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async loadImageFromPath(filePath, addMode) {
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                return new Promise((resolve) => {
                    img.onload = async () => {
                        log.info("Successfully loaded image from URL");
                        await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
                        resolve(true);
                    };
                    img.onerror = () => {
                        log.warn("Failed to load image from URL:", filePath);
                        resolve(false);
                    };
                    img.src = filePath;
                });
            }
            catch (error) {
                log.warn("Error loading image from URL:", error);
                return false;
            }
        }
        try {
            log.info("Attempting to load local file via backend");
            const success = await this.loadFileViaBackend(filePath, addMode);
            if (success) {
                return true;
            }
        }
        catch (error) {
            log.warn("Backend loading failed:", error);
        }
        try {
            log.info("Falling back to file picker");
            const success = await this.promptUserForFile(filePath, addMode);
            if (success) {
                return true;
            }
        }
        catch (error) {
            log.warn("File picker failed:", error);
        }
        this.showFilePathMessage(filePath);
        return false;
    }
    /**
     * Loads a local file via the ComfyUI backend endpoint
     * @param {string} filePath - The file path to load
     * @param {AddMode} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async loadFileViaBackend(filePath, addMode) {
        try {
            log.info("Loading file via ComfyUI backend:", filePath);
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
            const img = new Image();
            const success = await new Promise((resolve) => {
                img.onload = async () => {
                    log.info("Successfully loaded image from backend response");
                    await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
                    resolve(true);
                };
                img.onerror = () => {
                    log.warn("Failed to load image from backend response");
                    resolve(false);
                };
                img.src = data.image_data;
            });
            return success;
        }
        catch (error) {
            log.debug("Error loading file via ComfyUI backend:", error);
            return false;
        }
    }
    /**
     * Prompts the user to select a file when a local path is detected
     * @param {string} originalPath - The original file path from clipboard
     * @param {AddMode} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
    async promptUserForFile(originalPath, addMode) {
        return new Promise((resolve) => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            const fileName = originalPath.split(/[\\\/]/).pop();
            fileInput.onchange = async (event) => {
                const target = event.target;
                const file = target.files?.[0];
                if (file && file.type.startsWith('image/')) {
                    try {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            const img = new Image();
                            img.onload = async () => {
                                log.info("Successfully loaded image from file picker");
                                await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
                                resolve(true);
                            };
                            img.onerror = () => {
                                log.warn("Failed to load selected image");
                                resolve(false);
                            };
                            if (e.target?.result) {
                                img.src = e.target.result;
                            }
                        };
                        reader.onerror = () => {
                            log.warn("Failed to read selected file");
                            resolve(false);
                        };
                        reader.readAsDataURL(file);
                    }
                    catch (error) {
                        log.warn("Error processing selected file:", error);
                        resolve(false);
                    }
                }
                else {
                    log.warn("Selected file is not an image");
                    resolve(false);
                }
                document.body.removeChild(fileInput);
            };
            fileInput.oncancel = () => {
                log.info("File selection cancelled by user");
                document.body.removeChild(fileInput);
                resolve(false);
            };
            this.showNotification(`Detected image path: ${fileName}. Please select the file to load it.`, 3000);
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
     * Shows a helpful message when clipboard appears empty and offers file picker
     * @param {AddMode} addMode - The mode for adding the layer
     */
    showEmptyClipboardMessage(addMode) {
        const message = `Copied a file? Browser can't access file paths for security. Click here to select the file manually.`;
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #2d5aa0;
            color: white;
            padding: 14px 18px;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            z-index: 10001;
            max-width: 320px;
            font-size: 14px;
            line-height: 1.4;
            cursor: pointer;
            border: 2px solid #4a7bc8;
            transition: all 0.2s ease;
            font-weight: 500;
        `;
        notification.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 18px;">📁</span>
                <span>${message}</span>
            </div>
            <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">
                💡 Tip: You can also drag & drop files directly onto the canvas
            </div>
        `;
        notification.onmouseenter = () => {
            notification.style.backgroundColor = '#3d6bb0';
            notification.style.borderColor = '#5a8bd8';
            notification.style.transform = 'translateY(-1px)';
        };
        notification.onmouseleave = () => {
            notification.style.backgroundColor = '#2d5aa0';
            notification.style.borderColor = '#4a7bc8';
            notification.style.transform = 'translateY(0)';
        };
        notification.onclick = async () => {
            document.body.removeChild(notification);
            try {
                const success = await this.promptUserForFile('image_file.jpg', addMode);
                if (success) {
                    log.info("Successfully loaded image via empty clipboard file picker");
                }
            }
            catch (error) {
                log.warn("Error with empty clipboard file picker:", error);
            }
        };
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 12000);
        log.info("Showed enhanced empty clipboard message with file picker option");
    }
    /**
     * Shows a temporary notification to the user
     * @param {string} message - The message to show
     * @param {number} duration - Duration in milliseconds
     */
    showNotification(message, duration = 3000) {
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
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }
}
