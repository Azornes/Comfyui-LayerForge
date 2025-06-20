import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {$el} from "../../scripts/ui.js";
import {Canvas} from "./Canvas.js";

async function createCanvasWidget(node, widget, app) {
    const canvas = new Canvas(node, widget);

    const style = document.createElement('style');
    style.textContent = `
        .painter-button {
            background: linear-gradient(to bottom, #4a4a4a, #3a3a3a);
            border: 1px solid #2a2a2a;
            border-radius: 4px;
            color: #ffffff;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 80px;
            text-align: center;
            margin: 2px;
            text-shadow: 0 1px 1px rgba(0,0,0,0.2);
        }

        .painter-button:hover {
            background: linear-gradient(to bottom, #5a5a5a, #4a4a4a);
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .painter-button:active {
            background: linear-gradient(to bottom, #3a3a3a, #4a4a4a);
            transform: translateY(1px);
        }

        .painter-button.primary {
            background: linear-gradient(to bottom, #4a6cd4, #3a5cc4);
            border-color: #2a4cb4;
        }

        .painter-button.primary:hover {
            background: linear-gradient(to bottom, #5a7ce4, #4a6cd4);
        }

        .painter-controls {
            background: linear-gradient(to bottom, #404040, #383838);
            border-bottom: 1px solid #2a2a2a;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 8px;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            align-items: center;
        }

        .painter-container {
            background: #607080;  /* 带蓝色的灰色背景 */
            border: 1px solid #4a5a6a;
            border-radius: 6px;
            box-shadow: inset 0 0 10px rgba(0,0,0,0.1);
            transition: border-color 0.3s ease; /* Dodano dla płynnej zmiany ramki */
        }
        
        .painter-container.drag-over {
            border-color: #00ff00; /* Zielona ramka podczas przeciągania */
            border-style: dashed;
        }

        .painter-dialog {
            background: #404040;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            padding: 20px;
            color: #ffffff;
        }

        .painter-dialog input {
            background: #303030;
            border: 1px solid #505050;
            border-radius: 4px;
            color: #ffffff;
            padding: 4px 8px;
            margin: 4px;
            width: 80px;
        }

        .painter-dialog button {
            background: #505050;
            border: 1px solid #606060;
            border-radius: 4px;
            color: #ffffff;
            padding: 4px 12px;
            margin: 4px;
            cursor: pointer;
        }

        .painter-dialog button:hover {
            background: #606060;
        }

        .blend-opacity-slider {
            width: 100%;
            margin: 5px 0;
            display: none;
        }

        .blend-mode-active .blend-opacity-slider {
            display: block;
        }

        .blend-mode-item {
            padding: 5px;
            cursor: pointer;
            position: relative;
        }

        .blend-mode-item.active {
            background-color: rgba(0,0,0,0.1);
        }
    `;
    document.head.appendChild(style);

    const controlPanel = $el("div.painterControlPanel", {}, [
        $el("div.controls.painter-controls", {
            style: {
                position: "absolute",
                top: "0",
                left: "0",
                right: "0",
                minHeight: "50px",
                zIndex: "10",
                background: "linear-gradient(to bottom, #404040, #383838)",
                borderBottom: "1px solid #2a2a2a",
                boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                padding: "8px",
                display: "flex",
                gap: "6px",
                flexWrap: "wrap",
                alignItems: "center"
            },

            onresize: (entries) => {
                const controlsHeight = entries[0].target.offsetHeight;
                canvasContainer.style.top = (controlsHeight + 10) + "px";
            }
        }, [
            $el("button.painter-button.primary", {
                textContent: "Add Image",
                onclick: () => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.multiple = true;
                    input.onchange = async (e) => {
                        for (const file of e.target.files) {

                            const img = new Image();
                            img.onload = async () => {

                                const scale = Math.min(
                                    canvas.width / img.width * 0.8,
                                    canvas.height / img.height * 0.8
                                );

                                const layer = {
                                    image: img,
                                    x: (canvas.width - img.width * scale) / 2,
                                    y: (canvas.height - img.height * scale) / 2,
                                    width: img.width * scale,
                                    height: img.height * scale,
                                    rotation: 0,
                                    zIndex: canvas.layers.length
                                };

                                canvas.layers.push(layer);
                                canvas.selectedLayer = layer;

                                canvas.render();

                                await canvas.saveToServer(widget.value);

                                app.graph.runStep();
                            };
                            img.src = URL.createObjectURL(file);
                        }
                    };
                    input.click();
                }
            }),
            $el("button.painter-button.primary", {
                textContent: "Import Input",
                onclick: async () => {
                    try {
                        console.log("Import Input clicked");
                        const success = await canvas.importLatestImage();
                        if (success) {
                            await canvas.saveToServer(widget.value);
                            app.graph.runStep();
                        }
                    } catch (error) {
                        console.error("Error during import input process:", error);
                        alert(`Failed to import input: ${error.message}`);
                    }
                }
            }),
            $el("button.painter-button", {
                textContent: "Canvas Size",
                onclick: () => {
                    const dialog = $el("div.painter-dialog", {
                        style: {
                            position: 'fixed',
                            left: '50%',
                            top: '50%',
                            transform: 'translate(-50%, -50%)',
                            zIndex: '1000'
                        }
                    }, [
                        $el("div", {
                            style: {
                                color: "white",
                                marginBottom: "10px"
                            }
                        }, [
                            $el("label", {
                                style: {
                                    marginRight: "5px"
                                }
                            }, [
                                $el("span", {}, ["Width: "])
                            ]),
                            $el("input", {
                                type: "number",
                                id: "canvas-width",
                                value: canvas.width,
                                min: "1",
                                max: "4096"
                            })
                        ]),
                        $el("div", {
                            style: {
                                color: "white",
                                marginBottom: "10px"
                            }
                        }, [
                            $el("label", {
                                style: {
                                    marginRight: "5px"
                                }
                            }, [
                                $el("span", {}, ["Height: "])
                            ]),
                            $el("input", {
                                type: "number",
                                id: "canvas-height",
                                value: canvas.height,
                                min: "1",
                                max: "4096"
                            })
                        ]),
                        $el("div", {
                            style: {
                                textAlign: "right"
                            }
                        }, [
                            $el("button", {
                                id: "cancel-size",
                                textContent: "Cancel"
                            }),
                            $el("button", {
                                id: "confirm-size",
                                textContent: "OK"
                            })
                        ])
                    ]);
                    document.body.appendChild(dialog);

                    document.getElementById('confirm-size').onclick = () => {
                        const width = parseInt(document.getElementById('canvas-width').value) || canvas.width;
                        const height = parseInt(document.getElementById('canvas-height').value) || canvas.height;
                        canvas.updateCanvasSize(width, height);
                        document.body.removeChild(dialog);
                    };

                    document.getElementById('cancel-size').onclick = () => {
                        document.body.removeChild(dialog);
                    };
                }
            }),
            $el("button.painter-button", {
                textContent: "Remove Layer",
                onclick: () => {
                    const index = canvas.layers.indexOf(canvas.selectedLayer);
                    canvas.removeLayer(index);
                }
            }),
            $el("button.painter-button", {
                textContent: "Rotate +90°",
                onclick: () => canvas.rotateLayer(90)
            }),
            $el("button.painter-button", {
                textContent: "Scale +5%",
                onclick: () => canvas.resizeLayer(1.05)
            }),
            $el("button.painter-button", {
                textContent: "Scale -5%",
                onclick: () => canvas.resizeLayer(0.95)
            }),
            $el("button.painter-button", {
                textContent: "Layer Up",
                onclick: async () => {
                    canvas.moveLayerUp();
                    await canvas.saveToServer(widget.value);
                    app.graph.runStep();
                }
            }),
            $el("button.painter-button", {
                textContent: "Layer Down",
                onclick: async () => {
                    canvas.moveLayerDown();
                    await canvas.saveToServer(widget.value);
                    app.graph.runStep();
                }
            }),

            $el("button.painter-button", {
                textContent: "Mirror H",
                onclick: () => {
                    canvas.mirrorHorizontal();
                }
            }),

            $el("button.painter-button", {
                textContent: "Mirror V",
                onclick: () => {
                    canvas.mirrorVertical();
                }
            }),

            $el("button.painter-button", {
                textContent: "Matting",
                onclick: async () => {
                    try {
                        if (!canvas.selectedLayer) {
                            throw new Error("Please select an image first");
                        }

                        const statusIndicator = MattingStatusIndicator.getInstance(controlPanel.querySelector('.controls'));

                        const updateStatus = (event) => {
                            const {status} = event.detail;
                            statusIndicator.setStatus(status);
                        };

                        api.addEventListener("matting_status", updateStatus);

                        try {

                            const imageData = await canvas.getLayerImageData(canvas.selectedLayer);
                            console.log("Sending image to server...");

                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                    image: imageData,
                                    threshold: 0.5,
                                    refinement: 1
                                })
                            });

                            if (!response.ok) {
                                throw new Error(`Server error: ${response.status}`);
                            }

                            const result = await response.json();
                            console.log("Creating new layer with matting result...");

                            const mattedImage = new Image();
                            mattedImage.onload = async () => {

                                const tempCanvas = document.createElement('canvas');
                                const tempCtx = tempCanvas.getContext('2d');
                                tempCanvas.width = canvas.selectedLayer.width;
                                tempCanvas.height = canvas.selectedLayer.height;

                                tempCtx.drawImage(
                                    mattedImage,
                                    0, 0,
                                    tempCanvas.width, tempCanvas.height
                                );

                                const newImage = new Image();
                                newImage.onload = async () => {
                                    const newLayer = {
                                        image: newImage,
                                        x: canvas.selectedLayer.x,
                                        y: canvas.selectedLayer.y,
                                        width: canvas.selectedLayer.width,
                                        height: canvas.selectedLayer.height,
                                        rotation: canvas.selectedLayer.rotation,
                                        zIndex: canvas.layers.length + 1
                                    };

                                    canvas.layers.push(newLayer);
                                    canvas.selectedLayer = newLayer;
                                    canvas.render();

                                    await canvas.saveToServer(widget.value);
                                    app.graph.runStep();
                                };

                                newImage.src = tempCanvas.toDataURL('image/png');
                            };

                            mattedImage.src = result.matted_image;
                            console.log("Matting result applied successfully");

                        } finally {
                            api.removeEventListener("matting_status", updateStatus);
                        }

                    } catch (error) {
                        console.error("Matting error:", error);
                        alert(`Error during matting process: ${error.message}`);
                    }
                }
            })
        ])
    ]);

    const resizeObserver = new ResizeObserver((entries) => {
        const controlsHeight = entries[0].target.offsetHeight;
        canvasContainer.style.top = (controlsHeight + 10) + "px";
    });

    resizeObserver.observe(controlPanel.querySelector('.controls'));

    const triggerWidget = node.widgets.find(w => w.name === "trigger");

    const updateOutput = async () => {

        await canvas.saveToServer(widget.value);

        triggerWidget.value = (triggerWidget.value + 1) % 99999999;

        app.graph.runStep();
    };

    const addUpdateToButton = (button) => {
        const origClick = button.onclick;
        button.onclick = async (...args) => {
            await origClick?.(...args);
            await updateOutput();
        };
    };

    controlPanel.querySelectorAll('button').forEach(addUpdateToButton);

    const canvasContainer = $el("div.painterCanvasContainer.painter-container", {
        style: {
            position: "absolute",
            top: "60px",
            left: "10px",
            right: "10px",
            bottom: "10px",

            overflow: "hidden"
        }
    }, [canvas.canvas]);

    node.onResize = function () {
        canvas.render();
    };

    canvas.canvas.addEventListener('mouseup', updateOutput);
    canvas.canvas.addEventListener('mouseleave', updateOutput);

    const mainContainer = $el("div.painterMainContainer", {
        style: {
            position: "relative",
            width: "100%",
            height: "100%"
        }
    }, [controlPanel, canvasContainer]);
    const handleFileLoad = async (file) => {
        // Sprawdzamy, czy plik jest obrazem
        if (!file.type.startsWith('image/')) {
            return;
        }

        const img = new Image();
        img.onload = async () => {
            // Logika dodawania obrazu jest taka sama jak w przycisku "Add Image"
            const scale = Math.min(
                canvas.width / img.width * 0.8,
                canvas.height / img.height * 0.8
            );

            const layer = {
                image: img,
                x: (canvas.width - img.width * scale) / 2,
                y: (canvas.height - img.height * scale) / 2,
                width: img.width * scale,
                height: img.height * scale,
                rotation: 0,
                zIndex: canvas.layers.length,
                blendMode: 'normal',
                opacity: 1
            };

            canvas.layers.push(layer);
            canvas.selectedLayer = layer;
            canvas.render();

            // Używamy funkcji updateOutput, aby zapisać stan i uruchomić graf
            await updateOutput();

            // Zwolnienie zasobu URL
            URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(file);
    };

    mainContainer.addEventListener('dragover', (e) => {
        e.preventDefault(); // Niezbędne, aby zdarzenie 'drop' zadziałało
        e.stopPropagation();
        // Dodajemy klasę, aby pokazać wizualną informację zwrotną
        canvasContainer.classList.add('drag-over');
    });

    mainContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Usuwamy klasę po opuszczeniu obszaru
        canvasContainer.classList.remove('drag-over');
    });

    mainContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Usuwamy klasę po upuszczeniu pliku
        canvasContainer.classList.remove('drag-over');

        if (e.dataTransfer.files) {
            // Przetwarzamy wszystkie upuszczone pliki
            for (const file of e.dataTransfer.files) {
                await handleFileLoad(file);
            }
        }
    });

    const mainWidget = node.addDOMWidget("mainContainer", "widget", mainContainer);

    node.size = [500, 500];
    api.addEventListener("execution_start", async () => {

        await canvas.saveToServer(widget.value);

        if (node.inputs[0].link) {
            const linkId = node.inputs[0].link;
            const inputData = app.nodeOutputs[linkId];
            if (inputData) {
                ImageCache.set(linkId, inputData);
            }
        }
    });

    const originalSaveToServer = canvas.saveToServer;
    canvas.saveToServer = async function (fileName) {
        const result = await originalSaveToServer.call(this, fileName);
        return result;
    };

    node.canvasWidget = canvas;

    return {
        canvas: canvas,
        panel: controlPanel
    };
}


