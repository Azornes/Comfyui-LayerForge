// @ts-ignore
import {app} from "../../scripts/app.js";
// @ts-ignore
import {api} from "../../scripts/api.js";
// @ts-ignore
import {ComfyApp} from "../../scripts/app.js";
// @ts-ignore
import {$el} from "../../scripts/ui.js";

import { addStylesheet, getUrl, loadTemplate } from "./utils/ResourceManager.js";

import {Canvas} from "./Canvas.js";
import {clearAllCanvasStates} from "./db.js";
import {ImageCache} from "./ImageCache.js";
import {generateUniqueFileName, createCanvas} from "./utils/CommonUtils.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {showErrorNotification, showSuccessNotification} from "./utils/NotificationUtils.js";
import { iconLoader, LAYERFORGE_TOOLS } from "./utils/IconLoader.js";
import { registerImageInClipspace, startSAMDetectorMonitoring, setupSAMDetectorHook } from "./SAMDetectorIntegration.js";
import type { ComfyNode, Layer, AddMode } from './types';

const log = createModuleLogger('Canvas_view');

interface CanvasWidget {
    canvas: Canvas;
    panel: HTMLDivElement;
    destroy?: () => void;
}

async function createCanvasWidget(node: ComfyNode, widget: any, app: ComfyApp): Promise<CanvasWidget> {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput(node, canvas)
    });
    const imageCache = new ImageCache();

    const helpTooltip = $el("div.painter-tooltip", {
        id: `painter-help-tooltip-${node.id}`,
    }) as HTMLDivElement;

    const [standardShortcuts, maskShortcuts, systemClipboardTooltip, clipspaceClipboardTooltip] = await Promise.all([
        loadTemplate('./templates/standard_shortcuts.html'),
        loadTemplate('./templates/mask_shortcuts.html'),
        loadTemplate('./templates/system_clipboard_tooltip.html'),
        loadTemplate('./templates/clipspace_clipboard_tooltip.html')
    ]);

    document.body.appendChild(helpTooltip);

    const showTooltip = (buttonElement: HTMLElement, content: string) => {
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

        if (left < 10) left = 10;
        if (top < 10) top = 10;

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
                    onmouseenter: (e: MouseEvent) => {
                        const content = canvas.maskTool.isActive ? maskShortcuts : standardShortcuts;
                        showTooltip(e.target as HTMLElement, content);
                    },
                    onmouseleave: hideTooltip
                }),
                $el("button.painter-button.primary", {
                    textContent: "Add Image",
                    title: "Add image from file",
                    onclick: () => {
                        const fitOnAddWidget = node.widgets.find((w) => w.name === "fit_on_add");
                        const addMode: AddMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            const target = e.target as HTMLInputElement;
                            if (!target.files) return;
                            for (const file of target.files) {
                                const reader = new FileReader();
                                reader.onload = (event) => {
                                    const img = new Image();
                                    img.onload = () => {
                                        canvas.addLayer(img, {}, addMode);
                                    };
                                    if (event.target?.result) {
                                        img.src = event.target.result as string;
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
                        const addMode: AddMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
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
                    onclick: (e: MouseEvent) => {
                        const button = e.target as HTMLButtonElement;
                        if (canvas.canvasLayers.clipboardPreference === 'system') {
                            canvas.canvasLayers.clipboardPreference = 'clipspace';
                            button.textContent = "📋 Clipspace";
                            button.title = "Toggle clipboard source: ComfyUI Clipspace";
                            button.style.backgroundColor = "#4a6cd4";
                        } else {
                            canvas.canvasLayers.clipboardPreference = 'system';
                            button.textContent = "📋 System";
                            button.title = "Toggle clipboard source: System Clipboard";
                            button.style.backgroundColor = "#4a4a4a";
                        }
                        log.info(`Clipboard preference toggled to: ${canvas.canvasLayers.clipboardPreference}`);
                    },
                    onmouseenter: (e: MouseEvent) => {
                        const currentPreference = canvas.canvasLayers.clipboardPreference;
                        const tooltipContent = currentPreference === 'system' ? systemClipboardTooltip : clipspaceClipboardTooltip;
                        showTooltip(e.target as HTMLElement, tooltipContent);
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

                        (document.getElementById('confirm-size') as HTMLButtonElement).onclick = () => {
                            const widthInput = document.getElementById('canvas-width') as HTMLInputElement;
                            const heightInput = document.getElementById('canvas-height') as HTMLInputElement;
                            const width = parseInt(widthInput.value) || canvas.width;
                            const height = parseInt(heightInput.value) || canvas.height;
                            canvas.updateOutputAreaSize(width, height);
                            document.body.removeChild(dialog);

                        };

                        (document.getElementById('cancel-size') as HTMLButtonElement).onclick = () => {
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
                    onclick: async (e: MouseEvent) => {
                        const button = (e.target as HTMLElement).closest('.matting-button') as HTMLButtonElement;
                        if (button.classList.contains('loading')) return;

                        const spinner = $el("div.matting-spinner") as HTMLDivElement;
                        button.appendChild(spinner);
                        button.classList.add('loading');

                        try {
                            if (canvas.canvasSelection.selectedLayers.length !== 1) throw new Error("Please select exactly one image layer for matting.");

                            const selectedLayer = canvas.canvasSelection.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.canvasLayers.getLayerImageData(selectedLayer);
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({image: imageData})
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
                            const newLayer = {...selectedLayer, image: mattedImage, flipH: false, flipV: false} as Layer;
                            delete (newLayer as any).imageId;
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.canvasSelection.updateSelection([newLayer]);
                            canvas.render();
                            canvas.saveState();
                        } catch (error: any) {
                            log.error("Matting error:", error);
                            const errorMessage = error.message || "An unknown error occurred.";
                            const errorDetails = error.stack || (error.details ? JSON.stringify(error.details, null, 2) : "No details available.");
                            showErrorDialog(errorMessage, errorDetails);
                        } finally {
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
            $el("div.painter-button-group", {id: "mask-controls"}, [
                $el("button.painter-button.primary", {
                    id: `toggle-mask-btn-${node.id}`,
                    textContent: "M", // Fallback text until icon loads
                    title: "Toggle mask overlay visibility",
                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: '32px',
                        maxWidth: '32px',
                        padding: '4px',
                        fontSize: '12px',
                        fontWeight: 'bold'
                    },
                    onclick: (e: MouseEvent) => {
                        const button = e.currentTarget as HTMLButtonElement;
                        canvas.maskTool.toggleOverlayVisibility();
                        canvas.render();
                        
                        const iconContainer = button.querySelector('.mask-icon-container') as HTMLElement;
                        if (iconContainer) {
                            if (canvas.maskTool.isOverlayVisible) {
                                button.classList.add('primary');
                                iconContainer.style.opacity = '1';
                            } else {
                                button.classList.remove('primary');
                                iconContainer.style.opacity = '0.5';
                            }
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
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn') as HTMLButtonElement;
                        const maskControls = controlPanel.querySelector('#mask-controls') as HTMLDivElement;

                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => (c as HTMLElement).style.display = 'none');
                        } else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => (c as HTMLElement).style.display = 'flex');
                        }

                        setTimeout(() => canvas.render(), 0);
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
                        oninput: (e: Event) => canvas.maskTool.setBrushSize(parseInt((e.target as HTMLInputElement).value))
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
                        oninput: (e: Event) => canvas.maskTool.setBrushStrength(parseFloat((e.target as HTMLInputElement).value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-hardness-slider", textContent: "Hardness:"}),
                    $el("input", {
                        id: "brush-hardness-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e: Event) => canvas.maskTool.setBrushHardness(parseFloat((e.target as HTMLInputElement).value))
                    })
                ]),
                $el("button.painter-button.mask-control", {
                    textContent: "Clear Mask",
                    title: "Clear the entire mask",
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
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Run GC",
                    title: "Run Garbage Collection to clean unused images",
                    style: {backgroundColor: "#4a7c59", borderColor: "#3a6c49"},
                    onclick: async () => {
                        try {
                            const stats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats before cleanup:", stats);

                            await canvas.imageReferenceManager.manualGarbageCollection();

                            const newStats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats after cleanup:", newStats);

                            showSuccessNotification(`Garbage collection completed!\nTracked images: ${newStats.trackedImages}\nTotal references: ${newStats.totalReferences}\nOperations: ${canvas.imageReferenceManager.operationCount}/${canvas.imageReferenceManager.operationThreshold}`);
                        } catch (e) {
                            log.error("Failed to run garbage collection:", e);
                            showErrorNotification("Error running garbage collection. Check the console for details.");
                        }
                    }
                }),
                $el("button.painter-button", {
                    textContent: "Clear Cache",
                    title: "Clear all saved canvas states from browser storage",
                    style: {backgroundColor: "#c54747", borderColor: "#a53737"},
                    onclick: async () => {
                        if (confirm("Are you sure you want to clear all saved canvas states? This action cannot be undone.")) {
                            try {
                                await clearAllCanvasStates();
                                showSuccessNotification("Canvas cache cleared successfully!");
                            } catch (e) {
                                log.error("Failed to clear canvas cache:", e);
                                showErrorNotification("Error clearing canvas cache. Check the console for details.");
                            }
                        }
                    }
                })
            ])
        ]),
        $el("div.painter-separator")
    ]);


    // Function to create mask icon
    const createMaskIcon = (): HTMLElement => {
        const iconContainer = document.createElement('div');
        iconContainer.className = 'mask-icon-container';
        iconContainer.style.cssText = `
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const icon = iconLoader.getIcon(LAYERFORGE_TOOLS.MASK);
        if (icon) {
            if (icon instanceof HTMLImageElement) {
                const img = icon.cloneNode() as HTMLImageElement;
                img.style.cssText = `
                    width: 16px;
                    height: 16px;
                    filter: brightness(0) invert(1);
                `;
                iconContainer.appendChild(img);
            } else if (icon instanceof HTMLCanvasElement) {
                const { canvas, ctx } = createCanvas(16, 16);
                if (ctx) {
                    ctx.drawImage(icon, 0, 0, 16, 16);
                }
                iconContainer.appendChild(canvas);
            }
        } else {
            // Fallback text
            iconContainer.textContent = 'M';
            iconContainer.style.fontSize = '12px';
            iconContainer.style.color = '#ffffff';
        }

        return iconContainer;
    };

    const updateButtonStates = () => {
        const selectionCount = canvas.canvasSelection.selectedLayers.length;
        const hasSelection = selectionCount > 0;
        controlPanel.querySelectorAll('.requires-selection').forEach((btn: any) => {
            const button = btn as HTMLButtonElement;
            if (button.textContent === 'Fuse') {
                button.disabled = selectionCount < 2;
            } else {
                button.disabled = !hasSelection;
            }
        });
        const mattingBtn = controlPanel.querySelector('.matting-button') as HTMLButtonElement;
        if (mattingBtn && !mattingBtn.classList.contains('loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
    };

    canvas.canvasSelection.onSelectionChange = updateButtonStates;

    const undoButton = controlPanel.querySelector(`#undo-button-${node.id}`) as HTMLButtonElement;
    const redoButton = controlPanel.querySelector(`#redo-button-${node.id}`) as HTMLButtonElement;

    canvas.onHistoryChange = ({ canUndo, canRedo }: { canUndo: boolean, canRedo: boolean }) => {
        if (undoButton) undoButton.disabled = !canUndo;
        if (redoButton) redoButton.disabled = !canRedo;
    };

    updateButtonStates();
    canvas.updateHistoryButtons();

    // Add mask icon to toggle mask button after icons are loaded
    setTimeout(async () => {
        try {
            await iconLoader.preloadToolIcons();
            const toggleMaskBtn = controlPanel.querySelector(`#toggle-mask-btn-${node.id}`) as HTMLButtonElement;
            if (toggleMaskBtn && !toggleMaskBtn.querySelector('.mask-icon-container')) {
                // Clear fallback text
                toggleMaskBtn.textContent = '';
                
                const maskIcon = createMaskIcon();
                toggleMaskBtn.appendChild(maskIcon);
                
                // Set initial state based on mask visibility
                if (canvas.maskTool.isOverlayVisible) {
                    toggleMaskBtn.classList.add('primary');
                    maskIcon.style.opacity = '1';
                } else {
                    toggleMaskBtn.classList.remove('primary');
                    maskIcon.style.opacity = '0.5';
                }
            }
        } catch (error) {
            log.warn('Failed to load mask icon:', error);
        }
    }, 200);

    // Debounce timer for updateOutput to prevent excessive updates
    let updateOutputTimer: NodeJS.Timeout | null = null;
    
    const updateOutput = async (node: ComfyNode, canvas: Canvas) => {
        // Check if preview is disabled - if so, skip updateOutput entirely


        const triggerWidget = node.widgets.find((w) => w.name === "trigger");
        if (triggerWidget) {
            triggerWidget.value = (triggerWidget.value + 1) % 99999999;
        }

        const showPreviewWidget = node.widgets.find((w) => w.name === "show_preview");
        if (showPreviewWidget && !showPreviewWidget.value) {
            log.debug("Preview disabled, skipping updateOutput");
            const PLACEHOLDER_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
            const placeholder = new Image();
            placeholder.src = PLACEHOLDER_IMAGE;
            node.imgs = [placeholder];
            return;
        }

        // Clear previous timer
        if (updateOutputTimer) {
            clearTimeout(updateOutputTimer);
        }

        // Debounce the update to prevent excessive processing during rapid changes
        updateOutputTimer = setTimeout(async () => {
            try {
                const blob = await canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
                if (blob) {
                    // For large images, use blob URL for better performance
                    if (blob.size > 2 * 1024 * 1024) { // 2MB threshold
                        const blobUrl = URL.createObjectURL(blob);
                        const img = new Image();
                        img.onload = () => {
                            node.imgs = [img];
                            log.debug(`Using blob URL for large image (${(blob.size / 1024 / 1024).toFixed(1)}MB): ${blobUrl.substring(0, 50)}...`);
                            // Clean up old blob URLs to prevent memory leaks
                            if (node.imgs.length > 1) {
                                const oldImg = node.imgs[0];
                                if (oldImg.src.startsWith('blob:')) {
                                    URL.revokeObjectURL(oldImg.src);
                                }
                            }
                        };
                        img.src = blobUrl;
                    } else {
                        // For smaller images, use data URI as before
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = reader.result as string;
                            const img = new Image();
                            img.onload = () => {
                                node.imgs = [img];
                                log.debug(`Using data URI for small image (${(blob.size / 1024).toFixed(1)}KB): ${dataUrl.substring(0, 50)}...`);
                            };
                            img.src = dataUrl;
                        };
                        reader.readAsDataURL(blob);
                    }
                } else {
                    node.imgs = [];
                }
            } catch (error) {
                console.error("Error updating node preview:", error);
            }
        }, 250); // 150ms debounce delay
    };

    // Store previous temp filenames for cleanup (make it globally accessible)
    if (!(window as any).layerForgeTempFileTracker) {
        (window as any).layerForgeTempFileTracker = new Map<string, string>();
    }
    const tempFileTracker = (window as any).layerForgeTempFileTracker;

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
    }, [canvas.canvas]) as HTMLDivElement;

    const layersPanelContainer = $el("div.painterLayersPanelContainer", {
        style: {
            position: "absolute",
            top: "60px",
            right: "10px",
            width: "250px",
            bottom: "10px",
            overflow: "hidden"
        }
    }, [layersPanel]) as HTMLDivElement;

    const resizeObserver = new ResizeObserver((entries) => {
        const controlsHeight = (entries[0].target as HTMLElement).offsetHeight;
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
    }, [controlPanel, canvasContainer, layersPanelContainer]) as HTMLDivElement;

    node.addDOMWidget("mainContainer", "widget", mainContainer);

    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`) as HTMLButtonElement;
    let backdrop: HTMLDivElement | null = null;
    let originalParent: HTMLElement | null = null;
    let isEditorOpen = false;

    const closeEditor = () => {
        if (originalParent && backdrop) {
            originalParent.appendChild(mainContainer);
            document.body.removeChild(backdrop);
        }

        isEditorOpen = false;
        openEditorBtn.textContent = "⛶";
        openEditorBtn.title = "Open in Editor";

        // Remove ESC key listener when editor closes
        document.removeEventListener('keydown', handleEscKey);

        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };

    // ESC key handler for closing fullscreen editor
    const handleEscKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && isEditorOpen) {
            e.preventDefault();
            e.stopPropagation();
            closeEditor();
            log.info("Fullscreen editor closed via ESC key");
        }
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

        backdrop = $el("div.painter-modal-backdrop") as HTMLDivElement;
        const modalContent = $el("div.painter-modal-content") as HTMLDivElement;

        modalContent.appendChild(mainContainer);
        backdrop.appendChild(modalContent);
        document.body.appendChild(backdrop);

        isEditorOpen = true;
        openEditorBtn.textContent = "X";
        openEditorBtn.title = "Close Editor (ESC)";

        // Add ESC key listener when editor opens
        document.addEventListener('keydown', handleEscKey);

        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };

    if (!(window as any).canvasExecutionStates) {
        (window as any).canvasExecutionStates = new Map<string, any>();
    }
    (node as any).canvasWidget = canvas;

    setTimeout(() => {
        canvas.loadInitialState();
        if (canvas.canvasLayersPanel) {
            canvas.canvasLayersPanel.renderLayers();
        }
    }, 100);

    const showPreviewWidget = node.widgets.find((w) => w.name === "show_preview");
    if (showPreviewWidget) {
        const originalCallback = showPreviewWidget.callback;

        showPreviewWidget.callback = function (value: boolean) {
            if (originalCallback) {
                originalCallback.call(this, value);
            }

            if (canvas && canvas.setPreviewVisibility) {
                canvas.setPreviewVisibility(value);
            }

            if ((node as any).graph && (node as any).graph.canvas) {
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

function showErrorDialog(message: string, details: string) {
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
                        .then(() => showSuccessNotification("Error details copied to clipboard!"))
                        .catch(err => showErrorNotification("Failed to copy details: " + err));
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

const canvasNodeInstances = new Map<number, CanvasWidget>();

app.registerExtension({
    name: "Comfy.CanvasNode",

    init() {
        addStylesheet(getUrl('./css/canvas_view.css'));

        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (this: ComfyApp, number: number, prompt: any) {
            log.info("Preparing to queue prompt...");

            if (canvasNodeInstances.size > 0) {
                log.info(`Found ${canvasNodeInstances.size} CanvasNode(s). Sending data via WebSocket...`);

                const sendPromises: Promise<any>[] = [];
                for (const [nodeId, canvasWidget] of canvasNodeInstances.entries()) {
                    if (app.graph.getNodeById(nodeId) && canvasWidget.canvas && canvasWidget.canvas.canvasIO) {
                        log.debug(`Sending data for canvas node ${nodeId}`);
                        sendPromises.push(canvasWidget.canvas.canvasIO.sendDataViaWebSocket(nodeId));
                    } else {
                        log.warn(`Node ${nodeId} not found in graph, removing from instances map.`);
                        canvasNodeInstances.delete(nodeId);
                    }
                }

                try {
                    await Promise.all(sendPromises);
                    log.info("All canvas data has been sent and acknowledged by the server.");
                } catch (error: any) {
                    log.error("Failed to send canvas data for one or more nodes. Aborting prompt.", error);
                    showErrorNotification(`CanvasNode Error: ${error.message}`);
                    return;
                }
            }

            log.info("All pre-prompt tasks complete. Proceeding with original queuePrompt.");
            return originalQueuePrompt.apply(this, arguments as any);
        };
    },

    async beforeRegisterNodeDef(nodeType: any, nodeData: any, app: ComfyApp) {
        if (nodeType.comfyClass === "CanvasNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function (this: ComfyNode) {
                log.debug("CanvasNode onNodeCreated: Base widget setup.");
                const r = onNodeCreated?.apply(this, arguments as any);
                this.size = [1150, 1000];
                return r;
            };

            nodeType.prototype.onAdded = async function (this: ComfyNode) {
                log.info(`CanvasNode onAdded, ID: ${this.id}`);
                log.debug(`Available widgets in onAdded:`, this.widgets.map((w) => w.name));

                if ((this as any).canvasWidget) {
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
                } else {
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
            nodeType.prototype.onRemoved = function (this: ComfyNode) {
                log.info(`Cleaning up canvas node ${this.id}`);

                // Clean up temp file tracker for this node (just remove from tracker)
                const nodeKey = `node-${this.id}`;
                const tempFileTracker = (window as any).layerForgeTempFileTracker;
                if (tempFileTracker && tempFileTracker.has(nodeKey)) {
                    tempFileTracker.delete(nodeKey);
                    log.debug(`Removed temp file tracker for node ${this.id}`);
                }

                canvasNodeInstances.delete(this.id);
                log.info(`Deregistered CanvasNode instance for ID: ${this.id}`);

                if ((window as any).canvasExecutionStates) {
                    (window as any).canvasExecutionStates.delete(this.id);
                }

                const tooltip = document.getElementById(`painter-help-tooltip-${this.id}`);
                if (tooltip) {
                    tooltip.remove();
                }
                const backdrop = document.querySelector('.painter-modal-backdrop');
                if (backdrop && (this as any).canvasWidget && backdrop.contains((this as any).canvasWidget.canvas.canvas)) {
                    document.body.removeChild(backdrop);
                }

                if ((this as any).canvasWidget && (this as any).canvasWidget.destroy) {
                    (this as any).canvasWidget.destroy();
                }

                return onRemoved?.apply(this, arguments as any);
            };

            const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (this: ComfyNode, _: any, options: any[]) {
                // FIRST: Call original to let other extensions add their options
                originalGetExtraMenuOptions?.apply(this, arguments as any);

                const self = this;

                // Debug: Log all menu options AFTER other extensions have added theirs
                log.info("Available menu options AFTER original call:", options.map((opt, idx) => ({
                    index: idx,
                    content: opt?.content,
                    hasCallback: !!opt?.callback
                })));

                // Debug: Check node data to see what Impact Pack sees
                const nodeData = (self as any).constructor.nodeData || {};
                log.info("Node data for Impact Pack check:", {
                    output: nodeData.output,
                    outputType: typeof nodeData.output,
                    isArray: Array.isArray(nodeData.output),
                    nodeType: (self as any).type,
                    comfyClass: (self as any).comfyClass
                });

                // Additional debug: Check if any option contains common Impact Pack keywords
                const impactOptions = options.filter((opt, idx) => {
                    if (!opt || !opt.content) return false;
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
                } else {
                    log.info("No Impact Pack-related options found in menu");
                }

                // Debug: Check if Impact Pack extension is loaded
                const impactExtensions = app.extensions.filter((ext: any) => 
                    ext.name && ext.name.toLowerCase().includes('impact')
                );
                log.info("Impact Pack extensions found:", impactExtensions.map((ext: any) => ext.name));

                // Debug: Check menu options again after a delay to see if Impact Pack adds options later
                setTimeout(() => {
                    log.info("Menu options after 100ms delay:", options.map((opt, idx) => ({
                        index: idx,
                        content: opt?.content,
                        hasCallback: !!opt?.callback
                    })));
                    
                    // Try to find SAM Detector again
                    const delayedSamDetectorIndex = options.findIndex((option) => 
                        option && option.content && (
                            option.content.includes("SAM Detector") ||
                            option.content.includes("SAM") ||
                            option.content.includes("Detector") ||
                            option.content.toLowerCase().includes("sam") ||
                            option.content.toLowerCase().includes("detector")
                        )
                    );
                    
                    if (delayedSamDetectorIndex !== -1) {
                        log.info(`Found SAM Detector after delay at index ${delayedSamDetectorIndex}: "${options[delayedSamDetectorIndex].content}"`);
                    } else {
                        log.info("SAM Detector still not found after delay");
                    }
                }, 100);

                // Debug: Let's also check what the Impact Pack extension actually does
                const samExtension = app.extensions.find((ext: any) => ext.name === 'Comfy.Impact.SAMEditor');
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

                // Hook into "Open in SAM Detector" using the new integration module
                setupSAMDetectorHook(self, options);

                const newOptions = [
                    {
                        content: "Open in MaskEditor",
                        callback: async () => {
                            try {
                                log.info("Opening LayerForge canvas in MaskEditor");
                                if ((self as any).canvasWidget && (self as any).canvasWidget.startMaskEditor) {
                                    await (self as any).canvasWidget.startMaskEditor(null, true);
                                } else {
                                    log.error("Canvas widget not available");
                                    showErrorNotification("Canvas not ready. Please try again.");
                                }
                            } catch (e: any) {
                                log.error("Error opening MaskEditor:", e);
                                showErrorNotification(`Failed to open MaskEditor: ${e.message}`);
                            }
                        },
                    },
                    {
                        content: "Open Image",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob) return;
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error opening image:", e);
                            }
                        },
                    },
                    {
                        content: "Open Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob) return;
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error opening image with mask:", e);
                            }
                        },
                    },
                    {
                        content: "Copy Image",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob) return;
                                const item = new ClipboardItem({'image/png': blob});
                                await navigator.clipboard.write([item]);
                                log.info("Image copied to clipboard.");
                            } catch (e) {
                                log.error("Error copying image:", e);
                                showErrorNotification("Failed to copy image to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Copy Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob) return;
                                const item = new ClipboardItem({'image/png': blob});
                                await navigator.clipboard.write([item]);
                                log.info("Image with mask alpha copied to clipboard.");
                            } catch (e) {
                                log.error("Error copying image with mask:", e);
                                showErrorNotification("Failed to copy image with mask to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Save Image",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasAsBlob();
                                if (!blob) return;
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
                    {
                        content: "Save Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!(self as any).canvasWidget) return;
                                const blob = await (self as any).canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob) return;
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output_with_mask.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error saving image with mask:", e);
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
