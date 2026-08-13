// @ts-ignore
import {app} from "../../scripts/app.js";
// @ts-ignore
import {api} from "../../scripts/api.js";
// @ts-ignore
import {ComfyApp} from "../../scripts/app.js";
// @ts-ignore
import {ChangeTracker} from "../../scripts/changeTracker.js";
// @ts-ignore
import {$el} from "../../scripts/ui.js";

import { addStylesheet, getUrl, loadTemplate } from "./utils/ResourceManager.js";

import {Canvas} from "./Canvas.js";
import {clearAllCanvasStates, getCanvasState, setCanvasState} from "./db.js";
import {generateUniqueFileName, createCanvas} from "./utils/CommonUtils.js";
import { loadImageFromBlob } from "./utils/ImageUtils.js";
import {createModuleLogger} from "./log_system/log_funcs.js";
import {showErrorNotification, showSuccessNotification, showInfoNotification, showWarningNotification} from "./utils/NotificationUtils.js";
import { iconLoader, LAYERFORGE_TOOLS } from "./utils/IconLoader.js";
import { exportCanvasImage, type CanvasExportAction } from "./utils/CanvasExportUtils.js";
import { getFlattenedCanvasBlob, type CanvasBlobVariant } from "./utils/CanvasBlobUtils.js";
import { loadPreviewImage } from "./utils/PreviewUtils.js";
import { getImageAddMode } from "./utils/CanvasInputUtils.js";
import { fetchMattingModelStatus } from "./utils/MattingUtils.js";
import { registerImageInClipspace, startSAMDetectorMonitoring, setupSAMDetectorHook } from "./SAMDetectorIntegration.js";
import type { ComfyNode, Layer, AddMode } from './types';

const log = createModuleLogger('Canvas_view');

type MattingMode = 'remove_background' | 'remove_foreground' | 'mask_only';

interface MattingSettings {
    modelPath: string;
    mode: MattingMode;
    threshold: number;
}

interface MattingModelOption {
    path: string;
    label: string;
    description?: string;
    url?: string;
    project_url?: string;
    source?: 'local' | 'remote';
    backend?: 'birefnet' | 'rmbg';
    downloaded?: boolean;
}

const MATTING_SETTINGS_STORAGE_KEY = 'layerforge.matting.settings';
const DEFAULT_MATTING_SETTINGS: MattingSettings = {
    modelPath: '',
    mode: 'remove_background',
    threshold: 0.5,
};

const isMattingMode = (value: unknown): value is MattingMode => {
    return value === 'remove_background' || value === 'remove_foreground' || value === 'mask_only';
};

const loadMattingSettings = (): MattingSettings => {
    try {
        const stored = JSON.parse(localStorage.getItem(MATTING_SETTINGS_STORAGE_KEY) || '{}') as Partial<MattingSettings>;
        const threshold = Number(stored.threshold);

        return {
            modelPath: typeof stored.modelPath === 'string' ? stored.modelPath : DEFAULT_MATTING_SETTINGS.modelPath,
            mode: isMattingMode(stored.mode) ? stored.mode : DEFAULT_MATTING_SETTINGS.mode,
            threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_MATTING_SETTINGS.threshold,
        };
    } catch (error) {
        log.warn('Unable to load Matting settings:', error);
        return { ...DEFAULT_MATTING_SETTINGS };
    }
};

const saveMattingSettings = (settings: MattingSettings): void => {
    try {
        localStorage.setItem(MATTING_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
        log.warn('Unable to save Matting settings:', error);
    }
};

const getMattingModeLabel = (mode: MattingMode): string => {
    switch (mode) {
        case 'remove_foreground':
            return 'Remove detected foreground / keep background';
        case 'mask_only':
            return 'Apply generated mask to Draw Mask';
        default:
            return 'Remove background / keep foreground';
    }
};

const LAYERFORGE_CHANGE_TRACKER_PATCH_FLAG = '__layerForgeUndoRedoPatched';
const LAYERFORGE_SHORTCUT_ACTIVE_ATTR = 'data-layerforge-shortcuts-active';

const isLayerForgeEditableElement = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    return !!target.closest('.lf-painter-main-container input, .lf-painter-main-container textarea, .lf-painter-main-container select, .lf-painter-main-container [contenteditable="true"]');
};

const isLayerForgeShortcutContextElement = (target: EventTarget | null): boolean => {
    return target instanceof HTMLElement && !!target.closest('.lf-painter-main-container');
};

const isLayerForgeShortcutContextActive = (event?: KeyboardEvent): boolean => {
    if (event && isLayerForgeShortcutContextElement(event.target)) {
        return true;
    }

    if (isLayerForgeShortcutContextElement(document.activeElement)) {
        return true;
    }

    return !!document.querySelector(`.lf-painter-main-container[${LAYERFORGE_SHORTCUT_ACTIVE_ATTR}="true"]`);
};

const isLayerForgeEditableFocused = (): boolean => {
    return isLayerForgeEditableElement(document.activeElement);
};

const patchLayerForgeChangeTrackerUndoRedo = (): void => {
    const prototype = ChangeTracker?.prototype as any;
    if (!prototype || prototype[LAYERFORGE_CHANGE_TRACKER_PATCH_FLAG] || typeof prototype.undoRedo !== 'function') {
        return;
    }

    const originalUndoRedo = prototype.undoRedo;
    prototype.undoRedo = async function (event: KeyboardEvent) {
        if (isLayerForgeShortcutContextActive(event)) {
            return false;
        }

        return await originalUndoRedo.call(this, event);
    };

    Object.defineProperty(prototype, LAYERFORGE_CHANGE_TRACKER_PATCH_FLAG, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });
};

patchLayerForgeChangeTrackerUndoRedo();

interface CanvasWidget {
    canvas: Canvas;
    panel: HTMLDivElement;
    destroy?: () => void;
}

