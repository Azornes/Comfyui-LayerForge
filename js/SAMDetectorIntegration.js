// @ts-ignore
import { ComfyApp } from "../../scripts/app.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { showInfoNotification, showSuccessNotification, showErrorNotification } from "./utils/NotificationUtils.js";
import { uploadCanvasAsImage, uploadImageBlob } from "./utils/ImageUploadUtils.js";
import { processImageToMask } from "./utils/MaskProcessingUtils.js";
import { convertToImage } from "./utils/ImageUtils.js";
import { updateNodePreview } from "./utils/PreviewUtils.js";
const log = createModuleLogger('SAMDetectorIntegration');
/**
 * SAM Detector Integration for LayerForge
 * Handles automatic clipspace integration and mask application from Impact Pack's SAM Detector
 */
// Function to register image in clipspace for Impact Pack compatibility
export const registerImageInClipspace = async (node, blob) => {
    try {
        // Use ImageUploadUtils to upload the blob
        const uploadResult = await uploadImageBlob(blob, {
            filenamePrefix: 'layerforge-sam',
            nodeId: node.id
        });
        log.debug(`Image registered in clipspace for node ${node.id}: ${uploadResult.filename}`);
        return uploadResult.imageElement;
    }
    catch (error) {
        log.debug("Failed to register image in clipspace:", error);
        return null;
    }
};
// Function to monitor for SAM Detector modal closure and apply masks to LayerForge
export function startSAMDetectorMonitoring(node) {
    if (node.samMonitoringActive) {
        log.debug("SAM Detector monitoring already active for node", node.id);
        return;
    }
    node.samMonitoringActive = true;
    log.info("Starting SAM Detector modal monitoring for node", node.id);
    // Store original image source for comparison
    const originalImgSrc = node.imgs?.[0]?.src;
    node.samOriginalImgSrc = originalImgSrc;
    // Start monitoring for SAM Detector modal closure
    monitorSAMDetectorModal(node);
}
// Function to monitor SAM Detector modal closure
function monitorSAMDetectorModal(node) {
    log.info("Starting SAM Detector modal monitoring for node", node.id);
    // Try to find modal multiple times with increasing delays
    let attempts = 0;
    const maxAttempts = 10; // Try for 5 seconds total
    const findModal = () => {
        attempts++;
        log.debug(`Looking for SAM Detector modal, attempt ${attempts}/${maxAttempts}`);
        // Look for SAM Detector specific elements instead of generic modal
        const samCanvas = document.querySelector('#samEditorMaskCanvas');
        const pointsCanvas = document.querySelector('#pointsCanvas');
        const imageCanvas = document.querySelector('#imageCanvas');
        // Debug: Log SAM specific elements
        log.debug(`SAM specific elements found:`, {
            samCanvas: !!samCanvas,
            pointsCanvas: !!pointsCanvas,
            imageCanvas: !!imageCanvas
        });
        // Find the modal that contains SAM Detector elements
        let modal = null;
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
            }
            else {
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
                        if (removedNode === modal || removedNode?.contains?.(modal)) {
                            log.info("SAM Detector modal removed from DOM");
                            handleSAMDetectorModalClosed(node);
                            observer.disconnect();
                        }
                    });
                }
                // Check if modal style changed to hidden
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const target = mutation.target;
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
        node.samModalObserver = observer;
        // Fallback timeout in case observer doesn't catch the closure
        setTimeout(() => {
            if (node.samMonitoringActive) {
                log.debug("SAM Detector modal monitoring timeout, cleaning up");
                observer.disconnect();
                node.samMonitoringActive = false;
            }
        }, 60000); // 1 minute timeout
        log.info("SAM Detector modal observers set up successfully");
    };
    // Start the modal finding process
    findModal();
}
// Function to handle SAM Detector modal closure
function handleSAMDetectorModalClosed(node) {
    if (!node.samMonitoringActive) {
        log.debug("SAM monitoring already inactive for node", node.id);
        return;
    }
    log.info("SAM Detector modal closed for node", node.id);
    node.samMonitoringActive = false;
    // Clean up observer
    if (node.samModalObserver) {
        node.samModalObserver.disconnect();
        delete node.samModalObserver;
    }
    // Check if there's a new image to process
    if (node.imgs && node.imgs.length > 0) {
        const currentImgSrc = node.imgs[0].src;
        const originalImgSrc = node.samOriginalImgSrc;
        if (currentImgSrc && currentImgSrc !== originalImgSrc) {
            log.info("SAM Detector result detected after modal closure, processing mask...");
            handleSAMDetectorResult(node, node.imgs[0]);
        }
        else {
            log.info("No new image detected after SAM Detector modal closure");
            // Show info notification
            showInfoNotification("SAM Detector closed. No mask was applied.");
        }
    }
    else {
        log.info("No image available after SAM Detector modal closure");
    }
    // Clean up stored references
    delete node.samOriginalImgSrc;
}
// Fallback function to monitor changes in node.imgs (old polling approach)
function monitorSAMDetectorChanges(node) {
    let checkCount = 0;
    const maxChecks = 300; // 30 seconds maximum monitoring
    const checkForChanges = () => {
        checkCount++;
        if (!(node.samMonitoringActive)) {
            log.debug("SAM monitoring stopped for node", node.id);
            return;
        }
        log.debug(`SAM monitoring check ${checkCount}/${maxChecks} for node ${node.id}`);
        // Check if the node's image has been updated (this happens when "Save to node" is clicked)
        if (node.imgs && node.imgs.length > 0) {
            const currentImgSrc = node.imgs[0].src;
            const originalImgSrc = node.samOriginalImgSrc;
            if (currentImgSrc && currentImgSrc !== originalImgSrc) {
                log.info("SAM Detector result detected in node.imgs, processing mask...");
                handleSAMDetectorResult(node, node.imgs[0]);
                node.samMonitoringActive = false;
                return;
            }
        }
        // Continue monitoring if not exceeded max checks
        if (checkCount < maxChecks && node.samMonitoringActive) {
            setTimeout(checkForChanges, 100);
        }
        else {
            log.debug("SAM Detector monitoring timeout or stopped for node", node.id);
            node.samMonitoringActive = false;
        }
    };
    // Start monitoring after a short delay
    setTimeout(checkForChanges, 500);
}
// Function to handle SAM Detector result (using same logic as MaskEditorIntegration.handleMaskEditorClose)
async function handleSAMDetectorResult(node, resultImage) {
    try {
        log.info("Handling SAM Detector result for node", node.id);
        log.debug("Result image source:", resultImage.src.substring(0, 100) + '...');
        const canvasWidget = node.canvasWidget;
        if (!canvasWidget || !canvasWidget.canvas) {
            log.error("Canvas widget not available for SAM result processing");
            return;
        }
        const canvas = canvasWidget; // canvasWidget is the Canvas object, not canvasWidget.canvas
        // Wait for the result image to load (same as MaskEditorIntegration)
        try {
            // First check if the image is already loaded
            if (resultImage.complete && resultImage.naturalWidth > 0) {
                log.debug("SAM result image already loaded", {
                    width: resultImage.width,
                    height: resultImage.height
                });
            }
            else {
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
        }
        catch (error) {
            log.error("Failed to load image from SAM Detector.", error);
            showErrorNotification("Failed to load SAM Detector result. The mask file may not be available.");
            return;
        }
        // Process image to mask using MaskProcessingUtils
        log.debug("Processing image to mask using utils");
        const processedMask = await processImageToMask(resultImage, {
            targetWidth: resultImage.width,
            targetHeight: resultImage.height,
            invertAlpha: true
        });
        // Convert processed mask to image
        const maskAsImage = await convertToImage(processedMask);
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
        // Update canvas and save state (same as MaskEditorIntegration)
        canvas.render();
        canvas.saveState();
        // Update node preview using PreviewUtils
        await updateNodePreview(canvas, node, true);
        log.info("SAM Detector mask applied successfully to LayerForge canvas");
        // Show success notification
        showSuccessNotification("SAM Detector mask applied to LayerForge!");
    }
    catch (error) {
        log.error("Error processing SAM Detector result:", error);
        // Show error notification
        showErrorNotification(`Failed to apply SAM mask: ${error.message}`);
    }
    finally {
        node.samMonitoringActive = false;
        node.samOriginalImgSrc = null;
    }
}
// Function to setup SAM Detector hook in menu options
export function setupSAMDetectorHook(node, options) {
    // Hook into "Open in SAM Detector" with delay since Impact Pack adds it asynchronously
    const hookSAMDetector = () => {
        const samDetectorIndex = options.findIndex((option) => option && option.content && (option.content.includes("SAM Detector") ||
            option.content === "Open in SAM Detector"));
        if (samDetectorIndex !== -1) {
            log.info(`Found SAM Detector menu item at index ${samDetectorIndex}: "${options[samDetectorIndex].content}"`);
            const originalSamCallback = options[samDetectorIndex].callback;
            options[samDetectorIndex].callback = async () => {
                try {
                    log.info("Intercepted 'Open in SAM Detector' - automatically sending to clipspace and starting monitoring");
                    // Automatically send canvas to clipspace and start monitoring
                    if (node.canvasWidget && node.canvasWidget.canvas) {
                        const canvas = node.canvasWidget; // canvasWidget IS the Canvas object
                        // Use ImageUploadUtils to upload canvas
                        const uploadResult = await uploadCanvasAsImage(canvas, {
                            filenamePrefix: 'layerforge-sam',
                            nodeId: node.id
                        });
                        // Set the image to the node for clipspace
                        node.imgs = [uploadResult.imageElement];
                        node.clipspaceImg = uploadResult.imageElement;
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
                }
                catch (e) {
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
            }
            else {
                log.debug("SAM Detector menu item not found even after delay");
            }
        }, 150); // Slightly longer delay to ensure Impact Pack has added it
    }
}
