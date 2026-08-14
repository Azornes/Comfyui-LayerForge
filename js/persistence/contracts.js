export const CURRENT_PERSISTED_STATE_VERSION = 2;
const isRecord = (value) => (typeof value === 'object' && value !== null);
const isFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value));
const isPositiveFiniteNumber = (value) => (isFiniteNumber(value) && value > 0);
const isPersistedLayer = (value) => {
    if (!isRecord(value))
        return false;
    return (typeof value.imageId === 'string' && value.imageId.length > 0)
        || typeof value.imageSrc === 'string'
        || (typeof value.imageSrc === 'object' && value.imageSrc !== null);
};
const isViewport = (value) => (isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.zoom));
const isOutputAreaBounds = (value) => (isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height));
/**
 * Normalize current and legacy IndexedDB records before they reach CanvasState.
 * Older records may omit the version, viewport, output bounds, or use imageSrc.
 */
export function migratePersistedCanvasState(value) {
    if (!isRecord(value) || !Array.isArray(value.layers))
        return null;
    const layers = value.layers.filter(isPersistedLayer).map(layer => ({ ...layer }));
    if (value.layers.length > 0 && layers.length === 0)
        return null;
    const width = isPositiveFiniteNumber(value.width) ? value.width : 512;
    const height = isPositiveFiniteNumber(value.height) ? value.height : 512;
    const viewport = isViewport(value.viewport)
        ? value.viewport
        : { x: -(width / 4), y: -(height / 4), zoom: 0.8 };
    const outputAreaBounds = isOutputAreaBounds(value.outputAreaBounds)
        ? value.outputAreaBounds
        : { x: -(width / 4), y: -(height / 4), width, height };
    return {
        version: CURRENT_PERSISTED_STATE_VERSION,
        layers,
        viewport,
        width,
        height,
        outputAreaBounds,
    };
}
export function isPersistedCanvasState(value) {
    if (!isRecord(value) || !Array.isArray(value.layers))
        return false;
    const viewport = value.viewport;
    const outputAreaBounds = value.outputAreaBounds;
    if (!isViewport(viewport) || !isOutputAreaBounds(outputAreaBounds))
        return false;
    return isFiniteNumber(value.width)
        && isFiniteNumber(value.height)
        && value.layers.every(isPersistedLayer);
}
export function isStateSaverMessage(value) {
    if (!isRecord(value) || typeof value.stateKey !== 'string' || value.stateKey.length === 0) {
        return false;
    }
    return isPersistedCanvasState(value.state);
}
