// @ts-ignore
import { app } from "../../../scripts/app.js";
// @ts-ignore
import { api } from "../../../scripts/api.js";
// @ts-ignore
import { ChangeTracker } from "../../../scripts/changeTracker.js";
// @ts-ignore
import { $el } from "../../../scripts/ui.js";
import { addStylesheet, getUrl, loadTemplate } from "../utils/ResourceManager.js";
import { Canvas, configureCanvasImagePreviewWidget } from "../canvas/Canvas.js";
import { canvasNodeInstances, installLayerForgeMultiImagePromptPatch, installLayerForgeVirtualWirePatch, isLayerForgeTransportInput, pruneLayerForgeTransportInputs, scheduleLayerForgeImageConnectionConversion, } from "./LayerForgeConnections.js";
import { clearAllCanvasStates, getCanvasState, setCanvasState } from "../persistence/db.js";
import { getCanvasStateKey } from "../utils/CanvasStateKey.js";
import { createCanvas } from "../utils/CommonUtils.js";
import { loadImageFromBlob } from "../media/ImageUtils.js";
import { createModuleLogger } from "../log_system/log_funcs.js";
import { showErrorNotification, showSuccessNotification, showInfoNotification, showWarningNotification } from "../utils/NotificationUtils.js";
import { iconLoader, LAYERFORGE_TOOLS } from "../utils/IconLoader.js";
import { exportCanvasImage } from "../media/CanvasExportUtils.js";
import { getFlattenedCanvasBlob } from "../media/CanvasBlobUtils.js";
import { loadPreviewImage } from "../media/PreviewUtils.js";
import { getImageAddMode } from "../utils/CanvasInputUtils.js";
import { clearLayerForgeImageInputLinks, getLayerForgeImageInputLinks, getLayerForgeMaskInputSlot, hasLayerForgeImageInput, } from "../utils/MultiImageInputUtils.js";
import { fetchMattingModelStatus, fetchMattingSettings, saveMattingSettings as saveMattingSettingsToServer, } from "../utils/MattingUtils.js";
import { setupSAMDetectorHook } from "../mask/SAMDetectorIntegration.js";
const log = createModuleLogger('Canvas_view');
const DEFAULT_MATTING_SETTINGS = {
    modelPath: '',
    mode: 'remove_background',
    threshold: 0.5,
    hfTokenConfigured: false,
};
const isMattingMode = (value) => {
    return value === 'remove_background'
        || value === 'remove_foreground'
        || value === 'mask_only'
        || value === 'mask_only_inverted';
};
const normalizeMattingSettings = (settings) => {
    const threshold = Number(settings.threshold);
    return {
        modelPath: typeof settings.modelPath === 'string' ? settings.modelPath : DEFAULT_MATTING_SETTINGS.modelPath,
        mode: isMattingMode(settings.mode) ? settings.mode : DEFAULT_MATTING_SETTINGS.mode,
        threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_MATTING_SETTINGS.threshold,
        hfTokenConfigured: settings.hfTokenConfigured === true,
    };
};
const fromServerMattingSettings = (settings) => normalizeMattingSettings({
    modelPath: settings.model_path,
    mode: settings.mode,
    threshold: settings.threshold,
    hfTokenConfigured: settings.hf_token_configured,
});
const loadMattingSettings = async () => {
    try {
        const response = await fetchMattingSettings();
        if (response.ok && response.data.settings) {
            return fromServerMattingSettings(response.data.settings);
        }
    }
    catch (error) {
        log.warn('Unable to load Matting settings from ComfyUI:', error);
    }
    return { ...DEFAULT_MATTING_SETTINGS };
};
const persistMattingSettings = async (settings, token, clearToken) => {
    const payload = {
        model_path: settings.modelPath,
        mode: settings.mode,
        threshold: settings.threshold,
    };
    if (token.trim())
        payload.hf_token = token.trim();
    if (clearToken)
        payload.clear_hf_token = true;
    const response = await saveMattingSettingsToServer(payload);
    if (!response.ok || !response.data.settings) {
        throw new Error(response.data.error || 'Unable to save Matting settings on the ComfyUI server.');
    }
    return fromServerMattingSettings(response.data.settings);
};
const getMattingModeLabel = (mode) => {
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
const isLayerForgeEditableElement = (target) => {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    return !!target.closest('.lf-painter-main-container input, .lf-painter-main-container textarea, .lf-painter-main-container select, .lf-painter-main-container [contenteditable="true"]');
};
const isLayerForgeShortcutContextElement = (target) => {
    return target instanceof HTMLElement && !!target.closest('.lf-painter-main-container');
};
const isLayerForgeShortcutContextActive = (event) => {
    if (event && isLayerForgeShortcutContextElement(event.target)) {
        return true;
    }
    if (isLayerForgeShortcutContextElement(document.activeElement)) {
        return true;
    }
    return !!document.querySelector(`.lf-painter-main-container[${LAYERFORGE_SHORTCUT_ACTIVE_ATTR}="true"]`);
};
const isLayerForgeEditableFocused = () => {
    return isLayerForgeEditableElement(document.activeElement);
};
const patchLayerForgeChangeTrackerUndoRedo = () => {
    const prototype = ChangeTracker?.prototype;
    if (!prototype || prototype[LAYERFORGE_CHANGE_TRACKER_PATCH_FLAG] || typeof prototype.undoRedo !== 'function') {
        return;
    }
    const originalUndoRedo = prototype.undoRedo;
    prototype.undoRedo = async function (event) {
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
async function createCanvasWidget(node, widget, app) {
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
    const helpTooltip = $el("div.lf-painter-tooltip", {
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
    const showMattingTooltip = (target, content) => {
        helpTooltip.classList.add('lf-matting-tooltip');
        showTooltip(target, content);
    };
    const hideMattingTooltip = () => {
        hideTooltip();
        helpTooltip.classList.remove('lf-matting-tooltip');
    };
    const createMattingTooltipBadge = (labelText, tooltipText) => {
        const badge = document.createElement('span');
        badge.className = 'lf-matting-tooltip-badge';
        badge.textContent = '?';
        badge.tabIndex = 0;
        badge.dataset.tooltip = tooltipText;
        badge.setAttribute('aria-label', `More information about ${labelText}`);
        const show = () => {
            const content = badge.dataset.tooltip;
            if (content)
                showMattingTooltip(badge, content);
        };
        const hide = () => hideMattingTooltip();
        badge.addEventListener('mouseenter', show);
        badge.addEventListener('focus', show);
        badge.addEventListener('mouseleave', hide);
        badge.addEventListener('blur', hide);
        badge.addEventListener('click', (event) => event.preventDefault());
        return badge;
    };
    let mattingSettingsBackdrop = null;
    let mattingSettingsEscapeHandler = null;
    const closeMattingSettings = () => {
        hideMattingTooltip();
        if (mattingSettingsEscapeHandler) {
            document.removeEventListener('keydown', mattingSettingsEscapeHandler);
            mattingSettingsEscapeHandler = null;
        }
        mattingSettingsBackdrop?.remove();
        mattingSettingsBackdrop = null;
    };
    const openMattingSettings = async () => {
        if (mattingSettingsBackdrop)
            return;
        const settings = await loadMattingSettings();
        let modelOptions = [];
        let modelStatusMessage = 'Model options are loaded from ComfyUI background-removal storage.';
        try {
            const { ok, data: status } = await fetchMattingModelStatus();
            if (ok) {
                if (Array.isArray(status.models)) {
                    modelOptions = status.models.filter((option) => (option && typeof option.path === 'string' && typeof option.label === 'string'));
                }
            }
            else {
                modelStatusMessage = 'Unable to read installed model options. Automatic selection remains available.';
            }
        }
        catch (error) {
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
        const createRow = (labelText, control, tooltipText) => {
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
                if (option.description)
                    remoteOption.title = option.description;
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
        const createModelLink = (label, url) => {
            const link = document.createElement('a');
            link.className = 'lf-matting-model-link';
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = label;
            return link;
        };
        const updateModelDetails = () => {
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
            modelDescription.textContent = selectedOption.description || (selectedOption.backend === 'rmbg'
                ? 'Local BRIA RMBG 2.0 model loaded through Transformers.'
                : 'Installed checkpoint validated by ComfyUI\'s native BiRefNet loader.');
            if (selectedOption.url) {
                modelLinks.appendChild(createModelLink('Model page', selectedOption.url));
            }
            if (selectedOption.project_url) {
                modelLinks.appendChild(createModelLink(selectedOption.backend === 'rmbg' ? 'BRIA project' : 'BiRefNet project', selectedOption.project_url));
            }
            modelDetails.hidden = false;
        };
        modelSelect.onchange = updateModelDetails;
        modelDetails.append(modelDescription, modelLinks);
        updateModelDetails();
        const modeSelect = document.createElement('select');
        modeSelect.className = 'lf-matting-settings-select';
        ['remove_background', 'remove_foreground', 'mask_only', 'mask_only_inverted'].forEach((mode) => {
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
            if (tokenInput.value.trim())
                clearTokenInput.checked = false;
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
        body.append(createRow('Model', modelSelect, 'Choose a local BiRefNet checkpoint or BRIA RMBG 2.0, or download an official model on first use.'), modelDetails, createRow('Processing mode', modeSelect, 'The selected mode controls what the Matting button creates from the detected mask.'), createRow('Mask threshold', thresholdContainer, 'Set to 0 for a soft alpha mask; higher values create a harder cutout.'), createRow('Hugging Face token', tokenContainer, 'Optional read token for gated models such as BRIA RMBG 2.0. It is stored only in the ComfyUI custom node settings file.'), modelStatus);
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
                await persistMattingSettings({
                    modelPath: modelSelect.value === 'auto' ? '' : modelSelect.value,
                    mode: modeSelect.value,
                    threshold: Number(thresholdInput.value),
                    hfTokenConfigured: settings.hfTokenConfigured,
                }, tokenInput.value, clearTokenInput.checked);
                closeMattingSettings();
                showInfoNotification('Matting settings saved.', 2000);
            }
            catch (error) {
                log.error('Unable to save Matting settings:', error);
                showErrorNotification(error instanceof Error ? error.message : 'Unable to save Matting settings.', 8000);
            }
            finally {
                saveButton.disabled = false;
            }
        };
        actions.append(resetButton, saveButton);
        dialog.append(header, body, actions);
        backdrop.appendChild(dialog);
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop)
                closeMattingSettings();
        });
        mattingSettingsEscapeHandler = (event) => {
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
    let inputMenu = null;
    let inputMenuOutsideHandler = null;
    let inputMenuEscapeHandler = null;
    let inputMenuRepositionHandler = null;
    const closeInputMenu = () => {
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
        inputMenu?.remove();
        inputMenu = null;
        showInputsButton?.setAttribute('aria-expanded', 'false');
    };
    const positionInputMenu = () => {
        if (!inputMenu || !showInputsButton)
            return;
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
    const getInputImageFileLabel = (image, fallback) => {
        const source = String(image.currentSrc || image.src || '');
        if (!source || /^data:/i.test(source))
            return fallback;
        let rawName = '';
        try {
            const parsedSource = new URL(source, window.location.href);
            rawName = parsedSource.searchParams.get('filename')
                || parsedSource.pathname.split('/').pop()
                || '';
        }
        catch {
            rawName = source.split(/[?#]/, 1)[0].split('/').pop() || '';
        }
        try {
            const decodedName = decodeURIComponent(rawName).trim();
            if (decodedName && decodedName.length <= 80)
                return decodedName;
        }
        catch {
            if (rawName && rawName.length <= 80)
                return rawName;
        }
        return fallback;
    };
    const renderInputMenu = (menu) => {
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
            item.title = 'Add this input image to the canvas';
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
            unlink.title = 'Disconnect this image input from LayerForge';
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
                    if (added)
                        closeInputMenu();
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
    function toggleInputMenu() {
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
        inputMenuOutsideHandler = (event) => {
            const target = event.target;
            if (target && (menu.contains(target) || showInputsButton.contains(target)))
                return;
            closeInputMenu();
        };
        inputMenuEscapeHandler = (event) => {
            if (event.key !== 'Escape')
                return;
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
    });
    showInputsButton.setAttribute('aria-haspopup', 'menu');
    showInputsButton.setAttribute('aria-expanded', 'false');
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
                    onmouseenter: (e) => {
                        const content = canvas.maskTool.isActive ? maskShortcuts : standardShortcuts;
                        showTooltip(e.target, content);
                    },
                    onmouseleave: hideTooltip
                }),
                $el("button.lf-painter-button.lf-primary", {
                    textContent: "Add Image",
                    title: "Add image from file",
                    onclick: () => {
                        const addMode = getImageAddMode(node.widgets);
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            const target = e.target;
                            if (!target.files)
                                return;
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
                            const addMode = getImageAddMode(node.widgets);
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
                                onchange: (e) => {
                                    const checked = e.target.checked;
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
                        const knobIcon = switchEl.querySelector('.lf-switch-knob .lf-switch-icon');
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
                        }
                        else {
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
                        $el("span.lf-switch-track"),
                        $el("span.lf-switch-labels", { style: { fontSize: "11px" } }, [
                            $el("span.lf-text-clipspace", {}, ["Crop"]),
                            $el("span.lf-text-system", {}, ["Transform"])
                        ]),
                        $el("span.lf-switch-knob", {}, [
                            $el("span.lf-switch-icon", { id: `crop-transform-icon-${node.id}` })
                        ])
                    ]);
                    const input = switchEl.querySelector('input[type="checkbox"]');
                    const knobIcon = switchEl.querySelector('.lf-switch-icon');
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
                    onclick: async (e) => {
                        const button = e.target.closest('.lf-matting-button');
                        if (button.classList.contains('lf-loading'))
                            return;
                        const mattingSettings = await loadMattingSettings();
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
                            const spinner = $el("div.lf-matting-spinner");
                            button.appendChild(spinner);
                            button.classList.add('lf-loading');
                            startMattingSpinner();
                            if (modelStatus.reason === 'not_downloaded') {
                                setMattingDownloadProgress(0);
                                startMattingProgressPolling();
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
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    image: imageData,
                                    model_path: mattingSettings.modelPath || "auto",
                                    mode: mattingSettings.mode,
                                    threshold: mattingSettings.threshold,
                                    node_id: String(node.id),
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
                                    }
                                    else if (result.error === "Matting Interrupted") {
                                        showWarningNotification(result.details || "Matting was interrupted by ComfyUI.", 6000);
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
                            if (mattingSettings.mode === 'mask_only' || mattingSettings.mode === 'mask_only_inverted') {
                                if (typeof result.draw_mask !== 'string') {
                                    throw new Error('Matting response did not contain a Draw Mask image.');
                                }
                                const drawMaskImage = new Image();
                                drawMaskImage.src = result.draw_mask;
                                await drawMaskImage.decode();
                                canvas.maskTool.setMaskForLayer(drawMaskImage, selectedLayer);
                                showSuccessNotification(mattingSettings.mode === 'mask_only_inverted'
                                    ? 'Inverted mask applied to Draw Mask.'
                                    : 'Generated mask applied to Draw Mask.');
                                return;
                            }
                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();
                            const newLayer = { ...selectedLayer, image: mattedImage, flipH: false, flipV: false };
                            delete newLayer.imageId;
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.canvasSelection.updateSelection([newLayer]);
                            canvas.canvasLayersPanel?.onLayersChanged();
                            // Invalidate processed image cache when layer image changes (matting)
                            canvas.canvasLayers.invalidateProcessedImageCache(newLayer.id);
                            canvas.render();
                            canvas.saveState();
                            showSuccessNotification(`${getMattingModeLabel(mattingSettings.mode)} successfully!`);
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
                    onclick: (e) => {
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
            $el("div.lf-painter-button-group", { id: "mask-controls" }, [
                $el("label.lf-clipboard-switch.lf-mask-switch", {
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
                    $el("span.lf-switch-track"),
                    $el("span.lf-switch-labels", { style: { fontSize: "11px" } }, [
                        $el("span.lf-text-clipspace", { style: { paddingRight: "22px" } }, ["On"]),
                        $el("span.lf-text-system", { style: { paddingLeft: "20px" } }, ["Off"])
                    ]),
                    $el("span.lf-switch-knob", {}, [
                        (() => {
                            // Ikona maski (SVG lub obrazek)
                            const iconContainer = document.createElement('span');
                            iconContainer.className = 'lf-switch-icon';
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
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn');
                        const maskControls = controlPanel.querySelector('#mask-controls');
                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('lf-primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => c.style.display = 'none');
                        }
                        else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('lf-primary');
                            maskControls.querySelectorAll('.mask-control').forEach((c) => c.style.display = 'flex');
                        }
                        setTimeout(() => canvas.render(), 0);
                    }
                }),
                $el("div.lf-painter-slider-container.mask-control", { style: { display: 'none' } }, [
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
                    $el("div.lf-slider-value", { id: "preview-opacity-value" }, ["50%"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", { style: { display: 'none' } }, [
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
                    $el("div.lf-slider-value", { id: "brush-size-value" }, ["20px"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", { style: { display: 'none' } }, [
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
                    $el("div.lf-slider-value", { id: "brush-strength-value" }, ["50%"])
                ]),
                $el("div.lf-painter-slider-container.mask-control", { style: { display: 'none' } }, [
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
                    $el("div.lf-slider-value", { id: "brush-hardness-value" }, ["50%"])
                ]),
                $el("button.lf-painter-button.mask-control", {
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
                        }
                        catch (e) {
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
                            }
                            catch (e) {
                                log.error("Failed to clear canvas cache:", e);
                                showErrorNotification("Error clearing canvas cache. Check the console for details.");
                            }
                        }
                    }
                })
            ])
        ])
    ]);
    const mattingButton = controlPanel.querySelector('.lf-matting-button');
    const mattingProgressTrack = document.createElement('span');
    mattingProgressTrack.className = 'lf-matting-download-progress';
    mattingProgressTrack.setAttribute('aria-hidden', 'true');
    const mattingProgressFill = document.createElement('span');
    mattingProgressFill.className = 'lf-matting-download-progress-fill';
    mattingProgressTrack.appendChild(mattingProgressFill);
    mattingButton?.appendChild(mattingProgressTrack);
    let mattingSpinnerAnimationFrame = null;
    let mattingProgressPollTimer = null;
    let mattingProgressPolling = false;
    const stopMattingSpinner = () => {
        if (mattingSpinnerAnimationFrame !== null) {
            window.cancelAnimationFrame(mattingSpinnerAnimationFrame);
            mattingSpinnerAnimationFrame = null;
        }
        const spinner = mattingButton?.querySelector('.lf-matting-spinner');
        if (spinner) {
            spinner.style.transform = '';
        }
    };
    const startMattingSpinner = () => {
        stopMattingSpinner();
        const spinner = mattingButton?.querySelector('.lf-matting-spinner');
        if (!spinner)
            return;
        const startedAt = performance.now();
        const animate = (timestamp) => {
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
    const setMattingDownloadProgress = (progress) => {
        if (!mattingButton)
            return;
        if (progress === null) {
            mattingButton.classList.remove('lf-downloading');
            mattingProgressFill.style.width = '0%';
            return;
        }
        const normalizedProgress = Math.min(100, Math.max(0, Number(progress) || 0));
        mattingButton.classList.add('lf-downloading');
        mattingProgressFill.style.width = `${normalizedProgress}%`;
    };
    const handleMattingStatus = (event) => {
        const eventPayload = event?.detail && typeof event.detail === 'object' ? event.detail : event;
        const payload = eventPayload?.data && typeof eventPayload.data === 'object'
            ? eventPayload.data
            : eventPayload;
        if (!payload || typeof payload.status !== 'string')
            return;
        if (payload.node_id !== undefined && String(payload.node_id) !== String(node.id)) {
            return;
        }
        if (payload.status === 'downloading') {
            setMattingDownloadProgress(Number(payload.progress) || 0);
        }
        else if (payload.status === 'completed' || payload.status === 'error') {
            setMattingDownloadProgress(null);
        }
    };
    const stopMattingProgressPolling = () => {
        mattingProgressPolling = false;
        if (mattingProgressPollTimer !== null) {
            window.clearTimeout(mattingProgressPollTimer);
            mattingProgressPollTimer = null;
        }
    };
    const pollMattingProgress = async () => {
        if (!mattingProgressPolling)
            return;
        try {
            const response = await fetch(`/matting/progress?node_id=${encodeURIComponent(String(node.id))}`, { cache: 'no-store' });
            if (response.ok) {
                handleMattingStatus({ detail: await response.json() });
            }
        }
        catch {
            // WebSocket events remain the primary path; polling is a best-effort fallback.
        }
        finally {
            if (mattingProgressPolling) {
                mattingProgressPollTimer = window.setTimeout(() => {
                    void pollMattingProgress();
                }, 250);
            }
        }
    };
    const startMattingProgressPolling = () => {
        stopMattingProgressPolling();
        mattingProgressPolling = true;
        void pollMattingProgress();
    };
    if (mattingButton) {
        api.addEventListener('matting_status', handleMattingStatus);
    }
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
        const mattingBtn = controlPanel.querySelector('.lf-matting-button');
        if (mattingBtn && !mattingBtn.classList.contains('lf-loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
        // --- Handle Crop/Transform Switch ---
        const switchEl = controlPanel.querySelector(`#crop-transform-switch-${node.id}`);
        if (switchEl) {
            const input = switchEl.querySelector('input');
            const knobIcon = switchEl.querySelector('.lf-switch-icon');
            const isDisabled = !hasSelection;
            switchEl.classList.toggle('lf-disabled', isDisabled);
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
                    toggleMaskBtn.classList.add('lf-primary');
                    maskIcon.style.opacity = '1';
                }
                else {
                    toggleMaskBtn.classList.remove('lf-primary');
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
                    }
                    else {
                        // For smaller images, use data URI as before
                        void loadPreviewImage(blob, {
                            source: 'canvas',
                            urlMode: 'data-url'
                        }).then(img => {
                            node.imgs = [img];
                            log.debug(`Using data URI for small image (${(blob.size / 1024).toFixed(1)}KB): ${img.src.substring(0, 50)}...`);
                        }).catch(() => undefined);
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
    const canvasContainer = $el("div.lf-painter-canvas-container.lf-painter-container", {
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
    }, [controlPanel, canvasContainer, layersPanelContainer]);
    const stopEditableClipboardLeak = (event) => {
        if (isLayerForgeEditableElement(event.target) || isLayerForgeEditableFocused()) {
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    };
    mainContainer.addEventListener('copy', stopEditableClipboardLeak);
    mainContainer.addEventListener('cut', stopEditableClipboardLeak);
    mainContainer.addEventListener('paste', stopEditableClipboardLeak);
    const setShortcutContextActive = (active) => {
        if (active) {
            mainContainer.setAttribute(LAYERFORGE_SHORTCUT_ACTIVE_ATTR, 'true');
        }
        else {
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
    const handleRootUndoRedo = (event) => {
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
        }
        else {
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
        node.addDOMWidget("mainContainer", "widget", mainContainer, {
            getMinHeight: getEditorWidgetHeight,
            getHeight: getEditorWidgetHeight,
        });
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
        backdrop = $el("div.lf-painter-modal-backdrop");
        const modalContent = $el("div.lf-painter-modal-content");
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
        panel: controlPanel,
        destroy: () => {
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
export function registerLayerForgeExtension() {
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
            app.queuePrompt = async function (number, prompt) {
                installLayerForgeMultiImagePromptPatch();
                installLayerForgeVirtualWirePatch();
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
                    var _a;
                    log.debug("CanvasNode onNodeCreated: Base widget setup.");
                    const r = onNodeCreated?.apply(this, arguments);
                    const nodeWithPreviewHook = this;
                    const originalAddCustomWidget = nodeWithPreviewHook.addCustomWidget;
                    if (typeof originalAddCustomWidget === "function" && !nodeWithPreviewHook.__layerForgePreviewWidgetHooked) {
                        nodeWithPreviewHook.addCustomWidget = function (customWidget, ...args) {
                            if (customWidget?.name === "$$canvas-image-preview" || customWidget?.type === "IMAGE_PREVIEW") {
                                const showPreviewWidget = this.widgets?.find((widget) => widget.name === "show_preview");
                                configureCanvasImagePreviewWidget(customWidget, showPreviewWidget?.value === true);
                            }
                            return originalAddCustomWidget.call(this, customWidget, ...args);
                        };
                        nodeWithPreviewHook.__layerForgePreviewWidgetHooked = true;
                    }
                    (_a = this).properties || (_a.properties = {});
                    pruneLayerForgeTransportInputs(this);
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
                                const sourceNode = this.graph?.getNodeById?.(sourceNodeId);
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
                            }
                            catch (error) {
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
                nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
                    log.info(`onConnectionsChange called: type=${type}, index=${index}, connected=${connected}`, link_info);
                    if (this.__layerForgeVirtualWireClearing)
                        return;
                    // Check if this is an input connection (type 1 = INPUT)
                    if (type === 1) {
                        const inputName = String(this.inputs?.[index]?.name || '');
                        const isImageInput = inputName === 'input_image' || isLayerForgeTransportInput(inputName) || index === 0;
                        const isMaskInput = inputName === 'input_mask' || index === 1;
                        if (connected && link_info && (inputName === 'input_image' || isLayerForgeTransportInput(inputName))) {
                            scheduleLayerForgeImageConnectionConversion(this, index, link_info);
                        }
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
                                        const opts = isMaskInput
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
                    const backdrop = document.querySelector('.lf-painter-modal-backdrop');
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
                            const sourceState = await getCanvasState(getCanvasStateKey(this));
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
                    var _a;
                    if (originalConfigure) {
                        originalConfigure.apply(this, [data]);
                    }
                    (_a = this).properties || (_a.properties = {});
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
                    const runCanvasExport = async (action, variant, filename) => {
                        const canvas = self.canvasWidget?.canvas;
                        if (!canvas)
                            return;
                        const withMask = variant === 'with-mask';
                        const imageLabel = withMask ? 'image with mask' : 'image';
                        try {
                            const exported = await exportCanvasImage(canvas, { action, variant, filename });
                            if (exported && action === 'copy') {
                                log.info(`${withMask ? 'Image with mask alpha' : 'Image'} copied to clipboard.`);
                            }
                        }
                        catch (error) {
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
                                    if (!cleared)
                                        return;
                                    self.setDirtyCanvas?.(true, true);
                                    app.graph?.change?.();
                                    const canvas = self.canvasWidget?.canvas;
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
                        options.unshift({ content: "___", disabled: true });
                    }
                    options.unshift(...newOptions);
                };
            }
        }
    });
}
