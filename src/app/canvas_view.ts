// @ts-ignore
import {app} from "../../../scripts/app.js";
// @ts-ignore
import {api} from "../../../scripts/api.js";
// @ts-ignore
import {ComfyApp} from "../../../scripts/app.js";
// @ts-ignore
import {ChangeTracker} from "../../../scripts/changeTracker.js";
// @ts-ignore
import {$el} from "../../../scripts/ui.js";

import { addStylesheet, getUrl, loadTemplate } from "../utils/resource_manager.js";

import {Canvas, configureCanvasImagePreviewWidget} from "../canvas/canvas.js";
import type {CanvasWidget} from "./canvas_widget_types.js";
import {
    canvasNodeInstances,
    installLayerForgeMultiImagePromptPatch,
    installLayerForgeVirtualWirePatch,
    isLayerForgeTransportInput,
    pruneLayerForgeTransportInputs,
    scheduleLayerForgeImageConnectionConversion,
} from "./layer_forge_connections.js";
import {clearAllCanvasStates, getCanvasState, setCanvasState} from "../persistence/db.js";
import {getCanvasStateKey} from "../utils/canvas_state_key.js";
import {generateUniqueFileName, createCanvas} from "../utils/common_utils.js";
import { loadImageFromBlob } from "../media/image_utils.js";
import {createModuleLogger} from "../log_system/log_funcs.js";
import {showErrorNotification, showSuccessNotification, showInfoNotification, showWarningNotification} from "../utils/notification_utils.js";
import {tooltipManager} from "../utils/tooltip_manager.js";
import { iconLoader, LAYERFORGE_TOOLS } from "../utils/icon_loader.js";
import { exportCanvasImage, type CanvasExportAction } from "../media/canvas_export_utils.js";
import { getFlattenedCanvasBlob, type CanvasBlobVariant } from "../media/canvas_blob_utils.js";
import { loadPreviewImage } from "../media/preview_utils.js";
import { getImageAddMode } from "../utils/canvas_input_utils.js";
import {
    addLayerForgeImageInputLink,
    clearLayerForgeImageInputLinks,
    getLayerForgeImageInputLinks,
    getLayerForgeImageInputSlot,
    getLayerForgeMaskInputSlot,
    hasLayerForgeImageInput,
    LAYERFORGE_MAX_IMAGE_INPUTS,
    removeLayerForgeImageInputLink,
} from "../utils/multi_image_input_utils.js";
import {
    fetchMattingModelStatus,
    fetchMattingSettings,
    saveMattingSettings as saveMattingSettingsToServer,
    type MattingServerSettings,
    type MattingSettingsUpdate,
} from "../utils/matting_utils.js";
import { cancelSAMDetectorMonitoring, registerImageInClipspace, startSAMDetectorMonitoring, setupSAMDetectorHook } from "../mask/sam_detector_integration.js";
import type { ComfyNode, Layer, AddMode } from '../shared/types';

const log = createModuleLogger('Canvas_view');

type MattingMode = 'remove_background' | 'remove_foreground' | 'mask_only' | 'mask_only_inverted';

