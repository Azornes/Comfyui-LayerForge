// @ts-ignore
import { app } from "../../scripts/app.js";
// @ts-ignore
import { $el } from "../../scripts/ui.js";
import { addStylesheet, getUrl, loadTemplate } from "./utils/ResourceManager.js";
import { Canvas } from "./Canvas.js";
import { clearAllCanvasStates } from "./db.js";
import { ImageCache } from "./ImageCache.js";
import { createCanvas } from "./utils/CommonUtils.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { showErrorNotification, showSuccessNotification, showInfoNotification, showWarningNotification } from "./utils/NotificationUtils.js";
import { iconLoader, LAYERFORGE_TOOLS } from "./utils/IconLoader.js";
import { setupSAMDetectorHook } from "./SAMDetectorIntegration.js";
const log = createModuleLogger('Canvas_view');
async function createCanvasWidget(node, widget, app) {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput(node, canvas)
    });
    const imageCache = new ImageCache();
    /**
     * Helper function to update the icon of a switch component.
     * @param knobIconEl The HTML element for the switch's knob icon.
     * @param isChecked The current state of the switch (e.g., checkbox.checked).
     * @param iconToolTrue The icon tool name for the 'true' state.
     * @param iconToolFalse The icon tool name for the 'false' state.
     * @param fallbackTrue The text fallback for the 'true' state.
     * @param fallbackFalse The text fallback for the 'false' state.
     */
    const updateSwitchIcon = (knobIconEl, isChecked, iconToolTrue, iconToolFalse, fallbackTrue, fallbackFalse) => {
        if (!knobIconEl)
            return;
        const iconTool = isChecked ? iconToolTrue : iconToolFalse;
        const fallbackText = isChecked ? fallbackTrue : fallbackFalse;
        const icon = iconLoader.getIcon(iconTool);
        knobIconEl.innerHTML = ''; // Clear previous icon
        if (icon instanceof HTMLImageElement) {
            const clonedIcon = icon.cloneNode();
            clonedIcon.style.width = '20px';
            clonedIcon.style.height = '20px';
            knobIconEl.appendChild(clonedIcon);
        }
        else {
            knobIconEl.textContent = fallbackText;
        }
    };
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
                $el("button.painter-button.icon-button", {
                    id: `open-editor-btn-${node.id}`,
                    textContent: "⛶",
                    title: "Open in Editor",
                }),
                $el("button.painter-button.icon-button", {
                    textContent: "?",
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
                    (() => {
                        // Modern clipboard switch
                        // Initial state: checked = clipspace, unchecked = system
                        const isClipspace = canvas.canvasLayers.clipboardPreference === 'clipspace';
                        const switchId = `clipboard-switch-${node.id}`;
                        const switchEl = $el("label.clipboard-switch", { id: switchId }, [
                            $el("input", {
                                type: "checkbox",
                                checked: isClipspace,
                                onchange: (e) => {
                                    const checked = e.target.checked;
                                    canvas.canvasLayers.clipboardPreference = checked ? 'clipspace' : 'system';
                                    // For accessibility, update ARIA label
                                    switchEl.setAttribute('aria-label', checked ? "Clipboard: Clipspace" : "Clipboard: System");
                                    log.info(`Clipboard preference toggled to: ${canvas.canvasLayers.clipboardPreference}`);
                                }
                            }),
                            $el("span.switch-track"),
                            $el("span.switch-labels", {}, [
                                $el("span.text-clipspace", {}, ["Clipspace"]),
                                $el("span.text-system", {}, ["System"])
                            ]),
                            $el("span.switch-knob", {}, [
                                $el("span.switch-icon")
                            ])
                        ]);
                        // Helper function to get current tooltip content based on switch state
                        const getCurrentTooltipContent = () => {
                            const checked = switchEl.querySelector('input[type="checkbox"]').checked;
                            return checked ? clipspaceClipboardTooltip : systemClipboardTooltip;
                        };
                        // Helper function to update tooltip content if it's currently visible
                        const updateTooltipIfVisible = () => {
                            // Only update if tooltip is currently visible
                            if (helpTooltip.style.display === 'block') {
                                const tooltipContent = getCurrentTooltipContent();
                                showTooltip(switchEl, tooltipContent);
                            }
                        };
                        // Tooltip logic
                        switchEl.addEventListener("mouseenter", (e) => {
                            const tooltipContent = getCurrentTooltipContent();
                            showTooltip(switchEl, tooltipContent);
                        });
                        switchEl.addEventListener("mouseleave", hideTooltip);
                        // Dynamic icon update on toggle
                        const input = switchEl.querySelector('input[type="checkbox"]');
                        const knobIcon = switchEl.querySelector('.switch-knob .switch-icon');
                        input.addEventListener('change', () => {
                            updateSwitchIcon(knobIcon, input.checked, LAYERFORGE_TOOLS.CLIPSPACE, LAYERFORGE_TOOLS.SYSTEM_CLIPBOARD, "🗂️", "📋");
                            // Update tooltip content immediately after state change
                            updateTooltipIfVisible();
                        });
                        // Initial state
                        iconLoader.preloadToolIcons().then(() => {
                            updateSwitchIcon(knobIcon, isClipspace, LAYERFORGE_TOOLS.CLIPSPACE, LAYERFORGE_TOOLS.SYSTEM_CLIPBOARD, "🗂️", "📋");
                        });
                        return switchEl;
                    })()
                ]),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection", {
                    textContent: "Auto Adjust Output",
                    title: "Automatically adjust output area to fit selected layers",
                    onclick: () => {
                        const selectedLayers = canvas.canvasSelection.selectedLayers;
                        if (selectedLayers.length === 0) {
                            showWarningNotification("Please select one or more layers first");
                            return;
                        }
                        const success = canvas.canvasLayers.autoAdjustOutputToSelection();
                        if (success) {
                            const bounds = canvas.outputAreaBounds;
                            showSuccessNotification(`Output area adjusted to ${bounds.width}x${bounds.height}px`);
                        }
                        else {
                            showErrorNotification("Cannot calculate valid output area dimensions");
                        }
                    }
                }),
                $el("button.painter-button", {
                    textContent: "Output Area Size",
                    title: "Transform output area - drag handles to resize",
                    onclick: () => {
                        // Activate output area transform mode
                        canvas.canvasInteractions.activateOutputAreaTransform();
                        showInfoNotification("Click and drag the handles to resize the output area. Click anywhere else to exit.", 3000);
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
                (() => {
                    const switchEl = $el("label.clipboard-switch.requires-selection", {
                        id: `crop-transform-switch-${node.id}`,
                        title: "Toggle between Transform and Crop mode for selected layer(s)"
                    }, [
                        $el("input", {
                            type: "checkbox",
                            checked: false,
                            onchange: (e) => {
                                const isCropMode = e.target.checked;
                                const selectedLayers = canvas.canvasSelection.selectedLayers;
                                if (selectedLayers.length === 0)
                                    return;
                                selectedLayers.forEach((layer) => {
                                    layer.cropMode = isCropMode;
                                    if (isCropMode && !layer.cropBounds) {
                                        layer.cropBounds = { x: 0, y: 0, width: layer.originalWidth, height: layer.originalHeight };
                                    }
                                });
                                canvas.saveState();
                                canvas.render();
                            }
                        }),
                        $el("span.switch-track"),
                        $el("span.switch-labels", { style: { fontSize: "11px" } }, [
                            $el("span.text-clipspace", {}, ["Crop"]),
                            $el("span.text-system", {}, ["Transform"])
                        ]),
                        $el("span.switch-knob", {}, [
                            $el("span.switch-icon", { id: `crop-transform-icon-${node.id}` })
                        ])
                    ]);
                    const input = switchEl.querySelector('input[type="checkbox"]');
                    const knobIcon = switchEl.querySelector('.switch-icon');
                    input.addEventListener('change', () => {
                        updateSwitchIcon(knobIcon, input.checked, LAYERFORGE_TOOLS.CROP, LAYERFORGE_TOOLS.TRANSFORM, "✂️", "✥");
                    });
                    // Initial state
                    iconLoader.preloadToolIcons().then(() => {
                        updateSwitchIcon(knobIcon, false, // Initial state is transform
                        LAYERFORGE_TOOLS.CROP, LAYERFORGE_TOOLS.TRANSFORM, "✂️", "✥");
                    });
                    return switchEl;
                })(),
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
                        try {
                            // First check if model is available
                            const modelCheckResponse = await fetch("/matting/check-model");
                            const modelStatus = await modelCheckResponse.json();
                            if (!modelStatus.available) {
                                switch (modelStatus.reason) {
                                    case 'missing_dependency':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;
                                    case 'not_downloaded':
                                        showWarningNotification("The matting model needs to be downloaded first. This will happen automatically when you proceed (requires internet connection).", 5000);
                                        // Ask user if they want to proceed with download
                                        if (!confirm("The matting model needs to be downloaded (about 1GB). This is a one-time download. Do you want to proceed?")) {
                                            return;
                                        }
                                        showInfoNotification("Downloading matting model... This may take a few minutes.", 10000);
                                        break;
                                    case 'corrupted':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;
                                    case 'error':
                                        showErrorNotification(`Error checking model: ${modelStatus.message}`, 5000);
                                        return;
                                }
                            }
                            // Proceed with matting
                            const spinner = $el("div.matting-spinner");
                            button.appendChild(spinner);
                            button.classList.add('loading');
                            if (modelStatus.available) {
                                showInfoNotification("Starting background removal process...", 2000);
                            }
                            if (canvas.canvasSelection.selectedLayers.length !== 1) {
                                throw new Error("Please select exactly one image layer for matting.");
                            }
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
                                    // Handle specific error types
                                    if (result.error === "Network Connection Error") {
                                        showErrorNotification("Failed to download the matting model. Please check your internet connection and try again.", 8000);
                                        return;
                                    }
                                    else if (result.error === "Matting Model Error") {
                                        showErrorNotification(result.details || "Model loading error. Please check the console for details.", 8000);
                                        return;
                                    }
                                    else if (result.error === "Dependency Not Found") {
                                        showErrorNotification(result.details || "Missing required dependencies.", 8000);
                                        return;
                                    }
                                    errorMsg = `${result.error}: ${result.details || 'Check console'}`;
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
                            // Invalidate processed image cache when layer image changes (matting)
                            canvas.canvasLayers.invalidateProcessedImageCache(newLayer.id);
                            canvas.render();
                            canvas.saveState();
                            showSuccessNotification("Background removed successfully!");
                        }
                        catch (error) {
                            log.error("Matting error:", error);
                            const errorMessage = error.message || "An unknown error occurred.";
                            if (!errorMessage.includes("Network Connection Error") &&
                                !errorMessage.includes("Matting Model Error") &&
                                !errorMessage.includes("Dependency Not Found")) {
                                showErrorNotification(`Matting Failed: ${errorMessage}`);
                            }
                        }
                        finally {
                            button.classList.remove('loading');
                            const spinner = button.querySelector('.matting-spinner');
                            if (spinner && button.contains(spinner)) {
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
                $el("label.clipboard-switch.mask-switch", {
                    id: `toggle-mask-switch-${node.id}`,
                    style: { minWidth: "56px", maxWidth: "56px", width: "56px", paddingLeft: "0", paddingRight: "0" },
                    title: "Toggle mask overlay visibility on canvas (mask still affects output when disabled)"
                }, [
                    $el("input", {
                        type: "checkbox",
                        checked: canvas.maskTool.isOverlayVisible,
                        onchange: (e) => {
                            const checked = e.target.checked;
                            canvas.maskTool.isOverlayVisible = checked;
                            canvas.render();
                        }
                    }),
                    $el("span.switch-track"),
                    $el("span.switch-labels", { style: { fontSize: "11px" } }, [
                        $el("span.text-clipspace", { style: { paddingRight: "22px" } }, ["On"]),
                        $el("span.text-system", { style: { paddingLeft: "20px" } }, ["Off"])
                    ]),
                    $el("span.switch-knob", {}, [
                        (() => {
                            // Ikona maski (SVG lub obrazek)
                            const iconContainer = document.createElement('span');
                            iconContainer.className = 'switch-icon';
                            iconContainer.style.display = 'flex';
                            iconContainer.style.alignItems = 'center';
                            iconContainer.style.justifyContent = 'center';
                            iconContainer.style.width = '16px';
                            iconContainer.style.height = '16px';
                            // Pobierz ikonę maski z iconLoader
                            const icon = iconLoader.getIcon(LAYERFORGE_TOOLS.MASK);
                            if (icon instanceof HTMLImageElement) {
                                const img = icon.cloneNode();
                                img.style.width = "16px";
                                img.style.height = "16px";
                                // Ustaw filtr w zależności od stanu checkboxa
                                setTimeout(() => {
                                    const input = document.getElementById(`toggle-mask-switch-${node.id}`)?.querySelector('input[type="checkbox"]');
                                    const updateIconFilter = () => {
                                        if (input && img) {
                                            img.style.filter = input.checked
                                                ? "brightness(0) invert(1)"
                                                : "grayscale(1) brightness(0.7) opacity(0.6)";
                                        }
                                    };
                                    if (input) {
                                        input.addEventListener('change', updateIconFilter);
                                        updateIconFilter();
                                    }
                                }, 0);
                                iconContainer.appendChild(img);
                            }
                            else {
                                iconContainer.textContent = "M";
                                iconContainer.style.fontSize = "12px";
                                iconContainer.style.color = "#fff";
                            }
                            return iconContainer;
                        })()
                    ])
                ]),
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
                    $el("label", { for: "preview-opacity-slider", textContent: "Mask Opacity:" }),
                    $el("input", {
                        id: "preview-opacity-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => {
                            const value = e.target.value;
                            canvas.maskTool.setPreviewOpacity(parseFloat(value));
                            const valueEl = document.getElementById('preview-opacity-value');
                            if (valueEl)
                                valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.slider-value", { id: "preview-opacity-value" }, ["50%"])
                ]),
                $el("div.painter-slider-container.mask-control", { style: { display: 'none' } }, [
                    $el("label", { for: "brush-size-slider", textContent: "Size:" }),
                    $el("input", {
                        id: "brush-size-slider",
                        type: "range",
                        min: "1",
                        max: "200",
                        value: "20",
                        oninput: (e) => {
                            const value = e.target.value;
                            canvas.maskTool.setBrushSize(parseInt(value));
                            const valueEl = document.getElementById('brush-size-value');
                            if (valueEl)
                                valueEl.textContent = `${value}px`;
                        }
                    }),
                    $el("div.slider-value", { id: "brush-size-value" }, ["20px"])
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
                        oninput: (e) => {
                            const value = e.target.value;
                            canvas.maskTool.setBrushStrength(parseFloat(value));
                            const valueEl = document.getElementById('brush-strength-value');
                            if (valueEl)
                                valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.slider-value", { id: "brush-strength-value" }, ["50%"])
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
                        oninput: (e) => {
                            const value = e.target.value;
                            canvas.maskTool.setBrushHardness(parseFloat(value));
                            const valueEl = document.getElementById('brush-hardness-value');
                            if (valueEl)
                                valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.slider-value", { id: "brush-hardness-value" }, ["50%"])
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
                $el("button.painter-button.success", {
                    textContent: "Run GC",
                    title: "Run Garbage Collection to clean unused images",
                    onclick: async () => {
                        try {
                            const stats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats before cleanup:", stats);
                            await canvas.imageReferenceManager.manualGarbageCollection();
                            const newStats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats after cleanup:", newStats);
                            showSuccessNotification(`Garbage collection completed!\nTracked images: ${newStats.trackedImages}\nTotal references: ${newStats.totalReferences}\nOperations: ${canvas.imageReferenceManager.operationCount}/${canvas.imageReferenceManager.operationThreshold}`);
                        }
                        catch (e) {
                            log.error("Failed to run garbage collection:", e);
                            showErrorNotification("Error running garbage collection. Check the console for details.");
                        }
                    }
                }),
                $el("button.painter-button.danger", {
                    textContent: "Clear Cache",
                    title: "Clear all saved canvas states from browser storage",
                    onclick: async () => {
                        if (confirm("Are you sure you want to clear all saved canvas states? This action cannot be undone.")) {
                            try {
                                await clearAllCanvasStates();
                                showSuccessNotification("Canvas cache cleared successfully!");
                            }
                            catch (e) {
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
    const createMaskIcon = () => {
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
                const img = icon.cloneNode();
                img.style.cssText = `
                    width: 16px;
                    height: 16px;
                    filter: brightness(0) invert(1);
                `;
                iconContainer.appendChild(img);
            }
            else if (icon instanceof HTMLCanvasElement) {
                const { canvas, ctx } = createCanvas(16, 16);
                if (ctx) {
                    ctx.drawImage(icon, 0, 0, 16, 16);
                }
                iconContainer.appendChild(canvas);
            }
        }
        else {
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
        // --- Handle Standard Buttons ---
        controlPanel.querySelectorAll('.requires-selection').forEach((el) => {
            if (el.tagName === 'BUTTON') {
                if (el.textContent === 'Fuse') {
                    el.disabled = selectionCount < 2;
                }
                else {
                    el.disabled = !hasSelection;
                }
            }
        });
        const mattingBtn = controlPanel.querySelector('.matting-button');
        if (mattingBtn && !mattingBtn.classList.contains('loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
        // --- Handle Crop/Transform Switch ---
        const switchEl = controlPanel.querySelector(`#crop-transform-switch-${node.id}`);
        if (switchEl) {
            const input = switchEl.querySelector('input');
            const knobIcon = switchEl.querySelector('.switch-icon');
            const isDisabled = !hasSelection;
            switchEl.classList.toggle('disabled', isDisabled);
            input.disabled = isDisabled;
            if (!isDisabled) {
                const isCropMode = canvas.canvasSelection.selectedLayers[0].cropMode || false;
                if (input.checked !== isCropMode) {
                    input.checked = isCropMode;
                }
                // Update icon view
                updateSwitchIcon(knobIcon, isCropMode, LAYERFORGE_TOOLS.CROP, LAYERFORGE_TOOLS.TRANSFORM, "✂️", "✥");
            }
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
    // Add mask icon to toggle mask button after icons are loaded
    setTimeout(async () => {
        try {
            await iconLoader.preloadToolIcons();
            const toggleMaskBtn = controlPanel.querySelector(`#toggle-mask-btn-${node.id}`);
            if (toggleMaskBtn && !toggleMaskBtn.querySelector('.mask-icon-container')) {
                // Clear fallback text
                toggleMaskBtn.textContent = '';
                const maskIcon = createMaskIcon();
                toggleMaskBtn.appendChild(maskIcon);
                // Set initial state based on mask visibility
                if (canvas.maskTool.isOverlayVisible) {
                    toggleMaskBtn.classList.add('primary');
                    maskIcon.style.opacity = '1';
                }
                else {
                    toggleMaskBtn.classList.remove('primary');
                    maskIcon.style.opacity = '0.5';
                }
            }
        }
        catch (error) {
            log.warn('Failed to load mask icon:', error);
        }
    }, 200);
    // Debounce timer for updateOutput to prevent excessive updates
    let updateOutputTimer = null;
    const updateOutput = async (node, canvas) => {
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
                    }
                    else {
                        // For smaller images, use data URI as before
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = reader.result;
                            const img = new Image();
                            img.onload = () => {
                                node.imgs = [img];
                                log.debug(`Using data URI for small image (${(blob.size / 1024).toFixed(1)}KB): ${dataUrl.substring(0, 50)}...`);
                            };
                            img.src = dataUrl;
                        };
                        reader.readAsDataURL(blob);
                    }
                }
                else {
                    node.imgs = [];
                }
            }
            catch (error) {
                console.error("Error updating node preview:", error);
            }
        }, 250); // 150ms debounce delay
    };
    // Store previous temp filenames for cleanup (make it globally accessible)
    if (!window.layerForgeTempFileTracker) {
        window.layerForgeTempFileTracker = new Map();
    }
    const tempFileTracker = window.layerForgeTempFileTracker;
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
    canvas.canvasContainer = canvasContainer;
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
    // Watch the canvas container itself to detect size changes and fix canvas dimensions
    const canvasContainerResizeObserver = new ResizeObserver(() => {
        // Force re-read of canvas dimensions on next render
        canvas.render();
    });
    canvasContainerResizeObserver.observe(canvasContainer);
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
    if (node.addDOMWidget) {
        node.addDOMWidget("mainContainer", "widget", mainContainer);
    }
    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`);
    let backdrop = null;
    let originalParent = null;
    let isEditorOpen = false;
    let viewportAdjustment = { x: 0, y: 0 };
    /**
     * Adjusts the viewport when entering fullscreen mode.
     */
    const adjustViewportOnOpen = (originalRect) => {
        const fullscreenRect = canvasContainer.getBoundingClientRect();
        const widthDiff = fullscreenRect.width - originalRect.width;
        const heightDiff = fullscreenRect.height - originalRect.height;
        const adjustX = (widthDiff / 2) / canvas.viewport.zoom;
        const adjustY = (heightDiff / 2) / canvas.viewport.zoom;
        // Store the adjustment
        viewportAdjustment = { x: adjustX, y: adjustY };
        // Apply the adjustment
        canvas.viewport.x -= viewportAdjustment.x;
        canvas.viewport.y -= viewportAdjustment.y;
    };
    /**
     * Restores the viewport when exiting fullscreen mode.
     */
    const adjustViewportOnClose = () => {
        // Apply the stored adjustment in reverse
        canvas.viewport.x += viewportAdjustment.x;
        canvas.viewport.y += viewportAdjustment.y;
        // Reset adjustment
        viewportAdjustment = { x: 0, y: 0 };
    };
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
            adjustViewportOnClose();
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };
    // ESC key handler for closing fullscreen editor
    const handleEscKey = (e) => {
        if (e.key === 'Escape' && isEditorOpen) {
            e.preventDefault();
            e.stopPropagation();
            closeEditor();
        }
    };
    openEditorBtn.onclick = () => {
        if (isEditorOpen) {
            closeEditor();
            return;
        }
        const originalRect = canvasContainer.getBoundingClientRect();
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
        openEditorBtn.title = "Close Editor (ESC)";
        // Add ESC key listener when editor opens
        document.addEventListener('keydown', handleEscKey);
        setTimeout(() => {
            adjustViewportOnOpen(originalRect);
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };
    if (!window.canvasExecutionStates) {
        window.canvasExecutionStates = new Map();
    }
    // Store the entire widget object, not just the canvas
    node.canvasWidget = {
        canvas: canvas,
        panel: controlPanel
    };
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
            if (node.graph && node.graph.canvas && node.setDirtyCanvas) {
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
const canvasNodeInstances = new Map();
app.registerExtension({
    name: "Comfy.LayerForgeNode",
    init() {
        addStylesheet(getUrl('./css/canvas_view.css'));
        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (number, prompt) {
            log.info("Preparing to queue prompt...");
            if (canvasNodeInstances.size > 0) {
                log.info(`Found ${canvasNodeInstances.size} CanvasNode(s). Sending data via WebSocket...`);
                const sendPromises = [];
                for (const [nodeId, canvasWidget] of canvasNodeInstances.entries()) {
                    const node = app.graph.getNodeById(nodeId);
                    if (!node) {
                        log.warn(`Node ${nodeId} not found in graph, removing from instances map.`);
                        canvasNodeInstances.delete(nodeId);
                        continue;
                    }
                    // Skip bypassed nodes
                    if (node.mode === 4) {
                        log.debug(`Node ${nodeId} is bypassed, skipping data send.`);
                        continue;
                    }
                    if (canvasWidget.canvas && canvasWidget.canvas.canvasIO) {
                        log.debug(`Sending data for canvas node ${nodeId}`);
                        sendPromises.push(canvasWidget.canvas.canvasIO.sendDataViaWebSocket(nodeId));
                    }
                }
                try {
                    await Promise.all(sendPromises);
                    log.info("All canvas data has been sent and acknowledged by the server.");
                }
                catch (error) {
                    log.error("Failed to send canvas data for one or more nodes. Aborting prompt.", error);
                    showErrorNotification(`CanvasNode Error: ${error.message}`);
                    return;
                }
            }
            log.info("All pre-prompt tasks complete. Proceeding with original queuePrompt.");
            return originalQueuePrompt.apply(this, arguments);
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "LayerForgeNode") {
            // Map to track pending copy sources across node ID changes
            const pendingCopySources = new Map();
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
                // Store the canvas widget on the node
                this.canvasWidget = canvasWidget;
                // Check if this node has a pending copy source (from onConfigure)
                // Check both the current ID and -1 (temporary ID during paste)
                let sourceNodeId = pendingCopySources.get(this.id);
                if (!sourceNodeId) {
                    sourceNodeId = pendingCopySources.get(-1);
                    if (sourceNodeId) {
                        // Transfer from -1 to the real ID and clear -1
                        pendingCopySources.delete(-1);
                    }
                }
                if (sourceNodeId && sourceNodeId !== this.id) {
                    log.info(`Node ${this.id} will copy canvas state from node ${sourceNodeId}`);
                    // Clear the flag
                    pendingCopySources.delete(this.id);
                    // Copy the canvas state now that the widget is initialized
                    setTimeout(async () => {
                        try {
                            const { getCanvasState, setCanvasState } = await import('./db.js');
                            let sourceState = await getCanvasState(String(sourceNodeId));
                            // If source node doesn't exist (cross-workflow paste), try clipboard
                            if (!sourceState) {
                                log.debug(`No canvas state found for source node ${sourceNodeId}, checking clipboard`);
                                sourceState = await getCanvasState('__clipboard__');
                            }
                            if (!sourceState) {
                                log.debug(`No canvas state found in clipboard either`);
                                return;
                            }
                            await setCanvasState(String(this.id), sourceState);
                            await canvasWidget.canvas.loadInitialState();
                            log.info(`Canvas state copied successfully to node ${this.id}`);
                        }
                        catch (error) {
                            log.error(`Error copying canvas state:`, error);
                        }
                    }, 100);
                }
                // Check if there are already connected inputs
                setTimeout(() => {
                    if (this.inputs && this.inputs.length > 0) {
                        // Check if input_image (index 0) is connected
                        if (this.inputs[0] && this.inputs[0].link) {
                            log.info("Input image already connected on node creation, checking for data...");
                            if (canvasWidget.canvas && canvasWidget.canvas.canvasIO) {
                                canvasWidget.canvas.inputDataLoaded = false;
                                // Only allow images on init; mask should load only on mask connect or execution
                                canvasWidget.canvas.canvasIO.checkForInputData({ allowImage: true, allowMask: false, reason: "init_image_connected" });
                            }
                        }
                    }
                    if (this.setDirtyCanvas) {
                        this.setDirtyCanvas(true, true);
                    }
                }, 500);
            };
            // Add onConnectionsChange handler to detect when inputs are connected
            nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
                log.info(`onConnectionsChange called: type=${type}, index=${index}, connected=${connected}`, link_info);
                // Check if this is an input connection (type 1 = INPUT)
                if (type === 1) {
                    // Get the canvas widget - it might be in different places
                    const canvasWidget = this.canvasWidget;
                    const canvas = canvasWidget?.canvas || canvasWidget;
                    if (!canvas || !canvas.canvasIO) {
                        log.warn("Canvas not ready in onConnectionsChange, scheduling retry...");
                        // Retry multiple times with increasing delays
                        const retryDelays = [500, 1000, 2000];
                        let retryCount = 0;
                        const tryAgain = () => {
                            const retryCanvas = this.canvasWidget?.canvas || this.canvasWidget;
                            if (retryCanvas && retryCanvas.canvasIO) {
                                log.info("Canvas now ready, checking for input data...");
                                if (connected) {
                                    retryCanvas.inputDataLoaded = false;
                                    // Respect which input triggered the connection:
                                    const opts = (index === 1)
                                        ? { allowImage: false, allowMask: true, reason: "mask_connect" }
                                        : { allowImage: true, allowMask: false, reason: "image_connect" };
                                    retryCanvas.canvasIO.checkForInputData(opts);
                                }
                            }
                            else if (retryCount < retryDelays.length) {
                                log.warn(`Canvas still not ready, retry ${retryCount + 1}/${retryDelays.length}...`);
                                setTimeout(tryAgain, retryDelays[retryCount++]);
                            }
                            else {
                                log.error("Canvas failed to initialize after multiple retries");
                            }
                        };
                        setTimeout(tryAgain, retryDelays[retryCount++]);
                        return;
                    }
                    // Handle input_image connection (index 0)
                    if (index === 0) {
                        if (connected && link_info) {
                            log.info("Input image connected, marking for data check...");
                            // Reset the input data loaded flag to allow loading the new connection
                            canvas.inputDataLoaded = false;
                            // Also reset the last loaded image source and link ID to allow the new image
                            canvas.lastLoadedImageSrc = undefined;
                            canvas.lastLoadedLinkId = undefined;
                            // Mark that we have a pending input connection
                            canvas.hasPendingInputConnection = true;
                            // If mask input is not connected and a mask was auto-applied from input_mask before, clear it now
                            if (!(this.inputs && this.inputs[1] && this.inputs[1].link)) {
                                if (canvas.maskAppliedFromInput && canvas.maskTool) {
                                    canvas.maskTool.clear();
                                    canvas.render();
                                    canvas.maskAppliedFromInput = false;
                                    canvas.lastLoadedMaskLinkId = undefined;
                                    log.info("Cleared auto-applied mask because input_image connected without input_mask");
                                }
                            }
                            // Check for data immediately when connected
                            setTimeout(() => {
                                log.info("Checking for input data after connection...");
                                // Only load images here; masks should not auto-load on image connect
                                canvas.canvasIO.checkForInputData({ allowImage: true, allowMask: false, reason: "image_connect" });
                            }, 500);
                        }
                        else {
                            log.info("Input image disconnected");
                            canvas.hasPendingInputConnection = false;
                            // Reset when disconnected so a new connection can load
                            canvas.inputDataLoaded = false;
                            canvas.lastLoadedImageSrc = undefined;
                            canvas.lastLoadedLinkId = undefined;
                        }
                    }
                    // Handle input_mask connection (index 1)
                    if (index === 1) {
                        if (connected && link_info) {
                            log.info("Input mask connected");
                            // DON'T clear existing mask when connecting a new input
                            // Reset the loaded mask link ID to allow loading from the new connection
                            canvas.lastLoadedMaskLinkId = undefined;
                            // Mark that we have a pending mask connection
                            canvas.hasPendingMaskConnection = true;
                            // Check for data immediately when connected
                            setTimeout(() => {
                                log.info("Checking for input data after mask connection...");
                                // Only load mask here if it's immediately available from the connected node
                                // Don't load stale masks from backend storage
                                canvas.canvasIO.checkForInputData({ allowImage: false, allowMask: true, reason: "mask_connect" });
                            }, 500);
                        }
                        else {
                            log.info("Input mask disconnected");
                            canvas.hasPendingMaskConnection = false;
                            // If the current mask came from input_mask, clear it to avoid affecting images when mask is not connected
                            if (canvas.maskAppliedFromInput && canvas.maskTool) {
                                canvas.maskAppliedFromInput = false;
                                canvas.lastLoadedMaskLinkId = undefined;
                                log.info("Cleared auto-applied mask due to mask input disconnection");
                            }
                        }
                    }
                }
            };
            // Add onExecuted handler to check for input data after workflow execution
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                log.info("Node executed, checking for input data...");
                const canvas = this.canvasWidget?.canvas || this.canvasWidget;
                if (canvas && canvas.canvasIO) {
                    // Don't reset inputDataLoaded - just check for new data
                    // On execution we allow both image and mask to load
                    canvas.canvasIO.checkForInputData({ allowImage: true, allowMask: true, reason: "execution" });
                }
                // Call original if it exists
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }
            };
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                log.info(`Cleaning up canvas node ${this.id}`);
                // Clean up temp file tracker for this node (just remove from tracker)
                const nodeKey = `node-${this.id}`;
                const tempFileTracker = window.layerForgeTempFileTracker;
                if (tempFileTracker && tempFileTracker.has(nodeKey)) {
                    tempFileTracker.delete(nodeKey);
                    log.debug(`Removed temp file tracker for node ${this.id}`);
                }
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
            // Handle copy/paste - save canvas state when copying
            const originalSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function () {
                const data = originalSerialize ? originalSerialize.apply(this) : {};
                // Store a reference to the source node ID so we can copy layer data
                data.sourceNodeId = this.id;
                log.debug(`Serializing node ${this.id} for copy`);
                // Store canvas state in a clipboard entry for cross-workflow paste
                // This happens async but that's fine since paste happens later
                (async () => {
                    try {
                        const { getCanvasState, setCanvasState } = await import('./db.js');
                        const sourceState = await getCanvasState(String(this.id));
                        if (sourceState) {
                            // Store in a special "clipboard" entry
                            await setCanvasState('__clipboard__', sourceState);
                            log.debug(`Stored canvas state in clipboard for node ${this.id}`);
                        }
                    }
                    catch (error) {
                        log.error('Error storing canvas state to clipboard:', error);
                    }
                })();
                return data;
            };
            // Handle copy/paste - load canvas state from source node when pasting
            const originalConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = async function (data) {
                if (originalConfigure) {
                    originalConfigure.apply(this, [data]);
                }
                // Store the source node ID in the map (persists across node ID changes)
                // This will be picked up later in onAdded when the canvas widget is ready
                if (data.sourceNodeId && data.sourceNodeId !== this.id) {
                    const existingSource = pendingCopySources.get(this.id);
                    if (!existingSource) {
                        pendingCopySources.set(this.id, data.sourceNodeId);
                        log.debug(`Stored pending copy source: ${data.sourceNodeId} for node ${this.id}`);
                    }
                }
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
                // Hook into "Open in SAM Detector" using the new integration module
                setupSAMDetectorHook(self, options);
                const newOptions = [
                    {
                        content: "Open in MaskEditor",
                        callback: async () => {
                            try {
                                log.info("Opening LayerForge canvas in MaskEditor");
                                if (self.canvasWidget && self.canvasWidget.canvas) {
                                    await self.canvasWidget.canvas.startMaskEditor(null, true);
                                }
                                else {
                                    log.error("Canvas widget not available");
                                    showErrorNotification("Canvas not ready. Please try again.");
                                }
                            }
                            catch (e) {
                                log.error("Error opening MaskEditor:", e);
                                showErrorNotification(`Failed to open MaskEditor: ${e.message}`);
                            }
                        },
                    },
                    {
                        content: "Open Image",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasAsBlob();
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
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
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
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasAsBlob();
                                if (!blob)
                                    return;
                                const item = new ClipboardItem({ 'image/png': blob });
                                await navigator.clipboard.write([item]);
                                log.info("Image copied to clipboard.");
                            }
                            catch (e) {
                                log.error("Error copying image:", e);
                                showErrorNotification("Failed to copy image to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Copy Image with Mask Alpha",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
                                if (!blob)
                                    return;
                                const item = new ClipboardItem({ 'image/png': blob });
                                await navigator.clipboard.write([item]);
                                log.info("Image with mask alpha copied to clipboard.");
                            }
                            catch (e) {
                                log.error("Error copying image with mask:", e);
                                showErrorNotification("Failed to copy image with mask to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Save Image",
                        callback: async () => {
                            try {
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasAsBlob();
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
                                if (!self.canvasWidget || !self.canvasWidget.canvas)
                                    return;
                                const blob = await self.canvasWidget.canvas.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
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
