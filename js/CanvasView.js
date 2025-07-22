// @ts-ignore
import { app } from "../../scripts/app.js";
// @ts-ignore
import { api } from "../../scripts/api.js";
// @ts-ignore
import { ComfyApp } from "../../scripts/app.js";
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
                            const newLayer = { ...selectedLayer, image: mattedImage, flipH: false, flipV: false };
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
            const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
            if (blob) {
                // Auto-register in clipspace for Impact Pack compatibility and get server URL
                const serverImg = await registerImageInClipspace(node, blob);
                if (serverImg) {
                    // Use server URL image as the main image for Impact Pack compatibility
                    node.imgs = [serverImg];
                    node.clipspaceImg = serverImg;
                    log.debug(`Using server URL for node.imgs: ${serverImg.src}`);
                }
                else {
                    // Fallback to blob URL if server upload failed
                    const new_preview = new Image();
                    new_preview.src = URL.createObjectURL(blob);
                    await new Promise(r => new_preview.onload = r);
                    node.imgs = [new_preview];
                    log.debug(`Fallback to blob URL for node.imgs: ${new_preview.src}`);
                }
            }
            else {
                node.imgs = [];
            }
        }
        catch (error) {
            console.error("Error updating node preview:", error);
        }
    };
    // Function to register image in clipspace for Impact Pack compatibility
    const registerImageInClipspace = async (node, blob) => {
        try {
            // Upload the image to ComfyUI's temp storage for clipspace access
            const formData = new FormData();
            const filename = `layerforge-auto-${node.id}-${Date.now()}.png`;
            formData.append("image", blob, filename);
            formData.append("overwrite", "true");
            formData.append("type", "temp");
            const response = await api.fetchApi("/upload/image", {
                method: "POST",
                body: formData,
            });
            if (response.ok) {
                const data = await response.json();
                // Create a proper image element with the server URL
                const clipspaceImg = new Image();
                clipspaceImg.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
                // Wait for image to load
                await new Promise((resolve, reject) => {
                    clipspaceImg.onload = resolve;
                    clipspaceImg.onerror = reject;
                });
                log.debug(`Image registered in clipspace for node ${node.id}: ${filename}`);
                return clipspaceImg;
            }
        }
        catch (error) {
            log.debug("Failed to register image in clipspace:", error);
        }
        return null;
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
        // Inicjalizuj stan preview na podstawie aktualnej wartości widget'u
        if (canvas && canvas.setPreviewVisibility) {
            canvas.setPreviewVisibility(showPreviewWidget.value);
        }
    }
    return {
        canvas: canvas,
        panel: controlPanel
    };
}
// Function to monitor for SAM Detector results and apply masks to LayerForge
function startSAMDetectorMonitoring(node) {
    if (node.samMonitoringActive) {
        log.debug("SAM Detector monitoring already active for node", node.id);
        return;
    }
    node.samMonitoringActive = true;
    log.info("Starting SAM Detector monitoring for node", node.id);
    // Store original image source for comparison
    const originalImgSrc = node.imgs?.[0]?.src;
    node.samOriginalImgSrc = originalImgSrc;
    // Start monitoring for changes in node.imgs (simple polling like original approach)
    monitorSAMDetectorChanges(node);
}
// Function to monitor changes in node.imgs (simple polling approach)
function monitorSAMDetectorChanges(node) {
    let checkCount = 0;
    const maxChecks = 300; // 30 seconds maximum monitoring
    const checkForChanges = () => {
        checkCount++;
        if (!(node.samMonitoringActive)) {
            log.debug("SAM monitoring stopped for node", node.id);
            return;
        }
        log.debug(`SAM monitoring check ${checkCount}/${maxChecks} for node ${node.id}`);
        // Check if the node's image has been updated (this happens when "Save to node" is clicked)
        if (node.imgs && node.imgs.length > 0) {
            const currentImgSrc = node.imgs[0].src;
            const originalImgSrc = node.samOriginalImgSrc;
            if (currentImgSrc && currentImgSrc !== originalImgSrc) {
                log.info("SAM Detector result detected in node.imgs, processing mask...");
                handleSAMDetectorResult(node, node.imgs[0]);
                node.samMonitoringActive = false;
                return;
            }
        }
        // Continue monitoring if not exceeded max checks
        if (checkCount < maxChecks && node.samMonitoringActive) {
            setTimeout(checkForChanges, 100);
        }
        else {
            log.debug("SAM Detector monitoring timeout or stopped for node", node.id);
            node.samMonitoringActive = false;
        }
    };
    // Start monitoring after a short delay
    setTimeout(checkForChanges, 500);
}
// Function to handle SAM Detector result (using same logic as CanvasMask.handleMaskEditorClose)
async function handleSAMDetectorResult(node, resultImage) {
    try {
        log.info("Handling SAM Detector result for node", node.id);
        log.debug("Result image source:", resultImage.src.substring(0, 100) + '...');
        const canvasWidget = node.canvasWidget;
        if (!canvasWidget || !canvasWidget.canvas) {
            log.error("Canvas widget not available for SAM result processing");
            return;
        }
        const canvas = canvasWidget; // canvasWidget is the Canvas object, not canvasWidget.canvas
        // Wait for the result image to load (same as CanvasMask)
        try {
            // First check if the image is already loaded
            if (resultImage.complete && resultImage.naturalWidth > 0) {
                log.debug("SAM result image already loaded", {
                    width: resultImage.width,
                    height: resultImage.height
                });
            }
            else {
                // Try to reload the image with a fresh request
                log.debug("Attempting to reload SAM result image");
                const originalSrc = resultImage.src;
                // Add cache-busting parameter to force fresh load
                const url = new URL(originalSrc);
                url.searchParams.set('_t', Date.now().toString());
                await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => {
                        // Copy the loaded image data to the original image
                        resultImage.src = img.src;
                        resultImage.width = img.width;
                        resultImage.height = img.height;
                        log.debug("SAM result image reloaded successfully", {
                            width: img.width,
                            height: img.height,
                            originalSrc: originalSrc,
                            newSrc: img.src
                        });
                        resolve(img);
                    };
                    img.onerror = (error) => {
                        log.error("Failed to reload SAM result image", {
                            originalSrc: originalSrc,
                            newSrc: url.toString(),
                            error: error
                        });
                        reject(error);
                    };
                    img.src = url.toString();
                });
            }
        }
        catch (error) {
            log.error("Failed to load image from SAM Detector.", error);
            // Show error notification
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #c54747;
                color: white;
                padding: 12px 16px;
                border-radius: 4px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                z-index: 10001;
                font-size: 14px;
            `;
            notification.textContent = "Failed to load SAM Detector result. The mask file may not be available.";
            document.body.appendChild(notification);
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 5000);
            return;
        }
        // Create temporary canvas for mask processing (same as CanvasMask)
        log.debug("Creating temporary canvas for mask processing");
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        if (tempCtx) {
            tempCtx.drawImage(resultImage, 0, 0, canvas.width, canvas.height);
            log.debug("Processing image data to create mask");
            const imageData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            // Convert to mask format (same as CanvasMask)
            for (let i = 0; i < data.length; i += 4) {
                const originalAlpha = data[i + 3];
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = 255 - originalAlpha;
            }
            tempCtx.putImageData(imageData, 0, 0);
        }
        // Convert processed mask to image (same as CanvasMask)
        log.debug("Converting processed mask to image");
        const maskAsImage = new Image();
        maskAsImage.src = tempCanvas.toDataURL();
        await new Promise(resolve => maskAsImage.onload = resolve);
        // Apply mask to LayerForge canvas using MaskTool.setMask method
        log.debug("Checking canvas and maskTool availability", {
            hasCanvas: !!canvas,
            hasMaskTool: !!canvas.maskTool,
            maskToolType: typeof canvas.maskTool,
            canvasKeys: Object.keys(canvas)
        });
        if (!canvas.maskTool) {
            log.error("MaskTool is not available. Canvas state:", {
                hasCanvas: !!canvas,
                canvasConstructor: canvas.constructor.name,
                canvasKeys: Object.keys(canvas),
                maskToolValue: canvas.maskTool
            });
            throw new Error("Mask tool not available or not initialized");
        }
        log.debug("Applying SAM mask to canvas using setMask method");
        // Use the setMask method which handles positioning automatically
        canvas.maskTool.setMask(maskAsImage);
        // Update canvas and save state (same as CanvasMask)
        canvas.render();
        canvas.saveState();
        // Create new preview image (same as CanvasMask)
        log.debug("Creating new preview image");
        const new_preview = new Image();
        const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        if (blob) {
            new_preview.src = URL.createObjectURL(blob);
            await new Promise(r => new_preview.onload = r);
            node.imgs = [new_preview];
            log.debug("New preview image created successfully");
        }
        else {
            log.warn("Failed to create preview blob");
        }
        canvas.render();
        log.info("SAM Detector mask applied successfully to LayerForge canvas");
        // Show success notification
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #4a7c59;
            color: white;
            padding: 12px 16px;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            z-index: 10001;
            font-size: 14px;
        `;
        notification.textContent = "SAM Detector mask applied to LayerForge!";
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }
    catch (error) {
        log.error("Error processing SAM Detector result:", error);
        // Show error notification
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #c54747;
            color: white;
            padding: 12px 16px;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            z-index: 10001;
            font-size: 14px;
        `;
        notification.textContent = `Failed to apply SAM mask: ${error.message}`;
        document.body.appendChild(notification);
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
    }
    finally {
        node.samMonitoringActive = false;
        node.samOriginalImgSrc = null;
    }
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
                // FIRST: Call original to let other extensions add their options
                originalGetExtraMenuOptions?.apply(this, arguments);
                const self = this;
                // Debug: Log all menu options AFTER other extensions have added theirs
                log.info("Available menu options AFTER original call:", options.map((opt, idx) => ({
                    index: idx,
                    content: opt?.content,
                    hasCallback: !!opt?.callback
                })));
                // Debug: Check node data to see what Impact Pack sees
                const nodeData = self.constructor.nodeData || {};
                log.info("Node data for Impact Pack check:", {
                    output: nodeData.output,
                    outputType: typeof nodeData.output,
                    isArray: Array.isArray(nodeData.output),
                    nodeType: self.type,
                    comfyClass: self.comfyClass
                });
                // Additional debug: Check if any option contains common Impact Pack keywords
                const impactOptions = options.filter((opt, idx) => {
                    if (!opt || !opt.content)
                        return false;
                    const content = opt.content.toLowerCase();
                    return content.includes('impact') ||
                        content.includes('sam') ||
                        content.includes('detector') ||
                        content.includes('segment') ||
                        content.includes('mask') ||
                        content.includes('open in');
                });
                if (impactOptions.length > 0) {
                    log.info("Found potential Impact Pack options:", impactOptions.map(opt => opt.content));
                }
                else {
                    log.info("No Impact Pack-related options found in menu");
                }
                // Debug: Check if Impact Pack extension is loaded
                const impactExtensions = app.extensions.filter((ext) => ext.name && ext.name.toLowerCase().includes('impact'));
                log.info("Impact Pack extensions found:", impactExtensions.map((ext) => ext.name));
                // Debug: Check menu options again after a delay to see if Impact Pack adds options later
                setTimeout(() => {
                    log.info("Menu options after 100ms delay:", options.map((opt, idx) => ({
                        index: idx,
                        content: opt?.content,
                        hasCallback: !!opt?.callback
                    })));
                    // Try to find SAM Detector again
                    const delayedSamDetectorIndex = options.findIndex((option) => option && option.content && (option.content.includes("SAM Detector") ||
                        option.content.includes("SAM") ||
                        option.content.includes("Detector") ||
                        option.content.toLowerCase().includes("sam") ||
                        option.content.toLowerCase().includes("detector")));
                    if (delayedSamDetectorIndex !== -1) {
                        log.info(`Found SAM Detector after delay at index ${delayedSamDetectorIndex}: "${options[delayedSamDetectorIndex].content}"`);
                    }
                    else {
                        log.info("SAM Detector still not found after delay");
                    }
                }, 100);
                // Debug: Let's also check what the Impact Pack extension actually does
                const samExtension = app.extensions.find((ext) => ext.name === 'Comfy.Impact.SAMEditor');
                if (samExtension) {
                    log.info("SAM Extension details:", {
                        name: samExtension.name,
                        hasBeforeRegisterNodeDef: !!samExtension.beforeRegisterNodeDef,
                        hasInit: !!samExtension.init
                    });
                }
                // Remove our old MaskEditor if it exists
                const maskEditorIndex = options.findIndex((option) => option && option.content === "Open in MaskEditor");
                if (maskEditorIndex !== -1) {
                    options.splice(maskEditorIndex, 1);
                }
                // Hook into "Open in SAM Detector" with delay since Impact Pack adds it asynchronously
                const hookSAMDetector = () => {
                    const samDetectorIndex = options.findIndex((option) => option && option.content && (option.content.includes("SAM Detector") ||
                        option.content === "Open in SAM Detector"));
                    if (samDetectorIndex !== -1) {
                        log.info(`Found SAM Detector menu item at index ${samDetectorIndex}: "${options[samDetectorIndex].content}"`);
                        const originalSamCallback = options[samDetectorIndex].callback;
                        options[samDetectorIndex].callback = async () => {
                            try {
                                log.info("Intercepted 'Open in SAM Detector' - automatically sending to clipspace and starting monitoring");
                                // Automatically send canvas to clipspace and start monitoring
                                if (self.canvasWidget && self.canvasWidget.canvas) {
                                    const canvas = self.canvasWidget; // canvasWidget IS the Canvas object
                                    // Get the flattened canvas as blob
                                    const blob = await canvas.canvasLayers.getFlattenedCanvasAsBlob();
                                    if (!blob) {
                                        throw new Error("Failed to generate canvas blob");
                                    }
                                    // Upload the image to ComfyUI's temp storage
                                    const formData = new FormData();
                                    const filename = `layerforge-sam-${self.id}-${Date.now()}.png`; // Unique filename with timestamp
                                    formData.append("image", blob, filename);
                                    formData.append("overwrite", "true");
                                    formData.append("type", "temp");
                                    const response = await api.fetchApi("/upload/image", {
                                        method: "POST",
                                        body: formData,
                                    });
                                    if (!response.ok) {
                                        throw new Error(`Failed to upload image: ${response.statusText}`);
                                    }
                                    const data = await response.json();
                                    log.debug('Image uploaded for SAM Detector:', data);
                                    // Create image element with proper URL
                                    const img = new Image();
                                    img.crossOrigin = "anonymous"; // Add CORS support
                                    // Wait for image to load before setting src
                                    const imageLoadPromise = new Promise((resolve, reject) => {
                                        img.onload = () => {
                                            log.debug("SAM Detector image loaded successfully", {
                                                width: img.width,
                                                height: img.height,
                                                src: img.src.substring(0, 100) + '...'
                                            });
                                            resolve(img);
                                        };
                                        img.onerror = (error) => {
                                            log.error("Failed to load SAM Detector image", error);
                                            reject(new Error("Failed to load uploaded image"));
                                        };
                                    });
                                    // Set src after setting up event handlers
                                    img.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
                                    // Wait for image to load
                                    await imageLoadPromise;
                                    // Set the image to the node for clipspace
                                    self.imgs = [img];
                                    self.clipspaceImg = img;
                                    // Copy to ComfyUI clipspace
                                    ComfyApp.copyToClipspace(self);
                                    // Start monitoring for SAM Detector results
                                    startSAMDetectorMonitoring(self);
                                    log.info("Canvas automatically sent to clipspace and monitoring started");
                                }
                                // Call the original SAM Detector callback
                                if (originalSamCallback) {
                                    await originalSamCallback();
                                }
                            }
                            catch (e) {
                                log.error("Error in SAM Detector hook:", e);
                                // Still try to call original callback
                                if (originalSamCallback) {
                                    await originalSamCallback();
                                }
                            }
                        };
                        return true; // Found and hooked
                    }
                    return false; // Not found
                };
                // Try to hook immediately
                if (!hookSAMDetector()) {
                    // If not found immediately, try again after Impact Pack adds it
                    setTimeout(() => {
                        if (hookSAMDetector()) {
                            log.info("Successfully hooked SAM Detector after delay");
                        }
                        else {
                            log.debug("SAM Detector menu item not found even after delay");
                        }
                    }, 150); // Slightly longer delay to ensure Impact Pack has added it
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