interface MattingSettings {
    modelPath: string;
    mode: MattingMode;
    threshold: number;
    hfTokenConfigured: boolean;
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

const DEFAULT_MATTING_SETTINGS: MattingSettings = {
    modelPath: '',
    mode: 'remove_background',
    threshold: 0.5,
    hfTokenConfigured: false,
};

const isMattingMode = (value: unknown): value is MattingMode => {
    return value === 'remove_background'
        || value === 'remove_foreground'
        || value === 'mask_only'
        || value === 'mask_only_inverted';
};

const normalizeMattingSettings = (settings: Partial<MattingSettings>): MattingSettings => {
    const threshold = Number(settings.threshold);
    return {
        modelPath: typeof settings.modelPath === 'string' ? settings.modelPath : DEFAULT_MATTING_SETTINGS.modelPath,
        mode: isMattingMode(settings.mode) ? settings.mode : DEFAULT_MATTING_SETTINGS.mode,
        threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_MATTING_SETTINGS.threshold,
        hfTokenConfigured: settings.hfTokenConfigured === true,
    };
};

const fromServerMattingSettings = (settings: MattingServerSettings): MattingSettings => normalizeMattingSettings({
    modelPath: settings.model_path,
    mode: settings.mode as MattingMode,
    threshold: settings.threshold,
    hfTokenConfigured: settings.hf_token_configured,
});

const loadMattingSettings = async (): Promise<MattingSettings> => {
    try {
        const response = await fetchMattingSettings();
        if (response.ok && response.data.settings) {
            return fromServerMattingSettings(response.data.settings);
        }
    } catch (error) {
        log.warn('Unable to load Matting settings from ComfyUI:', error);
    }

    return { ...DEFAULT_MATTING_SETTINGS };
};

const persistMattingSettings = async (
    settings: MattingSettings,
    token: string,
    clearToken: boolean,
): Promise<MattingSettings> => {
    const payload: MattingSettingsUpdate = {
        model_path: settings.modelPath,
        mode: settings.mode,
        threshold: settings.threshold,
    };
    if (token.trim()) payload.hf_token = token.trim();
    if (clearToken) payload.clear_hf_token = true;

    const response = await saveMattingSettingsToServer(payload);
    if (!response.ok || !response.data.settings) {
        throw new Error(response.data.error || 'Unable to save Matting settings on the ComfyUI server.');
    }

    return fromServerMattingSettings(response.data.settings);
};

const getMattingModeLabel = (mode: MattingMode): string => {
    switch (mode) {
        case 'remove_foreground':
            return 'Remove detected foreground / keep background';
        case 'mask_only':
            return 'Apply generated mask to Draw Mask';
        case 'mask_only_inverted':
            return 'Apply inverted mask to Draw Mask';
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

async function createCanvasWidget(node: ComfyNode, widget: any, _app: ComfyApp): Promise<CanvasWidget> {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput(node, canvas)
    });
    let widgetDestroyed = false;
    let mattingAbortController: AbortController | null = null;

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

    const [standardShortcuts, maskShortcuts, systemClipboardTooltip, clipspaceClipboardTooltip] = await Promise.all([
        loadTemplate('./templates/standard_shortcuts.html'),
        loadTemplate('./templates/mask_shortcuts.html'),
        loadTemplate('./templates/system_clipboard_tooltip.html'),
        loadTemplate('./templates/clipspace_clipboard_tooltip.html')
    ]);

    const createMattingTooltipBadge = (labelText: string, tooltipText: string): HTMLSpanElement => {
        const badge = document.createElement('span');
        badge.className = 'lf-matting-tooltip-badge';
        badge.textContent = '?';
        badge.tabIndex = 0;
        badge.dataset.tooltip = tooltipText;
        badge.setAttribute('aria-label', `More information about ${labelText}`);
        badge.addEventListener('click', (event) => event.preventDefault());
        return badge;
    };

    let mattingSettingsBackdrop: HTMLDivElement | null = null;
    let mattingSettingsDialog: HTMLDivElement | null = null;
    let mattingSettingsTooltipRootCleanup: (() => void) | null = null;
    let mattingSettingsEscapeHandler: ((event: KeyboardEvent) => void) | null = null;

    const closeMattingSettings = () => {
        if (mattingSettingsDialog) {
            tooltipManager.hideTooltip(mattingSettingsDialog);
        }
        mattingSettingsTooltipRootCleanup?.();
        mattingSettingsTooltipRootCleanup = null;
        mattingSettingsDialog = null;
        if (mattingSettingsEscapeHandler) {
            document.removeEventListener('keydown', mattingSettingsEscapeHandler);
            mattingSettingsEscapeHandler = null;
        }

        mattingSettingsBackdrop?.remove();
        mattingSettingsBackdrop = null;
    };

    const openMattingSettings = async (): Promise<void> => {
        if (mattingSettingsBackdrop) return;

        const settings = await loadMattingSettings();
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
        tooltipManager.setTooltip(closeButton, 'Close Matting settings');
        closeButton.setAttribute('aria-label', 'Close Matting settings');
        closeButton.onclick = closeMattingSettings;

        header.append(title, closeButton);

        const body = document.createElement('div');
        body.className = 'lf-matting-settings-body';

        const createRow = (labelText: string, control: HTMLElement, tooltipText?: string): HTMLLabelElement => {
            const row = document.createElement('label');
            row.className = 'lf-matting-settings-row';

            const label = document.createElement('span');
            label.className = 'lf-matting-settings-label';
            label.appendChild(document.createTextNode(labelText));
            if (tooltipText) {
                label.appendChild(createMattingTooltipBadge(labelText, tooltipText));
            }
            row.appendChild(label);
            row.appendChild(control);

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
                if (option.description) tooltipManager.setTooltip(remoteOption, option.description);
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
                modelDescription.textContent = 'Automatic mode picks the best compatible installed model and downloads the default model if needed.';
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
        (['remove_background', 'remove_foreground', 'mask_only', 'mask_only_inverted'] as MattingMode[]).forEach((mode) => {
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

        const tokenContainer = document.createElement('div');
        tokenContainer.className = 'lf-matting-settings-token';

        const tokenInput = document.createElement('input');
        tokenInput.type = 'password';
        tokenInput.className = 'lf-matting-settings-input';
        tokenInput.autocomplete = 'off';
        tokenInput.placeholder = settings.hfTokenConfigured
            ? 'Token saved — leave blank to keep it'
            : 'Paste a Hugging Face read token';
        tokenInput.spellcheck = false;

        const clearTokenLabel = document.createElement('label');
        clearTokenLabel.className = 'lf-matting-settings-token-clear';
        const clearTokenInput = document.createElement('input');
        clearTokenInput.type = 'checkbox';
        clearTokenInput.disabled = !settings.hfTokenConfigured;
        const clearTokenText = document.createElement('span');
        clearTokenText.textContent = 'Clear saved token';
        clearTokenLabel.append(clearTokenInput, clearTokenText);
        tokenInput.oninput = () => {
            if (tokenInput.value.trim()) clearTokenInput.checked = false;
        };
        tokenContainer.append(tokenInput, clearTokenLabel);

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
            createRow('Hugging Face token', tokenContainer, 'Optional read token for gated models such as BRIA RMBG 2.0. It is stored only in the ComfyUI custom node settings file.'),
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
            updateModelDetails();
        };

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'lf-matting-settings-primary';
        saveButton.textContent = 'Save settings';
        saveButton.onclick = async () => {
            saveButton.disabled = true;
            try {
                await persistMattingSettings(
                    {
                        modelPath: modelSelect.value === 'auto' ? '' : modelSelect.value,
                        mode: modeSelect.value as MattingMode,
                        threshold: Number(thresholdInput.value),
                        hfTokenConfigured: settings.hfTokenConfigured,
                    },
                    tokenInput.value,
                    clearTokenInput.checked,
                );
                closeMattingSettings();
                showInfoNotification('Matting settings saved.', 2000);
            } catch (error) {
                log.error('Unable to save Matting settings:', error);
                showErrorNotification(error instanceof Error ? error.message : 'Unable to save Matting settings.', 8000);
            } finally {
                saveButton.disabled = false;
            }
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

        mattingSettingsDialog = dialog;
        mattingSettingsTooltipRootCleanup = tooltipManager.observeRoot(dialog);
        mattingSettingsBackdrop = backdrop;
        document.body.appendChild(backdrop);
        closeButton.focus();
    };

    let inputMenu: HTMLDivElement | null = null;
    let inputMenuOutsideHandler: ((event: PointerEvent) => void) | null = null;
    let inputMenuEscapeHandler: ((event: KeyboardEvent) => void) | null = null;
    let inputMenuRepositionHandler: (() => void) | null = null;
    let inputMenuTooltipRootCleanup: (() => void) | null = null;

    const closeInputMenu = (): void => {
        if (inputMenuOutsideHandler) {
            document.removeEventListener('pointerdown', inputMenuOutsideHandler);
            inputMenuOutsideHandler = null;
        }
        if (inputMenuEscapeHandler) {
            document.removeEventListener('keydown', inputMenuEscapeHandler);
            inputMenuEscapeHandler = null;
        }
        if (inputMenuRepositionHandler) {
            window.removeEventListener('resize', inputMenuRepositionHandler);
            window.removeEventListener('scroll', inputMenuRepositionHandler, true);
            inputMenuRepositionHandler = null;
        }
        inputMenuTooltipRootCleanup?.();
        inputMenuTooltipRootCleanup = null;
        inputMenu?.remove();
        inputMenu = null;
        showInputsButton?.setAttribute('aria-expanded', 'false');
    };

    const positionInputMenu = (): void => {
        if (!inputMenu || !showInputsButton) return;

        const buttonRect = showInputsButton.getBoundingClientRect();
        const menuWidth = inputMenu.offsetWidth || 320;
        const menuHeight = inputMenu.offsetHeight || 180;
        let left = buttonRect.left;
        let top = buttonRect.bottom + 6;

        if (left + menuWidth > window.innerWidth - 8) {
            left = window.innerWidth - menuWidth - 8;
        }
        if (top + menuHeight > window.innerHeight - 8) {
            top = buttonRect.top - menuHeight - 6;
        }

        inputMenu.style.left = `${Math.max(8, Math.round(left))}px`;
        inputMenu.style.top = `${Math.max(8, Math.round(top))}px`;
    };

    const getInputImageFileLabel = (image: HTMLImageElement, fallback: string): string => {
        const source = String(image.currentSrc || image.src || '');
        if (!source || /^data:/i.test(source)) return fallback;

        let rawName = '';
        try {
            const parsedSource = new URL(source, window.location.href);
            rawName = parsedSource.searchParams.get('filename')
                || parsedSource.pathname.split('/').pop()
                || '';
        } catch {
            rawName = source.split(/[?#]/, 1)[0].split('/').pop() || '';
        }
        try {
            const decodedName = decodeURIComponent(rawName).trim();
            if (decodedName && decodedName.length <= 80) return decodedName;
        } catch {
            if (rawName && rawName.length <= 80) return rawName;
        }

        return fallback;
    };

    const renderInputMenu = (menu: HTMLDivElement): void => {
        menu.replaceChildren();

        const title = document.createElement('div');
        title.className = 'lf-inputs-menu-title';
        title.textContent = 'Connected input images';
        menu.appendChild(title);

        const references = canvas.canvasIO.getConnectedInputImages();
        const list = document.createElement('div');
        list.className = 'lf-inputs-menu-list';

        if (references.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lf-inputs-menu-empty';
            empty.textContent = 'Connect an image input to see it here.';
            list.appendChild(empty);
            menu.appendChild(list);
            return;
        }

        references.forEach((reference, index) => {
            const connectionLabel = `Image ${reference.connectionIndex}`;
            const fallbackLabel = `${reference.sourceLabel} · ${connectionLabel}`;
            const row = document.createElement('div');
            row.className = 'lf-input-reference-row';
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'lf-input-reference';
            item.setAttribute('role', 'menuitem');
            tooltipManager.setTooltip(item, 'Add this input image to the canvas');

            const thumbnail = document.createElement('img');
            thumbnail.className = 'lf-input-reference-thumb';
            thumbnail.src = reference.image.currentSrc || reference.image.src;
            thumbnail.alt = fallbackLabel;
            thumbnail.draggable = false;

            const text = document.createElement('span');
            text.className = 'lf-input-reference-text';
            const label = document.createElement('span');
            label.className = 'lf-input-reference-label';
            label.textContent = getInputImageFileLabel(reference.image, `Image ${index + 1}`);
            const detail = document.createElement('span');
            detail.className = 'lf-input-reference-detail';
            detail.textContent = `${reference.sourceLabel} · ${connectionLabel}`;
            text.append(label, detail);
            item.append(thumbnail, text);

            const unlink = document.createElement('button');
            unlink.type = 'button';
            unlink.className = 'lf-input-reference-unlink';
            unlink.textContent = 'Unlink';
            tooltipManager.setTooltip(unlink, 'Disconnect this image input from LayerForge');
            unlink.setAttribute('aria-label', `Unlink ${fallbackLabel}`);

            item.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            item.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                item.disabled = true;
                void canvas.canvasIO.addSelectedInputImage(reference.image).then((added) => {
                    if (added) closeInputMenu();
                }).finally(() => {
                    item.disabled = false;
                });
            });

            unlink.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            unlink.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                unlink.disabled = true;
                const unlinked = canvas.canvasIO.unlinkConnectedInputImage(reference);
                if (unlinked) {
                    renderInputMenu(menu);
                    requestAnimationFrame(positionInputMenu);
                }
                unlink.disabled = false;
            });

            row.append(item, unlink);
            list.appendChild(row);
        });

        menu.appendChild(list);
    };

    function toggleInputMenu(): void {
        if (inputMenu) {
            closeInputMenu();
            return;
        }

        const menu = document.createElement('div');
        menu.className = 'lf-inputs-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Connected input images');
        menu.addEventListener('pointerdown', (event) => event.stopPropagation());
        menu.addEventListener('click', (event) => event.stopPropagation());

        inputMenu = menu;
        showInputsButton.setAttribute('aria-expanded', 'true');
        document.body.appendChild(menu);
        renderInputMenu(menu);
        inputMenuTooltipRootCleanup = tooltipManager.observeRoot(menu);

        inputMenuOutsideHandler = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (target && (menu.contains(target) || showInputsButton.contains(target))) return;
            closeInputMenu();
        };
        inputMenuEscapeHandler = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeInputMenu();
            showInputsButton.focus();
        };
        inputMenuRepositionHandler = positionInputMenu;
        document.addEventListener('pointerdown', inputMenuOutsideHandler);
        document.addEventListener('keydown', inputMenuEscapeHandler);
        window.addEventListener('resize', inputMenuRepositionHandler);
        window.addEventListener('scroll', inputMenuRepositionHandler, true);
        positionInputMenu();
    }

    const showInputsButton = $el("button.lf-painter-button.lf-primary", {
        textContent: "Show Inputs",
        title: "Show connected input images",
        onclick: toggleInputMenu,
    }) as HTMLButtonElement;
    showInputsButton.setAttribute('aria-haspopup', 'menu');
    showInputsButton.setAttribute('aria-expanded', 'false');

    const shortcutHelpButton = $el("button.lf-painter-button.lf-icon-button", {
        textContent: "?",
        "aria-label": "Show keyboard shortcuts",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const button = e.currentTarget as HTMLButtonElement;

            if (tooltipManager.isVisibleFor(button)) {
                tooltipManager.hideTooltip(button);
                return;
            }

            const content = canvas.maskTool.isActive ? maskShortcuts : standardShortcuts;
            tooltipManager.showTooltip(button, content, {
                html: true,
                persistent: true,
                onDismiss: () => button.setAttribute('aria-expanded', 'false')
            });
            button.setAttribute('aria-expanded', 'true');
        }
    }) as HTMLButtonElement;

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
                shortcutHelpButton,
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
                showInputsButton,
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
        if (tooltipManager.isVisibleFor(switchEl)) {
            const tooltipContent = getCurrentTooltipContent();
            tooltipManager.showTooltip(switchEl, tooltipContent, { html: true, interactive: false });
        }
    };

    // Tooltip logic
    switchEl.addEventListener("mouseenter", () => {
        const tooltipContent = getCurrentTooltipContent();
        tooltipManager.showTooltip(switchEl, tooltipContent, { html: true, interactive: false });
    });
    switchEl.addEventListener("mouseleave", () => tooltipManager.hideTooltip(switchEl));

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
                        if (widgetDestroyed || button.classList.contains('lf-loading')) return;

                        const operationController = new AbortController();
                        mattingAbortController = operationController;

                        const mattingSettings = await loadMattingSettings();
                        if (widgetDestroyed || operationController.signal.aborted) {
                            if (mattingAbortController === operationController) mattingAbortController = null;
                            return;
                        }

                        try {
                            // First check if model is available
                            const { data: modelStatus } = await fetchMattingModelStatus(mattingSettings.modelPath);
                            if (widgetDestroyed || operationController.signal.aborted) return;
                            
                            if (!modelStatus.available) {
                                switch (modelStatus.reason) {
                                    case 'missing_dependency':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;

                                    case 'unsupported_comfyui':
                                        showErrorNotification(modelStatus.message, 8000);
                                        return;

                                    case 'unsupported_rmbg':
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
                            startMattingSpinner();
                            if (modelStatus.reason === 'not_downloaded') {
                                setMattingDownloadProgress(0);
                                startMattingProgressPolling(operationController.signal);
                            }
                            
                            if (modelStatus.available) {
                                showInfoNotification(`Starting ${getMattingModeLabel(mattingSettings.mode).toLowerCase()}...`, 2000);
                            }

                            if (canvas.canvasSelection.selectedLayers.length !== 1) {
                                throw new Error("Please select exactly one image layer for matting.");
                            }

                            const selectedLayer = canvas.canvasSelection.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.canvasLayers.getLayerImageData(selectedLayer);
                            if (widgetDestroyed || operationController.signal.aborted) return;
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {"Content-Type": "application/json"},
                                signal: operationController.signal,
                                body: JSON.stringify({
                                    image: imageData,
                                    model_path: mattingSettings.modelPath || "auto",
                                    mode: mattingSettings.mode,
                                    threshold: mattingSettings.threshold,
                                    node_id: String(node.id),
                                })
                            });

                            const result = await response.json();
                            if (widgetDestroyed || operationController.signal.aborted) return;

                            if (!response.ok) {
                                let errorMsg = `Server error: ${response.status} - ${response.statusText}`;
                                if (result && result.error) {
                                    // Handle specific error types
                                    if (result.error === "Network Connection Error") {
                                        showErrorNotification("Failed to download the matting model. Please check your internet connection and try again.", 8000);
                                        return;
                                    } else if (result.error === "Matting Interrupted") {
                                        showWarningNotification(result.details || "Matting was interrupted by ComfyUI.", 6000);
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
                            
                            if (mattingSettings.mode === 'mask_only' || mattingSettings.mode === 'mask_only_inverted') {
                                if (typeof result.draw_mask !== 'string') {
                                    throw new Error('Matting response did not contain a Draw Mask image.');
                                }

                                const drawMaskImage = new Image();
                                drawMaskImage.src = result.draw_mask;
                                await drawMaskImage.decode();
                                if (widgetDestroyed || operationController.signal.aborted || canvas.layers[selectedLayerIndex] !== selectedLayer) return;
                                canvas.maskTool.setMaskForLayer(drawMaskImage, selectedLayer);
                                showSuccessNotification(
                                    mattingSettings.mode === 'mask_only_inverted'
                                        ? 'Inverted mask applied to Draw Mask.'
                                        : 'Generated mask applied to Draw Mask.',
                                );
                                return;
                            }

                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();
                            if (widgetDestroyed || operationController.signal.aborted || canvas.layers[selectedLayerIndex] !== selectedLayer) return;
                            
                            const newLayer = {...selectedLayer, image: mattedImage, flipH: false, flipV: false} as Layer;
                            delete (newLayer as any).imageId;
                            
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.canvasSelection.updateSelection([newLayer]);
                            canvas.canvasLayersPanel?.onLayersChanged();
                            
                            // Invalidate processed image cache when layer image changes (matting)
                            canvas.canvasLayers.invalidateProcessedImageCache(newLayer.id);
                            
                            canvas.render();
                            canvas.saveState();
                            showSuccessNotification(`${getMattingModeLabel(mattingSettings.mode)} successfully!`);

                        } catch (error: any) {
                            if (widgetDestroyed || operationController.signal.aborted) return;
                            log.error("Matting error:", error);
                            const errorMessage = error.message || "An unknown error occurred.";
                            if (!errorMessage.includes("Network Connection Error") && 
                                !errorMessage.includes("Matting Model Error") &&
                                !errorMessage.includes("Dependency Not Found")) {
                                showErrorNotification(`Matting Failed: ${errorMessage}`);
                            }
                        } finally {
                            if (mattingAbortController === operationController) mattingAbortController = null;
                            stopMattingProgressPolling();
                            stopMattingSpinner();
                            setMattingDownloadProgress(null);
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
        ])
    ]);

    const mattingButton = controlPanel.querySelector('.lf-matting-button') as HTMLButtonElement | null;
    const mattingProgressTrack = document.createElement('span');
    mattingProgressTrack.className = 'lf-matting-download-progress';
    mattingProgressTrack.setAttribute('aria-hidden', 'true');
    const mattingProgressFill = document.createElement('span');
    mattingProgressFill.className = 'lf-matting-download-progress-fill';
    mattingProgressTrack.appendChild(mattingProgressFill);
    mattingButton?.appendChild(mattingProgressTrack);

    let mattingSpinnerAnimationFrame: number | null = null;
    let mattingProgressPollTimer: number | null = null;
    let mattingProgressPolling = false;

    const stopMattingSpinner = (): void => {
        if (mattingSpinnerAnimationFrame !== null) {
            window.cancelAnimationFrame(mattingSpinnerAnimationFrame);
            mattingSpinnerAnimationFrame = null;
        }

        const spinner = mattingButton?.querySelector('.lf-matting-spinner') as HTMLDivElement | null;
        if (spinner) {
            spinner.style.transform = '';
        }
    };

    const startMattingSpinner = (): void => {
        stopMattingSpinner();
        const spinner = mattingButton?.querySelector('.lf-matting-spinner') as HTMLDivElement | null;
        if (!spinner) return;

        const startedAt = performance.now();
        const animate = (timestamp: number): void => {
            if (!mattingButton?.classList.contains('lf-loading') || !spinner.isConnected) {
                stopMattingSpinner();
                return;
            }

            const rotation = ((timestamp - startedAt) * 0.45) % 360;
            spinner.style.transform = `translateY(-50%) rotate(${rotation}deg)`;
            mattingSpinnerAnimationFrame = window.requestAnimationFrame(animate);
        };

        mattingSpinnerAnimationFrame = window.requestAnimationFrame(animate);
    };

    const setMattingDownloadProgress = (progress: number | null): void => {
        if (!mattingButton) return;

        if (progress === null) {
            mattingButton.classList.remove('lf-downloading');
            mattingProgressFill.style.width = '0%';
            return;
        }

        const normalizedProgress = Math.min(100, Math.max(0, Number(progress) || 0));
        mattingButton.classList.add('lf-downloading');
        mattingProgressFill.style.width = `${normalizedProgress}%`;
    };

    const handleMattingStatus = (event: any): void => {
        const eventPayload = event?.detail && typeof event.detail === 'object' ? event.detail : event;
        const payload = eventPayload?.data && typeof eventPayload.data === 'object'
            ? eventPayload.data
            : eventPayload;
        if (!payload || typeof payload.status !== 'string') return;

        if (payload.node_id !== undefined && String(payload.node_id) !== String(node.id)) {
            return;
        }

        if (payload.status === 'downloading') {
            setMattingDownloadProgress(Number(payload.progress) || 0);
        } else if (payload.status === 'completed' || payload.status === 'error') {
            setMattingDownloadProgress(null);
        }
    };

    const stopMattingProgressPolling = (): void => {
        mattingProgressPolling = false;
        if (mattingProgressPollTimer !== null) {
            window.clearTimeout(mattingProgressPollTimer);
            mattingProgressPollTimer = null;
        }
    };

    const pollMattingProgress = async (signal?: AbortSignal): Promise<void> => {
        if (!mattingProgressPolling || signal?.aborted) return;

        try {
            const response = await fetch(
                `/matting/progress?node_id=${encodeURIComponent(String(node.id))}`,
                { cache: 'no-store', signal },
            );
            if (response.ok && mattingProgressPolling && !signal?.aborted && !widgetDestroyed) {
                handleMattingStatus({ detail: await response.json() });
            }
        } catch {
            // WebSocket events remain the primary path; polling is a best-effort fallback.
        } finally {
            if (mattingProgressPolling && !signal?.aborted && !widgetDestroyed) {
                mattingProgressPollTimer = window.setTimeout(() => {
                    void pollMattingProgress(signal);
                }, 250);
            }
        }
    };

    const startMattingProgressPolling = (signal: AbortSignal): void => {
        stopMattingProgressPolling();
        mattingProgressPolling = true;
        void pollMattingProgress(signal);
    };

    if (mattingButton) {
        api.addEventListener('matting_status', handleMattingStatus);
    }

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
    const unregisterTooltips = tooltipManager.observeRoot(mainContainer);

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
        const getEditorWidgetHeight = () => {
            const controlsHeight = controlsElement instanceof HTMLElement ? controlsElement.offsetHeight : 0;
            return Math.max(300, controlsHeight + 180);
        };
        (node.addDOMWidget as any)("mainContainer", "widget", mainContainer, {
            getMinHeight: getEditorWidgetHeight,
            getHeight: getEditorWidgetHeight,
            hideInPanel: true,
        });
    }

    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`) as HTMLButtonElement;
    let backdrop: HTMLDivElement | null = null;
    let modalContent: HTMLDivElement | null = null;
    let workflowOverviewToggleButton: HTMLButtonElement | null = null;
    let workflowRunButton: HTMLButtonElement | null = null;
    let workflowOverviewResizeObserver: ResizeObserver | null = null;
    let workflowOverviewWindowResizeHandler: (() => void) | null = null;
    let workflowOverviewLayoutFrame: number | null = null;
    let workflowOverviewSyncFrame: number | null = null;
    let workflowOverviewToggleRequest = 0;
    let lastModalBounds = { left: Number.NaN, right: Number.NaN };
    let originalParent: HTMLElement | null = null;
    let isEditorOpen = false;

    const clearFullscreenButtonTooltips = () => {
        if (workflowOverviewToggleButton) {
            tooltipManager.removeTooltip(workflowOverviewToggleButton);
        }
        if (workflowRunButton) {
            tooltipManager.removeTooltip(workflowRunButton);
        }
    };
    let viewportAdjustment = { x: 0, y: 0 };
    let workflowOverviewSelectionSnapshot: any[] | null = null;
    let workflowOverviewSelectionCleared = false;

    const workflowOverviewPanelSelector = '[data-testid="properties-panel"]';
    const workflowOverviewNodesTabSelector = '[data-testid="panel-tab-nodes"]';
    const nativeWorkflowOverviewToggleSelector =
        'button[aria-label="Toggle properties panel"]:not(.lf-workflow-overview-toggle)';

    const getComfyCanvas = (): any => (_app as any)?.canvas ?? (app as any)?.canvas;

    const getComfySelectedItems = (comfyCanvas: any): any[] => {
        const selectedItems = comfyCanvas?.selectedItems;
        if (selectedItems && typeof selectedItems[Symbol.iterator] === "function") {
            return Array.from(selectedItems);
        }

        const selectedNodes = comfyCanvas?.selected_nodes;
        if (selectedNodes && typeof selectedNodes === "object") {
            return Object.values(selectedNodes);
        }

        return [];
    };

    const getComfyCanvasStore = (): any => {
        const vueRoot = document.querySelector<HTMLElement>("#vue-app") as any;
        const provides = vueRoot?.__vue_app__?._context?.provides;
        if (!provides) {
            return null;
        }

        const pinia = Reflect.ownKeys(provides)
            .map((key) => provides[key as keyof typeof provides])
            .find((candidate: any) => candidate?._s?.has?.("canvas"));

        return pinia?._s?.get?.("canvas") ?? null;
    };

    const notifyComfySelectionChanged = (comfyCanvas: any) => {
        comfyCanvas?.onSelectionChange?.(comfyCanvas.selected_nodes ?? {});
        // Vue Nodes 2.0 explicitly refreshes this Pinia store after native
        // selection mutations. The native callback is not guaranteed to be
        // installed for every canvas lifecycle, so mirror that update here.
        const canvasStore = getComfyCanvasStore();
        canvasStore?.updateSelectedItems?.();
        // Keep a final explicit empty-state fallback. This covers a canvas
        // lifecycle where the store still points at an old graph instance:
        // the native canvas is already empty, so the properties panel must be
        // told that there are no directly selected items as well.
        if (canvasStore && getComfySelectedItems(comfyCanvas).length === 0) {
            canvasStore.selectedItems = [];
        }
        comfyCanvas?.setDirty?.(true, true);
    };

    const clearWorkflowOverviewSelection = () => {
        const comfyCanvas = getComfyCanvas();
        if (!comfyCanvas) {
            return;
        }

        // Keep the selection from before fullscreen only once. The actual
        // clearing must remain repeatable: ComfyUI can restore its selection
        // while mounting/toggling the Vue properties panel, and returning
        // early here would leave the panel on the LayerForge node.
        if (!workflowOverviewSelectionCleared) {
            workflowOverviewSelectionSnapshot = getComfySelectedItems(comfyCanvas);
            workflowOverviewSelectionCleared = true;
        }

        if (typeof comfyCanvas.deselectAll === "function") {
            comfyCanvas.deselectAll();
        } else if (comfyCanvas.selectedItems?.clear) {
            for (const item of getComfySelectedItems(comfyCanvas)) {
                item.selected = false;
                item.onDeselected?.();
            }
            comfyCanvas.selectedItems.clear();
            comfyCanvas.selected_nodes = {};
        } else if (comfyCanvas.selected_nodes && typeof comfyCanvas.selected_nodes === "object") {
            comfyCanvas.selected_nodes = {};
        }

        // ComfyUI's Vue canvas store is synchronized through this callback.
        // Recent LiteGraph versions clear the native selection without always
        // invoking it, which would leave the properties panel on the selected
        // LayerForge node even though the canvas itself is deselected.
        notifyComfySelectionChanged(comfyCanvas);

    };

    const restoreWorkflowOverviewSelection = () => {
        if (!workflowOverviewSelectionCleared) {
            return;
        }

        const comfyCanvas = getComfyCanvas();
        const selection = workflowOverviewSelectionSnapshot ?? [];

        if (comfyCanvas) {
            if (typeof comfyCanvas.selectNodes === "function") {
                comfyCanvas.selectNodes(selection);
            } else if (typeof comfyCanvas.selectItems === "function") {
                comfyCanvas.selectItems(selection);
            } else if (comfyCanvas.selectedItems?.clear) {
                comfyCanvas.selectedItems.clear();
                for (const item of selection) {
                    item.selected = true;
                    comfyCanvas.selectedItems.add(item);
                }
            }

            notifyComfySelectionChanged(comfyCanvas);
        }

        workflowOverviewSelectionSnapshot = null;
        workflowOverviewSelectionCleared = false;
    };

    const isVisibleElement = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        const styles = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return styles.display !== "none" &&
            styles.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
    };

    const getWorkflowOverviewPanel = (): HTMLElement | null => {
        const panel = document.querySelector<HTMLElement>(workflowOverviewPanelSelector);
        return isVisibleElement(panel) ? panel : null;
    };

    const findNativeWorkflowOverviewToggle = (): HTMLButtonElement | null => {
        const labeledButton = document.querySelector<HTMLButtonElement>(
            nativeWorkflowOverviewToggleSelector
        );
        if (isVisibleElement(labeledButton)) {
            return labeledButton;
        }

        const panelCloseButton = document.querySelector<HTMLButtonElement>(
            workflowOverviewPanelSelector + ' button[aria-pressed="true"]'
        );
        if (isVisibleElement(panelCloseButton)) {
            return panelCloseButton;
        }

        return Array.from(
            document.querySelectorAll<HTMLButtonElement>("button:not(.lf-workflow-overview-toggle)")
        ).find((button) => {
            if (!isVisibleElement(button)) {
                return false;
            }

            return Array.from(button.querySelectorAll("i")).some((icon) =>
                icon.className.includes("icon-[lucide--panel-")
            );
        }) ?? null;
    };

    const isWorkflowOverviewOpen = (): boolean => {
        return getWorkflowOverviewPanel() !== null;
    };

    interface WorkflowOverviewLayout {
        left: number;
        right: number;
        observedElements: HTMLElement[];
    }

    const getWorkflowOverviewLayout = (): WorkflowOverviewLayout | null => {
        const panel = getWorkflowOverviewPanel();
        if (!panel) {
            return null;
        }

        const splitterPanel = panel.closest('[data-pc-name="splitterpanel"]') as HTMLElement | null;
        const panelElement = splitterPanel ?? panel;
        const panelRect = panelElement.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        let panelIsOnRight = panelRect.left >= viewportWidth / 2;

        let gutter: HTMLElement | null = null;
        if (splitterPanel) {
            const previousSibling = splitterPanel.previousElementSibling;
            const nextSibling = splitterPanel.nextElementSibling;
            const previousGutter = previousSibling instanceof HTMLElement &&
                previousSibling.classList.contains("p-splitter-gutter")
                ? previousSibling
                : null;
            const nextGutter = nextSibling instanceof HTMLElement &&
                nextSibling.classList.contains("p-splitter-gutter")
                ? nextSibling
                : null;

            if (previousGutter && !nextGutter) {
                panelIsOnRight = true;
                gutter = previousGutter;
            } else if (nextGutter && !previousGutter) {
                panelIsOnRight = false;
                gutter = nextGutter;
            } else if (splitterPanel.parentElement?.firstElementChild === splitterPanel) {
                panelIsOnRight = false;
            } else if (splitterPanel.parentElement?.lastElementChild === splitterPanel) {
                panelIsOnRight = true;
            }
        }

        const gutterRect = gutter?.getBoundingClientRect();
        if (panelIsOnRight) {
            const boundary = gutterRect?.left ?? Math.max(0, panelRect.left - 8);
            return {
                left: 0,
                right: Math.max(0, viewportWidth - boundary),
                observedElements: gutter ? [panelElement, gutter] : [panelElement],
            };
        }

        const boundary = gutterRect?.right ?? Math.min(viewportWidth, panelRect.right + 8);
        return {
            left: Math.min(viewportWidth, boundary),
            right: 0,
            observedElements: gutter ? [panelElement, gutter] : [panelElement],
        };
    };

    const updateWorkflowOverviewButton = () => {
        if (!workflowOverviewToggleButton) {
            return;
        }

        const isOpen = isWorkflowOverviewOpen();
        workflowOverviewToggleButton.setAttribute("aria-pressed", String(isOpen));
        tooltipManager.setTooltip(
            workflowOverviewToggleButton,
            isOpen ? "Close Workflow Overview" : "Open Workflow Overview"
        );
        workflowOverviewToggleButton.classList.toggle("lf-workflow-overview-open", isOpen);
    };

    const applyWorkflowOverviewLayout = () => {
        updateWorkflowOverviewButton();

        if (!modalContent) {
            return;
        }

        const layout = getWorkflowOverviewLayout();
        const left = layout?.left ?? 0;
        const right = layout?.right ?? 0;

        modalContent.style.left = left + "px";
        modalContent.style.right = right + "px";

        if (lastModalBounds.left !== left || lastModalBounds.right !== right) {
            lastModalBounds = { left, right };
            if (node.onResize) {
                node.onResize();
            } else {
                canvas.render();
            }
        }
    };

    const scheduleWorkflowOverviewLayoutUpdate = () => {
        if (workflowOverviewLayoutFrame !== null) {
            return;
        }

        workflowOverviewLayoutFrame = window.requestAnimationFrame(() => {
            workflowOverviewLayoutFrame = null;
            applyWorkflowOverviewLayout();
        });
    };

    const attachWorkflowOverviewResizeObserver = () => {
        workflowOverviewResizeObserver?.disconnect();
        workflowOverviewResizeObserver = null;

        if (typeof ResizeObserver === "undefined") {
            scheduleWorkflowOverviewLayoutUpdate();
            return;
        }

        const layout = getWorkflowOverviewLayout();
        if (!layout) {
            scheduleWorkflowOverviewLayoutUpdate();
            return;
        }

        const observer = new ResizeObserver(scheduleWorkflowOverviewLayoutUpdate);
        layout.observedElements.forEach((element) => observer.observe(element));
        workflowOverviewResizeObserver = observer;
        scheduleWorkflowOverviewLayoutUpdate();
    };

    const startWorkflowOverviewLayoutTracking = () => {
        if (!workflowOverviewWindowResizeHandler) {
            workflowOverviewWindowResizeHandler = scheduleWorkflowOverviewLayoutUpdate;
            window.addEventListener("resize", workflowOverviewWindowResizeHandler);
        }

        attachWorkflowOverviewResizeObserver();
        scheduleWorkflowOverviewLayoutUpdate();
    };

    const stopWorkflowOverviewLayoutTracking = () => {
        workflowOverviewResizeObserver?.disconnect();
        workflowOverviewResizeObserver = null;

        if (workflowOverviewWindowResizeHandler) {
            window.removeEventListener("resize", workflowOverviewWindowResizeHandler);
            workflowOverviewWindowResizeHandler = null;
        }

        if (workflowOverviewLayoutFrame !== null) {
            window.cancelAnimationFrame(workflowOverviewLayoutFrame);
            workflowOverviewLayoutFrame = null;
        }

        if (workflowOverviewSyncFrame !== null) {
            window.cancelAnimationFrame(workflowOverviewSyncFrame);
            workflowOverviewSyncFrame = null;
        }

        lastModalBounds = { left: Number.NaN, right: Number.NaN };
    };

    const scheduleWorkflowOverviewSync = (expectedState: boolean, requestId: number) => {
        if (workflowOverviewSyncFrame !== null) {
            window.cancelAnimationFrame(workflowOverviewSyncFrame);
        }

        let attempts = 0;
        const synchronize = () => {
            workflowOverviewSyncFrame = null;
            if (!isEditorOpen || requestId !== workflowOverviewToggleRequest) {
                return;
            }

            if (expectedState) {
                // Moving the LayerForge widget into fullscreen can cause
                // ComfyUI to re-apply the previously selected node. Re-sync
                // after the move as well, so an already-open properties panel
                // switches from LayerForge details to the global Nodes view.
                clearWorkflowOverviewSelection();
            }

            const panel = document.querySelector<HTMLElement>(workflowOverviewPanelSelector);
            const nodesTab = panel?.querySelector<HTMLButtonElement>(
                workflowOverviewNodesTabSelector
            ) ?? null;

            // Vue may need one extra frame to mount the global overview tabs after
            // ComfyUI's native toggle changes the panel state. Keep this retry
            // short and bounded so opening the panel never waits on a 1s poll.
            if (expectedState && (!panel || !nodesTab) && attempts < 6) {
                attempts += 1;
                workflowOverviewSyncFrame = window.requestAnimationFrame(synchronize);
                return;
            }

            if (expectedState && nodesTab && nodesTab.getAttribute("aria-selected") !== "true") {
                nodesTab.click();
            }

            attachWorkflowOverviewResizeObserver();
            applyWorkflowOverviewLayout();
        };

        workflowOverviewSyncFrame = window.requestAnimationFrame(synchronize);
    };

    const toggleWorkflowOverview = () => {
        const requestId = ++workflowOverviewToggleRequest;
        const nativeToggle = findNativeWorkflowOverviewToggle();
        if (!nativeToggle) {
            log.warn("Could not find ComfyUI's Workflow Overview toggle.");
            return;
        }

        const expectedState = !isWorkflowOverviewOpen();
        if (expectedState) {
            // Clear the selected node before ComfyUI renders the panel so its
            // first render is the global Workflow Overview, not node details.
            clearWorkflowOverviewSelection();
        }
        nativeToggle.click();
        if (expectedState) {
            // The native toggle has already run synchronously. Only the small
            // DOM/layout synchronization is deferred until the next frame.
            window.requestAnimationFrame(() => {
                if (!isEditorOpen || requestId !== workflowOverviewToggleRequest) {
                    return;
                }

                scheduleWorkflowOverviewSync(expectedState, requestId);
            });
            return;
        }

        scheduleWorkflowOverviewSync(expectedState, requestId);
    };

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

    const runWorkflowFromFullscreen = (): void => {
        // Use ComfyUI's own queue button when available. This preserves the
        // current batch count, queue mode, disabled state, and all native
        // prompt preparation hooks.
        const nativeQueueButton = document.querySelector<HTMLButtonElement>(
            'button[data-testid="queue-button"]'
        );
        if (nativeQueueButton) {
            nativeQueueButton.click();
            return;
        }

        // Older ComfyUI versions may not expose the current queue button
        // markup, but still provide the public queuePrompt API.
        const queuePrompt = (app as any)?.queuePrompt;
        if (typeof queuePrompt === 'function') {
            void queuePrompt.call(app, 0, 1);
            return;
        }

        showErrorNotification('Unable to find ComfyUI workflow run action.');
    };

    const closeEditor = () => {
        if (!isEditorOpen) {
            return;
        }

        stopWorkflowOverviewLayoutTracking();

        if (originalParent) {
            originalParent.appendChild(mainContainer);
        }
        if (backdrop?.parentNode) {
            backdrop.parentNode.removeChild(backdrop);
        }

        isEditorOpen = false;
        restoreWorkflowOverviewSelection();
        clearFullscreenButtonTooltips();
        modalContent = null;
        workflowOverviewToggleButton = null;
        workflowRunButton = null;
        openEditorBtn.textContent = "⛶";
        tooltipManager.setTooltip(openEditorBtn, "Open in Editor");

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

        clearWorkflowOverviewSelection();

        backdrop = $el("div.lf-painter-modal-backdrop") as HTMLDivElement;
        modalContent = $el("div.lf-painter-modal-content") as HTMLDivElement;

        workflowOverviewToggleButton = document.createElement("button");
        workflowOverviewToggleButton.type = "button";
        workflowOverviewToggleButton.className =
            "lf-painter-button lf-icon-button lf-workflow-overview-toggle";
        workflowOverviewToggleButton.setAttribute("aria-label", "Toggle Workflow Overview");
        workflowOverviewToggleButton.setAttribute("aria-pressed", "false");
        tooltipManager.setTooltip(workflowOverviewToggleButton, "Open Workflow Overview");

        const workflowOverviewIcon = document.createElement("i");
        workflowOverviewIcon.className = "icon-[lucide--panel-right] size-4";
        workflowOverviewIcon.setAttribute("aria-hidden", "true");
        workflowOverviewToggleButton.appendChild(workflowOverviewIcon);
        workflowOverviewToggleButton.onclick = () => {
            void toggleWorkflowOverview();
        };

        workflowRunButton = document.createElement("button");
        workflowRunButton.type = "button";
        workflowRunButton.className = "lf-painter-button lf-icon-button lf-workflow-run-button";
        workflowRunButton.setAttribute("aria-label", "Run workflow");
        tooltipManager.setTooltip(workflowRunButton, "Run workflow");

        const workflowRunIcon = document.createElement("i");
        workflowRunIcon.className = "icon-[lucide--play] size-4";
        workflowRunIcon.setAttribute("aria-hidden", "true");
        workflowRunButton.appendChild(workflowRunIcon);
        workflowRunButton.onclick = runWorkflowFromFullscreen;

        modalContent.appendChild(mainContainer);
        modalContent.appendChild(workflowRunButton);
        modalContent.appendChild(workflowOverviewToggleButton);
        backdrop.appendChild(modalContent);
        document.body.appendChild(backdrop);

        isEditorOpen = true;
        applyWorkflowOverviewLayout();
        startWorkflowOverviewLayoutTracking();
        if (isWorkflowOverviewOpen()) {
            scheduleWorkflowOverviewSync(true, workflowOverviewToggleRequest);
        }
        openEditorBtn.textContent = "X";
        tooltipManager.setTooltip(openEditorBtn, "Close Editor (ESC)");

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
            widgetDestroyed = true;
            stopWorkflowOverviewLayoutTracking();
            if (isEditorOpen) {
                document.removeEventListener('keydown', handleEscKey);
                if (backdrop?.parentNode) {
                    backdrop.parentNode.removeChild(backdrop);
                }
                isEditorOpen = false;
                workflowOverviewSelectionSnapshot = null;
                workflowOverviewSelectionCleared = false;
                clearFullscreenButtonTooltips();
                modalContent = null;
                workflowOverviewToggleButton = null;
                workflowRunButton = null;
            }
            unregisterTooltips();
            mattingAbortController?.abort();
            closeInputMenu();
            closeMattingSettings();
            stopMattingProgressPolling();
            stopMattingSpinner();
            if (mattingButton) {
                api.removeEventListener('matting_status', handleMattingStatus);
            }
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






export function registerLayerForgeExtension(): void {
    app.registerExtension({
    name: "Comfy.LayerForgeNode",

    init() {
        addStylesheet(getUrl('./css/canvas_view.css'));
        installLayerForgeMultiImagePromptPatch();
        installLayerForgeVirtualWirePatch();
        for (const delay of [0, 100, 500, 1200]) {
            setTimeout(installLayerForgeVirtualWirePatch, delay);
        }

        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (this: ComfyApp, _number: number, _prompt: any) {
            installLayerForgeMultiImagePromptPatch();
            installLayerForgeVirtualWirePatch();
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

                const nodeWithPreviewHook = this as any;
                const originalAddCustomWidget = nodeWithPreviewHook.addCustomWidget;
                if (typeof originalAddCustomWidget === "function" && !nodeWithPreviewHook.__layerForgePreviewWidgetHooked) {
                    nodeWithPreviewHook.addCustomWidget = function (customWidget: any, ...args: any[]) {
                        if (customWidget?.name === "$$canvas-image-preview" || customWidget?.type === "IMAGE_PREVIEW") {
                            const showPreviewWidget = this.widgets?.find((widget: any) => widget.name === "show_preview");
                            configureCanvasImagePreviewWidget(customWidget, showPreviewWidget?.value === true);
                        }

                        return originalAddCustomWidget.call(this, customWidget, ...args);
                    };
                    nodeWithPreviewHook.__layerForgePreviewWidgetHooked = true;
                }

                if (!(this as any).properties) {
                    (this as any).properties = {};
                }
                pruneLayerForgeTransportInputs(this);

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
                            const sourceNode = (this as any).graph?.getNodeById?.(sourceNodeId);
                            let sourceState = sourceNode
                                ? await getCanvasState(getCanvasStateKey(sourceNode))
                                : null;

                            // If source node doesn't exist (cross-workflow paste), try clipboard
                            if (!sourceState) {
                                log.debug(`No canvas state found for source node ${sourceNodeId}, checking clipboard`);
                                sourceState = await getCanvasState('__clipboard__');
                            }

                            if (!sourceState) {
                                log.debug(`No canvas state found in clipboard either`);
                                return;
                            }

                            await setCanvasState(getCanvasStateKey(this), sourceState);
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
                            // Check if input_image is connected, including virtual
                            // links restored from a saved workflow.
                            if (hasLayerForgeImageInput(this)) {
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

                if ((this as any).__layerForgeVirtualWireClearing) return;
                
                // Check if this is an input connection (type 1 = INPUT)
                if (type === 1) {
                    const inputName = String((this.inputs as any)?.[index]?.name || '');
                    const isImageInput = inputName === 'input_image' || isLayerForgeTransportInput(inputName) || index === 0;
                    const isMaskInput = inputName === 'input_mask' || index === 1;

                    if (connected && link_info && (inputName === 'input_image' || isLayerForgeTransportInput(inputName))) {
                        scheduleLayerForgeImageConnectionConversion(this, index, link_info);
                    }

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
                                    const opts = isMaskInput
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

                    // Handle input_image connection (including the virtual multi-link port)
                    if (isImageInput) {
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
                            if (getLayerForgeMaskInputSlot(this)?.link == null) {
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
                    if (isMaskInput) {
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
            nodeType.prototype.onExecuted = function (this: ComfyNode, _message: any) {
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
                cancelSAMDetectorMonitoring(this);

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
                        const sourceState = await getCanvasState(getCanvasStateKey(this));
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

                if (!(this as any).properties) {
                    (this as any).properties = {};
                }
                pruneLayerForgeTransportInputs(this);

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
                const impactOptions = options.filter((opt) => {
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

                const virtualImageLinks = getLayerForgeImageInputLinks(self);
                const newOptions = [
                    ...(virtualImageLinks.length > 0 ? [{
                        content: `Clear ${virtualImageLinks.length} connected input image${virtualImageLinks.length === 1 ? '' : 's'}`,
                        callback: () => {
                            const cleared = clearLayerForgeImageInputLinks(self);
                            if (!cleared) return;

                            self.setDirtyCanvas?.(true, true);
                            app.graph?.change?.();
                            const canvas = (self as any).canvasWidget?.canvas;
                            if (canvas) {
                                canvas.inputDataLoaded = false;
                                canvas.lastLoadedImageSrc = undefined;
                                canvas.lastLoadedLinkId = undefined;
                            }
                        },
                    }] : []),
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
}
