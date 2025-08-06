import { createModuleLogger } from "./LoggerUtils.js";
// @ts-ignore
import { ComfyApp } from "../../../scripts/app.js";
const log = createModuleLogger('ClipspaceUtils');
/**
 * Validates and fixes ComfyUI clipspace structure to prevent 'Cannot read properties of undefined' errors
 * @returns {boolean} - True if clipspace is valid and ready to use, false otherwise
 */
export function validateAndFixClipspace() {
    log.debug("Validating and fixing clipspace structure");
    // Check if clipspace exists
    if (!ComfyApp.clipspace) {
        log.debug("ComfyUI clipspace is not available");
        return false;
    }
    // Validate clipspace structure
    if (!ComfyApp.clipspace.imgs || ComfyApp.clipspace.imgs.length === 0) {
        log.debug("ComfyUI clipspace has no images");
        return false;
    }
    log.debug("Current clipspace state:", {
        hasImgs: !!ComfyApp.clipspace.imgs,
        imgsLength: ComfyApp.clipspace.imgs?.length,
        selectedIndex: ComfyApp.clipspace.selectedIndex,
        combinedIndex: ComfyApp.clipspace.combinedIndex,
        img_paste_mode: ComfyApp.clipspace.img_paste_mode
    });
    // Ensure required indices are set
    if (ComfyApp.clipspace.selectedIndex === undefined || ComfyApp.clipspace.selectedIndex === null) {
        ComfyApp.clipspace.selectedIndex = 0;
        log.debug("Fixed clipspace selectedIndex to 0");
    }
    if (ComfyApp.clipspace.combinedIndex === undefined || ComfyApp.clipspace.combinedIndex === null) {
        ComfyApp.clipspace.combinedIndex = 0;
        log.debug("Fixed clipspace combinedIndex to 0");
    }
    if (!ComfyApp.clipspace.img_paste_mode) {
        ComfyApp.clipspace.img_paste_mode = 'selected';
        log.debug("Fixed clipspace img_paste_mode to 'selected'");
    }
    // Ensure indices are within bounds
    const maxIndex = ComfyApp.clipspace.imgs.length - 1;
    if (ComfyApp.clipspace.selectedIndex > maxIndex) {
        ComfyApp.clipspace.selectedIndex = maxIndex;
        log.debug(`Fixed clipspace selectedIndex to ${maxIndex} (max available)`);
    }
    if (ComfyApp.clipspace.combinedIndex > maxIndex) {
        ComfyApp.clipspace.combinedIndex = maxIndex;
        log.debug(`Fixed clipspace combinedIndex to ${maxIndex} (max available)`);
    }
    // Verify the image at combinedIndex exists and has src
    const combinedImg = ComfyApp.clipspace.imgs[ComfyApp.clipspace.combinedIndex];
    if (!combinedImg || !combinedImg.src) {
        log.debug("Image at combinedIndex is missing or has no src, trying to find valid image");
        // Try to use the first available image
        for (let i = 0; i < ComfyApp.clipspace.imgs.length; i++) {
            if (ComfyApp.clipspace.imgs[i] && ComfyApp.clipspace.imgs[i].src) {
                ComfyApp.clipspace.combinedIndex = i;
                log.debug(`Fixed combinedIndex to ${i} (first valid image)`);
                break;
            }
        }
        // Final check - if still no valid image found
        const finalImg = ComfyApp.clipspace.imgs[ComfyApp.clipspace.combinedIndex];
        if (!finalImg || !finalImg.src) {
            log.error("No valid images found in clipspace after attempting fixes");
            return false;
        }
    }
    log.debug("Final clipspace structure:", {
        selectedIndex: ComfyApp.clipspace.selectedIndex,
        combinedIndex: ComfyApp.clipspace.combinedIndex,
        img_paste_mode: ComfyApp.clipspace.img_paste_mode,
        imgsLength: ComfyApp.clipspace.imgs?.length,
        combinedImgSrc: ComfyApp.clipspace.imgs[ComfyApp.clipspace.combinedIndex]?.src?.substring(0, 50) + '...'
    });
    return true;
}
/**
 * Safely calls ComfyApp.pasteFromClipspace after validating clipspace structure
 * @param {any} node - The ComfyUI node to paste to
 * @returns {boolean} - True if paste was successful, false otherwise
 */
export function safeClipspacePaste(node) {
    log.debug("Attempting safe clipspace paste");
    if (!validateAndFixClipspace()) {
        log.debug("Clipspace validation failed, cannot paste");
        return false;
    }
    try {
        ComfyApp.pasteFromClipspace(node);
        log.debug("Successfully called pasteFromClipspace");
        return true;
    }
    catch (error) {
        log.error("Error calling pasteFromClipspace:", error);
        return false;
    }
}
