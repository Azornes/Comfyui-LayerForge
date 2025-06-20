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
        
        .painter-button:disabled,
        .painter-button:disabled:hover {
            background: #555;
            color: #888;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
            border-color: #444;
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
                                    canvas.width / img.width,
                                    canvas.height / img.height
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
            $el("button.painter-button.primary", {
                textContent: "Paste Image",
                onclick: async () => {
                    try {
                        // Sprawdzenie, czy przeglądarka obsługuje API schowka
                        if (!navigator.clipboard || !navigator.clipboard.read) {
                            alert("Your browser does not support pasting from the clipboard.");
                            return;
                        }

                        // Poproś o dostęp do schowka i odczytaj jego zawartość
                        const clipboardItems = await navigator.clipboard.read();
                        let imageFound = false;

                        for (const item of clipboardItems) {
                            // Szukaj typu danych, który jest obrazem
                            const imageType = item.types.find(type => type.startsWith('image/'));

                            if (imageType) {
                                // Pobierz dane obrazu jako Blob
                                const blob = await item.getType(imageType);

                                // Ta część jest niemal identyczna jak w "Add Image"
                                const img = new Image();
                                img.onload = () => {
                                    // Skaluj obraz, aby pasował do canvasu, zachowując proporcje
                                    const scale = Math.min(
                                        canvas.width / img.width,
                                        canvas.height / img.height
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
                                    canvas.updateSelection([layer]); // Zaznacz nową warstwę
                                    canvas.render();

                                    // Zwolnij zasób URL po załadowaniu obrazu
                                    URL.revokeObjectURL(img.src);
                                };
                                img.src = URL.createObjectURL(blob);
                                imageFound = true;
                                break; // Znaleziono obraz, przerwij pętlę
                            }
                        }

                        if (!imageFound) {
                            alert("No image found in the clipboard.");
                        }

                    } catch (err) {
                        console.error("Failed to paste image:", err);
                        alert("Could not paste image. Please ensure you have granted clipboard permissions or that there is an image in the clipboard.");
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
            $el("button.painter-button.requires-selection", {
                textContent: "Remove Layer",
                onclick: () => {
                    if (canvas.selectedLayers.length > 0) {
                        // Tworzy nową tablicę warstw, odfiltrowując te zaznaczone
                        canvas.layers = canvas.layers.filter(l => !canvas.selectedLayers.includes(l));
                        // Czyści zaznaczenie i powiadamia UI
                        canvas.updateSelection([]);
                        canvas.render();
                    }
                }
            }),
            $el("button.painter-button.requires-selection", {
                textContent: "Rotate +90°",
                onclick: () => canvas.rotateLayer(90)
            }),
            $el("button.painter-button.requires-selection", {
                textContent: "Scale +5%",
                onclick: () => canvas.resizeLayer(1.05)
            }),
            $el("button.painter-button.requires-selection", {
                textContent: "Scale -5%",
                onclick: () => canvas.resizeLayer(0.95)
            }),
            $el("button.painter-button.requires-selection", {
                textContent: "Layer Up",
                onclick: async () => {
                    canvas.moveLayerUp();
                    await canvas.saveToServer(widget.value);
                    app.graph.runStep();
                }
            }),
            $el("button.painter-button.requires-selection", {
                textContent: "Layer Down",
                onclick: async () => {
                    canvas.moveLayerDown();
                    await canvas.saveToServer(widget.value);
                    app.graph.runStep();
                }
            }),

            $el("button.painter-button.requires-selection", {
                textContent: "Mirror H",
                onclick: () => {
                    canvas.mirrorHorizontal();
                }
            }),

            $el("button.painter-button.requires-selection", {
                textContent: "Mirror V",
                onclick: () => {
                    canvas.mirrorVertical();
                }
            }),

            $el("button.painter-button.requires-selection.matting-button", {
                textContent: "Matting",
                onclick: async () => {
                    const statusIndicator = MattingStatusIndicator.getInstance(controlPanel.querySelector('.controls'));

                    try {
                        if (canvas.selectedLayers.length !== 1) {
                            throw new Error("Please select exactly one image layer for matting.");
                        }

                        // Ustaw status na 'przetwarzanie' (żółty)
                        statusIndicator.setStatus('processing');

                        const selectedLayer = canvas.selectedLayers[0];
                        const imageData = await canvas.getLayerImageData(selectedLayer);

                        console.log("Sending image to server for matting...");

                        const response = await fetch("/matting", {
                            method: "POST",
                            headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({image: imageData})
                        });

                        if (!response.ok) {
                            throw new Error(`Server error: ${response.status} - ${response.statusText}`);
                        }

                        const result = await response.json();
                        console.log("Creating new layer with matting result...");

                        const mattedImage = new Image();
                        mattedImage.onload = async () => {
                            const newImage = new Image();
                            newImage.onload = async () => {
                                const newLayer = {
                                    image: newImage,
                                    x: selectedLayer.x,
                                    y: selectedLayer.y,
                                    width: selectedLayer.width,
                                    height: selectedLayer.height,
                                    rotation: selectedLayer.rotation,
                                    zIndex: canvas.layers.length + 1
                                };
                                canvas.layers.push(newLayer);
                                canvas.updateSelection([newLayer]);
                                canvas.render();

                                await canvas.saveToServer(widget.value);
                                app.graph.runStep();

                                // Ustaw status na 'ukończono' (zielony)
                                statusIndicator.setStatus('completed');
                            };

                            // Tworzymy obraz z przezroczystością z serwera
                            newImage.src = result.matted_image;
                        };
                        mattedImage.onerror = () => {
                            throw new Error("Failed to load the matted image from server response.");
                        };
                        mattedImage.src = result.matted_image;

                    } catch (error) {
                        console.error("Matting error:", error);
                        alert(`Error during matting process: ${error.message}`);
                        // Ustaw status na 'błąd' (czerwony)
                        statusIndicator.setStatus('error');
                    }
                }
            })


        ])
    ]);


    const updateButtonStates = () => {
        const selectionCount = canvas.selectedLayers.length;
        const hasSelection = selectionCount > 0;

        // Ogólne przyciski wymagające przynajmniej jednego zaznaczenia
        controlPanel.querySelectorAll('.requires-selection').forEach(btn => {
            btn.disabled = !hasSelection;
        });

        // Specjalna logika dla przycisku "Matting", który wymaga DOKŁADNIE jednego zaznaczenia
        const mattingBtn = controlPanel.querySelector('.matting-button');
        if (mattingBtn) {
            mattingBtn.disabled = selectionCount !== 1;
        }
    };

    canvas.onSelectionChange = updateButtonStates;
    updateButtonStates();

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
            const scale = Math.min(
                canvas.width / img.width,
                canvas.height / img.height
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
        if (container && !container.contains(MattingStatusIndicator.instance.indicator)) {
            container.appendChild(MattingStatusIndicator.instance.indicator);
        }
        return MattingStatusIndicator.instance;
    }

    constructor(container) {
        // Lista możliwych statusów, aby łatwiej nimi zarządzać
        this.statuses = ['processing', 'completed', 'error'];

        this.indicator = document.createElement('div');
        // Ustawiamy bazową klasę, która będzie miała domyślny szary kolor
        this.indicator.className = 'matting-indicator';

        // Usunięto 'background-color' z stylów inline
        this.indicator.style.cssText = `
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-left: 10px;
            display: inline-block;
            transition: background-color 0.3s ease;
        `;

        const style = document.createElement('style');
        style.textContent = `
            /* Styl dla domyślnego stanu (szary) */
            .matting-indicator {
                background-color: #808080;
            }
            /* Style dla konkretnych statusów, które nadpiszą domyślny */
            .matting-indicator.processing {
                background-color: #FFC107; /* Żółty */
                animation: blink 1s infinite;
            }
            .matting-indicator.completed {
                background-color: #4CAF50; /* Zielony */
            }
            .matting-indicator.error {
                background-color: #f44336; /* Czerwony */
            }
            @keyframes blink {
                0% { opacity: 1; }
                50% { opacity: 0.4; }
                100% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);

        if (container) {
            container.appendChild(this.indicator);
        }
    }

    setStatus(status) {
        // 1. Usuń wszystkie poprzednie klasy statusu, pozostawiając klasę bazową
        this.indicator.classList.remove(...this.statuses);

        // 2. Dodaj nową klasę statusu, jeśli została podana
        if (status && this.statuses.includes(status)) {
            this.indicator.classList.add(status);
        }

        // 3. Usuń statusy końcowe (sukces/błąd) po 3 sekundach,
        //    aby wskaźnik wrócił do domyślnego szarego koloru.
        if (status === 'completed' || status === 'error') {
            setTimeout(() => {
                this.indicator.classList.remove(status);
            }, 3000);
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
