export async function fetchMattingModelStatus(modelPath) {
    const query = modelPath
        ? `?model_path=${encodeURIComponent(modelPath)}`
        : '';
    const response = await fetch(`/matting/check-model${query}`);
    const data = await response.json();
    return { ok: response.ok, data };
}
