import { createCanvas } from "./utils/CommonUtils.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { showErrorNotification } from "./utils/NotificationUtils.js";
import { webSocketManager } from "./utils/WebSocketManager.js";
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
        `Make sure that the nodeId: (${nodeId}) matches the "node_id" value in the node options. If they don't match, you may need to manually set the node_id to ${nodeId}.`
        );
        }
    }

    async addInputToCanvas(inputImage: any, inputMask: any): Promise<boolean> {
        try {
            log.debug("Adding input to canvas:", { inputImage });

            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(inputImage.width, inputImage.height);
            if (!tempCtx) throw new Error("Could not create temp context");

            const imgData = new ImageData(
                new Uint8ClampedArray(inputImage.data),
                inputImage.width,
                inputImage.height
            );
            tempCtx.putImageData(imgData, 0, 0);

            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
                image.src = tempCanvas.toDataURL();
            });

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

            const { canvas, ctx } = createCanvas(tensor.width, tensor.height, '2d', { willReadFrequently: true });
            if (!ctx) throw new Error("Could not create canvas context");

            const imageData = new ImageData(
                new Uint8ClampedArray(tensor.data),
                tensor.width,
                tensor.height
            );

            ctx.putImageData(imageData, 0, 0);

            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = (e) => reject(new Error("Failed to load image: " + e));
                img.src = canvas.toDataURL();
            });
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

            if (!this.canvas.node || !(this.canvas.node as any).inputs) {
                log.debug("Node or inputs not ready");
                return this.scheduleDataCheck();
            }

            if ((this.canvas.node as any).inputs[0] && (this.canvas.node as any).inputs[0].link) {
                const imageLinkId = (this.canvas.node as any).inputs[0].link;
                const imageData = (window as any).app.nodeOutputs[imageLinkId];

                if (imageData) {
                    log.debug("Found image data:", imageData);
                    await this.processImageData(imageData);
                    this.canvas.dataInitialized = true;
                } else {
                    log.debug("Image data not available yet");
                    return this.scheduleDataCheck();
                }
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
        try {
            const shape = tensor.shape;
            const height = shape[1];
            const width = shape[2];
            const channels = shape[3];

            log.debug("Converting tensor:", {
                shape: shape,
                dataRange: {
                    min: tensor.min_val,
                    max: tensor.max_val
                }
            });

            const imageData = new ImageData(width, height);
            const data = new Uint8ClampedArray(width * height * 4);

            const flatData = tensor.data;
            const pixelCount = width * height;

            for (let i = 0; i < pixelCount; i++) {
                const pixelIndex = i * 4;
                const tensorIndex = i * channels;

                for (let c = 0; c < channels; c++) {
                    const value = flatData[tensorIndex + c];

                    const normalizedValue = (value - tensor.min_val) / (tensor.max_val - tensor.min_val);
                    data[pixelIndex + c] = Math.round(normalizedValue * 255);
                }

                data[pixelIndex + 3] = 255;
            }

            imageData.data.set(data);
            return imageData;
        } catch (error) {
            log.error("Error converting tensor:", error);
            return null;
        }
    }

    async createImageFromData(imageData: ImageData): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const { canvas, ctx } = createCanvas(imageData.width, imageData.height, '2d', { willReadFrequently: true });
            if (!ctx) throw new Error("Could not create canvas context");
            ctx.putImageData(imageData, 0, 0);

            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = canvas.toDataURL();
        });
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
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = imageData;
                    });
                    
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
        return new Promise((resolve, reject) => {
            const { canvas, ctx } = createCanvas(image.width, image.height);
            if (!ctx) {
                reject(new Error("Could not create canvas context for clipping"));
                return;
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
            const clippedImage = new Image();
            clippedImage.onload = () => resolve(clippedImage);
            clippedImage.onerror = () => reject(new Error("Failed to create clipped image"));
            clippedImage.src = canvas.toDataURL();
        });
    }
}
