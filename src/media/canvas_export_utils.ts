import { getFlattenedCanvasBlob, type CanvasBlobVariant } from './canvas_blob_utils.js';

export type CanvasExportAction = 'open' | 'copy' | 'download';

export interface CanvasExportOptions {
    action: CanvasExportAction;
    variant: CanvasBlobVariant;
    filename?: string;
}

function openBlob(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyBlob(blob: Blob): Promise<void> {
    const item = new ClipboardItem({'image/png': blob});
    await navigator.clipboard.write([item]);
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportCanvasImage(canvas: any, options: CanvasExportOptions): Promise<boolean> {
    const blob = await getFlattenedCanvasBlob(canvas, options.variant);
    if (!blob) return false;

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
