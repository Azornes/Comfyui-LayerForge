import { createCanvas } from "./utils/CommonUtils.js";
import { createModuleLogger } from "./log_system/log_funcs.js";
import { showErrorNotification } from "./utils/NotificationUtils.js";
import { webSocketManager } from "./utils/WebSocketManager.js";
import { scaleImageToFit, loadImage, blobToDataUrl, tensorToImageData, createImageFromImageData } from "./utils/ImageUtils.js";
import { postImageBlob } from "./utils/ImageUploadUtils.js";
import { getImageAddMode, isFitOnAddEnabled } from "./utils/CanvasInputUtils.js";
import {
    getLayerForgeImageInputLinks,
    getLayerForgeImageInputSlot,
    getLayerForgeMaskInputSlot,
    hasLayerForgeImageInput,
} from "./utils/MultiImageInputUtils.js";
import type { Canvas } from './Canvas';
import type { Layer, Shape, AddMode } from './types';

const log = createModuleLogger('CanvasIO');

interface BackendInputData {
    input_images?: Array<{ data: string }>;
    input_images_batch?: Array<{ data: string }>;
    input_image?: string;
}

interface ConnectedImageSource {
    sourceNode: any;
    sourceId: number;
    sourceSlot: number;
}

export interface ConnectedInputImage {
    image: HTMLImageElement;
    sourceId: number;
    sourceSlot: number;
    imageIndex: number;
    sourceLabel: string;
}

function imageBatchIdentity(sources: readonly string[]): string {
    return sources.join('|');
}

function getBackendImageSources(data?: BackendInputData): Array<{ data: string }> {
    if (Array.isArray(data?.input_images)) return data.input_images;
    if (Array.isArray(data?.input_images_batch)) return data.input_images_batch;
    if (data?.input_image) return [{ data: data.input_image }];
    return [];
}

function getBackendImageIdentity(data?: BackendInputData): string | undefined {
    const sources = getBackendImageSources(data);
    return sources.length > 0 ? imageBatchIdentity(sources.map(image => image.data)) : undefined;
}

