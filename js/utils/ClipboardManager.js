import {createModuleLogger} from "./LoggerUtils.js";
import {api} from "../../../scripts/api.js";

const log = createModuleLogger('ClipboardManager');

export class ClipboardManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.clipboardPreference = 'system'; // 'system', 'clipspace'
    }

    /**
     * Attempts to paste from system clipboard
     * @param {string} addMode - The mode for adding the layer
     * @returns {Promise<boolean>} - True if successful, false otherwise
     */
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
                            await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
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
     * Validates if a text string is a valid image file path or URL
     * @param {string} text - The text to validate
     * @returns {boolean} - True if the text appears to be a valid image file path or URL
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

        // Check if it's a URL first (URLs have priority and don't need file extensions)
        if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('file://')) {
            // For URLs, we're more permissive - any valid URL could potentially be an image
            try {
                new URL(text);
                log.debug("Detected valid URL:", text);
                return true;
            } catch (e) {
                log.debug("Invalid URL format:", text);
                return false;
            }
        }

        // For local file paths, check for image extensions
        const imageExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', 
            '.svg', '.tiff', '.tif', '.ico', '.avif'
        ];

        // Check if the text ends with a valid image extension (case insensitive)
        const hasImageExtension = imageExtensions.some(ext => 
            text.toLowerCase().endsWith(ext)
        );

        if (!hasImageExtension) {
            log.debug("No valid image extension found in:", text);
            return false;
        }

        // Basic path validation for local files - should look like a file path
        // Accept both Windows and Unix style paths
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
        } else {
            log.debug("Invalid local file path format:", text);
        }

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
                        await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
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
                            await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
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
                                await this.canvas.canvasLayers.addLayerWithImage(img, {}, addMode);
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
}
