export type CanvasBlobVariant = 'plain' | 'with-mask';
export type CanvasBlobSource = 'flattened' | 'native' | 'unsupported';

export interface CanvasBlobResolution {
    source: CanvasBlobSource;
    blob: Blob | null;
}

export interface CanvasBlobResolutionOptions {
    allowNativeCanvasFallback?: boolean;
}

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

export async function resolveCanvasBlob(
    canvas: any,
    variant: CanvasBlobVariant,
    options: CanvasBlobResolutionOptions = {},
): Promise<CanvasBlobResolution> {
    if (supportsFlattenedCanvasBlob(canvas, variant)) {
        return {
            source: 'flattened',
            blob: await getFlattenedCanvasBlob(canvas, variant),
        };
    }

    const isNativeCanvas = typeof HTMLCanvasElement !== 'undefined'
        && canvas instanceof HTMLCanvasElement;
    if (options.allowNativeCanvasFallback && isNativeCanvas) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
        return { source: 'native', blob };
    }

    return { source: 'unsupported', blob: null };
}
