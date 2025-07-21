import { createCanvas } from "./utils/CommonUtils.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { webSocketManager } from "./utils/WebSocketManager.js";
import type { Canvas } from './Canvas';
import type { Layer } from './types';

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

            const visibilityCanvas = document.createElement('canvas');
            visibilityCanvas.width = this.canvas.width;
            visibilityCanvas.height = this.canvas.height;
            const visibilityCtx = visibilityCanvas.getContext('2d', { alpha: true });
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
            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {

                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.canvas.width;
                tempMaskCanvas.height = this.canvas.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });
                if (!tempMaskCtx) throw new Error("Could not create temp mask context");

                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);


                const maskX = this.canvas.maskTool.x;
                const maskY = this.canvas.maskTool.y;

                log.debug(`Extracting mask from world position (${maskX}, ${maskY}) for output area (0,0) to (${this.canvas.width}, ${this.canvas.height})`);

                const sourceX = Math.max(0, -maskX);  // Where in the mask canvas to start reading
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);     // Where in the output canvas to start writing
                const destY = Math.max(0, maskY);

                const copyWidth = Math.min(
                    toolMaskCanvas.width - sourceX,   // Available width in source
                    this.canvas.width - destX         // Available width in destination
                );
                const copyHeight = Math.min(
                    toolMaskCanvas.height - sourceY,  // Available height in source
                    this.canvas.height - destY        // Available height in destination
                );

                if (copyWidth > 0 && copyHeight > 0) {
                    log.debug(`Copying mask region: source(${sourceX}, ${sourceY}) to dest(${destX}, ${destY}) size(${copyWidth}, ${copyHeight})`);

                    tempMaskCtx.drawImage(
                        toolMaskCanvas,
                        sourceX, sourceY, copyWidth, copyHeight,  // Source rectangle
                        destX, destY, copyWidth, copyHeight       // Destination rectangle
                    );
                }

                const tempMaskData = tempMaskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                for (let i = 0; i < tempMaskData.data.length; i += 4) {
                    const alpha = tempMaskData.data[i + 3];
                    tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = 255;
                    tempMaskData.data[i + 3] = alpha;
                }
                tempMaskCtx.putImageData(tempMaskData, 0, 0);

                maskCtx.globalCompositeOperation = 'source-over';
                maskCtx.drawImage(tempMaskCanvas, 0, 0);
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
        return new Promise((resolve) => {
            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(this.canvas.width, this.canvas.height);
            const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(this.canvas.width, this.canvas.height);

            const visibilityCanvas = document.createElement('canvas');
            visibilityCanvas.width = this.canvas.width;
            visibilityCanvas.height = this.canvas.height;
            const visibilityCtx = visibilityCanvas.getContext('2d', { alpha: true });
            if (!visibilityCtx) throw new Error("Could not create visibility context");
            if (!maskCtx) throw new Error("Could not create mask context");
            if (!tempCtx) throw new Error("Could not create temp context");
            maskCtx.fillStyle = '#ffffff'; // Start with a white mask (nothing masked)
            maskCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            this.canvas.canvasLayers.drawLayersToContext(tempCtx, this.canvas.layers);
            this.canvas.canvasLayers.drawLayersToContext(visibilityCtx, this.canvas.layers);

            const visibilityData = visibilityCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const maskData = maskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            for (let i = 0; i < visibilityData.data.length; i += 4) {
                const alpha = visibilityData.data[i + 3];
                const maskValue = 255 - alpha; // Invert alpha to create the mask
                maskData.data[i] = maskData.data[i + 1] = maskData.data[i + 2] = maskValue;
                maskData.data[i + 3] = 255; // Solid mask
            }
            maskCtx.putImageData(maskData, 0, 0);

            const toolMaskCanvas = this.canvas.maskTool.getMask();
            if (toolMaskCanvas) {

                const tempMaskCanvas = document.createElement('canvas');
                tempMaskCanvas.width = this.canvas.width;
                tempMaskCanvas.height = this.canvas.height;
                const tempMaskCtx = tempMaskCanvas.getContext('2d', { willReadFrequently: true });
                if (!tempMaskCtx) throw new Error("Could not create temp mask context");

                tempMaskCtx.clearRect(0, 0, tempMaskCanvas.width, tempMaskCanvas.height);

                const maskX = this.canvas.maskTool.x;
                const maskY = this.canvas.maskTool.y;

                log.debug(`[renderOutputData] Extracting mask from world position (${maskX}, ${maskY})`);

                const sourceX = Math.max(0, -maskX);
                const sourceY = Math.max(0, -maskY);
                const destX = Math.max(0, maskX);
                const destY = Math.max(0, maskY);

                const copyWidth = Math.min(toolMaskCanvas.width - sourceX, this.canvas.width - destX);
                const copyHeight = Math.min(toolMaskCanvas.height - sourceY, this.canvas.height - destY);

                if (copyWidth > 0 && copyHeight > 0) {
                    tempMaskCtx.drawImage(
                        toolMaskCanvas,
                        sourceX, sourceY, copyWidth, copyHeight,
                        destX, destY, copyWidth, copyHeight
                    );
                }

                const tempMaskData = tempMaskCtx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                for (let i = 0; i < tempMaskData.data.length; i += 4) {
                    const alpha = tempMaskData.data[i + 3];

                    tempMaskData.data[i] = tempMaskData.data[i + 1] = tempMaskData.data[i + 2] = alpha;
                    tempMaskData.data[i + 3] = 255; // Solid alpha
                }
                tempMaskCtx.putImageData(tempMaskData, 0, 0);


                maskCtx.globalCompositeOperation = 'screen';
                maskCtx.drawImage(tempMaskCanvas, 0, 0);
            }

            const imageDataUrl = tempCanvas.toDataURL('image/png');
            const maskDataUrl = maskCanvas.toDataURL('image/png');

            resolve({image: imageDataUrl, mask: maskDataUrl});
        });
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


            throw new Error(`Failed to get confirmation from server for node ${nodeId}. The workflow might not have the latest canvas data.`);
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

            const scale = Math.min(
                this.canvas.width / inputImage.width * 0.8,
                this.canvas.height / inputImage.height * 0.8
            );

            const layer = await this.canvas.canvasLayers.addLayerWithImage(image, {
                x: (this.canvas.width - inputImage.width * scale) / 2,
                y: (this.canvas.height - inputImage.height * scale) / 2,
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

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error("Could not create canvas context");
            canvas.width = tensor.width;
            canvas.height = tensor.height;

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
                opacity: 1
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
            const canvas = document.createElement('canvas');
            canvas.width = imageData.width;
            canvas.height = imageData.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error("Could not create canvas context");
            ctx.putImageData(imageData, 0, 0);

            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = canvas.toDataURL();
        });
    }

    async retryDataLoad(maxRetries = 3, delay = 1000): Promise<void> {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.initNodeData();
                return;
            } catch (error) {
                log.warn(`Retry ${i + 1}/${maxRetries} failed:`, error);
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        log.error("Failed to load data after", maxRetries, "retries");
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

    async loadImageFromCache(base64Data: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = base64Data;
        });
    }

    async importImage(cacheData: { image: string, mask?: string }): Promise<void> {
        try {
            log.info("Starting image import with cache data");
            const img = await this.loadImageFromCache(cacheData.image);
            const mask = cacheData.mask ? await this.loadImageFromCache(cacheData.mask) : null;

            const scale = Math.min(
                this.canvas.width / img.width * 0.8,
                this.canvas.height / img.height * 0.8
            );

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            if (!tempCtx) throw new Error("Could not create temp context");

            tempCtx.drawImage(img, 0, 0);

            if (mask) {
                const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = img.width;
                maskCanvas.height = img.height;
                const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
                if (!maskCtx) throw new Error("Could not create mask context");
                maskCtx.drawImage(mask, 0, 0);
                const maskData = maskCtx.getImageData(0, 0, img.width, img.height);

                for (let i = 0; i < imageData.data.length; i += 4) {
                    imageData.data[i + 3] = maskData.data[i];
                }

                tempCtx.putImageData(imageData, 0, 0);
            }

            const finalImage = new Image();
            await new Promise((resolve) => {
                finalImage.onload = resolve;
                finalImage.src = tempCanvas.toDataURL();
            });

            const layer: Layer = {
                id: '', // This will be set in addLayerWithImage
                imageId: '', // This will be set in addLayerWithImage
                name: 'Layer',
                image: finalImage,
                x: (this.canvas.width - img.width * scale) / 2,
                y: (this.canvas.height - img.height * scale) / 2,
                width: img.width * scale,
                height: img.height * scale,
                originalWidth: img.width,
                originalHeight: img.height,
                rotation: 0,
                zIndex: this.canvas.layers.length,
                blendMode: 'normal',
                opacity: 1,
            };

            this.canvas.layers.push(layer);
            this.canvas.updateSelection([layer]);
            this.canvas.render();
            this.canvas.saveState();
        } catch (error) {
            log.error('Error importing image:', error);
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
            alert(`Failed to import latest image: ${error.message}`);
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
                    const newLayer = await this.canvas.canvasLayers.addLayerWithImage(img, {}, 'fit', targetArea);
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
            alert(`Failed to import latest images: ${error.message}`);
            return [];
        }
    }
}
