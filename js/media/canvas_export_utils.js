import { getFlattenedCanvasBlob } from './canvas_blob_utils.js';
function openBlob(blob) {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyBlob(blob) {
    const item = new ClipboardItem({ 'image/png': blob });
    await navigator.clipboard.write([item]);
}
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportCanvasImage(canvas, options) {
    const blob = await getFlattenedCanvasBlob(canvas, options.variant);
    if (!blob)
        return false;
    switch (options.action) {
        case 'open':
            openBlob(blob);
            return true;
        case 'copy':
            await copyBlob(blob);
            return true;
        case 'download':
            if (!options.filename) {
                throw new Error('Filename is required for canvas image download');
            }
            downloadBlob(blob, options.filename);
            return true;
    }
}
