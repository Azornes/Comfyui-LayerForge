export async function fetchMattingModelStatus(modelPath) {
    const query = modelPath
        ? `?model_path=${encodeURIComponent(modelPath)}`
        : '';
    const response = await fetch(`/matting/check-model${query}`);
    const data = await response.json();
    return { ok: response.ok, data };
}
export async function fetchMattingSettings() {
    const response = await fetch('/matting/settings');
    const data = await response.json();
    return { ok: response.ok, data };
}
export async function saveMattingSettings(settings) {
    const response = await fetch('/matting/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    const data = await response.json();
    return { ok: response.ok, data };
}
