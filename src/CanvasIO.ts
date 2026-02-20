import { createCanvas } from "./utils/CommonUtils.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { showErrorNotification } from "./utils/NotificationUtils.js";
import { webSocketManager } from "./utils/WebSocketManager.js";
import { scaleImageToFit, createImageFromSource, tensorToImageData, createImageFromImageData } from "./utils/ImageUtils.js";
import type { Canvas } from './Canvas';
import type { Layer, Shape } from './types';

const log = createModuleLogger('CanvasIO');

export class CanvasIO {
    private _saveInProgress: Promise<any> | null;
    private canvas: Canvas;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this._saveInProgress = null;
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
            const {canvas: tempCanvas, ctx: tempCtx} = createCanvas(this.canvas.width, this.canvas.height);
            const {canvas: maskCanvas, ctx: maskCtx} = createCanvas(this.canvas.width, this.canvas.height);

            const originalShape = this.canvas.outputAreaShape;
            this.canvas.outputAreaShape = null;

            const { canvas: visibilityCanvas, ctx: visibilityCtx } = createCanvas(this.canvas.width, this.canvas.height, '2d', { alpha: true });
            if (!visibilityCtx) throw new Error("Could not create visibility context");
            if (!maskCtx) throw new Error("Could not create mask context");
            if (!tempCtx) throw new Error("Could not create temp context");
            maskCtx.fillStyle = '#ffffff';
            maskCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            log.debug(`Canvas contexts created, starting layer rendering`);
            
            this.canvas.canvasLayers.drawLayersToContext(tempCtx, this.canvas.layers);
            this.canvas.canvasLayers.drawLayersToContext(visibilityCtx, this.canvas.layers);
            log.debug(`Finished rendering layers`);
            const visibilityData = visibilityCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const maskData = maskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            for (let i = 0; i < visibilityData.data.length; i += 4) {
                const alpha = visibilityData.data[i + 3];
                const maskValue = 255 - alpha;
                maskData.data[i] = maskData.data[i + 1] = maskData.data[i + 2] = maskValue;
                maskData.data[i + 3] = 255;
            }

            maskCtx.putImageData(maskData, 0, 0);

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

