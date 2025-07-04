// @ts-ignore
import { app } from "../../scripts/app.js";
// @ts-ignore
import { $el } from "../../scripts/ui.js";
import { addStylesheet, getUrl, loadTemplate } from "./utils/ResourceManager.js";
import { Canvas } from "./Canvas.js";
import { clearAllCanvasStates } from "./db.js";
import { ImageCache } from "./ImageCache.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('Canvas_view');
async function createCanvasWidget(node, widget, app) {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput(node, canvas)
    });
    const imageCache = new ImageCache();
    const helpTooltip = $el("div.painter-tooltip", {
        id: `painter-help-tooltip-${node.id}`,
    });
    const [standardShortcuts, maskShortcuts, systemClipboardTooltip, clipspaceClipboardTooltip] = await Promise.all([
        loadTemplate('./templates/standard_shortcuts.html'),
        loadTemplate('./templates/mask_shortcuts.html'),
        loadTemplate('./templates/system_clipboard_tooltip.html'),
        loadTemplate('./templates/clipspace_clipboard_tooltip.html')
    ]);
    document.body.appendChild(helpTooltip);
    const showTooltip = (buttonElement, content) => {
        helpTooltip.innerHTML = content;
        helpTooltip.style.visibility = 'hidden';
        helpTooltip.style.display = 'block';
        const buttonRect = buttonElement.getBoundingClientRect();
        const tooltipRect = helpTooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let left = buttonRect.left;
        let top = buttonRect.bottom + 5;
        if (left + tooltipRect.width > viewportWidth) {
            left = viewportWidth - tooltipRect.width - 10;
        }
        if (top + tooltipRect.height > viewportHeight) {
            top = buttonRect.top - tooltipRect.height - 5;
        }
        if (left < 10)
            left = 10;
        if (top < 10)
            top = 10;
        helpTooltip.style.left = `${left}px`;
        helpTooltip.style.top = `${top}px`;
        helpTooltip.style.visibility = 'visible';
    };
    const hideTooltip = () => {
        helpTooltip.style.display = 'none';
    };
    const controlPanel = $el("div.painterControlPanel", {}, [
        $el("div.controls.painter-controls", {
            style: {
                position: "absolute",
                top: "0",
                left: "0",
                right: "0",
                zIndex: "10",
            },
        }, [
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    id: `open-editor-btn-${node.id}`,
                    textContent: "⛶",
                    title: "Open in Editor",
                    style: { minWidth: "40px", maxWidth: "40px", fontWeight: "bold" },
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
                        const content = canvas.maskTool.isActive ? maskShortcuts : standardShortcuts;
                        showTooltip(e.target, content);
                    },
                    onmouseleave: hideTooltip
                }),
                $el("button.painter-button.primary", {
                    textContent: "Add Image",
                    title: "Add image from file",
                    onclick: () => {
                        const fitOnAddWidget = node.widgets.find((w) => w.name === "fit_on_add");
                        const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            const target = e.target;
                            if (!target.files)
                                return;
                            for (const file of target.files) {
                                const reader = new FileReader();
                                reader.onload = (event) => {
                                    const img = new Image();
                                    img.onload = () => {
                                        canvas.addLayer(img, {}, addMode);
                                    };
                                    if (event.target?.result) {
                                        img.src = event.target.result;
                                    }
                                };
                                reader.readAsDataURL(file);
                            }
                        };
                        input.click();
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Import Input",
                    title: "Import image from another node",
                    onclick: () => canvas.canvasIO.importLatestImage()
                }),
                $el("div.painter-clipboard-group", {}, [
                    $el("button.painter-button.primary", {
                        textContent: "Paste Image",
                        title: "Paste image from clipboard",
                        onclick: () => {
                            const fitOnAddWidget = node.widgets.find((w) => w.name === "fit_on_add");
                            const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                            canvas.canvasLayers.handlePaste(addMode);
                        }
                    }),
                    $el("button.painter-button", {
                        id: `clipboard-toggle-${node.id}`,
                        textContent: "📋 System",
                        title: "Toggle clipboard source: System Clipboard",
                        style: {
                            minWidth: "100px",
                            fontSize: "11px",
                            backgroundColor: "#4a4a4a"
                        },
                        onclick: (e) => {
                            const button = e.target;
                            if (canvas.canvasLayers.clipboardPreference === 'system') {
                                canvas.canvasLayers.clipboardPreference = 'clipspace';
                                button.textContent = "📋 Clipspace";
                                button.title = "Toggle clipboard source: ComfyUI Clipspace";
                                button.style.backgroundColor = "#4a6cd4";
                            }
                            else {
                                canvas.canvasLayers.clipboardPreference = 'system';
                                button.textContent = "📋 System";
                                button.title = "Toggle clipboard source: System Clipboard";
                                button.style.backgroundColor = "#4a4a4a";
                            }
                            log.info(`Clipboard preference toggled to: ${canvas.canvasLayers.clipboardPreference}`);
                        },
                        onmouseenter: (e) => {
                            const currentPreference = canvas.canvasLayers.clipboardPreference;
                            const tooltipContent = currentPreference === 'system' ? systemClipboardTooltip : clipspaceClipboardTooltip;
                            showTooltip(e.target, tooltipContent);
                        },
                        onmouseleave: hideTooltip
                    })
                ]),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Output Area Size",
                    title: "Set the size of the output area",
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
                                    value: String(canvas.width),
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
                                    value: String(canvas.height),
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
                            const widthInput = document.getElementById('canvas-width');
                            const heightInput = document.getElementById('canvas-height');
                            const width = parseInt(widthInput.value) || canvas.width;
                            const height = parseInt(heightInput.value) || canvas.height;
                            canvas.updateOutputAreaSize(width, height);
                            document.body.removeChild(dialog);
                        };
                        document.getElementById('cancel-size').onclick = () => {
                            document.body.removeChild(dialog);
                        };
                    }
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Remove Layer",
                    title: "Remove selected layer(s)",
                    onclick: () => canvas.removeSelectedLayers()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Up",
                    title: "Move selected layer(s) up",
                    onclick: () => canvas.canvasLayers.moveLayerUp()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Down",
                    title: "Move selected layer(s) down",
                    onclick: () => canvas.canvasLayers.moveLayerDown()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Fuse",
                    title: "Flatten and merge selected layers into a single layer",
                    onclick: () => canvas.canvasLayers.fuseLayers()
                }),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection", {
                    textContent: "Rotate +90°",
                    title: "Rotate selected layer(s) by +90 degrees",
                    onclick: () => canvas.canvasLayers.rotateLayer(90)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Scale +5%",
                    title: "Increase size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(1.05)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Scale -5%",
                    title: "Decrease size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(0.95)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Mirror H",
                    title: "Mirror selected layer(s) horizontally",
                    onclick: () => canvas.canvasLayers.mirrorHorizontal()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Mirror V",
                    title: "Mirror selected layer(s) vertically",
                    onclick: () => canvas.canvasLayers.mirrorVertical()
                }),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection.matting-button", {
                    textContent: "Matting",
                    title: "Perform background removal on the selected layer",
                    onclick: async (e) => {
                        const button = e.target.closest('.matting-button');
                        if (button.classList.contains('loading'))
                            return;
                        const spinner = $el("div.matting-spinner");
                        button.appendChild(spinner);
                        button.classList.add('loading');
                        try {
                            if (canvas.canvasSelection.selectedLayers.length !== 1)
                                throw new Error("Please select exactly one image layer for matting.");
                            const selectedLayer = canvas.canvasSelection.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.canvasLayers.getLayerImageData(selectedLayer);
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ image: imageData })
                            });
                            const result = await response.json();
                            if (!response.ok) {
                                let errorMsg = `Server error: ${response.status} - ${response.statusText}`;
                                if (result && result.error) {
                                    errorMsg = `Error: ${result.error}\n\nDetails: ${result.details}`;
                                }
                                throw new Error(errorMsg);
                            }
                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();
                            const newLayer = { ...selectedLayer, image: mattedImage };
                            delete newLayer.imageId;
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.canvasSelection.updateSelection([newLayer]);
                            canvas.render();
                            canvas.saveState();
                        }
                        catch (error) {
                            log.error("Matting error:", error);
                            const errorMessage = error.message || "An unknown error occurred.";
                            const errorDetails = error.stack || (error.details ? JSON.stringify(error.details, null, 2) : "No details available.");
                            showErrorDialog(errorMessage, errorDetails);
                        }
                        finally {
                            button.classList.remove('loading');
                            if (button.contains(spinner)) {
                                button.removeChild(spinner);
                            }
                        }
                    }
                }),
                $el("button.painter-button", {
                    id: `undo-button-${node.id}`,
                    textContent: "Undo",
                    title: "Undo last action",
                    disabled: true,
                    onclick: () => canvas.undo()
                }),
                $el("button.painter-button", {
                    id: `redo-button-${node.id}`,
                    textContent: "Redo",
                    title: "Redo last undone action",
                    disabled: true,
                    onclick: () => canvas.redo()
                }),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", { id: "mask-controls" }, [
                $el("button.painter-button.primary", {
                    id: `toggle-mask-btn-${node.id}`,
                    textContent: "Show Mask",
                    title: "Toggle mask overlay visibility",
                    onclick: (e) => {
                        const button = e.target;
                        canvas.maskTool.toggleOverlayVisibility();
                        canvas.render();
                        if (canvas.maskTool.isOverlayVisible) {
                            button.classList.add('primary');
                            button.textContent = "Show Mask";
                        }
                        else {
                            button.classList.remove('primary');
                            button.textContent = "Hide Mask";
                        }
                    }
                }),
                $el("button.painter-button", {
                    textContent: "Edit Mask",
                    title: "Open the current canvas view in the mask editor",
                    onclick: () => {
                        canvas.startMaskEditor(null, true);
                    }
                }),
                $el("button.painter-button", {
                    id: "mask-mode-btn",
                    textContent: "Draw Mask",
                    title: "Toggle mask drawing mode",
                    onclick: () => {
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn');
                        const maskControls = controlPanel.querySelector('#mask-controls');
                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => c.style.display = 'none');
                        }
                        else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => c.style.display = 'flex');
                        }
                        setTimeout(() => canvas.render(), 0);
                    }
                }),
                $el("div.painter-slider-container.mask-control", { style: { display: 'none' } }, [
                    $el("label", { for: "brush-size-slider", textContent: "Size:" }),
                    $el("input", {
                        id: "brush-size-slider",
                        type: "range",
                        min: "1",
                        max: "200",
                        value: "20",
                        oninput: (e) => canvas.maskTool.setBrushSize(parseInt(e.target.value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", { style: { display: 'none' } }, [
                    $el("label", { for: "brush-strength-slider", textContent: "Strength:" }),
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
                $el("div.painter-slider-container.mask-control", { style: { display: 'none' } }, [
                    $el("label", { for: "brush-hardness-slider", textContent: "Hardness:" }),
                    $el("input", {
                        id: "brush-hardness-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => canvas.maskTool.setBrushHardness(parseFloat(e.target.value))
                    })
                ]),
                $el("button.painter-button.mask-control", {
                    textContent: "Clear Mask",
                    title: "Clear the entire mask",
                    style: { display: 'none' },
                    onclick: () => {
                        if (confirm("Are you sure you want to clear the mask?")) {
                            canvas.maskTool.clear();
                            canvas.render();
                        }
                    }
                })
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Run GC",
                    title: "Run Garbage Collection to clean unused images",
                    style: { backgroundColor: "#4a7c59", borderColor: "#3a6c49" },
                    onclick: async () => {
                        try {
                            const stats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats before cleanup:", stats);
                            await canvas.imageReferenceManager.manualGarbageCollection();
                            const newStats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats after cleanup:", newStats);
                            alert(`Garbage collection completed!\nTracked images: ${newStats.trackedImages}\nTotal references: ${newStats.totalReferences}\nOperations: ${canvas.imageReferenceManager.operationCount}/${canvas.imageReferenceManager.operationThreshold}`);
                        }
                        catch (e) {
                            log.error("Failed to run garbage collection:", e);
                            alert("Error running garbage collection. Check the console for details.");
                        }
                    }
                }),
                $el("button.painter-button", {
                    textContent: "Clear Cache",
                    title: "Clear all saved canvas states from browser storage",
                    style: { backgroundColor: "#c54747", borderColor: "#a53737" },
                    onclick: async () => {
                        if (confirm("Are you sure you want to clear all saved canvas states? This action cannot be undone.")) {
                            try {
                                await clearAllCanvasStates();
                                alert("Canvas cache cleared successfully!");
                            }
                            catch (e) {
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
        const selectionCount = canvas.canvasSelection.selectedLayers.length;
        const hasSelection = selectionCount > 0;
        controlPanel.querySelectorAll('.requires-selection').forEach((btn) => {
            const button = btn;
            if (button.textContent === 'Fuse') {
                button.disabled = selectionCount < 2;
            }
            else {
                button.disabled = !hasSelection;
            }
        });
        const mattingBtn = controlPanel.querySelector('.matting-button');
        if (mattingBtn && !mattingBtn.classList.contains('loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
    };
    canvas.canvasSelection.onSelectionChange = updateButtonStates;
    const undoButton = controlPanel.querySelector(`#undo-button-${node.id}`);
    const redoButton = controlPanel.querySelector(`#redo-button-${node.id}`);
    canvas.onHistoryChange = ({ canUndo, canRedo }) => {
        if (undoButton)
            undoButton.disabled = !canUndo;
        if (redoButton)
            redoButton.disabled = !canRedo;
    };
    updateButtonStates();
    canvas.updateHistoryButtons();
    const updateOutput = async (node, canvas) => {
        const triggerWidget = node.widgets.find((w) => w.name === "trigger");
        if (triggerWidget) {
            triggerWidget.value = (triggerWidget.value + 1) % 99999999;
        }
        try {
            const new_preview = new Image();
            const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
            if (blob) {
                new_preview.src = URL.createObjectURL(blob);
                await new Promise(r => new_preview.onload = r);
                node.imgs = [new_preview];
            }
            else {
                node.imgs = [];
            }
        }
        catch (error) {
            console.error("Error updating node preview:", error);
        }
    };
    const layersPanel = canvas.canvasLayersPanel.createPanelStructure();
    const canvasContainer = $el("div.painterCanvasContainer.painter-container", {
        style: {
            position: "absolute",
            top: "60px",
            left: "10px",
            right: "270px",
            bottom: "10px",
            overflow: "hidden"
        }
    }, [canvas.canvas]);
    const layersPanelContainer = $el("div.painterLayersPanelContainer", {
        style: {
            position: "absolute",
            top: "60px",
            right: "10px",
            width: "250px",
            bottom: "10px",
            overflow: "hidden"
        }
    }, [layersPanel]);
    const resizeObserver = new ResizeObserver((entries) => {
        const controlsHeight = entries[0].target.offsetHeight;
        const newTop = (controlsHeight + 10) + "px";
        canvasContainer.style.top = newTop;
        layersPanelContainer.style.top = newTop;
    });
    const controlsElement = controlPanel.querySelector('.controls');
    if (controlsElement) {
        resizeObserver.observe(controlsElement);
    }
    canvas.canvas.addEventListener('focus', () => {
        canvasContainer.classList.add('has-focus');
    });
    canvas.canvas.addEventListener('blur', () => {
        canvasContainer.classList.remove('has-focus');
    });
    node.onResize = function () {
        canvas.render();
    };
    const mainContainer = $el("div.painterMainContainer", {
        style: {
            position: "relative",
            width: "100%",
            height: "100%"
        }
    }, [controlPanel, canvasContainer, layersPanelContainer]);
    node.addDOMWidget("mainContainer", "widget", mainContainer);
    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`);
    let backdrop = null;
    let originalParent = null;
    let isEditorOpen = false;
    const closeEditor = () => {
        if (originalParent && backdrop) {
            originalParent.appendChild(mainContainer);
            document.body.removeChild(backdrop);
        }
        isEditorOpen = false;
        openEditorBtn.textContent = "⛶";
        openEditorBtn.title = "Open in Editor";
        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };
    openEditorBtn.onclick = () => {
        if (isEditorOpen) {
            closeEditor();
            return;
        }
        originalParent = mainContainer.parentElement;
        if (!originalParent) {
            log.error("Could not find original parent of the canvas container!");
            return;
        }
        backdrop = $el("div.painter-modal-backdrop");
        const modalContent = $el("div.painter-modal-content");
        modalContent.appendChild(mainContainer);
        backdrop.appendChild(modalContent);
        document.body.appendChild(backdrop);
        isEditorOpen = true;
        openEditorBtn.textContent = "X";
        openEditorBtn.title = "Close Editor";
        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };
    if (!window.canvasExecutionStates) {
        window.canvasExecutionStates = new Map();
    }
    node.canvasWidget = canvas;
    setTimeout(() => {
        canvas.loadInitialState();
        if (canvas.canvasLayersPanel) {
            canvas.canvasLayersPanel.renderLayers();
        }
    }, 100);
    const showPreviewWidget = node.widgets.find((w) => w.name === "show_preview");
    if (showPreviewWidget) {
        const originalCallback = showPreviewWidget.callback;
        showPreviewWidget.callback = function (value) {
            if (originalCallback) {
                originalCallback.call(this, value);
            }
            if (canvas && canvas.setPreviewVisibility) {
                canvas.setPreviewVisibility(value);
            }
            if (node.graph && node.graph.canvas) {
                node.setDirtyCanvas(true, true);
            }
        };
    }
    return {
        canvas: canvas,
        panel: controlPanel
    };
}
function showErrorDialog(message, details) {
    const dialog = $el("div.painter-dialog.error-dialog", {
        style: {
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: '9999',
            padding: '20px',
            background: '#282828',
            border: '1px solid #ff4444',
            borderRadius: '8px',
            minWidth: '400px',
            maxWidth: '80vw',
        }
    }, [
        $el("h3", { textContent: "Matting Error", style: { color: "#ff4444", marginTop: "0" } }),
        $el("p", { textContent: message, style: { color: "white" } }),
        $el("pre.error-details", {
            textContent: details,
            style: {
                background: "#1e1e1e",
                border: "1px solid #444",
                padding: "10px",
                maxHeight: "300px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color: "#ccc"
            }
        }),
        $el("div.dialog-buttons", { style: { textAlign: "right", marginTop: "20px" } }, [
            $el("button", {
                textContent: "Copy Details",
                onclick: () => {
                    navigator.clipboard.writeText(details)
                        .then(() => alert("Error details copied to clipboard!"))
                        .catch(err => alert("Failed to copy details: " + err));
                }
            }),
            $el("button", {
                textContent: "Close",
                style: { marginLeft: "10px" },
                onclick: () => document.body.removeChild(dialog)
            })
        ])
    ]);
    document.body.appendChild(dialog);
}
const canvasNodeInstances = new Map();
app.registerExtension({
    name: "Comfy.CanvasNode",
    init() {
        addStylesheet(getUrl('./css/canvas_view.css'));
        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (number, prompt) {
            log.info("Preparing to queue prompt...");
            if (canvasNodeInstances.size > 0) {
                log.info(`Found ${canvasNodeInstances.size} CanvasNode(s). Sending data via WebSocket...`);
                const sendPromises = [];
                for (const [nodeId, canvasWidget] of canvasNodeInstances.entries()) {
                    if (app.graph.getNodeById(nodeId) && canvasWidget.canvas && canvasWidget.canvas.canvasIO) {
                        log.debug(`Sending data for canvas node ${nodeId}`);
                        sendPromises.push(canvasWidget.canvas.canvasIO.sendDataViaWebSocket(nodeId));
                    }
                    else {
                        log.warn(`Node ${nodeId} not found in graph, removing from instances map.`);
                        canvasNodeInstances.delete(nodeId);
                    }
                }
                try {
                    await Promise.all(sendPromises);
                    log.info("All canvas data has been sent and acknowledged by the server.");
                }
                catch (error) {
                    log.error("Failed to send canvas data for one or more nodes. Aborting prompt.", error);
                    alert(`CanvasNode Error: ${error.message}`);
                    return;
                }
            }
            log.info("All pre-prompt tasks complete. Proceeding with original queuePrompt.");
            return originalQueuePrompt.apply(this, arguments);
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "CanvasNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                log.debug("CanvasNode onNodeCreated: Base widget setup.");
                const r = onNodeCreated?.apply(this, arguments);
                this.size = [1150, 1000];
                return r;
            };
            nodeType.prototype.onAdded = async function () {
                log.info(`CanvasNode onAdded, ID: ${this.id}`);
                log.debug(`Available widgets in onAdded:`, this.widgets.map((w) => w.name));
                if (this.canvasWidget) {
                    log.warn(`CanvasNode ${this.id} already initialized. Skipping onAdded setup.`);
                    return;
                }
                this.widgets.forEach((w) => {
                    log.debug(`Widget name: ${w.name}, type: ${w.type}, value: ${w.value}`);
                });
                const nodeIdWidget = this.widgets.find((w) => w.name === "node_id");
                if (nodeIdWidget) {
                    nodeIdWidget.value = String(this.id);
                    log.debug(`Set hidden node_id widget to: ${nodeIdWidget.value}`);
                }
                else {
                    log.error("Could not find the hidden node_id widget!");
                }
                const canvasWidget = await createCanvasWidget(this, null, app);
                canvasNodeInstances.set(this.id, canvasWidget);
                log.info(`Registered CanvasNode instance for ID: ${this.id}`);
                setTimeout(() => {
                    this.setDirtyCanvas(true, true);
                }, 100);
            };
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                log.info(`Cleaning up canvas node ${this.id}`);
                canvasNodeInstances.delete(this.id);
                log.info(`Deregistered CanvasNode instance for ID: ${this.id}`);
                if (window.canvasExecutionStates) {
                    window.canvasExecutionStates.delete(this.id);
                }
                const tooltip = document.getElementById(`painter-help-tooltip-${this.id}`);
                if (tooltip) {
                    tooltip.remove();
                }
                const backdrop = document.querySelector('.painter-modal-backdrop');
                if (backdrop && this.canvasWidget && backdrop.contains(this.canvasWidget.canvas.canvas)) {
                    document.body.removeChild(backdrop);
                }
                if (this.canvasWidget && this.canvasWidget.destroy) {
                    this.canvasWidget.destroy();
                }
                return onRemoved?.apply(this, arguments);
            };
            const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                originalGetExtraMenuOptions?.apply(this, arguments);
                const self = this;
                const maskEditorIndex = options.findIndex((option) => option && option.content === "Open in MaskEditor");
                if (maskEditorIndex !== -1) {
                    options.splice(maskEditorIndex, 1);
                }
                const newOptions = [
                    {
                        content: "Open in MaskEditor",
                        callback: async () => {
                            try {
                                log.info("Opening LayerForge canvas in MaskEditor");
                                if (self.canvasWidget && self.canvasWidget.startMaskEditor) {
                                    await self.canvasWidget.startMaskEditor(null, true);
                                }
                                else {
                                    log.error("Canvas widget not available");
                                    alert("Canvas not ready. Please try again.");
                                }
                            }
                            catch (e) {
                                log.error("Error opening MaskEditor:", e);
                                alert(`Failed to open MaskEditor: ${e.message}`);
                            }
                        },
                    },
                    {
                        content: "Open Image",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob)
                                    return;
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }
                            catch (e) {
                                log.error("Error opening image:", e);
                            }
                        },
                    },
                    {
                        content: "Open Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob)
                                    return;
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }
                            catch (e) {
                                log.error("Error opening image with mask:", e);
                            }
                        },
                    },
                    {
                        content: "Copy Image",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob)
                                    return;
                                const item = new ClipboardItem({ 'image/png': blob });
                                await navigator.clipboard.write([item]);
                                log.info("Image copied to clipboard.");
                            }
                            catch (e) {
                                log.error("Error copying image:", e);
                                alert("Failed to copy image to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Copy Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob)
                                    return;
                                const item = new ClipboardItem({ 'image/png': blob });
                                await navigator.clipboard.write([item]);
                                log.info("Image with mask alpha copied to clipboard.");
                            }
                            catch (e) {
                                log.error("Error copying image with mask:", e);
                                alert("Failed to copy image with mask to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Save Image",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob)
                                    return;
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }
                            catch (e) {
                                log.error("Error saving image:", e);
                            }
                        },
                    },
                    {
                        content: "Save Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget)
                                    return;
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob)
                                    return;
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output_with_mask.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            }
                            catch (e) {
                                log.error("Error saving image with mask:", e);
                            }
                        },
                    },
                ];
                if (options.length > 0) {
                    options.unshift({ content: "___", disabled: true });
                }
                options.unshift(...newOptions);
            };
        }
    }
});