class MattingStatusIndicator {
    static instance = null;

    static getInstance(container) {
        if (!MattingStatusIndicator.instance) {
            MattingStatusIndicator.instance = new MattingStatusIndicator(container);
        }
        return MattingStatusIndicator.instance;
    }

    constructor(container) {
        this.indicator = document.createElement('div');
        this.indicator.style.cssText = `
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background-color: #808080;
            margin-left: 10px;
            display: inline-block;
            transition: background-color 0.3s;
        `;

        const style = document.createElement('style');
        style.textContent = `
            .processing {
                background-color: #2196F3;
                animation: blink 1s infinite;
            }
            .completed {
                background-color: #4CAF50;
            }
            .error {
                background-color: #f44336;
            }
            @keyframes blink {
                0% { opacity: 1; }
                50% { opacity: 0.4; }
                100% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);

        container.appendChild(this.indicator);
    }

    setStatus(status) {
        this.indicator.className = '';
        if (status) {
            this.indicator.classList.add(status);
        }
        if (status === 'completed') {
            setTimeout(() => {
                this.indicator.classList.remove('completed');
            }, 2000);
        }
    }
}

function validateImageData(data) {

    console.log("Validating data structure:", {
        hasData: !!data,
        type: typeof data,
        isArray: Array.isArray(data),
        keys: data ? Object.keys(data) : null,
        shape: data?.shape,
        dataType: data?.data ? data.data.constructor.name : null,
        fullData: data
    });

    if (!data) {
        console.log("Data is null or undefined");
        return false;
    }

    if (Array.isArray(data)) {
        console.log("Data is array, getting first element");
        data = data[0];
    }

    if (!data || typeof data !== 'object') {
        console.log("Invalid data type");
        return false;
    }

    if (!data.data) {
        console.log("Missing data property");
        return false;
    }

    if (!(data.data instanceof Float32Array)) {

        try {
            data.data = new Float32Array(data.data);
        } catch (e) {
            console.log("Failed to convert data to Float32Array:", e);
            return false;
        }
    }

    return true;
}

function convertImageData(data) {
    console.log("Converting image data:", data);

    if (Array.isArray(data)) {
        data = data[0];
    }

    const shape = data.shape;
    const height = shape[1];
    const width = shape[2];
    const channels = shape[3];
    const floatData = new Float32Array(data.data);

    console.log("Processing dimensions:", {height, width, channels});

    const rgbaData = new Uint8ClampedArray(width * height * 4);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const tensorIndex = (h * width + w) * channels;

            for (let c = 0; c < channels; c++) {
                const value = floatData[tensorIndex + c];
                rgbaData[pixelIndex + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
            }

            rgbaData[pixelIndex + 3] = 255;
        }
    }

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}

function applyMaskToImageData(imageData, maskData) {
    console.log("Applying mask to image data");

    const rgbaData = new Uint8ClampedArray(imageData.data);
    const width = imageData.width;
    const height = imageData.height;

    const maskShape = maskData.shape;
    const maskFloatData = new Float32Array(maskData.data);

    console.log(`Applying mask of shape: ${maskShape}`);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const maskIndex = h * width + w;

            const alpha = maskFloatData[maskIndex];
            rgbaData[pixelIndex + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
        }
    }

    console.log("Mask application completed");

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}

const ImageCache = {
    cache: new Map(),

    set(key, imageData) {
        console.log("Caching image data for key:", key);
        this.cache.set(key, imageData);
    },

    get(key) {
        const data = this.cache.get(key);
        console.log("Retrieved cached data for key:", key, !!data);
        return data;
    },

    has(key) {
        return this.cache.has(key);
    },

    clear() {
        console.log("Clearing image cache");
        this.cache.clear();
    }
};

function prepareImageForCanvas(inputImage) {
    console.log("Preparing image for canvas:", inputImage);

    try {

        if (Array.isArray(inputImage)) {
            inputImage = inputImage[0];
        }

        if (!inputImage || !inputImage.shape || !inputImage.data) {
            throw new Error("Invalid input image format");
        }

        const shape = inputImage.shape;
        const height = shape[1];
        const width = shape[2];
        const channels = shape[3];
        const floatData = new Float32Array(inputImage.data);

        console.log("Image dimensions:", {height, width, channels});

        const rgbaData = new Uint8ClampedArray(width * height * 4);

        for (let h = 0; h < height; h++) {
            for (let w = 0; w < width; w++) {
                const pixelIndex = (h * width + w) * 4;
                const tensorIndex = (h * width + w) * channels;

                for (let c = 0; c < channels; c++) {
                    const value = floatData[tensorIndex + c];
                    rgbaData[pixelIndex + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
                }

                rgbaData[pixelIndex + 3] = 255;
            }
        }

        return {
            data: rgbaData,
            width: width,
            height: height
        };
    } catch (error) {
        console.error("Error preparing image:", error);
        throw new Error(`Failed to prepare image: ${error.message}`);
    }
}

app.registerExtension({
    name: "Comfy.CanvasNode",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "CanvasNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = async function () {
                const r = onNodeCreated?.apply(this, arguments);

                const widget = this.widgets.find(w => w.name === "canvas_image");
                await createCanvasWidget(this, widget, app);

                return r;
            };
            const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                originalGetExtraMenuOptions?.apply(this, arguments);

                const self = this;
                const newOptions = [
                    {
                        content: "Open Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                console.error("Error opening image:", e);
                            }
                        },
                    },
                    {
                        content: "Copy Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const item = new ClipboardItem({'image/png': blob});
                                await navigator.clipboard.write([item]);
                                console.log("Image copied to clipboard.");
                            } catch (e) {
                                console.error("Error copying image:", e);
                                alert("Failed to copy image to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Save Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                console.error("Error saving image:", e);
                            }
                        },
                    },
                ];
                if (options.length > 0) {
                    options.unshift({content: "___", disabled: true});
                }
                options.unshift(...newOptions);
            };
        }
    }
});

async function handleImportInput(data) {
    if (data && data.image) {
        const imageData = data.image;
        await importImage(imageData);
    }
}
