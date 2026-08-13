export type CanvasBlobVariant = 'plain' | 'with-mask';

const CANVAS_BLOB_METHODS: Record<CanvasBlobVariant, string> = {
    plain: 'getFlattenedCanvasAsBlob',
    'with-mask': 'getFlattenedCanvasWithMaskAsBlob'
};

export function supportsFlattenedCanvasBlob(canvas: any, variant: CanvasBlobVariant): boolean {
    const canvasLayers = canvas?.canvasLayers;
    return !!canvasLayers && typeof canvasLayers[CANVAS_BLOB_METHODS[variant]] === 'function';
}

export function getFlattenedCanvasBlob(canvas: any, variant: CanvasBlobVariant): Promise<Blob | null> {
    return canvas.canvasLayers[CANVAS_BLOB_METHODS[variant]]();
}
