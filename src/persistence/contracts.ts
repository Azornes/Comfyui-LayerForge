import type {Layer, OutputAreaBounds, Viewport} from '../shared/types.js';

export type PersistedLayer = Omit<Layer, 'image'>;

export interface PersistedCanvasState {
    layers: PersistedLayer[];
    viewport: Viewport;
    width: number;
    height: number;
    outputAreaBounds: OutputAreaBounds;
}

export interface CanvasStateRecord {
    id: string;
    state: PersistedCanvasState;
}

export interface CanvasImageRecord {
    imageId: string;
    imageSrc: string | ImageBitmap;
}

export interface StateSaverMessage {
    stateKey: string;
    state: PersistedCanvasState;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null
);

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
);

export function isPersistedCanvasState(value: unknown): value is PersistedCanvasState {
    if (!isRecord(value) || !Array.isArray(value.layers)) return false;

    const viewport = value.viewport;
    const outputAreaBounds = value.outputAreaBounds;
    if (!isRecord(viewport) || !isRecord(outputAreaBounds)) return false;

    return isFiniteNumber(value.width)
        && isFiniteNumber(value.height)
        && isFiniteNumber(viewport.x)
        && isFiniteNumber(viewport.y)
        && isFiniteNumber(viewport.zoom)
        && isFiniteNumber(outputAreaBounds.x)
        && isFiniteNumber(outputAreaBounds.y)
        && isFiniteNumber(outputAreaBounds.width)
        && isFiniteNumber(outputAreaBounds.height);
}

export function isStateSaverMessage(value: unknown): value is StateSaverMessage {
    if (!isRecord(value) || typeof value.stateKey !== 'string' || value.stateKey.length === 0) {
        return false;
    }

    return isPersistedCanvasState(value.state);
}
