import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {$el} from "../../scripts/ui.js";

import {Canvas} from "./Canvas.js";
import {clearAllCanvasStates} from "./db.js";
import {ImageCache} from "./ImageCache.js";
import {validateImageData, convertImageData, applyMaskToImageData, prepareImageForCanvas, createImageFromSource} from "./ImageUtils.js";
import {generateUniqueFileName} from "./CommonUtils.js";
import {logger, LogLevel} from "./logger.js";
import {createModuleLogger} from "./LoggerUtils.js";

const log = createModuleLogger('Canvas_view');

async function createCanvasWidget(node, widget, app) {
    const canvas = new Canvas(node, widget);
    const imageCache = new ImageCache();

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
            justify-content: flex-start;
        }

       .painter-slider-container {
           display: flex;
           align-items: center;
           gap: 8px;
           color: #fff;
           font-size: 12px;
       }

       .painter-slider-container input[type="range"] {
           width: 80px;
       }


        .painter-button-group {
            display: flex;
            align-items: center;
            gap: 6px;
            background-color: rgba(0,0,0,0.2);
            padding: 4px;
            border-radius: 6px;
        }

        .painter-separator {
            width: 1px;
            height: 28px;
            background-color: #2a2a2a;
            margin: 0 8px;
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
        
                .blend-mode-item.active {
            background-color: rgba(0,0,0,0.1);
        }

        .painter-tooltip {
            position: fixed; /* Pozycjonowanie względem okna przeglądarki */
            display: none;   /* Domyślnie ukryty */
            background: #3a3a3a;
            color: #f0f0f0;
            border: 1px solid #555;
            border-radius: 8px;
            padding: 12px 18px;
            z-index: 9999; /* Wyżej niż modal backdrop */
            font-size: 13px;
            line-height: 1.7;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            pointer-events: none; /* Zapobiega interakcji myszy z dymkiem */
        }
        
        .painter-tooltip h4 {
            margin-top: 10px;
            margin-bottom: 5px;
            color: #4a90e2; /* Jasnoniebieski akcent */
            border-bottom: 1px solid #555;
            padding-bottom: 4px;
        }

        .painter-tooltip ul {
            list-style: none;
            padding-left: 10px;
            margin: 0;
        }
        
        .painter-tooltip kbd {
            background-color: #2a2a2a;
            border: 1px solid #1a1a1a;
            border-radius: 3px;
            padding: 2px 6px;
            font-family: monospace;
            font-size: 12px;
            color: #d0d0d0;
        }
        
        .painter-container.has-focus {
            /* Używamy box-shadow, aby stworzyć efekt zewnętrznej ramki,
               która nie wpłynie na rozmiar ani pozycję elementu. */
            box-shadow: 0 0 0 2px white;
            /* Możesz też zmienić kolor istniejącej ramki, ale box-shadow jest bardziej wyrazisty */
            /* border-color: white; */
        }

        .painter-button.matting-button {
            position: relative;
            transition: all 0.3s ease;
        }

        .painter-button.matting-button.loading {
            padding-right: 36px; /* Make space for spinner */
            cursor: wait;
        }

        .painter-button.matting-button .matting-spinner {
            display: none;
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: matting-spin 1s linear infinite;
        }

        .painter-button.matting-button.loading .matting-spinner {
            display: block;
        }

        @keyframes matting-spin {
            to {
                transform: translateY(-50%) rotate(360deg);
            }
        }
    `;
    style.textContent += `
        .painter-modal-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(0, 0, 0, 0.8);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .painter-modal-content {
            width: 90vw;
            height: 90vh;
            background-color: #353535;
            border: 1px solid #222;
            border-radius: 8px;
            box-shadow: 0 5px 25px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            position: relative;
        }
    `;
    document.head.appendChild(style);

    const helpTooltip = $el("div.painter-tooltip", {
        id: `painter-help-tooltip-${node.id}`,
        innerHTML: `
            <h4>Canvas Control</h4>
            <ul>
                <li><kbd>Click + Drag</kbd> - Pan canvas view</li>
                <li><kbd>Mouse Wheel</kbd> - Zoom view in/out</li>
                <li><kbd>Shift + Click (background)</kbd> - Start resizing canvas area</li>
                <li><kbd>Shift + Ctrl + Click</kbd> - Start moving entire canvas</li>
                <li><kbd>Double Click (background)</kbd> - Deselect all layers</li>
            </ul>
            <h4>Clipboard & I/O</h4>
            <ul>
                <li><kbd>Ctrl + C</kbd> - Copy selected layer(s)</li>
                <li><kbd>Ctrl + V</kbd> - Paste from clipboard (image or internal layers)</li>
                <li><kbd>Drag & Drop Image File</kbd> - Add image as a new layer</li>
            </ul>
            <h4>Layer Interaction</h4>
            <ul>
                <li><kbd>Click + Drag</kbd> - Move selected layer(s)</li>
                <li><kbd>Ctrl + Click</kbd> - Add/Remove layer from selection</li>
                <li><kbd>Alt + Drag</kbd> - Clone selected layer(s)</li>
                <li><kbd>Shift + Click</kbd> - Show blend mode & opacity menu</li>
                <li><kbd>Mouse Wheel</kbd> - Scale layer (snaps to grid)</li>
                <li><kbd>Ctrl + Mouse Wheel</kbd> - Fine-scale layer</li>
                <li><kbd>Shift + Mouse Wheel</kbd> - Rotate layer by 5°</li>
                <li><kbd>Arrow Keys</kbd> - Nudge layer by 1px</li>
                <li><kbd>Shift + Arrow Keys</kbd> - Nudge layer by 10px</li>
                <li><kbd>[</kbd> or <kbd>]</kbd> - Rotate by 1°</li>
                <li><kbd>Shift + [</kbd> or <kbd>]</kbd> - Rotate by 10°</li>
                <li><kbd>Delete</kbd> - Delete selected layer(s)</li>
            </ul>
            <h4>Transform Handles (on selected layer)</h4>
            <ul>
                <li><kbd>Drag Corner/Side</kbd> - Resize layer</li>
                <li><kbd>Drag Rotation Handle</kbd> - Rotate layer</li>
                <li><kbd>Hold Shift</kbd> - Keep aspect ratio / Snap rotation to 15°</li>
                <li><kbd>Hold Ctrl</kbd> - Snap to grid</li>
            </ul>
        `
    });

    document.body.appendChild(helpTooltip);
    const controlPanel = $el("div.painterControlPanel", {}, [
        $el("div.controls.painter-controls", {
            style: {
                position: "absolute",
                top: "0",
                left: "0",
                right: "0",
                zIndex: "10",
            },

            onresize: (entries) => {
                const controlsHeight = entries[0].target.offsetHeight;
                canvasContainer.style.top = (controlsHeight + 10) + "px";
            }
        }, [
            // --- Group: Help & I/O ---
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    id: `open-editor-btn-${node.id}`,
                    textContent: "⛶",
                    title: "Open in Editor",
                    style: {minWidth: "40px", maxWidth: "40px", fontWeight: "bold"},
                }),
                $el("button.painter-button", {
                    textContent: "?",
                    title: "Show shortcuts",
                    style: {
                        minWidth: "30px",
                        maxWidth: "30px",
                        fontWeight: "bold",
                    },
                    onmouseenter: (e) => {
                        const rect = e.target.getBoundingClientRect();
                        helpTooltip.style.left = `${rect.left}px`;
                        helpTooltip.style.top = `${rect.bottom + 5}px`;
                        helpTooltip.style.display = 'block';
                    },
                    onmouseleave: () => {
                        helpTooltip.style.display = 'none';
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Add Image",
                    onclick: () => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            for (const file of e.target.files) {
                                const reader = new FileReader();
                                reader.onload = async (event) => {
                                    const img = new Image();
                                    img.onload = async () => {
                                        canvas.addLayer(img);
                                        await saveWithFallback(widget.value);
                                        app.graph.runStep();
                                    };
                                    img.src = event.target.result;
                                };
                                reader.readAsDataURL(file);
                            }
                        };
                        input.click();
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Import Input",
                    onclick: async () => {
                        if (await canvas.importLatestImage()) {
                            await saveWithFallback(widget.value);
                            app.graph.runStep();
                        }
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Paste Image",
                    onclick: () => canvas.handlePaste()
                }),
            ]),

            $el("div.painter-separator"),

            // --- Group: Canvas & Layers ---
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Canvas Size",
                    onclick: () => {
                        const dialog = $el("div.painter-dialog", {
                            style: {
                                position: 'fixed',
                                left: '50%',
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                zIndex: '9999'
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
                            canvas.saveState();
                            canvas.layers = canvas.layers.filter(l => !canvas.selectedLayers.includes(l));
                            canvas.updateSelection([]);
                            canvas.render();
                            canvas.saveState();
                        }
                    }
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Up",
                    onclick: async () => {
                        canvas.moveLayerUp();
                    }
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Down",
                    onclick: async () => {
                        canvas.moveLayerDown();
                    }
                }),
            ]),

            $el("div.painter-separator"),

            // --- Group: Transform ---
            $el("div.painter-button-group", {}, [
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
                    textContent: "Mirror H",
                    onclick: () => canvas.mirrorHorizontal()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Mirror V",
                    onclick: () => canvas.mirrorVertical()
                }),
            ]),

            $el("div.painter-separator"),

            // --- Group: Tools & History ---
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection.matting-button", {
                    textContent: "Matting",
                    onclick: async (e) => {
                        const button = e.target.closest('.matting-button');
                        if (button.classList.contains('loading')) return;

                        const spinner = $el("div.matting-spinner");
                        button.appendChild(spinner);
                        button.classList.add('loading');

                        try {
                            if (canvas.selectedLayers.length !== 1) throw new Error("Please select exactly one image layer for matting.");

                            const selectedLayer = canvas.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.getLayerImageData(selectedLayer);
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({image: imageData})
                            });

                            if (!response.ok) throw new Error(`Server error: ${response.status} - ${response.statusText}`);

                            const result = await response.json();
                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();

                            // Zastąp starą warstwę nową warstwą z obrazem bez tła
                            const newLayer = {...selectedLayer, image: mattedImage};
                            // Usuń starą imageId, aby wymusić zapisanie nowego obrazu
                            delete newLayer.imageId;
                            
                            // Zastąp warstwę w tablicy zamiast dodawać nową
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.updateSelection([newLayer]);
                            canvas.render();
                            canvas.saveState();
                            await saveWithFallback(widget.value);
                            app.graph.runStep();
                        } catch (error) {
                            log.error("Matting error:", error);
                            alert(`Error during matting process: ${error.message}`);
                        } finally {
                            button.classList.remove('loading');
                            button.removeChild(spinner);
                        }
                    }
                }),
                $el("button.painter-button", {
                    id: `undo-button-${node.id}`,
                    textContent: "Undo",
                    disabled: true,
                    onclick: () => canvas.undo()
                }),
                $el("button.painter-button", {
                    id: `redo-button-${node.id}`,
                    textContent: "Redo",
                    disabled: true,
                    onclick: () => canvas.redo()
                }),
            ]),
            $el("div.painter-separator"),

            // --- Group: Masking ---
            $el("div.painter-button-group", {id: "mask-controls"}, [
                $el("button.painter-button", {
                    id: "mask-mode-btn",
                    textContent: "Draw Mask",
                    onclick: () => {
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn');
                        const maskControls = controlPanel.querySelector('#mask-controls');

                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('primary');
                            maskControls.querySelectorAll('.mask-control').forEach(c => c.style.display = 'none');
                        } else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('primary');
                            maskControls.querySelectorAll('.mask-control').forEach(c => c.style.display = 'flex');
                        }
                    }
                }),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-size-slider", textContent: "Size:"}),
                    $el("input", {
                        id: "brush-size-slider",
                        type: "range",
                        min: "1",
                        max: "200",
                        value: "20",
                        oninput: (e) => canvas.maskTool.setBrushSize(parseInt(e.target.value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-strength-slider", textContent: "Strength:"}),
                    $el("input", {
                        id: "brush-strength-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => canvas.maskTool.setBrushStrength(parseFloat(e.target.value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-softness-slider", textContent: "Softness:"}),
                    $el("input", {
                        id: "brush-softness-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => canvas.maskTool.setBrushSoftness(parseFloat(e.target.value))
                    })
                ]),
                $el("button.painter-button.mask-control", {
                    textContent: "Clear Mask",
                    style: {display: 'none'},
                    onclick: () => {
                        if (confirm("Are you sure you want to clear the mask?")) {
                            canvas.maskTool.clear();
                            canvas.render();
                        }
                    }
                })
            ]),

            $el("div.painter-separator"),

            // --- Group: Cache ---
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Clear Cache",
                    style: {backgroundColor: "#c54747", borderColor: "#a53737"},
                    onclick: async () => {
                        if (confirm("Are you sure you want to clear all saved canvas states? This action cannot be undone.")) {
                            try {
                                await clearAllCanvasStates();
                                alert("Canvas cache cleared successfully!");
                            } catch (e) {
                                log.error("Failed to clear canvas cache:", e);
                                alert("Error clearing canvas cache. Check the console for details.");
                            }
                        }
                    }
                })
            ])
        ]),
        $el("div.painter-separator")
    ]);


    const updateButtonStates = () => {
        const selectionCount = canvas.selectedLayers.length;
        const hasSelection = selectionCount > 0;
        controlPanel.querySelectorAll('.requires-selection').forEach(btn => {
            btn.disabled = !hasSelection;
        });
        const mattingBtn = controlPanel.querySelector('.matting-button');
        if (mattingBtn && !mattingBtn.classList.contains('loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
    };

    canvas.onSelectionChange = updateButtonStates;

    const undoButton = controlPanel.querySelector(`#undo-button-${node.id}`);
    const redoButton = controlPanel.querySelector(`#redo-button-${node.id}`);

    canvas.onHistoryChange = ({canUndo, canRedo}) => {
        if (undoButton) undoButton.disabled = !canUndo;
        if (redoButton) redoButton.disabled = !canRedo;
    };

    updateButtonStates();
    canvas.updateHistoryButtons();


    const resizeObserver = new ResizeObserver((entries) => {
        const controlsHeight = entries[0].target.offsetHeight;
        canvasContainer.style.top = (controlsHeight + 10) + "px";
    });

    resizeObserver.observe(controlPanel.querySelector('.controls'));

    const triggerWidget = node.widgets.find(w => w.name === "trigger");

    const updateOutput = async () => {
        // Użyj funkcji fallback do zapisu
        await saveWithFallback(widget.value);
        triggerWidget.value = (triggerWidget.value + 1) % 99999999;
        app.graph.runStep();
    };

    const addUpdateToButton = (button) => {
        if (button.textContent === "Undo" || button.textContent === "Redo" || button.title === "Open in Editor") {
            return;
        }
        const origClick = button.onclick;
        button.onclick = async (...args) => {
            if (origClick) {
                await origClick(...args);
            }
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

    canvas.canvas.addEventListener('focus', () => {
        canvasContainer.classList.add('has-focus');
    });

    canvas.canvas.addEventListener('blur', () => {
        canvasContainer.classList.remove('has-focus');
    });


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
        log.info("File dropped:", file.name);
        if (!file.type.startsWith('image/')) {
            log.info("Dropped file is not an image.");
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            log.debug("FileReader finished loading dropped file as data:URL.");
            const img = new Image();
            img.onload = async () => {
                log.debug("Image object loaded from dropped data:URL.");
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
                canvas.updateSelection([layer]);
                canvas.render();
                canvas.saveState();
                log.info("Dropped layer added and state saved.");
                await updateOutput();
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };

    mainContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvasContainer.classList.add('drag-over');
    });

    mainContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvasContainer.classList.remove('drag-over');
    });

    mainContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        canvasContainer.classList.remove('drag-over');

        if (e.dataTransfer.files) {
            for (const file of e.dataTransfer.files) {
                await handleFileLoad(file);
            }
        }
    });

    const mainWidget = node.addDOMWidget("mainContainer", "widget", mainContainer);

    node.size = [500, 500];

    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`);
    let backdrop = null;
    let modalContent = null;
    let originalParent = null;
    let isEditorOpen = false;

    const closeEditor = () => {
        originalParent.appendChild(mainContainer);
        document.body.removeChild(backdrop);

        isEditorOpen = false;
        openEditorBtn.textContent = "⛶";
        openEditorBtn.title = "Open in Editor";

        canvas.render();
        if (node.onResize) {
            node.onResize();
        }
    };

    openEditorBtn.onclick = () => {
        if (isEditorOpen) {
            closeEditor();
            return;
        }

        originalParent = mainContainer.parentNode;
        if (!originalParent) {
            log.error("Could not find original parent of the canvas container!");
            return;
        }

        backdrop = $el("div.painter-modal-backdrop");
        modalContent = $el("div.painter-modal-content");

        modalContent.appendChild(mainContainer);
        backdrop.appendChild(modalContent);
        document.body.appendChild(backdrop);

        isEditorOpen = true;
        openEditorBtn.textContent = "X";
        openEditorBtn.title = "Close Editor";

        canvas.render();
        if (node.onResize) {
            node.onResize();
        }
    };

    // Globalna mapa do śledzenia wykonania dla każdego node-a
    if (!window.canvasExecutionStates) {
        window.canvasExecutionStates = new Map();
    }
    
    // Funkcja fallback w przypadku problemów z unikalną nazwą
    const saveWithFallback = async (fileName) => {
        try {
            const uniqueFileName = generateUniqueFileName(fileName, node.id);
            log.debug(`Attempting to save with unique name: ${uniqueFileName}`);
            return await canvas.saveToServer(uniqueFileName);
        } catch (error) {
            log.warn(`Failed to save with unique name, falling back to original: ${fileName}`, error);
            return await canvas.saveToServer(fileName);
        }
    };
    
    api.addEventListener("execution_start", async (event) => {
        // Sprawdź czy event dotyczy tego konkretnego node-a
        const executionData = event.detail || {};
        const currentPromptId = executionData.prompt_id;
        
        log.info(`Execution start event for node ${node.id}, prompt_id: ${currentPromptId}`);
        log.debug(`Widget value: ${widget.value}`);
        log.debug(`Node inputs: ${node.inputs?.length || 0}`);
        log.debug(`Canvas layers count: ${canvas.layers.length}`);
        
        // Sprawdź czy już trwa wykonanie dla tego node-a
        if (window.canvasExecutionStates.get(node.id)) {
            log.warn(`Execution already in progress for node ${node.id}, skipping...`);
            return;
        }
        
        // Ustaw flagę wykonania dla tego node-a
        window.canvasExecutionStates.set(node.id, true);
        
        try {
            // Sprawdź czy canvas ma jakiekolwiek warstwy przed zapisem
            if (canvas.layers.length === 0) {
                log.warn(`Node ${node.id} has no layers, skipping save to server`);
                // Nie zapisuj pustego canvas-a, ale nadal przetwórz dane wejściowe
            } else {
                // Użyj funkcji fallback do zapisu tylko jeśli są warstwy
                await saveWithFallback(widget.value);
                log.info(`Canvas saved to server for node ${node.id}`);
            }

            if (node.inputs[0]?.link) {
                const linkId = node.inputs[0].link;
                const inputData = app.nodeOutputs[linkId];
                log.debug(`Input link ${linkId} has data: ${!!inputData}`);
                if (inputData) {
                    imageCache.set(linkId, inputData);
                    log.debug(`Input data cached for link ${linkId}`);
                }
            } else {
                log.debug(`No input link found`);
            }
        } catch (error) {
            log.error(`Error during execution for node ${node.id}:`, error);
        } finally {
            // Zwolnij flagę wykonania dla tego node-a
            window.canvasExecutionStates.set(node.id, false);
            log.debug(`Execution completed for node ${node.id}, flag released`);
        }
    });

    const originalSaveToServer = canvas.saveToServer;
    canvas.saveToServer = async function (fileName) {
        log.debug(`saveToServer called with fileName: ${fileName}`);
        log.debug(`Current execution context - node ID: ${node.id}`);
        const result = await originalSaveToServer.call(this, fileName);
        log.debug(`saveToServer completed, result: ${result}`);
        return result;
    };

    node.canvasWidget = canvas;

    setTimeout(() => {
        canvas.loadInitialState();
    }, 100);

    return {
        canvas: canvas,
        panel: controlPanel
    };
}


app.registerExtension({
    name: "Comfy.CanvasNode",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "CanvasNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = async function () {
                log.info("CanvasNode created, ID:", this.id);
                const r = onNodeCreated?.apply(this, arguments);

                const widget = this.widgets.find(w => w.name === "canvas_image");
                log.debug("Found canvas_image widget:", widget);
                await createCanvasWidget(this, widget, app);

                return r;
            };

            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                const tooltip = document.getElementById(`painter-help-tooltip-${this.id}`);
                if (tooltip) {
                    tooltip.remove();
                }

                // If modal is open when node is removed, ensure it's cleaned up
                const backdrop = document.querySelector('.painter-modal-backdrop');
                if (backdrop && backdrop.contains(this.canvasWidget.canvas)) {
                    document.body.removeChild(backdrop);
                }

                return onRemoved?.apply(this, arguments);
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
                                log.error("Error opening image:", e);
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
                                log.info("Image copied to clipboard.");
                            } catch (e) {
                                log.error("Error copying image:", e);
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
                                log.error("Error saving image:", e);
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