export class CanvasIO {
    private _saveInProgress: Promise<any> | null;
    private canvas: Canvas;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this._saveInProgress = null;
    }

    private getImageInputSlot(): any | null {
        return getLayerForgeImageInputSlot(this.canvas.node);
    }

    private getMaskInputSlot(): any | null {
        return getLayerForgeMaskInputSlot(this.canvas.node);
    }

    private getGraphLink(linkId: any): any | null {
        const graph = (this.canvas.node as any).graph;
        if (!graph || linkId == null) return null;

        for (const links of [graph.links, graph._links]) {
            if (!links) continue;
            if (typeof links.get === 'function') {
                const link = links.get(linkId) ?? links.get(String(linkId));
                if (link) return link;
            }

            const link = links[linkId] ?? links[String(linkId)];
            if (link) return link;
        }

        return null;
    }

    private getImageInputIdentity(): string | number | undefined {
        const virtualLinks = getLayerForgeImageInputLinks(this.canvas.node);
        if (virtualLinks.length > 0) {
            return `virtual:${virtualLinks.map(link => `${link.source_id}:${link.source_slot}`).join('|')}`;
        }

        return this.getImageInputSlot()?.link;
    }

    private getConnectedImageSources(): ConnectedImageSource[] {
        const graph = (this.canvas.node as any).graph;
        if (!graph) return [];

        const sources: ConnectedImageSource[] = [];
        const seen = new Set<string>();
        const addSource = (sourceId: number, sourceSlot: number): void => {
            const sourceNode = graph.getNodeById?.(sourceId);
            if (!sourceNode?.imgs?.length) return;

            const key = `${sourceId}:${sourceSlot}`;
            if (seen.has(key)) return;
            seen.add(key);
            sources.push({ sourceNode, sourceId, sourceSlot });
        };

        for (const link of getLayerForgeImageInputLinks(this.canvas.node)) {
            addSource(link.source_id, link.source_slot);
        }

        const nativeLinkId = this.getImageInputSlot()?.link;
        const nativeLink = this.getGraphLink(nativeLinkId);
        if (nativeLink) {
            const sourceId = Number(nativeLink.origin_id ?? nativeLink.originId);
            const sourceSlot = Number(nativeLink.origin_slot ?? nativeLink.originSlot ?? 0);
            if (Number.isFinite(sourceId)) addSource(sourceId, Number.isFinite(sourceSlot) ? sourceSlot : 0);
        }

        return sources;
    }

    getConnectedInputImages(): ConnectedInputImage[] {
        return this.getConnectedImageSources().flatMap(({ sourceNode, sourceId, sourceSlot }) => {
            const sourceLabel = String(
                sourceNode.title
                || sourceNode.label
                || sourceNode.comfyClass
                || sourceNode.type
                || `Node ${sourceId}`
            );

            return (sourceNode.imgs as HTMLImageElement[]).map((image, imageIndex) => ({
                image,
                sourceId,
                sourceSlot,
                imageIndex,
                sourceLabel,
            }));
        });
    }

    private hasImageInput(): boolean {
        return hasLayerForgeImageInput(this.canvas.node);
    }

    private async addBatchImages(
        images: readonly (HTMLImageElement | string)[],
        addMode: AddMode,
        targetArea: { x: number, y: number, width: number, height: number } | null,
        logSuffix: string
    ): Promise<void> {
        for (let i = 0; i < images.length; i++) {
            const imageSource = images[i];
            const image = typeof imageSource === 'string' ? await loadImage(imageSource) : imageSource;

            await this.canvas.canvasLayers.addLayerWithImage(
                image,
                { name: `Batch Image ${i + 1}` },
                addMode,
                targetArea
            );

            log.debug(`Added batch image ${i + 1}/${images.length} ${logSuffix}`);
        }
    }

    private canvasToPngBlob(canvas: HTMLCanvasElement, callback: (blob: Blob | null) => void): void {
        canvas.toBlob(callback, "image/png");
    }

    async saveToServer(fileName: string, outputMode = 'disk'): Promise<any> {
        if (outputMode === 'disk') {
            if (!(window as any).canvasSaveStates) {
                (window as any).canvasSaveStates = new Map();
            }

            const nodeId = this.canvas.node.id;
            const saveKey = `${nodeId}_${fileName}`;
            if (this._saveInProgress || (window as any).canvasSaveStates.get(saveKey)) {
                log.warn(`Save already in progress for node ${nodeId}, waiting...`);
                return this._saveInProgress || (window as any).canvasSaveStates.get(saveKey);
            }

            log.info(`Starting saveToServer (disk) with fileName: ${fileName} for node: ${nodeId}`);
            this._saveInProgress = this._performSave(fileName, outputMode);
            (window as any).canvasSaveStates.set(saveKey, this._saveInProgress);

            try {
                return await this._saveInProgress;
            } finally {
                this._saveInProgress = null;
                (window as any).canvasSaveStates.delete(saveKey);
                log.debug(`Save completed for node ${nodeId}, lock released`);
            }
        } else {
            log.info(`Starting saveToServer (RAM) for node: ${this.canvas.node.id}`);
            return this._performSave(fileName, outputMode);
        }
    }

    async _performSave(fileName: string, outputMode: string): Promise<any> {
        if (this.canvas.layers.length === 0) {
            log.warn(`Node ${this.canvas.node.id} has no layers, creating empty canvas`);
            return Promise.resolve(true);
        }
        await this.canvas.canvasState.saveStateToDB();
        const nodeId = this.canvas.node.id;
        const delay = (nodeId % 10) * 50;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return new Promise((resolve) => {
            const originalShape = this.canvas.outputAreaShape;
            this.canvas.outputAreaShape = null;

            const renderBounds = { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height };
            const { canvas: tempCanvas } = this.canvas.canvasLayers.renderLayersToCanvas(
                renderBounds,
                this.canvas.layers,
                {}
            );
            const { canvas: maskCanvas, ctx: maskCtx } = this.canvas.canvasLayers.renderLayerVisibilityMask(
                renderBounds,
                this.canvas.layers,
                {
                    maskContextOptions: {},
                    visibilityContextOptions: { alpha: true }
                }
            );

            log.debug(`Canvas contexts created, starting layer rendering`);
            log.debug(`Finished rendering layers`);

            this.canvas.outputAreaShape = originalShape;

            // Use optimized getMaskForOutputArea() instead of getMask() for better performance
            // This only processes chunks that overlap with the output area
            const toolMaskCanvas = this.canvas.maskTool.getMaskForOutputArea();
            if (toolMaskCanvas) {
                log.debug(`Using optimized output area mask (${toolMaskCanvas.width}x${toolMaskCanvas.height}) instead of full mask`);

                // The optimized mask is already sized and positioned for the output area
                // So we can draw it directly without complex positioning calculations
                const tempMaskData = toolMaskCanvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, toolMaskCanvas.width, toolMaskCanvas.height);
                if (tempMaskData) {
                    // Ensure the mask data is in the correct format (white with alpha)
                    for (let i = 0; i < tempMaskData.data.length; i += 4) {
                        const alpha = tempMaskData.data[i + 3];
                        tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = 255;
                        tempMaskData.data[i + 3] = alpha;
                    }
                    
                    // Create a temporary canvas to hold the processed mask
                    const { canvas: tempMaskCanvas, ctx: tempMaskCtx } = createCanvas(this.canvas.width, this.canvas.height, '2d', { willReadFrequently: true });
                    if (!tempMaskCtx) throw new Error("Could not create temp mask context");
                    
                    // Put the processed mask data into a canvas that matches the output area size
                    const { canvas: outputMaskCanvas, ctx: outputMaskCtx } = createCanvas(toolMaskCanvas.width, toolMaskCanvas.height, '2d', { willReadFrequently: true });
                    if (!outputMaskCtx) throw new Error("Could not create output mask context");
                    
                    outputMaskCtx.putImageData(tempMaskData, 0, 0);
                    
                    // Draw the optimized mask at the correct position (output area bounds)
                    const bounds = this.canvas.outputAreaBounds;
                    tempMaskCtx.drawImage(outputMaskCanvas, bounds.x, bounds.y);
                    
                    maskCtx.globalCompositeOperation = 'source-over';
                    maskCtx.drawImage(tempMaskCanvas, 0, 0);
                }
            }
            if (outputMode === 'ram') {
                const imageData = tempCanvas.toDataURL('image/png');
                const maskData = maskCanvas.toDataURL('image/png');
                log.info("Returning image and mask data as base64 for RAM mode.");
                resolve({image: imageData, mask: maskData});
                return;
            }

            const fileNameWithoutMask = fileName.replace('.png', '_without_mask.png');
            log.info(`Saving image without mask as: ${fileNameWithoutMask}`);

            this.canvasToPngBlob(tempCanvas, async (blobWithoutMask) => {
                if (!blobWithoutMask) return;
                log.debug(`Created blob for image without mask, size: ${blobWithoutMask.size} bytes`);

                try {
                    const response = await postImageBlob(
                        { blob: blobWithoutMask, filename: fileNameWithoutMask },
                        fetch
                    );
                    log.debug(`Image without mask upload response: ${response.status}`);
                } catch (error) {
                    log.error(`Error uploading image without mask:`, error);
                }
            });
            log.info(`Saving main image as: ${fileName}`);
            this.canvasToPngBlob(tempCanvas, async (blob) => {
                if (!blob) return;
                log.debug(`Created blob for main image, size: ${blob.size} bytes`);

                try {
                    const resp = await postImageBlob(
                        { blob, filename: fileName },
                        fetch
                    );
                    log.debug(`Main image upload response: ${resp.status}`);

                    if (resp.status === 200) {
                        const maskFileName = fileName.replace('.png', '_mask.png');
                        log.info(`Saving mask as: ${maskFileName}`);

                        this.canvasToPngBlob(maskCanvas, async (maskBlob) => {
                            if (!maskBlob) return;
                            log.debug(`Created blob for mask, size: ${maskBlob.size} bytes`);

                            try {
                                const maskResp = await postImageBlob(
                                    { blob: maskBlob, filename: maskFileName },
                                    fetch
                                );
                                log.debug(`Mask upload response: ${maskResp.status}`);

                                if (maskResp.status === 200) {
                                    const data = await resp.json();
                                    if (this.canvas.widget) {
                                        this.canvas.widget.value = fileName;
                                    }
                                    log.info(`All files saved successfully, widget value set to: ${fileName}`);
                                    resolve(true);
                                } else {
                                    log.error(`Error saving mask: ${maskResp.status}`);
                                    resolve(false);
                                }
                            } catch (error) {
                                log.error(`Error saving mask:`, error);
                                resolve(false);
                            }
                        });
                    } else {
                        log.error(`Main image upload failed: ${resp.status} - ${resp.statusText}`);
                        resolve(false);
                    }
                } catch (error) {
                    log.error(`Error uploading main image:`, error);
                    resolve(false);
                }
            });
        });
    }

    async _renderOutputData(): Promise<{ image: string, mask: string }> {
        log.info("=== RENDERING OUTPUT DATA FOR COMFYUI ===");

        // Check if layers have valid images loaded, with retry logic
        const maxRetries = 5;
        const retryDelay = 200;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const layersWithoutImages = this.canvas.layers.filter(layer => !layer.image || !layer.image.complete);

            if (layersWithoutImages.length === 0) {
                break; // All images loaded
            }

            if (attempt === 0) {
                log.warn(`${layersWithoutImages.length} layer(s) have incomplete image data. Waiting for images to load...`);
            }

            if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                // Last attempt failed
                throw new Error(`Canvas not ready after ${maxRetries} attempts: ${layersWithoutImages.length} layer(s) still have incomplete image data. Try waiting a moment and running again.`);
            }
        }

        // Użyj zunifikowanych funkcji z CanvasLayers
        const imageBlob = await this.canvas.canvasLayers.getFlattenedCanvasAsBlob();
        const maskBlob = await this.canvas.canvasLayers.getFlattenedMaskAsBlob();

        if (!imageBlob || !maskBlob) {
            throw new Error("Failed to generate canvas or mask blobs");
        }
        
        // Konwertuj blob na data URL
        const imageDataUrl = await blobToDataUrl(imageBlob);
        const maskDataUrl = await blobToDataUrl(maskBlob);
        
        const bounds = this.canvas.outputAreaBounds;
        log.info(`=== OUTPUT DATA GENERATED ===`);
        log.info(`Image size: ${bounds.width}x${bounds.height}`);
        log.info(`Image data URL length: ${imageDataUrl.length}`);
        log.info(`Mask data URL length: ${maskDataUrl.length}`);

        return { image: imageDataUrl, mask: maskDataUrl };
    }

    async sendDataViaWebSocket(nodeId: number): Promise<boolean> {
        log.info(`Preparing to send data for node ${nodeId} via WebSocket.`);

        const { image, mask } = await this._renderOutputData();

        try {
            log.info(`Sending data for node ${nodeId}...`);
            await webSocketManager.sendMessage({
                type: 'canvas_data',
                nodeId: String(nodeId),
                image: image,
                mask: mask,
            }, true); // `true` requires an acknowledgment

            log.info(`Data for node ${nodeId} has been sent and acknowledged by the server.`);
            return true;
        } catch (error) {
            log.error(`Failed to send data for node ${nodeId}:`, error);


        throw new Error(
        `Failed to get confirmation from server for node ${nodeId}. ` +
        `Make sure that the nodeId: (${nodeId}) matches the "node_id" value in the node options. If they don't match, you may need to manually set the node_id to ${nodeId}.` +
        `If the issue persists, try using a different browser. Some issues have been observed specifically with portable versions of Chrome, ` +
        `which may have limitations related to memory or WebSocket handling. Consider testing in a standard Chrome installation, Firefox, or another browser.`
        );
        }
    }

    private async tensorToRgbImage(tensor: any): Promise<HTMLImageElement | null> {
        const imageData = tensorToImageData(tensor, 'rgb');
        if (!imageData) {
            return null;
        }

        return createImageFromImageData(imageData);
    }

    async addInputToCanvas(inputImage: any, inputMask: any): Promise<boolean> {
        try {
            log.debug("Adding input to canvas:", { inputImage });

            const image = await this.tensorToRgbImage(inputImage);
            if (!image) throw new Error("Failed to convert input image tensor");

            const bounds = this.canvas.outputAreaBounds;
            const scale = Math.min(
                bounds.width / inputImage.width * 0.8,
                bounds.height / inputImage.height * 0.8
            );

            const layer = await this.canvas.canvasLayers.addLayerWithImage(image, {
                x: bounds.x + (bounds.width - inputImage.width * scale) / 2,
                y: bounds.y + (bounds.height - inputImage.height * scale) / 2,
                width: inputImage.width * scale,
                height: inputImage.height * scale,
            });

            if (inputMask && layer) {
                (layer as any).mask = inputMask.data;
            }

            log.info("Layer added successfully");
            return true;

        } catch (error) {
            log.error("Error in addInputToCanvas:", error);
            throw error;
        }
    }

    async convertTensorToImage(tensor: any): Promise<HTMLImageElement> {
        try {
            log.debug("Converting tensor to image:", tensor);

            if (!tensor || !tensor.data || !tensor.width || !tensor.height) {
                throw new Error("Invalid tensor data");
            }

            const image = await this.tensorToRgbImage(tensor);
            if (!image) throw new Error("Failed to convert tensor to image data");

            return image;
        } catch (error) {
            log.error("Error converting tensor to image:", error);
            throw error;
        }
    }

    async convertTensorToMask(tensor: any): Promise<Float32Array> {
        if (!tensor || !tensor.data) {
            throw new Error("Invalid mask tensor");
        }

        try {
            return new Float32Array(tensor.data);
        } catch (error: any) {
            throw new Error(`Mask conversion failed: ${error.message}`);
        }
    }

    async initNodeData(): Promise<void> {
        try {
            log.info("Starting node data initialization...");

            // First check for input data from the backend (new feature)
            await this.checkForInputData();

            // If we've already loaded input data, don't continue with old initialization
            if (this.canvas.inputDataLoaded) {
                log.debug("Input data already loaded, skipping old initialization");
                this.canvas.dataInitialized = true;
                return;
            }

            if (!this.canvas.node || !(this.canvas.node as any).inputs) {
                log.debug("Node or inputs not ready");
                return this.scheduleDataCheck();
            }

            const imageInput = this.getImageInputSlot();
            if (this.hasImageInput()) {
                const imageLinkId = imageInput?.link;
                
                // Check if we already loaded this link
                if (imageLinkId != null && this.canvas.lastLoadedLinkId === imageLinkId) {
                    log.debug(`Link ${imageLinkId} already loaded via new system, marking as initialized`);
                    this.canvas.dataInitialized = true;
                    return;
                }
                
                const imageData = imageLinkId != null
                    ? (window as any).app.nodeOutputs[imageLinkId]
                    : undefined;

                if (imageData) {
                    log.debug("Found image data:", imageData);
                    await this.processImageData(imageData);
                    this.canvas.dataInitialized = true;
                } else {
                    log.debug("Image data not available yet");
                    return this.scheduleDataCheck();
                }
            } else {
                // No input connected, mark as initialized to stop repeated checks
                this.canvas.dataInitialized = true;
            }

            const maskInput = this.getMaskInputSlot();
            if (maskInput?.link != null) {
                const maskLinkId = maskInput.link;
                const maskData = (window as any).app.nodeOutputs[maskLinkId];

                if (maskData) {
                    log.debug("Found mask data:", maskData);
                    await this.processMaskData(maskData);
                }
            }

        } catch (error) {
            log.error("Error in initNodeData:", error);
            return this.scheduleDataCheck();
        }
    }

    async checkForInputData(options?: { allowImage?: boolean; allowMask?: boolean; reason?: string }): Promise<void> {
        try {
            const nodeId = this.canvas.node.id;
            const allowImage = options?.allowImage ?? true;
            const allowMask = options?.allowMask ?? true;
            const reason = options?.reason ?? 'unspecified';
            log.info(`Checking for input data for node ${nodeId}... opts: image=${allowImage}, mask=${allowMask}, reason=${reason}`);
            
            // Track loaded links separately for image and mask
            let imageLoaded = false;
            let maskLoaded = false;
            let imageChanged = false;
            
            // First, try to get data from every connected image source. The visible
            // input can have several virtual links, while legacy native links remain
            // supported as a fallback.
            const connectedImageSources = this.getConnectedImageSources();
            if (allowImage && connectedImageSources.length > 0) {
                const imageInputIdentity = this.getImageInputIdentity() ?? 'image-input';
                const currentSourceIdentities = connectedImageSources.map(({ sourceNode }) => imageBatchIdentity(sourceNode.imgs.map((img: HTMLImageElement) => img.src)));
                const currentBatchImageSrcs = imageBatchIdentity(currentSourceIdentities);

                if (this.canvas.lastLoadedLinkId === imageInputIdentity) {
                    if (this.canvas.lastLoadedImageSrc !== currentBatchImageSrcs) {
                        log.info(`Connected input images changed (${connectedImageSources.length} source(s)), will reload...`);
                        log.debug(`Previous image hash: ${this.canvas.lastLoadedImageSrc?.substring(0, 100)}...`);
                        log.debug(`Current image hash: ${currentBatchImageSrcs.substring(0, 100)}...`);
                        imageChanged = true;
                        this.canvas.inputDataLoaded = false;
                        this.canvas.lastLoadedImageSrc = undefined;
                        fetch(`/layerforge/clear_input_data/${nodeId}`, { method: 'POST' })
                            .then(() => log.debug("Backend input data cleared due to image change"))
                            .catch(err => log.error("Failed to clear backend data:", err));
                    } else {
                        log.debug(`Connected input images unchanged (${connectedImageSources.length} source(s))`);
                        imageLoaded = true;
                    }
                } else {
                    log.info(`New image input connection set detected, will load ${connectedImageSources.length} source(s)`);
                    imageChanged = false;
                    imageLoaded = false;
                    this.canvas.inputDataLoaded = false;
                }

                if (!imageLoaded || imageChanged) {
                    if (imageChanged) {
                        this.canvas.inputDataLoaded = false;
                        log.info("Resetting inputDataLoaded flag due to image change");
                    }

                    const sourceImages = connectedImageSources.flatMap(({ sourceNode }) => sourceNode.imgs as HTMLImageElement[]);
                    if (sourceImages.length > 0) {
                        log.info(`Found ${sourceImages.length} image(s) across ${connectedImageSources.length} connected source(s), loading all`);
                        const sourceIdentities = connectedImageSources.map(({ sourceNode }) => imageBatchIdentity(sourceNode.imgs.map((img: HTMLImageElement) => img.src)));
                        const batchImageSrcs = imageBatchIdentity(sourceIdentities);

                        this.canvas.lastLoadedLinkId = imageInputIdentity;
                        this.canvas.lastLoadedImageSrc = batchImageSrcs;

                        if (imageChanged) log.info("Image change detected, will add new layers");

                        const addMode = getImageAddMode(this.canvas.node.widgets);
                        await this.addBatchImages(
                            sourceImages,
                            addMode,
                            this.canvas.outputAreaBounds,
                            'to canvas'
                        );

                        this.canvas.inputDataLoaded = true;
                        imageLoaded = true;
                        log.info(`All ${sourceImages.length} connected input images added as separate layers`);
                        this.canvas.render();
                        this.canvas.saveState();
                    }
                }
            }
            
            // Check for mask input separately (from nodeOutputs) ONLY when allowed
            const maskInput = this.getMaskInputSlot();
            if (allowMask && maskInput?.link != null) {
                const maskLinkId = maskInput.link;
                
                // Check if we already loaded this mask link
                if (this.canvas.lastLoadedMaskLinkId === maskLinkId) {
                    log.debug(`Mask link ${maskLinkId} already loaded`);
                    maskLoaded = true;
                } else {
                    // Try to get mask tensor from nodeOutputs using origin_id (not link id)
                    const graph = (this.canvas.node as any).graph;
                    let maskOutput = null;
                    
                    if (graph) {
                        const link = this.getGraphLink(maskLinkId);
                        if (link && link.origin_id) {
                            // Use origin_id to get the actual node output
                            const nodeOutput = (window as any).app?.nodeOutputs?.[link.origin_id];
                            log.debug(`Looking for mask output from origin node ${link.origin_id}, found:`, !!nodeOutput);
                            
                            if (nodeOutput) {
                                log.debug(`Node ${link.origin_id} output structure:`, {
                                    hasData: !!nodeOutput.data,
                                    hasShape: !!nodeOutput.shape,
                                    dataType: typeof nodeOutput.data,
                                    shapeType: typeof nodeOutput.shape,
                                    keys: Object.keys(nodeOutput)
                                });
                                
                                // Only use if it has actual tensor data
                                if (nodeOutput.data && nodeOutput.shape) {
                                    maskOutput = nodeOutput;
                                }
                            }
                        }
                    }
                    
                    if (maskOutput && maskOutput.data && maskOutput.shape) {
                        try {
                            // Derive dimensions from shape or explicit width/height
                            let width = (maskOutput.width as number) || 0;
                            let height = (maskOutput.height as number) || 0;
                            const shape = maskOutput.shape as number[]; // e.g. [1,H,W] or [1,H,W,1]
                            if ((!width || !height) && Array.isArray(shape)) {
                                if (shape.length >= 3) {
                                    height = shape[1];
                                    width = shape[2];
                                } else if (shape.length === 2) {
                                    height = shape[0];
                                    width = shape[1];
                                }
                            }
                            if (!width || !height) {
                                throw new Error("Cannot determine mask dimensions from nodeOutputs");
                            }
                            
                            // Determine channels count
                            let channels = 1;
                            if (Array.isArray(shape) && shape.length >= 4) {
                                channels = shape[3];
                            } else if ((maskOutput as any).channels) {
                                channels = (maskOutput as any).channels;
                            } else {
                                const len = (maskOutput.data as any).length;
                                channels = Math.max(1, Math.floor(len / (width * height)));
                            }
                            
                            // Use unified tensorToImageData for masks
                            const maskImageData = tensorToImageData(maskOutput, 'grayscale');
                            if (!maskImageData) throw new Error("Failed to convert mask tensor to image data");
                            
                            // Create canvas and put image data
                            const { canvas: maskCanvas, ctx } = createCanvas(width, height, '2d', { willReadFrequently: true });
                            if (!ctx) throw new Error("Could not create mask context");
                            ctx.putImageData(maskImageData, 0, 0);
                            
                            // Convert to HTMLImageElement
                            const maskImg = await loadImage(maskCanvas.toDataURL());
                            
                            // Respect fit_on_add (scale to output area)
                            const shouldFit = isFitOnAddEnabled(this.canvas.node.widgets);
                            
                            let finalMaskImg: HTMLImageElement = maskImg;
                            if (shouldFit) {
                                const bounds = this.canvas.outputAreaBounds;
                                finalMaskImg = await scaleImageToFit(maskImg, bounds.width, bounds.height);
                            }
                            
                            // Apply to MaskTool (centers internally)
                            if (this.canvas.maskTool) {
                                this.canvas.maskTool.setMask(finalMaskImg, true);
                                (this.canvas as any).maskAppliedFromInput = true;
                                this.canvas.canvasState.saveMaskState();
                                this.canvas.render();
                                // Mark this mask link as loaded to avoid re-applying
                                this.canvas.lastLoadedMaskLinkId = maskLinkId;
                                maskLoaded = true;
                                log.info("Applied input mask from nodeOutputs immediately on connection" + (shouldFit ? " (fitted to output area)" : ""));
                            }
                        } catch (err) {
                            log.warn("Failed to apply mask from nodeOutputs immediately; will wait for backend input_mask after execution", err);
                        }
                    } else {
                        // nodeOutputs exist but don't have tensor data yet (need workflow execution)
                        log.info(`Mask node ${(this.canvas.node as any).graph?.links[maskLinkId]?.origin_id} found but has no tensor data yet. Mask will be applied automatically after workflow execution.`);
                        // Don't retry - data won't be available until workflow runs
                    }
                }
            }
            
            // Only check backend if we have actual inputs connected
            const hasImageInput = this.hasImageInput();
            const hasMaskInput = this.getMaskInputSlot()?.link != null;

            // If mask input is disconnected, clear any currently applied mask to ensure full separation
            if (!hasMaskInput) {
                (this.canvas as any).maskAppliedFromInput = false;
                this.canvas.lastLoadedMaskLinkId = undefined;
                log.info("Mask input disconnected - cleared mask to enforce separation from input_image");
            }
            
            if (!hasImageInput && !hasMaskInput) {
                log.debug("No inputs connected, skipping backend check");
                this.canvas.inputDataLoaded = true;
                return;
            }
            
            // Skip backend check during mask connection if we didn't get immediate data
            if (reason === "mask_connect" && !maskLoaded) {
                log.info("No immediate mask data available during connection, skipping backend check to avoid stale data. Will check after execution.");
                return;
            }
            
            // Check backend for input data only if we have connected inputs
            const response = await fetch(`/layerforge/get_input_data/${nodeId}`);
            const result = await response.json();

            if (result.success && result.has_input) {
                // Dedupe: skip only if backend payload matches last loaded batch hash
                const backendBatchHash = getBackendImageIdentity(result.data);
                // Check mask separately - don't skip if only images are unchanged AND mask is actually connected AND allowed
                const shouldCheckMask = hasMaskInput && allowMask;
                
                if (backendBatchHash && this.canvas.lastLoadedImageSrc === backendBatchHash && !shouldCheckMask) {
                    log.debug("Backend input data unchanged and no mask to check, skipping reload");
                    this.canvas.inputDataLoaded = true;
                    return;
                } else if (backendBatchHash && this.canvas.lastLoadedImageSrc === backendBatchHash && shouldCheckMask) {
                    log.debug("Images unchanged but need to check mask, continuing...");
                    imageLoaded = true; // Mark images as already loaded to skip reloading them
                }
                
                // Check if we already loaded image data (by checking the current link)
                if (allowImage && !imageLoaded && hasImageInput) {
                    const currentLinkId = this.getImageInputIdentity();
                    if (this.canvas.lastLoadedLinkId !== currentLinkId) {
                        // Mark this link as loaded
                        this.canvas.lastLoadedLinkId = currentLinkId;
                        imageLoaded = false; // Will load from backend
                    }
                }
                
                // Check for mask data from backend ONLY when mask input is actually connected AND allowed
                // Only reset if the mask link actually changed
                if (allowMask && hasMaskInput) {
                    const currentMaskLinkId = this.getMaskInputSlot()?.link;
                    // Only reset if this is a different mask link than what we loaded before
                    if (this.canvas.lastLoadedMaskLinkId !== currentMaskLinkId) {
                        maskLoaded = false;
                        log.debug(`New mask input detected (${currentMaskLinkId}), will check backend for mask data`);
                    } else {
                        log.debug(`Same mask input (${currentMaskLinkId}), mask already loaded`);
                        maskLoaded = true;
                    }
                } else {
                    // No mask input connected, or mask loading not allowed right now
                    maskLoaded = true; // Mark as loaded to skip mask processing
                    if (!allowMask) {
                        log.debug("Mask loading is currently disabled by caller, skipping mask check");
                    } else {
                        log.debug("No mask input connected, skipping mask check");
                    }
                }
                
                log.info("Input data found from backend, adding to canvas");
                const inputData = result.data;
                
                // Compute backend batch hash for dedupe and state
                const backendHashNow = getBackendImageIdentity(inputData);
                
                // Just update the hash without removing any layers
                if (backendHashNow) {
                    log.info("New backend input data detected, adding new layers");
                    this.canvas.lastLoadedImageSrc = backendHashNow;
                }
                
                // Mark that we've loaded input data for this execution
                this.canvas.inputDataLoaded = true;
                
                // Determine add mode based on fit_on_add setting
                const addMode = getImageAddMode(this.canvas.node.widgets);
                
                // Load input image(s) only if image input is actually connected, not already loaded, and allowed
                if (allowImage && !imageLoaded && hasImageInput) {
                    if (inputData.input_images || inputData.input_images_batch) {
                        // Handle ordered images from multiple inputs, while retaining
                        // the legacy tensor-batch payload for older workflows.
                        const batch = getBackendImageSources(inputData);
                        log.info(`Processing ${batch.length} ordered input images from backend`);
                        
                        await this.addBatchImages(
                            batch.map((imgData: { data: string }) => imgData.data),
                            addMode,
                            this.canvas.outputAreaBounds,
                            'from backend'
                        );
                        
                        log.info(`All ${batch.length} input images added from backend`);
                        this.canvas.render();
                        this.canvas.saveState();
                        
                    } else if (inputData.input_image) {
                        // Handle single image (backward compatibility)
                        const img = await loadImage(inputData.input_image);
                        
                        // Add image to canvas at output area position
                        await this.canvas.canvasLayers.addLayerWithImage(
                            img, 
                            {},
                            addMode,
                            this.canvas.outputAreaBounds
                        );
                        
                        log.info("Single input image added as new layer to canvas");
                        this.canvas.render();
                        this.canvas.saveState();
                    } else {
                        log.debug("No input image data from backend");
                    }
                } else if (!hasImageInput && (inputData.input_images || inputData.input_images_batch || inputData.input_image)) {
                    log.debug("Backend has image data but no image input connected, skipping image load");
                }
                
                // Handle mask separately only if mask input is actually connected, allowed, and not already loaded
                if (allowMask && !maskLoaded && hasMaskInput && inputData.input_mask) {
                    log.info("Processing input mask");
                    
                    // Load mask image
                    const maskImg = await loadImage(inputData.input_mask);
                    
                    // Determine if we should fit the mask or use it at original size
                    const shouldFit = isFitOnAddEnabled(this.canvas.node.widgets);
                    
                    let finalMaskImg: HTMLImageElement = maskImg;
                    if (shouldFit && this.canvas.maskTool) {
                        const bounds = this.canvas.outputAreaBounds;
                        finalMaskImg = await scaleImageToFit(maskImg, bounds.width, bounds.height);
                    }
                    
                    // Apply to MaskTool (centers internally)
                    if (this.canvas.maskTool) {
                        this.canvas.maskTool.setMask(finalMaskImg, true);
                    }
                    
                    (this.canvas as any).maskAppliedFromInput = true;
                    // Save the mask state
                    this.canvas.canvasState.saveMaskState()
                    
                    log.info("Applied input mask to mask tool" + (shouldFit ? " (fitted to output area)" : " (original size)"));
                } else if (!hasMaskInput && inputData.input_mask) {
                    log.debug("Backend has mask data but no mask input connected, skipping mask load");
                } else if (!allowMask && inputData.input_mask) {
                    log.debug("Mask input data present in backend but mask loading is disabled by caller; skipping");
                }
            } else {
                log.debug("No input data from backend");
                // Don't schedule another check - we'll only check when explicitly triggered
            }
        } catch (error) {
            log.error("Error checking for input data:", error);
            // Don't schedule another check on error
        }
    }

    scheduleInputDataCheck(): void {
        // Schedule a retry for mask data check when nodeOutputs are not ready yet
        if (this.canvas.pendingInputDataCheck) {
            clearTimeout(this.canvas.pendingInputDataCheck);
        }

        this.canvas.pendingInputDataCheck = window.setTimeout(() => {
            this.canvas.pendingInputDataCheck = null;
            log.debug("Retrying input data check for mask...");
            
        }, 500); // Shorter delay for mask data retry
    }

    scheduleDataCheck(): void {
        if (this.canvas.pendingDataCheck) {
            clearTimeout(this.canvas.pendingDataCheck);
        }

        this.canvas.pendingDataCheck = window.setTimeout(() => {
            this.canvas.pendingDataCheck = null;
            if (!this.canvas.dataInitialized) {
                this.initNodeData();
            }
        }, 1000);
    }

    async processImageData(imageData: any): Promise<void> {
        try {
            if (!imageData) return;

            log.debug("Processing image data:", {
                type: typeof imageData,
                isArray: Array.isArray(imageData),
                shape: imageData.shape,
                hasData: !!imageData.data
            });

            if (Array.isArray(imageData)) {
                imageData = imageData[0];
            }

            if (!imageData.shape || !imageData.data) {
                throw new Error("Invalid image data format");
            }

            const originalWidth = imageData.shape[2];
            const originalHeight = imageData.shape[1];

            const scale = Math.min(
                this.canvas.width / originalWidth * 0.8,
                this.canvas.height / originalHeight * 0.8
            );

            const image = await this.tensorToRgbImage(imageData);
            if (image) {

                this.addScaledLayer(image, scale);
                log.info("Image layer added successfully with scale:", scale);
            }
        } catch (error) {
            log.error("Error processing image data:", error);
            throw error;
        }
    }

    addScaledLayer(image: HTMLImageElement, scale: number): void {
        try {
            const scaledWidth = image.width * scale;
            const scaledHeight = image.height * scale;

            const layer: Layer = {
                id: '', // This will be set in addLayerWithImage
                imageId: '', // This will be set in addLayerWithImage
                name: 'Layer',
                image: image,
                x: (this.canvas.width - scaledWidth) / 2,
                y: (this.canvas.height - scaledHeight) / 2,
                width: scaledWidth,
                height: scaledHeight,
                rotation: 0,
                zIndex: this.canvas.layers.length,
                originalWidth: image.width,
                originalHeight: image.height,
                blendMode: 'normal',
                opacity: 1,
                visible: true
            };

            this.canvas.layers.push(layer);
            this.canvas.updateSelection([layer]);
            this.canvas.render();

            log.debug("Scaled layer added:", {
                originalSize: `${image.width}x${image.height}`,
                scaledSize: `${scaledWidth}x${scaledHeight}`,
                scale: scale
            });
        } catch (error) {
            log.error("Error adding scaled layer:", error);
            throw error;
        }
    }

    async processMaskData(maskData: any): Promise<void> {
        try {
            if (!maskData) return;

            log.debug("Processing mask data:", maskData);

            if (Array.isArray(maskData)) {
                maskData = maskData[0];
            }

            if (!maskData.shape || !maskData.data) {
                throw new Error("Invalid mask data format");
            }

            if (this.canvas.canvasSelection.selectedLayers.length > 0) {
                const maskTensor = await this.convertTensorToMask(maskData);
                (this.canvas.canvasSelection.selectedLayers[0] as any).mask = maskTensor;
                this.canvas.render();
                log.info("Mask applied to selected layer");
            }
        } catch (error) {
            log.error("Error processing mask data:", error);
        }
    }

    async importLatestImage(): Promise<boolean> {
        try {
            log.info("Fetching latest image from server...");
            const response = await fetch('/ycnode/get_latest_image');
            const result = await response.json();

            if (result.success && result.image_data) {
                log.info("Latest image received, adding to canvas.");
                const img = await loadImage(result.image_data);

                await this.canvas.canvasLayers.addLayerWithImage(img, {}, 'fit');
                log.info("Latest image imported and placed on canvas successfully.");
                return true;
            } else {
                throw new Error(result.error || "Failed to fetch the latest image.");
            }
        } catch (error: any) {
            log.error("Error importing latest image:", error);
            showErrorNotification(`Failed to import latest image: ${error.message}`);
            return false;
        }
    }

    async addSelectedInputImage(image: HTMLImageElement): Promise<boolean> {
        try {
            if (!image) return false;

            const addMode = getImageAddMode(this.canvas.node.widgets);
            await this.canvas.canvasLayers.addLayerWithImage(
                image,
                { name: 'Input Image' },
                addMode,
                this.canvas.outputAreaBounds,
            );
            this.canvas.render();
            log.info("Selected connected input image added to the canvas.");
            return true;
        } catch (error) {
            log.error("Error adding selected connected input image:", error);
            showErrorNotification("Failed to add the selected input image to the canvas.");
            return false;
        }
    }

    async importLatestImages(sinceTimestamp: number, targetArea: { x: number, y: number, width: number, height: number } | null = null): Promise<Layer[]> {
        try {
            log.info(`Fetching latest images since ${sinceTimestamp}...`);
            const response = await fetch(`/layerforge/get-latest-images/${sinceTimestamp}`);
            const result = await response.json();

            if (result.success && result.images && result.images.length > 0) {
                log.info(`Received ${result.images.length} new images, adding to canvas.`);
                const newLayers: (Layer | null)[] = [];

                for (const imageData of result.images) {
                    const img = await loadImage(imageData);
                    
                    let processedImage = img;
                    
                    // If there's a custom shape, clip the image to that shape
                    if (this.canvas.outputAreaShape && this.canvas.outputAreaShape.isClosed) {
                        processedImage = await this.clipImageToShape(img, this.canvas.outputAreaShape);
                    }
                    
                    const newLayer = await this.canvas.canvasLayers.addLayerWithImage(processedImage, {}, 'fit', targetArea);
                    newLayers.push(newLayer);
                }
                log.info("All new images imported and placed on canvas successfully.");
                return newLayers.filter(l => l !== null) as Layer[];

            } else if (result.success) {
                log.info("No new images found since last generation.");
                return [];
            } else {
                throw new Error(result.error || "Failed to fetch latest images.");
            }
        } catch (error: any) {
            log.error("Error importing latest images:", error);
            showErrorNotification(`Failed to import latest images: ${error.message}`);
            return [];
        }
    }

    async clipImageToShape(image: HTMLImageElement, shape: Shape): Promise<HTMLImageElement> {
        const { canvas, ctx } = createCanvas(image.width, image.height);
        if (!ctx) {
            throw new Error("Could not create canvas context for clipping");
        }

        // Draw the image first
        ctx.drawImage(image, 0, 0);

        // Calculate custom shape position accounting for extensions
        // Custom shape should maintain its relative position within the original canvas area
        const ext = this.canvas.outputAreaExtensionEnabled ? this.canvas.outputAreaExtensions : { top: 0, bottom: 0, left: 0, right: 0 };
        const shapeOffsetX = ext.left;  // Add left extension to maintain relative position
        const shapeOffsetY = ext.top;   // Add top extension to maintain relative position

        // Create a clipping mask using the shape with extension offset
        ctx.globalCompositeOperation = 'destination-in';
        ctx.beginPath();
        ctx.moveTo(shape.points[0].x + shapeOffsetX, shape.points[0].y + shapeOffsetY);
        for (let i = 1; i < shape.points.length; i++) {
            ctx.lineTo(shape.points[i].x + shapeOffsetX, shape.points[i].y + shapeOffsetY);
        }
        ctx.closePath();
        ctx.fill();

        // Create a new image from the clipped canvas
        return await loadImage(canvas.toDataURL());
    }
}
