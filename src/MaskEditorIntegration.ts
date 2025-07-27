// @ts-ignore
import {app} from "../../scripts/app.js";
// @ts-ignore
import {ComfyApp} from "../../scripts/app.js";
// @ts-ignore
import {api} from "../../scripts/api.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { uploadCanvasAsImage, uploadCanvasWithMaskAsImage, uploadImageBlob } from "./utils/ImageUploadUtils.js";
import { processImageToMask, processMaskForViewport } from "./utils/MaskProcessingUtils.js";
import { convertToImage } from "./utils/ImageUtils.js";
import { updateNodePreview } from "./utils/PreviewUtils.js";
import { mask_editor_showing, mask_editor_listen_for_cancel } from "./utils/mask_utils.js";

const log = createModuleLogger('MaskEditorIntegration');

export class MaskEditorIntegration {
    canvas: any;
    editorWasShowing: any;
    maskEditorCancelled: any;
    maskTool: any;
    node: any;
    pendingMask: any;
    savedMaskState: any;
    constructor(canvas: any) {
        this.canvas = canvas;
        this.node = canvas.node;
        this.maskTool = canvas.maskTool;

        this.savedMaskState = null;
        this.maskEditorCancelled = false;
        this.pendingMask = null;
        this.editorWasShowing = false;
    }

    /**
     * Uruchamia edytor masek
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask: any = null, sendCleanImage = true) {
        log.info('Starting mask editor', {
            hasPredefinedMask: !!predefinedMask,
            sendCleanImage,
            layersCount: this.canvas.layers.length
        });

        this.savedMaskState = await this.saveMaskState();
        this.maskEditorCancelled = false;

        if (!predefinedMask && this.maskTool && this.maskTool.maskCanvas) {
        try {
            log.debug('Creating mask from current mask tool');
            predefinedMask = await this.createMaskFromCurrentMask();
            log.debug('Mask created from current mask tool successfully');
        } catch (error) {
                log.warn("Could not create mask from current mask:", error);
            }
        }

        this.pendingMask = predefinedMask;

        let blob;
        if (sendCleanImage) {
            log.debug('Getting flattened canvas as blob (clean image)');
            blob = await this.canvas.canvasLayers.getFlattenedCanvasAsBlob();
        } else {
            log.debug('Getting flattened canvas for mask editor (with mask)');
            blob = await this.canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        }

        if (!blob) {
            log.warn("Canvas is empty, cannot open mask editor.");
            return;
        }

        log.debug('Canvas blob created successfully, size:', blob.size);

        try {
            // Use ImageUploadUtils to upload the blob
            const uploadResult = await uploadImageBlob(blob, {
                filenamePrefix: 'layerforge-mask-edit'
            });

            this.node.imgs = [uploadResult.imageElement];

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

        } catch (error) {
            log.error("Error preparing image for mask editor:", error);
            alert(`Error: ${(error as Error).message}`);
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

                const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');
                let editorReady = false;

                if (useNewEditor) {

                    const MaskEditorDialog = window.MaskEditorDialog;
                    if (MaskEditorDialog && MaskEditorDialog.instance) {

                        try {
                            const messageBroker = MaskEditorDialog.instance.getMessageBroker();
                            if (messageBroker) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via MessageBroker");
                            }
                        } catch (e) {

                            editorReady = false;
                        }
                    }

                    if (!editorReady) {
                        const maskEditorElement = document.getElementById('maskEditor');
                        if (maskEditorElement && maskEditorElement.style.display !== 'none') {

                            const canvas = maskEditorElement.querySelector('canvas');
                            if (canvas) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via DOM element");
                            }
                        }
                    }
                } else {

                    const maskCanvas = document.getElementById('maskCanvas') as HTMLCanvasElement;
                    if (maskCanvas) {
                        editorReady = !!(maskCanvas.getContext('2d') && maskCanvas.width > 0 && maskCanvas.height > 0);
                        if (editorReady) {
                            log.info("Old mask editor detected as ready");
                        }
                    }
                }

                if (editorReady) {

                    log.info("Applying mask to editor after", attempts * 100, "ms wait");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 300);
                } else if (attempts < maxAttempts) {

                    if (attempts % 10 === 0) {
                        log.info("Waiting for mask editor to be ready... attempt", attempts, "/", maxAttempts);
                    }
                    setTimeout(checkEditor, 100);
                } else {
                    log.warn("Mask editor timeout - editor not ready after", maxAttempts * 100, "ms");

                    log.info("Attempting to apply mask anyway...");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 100);
                }
            } else if (attempts < maxAttempts) {

                setTimeout(checkEditor, 100);
            } else {
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
    async applyMaskToEditor(maskData: any) {
        try {

            const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');

            if (useNewEditor) {

                const MaskEditorDialog = window.MaskEditorDialog;
                if (MaskEditorDialog && MaskEditorDialog.instance) {

                    await this.applyMaskToNewEditor(maskData);
                } else {
                    log.warn("New editor setting enabled but instance not found, trying old editor");
                    await this.applyMaskToOldEditor(maskData);
                }
            } else {

                await this.applyMaskToOldEditor(maskData);
            }

            log.info("Predefined mask applied to mask editor successfully");
        } catch (error) {
            log.error("Failed to apply predefined mask to editor:", error);

            try {
                log.info("Trying alternative mask application method...");
                await this.applyMaskToOldEditor(maskData);
                log.info("Alternative method succeeded");
            } catch (fallbackError) {
                log.error("Alternative method also failed:", fallbackError);
            }
        }
    }

    /**
     * Nakłada maskę na nowy mask editor (przez MessageBroker)
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToNewEditor(maskData: any) {

        const MaskEditorDialog = window.MaskEditorDialog;
        if (!MaskEditorDialog || !MaskEditorDialog.instance) {
            throw new Error("New mask editor instance not found");
        }

        const editor = MaskEditorDialog.instance;
        const messageBroker = editor.getMessageBroker();

        const maskCanvas = await messageBroker.pull('maskCanvas');
        const maskCtx = await messageBroker.pull('maskCtx');
        const maskColor = await messageBroker.pull('getMaskColor');

        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);

        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(processedMask, 0, 0);

        messageBroker.publish('saveState');
    }

    /**
     * Nakłada maskę na stary mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToOldEditor(maskData: any) {

        const maskCanvas = document.getElementById('maskCanvas') as HTMLCanvasElement;
        if (!maskCanvas) {
            throw new Error("Old mask editor canvas not found");
        }

        const maskCtx = maskCanvas.getContext('2d', {willReadFrequently: true});
        if (!maskCtx) {
            throw new Error("Old mask editor context not found");
        }

        const maskColor = {r: 255, g: 255, b: 255};
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
    async processMaskForEditor(maskData: any, targetWidth: any, targetHeight: any, maskColor: any) {
        // Pozycja maski w świecie względem output bounds
        const bounds = this.canvas.outputAreaBounds;
        const maskWorldX = this.maskTool.x;
        const maskWorldY = this.maskTool.y;
        const panX = maskWorldX - bounds.x;
        const panY = maskWorldY - bounds.y;

        // Use MaskProcessingUtils for viewport processing
        return await processMaskForViewport(
            maskData,
            targetWidth,
            targetHeight,
            { x: panX, y: panY },
            maskColor
        );
    }

    /**
     * Tworzy obiekt Image z obecnej maski canvas
     * @returns {Promise<Image>} Promise zwracający obiekt Image z maską
     */
    async createMaskFromCurrentMask() {
        if (!this.maskTool || !this.maskTool.maskCanvas) {
            throw new Error("No mask canvas available");
        }

        return new Promise((resolve, reject) => {
            const maskImage = new Image();
            maskImage.onload = () => resolve(maskImage);
            maskImage.onerror = reject;
            maskImage.src = this.maskTool.maskCanvas.toDataURL();
        });
    }

