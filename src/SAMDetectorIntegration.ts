import { api } from "../../scripts/api.js";
// @ts-ignore
import { ComfyApp } from "../../scripts/app.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import type { ComfyNode } from './types';

const log = createModuleLogger('SAMDetectorIntegration');

/**
 * SAM Detector Integration for LayerForge
 * Handles automatic clipspace integration and mask application from Impact Pack's SAM Detector
 */

// Function to register image in clipspace for Impact Pack compatibility
export const registerImageInClipspace = async (node: ComfyNode, blob: Blob): Promise<HTMLImageElement | null> => {
    try {
        // Upload the image to ComfyUI's temp storage for clipspace access
        const formData = new FormData();
        const filename = `layerforge-sam-${node.id}-${Date.now()}.png`; // Use timestamp for SAM Detector
        formData.append("image", blob, filename);
        formData.append("overwrite", "true");
        formData.append("type", "temp");

        const response = await api.fetchApi("/upload/image", {
            method: "POST",
            body: formData,
        });

        if (response.ok) {
            const data = await response.json();
            
            // Create a proper image element with the server URL
            const clipspaceImg = new Image();
            clipspaceImg.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
            
            // Wait for image to load
            await new Promise((resolve, reject) => {
                clipspaceImg.onload = resolve;
                clipspaceImg.onerror = reject;
            });

            log.debug(`Image registered in clipspace for node ${node.id}: ${filename}`);
            return clipspaceImg;
        }
    } catch (error) {
        log.debug("Failed to register image in clipspace:", error);
    }
    return null;
};

// Function to monitor for SAM Detector modal closure and apply masks to LayerForge
export function startSAMDetectorMonitoring(node: ComfyNode) {
    if ((node as any).samMonitoringActive) {
        log.debug("SAM Detector monitoring already active for node", node.id);
        return;
    }

    (node as any).samMonitoringActive = true;
    log.info("Starting SAM Detector modal monitoring for node", node.id);

    // Store original image source for comparison
    const originalImgSrc = node.imgs?.[0]?.src;
    (node as any).samOriginalImgSrc = originalImgSrc;

    // Start monitoring for SAM Detector modal closure
    monitorSAMDetectorModal(node);
}

// Function to monitor SAM Detector modal closure
function monitorSAMDetectorModal(node: ComfyNode) {
    log.info("Starting SAM Detector modal monitoring for node", node.id);
    
    // Try to find modal multiple times with increasing delays
    let attempts = 0;
    const maxAttempts = 10; // Try for 5 seconds total
    
    const findModal = () => {
        attempts++;
        log.debug(`Looking for SAM Detector modal, attempt ${attempts}/${maxAttempts}`);
        
        // Look for SAM Detector specific elements instead of generic modal
        const samCanvas = document.querySelector('#samEditorMaskCanvas') as HTMLElement;
        const pointsCanvas = document.querySelector('#pointsCanvas') as HTMLElement;
        const imageCanvas = document.querySelector('#imageCanvas') as HTMLElement;
        
        // Debug: Log SAM specific elements
        log.debug(`SAM specific elements found:`, {
            samCanvas: !!samCanvas,
            pointsCanvas: !!pointsCanvas,
            imageCanvas: !!imageCanvas
        });
        
        // Find the modal that contains SAM Detector elements
        let modal: HTMLElement | null = null;
        if (samCanvas || pointsCanvas || imageCanvas) {
            // Find the parent modal of SAM elements
            const samElement = samCanvas || pointsCanvas || imageCanvas;
            let parent = samElement?.parentElement;
            while (parent && !parent.classList.contains('comfy-modal')) {
                parent = parent.parentElement;
            }
            modal = parent;
        }
        
        if (!modal) {
            if (attempts < maxAttempts) {
                log.debug(`SAM Detector modal not found on attempt ${attempts}, retrying in 500ms...`);
                setTimeout(findModal, 500);
                return;
            } else {
                log.warn("SAM Detector modal not found after all attempts, falling back to polling");
                // Fallback to old polling method if modal not found
                monitorSAMDetectorChanges(node);
                return;
            }
        }

        log.info("Found SAM Detector modal, setting up observers", {
            className: modal.className,
            id: modal.id,
            display: window.getComputedStyle(modal).display,
            children: modal.children.length,
            hasSamCanvas: !!modal.querySelector('#samEditorMaskCanvas'),
            hasPointsCanvas: !!modal.querySelector('#pointsCanvas'),
            hasImageCanvas: !!modal.querySelector('#imageCanvas')
        });

        // Create a MutationObserver to watch for modal removal or style changes
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                // Check if the modal was removed from DOM
                if (mutation.type === 'childList') {
                    mutation.removedNodes.forEach((removedNode) => {
                        if (removedNode === modal || (removedNode as Element)?.contains?.(modal)) {
                            log.info("SAM Detector modal removed from DOM");
                            handleSAMDetectorModalClosed(node);
                            observer.disconnect();
                        }
                    });
                }
                
                // Check if modal style changed to hidden
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const target = mutation.target as HTMLElement;
                    if (target === modal) {
                        const display = window.getComputedStyle(modal).display;
                        if (display === 'none') {
                            log.info("SAM Detector modal hidden via style");
                            // Add delay to allow SAM Detector to process and save the mask
                            setTimeout(() => {
                                handleSAMDetectorModalClosed(node);
                            }, 1000); // 1 second delay
                            observer.disconnect();
                        }
                    }
                }
            });
        });

        // Observe the document body for child removals (modal removal)
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style']
        });

        // Also observe the modal itself for style changes
        observer.observe(modal, {
            attributes: true,
            attributeFilter: ['style']
        });

        // Store observer reference for cleanup
        (node as any).samModalObserver = observer;

        // Fallback timeout in case observer doesn't catch the closure
        setTimeout(() => {
            if ((node as any).samMonitoringActive) {
                log.debug("SAM Detector modal monitoring timeout, cleaning up");
                observer.disconnect();
                (node as any).samMonitoringActive = false;
            }
        }, 60000); // 1 minute timeout

        log.info("SAM Detector modal observers set up successfully");
    };
    
    // Start the modal finding process
    findModal();
}

