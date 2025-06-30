export function new_editor(app) {
    if (!app) return false;
    return app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor')
}

function get_mask_editor_element(app) {
    return new_editor(app) ? document.getElementById('maskEditor') : document.getElementById('maskCanvas')?.parentElement
}

export function mask_editor_showing(app) {
    const editor = get_mask_editor_element(app);
    return editor && editor.style.display !== "none";
}

export function hide_mask_editor() {
    if (mask_editor_showing()) document.getElementById('maskEditor').style.display = 'none'
}

function get_mask_editor_cancel_button(app) {
    if (document.getElementById("maskEditor_topBarCancelButton")) return document.getElementById("maskEditor_topBarCancelButton")
    return get_mask_editor_element(app)?.parentElement?.lastChild?.childNodes[2]
}

function get_mask_editor_save_button(app) {
    if (document.getElementById("maskEditor_topBarSaveButton")) return document.getElementById("maskEditor_topBarSaveButton")
    return get_mask_editor_element(app)?.parentElement?.lastChild?.childNodes[2]
}

export function mask_editor_listen_for_cancel(app, callback) {
    const cancel_button = get_mask_editor_cancel_button(app);
    if (cancel_button && !cancel_button.filter_listener_added) {
        cancel_button.addEventListener('click', callback);
        cancel_button.filter_listener_added = true;
    }
}

export function press_maskeditor_save(app) {
    get_mask_editor_save_button(app)?.click()
}

export function press_maskeditor_cancel(app) {
    get_mask_editor_cancel_button(app)?.click()
}

/**
 * Uruchamia mask editor z predefiniowaną maską
 * @param {Object} canvasInstance - Instancja Canvas
 * @param {Image|HTMLCanvasElement} maskImage - Obraz maski do nałożenia
 * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez istniejącej maski)
 */
export function start_mask_editor_with_predefined_mask(canvasInstance, maskImage, sendCleanImage = true) {
    if (!canvasInstance || !maskImage) {
        console.error('Canvas instance and mask image are required');
        return;
    }
    
    canvasInstance.startMaskEditor(maskImage, sendCleanImage);
}

/**
 * Uruchamia mask editor z automatycznym zachowaniem (czysty obraz + istniejąca maska)
 * @param {Object} canvasInstance - Instancja Canvas
 */
export function start_mask_editor_auto(canvasInstance) {
    if (!canvasInstance) {
        console.error('Canvas instance is required');
        return;
    }
    
    // Wywołaj bez parametrów - użyje domyślnych wartości (null, true)
    // Co oznacza: brak predefiniowanej maski, ale wyślij czysty obraz
    // i automatycznie nałóż istniejącą maskę z canvas
    canvasInstance.startMaskEditor();
}

/**
 * Tworzy maskę z obrazu dla użycia w mask editorze
 * @param {string} imageSrc - Źródło obrazu (URL lub data URL)
 * @returns {Promise<Image>} Promise zwracający obiekt Image
 */
export function create_mask_from_image_src(imageSrc) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = imageSrc;
    });
}

/**
 * Konwertuje canvas do Image dla użycia jako maska
 * @param {HTMLCanvasElement} canvas - Canvas do konwersji
 * @returns {Promise<Image>} Promise zwracający obiekt Image
 */
export function canvas_to_mask_image(canvas) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = canvas.toDataURL();
    });
}
