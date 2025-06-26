import {createCanvas} from "./utils/CommonUtils.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('CanvasIO');

export class CanvasIO {
    constructor(canvas) {
        this.canvas = canvas;
        this._saveInProgress = null;
    }

    async saveToServer(fileName) {
        if (!window.canvasSaveStates) {
            window.canvasSaveStates = new Map();
        }
        
        const nodeId = this.canvas.node.id;
        const saveKey = `${nodeId}_${fileName}`;
        if (this._saveInProgress || window.canvasSaveStates.get(saveKey)) {
            log.warn(`Save already in progress for node ${nodeId}, waiting...`);
            return this._saveInProgress || window.canvasSaveStates.get(saveKey);
        }

        log.info(`Starting saveToServer with fileName: ${fileName} for node: ${nodeId}`);
        log.debug(`Canvas dimensions: ${this.canvas.width}x${this.canvas.height}`);
        log.debug(`Number of layers: ${this.canvas.layers.length}`);
        this._saveInProgress = this._performSave(fileName);
        window.canvasSaveStates.set(saveKey, this._saveInProgress);
        
        try {
            const result = await this._saveInProgress;
            return result;
        } finally {
            this._saveInProgress = null;
            window.canvasSaveStates.delete(saveKey);
            log.debug(`Save completed for node ${nodeId}, lock released`);
        }
    }