// Function to handle SAM Detector modal closure
function handleSAMDetectorModalClosed(node: ComfyNode) {
    if (!(node as any).samMonitoringActive) {
        log.debug("SAM monitoring already inactive for node", node.id);
        return;
    }

    log.info("SAM Detector modal closed for node", node.id);
    (node as any).samMonitoringActive = false;

    // Clean up observer
    if ((node as any).samModalObserver) {
        (node as any).samModalObserver.disconnect();
        delete (node as any).samModalObserver;
    }

    // Check if there's a new image to process
    if (node.imgs && node.imgs.length > 0) {
        const currentImgSrc = node.imgs[0].src;
        const originalImgSrc = (node as any).samOriginalImgSrc;
        
        if (currentImgSrc && currentImgSrc !== originalImgSrc) {
            log.info("SAM Detector result detected after modal closure, processing mask...");
            handleSAMDetectorResult(node, node.imgs[0]);
        } else {
            log.info("No new image detected after SAM Detector modal closure");
            
            // Show info notification
            showNotification("SAM Detector closed. No mask was applied.", "#4a6cd4", 3000);
        }
    } else {
        log.info("No image available after SAM Detector modal closure");
    }

    // Clean up stored references
    delete (node as any).samOriginalImgSrc;
}

// Fallback function to monitor changes in node.imgs (old polling approach)
function monitorSAMDetectorChanges(node: ComfyNode) {
    let checkCount = 0;
    const maxChecks = 300; // 30 seconds maximum monitoring

    const checkForChanges = () => {
        checkCount++;

        if (!((node as any).samMonitoringActive)) {
            log.debug("SAM monitoring stopped for node", node.id);
            return;
        }

        log.debug(`SAM monitoring check ${checkCount}/${maxChecks} for node ${node.id}`);

        // Check if the node's image has been updated (this happens when "Save to node" is clicked)
        if (node.imgs && node.imgs.length > 0) {
            const currentImgSrc = node.imgs[0].src;
            const originalImgSrc = (node as any).samOriginalImgSrc;
            
            if (currentImgSrc && currentImgSrc !== originalImgSrc) {
                log.info("SAM Detector result detected in node.imgs, processing mask...");
                handleSAMDetectorResult(node, node.imgs[0]);
                (node as any).samMonitoringActive = false;
                return;
            }
        }

        // Continue monitoring if not exceeded max checks
        if (checkCount < maxChecks && (node as any).samMonitoringActive) {
            setTimeout(checkForChanges, 100);
        } else {
            log.debug("SAM Detector monitoring timeout or stopped for node", node.id);
            (node as any).samMonitoringActive = false;
        }
    };

    // Start monitoring after a short delay
    setTimeout(checkForChanges, 500);
}