            tempCanvas.toBlob(async (blobWithoutMask) => {
                if (!blobWithoutMask) return;
                log.debug(`Created blob for image without mask, size: ${blobWithoutMask.size} bytes`);
                const formDataWithoutMask = new FormData();
                formDataWithoutMask.append("image", blobWithoutMask, fileNameWithoutMask);
                formDataWithoutMask.append("overwrite", "true");

                try {
                    const response = await fetch("/upload/image", {
                        method: "POST",
                        body: formDataWithoutMask,
                    });
                    log.debug(`Image without mask upload response: ${response.status}`);
                } catch (error) {
                    log.error(`Error uploading image without mask:`, error);
                }
            }, "image/png");
            log.info(`Saving main image as: ${fileName}`);
            tempCanvas.toBlob(async (blob) => {
                if (!blob) return;
                log.debug(`Created blob for main image, size: ${blob.size} bytes`);
                const formData = new FormData();
                formData.append("image", blob, fileName);
                formData.append("overwrite", "true");

                try {
                    const resp = await fetch("/upload/image", {
                        method: "POST",
                        body: formData,
                    });
                    log.debug(`Main image upload response: ${resp.status}`);

                    if (resp.status === 200) {
                        const maskFileName = fileName.replace('.png', '_mask.png');
                        log.info(`Saving mask as: ${maskFileName}`);

                        maskCanvas.toBlob(async (maskBlob) => {
                            if (!maskBlob) return;
                            log.debug(`Created blob for mask, size: ${maskBlob.size} bytes`);
                            const maskFormData = new FormData();
                            maskFormData.append("image", maskBlob, maskFileName);
                            maskFormData.append("overwrite", "true");

                            try {
                                const maskResp = await fetch("/upload/image", {
                                    method: "POST",
                                    body: maskFormData,
                                });
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
                        }, "image/png");
                    } else {
                        log.error(`Main image upload failed: ${resp.status} - ${resp.statusText}`);
                        resolve(false);
                    }
                } catch (error) {
                    log.error(`Error uploading main image:`, error);
                    resolve(false);
                }
            }, "image/png");
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
        const imageDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(imageBlob);
        });
        
        const maskDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(maskBlob);
        });
        
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

    async addInputToCanvas(inputImage: any, inputMask: any): Promise<boolean> {
        try {
            log.debug("Adding input to canvas:", { inputImage });

            // Use unified tensorToImageData for RGB image
            const imageData = tensorToImageData(inputImage, 'rgb');
            if (!imageData) throw new Error("Failed to convert input image tensor");

            // Create HTMLImageElement from ImageData
            const image = await createImageFromImageData(imageData);

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

            const imageData = tensorToImageData(tensor, 'rgb');
            if (!imageData) throw new Error("Failed to convert tensor to image data");

            return await createImageFromImageData(imageData);
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

            if ((this.canvas.node as any).inputs[0] && (this.canvas.node as any).inputs[0].link) {
                const imageLinkId = (this.canvas.node as any).inputs[0].link;
                
                // Check if we already loaded this link
                if (this.canvas.lastLoadedLinkId === imageLinkId) {
                    log.debug(`Link ${imageLinkId} already loaded via new system, marking as initialized`);
                    this.canvas.dataInitialized = true;
                    return;
                }
                
                const imageData = (window as any).app.nodeOutputs[imageLinkId];

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

            if ((this.canvas.node as any).inputs[1] && (this.canvas.node as any).inputs[1].link) {
                const maskLinkId = (this.canvas.node as any).inputs[1].link;
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
            
            // First, try to get data from connected node's output if available (IMAGES)
            if (allowImage && this.canvas.node.inputs && this.canvas.node.inputs[0] && this.canvas.node.inputs[0].link) {
                const linkId = this.canvas.node.inputs[0].link;
                const graph = (this.canvas.node as any).graph;
                
                // Always check if images have changed first
                if (graph) {
                    const link = graph.links[linkId];
                    if (link) {
                        const sourceNode = graph.getNodeById(link.origin_id);
                        if (sourceNode && sourceNode.imgs && sourceNode.imgs.length > 0) {
                            // Create current batch identifier (all image sources combined)
                            const currentBatchImageSrcs = sourceNode.imgs.map((img: HTMLImageElement) => img.src).join('|');
                            
                            // Check if this is the same link we loaded before
                            if (this.canvas.lastLoadedLinkId === linkId) {
                                // Same link, check if images actually changed
                                if (this.canvas.lastLoadedImageSrc !== currentBatchImageSrcs) {
                                    log.info(`Batch images changed for link ${linkId} (${sourceNode.imgs.length} images), will reload...`);
                                    log.debug(`Previous batch hash: ${this.canvas.lastLoadedImageSrc?.substring(0, 100)}...`);
                                    log.debug(`Current batch hash: ${currentBatchImageSrcs.substring(0, 100)}...`);
                                    imageChanged = true;
                                    // Clear the inputDataLoaded flag to force reload from backend
                                    this.canvas.inputDataLoaded = false;
                                    // Clear the lastLoadedImageSrc to force reload
                                    this.canvas.lastLoadedImageSrc = undefined;
                                    // Clear backend data to force fresh load
                                    fetch(`/layerforge/clear_input_data/${nodeId}`, { method: 'POST' })
                                        .then(() => log.debug("Backend input data cleared due to image change"))
                                        .catch(err => log.error("Failed to clear backend data:", err));
                                } else {
                                    log.debug(`Batch images for link ${linkId} unchanged (${sourceNode.imgs.length} images)`);
                                    imageLoaded = true;
                                }
                            } else {
                                // Different link or first load
                                log.info(`New link ${linkId} detected, will load ${sourceNode.imgs.length} images`);
                                imageChanged = false; // It's not a change, it's a new link
                                imageLoaded = false; // Need to load
                                // Reset the inputDataLoaded flag for new link
                                this.canvas.inputDataLoaded = false;
                            }
                        }
                    }
                }
                
                if (!imageLoaded || imageChanged) {
                    // Reset the inputDataLoaded flag when images change
                    if (imageChanged) {
                        this.canvas.inputDataLoaded = false;
                        log.info("Resetting inputDataLoaded flag due to image change");
                    }
                
                    if ((this.canvas.node as any).graph) {
                        const graph2 = (this.canvas.node as any).graph;
                        const link2 = graph2.links[linkId];
                        if (link2) {
                            const sourceNode = graph2.getNodeById(link2.origin_id);
                            if (sourceNode && sourceNode.imgs && sourceNode.imgs.length > 0) {
                                // The connected node has images in its output - handle multiple images (batch)
                                log.info(`Found ${sourceNode.imgs.length} image(s) in connected node's output, loading all`);
                                
                                // Create a combined source identifier for batch detection
                                const batchImageSrcs = sourceNode.imgs.map((img: HTMLImageElement) => img.src).join('|');
                                
                                // Mark this link and batch sources as loaded
                                this.canvas.lastLoadedLinkId = linkId;
                                this.canvas.lastLoadedImageSrc = batchImageSrcs;
                                    
                                // Don't clear layers - just add new ones
                                if (imageChanged) {
                                    log.info("Image change detected, will add new layers");
                                }
                                
                                // Determine add mode
                                const fitOnAddWidget = this.canvas.node.widgets.find((w) => w.name === "fit_on_add");
                                const addMode = (fitOnAddWidget && fitOnAddWidget.value) ? 'fit' : 'center';
                                
                                // Add all images from the batch as separate layers
                                for (let i = 0; i < sourceNode.imgs.length; i++) {
                                    const img = sourceNode.imgs[i];
                                    await this.canvas.canvasLayers.addLayerWithImage(
                                        img, 
                                        { name: `Batch Image ${i + 1}` }, // Give each layer a unique name
                                        addMode,
                                        this.canvas.outputAreaBounds
                                    );
                                    log.debug(`Added batch image ${i + 1}/${sourceNode.imgs.length} to canvas`);
                                }
                                
                                this.canvas.inputDataLoaded = true;
                                imageLoaded = true;
                                log.info(`All ${sourceNode.imgs.length} input images from batch added as separate layers`);
                                this.canvas.render();
                                this.canvas.saveState();
                            }
                        }
                    }
                }
            }
            
            // Check for mask input separately (from nodeOutputs) ONLY when allowed
            if (allowMask && this.canvas.node.inputs && this.canvas.node.inputs[1] && this.canvas.node.inputs[1].link) {
                const maskLinkId = this.canvas.node.inputs[1].link;
                
                // Check if we already loaded this mask link
                if (this.canvas.lastLoadedMaskLinkId === maskLinkId) {
                    log.debug(`Mask link ${maskLinkId} already loaded`);
                    maskLoaded = true;
                } else {
                    // Try to get mask tensor from nodeOutputs using origin_id (not link id)
                    const graph = (this.canvas.node as any).graph;
                    let maskOutput = null;
                    
                    if (graph) {
                        const link = graph.links[maskLinkId];
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
                            const maskImg = await createImageFromSource(maskCanvas.toDataURL());
                            
                            // Respect fit_on_add (scale to output area)
                            const widgets = this.canvas.node.widgets;
                            const fitOnAddWidget = widgets ? widgets.find((w: any) => w.name === "fit_on_add") : null;
                            const shouldFit = fitOnAddWidget && fitOnAddWidget.value;
                            
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
            const hasImageInput = this.canvas.node.inputs && this.canvas.node.inputs[0] && this.canvas.node.inputs[0].link;
            const hasMaskInput = this.canvas.node.inputs && this.canvas.node.inputs[1] && this.canvas.node.inputs[1].link;

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
                let backendBatchHash: string | undefined;
                if (result.data?.input_images_batch && Array.isArray(result.data.input_images_batch)) {
                    backendBatchHash = result.data.input_images_batch.map((i: any) => i.data).join('|');
                } else if (result.data?.input_image) {
                    backendBatchHash = result.data.input_image;
                }
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
                if (allowImage && !imageLoaded && this.canvas.node.inputs && this.canvas.node.inputs[0] && this.canvas.node.inputs[0].link) {
                    const currentLinkId = this.canvas.node.inputs[0].link;
                    if (this.canvas.lastLoadedLinkId !== currentLinkId) {
                        // Mark this link as loaded
                        this.canvas.lastLoadedLinkId = currentLinkId;
                        imageLoaded = false; // Will load from backend
                    }
                }
                
                // Check for mask data from backend ONLY when mask input is actually connected AND allowed
                // Only reset if the mask link actually changed
                if (allowMask && hasMaskInput && this.canvas.node.inputs && this.canvas.node.inputs[1]) {
                    const currentMaskLinkId = this.canvas.node.inputs[1].link;
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
                let backendHashNow: string | undefined;
                if (inputData?.input_images_batch && Array.isArray(inputData.input_images_batch)) {
                    backendHashNow = inputData.input_images_batch.map((i: any) => i.data).join('|');
                } else if (inputData?.input_image) {
                    backendHashNow = inputData.input_image;
                }
                
                // Just update the hash without removing any layers
                if (backendHashNow) {
                    log.info("New backend input data detected, adding new layers");
                    this.canvas.lastLoadedImageSrc = backendHashNow;
                }
                
                // Mark that we've loaded input data for this execution
                this.canvas.inputDataLoaded = true;
                
                // Determine add mode based on fit_on_add setting
                const widgets = this.canvas.node.widgets;
                const fitOnAddWidget = widgets ? widgets.find((w: any) => w.name === "fit_on_add") : null;
                const addMode = (fitOnAddWidget && fitOnAddWidget.value) ? 'fit' : 'center';
                
                // Load input image(s) only if image input is actually connected, not already loaded, and allowed
                if (allowImage && !imageLoaded && hasImageInput) {
                    if (inputData.input_images_batch) {
                        // Handle batch of images
                        const batch = inputData.input_images_batch;
                        log.info(`Processing batch of ${batch.length} images from backend`);
                        
                                for (let i = 0; i < batch.length; i++) {
                                    const imgData = batch[i];
                                    const img = await createImageFromSource(imgData.data);
                                    
                                    // Add image to canvas with unique name
                                    await this.canvas.canvasLayers.addLayerWithImage(
                                        img, 
                                        { name: `Batch Image ${i + 1}` },
                                        addMode,
                                        this.canvas.outputAreaBounds
                                    );
                                    
                                    log.debug(`Added batch image ${i + 1}/${batch.length} from backend`);
                                }
                        
                        log.info(`All ${batch.length} batch images added from backend`);
                        this.canvas.render();
                        this.canvas.saveState();
                        
                    } else if (inputData.input_image) {
                        // Handle single image (backward compatibility)
                        const img = await createImageFromSource(inputData.input_image);
                        
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
                } else if (!hasImageInput && (inputData.input_images_batch || inputData.input_image)) {
                    log.debug("Backend has image data but no image input connected, skipping image load");
                }
                
                // Handle mask separately only if mask input is actually connected, allowed, and not already loaded
                if (allowMask && !maskLoaded && hasMaskInput && inputData.input_mask) {
                    log.info("Processing input mask");
                    
                    // Load mask image
                    const maskImg = await createImageFromSource(inputData.input_mask);
                    
                    // Determine if we should fit the mask or use it at original size
                    const fitOnAddWidget2 = this.canvas.node.widgets.find((w) => w.name === "fit_on_add");
                    const shouldFit = fitOnAddWidget2 && fitOnAddWidget2.value;
                    
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

            const convertedData = this.convertTensorToImageData(imageData);
            if (convertedData) {
                const image = await this.createImageFromData(convertedData);

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

    convertTensorToImageData(tensor: any): ImageData | null {
        return tensorToImageData(tensor, 'rgb');
    }

    async createImageFromData(imageData: ImageData): Promise<HTMLImageElement> {
        return createImageFromImageData(imageData);
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
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = result.image_data;
                });

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

    async importLatestImages(sinceTimestamp: number, targetArea: { x: number, y: number, width: number, height: number } | null = null): Promise<Layer[]> {
        try {
            log.info(`Fetching latest images since ${sinceTimestamp}...`);
            const response = await fetch(`/layerforge/get-latest-images/${sinceTimestamp}`);
            const result = await response.json();

            if (result.success && result.images && result.images.length > 0) {
                log.info(`Received ${result.images.length} new images, adding to canvas.`);
                const newLayers: (Layer | null)[] = [];

                for (const imageData of result.images) {
                    const img = await createImageFromSource(imageData);
                    
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
        return await createImageFromSource(canvas.toDataURL());
    }
}