async function createCanvasWidget(node: ComfyNode, widget: any, app: ComfyApp): Promise<CanvasWidget> {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput(node, canvas)
    });

    /**
     * Helper function to update the icon of a switch component.
     * @param knobIconEl The HTML element for the switch's knob icon.
     * @param isChecked The current state of the switch (e.g., checkbox.checked).
     * @param iconToolTrue The icon tool name for the 'true' state.
     * @param iconToolFalse The icon tool name for the 'false' state.
     * @param fallbackTrue The text fallback for the 'true' state.
     * @param fallbackFalse The text fallback for the 'false' state.
     */
    const updateSwitchIcon = (
        knobIconEl: HTMLElement, 
        isChecked: boolean, 
        iconToolTrue: string, 
        iconToolFalse: string, 
        fallbackTrue: string, 
        fallbackFalse: string
    ) => {
        if (!knobIconEl) return;
        
        const iconTool = isChecked ? iconToolTrue : iconToolFalse;
        const fallbackText = isChecked ? fallbackTrue : fallbackFalse;
        const icon = iconLoader.getIcon(iconTool);

        knobIconEl.innerHTML = ''; // Clear previous icon
        if (icon instanceof HTMLImageElement) {
            const clonedIcon = icon.cloneNode() as HTMLImageElement;
            clonedIcon.style.width = '20px';
            clonedIcon.style.height = '20px';
            knobIconEl.appendChild(clonedIcon);
        } else {
            knobIconEl.textContent = fallbackText;
        }
    };

    const helpTooltip = $el("div.lf-painter-tooltip", {
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

    let mattingSettingsBackdrop: HTMLDivElement | null = null;
    let mattingSettingsEscapeHandler: ((event: KeyboardEvent) => void) | null = null;

    const closeMattingSettings = () => {
        if (mattingSettingsEscapeHandler) {
            document.removeEventListener('keydown', mattingSettingsEscapeHandler);
            mattingSettingsEscapeHandler = null;
        }

        mattingSettingsBackdrop?.remove();
        mattingSettingsBackdrop = null;
    };

    const openMattingSettings = async (): Promise<void> => {
        if (mattingSettingsBackdrop) return;

        const settings = loadMattingSettings();
        let modelOptions: MattingModelOption[] = [];
        let modelStatusMessage = 'Model options are loaded from ComfyUI background-removal storage.';

        try {
            const { ok, data: status } = await fetchMattingModelStatus<MattingModelOption>();
            if (ok) {
                if (Array.isArray(status.models)) {
                    modelOptions = status.models.filter((option) => (
                        option && typeof option.path === 'string' && typeof option.label === 'string'
                    ));
                }
            } else {
                modelStatusMessage = 'Unable to read installed model options. Automatic selection remains available.';
            }
        } catch (error) {
            log.warn('Unable to load Matting model options:', error);
            modelStatusMessage = 'Unable to read installed model options. Automatic selection remains available.';
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'lf-matting-settings-backdrop';
        backdrop.setAttribute('role', 'presentation');

        const dialog = document.createElement('div');
        dialog.className = 'lf-matting-settings-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'lf-matting-settings-title');

        const header = document.createElement('div');
        header.className = 'lf-matting-settings-header';

        const title = document.createElement('h2');
        title.id = 'lf-matting-settings-title';
        title.textContent = 'Matting Settings';

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'lf-matting-settings-close';
        closeButton.textContent = '×';
        closeButton.title = 'Close Matting settings';
        closeButton.setAttribute('aria-label', 'Close Matting settings');
        closeButton.onclick = closeMattingSettings;

        header.append(title, closeButton);

        const body = document.createElement('div');
        body.className = 'lf-matting-settings-body';

        const createRow = (labelText: string, control: HTMLElement, description?: string): HTMLLabelElement => {
            const row = document.createElement('label');
            row.className = 'lf-matting-settings-row';

            const label = document.createElement('span');
            label.className = 'lf-matting-settings-label';
            label.textContent = labelText;
            row.appendChild(label);
            row.appendChild(control);

            if (description) {
                const hint = document.createElement('small');
                hint.className = 'lf-matting-settings-hint';
                hint.textContent = description;
                row.appendChild(hint);
            }

            return row;
        };

        const modelSelect = document.createElement('select');
        modelSelect.className = 'lf-matting-settings-select';
        modelSelect.appendChild(new Option('Automatic (recommended)', 'auto'));
        const localModelOptions = modelOptions.filter((option) => option.source !== 'remote');
        const remoteModelOptions = modelOptions.filter((option) => option.source === 'remote');

        if (localModelOptions.length > 0) {
            const localGroup = document.createElement('optgroup');
            localGroup.label = 'Installed locally';
            localModelOptions.forEach((option) => {
                localGroup.appendChild(new Option(option.label, option.path));
            });
            modelSelect.appendChild(localGroup);
        }

        if (remoteModelOptions.length > 0) {
            const remoteGroup = document.createElement('optgroup');
            remoteGroup.label = 'Download on first use';
            remoteModelOptions.forEach((option) => {
                const suffix = option.downloaded ? ' (downloaded)' : '';
                const remoteOption = new Option(`${option.label}${suffix}`, option.path);
                if (option.description) remoteOption.title = option.description;
                remoteGroup.appendChild(remoteOption);
            });
            modelSelect.appendChild(remoteGroup);
        }

        const selectedModel = settings.modelPath && modelOptions.some((option) => option.path === settings.modelPath)
            ? settings.modelPath
            : 'auto';
        modelSelect.value = selectedModel;

        const modelDetails = document.createElement('div');
        modelDetails.className = 'lf-matting-model-details';

        const modelDescription = document.createElement('p');
        modelDescription.className = 'lf-matting-model-description';

        const modelLinks = document.createElement('div');
        modelLinks.className = 'lf-matting-model-links';

        const createModelLink = (label: string, url: string): HTMLAnchorElement => {
            const link = document.createElement('a');
            link.className = 'lf-matting-model-link';
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = label;
            return link;
        };

        const updateModelDetails = (): void => {
            modelLinks.replaceChildren();
            const selectedOption = modelOptions.find((option) => option.path === modelSelect.value);

            if (modelSelect.value === 'auto') {
                modelDescription.textContent = 'LayerForge selects the best compatible installed checkpoint. If none is available, the standard General model is downloaded.';
                modelDetails.hidden = false;
                return;
            }

            if (!selectedOption) {
                modelDescription.textContent = 'The selected checkpoint is not currently available.';
                modelDetails.hidden = false;
                return;
            }

            modelDescription.textContent = selectedOption.description || (
                selectedOption.backend === 'rmbg'
                    ? 'Local BRIA RMBG 2.0 model loaded through Transformers.'
                    : 'Installed checkpoint validated by ComfyUI\'s native BiRefNet loader.'
            );
            if (selectedOption.url) {
                modelLinks.appendChild(createModelLink('Model page', selectedOption.url));
            }
            if (selectedOption.project_url) {
                modelLinks.appendChild(createModelLink(
                    selectedOption.backend === 'rmbg' ? 'BRIA project' : 'BiRefNet project',
                    selectedOption.project_url,
                ));
            }
            modelDetails.hidden = false;
        };

        modelSelect.onchange = updateModelDetails;
        modelDetails.append(modelDescription, modelLinks);
        updateModelDetails();

        const modeSelect = document.createElement('select');
        modeSelect.className = 'lf-matting-settings-select';
        (['remove_background', 'remove_foreground', 'mask_only'] as MattingMode[]).forEach((mode) => {
            modeSelect.appendChild(new Option(getMattingModeLabel(mode), mode));
        });
        modeSelect.value = settings.mode;

        const thresholdContainer = document.createElement('div');
        thresholdContainer.className = 'lf-matting-settings-threshold';

        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'range';
        thresholdInput.min = '0';
        thresholdInput.max = '1';
        thresholdInput.step = '0.01';
        thresholdInput.value = String(settings.threshold);

        const thresholdValue = document.createElement('output');
        thresholdValue.className = 'lf-matting-settings-threshold-value';
        thresholdValue.value = settings.threshold.toFixed(2);
        thresholdValue.textContent = settings.threshold.toFixed(2);

        thresholdInput.oninput = () => {
            const value = Number(thresholdInput.value);
            thresholdValue.value = value.toFixed(2);
            thresholdValue.textContent = value.toFixed(2);
        };

        thresholdContainer.append(thresholdInput, thresholdValue);

        const modelStatus = document.createElement('p');
        modelStatus.className = 'lf-matting-settings-status';
        const localCount = localModelOptions.length;
        const remoteCount = remoteModelOptions.length;
        const modelCounts = [
            localCount > 0 ? `${localCount} installed local model(s)` : 'No compatible local model installed',
            remoteCount > 0 ? `${remoteCount} official model(s) available for download` : '',
        ].filter(Boolean).join('; ');
        modelStatus.textContent = `${modelCounts}. ${modelStatusMessage}`;

        body.append(
            createRow('Model', modelSelect, 'Choose a local BiRefNet checkpoint or BRIA RMBG 2.0, or download an official model on first use.'),
            modelDetails,
            createRow('Processing mode', modeSelect, 'The selected mode controls what the Matting button creates from the detected mask.'),
            createRow('Mask threshold', thresholdContainer, 'Set to 0 for a soft alpha mask; higher values create a harder cutout.'),
            modelStatus,
        );

        const actions = document.createElement('div');
        actions.className = 'lf-matting-settings-actions';

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'lf-matting-settings-secondary';
        resetButton.textContent = 'Reset';
        resetButton.onclick = () => {
            modelSelect.value = 'auto';
            modeSelect.value = DEFAULT_MATTING_SETTINGS.mode;
            thresholdInput.value = String(DEFAULT_MATTING_SETTINGS.threshold);
            thresholdValue.value = DEFAULT_MATTING_SETTINGS.threshold.toFixed(2);
            thresholdValue.textContent = DEFAULT_MATTING_SETTINGS.threshold.toFixed(2);
        };

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'lf-matting-settings-primary';
        saveButton.textContent = 'Save settings';
        saveButton.onclick = () => {
            saveMattingSettings({
                modelPath: modelSelect.value === 'auto' ? '' : modelSelect.value,
                mode: modeSelect.value as MattingMode,
                threshold: Number(thresholdInput.value),
            });
            closeMattingSettings();
            showInfoNotification('Matting settings saved.', 2000);
        };

        actions.append(resetButton, saveButton);
        dialog.append(header, body, actions);
        backdrop.appendChild(dialog);

        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) closeMattingSettings();
        });

        mattingSettingsEscapeHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeMattingSettings();
            }
        };
        document.addEventListener('keydown', mattingSettingsEscapeHandler);

        mattingSettingsBackdrop = backdrop;
        document.body.appendChild(backdrop);
        closeButton.focus();
    };

    const controlPanel = $el("div.painterControlPanel", {}, [
        $el("div.controls.lf-painter-controls", {
            style: {
                position: "absolute",
                top: "0",
                left: "0",
                right: "0",
                zIndex: "10",
            },
        }, [
            $el("div.lf-painter-button-group", {}, [
                $el("button.lf-painter-button.lf-icon-button", {
                    id: `open-editor-btn-${node.id}`,
                    textContent: "⛶",
                    title: "Open in Editor",
                }),
                $el("button.lf-painter-button.lf-icon-button", {
                    textContent: "?",
                    onmouseenter: (e: MouseEvent) => {
                        const content = canvas.maskTool.isActive ? maskShortcuts : standardShortcuts;
                        showTooltip(e.target as HTMLElement, content);
                    },
                    onmouseleave: hideTooltip
                }),
                $el("button.lf-painter-button.lf-primary", {
                    textContent: "Add Image",
                    title: "Add image from file",
                    onclick: () => {
                        const addMode: AddMode = getImageAddMode(node.widgets);
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            const target = e.target as HTMLInputElement;
                            if (!target.files) return;
                            for (const file of target.files) {
                                void loadImageFromBlob(file).then(img => {
                                    canvas.addLayer(img, {}, addMode);
                                }).catch(() => undefined);
                            }
                        };
                        input.click();
                    }
                }),
                $el("button.lf-painter-button.lf-primary", {
                    textContent: "Import Input",
                    title: "Import image from another node",
                    onclick: () => canvas.canvasIO.importLatestImage()
                }),
                $el("div.lf-painter-clipboard-group", {}, [
                    $el("button.lf-painter-button.lf-primary", {
                    textContent: "Paste Image",
                    title: "Paste image from clipboard",
                    onclick: () => {
                        const addMode: AddMode = getImageAddMode(node.widgets);
                        canvas.canvasLayers.handlePaste(addMode);
                    }
                }),
(() => {
    // Modern clipboard switch
    // Initial state: checked = clipspace, unchecked = system
    const isClipspace = canvas.canvasLayers.clipboardPreference === 'clipspace';
    const switchId = `clipboard-switch-${node.id}`;
    const switchEl = $el("label.lf-clipboard-switch", { id: switchId }, [
        $el("input", {
            type: "checkbox",
            checked: isClipspace,
            onchange: (e: Event) => {
                const checked = (e.target as HTMLInputElement).checked;
                canvas.canvasLayers.clipboardPreference = checked ? 'clipspace' : 'system';
                // For accessibility, update ARIA label
                switchEl.setAttribute('aria-label', checked ? "Clipboard: Clipspace" : "Clipboard: System");
                log.info(`Clipboard preference toggled to: ${canvas.canvasLayers.clipboardPreference}`);
            }
        }),
        $el("span.lf-switch-track"),
        $el("span.lf-switch-labels", {}, [
            $el("span.lf-text-clipspace", {}, ["Clipspace"]),
            $el("span.lf-text-system", {}, ["System"])
        ]),
        $el("span.lf-switch-knob", {}, [
            $el("span.lf-switch-icon")
        ])
    ]);

    // Helper function to get current tooltip content based on switch state
    const getCurrentTooltipContent = () => {
        const checked = (switchEl.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
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
    switchEl.addEventListener("mouseenter", (e: MouseEvent) => {
        const tooltipContent = getCurrentTooltipContent();
        showTooltip(switchEl, tooltipContent);
    });
    switchEl.addEventListener("mouseleave", hideTooltip);

    // Dynamic icon update on toggle
    const input = switchEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const knobIcon = switchEl.querySelector('.lf-switch-knob .lf-switch-icon') as HTMLElement;
    
    input.addEventListener('change', () => {
        updateSwitchIcon(
            knobIcon,
            input.checked,
            LAYERFORGE_TOOLS.CLIPSPACE,
            LAYERFORGE_TOOLS.SYSTEM_CLIPBOARD,
            "🗂️",
            "📋"
        );
        
        // Update tooltip content immediately after state change
        updateTooltipIfVisible();
    });
    
    // Initial state
    iconLoader.preloadToolIcons().then(() => {
        updateSwitchIcon(
            knobIcon,
            isClipspace,
            LAYERFORGE_TOOLS.CLIPSPACE,
            LAYERFORGE_TOOLS.SYSTEM_CLIPBOARD,
            "🗂️",
            "📋"
        );
    });

    return switchEl;
})()
            ]),
            ]),

            $el("div.lf-painter-separator"),
            $el("div.lf-painter-button-group", {}, [
                $el("button.lf-painter-button.requires-selection", {
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
                        } else {
                            showErrorNotification("Cannot calculate valid output area dimensions");
                        }
                    }
                }),
                $el("button.lf-painter-button", {
                    textContent: "Output Area Size",
                    title: "Transform output area - drag handles to resize",
                    onclick: () => {
                        // Activate output area transform mode
                        canvas.canvasInteractions.activateOutputAreaTransform();
                        showInfoNotification("Click and drag the handles to resize the output area. Click anywhere else to exit.", 3000);
                    }
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Remove Layer",
                    title: "Remove selected layer(s)",
                    onclick: () => canvas.removeSelectedLayers()
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Layer Up",
                    title: "Move selected layer(s) up",
                    onclick: () => canvas.canvasLayers.moveLayerUp()
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Layer Down",
                    title: "Move selected layer(s) down",
                    onclick: () => canvas.canvasLayers.moveLayerDown()
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Fuse",
                    title: "Flatten and merge selected layers into a single layer",
                    onclick: () => canvas.canvasLayers.fuseLayers()
                }),
            ]),

            $el("div.lf-painter-separator"),
            $el("div.lf-painter-button-group", {}, [
                (() => {
                    const switchEl = $el("label.lf-clipboard-switch.requires-selection", { 
                        id: `crop-transform-switch-${node.id}`,
                        title: "Toggle between Transform and Crop mode for selected layer(s)"
                    }, [
                        $el("input", {
                            type: "checkbox",
                            checked: false,
                            onchange: (e: Event) => {
                                const isCropMode = (e.target as HTMLInputElement).checked;
                                const selectedLayers = canvas.canvasSelection.selectedLayers;
                                if (selectedLayers.length === 0) return;
                                
                                selectedLayers.forEach((layer: Layer) => {
                                    layer.cropMode = isCropMode;
                                    if (isCropMode && !layer.cropBounds) {
                                        layer.cropBounds = { x: 0, y: 0, width: layer.originalWidth, height: layer.originalHeight };
                                    }
                                });
                                
                                canvas.saveState();
                                canvas.render();
                            }
                        }),
                        $el("span.lf-switch-track"),
                        $el("span.lf-switch-labels", { style: { fontSize: "11px" } }, [
                            $el("span.lf-text-clipspace", {}, ["Crop"]),
                            $el("span.lf-text-system", {}, ["Transform"])
                        ]),
                        $el("span.lf-switch-knob", {}, [
                            $el("span.lf-switch-icon", { id: `crop-transform-icon-${node.id}`})
                        ])
                    ]);

                    const input = switchEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
                    const knobIcon = switchEl.querySelector('.lf-switch-icon') as HTMLElement;

                    input.addEventListener('change', () => {
                        updateSwitchIcon(
                            knobIcon,
                            input.checked,
                            LAYERFORGE_TOOLS.CROP,
                            LAYERFORGE_TOOLS.TRANSFORM,
                            "✂️",
                            "✥"
                        );
                    });
                    
                    // Initial state
                    iconLoader.preloadToolIcons().then(() => {
                        updateSwitchIcon(
                            knobIcon,
                            false, // Initial state is transform
                            LAYERFORGE_TOOLS.CROP,
                            LAYERFORGE_TOOLS.TRANSFORM,
                            "✂️",
                            "✥"
                        );
                    });

                    return switchEl;
                })(),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Rotate +90°",
                    title: "Rotate selected layer(s) by +90 degrees",
                    onclick: () => canvas.canvasLayers.rotateLayer(90)
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Scale +5%",
                    title: "Increase size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(1.05)
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Scale -5%",
                    title: "Decrease size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(0.95)
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Mirror H",
                    title: "Mirror selected layer(s) horizontally",
                    onclick: () => canvas.canvasLayers.mirrorHorizontal()
                }),
                $el("button.lf-painter-button.requires-selection", {
                    textContent: "Mirror V",
                    title: "Mirror selected layer(s) vertically",
                    onclick: () => canvas.canvasLayers.mirrorVertical()
                }),
            ]),

            $el("div.lf-painter-separator"),
            $el("div.lf-painter-button-group", {}, [
                $el("button.lf-painter-button.requires-selection.lf-matting-button", {
                    textContent: "Matting",
                    title: "Perform background removal on the selected layer",
                    onclick: async (e: MouseEvent) => {
                        const button = (e.target as HTMLElement).closest('.lf-matting-button') as HTMLButtonElement;
                        if (button.classList.contains('lf-loading')) return;

                        const mattingSettings = loadMattingSettings();

                        try {
                            // First check if model is available
                            const { data: modelStatus } = await fetchMattingModelStatus(mattingSettings.modelPath);
                            
                            if (!modelStatus.available) {
                                switch (modelStatus.reason) {
                                    case 'missing_dependency':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;

                                    case 'unsupported_comfyui':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;
                                    
                                    case 'not_downloaded':
                                        showWarningNotification(modelStatus.message || "The selected background-removal model will be downloaded automatically.", 7000);
                                        
                                        // Ask user if they want to proceed with download
                                        if (!confirm(`${modelStatus.message || "The selected background-removal model needs to be downloaded."}\n\nThis is a one-time download and may be large. Do you want to proceed?`)) {
                                            return;
                                        }
                                        showInfoNotification("Downloading the selected background-removal model... This may take a few minutes.", 10000);
                                        break;

                                    case 'selected_model_unavailable':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;
                                    
                                    case 'corrupted':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;
                                    
                                    case 'error':
                                        showErrorNotification(`Error checking model: ${modelStatus.message}`, 5000);
                                        return;
                                }
                            }

                            // Proceed with matting
                            const spinner = $el("div.lf-matting-spinner") as HTMLDivElement;
                            button.appendChild(spinner);
                            button.classList.add('lf-loading');
                            
                            if (modelStatus.available) {
                                showInfoNotification(`Starting ${getMattingModeLabel(mattingSettings.mode).toLowerCase()}...`, 2000);
                            }

                            if (canvas.canvasSelection.selectedLayers.length !== 1) {
                                throw new Error("Please select exactly one image layer for matting.");
                            }

                            const selectedLayer = canvas.canvasSelection.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.canvasLayers.getLayerImageData(selectedLayer);
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({
                                    image: imageData,
                                    model_path: mattingSettings.modelPath || "auto",
                                    mode: mattingSettings.mode,
                                    threshold: mattingSettings.threshold,
                                })
                            });

                            const result = await response.json();

                            if (!response.ok) {
                                let errorMsg = `Server error: ${response.status} - ${response.statusText}`;
                                if (result && result.error) {
                                    // Handle specific error types
                                    if (result.error === "Network Connection Error") {
                                        showErrorNotification("Failed to download the matting model. Please check your internet connection and try again.", 8000);
                                        return;
                                    } else if (result.error === "Matting Model Error") {
                                        showErrorNotification(result.details || "Model loading error. Please check the console for details.", 8000);
                                        return;
                                    } else if (result.error === "Dependency Not Found") {
                                        showErrorNotification(result.details || "Missing required dependencies.", 8000);
                                        return;
                                    }
                                    errorMsg = `${result.error}: ${result.details || 'Check console'}`;
                                }
                                throw new Error(errorMsg);
                            }
                            
                            if (mattingSettings.mode === 'mask_only') {
                                if (typeof result.draw_mask !== 'string') {
                                    throw new Error('Matting response did not contain a Draw Mask image.');
                                }

                                const drawMaskImage = new Image();
                                drawMaskImage.src = result.draw_mask;
                                await drawMaskImage.decode();
                                canvas.maskTool.setMaskForLayer(drawMaskImage, selectedLayer);
                                showSuccessNotification('Generated mask applied to Draw Mask.');
                                return;
                            }

                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();
                            
                            const newLayer = {...selectedLayer, image: mattedImage, flipH: false, flipV: false} as Layer;
                            delete (newLayer as any).imageId;
                            
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.canvasSelection.updateSelection([newLayer]);
                            
                            // Invalidate processed image cache when layer image changes (matting)
                            canvas.canvasLayers.invalidateProcessedImageCache(newLayer.id);
                            
                            canvas.render();
                            canvas.saveState();
                            showSuccessNotification(`${getMattingModeLabel(mattingSettings.mode)} successfully!`);

                        } catch (error: any) {
                            log.error("Matting error:", error);
                            const errorMessage = error.message || "An unknown error occurred.";
                            if (!errorMessage.includes("Network Connection Error") && 
                                !errorMessage.includes("Matting Model Error") &&
                                !errorMessage.includes("Dependency Not Found")) {
                                showErrorNotification(`Matting Failed: ${errorMessage}`);
                            }
                        } finally {
                            button.classList.remove('lf-loading');
                            const spinner = button.querySelector('.lf-matting-spinner');
                            if (spinner && button.contains(spinner)) {
                                button.removeChild(spinner);
                            }
                        }
                    }
                }),
                $el("button.lf-painter-button.lf-icon-button.lf-matting-settings-button", {
                    textContent: "⚙",
                    title: "Open Matting settings",
                    "aria-label": "Open Matting settings",
                    onclick: (e: MouseEvent) => {
                        e.stopPropagation();
                        void openMattingSettings();
                    }
                }),
                $el("button.lf-painter-button", {
                    id: `undo-button-${node.id}`,
                    textContent: "Undo",
                    title: "Undo last action",
                    disabled: true,
                    onclick: () => canvas.undo()
                }),
                $el("button.lf-painter-button", {
                    id: `redo-button-${node.id}`,
                    textContent: "Redo",
                    title: "Redo last undone action",
                    disabled: true,
                    onclick: () => canvas.redo()
                }),
            ]),
            $el("div.lf-painter-separator"),
            $el("div.lf-painter-button-group", {id: "mask-controls"}, [
$el("label.lf-clipboard-switch.lf-mask-switch", {
    id: `toggle-mask-switch-${node.id}`,
    style: { minWidth: "56px", maxWidth: "56px", width: "56px", paddingLeft: "0", paddingRight: "0" },
    title: "Toggle mask overlay visibility on canvas (mask still affects output when disabled)"
}, [
    $el("input", {
        type: "checkbox",
        checked: canvas.maskTool.isOverlayVisible,
        onchange: (e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            canvas.maskTool.isOverlayVisible = checked;
            canvas.render();
        }
    }),
    $el("span.lf-switch-track"),
    $el("span.lf-switch-labels", { style: { fontSize: "11px" } }, [
        $el("span.lf-text-clipspace", { style: { paddingRight: "22px" } }, ["On"]),
        $el("span.lf-text-system", { style: { paddingLeft: "20px" } }, ["Off"])
    ]),
    $el("span.lf-switch-knob", {}, [
        (() => {
            // Ikona maski (SVG lub obrazek)
            const iconContainer = document.createElement('span') as HTMLElement;
            iconContainer.className = 'lf-switch-icon';
            iconContainer.style.display = 'flex';
            iconContainer.style.alignItems = 'center';
            iconContainer.style.justifyContent = 'center';
            iconContainer.style.width = '16px';
            iconContainer.style.height = '16px';
            // Pobierz ikonę maski z iconLoader
            const icon = iconLoader.getIcon(LAYERFORGE_TOOLS.MASK);
            if (icon instanceof HTMLImageElement) {
                const img = icon.cloneNode() as HTMLImageElement;
                img.style.width = "16px";
                img.style.height = "16px";
                // Ustaw filtr w zależności od stanu checkboxa
                setTimeout(() => {
                    const input = document.getElementById(`toggle-mask-switch-${node.id}`)?.querySelector('input[type="checkbox"]') as HTMLInputElement;
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
            } else {
                iconContainer.textContent = "M";
                iconContainer.style.fontSize = "12px";
                iconContainer.style.color = "#fff";
            }
            return iconContainer;
        })()
    ])
]),
                $el("button.lf-painter-button", {
                    textContent: "Edit Mask",
                    title: "Open the current canvas view in the mask editor",
                    onclick: () => {
                        canvas.startMaskEditor(null, true);
                    }
                }),
                $el("button.lf-painter-button", {
                    id: "mask-mode-btn",
                    textContent: "Draw Mask",
                    title: "Toggle mask drawing mode",
                    onclick: () => {
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn') as HTMLButtonElement;
                        const maskControls = controlPanel.querySelector('#mask-controls') as HTMLDivElement;

                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('lf-primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => (c as HTMLElement).style.display = 'none');
                        } else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('lf-primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => (c as HTMLElement).style.display = 'flex');
                        }

                        setTimeout(() => canvas.render(), 0);
                    }
                }),
                $el("div.lf-painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "preview-opacity-slider", textContent: "Mask Opacity:"}),
                    $el("input", {
                        id: "preview-opacity-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e: Event) => {
                            const value = (e.target as HTMLInputElement).value;
                            canvas.maskTool.setPreviewOpacity(parseFloat(value));
                            const valueEl = document.getElementById('preview-opacity-value');
                            if (valueEl) valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.lf-slider-value", {id: "preview-opacity-value"}, ["50%"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-size-slider", textContent: "Size:"}),
                    $el("input", {
                        id: "brush-size-slider",
                        type: "range",
                        min: "1",
                        max: "200",
                        value: "20",
                        oninput: (e: Event) => {
                            const value = (e.target as HTMLInputElement).value;
                            canvas.maskTool.setBrushSize(parseInt(value));
                            const valueEl = document.getElementById('brush-size-value');
                            if (valueEl) valueEl.textContent = `${value}px`;
                        }
                    }),
                    $el("div.lf-slider-value", {id: "brush-size-value"}, ["20px"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-strength-slider", textContent: "Strength:"}),
                    $el("input", {
                        id: "brush-strength-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e: Event) => {
                            const value = (e.target as HTMLInputElement).value;
                            canvas.maskTool.setBrushStrength(parseFloat(value));
                            const valueEl = document.getElementById('brush-strength-value');
                            if (valueEl) valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.lf-slider-value", {id: "brush-strength-value"}, ["50%"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-hardness-slider", textContent: "Hardness:"}),
                    $el("input", {
                        id: "brush-hardness-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e: Event) => {
                            const value = (e.target as HTMLInputElement).value;
                            canvas.maskTool.setBrushHardness(parseFloat(value));
                            const valueEl = document.getElementById('brush-hardness-value');
                            if (valueEl) valueEl.textContent = `${Math.round(parseFloat(value) * 100)}%`;
                        }
                    }),
                    $el("div.lf-slider-value", {id: "brush-hardness-value"}, ["50%"])
                ]),
                $el("button.lf-painter-button.mask-control", {
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

            $el("div.lf-painter-separator"),
            $el("div.lf-painter-button-group", {}, [
                $el("button.lf-painter-button.lf-success", {
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
                        } catch (e) {
                            log.error("Failed to run garbage collection:", e);
                            showErrorNotification("Error running garbage collection. Check the console for details.");
                        }
                    }
                }),
                $el("button.lf-painter-button.lf-danger", {
                    textContent: "Clear Cache",
                    title: "Clear all saved canvas states from browser storage",
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
        $el("div.lf-painter-separator")
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

        // --- Handle Standard Buttons ---
        controlPanel.querySelectorAll('.requires-selection').forEach((el: any) => {
            if (el.tagName === 'BUTTON') {
                if (el.textContent === 'Fuse') {
                    el.disabled = selectionCount < 2;
                } else {
                    el.disabled = !hasSelection;
                }
            }
        });
        
        const mattingBtn = controlPanel.querySelector('.lf-matting-button') as HTMLButtonElement;
        if (mattingBtn && !mattingBtn.classList.contains('lf-loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }

        // --- Handle Crop/Transform Switch ---
        const switchEl = controlPanel.querySelector(`#crop-transform-switch-${node.id}`) as HTMLLabelElement;
        if (switchEl) {
            const input = switchEl.querySelector('input') as HTMLInputElement;
            const knobIcon = switchEl.querySelector('.lf-switch-icon') as HTMLElement;
            
            const isDisabled = !hasSelection;
            switchEl.classList.toggle('lf-disabled', isDisabled);
            input.disabled = isDisabled;

            if (!isDisabled) {
                const isCropMode = canvas.canvasSelection.selectedLayers[0].cropMode || false;
                if (input.checked !== isCropMode) {
                   input.checked = isCropMode;
                }
                
                // Update icon view
                updateSwitchIcon(
                    knobIcon,
                    isCropMode,
                    LAYERFORGE_TOOLS.CROP,
                    LAYERFORGE_TOOLS.TRANSFORM,
                    "✂️",
                    "✥"
                );
            }
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
                    toggleMaskBtn.classList.add('lf-primary');
                    maskIcon.style.opacity = '1';
                } else {
                    toggleMaskBtn.classList.remove('lf-primary');
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
                const blob = await getFlattenedCanvasBlob(canvas, 'with-mask');
                if (blob) {
                    // For large images, use blob URL for better performance
                    if (blob.size > 2 * 1024 * 1024) { // 2MB threshold
                        void loadPreviewImage(blob, {
                            source: 'canvas',
                            urlMode: 'object-url'
                        }).then(img => {
                            node.imgs = [img];
                            log.debug(`Using blob URL for large image (${(blob.size / 1024 / 1024).toFixed(1)}MB): ${img.src.substring(0, 50)}...`);
                            // Clean up old blob URLs to prevent memory leaks
                            if (node.imgs.length > 1) {
                                const oldImg = node.imgs[0];
                                if (oldImg.src.startsWith('blob:')) {
                                    URL.revokeObjectURL(oldImg.src);
                                }
                            }
                        }).catch(() => undefined);
                    } else {
                        // For smaller images, use data URI as before
                        void loadPreviewImage(blob, {
                            source: 'canvas',
                            urlMode: 'data-url'
                        }).then(img => {
                            node.imgs = [img];
                            log.debug(`Using data URI for small image (${(blob.size / 1024).toFixed(1)}KB): ${img.src.substring(0, 50)}...`);
                        }).catch(() => undefined);
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

    const canvasContainer = $el("div.lf-painter-canvas-container.lf-painter-container", {
        style: {
            position: "absolute",
            top: "60px",
            left: "10px",
            right: "270px",
            bottom: "10px",
            overflow: "hidden"
        }
    }, [canvas.canvas]) as HTMLDivElement;

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

    // Watch the canvas container itself to detect size changes and fix canvas dimensions
    const canvasContainerResizeObserver = new ResizeObserver(() => {
        // Force re-read of canvas dimensions on next render
        canvas.render();
    });
    canvasContainerResizeObserver.observe(canvasContainer);

    canvas.canvas.addEventListener('focus', () => {
        canvasContainer.classList.add('lf-has-focus');
    });

    canvas.canvas.addEventListener('blur', () => {
        canvasContainer.classList.remove('lf-has-focus');
    });

    node.onResize = function () {
        canvas.render();
    };

    const mainContainer = $el("div.lf-painter-main-container", {
        style: {
            position: "relative",
            width: "100%",
            height: "100%"
        }
    }, [controlPanel, canvasContainer, layersPanelContainer]) as HTMLDivElement;

    const stopEditableClipboardLeak = (event: ClipboardEvent) => {
        if (isLayerForgeEditableElement(event.target) || isLayerForgeEditableFocused()) {
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    };

    mainContainer.addEventListener('copy', stopEditableClipboardLeak);
    mainContainer.addEventListener('cut', stopEditableClipboardLeak);
    mainContainer.addEventListener('paste', stopEditableClipboardLeak);

    const setShortcutContextActive = (active: boolean) => {
        if (active) {
            mainContainer.setAttribute(LAYERFORGE_SHORTCUT_ACTIVE_ATTR, 'true');
        } else {
            mainContainer.removeAttribute(LAYERFORGE_SHORTCUT_ACTIVE_ATTR);
        }
    };

    const handleShortcutContextFocusIn = () => {
        setShortcutContextActive(true);
    };

    const handleShortcutContextFocusOut = () => {
        requestAnimationFrame(() => {
            if (!mainContainer.contains(document.activeElement)) {
                setShortcutContextActive(false);
            }
        });
    };

    const handleShortcutContextPointerEnter = () => {
        setShortcutContextActive(true);
    };

    const handleShortcutContextPointerLeave = () => {
        if (!mainContainer.contains(document.activeElement)) {
            setShortcutContextActive(false);
        }
    };

    const handleRootUndoRedo = (event: KeyboardEvent) => {
        if (isLayerForgeEditableElement(event.target)) {
            return;
        }

        const isPrimaryModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
        if (!isPrimaryModifier) {
            return;
        }

        const key = event.key.toLowerCase();
        const isUndo = key === 'z' && !event.shiftKey;
        const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
        if (!isUndo && !isRedo) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (isRedo) {
            canvas.redo();
        } else {
            canvas.undo();
        }
    };

    mainContainer.addEventListener('focusin', handleShortcutContextFocusIn);
    mainContainer.addEventListener('focusout', handleShortcutContextFocusOut);
    mainContainer.addEventListener('pointerenter', handleShortcutContextPointerEnter);
    mainContainer.addEventListener('pointerleave', handleShortcutContextPointerLeave);
    mainContainer.addEventListener('keydown', handleRootUndoRedo, true);

    if (node.addDOMWidget) {
        node.addDOMWidget("mainContainer", "widget", mainContainer);
    }

    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`) as HTMLButtonElement;
    let backdrop: HTMLDivElement | null = null;
    let originalParent: HTMLElement | null = null;
    let isEditorOpen = false;
    let viewportAdjustment = { x: 0, y: 0 };

    /**
     * Adjusts the viewport when entering fullscreen mode.
     */
    const adjustViewportOnOpen = (originalRect: DOMRect) => {
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
    const handleEscKey = (e: KeyboardEvent) => {
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

        backdrop = $el("div.lf-painter-modal-backdrop") as HTMLDivElement;
        const modalContent = $el("div.lf-painter-modal-content") as HTMLDivElement;

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

    if (!(window as any).canvasExecutionStates) {
        (window as any).canvasExecutionStates = new Map<string, any>();
    }
    
    // Store the entire widget object, not just the canvas
    (node as any).canvasWidget = {
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

        showPreviewWidget.callback = function (value: boolean) {
            if (originalCallback) {
                originalCallback.call(this, value);
            }

            if (canvas && canvas.setPreviewVisibility) {
                canvas.setPreviewVisibility(value);
            }

            if ((node as any).graph && (node as any).graph.canvas && node.setDirtyCanvas) {
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
        panel: controlPanel,
        destroy: () => {
            closeMattingSettings();
            mainContainer.removeEventListener('copy', stopEditableClipboardLeak);
            mainContainer.removeEventListener('cut', stopEditableClipboardLeak);
            mainContainer.removeEventListener('paste', stopEditableClipboardLeak);
            mainContainer.removeEventListener('focusin', handleShortcutContextFocusIn);
            mainContainer.removeEventListener('focusout', handleShortcutContextFocusOut);
            mainContainer.removeEventListener('pointerenter', handleShortcutContextPointerEnter);
            mainContainer.removeEventListener('pointerleave', handleShortcutContextPointerLeave);
            mainContainer.removeEventListener('keydown', handleRootUndoRedo, true);
            mainContainer.removeAttribute(LAYERFORGE_SHORTCUT_ACTIVE_ATTR);
        }
    };
}

const canvasNodeInstances = new Map<number, CanvasWidget>();

app.registerExtension({
    name: "Comfy.LayerForgeNode",

    init() {
        addStylesheet(getUrl('./css/canvas_view.css'));

        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (this: ComfyApp, number: number, prompt: any) {
            log.info("Preparing to queue prompt...");

            if (canvasNodeInstances.size > 0) {
                log.info(`Found ${canvasNodeInstances.size} CanvasNode(s). Sending data via WebSocket...`);

                const sendPromises: Promise<any>[] = [];
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
        if (nodeType.comfyClass === "LayerForgeNode") {
            // Map to track pending copy sources across node ID changes
            const pendingCopySources = new Map<number, number>();

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

                // Store the canvas widget on the node
                (this as any).canvasWidget = canvasWidget;

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
                        } catch (error) {
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
            nodeType.prototype.onConnectionsChange = function (this: ComfyNode, type: number, index: number, connected: boolean, link_info: any) {
                log.info(`onConnectionsChange called: type=${type}, index=${index}, connected=${connected}`, link_info);
                
                // Check if this is an input connection (type 1 = INPUT)
                if (type === 1) {
                    // Get the canvas widget - it might be in different places
                    const canvasWidget = (this as any).canvasWidget;
                    const canvas = canvasWidget?.canvas || canvasWidget;
                    
                    if (!canvas || !canvas.canvasIO) {
                        log.warn("Canvas not ready in onConnectionsChange, scheduling retry...");
                        // Retry multiple times with increasing delays
                        const retryDelays = [500, 1000, 2000];
                        let retryCount = 0;
                        
                        const tryAgain = () => {
                            const retryCanvas = (this as any).canvasWidget?.canvas || (this as any).canvasWidget;
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
                            } else if (retryCount < retryDelays.length) {
                                log.warn(`Canvas still not ready, retry ${retryCount + 1}/${retryDelays.length}...`);
                                setTimeout(tryAgain, retryDelays[retryCount++]);
                            } else {
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
                                if ((canvas as any).maskAppliedFromInput && canvas.maskTool) {
                                    canvas.maskTool.clear();
                                    canvas.render();
                                    (canvas as any).maskAppliedFromInput = false;
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
                        } else {
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
                        } else {
                            log.info("Input mask disconnected");
                            canvas.hasPendingMaskConnection = false;
                            // If the current mask came from input_mask, clear it to avoid affecting images when mask is not connected
                            if ((canvas as any).maskAppliedFromInput && canvas.maskTool) {
                                (canvas as any).maskAppliedFromInput = false;
                                canvas.lastLoadedMaskLinkId = undefined;
                                log.info("Cleared auto-applied mask due to mask input disconnection");
                            }
                        }
                    }
                }
            };

            // Add onExecuted handler to check for input data after workflow execution
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (this: ComfyNode, message: any) {
                log.info("Node executed, checking for input data...");
                
                const canvas = (this as any).canvasWidget?.canvas || (this as any).canvasWidget;
                if (canvas && canvas.canvasIO) {
                    // Don't reset inputDataLoaded - just check for new data
                    // On execution we allow both image and mask to load
                    canvas.canvasIO.checkForInputData({ allowImage: true, allowMask: true, reason: "execution" });
                }
                
                // Call original if it exists
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments as any);
                }
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
                const backdrop = document.querySelector('.lf-painter-modal-backdrop');
                if (backdrop && (this as any).canvasWidget && backdrop.contains((this as any).canvasWidget.canvas.canvas)) {
                    document.body.removeChild(backdrop);
                }

                if ((this as any).canvasWidget && (this as any).canvasWidget.destroy) {
                    (this as any).canvasWidget.destroy();
                }

                return onRemoved?.apply(this, arguments as any);
            };

            // Handle copy/paste - save canvas state when copying
            const originalSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function (this: ComfyNode) {
                const data = originalSerialize ? originalSerialize.apply(this) : {};

                // Store a reference to the source node ID so we can copy layer data
                data.sourceNodeId = this.id;
                log.debug(`Serializing node ${this.id} for copy`);

                // Store canvas state in a clipboard entry for cross-workflow paste
                // This happens async but that's fine since paste happens later
                (async () => {
                    try {
                        const sourceState = await getCanvasState(String(this.id));
                        if (sourceState) {
                            // Store in a special "clipboard" entry
                            await setCanvasState('__clipboard__', sourceState);
                            log.debug(`Stored canvas state in clipboard for node ${this.id}`);
                        }
                    } catch (error) {
                        log.error('Error storing canvas state to clipboard:', error);
                    }
                })();

                return data;
            };

            // Handle copy/paste - load canvas state from source node when pasting
            const originalConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = async function (this: ComfyNode, data: any) {
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

                const runCanvasExport = async (
                    action: CanvasExportAction,
                    variant: CanvasBlobVariant,
                    filename?: string,
                ): Promise<void> => {
                    const canvas = (self as any).canvasWidget?.canvas;
                    if (!canvas) return;

                    const withMask = variant === 'with-mask';
                    const imageLabel = withMask ? 'image with mask' : 'image';

                    try {
                        const exported = await exportCanvasImage(canvas, { action, variant, filename });

                        if (exported && action === 'copy') {
                            log.info(`${withMask ? 'Image with mask alpha' : 'Image'} copied to clipboard.`);
                        }
                    } catch (error) {
                        log.error(`Error ${action === 'open' ? 'opening' : action === 'copy' ? 'copying' : 'saving'} ${imageLabel}:`, error);
                        if (action === 'copy') {
                            showErrorNotification(`Failed to copy ${withMask ? 'image with mask to clipboard.' : 'image to clipboard.'}`);
                        }
                    }
                };

                const newOptions = [
                    {
                        content: "Open in MaskEditor",
                        callback: async () => {
                            try {
                                log.info("Opening LayerForge canvas in MaskEditor");
                                if ((self as any).canvasWidget && (self as any).canvasWidget.canvas) {
                                    await (self as any).canvasWidget.canvas.startMaskEditor(null, true);
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
                        callback: () => runCanvasExport('open', 'plain'),
                    },
                    {
                        content: "Open Image with Mask Alpha",
                        callback: () => runCanvasExport('open', 'with-mask'),
                    },
                    {
                        content: "Copy Image",
                        callback: () => runCanvasExport('copy', 'plain'),
                    },
                    {
                        content: "Copy Image with Mask Alpha",
                        callback: () => runCanvasExport('copy', 'with-mask'),
                    },
                    {
                        content: "Save Image",
                        callback: () => runCanvasExport('download', 'plain', 'canvas_output.png'),
                    },
                    {
                        content: "Save Image with Mask Alpha",
                        callback: () => runCanvasExport('download', 'with-mask', 'canvas_output_with_mask.png'),
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