// Function to handle SAM Detector result (using same logic as CanvasMask.handleMaskEditorClose)
async function handleSAMDetectorResult(node: ComfyNode, resultImage: HTMLImageElement) {
    try {
        log.info("Handling SAM Detector result for node", node.id);
        log.debug("Result image source:", resultImage.src.substring(0, 100) + '...');

        const canvasWidget = (node as any).canvasWidget;
        if (!canvasWidget || !canvasWidget.canvas) {
            log.error("Canvas widget not available for SAM result processing");
            return;
        }

        const canvas = canvasWidget; // canvasWidget is the Canvas object, not canvasWidget.canvas

        // Wait for the result image to load (same as CanvasMask)
        try {
            // First check if the image is already loaded
            if (resultImage.complete && resultImage.naturalWidth > 0) {
                log.debug("SAM result image already loaded", {
                    width: resultImage.width,
                    height: resultImage.height
                });
            } else {
                // Try to reload the image with a fresh request
                log.debug("Attempting to reload SAM result image");
                const originalSrc = resultImage.src;
                
                // Add cache-busting parameter to force fresh load
                const url = new URL(originalSrc);
                url.searchParams.set('_t', Date.now().toString());
                
                await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => {
                        // Copy the loaded image data to the original image
                        resultImage.src = img.src;
                        resultImage.width = img.width;
                        resultImage.height = img.height;
                        log.debug("SAM result image reloaded successfully", {
                            width: img.width,
                            height: img.height,
                            originalSrc: originalSrc,
                            newSrc: img.src
                        });
                        resolve(img);
                    };
                    img.onerror = (error) => {
                        log.error("Failed to reload SAM result image", {
                            originalSrc: originalSrc,
                            newSrc: url.toString(),
                            error: error
                        });
                        reject(error);
                    };
                    img.src = url.toString();
                });
            }
        } catch (error) {
            log.error("Failed to load image from SAM Detector.", error);
            showNotification("Failed to load SAM Detector result. The mask file may not be available.", "#c54747", 5000);
            return;
        }

        // Create temporary canvas for mask processing (same as CanvasMask)
        log.debug("Creating temporary canvas for mask processing");
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});

        if (tempCtx) {
            tempCtx.drawImage(resultImage, 0, 0, canvas.width, canvas.height);

            log.debug("Processing image data to create mask");
            const imageData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            // Convert to mask format (same as CanvasMask)
            for (let i = 0; i < data.length; i += 4) {
                const originalAlpha = data[i + 3];
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = 255 - originalAlpha;
            }

            tempCtx.putImageData(imageData, 0, 0);
        }

        // Convert processed mask to image (same as CanvasMask)
        log.debug("Converting processed mask to image");
        const maskAsImage = new Image();
        maskAsImage.src = tempCanvas.toDataURL();
        await new Promise(resolve => maskAsImage.onload = resolve);

        // Apply mask to LayerForge canvas using MaskTool.setMask method
        log.debug("Checking canvas and maskTool availability", {
            hasCanvas: !!canvas,
            hasMaskTool: !!canvas.maskTool,
            maskToolType: typeof canvas.maskTool,
            canvasKeys: Object.keys(canvas)
        });

        if (!canvas.maskTool) {
            log.error("MaskTool is not available. Canvas state:", {
                hasCanvas: !!canvas,
                canvasConstructor: canvas.constructor.name,
                canvasKeys: Object.keys(canvas),
                maskToolValue: canvas.maskTool
            });
            throw new Error("Mask tool not available or not initialized");
        }

        log.debug("Applying SAM mask to canvas using addMask method");

        // Use the addMask method which overlays on existing mask without clearing it
        canvas.maskTool.addMask(maskAsImage);

        // Update canvas and save state (same as CanvasMask)
        canvas.render();
        canvas.saveState();

        // Create new preview image (same as CanvasMask)
        log.debug("Creating new preview image");
        const new_preview = new Image();
        const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        if (blob) {
            new_preview.src = URL.createObjectURL(blob);
            await new Promise(r => new_preview.onload = r);
            node.imgs = [new_preview];
            log.debug("New preview image created successfully");
        } else {
            log.warn("Failed to create preview blob");
        }

        canvas.render();

        log.info("SAM Detector mask applied successfully to LayerForge canvas");

        // Show success notification
        showNotification("SAM Detector mask applied to LayerForge!", "#4a7c59", 3000);

    } catch (error: any) {
        log.error("Error processing SAM Detector result:", error);
        
        // Show error notification
        showNotification(`Failed to apply SAM mask: ${error.message}`, "#c54747", 5000);
    } finally {
        (node as any).samMonitoringActive = false;
        (node as any).samOriginalImgSrc = null;
    }
}

