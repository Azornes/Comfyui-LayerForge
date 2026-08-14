const CANVAS_BLOB_METHODS = {
    plain: 'getFlattenedCanvasAsBlob',
    'with-mask': 'getFlattenedCanvasWithMaskAsBlob'
};
export function supportsFlattenedCanvasBlob(canvas, variant) {
    const canvasLayers = canvas?.canvasLayers;
    return !!canvasLayers && typeof canvasLayers[CANVAS_BLOB_METHODS[variant]] === 'function';
}
export function getFlattenedCanvasBlob(canvas, variant) {
    return canvas.canvasLayers[CANVAS_BLOB_METHODS[variant]]();
}
export async function resolveCanvasBlob(canvas, variant, options = {}) {
    if (supportsFlattenedCanvasBlob(canvas, variant)) {
        return {
            source: 'flattened',
            blob: await getFlattenedCanvasBlob(canvas, variant),
        };
    }
    const isNativeCanvas = typeof HTMLCanvasElement !== 'undefined'
        && canvas instanceof HTMLCanvasElement;
    if (options.allowNativeCanvasFallback && isNativeCanvas) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        return { source: 'native', blob };
    }
    return { source: 'unsupported', blob: null };
}