    waitWhileMaskEditing() {
        if (mask_editor_showing(app)) {
            this.editorWasShowing = true;
        }

        if (!mask_editor_showing(app) && this.editorWasShowing) {
            this.editorWasShowing = false;
            setTimeout(() => this.handleMaskEditorClose(), 100);
        } else {
            setTimeout(this.waitWhileMaskEditing.bind(this), 100);
        }
    }

    /**
     * Zapisuje obecny stan maski przed otwarciem editora
     * @returns {Object} Zapisany stan maski
     */
    async saveMaskState() {
        if (!this.maskTool || !this.maskTool.maskCanvas) {
            return null;
        }

        const maskCanvas = this.maskTool.maskCanvas;
        const savedCanvas = document.createElement('canvas');
        savedCanvas.width = maskCanvas.width;
        savedCanvas.height = maskCanvas.height;
        const savedCtx = savedCanvas.getContext('2d', {willReadFrequently: true});
        if (savedCtx) {
            savedCtx.drawImage(maskCanvas, 0, 0);
        }

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
    async restoreMaskState(savedState: any) {
        if (!savedState || !this.maskTool) {
            return;
        }

        if (savedState.maskData) {
            const maskCtx = this.maskTool.maskCtx;
            maskCtx.clearRect(0, 0, this.maskTool.maskCanvas.width, this.maskTool.maskCanvas.height);
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

            this.maskEditorCancelled = false;
            this.savedMaskState = null;

            return;
        }

        if (!this.node.imgs || this.node.imgs.length === 0 || !this.node.imgs[0].src) {
            log.warn("Mask editor was closed without a result.");
            return;
        }

        log.debug("Processing mask editor result, image source:", this.node.imgs[0].src.substring(0, 100) + '...');

        const resultImage = new Image();
        resultImage.src = this.node.imgs[0].src;

        try {
            await new Promise((resolve, reject) => {
                resultImage.onload = resolve;
                resultImage.onerror = reject;
            });

            log.debug("Result image loaded successfully", {
                width: resultImage.width,
                height: resultImage.height
            });
        } catch (error) {
            log.error("Failed to load image from mask editor.", error);
            this.node.imgs = [];
            return;
        }

        // Process image to mask using MaskProcessingUtils
        log.debug("Processing image to mask using utils");
        const bounds = this.canvas.outputAreaBounds;
        const processedMask = await processImageToMask(resultImage, {
            targetWidth: bounds.width,
            targetHeight: bounds.height,
            invertAlpha: true
        });

        // Convert processed mask to image
        const maskAsImage = await convertToImage(processedMask);

        log.debug("Applying mask using chunk system", {
            boundsPos: {x: bounds.x, y: bounds.y},
            maskSize: {width: bounds.width, height: bounds.height}
        });

        // Use the chunk system instead of direct canvas manipulation
        this.maskTool.setMask(maskAsImage);

        // Update node preview using PreviewUtils
        await updateNodePreview(this.canvas, this.node, true);

        this.savedMaskState = null;
        log.info("Mask editor result processed successfully");
    }
}
