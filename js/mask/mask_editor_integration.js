// @ts-ignore
import { app } from "../../../scripts/app.js";
// @ts-ignore
import { ComfyApp } from "../../../scripts/app.js";
// @ts-ignore
import { api } from "../../../scripts/api.js";
import { createModuleLogger } from "../log_system/log_funcs.js";
import { showErrorNotification } from "../utils/notification_utils.js";
import { uploadImageBlob } from "../media/image_upload_utils.js";
import { processMaskForViewport } from "./mask_processing_utils.js";
import { applyMaskResultToTool } from "./mask_result_utils.js";
import { updateNodePreview } from "../media/preview_utils.js";
import { get_mask_editor_canvas, mask_editor_showing, mask_editor_listen_for_cancel, new_editor } from "./mask_utils.js";
import { cloneCanvas, createCanvas } from "../utils/common_utils.js";
import { getFlattenedCanvasBlob } from "../media/canvas_blob_utils.js";
import { loadImage, loadImageFromBlob } from "../media/image_utils.js";
const log = createModuleLogger('MaskEditorIntegration');
export class MaskEditorIntegration {
    constructor(canvas) {
        this.canvas = canvas;
        this.node = canvas.node;
        this.maskTool = canvas.maskTool;
        this.savedMaskState = null;
        this.savedNodeImageState = null;
        this.openedImageRef = null;
        this.openedImageUrl = null;
        this.maskEditorCancelled = false;
        this.pendingMask = null;
        this.editorWasShowing = false;
    }
    /**
     * Uruchamia edytor masek
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask = null, sendCleanImage = true) {
        log.info('Starting mask editor', {
            hasPredefinedMask: !!predefinedMask,
            sendCleanImage,
            layersCount: this.canvas.layers.length
        });
        this.savedMaskState = await this.saveMaskState();
        this.savedNodeImageState = this.saveNodeImageState();
        this.maskEditorCancelled = false;
        if (!predefinedMask && this.maskTool) {
            try {
                log.debug('Creating mask from current mask tool');
                predefinedMask = await this.createMaskFromCurrentMask();
                log.debug('Mask created from current mask tool successfully');
            }
            catch (error) {
                log.warn("Could not create mask from current mask:", error);
            }
        }
        this.pendingMask = predefinedMask;
        let blob;
        if (predefinedMask || sendCleanImage) {
            log.debug('Getting flattened canvas as blob (clean image)');
            blob = await getFlattenedCanvasBlob(this.canvas, 'plain');
        }
        else {
            log.debug('Getting flattened canvas for mask editor (with mask)');
            blob = await getFlattenedCanvasBlob(this.canvas, 'with-mask');
        }
        if (!blob) {
            log.warn("Canvas is empty, cannot open mask editor.");
            this.clearEditorSessionState();
            return;
        }
        if (predefinedMask || sendCleanImage) {
            // The native editor treats the uploaded image alpha as its mask.
            // LayerForge layers can legitimately contain transparent pixels,
            // so make the clean editor input fully opaque before opening it.
            try {
                blob = await this.makeOpaqueMaskEditorImage(blob);
            }
            catch (error) {
                log.warn('Could not make the mask editor input opaque; using the original clean image', error);
            }
        }
        log.debug('Canvas blob created successfully, size:', blob.size);
        try {
            // Use ImageUploadUtils to upload the blob
            const uploadResult = await uploadImageBlob(blob, {
                filenamePrefix: 'layerforge-mask-edit'
            });
            this.node.imgs = [uploadResult.imageElement];
            // Image.src is normalized by the browser; keep the same form for
            // the cancel/no-result comparison below.
            this.openedImageUrl = this.node.imgs[0].src || uploadResult.imageUrl;
            this.openedImageRef = this.createImageRef(uploadResult);
            // The current Vue editor prioritizes node.images over node.imgs.
            // Point both contracts at the temporary LayerForge upload so the
            // editor never falls back to an older ComfyUI preview.
            this.node.images = [{ ...this.openedImageRef }];
            log.info('Opening ComfyUI mask editor');
            ComfyApp.copyToClipspace(this.node);
            ComfyApp.clipspace_return_node = this.node;
            ComfyApp.open_maskeditor();
            this.editorWasShowing = false;
            this.waitWhileMaskEditing();
            this.setupCancelListener();
            if (predefinedMask) {
                log.debug('Will apply predefined mask when editor is ready');
                this.waitForMaskEditorAndApplyMask();
            }
        }
        catch (error) {
            log.error("Error preparing image for mask editor:", error);
            this.restoreNodeImageState();
            this.clearEditorSessionState();
            showErrorNotification(`Error: ${error.message}`);
        }
    }
    /**
     * Oblicza dynamiczny czas oczekiwania na podstawie rozmiaru obrazu
     * @returns {number} Czas oczekiwania w milisekundach
     */
    calculateDynamicWaitTime() {
        try {
            // Get canvas dimensions from output area bounds
            const bounds = this.canvas.outputAreaBounds;
            const width = bounds.width;
            const height = bounds.height;
            // Calculate total pixels
            const totalPixels = width * height;
            // Define wait time based on image size
            let waitTime = 500; // Base wait time for small images
            if (totalPixels <= 1000 * 1000) {
                // Below 1MP (1000x1000) - 500ms
                waitTime = 500;
            }
            else if (totalPixels <= 2000 * 2000) {
                // 1MP to 4MP (2000x2000) - 1000ms
                waitTime = 1000;
            }
            else if (totalPixels <= 4000 * 4000) {
                // 4MP to 16MP (4000x4000) - 2000ms
                waitTime = 2000;
            }
            else if (totalPixels <= 6000 * 6000) {
                // 16MP to 36MP (6000x6000) - 4000ms
                waitTime = 4000;
            }
            else {
                // Above 36MP - 6000ms
                waitTime = 6000;
            }
            log.debug("Calculated dynamic wait time", {
                imageSize: `${width}x${height}`,
                totalPixels: totalPixels,
                waitTime: waitTime
            });
            return waitTime;
        }
        catch (error) {
            log.warn("Error calculating dynamic wait time, using default 1000ms", error);
            return 1000; // Fallback to 1 second
        }
    }
    /**
     * Czeka na otwarcie mask editora i automatycznie nakłada predefiniowaną maskę
     */
    waitForMaskEditorAndApplyMask() {
        let attempts = 0;
        const maxAttempts = 100; // Zwiększone do 10 sekund oczekiwania
        const checkEditor = () => {
            attempts++;
            if (mask_editor_showing(app)) {
                let editorReady = false;
                const maskCanvas = get_mask_editor_canvas(app);
                if (maskCanvas) {
                    editorReady = !!(maskCanvas.getContext('2d') && maskCanvas.width > 0 && maskCanvas.height > 0);
                    if (editorReady) {
                        log.info(new_editor(app) ? "Vue mask editor detected as ready" : "Legacy mask editor detected as ready");
                    }
                }
                if (!editorReady) {
                    const MaskEditorDialog = window.MaskEditorDialog;
                    if (MaskEditorDialog?.instance) {
                        try {
                            editorReady = !!MaskEditorDialog.instance.getMessageBroker();
                        }
                        catch {
                            editorReady = false;
                        }
                    }
                }
                if (editorReady) {
                    // Calculate dynamic wait time based on image size
                    const waitTime = this.calculateDynamicWaitTime();
                    log.info("Applying mask to editor after", waitTime, "ms wait (dynamic based on image size)");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, waitTime);
                }
                else if (attempts < maxAttempts) {
                    if (attempts % 10 === 0) {
                        log.info("Waiting for mask editor to be ready... attempt", attempts, "/", maxAttempts);
                    }
                    setTimeout(checkEditor, 100);
                }
                else {
                    log.warn("Mask editor timeout - editor not ready after", maxAttempts * 100, "ms");
                    log.info("Attempting to apply mask anyway...");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 100);
                }
            }
            else if (attempts < maxAttempts) {
                setTimeout(checkEditor, 100);
            }
            else {
                log.warn("Mask editor timeout - editor not showing after", maxAttempts * 100, "ms");
                this.pendingMask = null;
            }
        };
        checkEditor();
    }
    /**
     * Nakłada maskę na otwarty mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski do nałożenia
     */
    async applyMaskToEditor(maskData) {
        try {
            if (new_editor(app) || window.MaskEditorDialog?.instance) {
                await this.applyMaskToNewEditor(maskData);
            }
            else {
                await this.applyMaskToOldEditor(maskData);
            }
            log.info("Predefined mask applied to mask editor successfully");
        }
        catch (error) {
            log.error("Failed to apply predefined mask to editor:", error);
            try {
                log.info("Trying alternative mask application method...");
                await this.applyMaskToOldEditor(maskData);
                log.info("Alternative method succeeded");
            }
            catch (fallbackError) {
                log.error("Alternative method also failed:", fallbackError);
            }
        }
    }
    /**
     * Nakłada maskę na nowy mask editor (przez MessageBroker)
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToNewEditor(maskData) {
        const MaskEditorDialog = window.MaskEditorDialog;
        if (MaskEditorDialog?.instance) {
            const editor = MaskEditorDialog.instance;
            const messageBroker = editor.getMessageBroker();
            const maskCanvas = await messageBroker.pull('maskCanvas');
            const maskCtx = await messageBroker.pull('maskCtx');
            const maskColor = await messageBroker.pull('getMaskColor');
            await this.renderProcessedMask(maskData, maskCanvas, maskCtx, maskColor);
            messageBroker.publish('saveState');
            return;
        }
        const maskCanvas = get_mask_editor_canvas(app);
        if (!maskCanvas) {
            throw new Error("Current mask editor canvas not found");
        }
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!maskCtx) {
            throw new Error("Current mask editor context not found");
        }
        // The current editor starts with its Black blend mode by default.
        await this.renderProcessedMask(maskData, maskCanvas, maskCtx, { r: 0, g: 0, b: 0 });
        await this.synchronizeNativeMaskEditorState();
    }
    /**
     * Nakłada maskę na stary mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToOldEditor(maskData) {
        const maskCanvas = document.getElementById('maskCanvas');
        if (!maskCanvas) {
            throw new Error("Old mask editor canvas not found");
        }
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
        if (!maskCtx) {
            throw new Error("Old mask editor context not found");
        }
        const maskColor = { r: 255, g: 255, b: 255 };
        await this.renderProcessedMask(maskData, maskCanvas, maskCtx, maskColor);
    }
    async renderProcessedMask(maskData, maskCanvas, maskCtx, maskColor) {
        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(processedMask, 0, 0);
    }
    /**
     * Przetwarza maskę do odpowiedniego formatu dla editora
     * @param {Image|HTMLCanvasElement} maskData - Oryginalne dane maski
     * @param {number} targetWidth - Docelowa szerokość
     * @param {number} targetHeight - Docelowa wysokość
     * @param {Object} maskColor - Kolor maski {r, g, b}
     * @returns {HTMLCanvasElement} Przetworzona maska
     */
    async processMaskForEditor(maskData, targetWidth, targetHeight, maskColor) {
        // Pozycja maski w świecie względem output bounds
        const bounds = this.canvas.outputAreaBounds;
        const maskWorldX = this.maskTool.x;
        const maskWorldY = this.maskTool.y;
        const panX = maskWorldX - bounds.x;
        const panY = maskWorldY - bounds.y;
        // Use MaskProcessingUtils for viewport processing
        return await processMaskForViewport(maskData, targetWidth, targetHeight, { x: panX, y: panY }, maskColor);
    }
    /**
     * Tworzy obiekt Image z obecnej maski canvas
     * @returns {Promise<Image>} Promise zwracający obiekt Image z maską
     */
    async createMaskFromCurrentMask() {
        if (!this.maskTool) {
            throw new Error("No mask canvas available");
        }
        return loadImage(this.maskTool.getMask().toDataURL());
    }
    async makeOpaqueMaskEditorImage(blob) {
        const image = await loadImageFromBlob(blob);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const { canvas, ctx } = createCanvas(width, height, '2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error('Could not create a canvas for the mask editor input');
        }
        ctx.drawImage(image, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        for (let i = 3; i < imageData.data.length; i += 4) {
            imageData.data[i] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        return await new Promise((resolve, reject) => {
            canvas.toBlob((result) => {
                if (result) {
                    resolve(result);
                }
                else {
                    reject(new Error('Could not encode the opaque mask editor input as PNG'));
                }
            }, 'image/png');
        });
    }
    /**
     * Synchronizes the direct canvas write with the current Vue editor's
     * private history/GPU state. The native editor initializes its GPU
     * texture from the canvas before external integrations can write the
     * predefined mask, so a canvas-only update is lost on the next brush
     * stroke. There is no public mask-seeding API; the store is accessed only
     * when the current Vue implementation exposes it through its mounted app.
     */
    async synchronizeNativeMaskEditorState() {
        const store = this.getNativeMaskEditorStore();
        const history = store?.canvasHistory;
        if (!history?.saveInitialState || !history?.saveState) {
            log.warn('Native mask editor store is unavailable; predefined mask may not survive the first brush stroke');
            return;
        }
        try {
            // Rebase undo/redo so the predefined mask is the initial state,
            // then advance the index once to trigger the native GPU watcher.
            history.saveInitialState();
            history.saveState();
            // The GPU watcher updates on the next Vue render cycle. Give it a
            // frame before the user can start painting.
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            log.debug('Synchronized predefined mask with native history and GPU state');
        }
        catch (error) {
            log.warn('Could not synchronize predefined mask with native history/GPU state', error);
        }
    }
    getNativeMaskEditorStore() {
        const roots = Array.from(document.querySelectorAll('#vue-app, [data-v-app]'));
        const editorElement = document.querySelector('#maskEditorCanvasContainer, [data-testid="mask-editor-root"], .mask-editor-dialog');
        if (editorElement) {
            roots.unshift(editorElement);
        }
        for (const root of roots) {
            const vueApp = root.__vue_app__;
            const store = this.findMaskEditorStore(vueApp?._context ?? vueApp?.config);
            if (store) {
                return store;
            }
            let component = root.__vueParentComponent;
            while (component) {
                const componentStore = this.findMaskEditorStore(component.appContext);
                if (componentStore) {
                    return componentStore;
                }
                component = component.parent;
            }
        }
        return null;
    }
    findMaskEditorStore(context) {
        const pinia = context?.config?.globalProperties?.$pinia ?? context?.globalProperties?.$pinia;
        return pinia?._s?.get?.('maskEditor') ?? null;
    }
    saveNodeImageState() {
        return {
            images: Array.isArray(this.node.images) ? [...this.node.images] : this.node.images,
            imgs: Array.isArray(this.node.imgs) ? [...this.node.imgs] : this.node.imgs
        };
    }
    restoreNodeImageState() {
        if (!this.savedNodeImageState) {
            return;
        }
        this.node.images = this.savedNodeImageState.images;
        this.node.imgs = this.savedNodeImageState.imgs;
    }
    createImageRef(uploadResult) {
        const data = uploadResult.data ?? {};
        return {
            filename: data.name ?? uploadResult.filename,
            subfolder: data.subfolder ?? '',
            type: data.type ?? 'temp'
        };
    }
    isSameImageRef(left, right) {
        return !!left && !!right &&
            left.filename === right.filename &&
            (left.subfolder ?? '') === (right.subfolder ?? '') &&
            (left.type ?? '') === (right.type ?? '');
    }
    getServerResultUrl() {
        const resultRef = this.node.images?.[0];
        if (!resultRef?.filename || this.isSameImageRef(resultRef, this.openedImageRef)) {
            return null;
        }
        const params = new URLSearchParams({
            filename: resultRef.filename,
            type: resultRef.type ?? 'output',
            subfolder: resultRef.subfolder ?? ''
        });
        return api.apiURL(`/view?${params.toString()}`);
    }
    getPreviewResultSource() {
        const preview = this.node.imgs?.[this.node.imageIndex ?? 0];
        if (!preview?.src || preview.src === this.openedImageUrl) {
            return null;
        }
        return preview.src;
    }
    clearEditorSessionState() {
        this.savedMaskState = null;
        this.savedNodeImageState = null;
        this.openedImageRef = null;
        this.openedImageUrl = null;
    }
    waitWhileMaskEditing() {
        if (mask_editor_showing(app)) {
            this.editorWasShowing = true;
        }
        if (!mask_editor_showing(app) && this.editorWasShowing) {
            this.editorWasShowing = false;
            setTimeout(() => this.handleMaskEditorClose(), 100);
        }
        else {
            setTimeout(this.waitWhileMaskEditing.bind(this), 100);
        }
    }
    /**
     * Zapisuje obecny stan maski przed otwarciem editora
     * @returns {Object} Zapisany stan maski
     */
    async saveMaskState() {
        if (!this.maskTool) {
            return null;
        }
        const maskCanvas = this.maskTool.getMask();
        const savedCanvas = cloneCanvas(maskCanvas);
        return {
            maskData: savedCanvas,
            maskPosition: {
                x: this.maskTool.x,
                y: this.maskTool.y
            }
        };
    }
    /**
     * Przywraca zapisany stan maski
     * @param {Object} savedState - Zapisany stan maski
     */
    async restoreMaskState(savedState) {
        if (!savedState || !this.maskTool) {
            return;
        }
        if (savedState.maskData) {
            const maskCanvas = this.maskTool.getMask();
            const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
            if (!maskCtx) {
                return;
            }
            maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            maskCtx.drawImage(savedState.maskData, 0, 0);
        }
        if (savedState.maskPosition) {
            this.maskTool.x = savedState.maskPosition.x;
            this.maskTool.y = savedState.maskPosition.y;
        }
        this.canvas.render();
        log.info("Mask state restored after cancel");
    }
    /**
     * Konfiguruje nasłuchiwanie na przycisk Cancel w mask editorze
     */
    setupCancelListener() {
        mask_editor_listen_for_cancel(app, () => {
            log.info("Mask editor cancel button clicked");
            this.maskEditorCancelled = true;
        });
    }
    /**
     * Sprawdza czy mask editor został anulowany i obsługuje to odpowiednio
     */
    async handleMaskEditorClose() {
        log.info("Handling mask editor close");
        log.debug("Node object after mask editor close:", this.node);
        if (this.maskEditorCancelled) {
            log.info("Mask editor was cancelled - restoring original mask state");
            if (this.savedMaskState) {
                await this.restoreMaskState(this.savedMaskState);
            }
            this.restoreNodeImageState();
            this.maskEditorCancelled = false;
            this.clearEditorSessionState();
            return;
        }
        const previewResultSource = this.getPreviewResultSource();
        const serverResultUrl = this.getServerResultUrl();
        if (!previewResultSource && !serverResultUrl) {
            log.warn("Mask editor was closed without a result.");
            await this.restoreMaskState(this.savedMaskState);
            this.restoreNodeImageState();
            this.clearEditorSessionState();
            return;
        }
        log.debug("Processing mask editor result", {
            source: previewResultSource ?? serverResultUrl,
            sourceType: previewResultSource ? 'preview' : 'server-reference'
        });
        let resultImage;
        try {
            if (previewResultSource) {
                resultImage = await loadImage(this.node.imgs[0].src);
            }
            else {
                resultImage = await loadImage(serverResultUrl);
            }
            log.debug("Result image loaded successfully", {
                width: resultImage.width,
                height: resultImage.height
            });
        }
        catch (error) {
            log.error("Failed to load image from mask editor.", error);
            this.node.imgs = [];
            await this.restoreMaskState(this.savedMaskState);
            this.restoreNodeImageState();
            this.clearEditorSessionState();
            return;
        }
        // Process image to mask using MaskProcessingUtils
        log.debug("Processing image to mask using utils");
        const bounds = this.canvas.outputAreaBounds;
        log.debug("Applying mask using chunk system", {
            boundsPos: { x: bounds.x, y: bounds.y },
            maskSize: { width: bounds.width, height: bounds.height }
        });
        await applyMaskResultToTool(resultImage, {
            targetWidth: bounds.width,
            targetHeight: bounds.height,
            invertAlpha: true
        }, () => this.maskTool);
        // Update node preview using PreviewUtils
        await updateNodePreview(this.canvas, this.node, true);
        this.clearEditorSessionState();
        log.info("Mask editor result processed successfully");
    }
}
