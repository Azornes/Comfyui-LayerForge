import { createModuleLogger } from "./LoggerUtils.js";
const log = createModuleLogger('MaskUtils');
export function new_editor(app) {
    if (!app)
        return false;
    return !!app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');
}
function get_mask_editor_element(app) {
    return new_editor(app) ? document.getElementById('maskEditor') : document.getElementById('maskCanvas')?.parentElement ?? null;
}
export function mask_editor_showing(app) {
    const editor = get_mask_editor_element(app);
    return !!editor && editor.style.display !== "none";
}
export function hide_mask_editor(app) {
    if (mask_editor_showing(app)) {
        const editor = document.getElementById('maskEditor');
        if (editor) {
            editor.style.display = 'none';
        }
    }
}
function get_mask_editor_cancel_button(app) {
    const cancelButton = document.getElementById("maskEditor_topBarCancelButton");
    if (cancelButton) {
        log.debug("Found cancel button by ID: maskEditor_topBarCancelButton");
        return cancelButton;
    }
    const cancelSelectors = [
        'button[onclick*="cancel"]',
        'button[onclick*="Cancel"]',
        'input[value="Cancel"]'
    ];
    for (const selector of cancelSelectors) {
        try {
            const button = document.querySelector(selector);
            if (button) {
                log.debug("Found cancel button with selector:", selector);
                return button;
            }
        }
        catch (e) {
            log.warn("Invalid selector:", selector, e);
        }
    }
    const allButtons = document.querySelectorAll('button, input[type="button"]');
    for (const button of allButtons) {
        const text = button.textContent || button.value || '';
        if (text.toLowerCase().includes('cancel')) {
            log.debug("Found cancel button by text content:", text);
            return button;
        }
    }
    const editorElement = get_mask_editor_element(app);
    if (editorElement) {
        const childNodes = editorElement?.parentElement?.lastChild?.childNodes;
        if (childNodes && childNodes.length > 2 && childNodes[2] instanceof HTMLElement) {
            return childNodes[2];
        }
    }
    return null;
}
function get_mask_editor_save_button(app) {
    const saveButton = document.getElementById("maskEditor_topBarSaveButton");
    if (saveButton) {
        return saveButton;
    }
    const editorElement = get_mask_editor_element(app);
    if (editorElement) {
        const childNodes = editorElement?.parentElement?.lastChild?.childNodes;
        if (childNodes && childNodes.length > 2 && childNodes[2] instanceof HTMLElement) {
            return childNodes[2];
        }
    }
    return null;
}
export function mask_editor_listen_for_cancel(app, callback) {
    let attempts = 0;
    const maxAttempts = 50; // 5 sekund
    const findAndAttachListener = () => {
        attempts++;
        const cancel_button = get_mask_editor_cancel_button(app);
        if (cancel_button instanceof HTMLElement && !cancel_button.filter_listener_added) {
            log.info("Cancel button found, attaching listener");
            cancel_button.addEventListener('click', callback);
            cancel_button.filter_listener_added = true;
        }
        else if (attempts < maxAttempts) {
            setTimeout(findAndAttachListener, 100);
        }
        else {
            log.warn("Could not find cancel button after", maxAttempts, "attempts");
            const globalClickHandler = (event) => {
                const target = event.target;
                const text = target.textContent || target.value || '';
                if (target && (text.toLowerCase().includes('cancel') ||
                    target.id.toLowerCase().includes('cancel') ||
                    target.className.toLowerCase().includes('cancel'))) {
                    log.info("Cancel detected via global click handler");
                    callback();
                    document.removeEventListener('click', globalClickHandler);
                }
            };
            document.addEventListener('click', globalClickHandler);
            log.debug("Added global click handler for cancel detection");
        }
    };
    findAndAttachListener();
}
export function press_maskeditor_save(app) {
    const button = get_mask_editor_save_button(app);
    if (button instanceof HTMLElement) {
        button.click();
    }
}
export function press_maskeditor_cancel(app) {
    const button = get_mask_editor_cancel_button(app);
    if (button instanceof HTMLElement) {
        button.click();
    }
}
/**
 * Uruchamia mask editor z predefiniowaną maską
 * @param {Canvas} canvasInstance - Instancja Canvas
 * @param {HTMLImageElement | HTMLCanvasElement} maskImage - Obraz maski do nałożenia
 * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez istniejącej maski)
 */
export function start_mask_editor_with_predefined_mask(canvasInstance, maskImage, sendCleanImage = true) {
    if (!canvasInstance || !maskImage) {
        log.error('Canvas instance and mask image are required');
        return;
    }
    canvasInstance.startMaskEditor(maskImage, sendCleanImage);
}
/**
 * Uruchamia mask editor z automatycznym zachowaniem (czysty obraz + istniejąca maska)
 * @param {Canvas} canvasInstance - Instancja Canvas
 */
export function start_mask_editor_auto(canvasInstance) {
    if (!canvasInstance) {
        log.error('Canvas instance is required');
        return;
    }
    canvasInstance.startMaskEditor(null, true);
}
/**
 * Tworzy maskę z obrazu dla użycia w mask editorze
 * @param {string} imageSrc - Źródło obrazu (URL lub data URL)
 * @returns {Promise<HTMLImageElement>} Promise zwracający obiekt Image
 */
export function create_mask_from_image_src(imageSrc) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = imageSrc;
    });
}
/**
 * Konwertuje canvas do Image dla użycia jako maska
 * @param {HTMLCanvasElement} canvas - Canvas do konwersji
 * @returns {Promise<HTMLImageElement>} Promise zwracający obiekt Image
 */
export function canvas_to_mask_image(canvas) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = canvas.toDataURL();
    });
}