    async _performSave(fileName) {
        if (this.canvas.layers.length === 0) {
            log.warn(`Node ${this.canvas.node.id} has no layers, creating empty canvas`);
            return Promise.resolve(true);
        }
        await this.canvas.saveStateToDB(true);
        const nodeId = this.canvas.node.id;
        const delay = (nodeId % 10) * 50;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return new Promise((resolve) => {
            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(this.canvas.width, this.canvas.height);
            const { canvas: maskCanvas, ctx: maskCtx } = createCanvas(this.canvas.width, this.canvas.height);

            tempCtx.fillStyle = '#ffffff';
            tempCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            const visibilityCanvas = document.createElement('canvas');
            visibilityCanvas.width = this.canvas.width;
            visibilityCanvas.height = this.canvas.height;
            const visibilityCtx = visibilityCanvas.getContext('2d', { alpha: true });
            maskCtx.fillStyle = '#ffffff';
            maskCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            
            log.debug(`Canvas contexts created, starting layer rendering`);
            const sortedLayers = this.canvas.layers.sort((a, b) => a.zIndex - b.zIndex);
            log.debug(`Processing ${sortedLayers.length} layers in order`);
            sortedLayers.forEach((layer, index) => {
                log.debug(`Processing layer ${index}: zIndex=${layer.zIndex}, size=${layer.width}x${layer.height}, pos=(${layer.x},${layer.y})`);
                log.debug(`Layer ${index}: blendMode=${layer.blendMode || 'normal'}, opacity=${layer.opacity !== undefined ? layer.opacity : 1}`);
                
                tempCtx.save();
                tempCtx.globalCompositeOperation = layer.blendMode || 'normal';
                tempCtx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
                tempCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                tempCtx.rotate(layer.rotation * Math.PI / 180);
                tempCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                tempCtx.restore();
                
                log.debug(`Layer ${index} rendered successfully`);
                visibilityCtx.save();
                visibilityCtx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
                visibilityCtx.rotate(layer.rotation * Math.PI / 180);
                visibilityCtx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
                visibilityCtx.restore();
            });
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
                const tempMaskCtx = tempMaskCanvas.getContext('2d');
                tempMaskCtx.drawImage(toolMaskCanvas, 0, 0);
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
            const fileNameWithoutMask = fileName.replace('.png', '_without_mask.png');
            log.info(`Saving image without mask as: ${fileNameWithoutMask}`);
            
            tempCanvas.toBlob(async (blobWithoutMask) => {
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
                                    this.canvas.widget.value = fileName;
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

    async addInputToCanvas(inputImage, inputMask) {
        try {
            log.debug("Adding input to canvas:", {inputImage});

            const { canvas: tempCanvas, ctx: tempCtx } = createCanvas(inputImage.width, inputImage.height);

            const imgData = new ImageData(
                inputImage.data,
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

            const layer = await this.canvas.addLayerWithImage(image, {
                x: (this.canvas.width - inputImage.width * scale) / 2,
                y: (this.canvas.height - inputImage.height * scale) / 2,
                width: inputImage.width * scale,
                height: inputImage.height * scale,
            });

            if (inputMask) {
                layer.mask = inputMask.data;
            }

            log.info("Layer added successfully");
            return true;

        } catch (error) {
            log.error("Error in addInputToCanvas:", error);
            throw error;
        }
    }

    async convertTensorToImage(tensor) {
        try {
            log.debug("Converting tensor to image:", tensor);

            if (!tensor || !tensor.data || !tensor.width || !tensor.height) {
                throw new Error("Invalid tensor data");
            }

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
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

    async convertTensorToMask(tensor) {
        if (!tensor || !tensor.data) {
            throw new Error("Invalid mask tensor");
        }

        try {
            return new Float32Array(tensor.data);
        } catch (error) {
            throw new Error(`Mask conversion failed: ${error.message}`);
        }
    }

    async initNodeData() {
        try {
            log.info("Starting node data initialization...");

            if (!this.canvas.node || !this.canvas.node.inputs) {
                log.debug("Node or inputs not ready");
                return this.scheduleDataCheck();
            }

            if (this.canvas.node.inputs[0] && this.canvas.node.inputs[0].link) {
                const imageLinkId = this.canvas.node.inputs[0].link;
                const imageData = app.nodeOutputs[imageLinkId];

                if (imageData) {
                    log.debug("Found image data:", imageData);
                    await this.processImageData(imageData);
                    this.canvas.dataInitialized = true;
                } else {
                    log.debug("Image data not available yet");
                    return this.scheduleDataCheck();
                }
            }

            if (this.canvas.node.inputs[1] && this.canvas.node.inputs[1].link) {
                const maskLinkId = this.canvas.node.inputs[1].link;
                const maskData = app.nodeOutputs[maskLinkId];

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

    scheduleDataCheck() {
        if (this.canvas.pendingDataCheck) {
            clearTimeout(this.canvas.pendingDataCheck);
        }

        this.canvas.pendingDataCheck = setTimeout(() => {
            this.canvas.pendingDataCheck = null;
            if (!this.canvas.dataInitialized) {
                this.initNodeData();
            }
        }, 1000);
    }

    async processImageData(imageData) {
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

    addScaledLayer(image, scale) {
        try {
            const scaledWidth = image.width * scale;
            const scaledHeight = image.height * scale;

            const layer = {
                image: image,
                x: (this.canvas.width - scaledWidth) / 2,
                y: (this.canvas.height - scaledHeight) / 2,
                width: scaledWidth,
                height: scaledHeight,
                rotation: 0,
                zIndex: this.canvas.layers.length,
                originalWidth: image.width,
                originalHeight: image.height
            };

            this.canvas.layers.push(layer);
            this.canvas.selectedLayer = layer;
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

    convertTensorToImageData(tensor) {
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

    async createImageFromData(imageData) {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = imageData.width;
            canvas.height = imageData.height;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imageData, 0, 0);

            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = canvas.toDataURL();
        });
    }

    async retryDataLoad(maxRetries = 3, delay = 1000) {
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

    async processMaskData(maskData) {
        try {
            if (!maskData) return;

            log.debug("Processing mask data:", maskData);

            if (Array.isArray(maskData)) {
                maskData = maskData[0];
            }

            if (!maskData.shape || !maskData.data) {
                throw new Error("Invalid mask data format");
            }

            if (this.canvas.selectedLayer) {
                const maskTensor = await this.convertTensorToMask(maskData);
                this.canvas.selectedLayer.mask = maskTensor;
                this.canvas.render();
                log.info("Mask applied to selected layer");
            }
        } catch (error) {
            log.error("Error processing mask data:", error);
        }
    }

    async loadImageFromCache(base64Data) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = base64Data;
        });
    }

    async importImage(cacheData) {
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
            const tempCtx = tempCanvas.getContext('2d');

            tempCtx.drawImage(img, 0, 0);

            if (mask) {
                const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = img.width;
                maskCanvas.height = img.height;
                const maskCtx = maskCanvas.getContext('2d');
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

            const layer = {
                image: finalImage,
                x: (this.canvas.width - img.width * scale) / 2,
                y: (this.canvas.height - img.height * scale) / 2,
                width: img.width * scale,
                height: img.height * scale,
                rotation: 0,
                zIndex: this.canvas.layers.length
            };

            this.canvas.layers.push(layer);
            this.canvas.selectedLayer = layer;
            this.canvas.render();

        } catch (error) {
            log.error('Error importing image:', error);
        }
    }

    async importLatestImage() {
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

                await this.canvas.addLayerWithImage(img, {
                    x: 0,
                    y: 0,
                    width: this.canvas.width,
                    height: this.canvas.height,
                });
                log.info("Latest image imported and placed on canvas successfully.");
                return true;
            } else {
                throw new Error(result.error || "Failed to fetch the latest image.");
            }
        } catch (error) {
            log.error("Error importing latest image:", error);
            alert(`Failed to import latest image: ${error.message}`);
            return false;
        }
    }
}
