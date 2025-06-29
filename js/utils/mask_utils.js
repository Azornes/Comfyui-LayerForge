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
