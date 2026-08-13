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