// Helper function to show notifications
function showNotification(message: string, backgroundColor: string, duration: number) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${backgroundColor};
        color: white;
        padding: 12px 16px;
        border-radius: 4px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        z-index: 10001;
        font-size: 14px;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, duration);
}

// Function to setup SAM Detector hook in menu options
export function setupSAMDetectorHook(node: ComfyNode, options: any[]) {
    // Hook into "Open in SAM Detector" with delay since Impact Pack adds it asynchronously
    const hookSAMDetector = () => {
        const samDetectorIndex = options.findIndex((option) => 
            option && option.content && (
                option.content.includes("SAM Detector") ||
                option.content === "Open in SAM Detector"
            )
        );

        if (samDetectorIndex !== -1) {
            log.info(`Found SAM Detector menu item at index ${samDetectorIndex}: "${options[samDetectorIndex].content}"`);
            const originalSamCallback = options[samDetectorIndex].callback;
            options[samDetectorIndex].callback = async () => {
                try {
                    log.info("Intercepted 'Open in SAM Detector' - automatically sending to clipspace and starting monitoring");
                    
                    // Automatically send canvas to clipspace and start monitoring
                    if ((node as any).canvasWidget && (node as any).canvasWidget.canvas) {
                        const canvas = (node as any).canvasWidget; // canvasWidget IS the Canvas object
                        
                        // Get the flattened canvas as blob
                        const blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
                        if (!blob) {
                            throw new Error("Failed to generate canvas blob");
                        }

                        // Upload the image to ComfyUI's temp storage
                        const formData = new FormData();
                        const filename = `layerforge-sam-${node.id}-${Date.now()}.png`; // Unique filename with timestamp
                        formData.append("image", blob, filename);
                        formData.append("overwrite", "true");
                        formData.append("type", "temp");

                        const response = await api.fetchApi("/upload/image", {
                            method: "POST",
                            body: formData,
                        });

                        if (!response.ok) {
                            throw new Error(`Failed to upload image: ${response.statusText}`);
                        }

                        const data = await response.json();
                        log.debug('Image uploaded for SAM Detector:', data);

                        // Create image element with proper URL
                        const img = new Image();
                        img.crossOrigin = "anonymous"; // Add CORS support
                        
                        // Wait for image to load before setting src
                        const imageLoadPromise = new Promise((resolve, reject) => {
                            img.onload = () => {
                                log.debug("SAM Detector image loaded successfully", {
                                    width: img.width,
                                    height: img.height,
                                    src: img.src.substring(0, 100) + '...'
                                });
                                resolve(img);
                            };
                            img.onerror = (error) => {
                                log.error("Failed to load SAM Detector image", error);
                                reject(new Error("Failed to load uploaded image"));
                            };
                        });
                        
                        // Set src after setting up event handlers
                        img.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
                        
                        // Wait for image to load
                        await imageLoadPromise;

                        // Set the image to the node for clipspace
                        node.imgs = [img];
                        (node as any).clipspaceImg = img;

                        // Copy to ComfyUI clipspace
                        ComfyApp.copyToClipspace(node);
                        
                        // Start monitoring for SAM Detector results
                        startSAMDetectorMonitoring(node);
                        
                        log.info("Canvas automatically sent to clipspace and monitoring started");
                    }
                    
                    // Call the original SAM Detector callback
                    if (originalSamCallback) {
                        await originalSamCallback();
                    }
                    
                } catch (e: any) {
                    log.error("Error in SAM Detector hook:", e);
                    // Still try to call original callback
                    if (originalSamCallback) {
                        await originalSamCallback();
                    }
                }
            };
            return true; // Found and hooked
        }
        return false; // Not found
    };

    // Try to hook immediately
    if (!hookSAMDetector()) {
        // If not found immediately, try again after Impact Pack adds it
        setTimeout(() => {
            if (hookSAMDetector()) {
                log.info("Successfully hooked SAM Detector after delay");
            } else {
                log.debug("SAM Detector menu item not found even after delay");
            }
        }, 150); // Slightly longer delay to ensure Impact Pack has added it
    }
}
