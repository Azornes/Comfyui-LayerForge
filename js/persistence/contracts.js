const isRecord = (value) => (typeof value === 'object' && value !== null);
const isFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value));
export function isPersistedCanvasState(value) {
    if (!isRecord(value) || !Array.isArray(value.layers))
        return false;
    const viewport = value.viewport;
    const outputAreaBounds = value.outputAreaBounds;
    if (!isRecord(viewport) || !isRecord(outputAreaBounds))
        return false;
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
export function isStateSaverMessage(value) {
    if (!isRecord(value) || typeof value.stateKey !== 'string' || value.stateKey.length === 0) {
        return false;
    }
    return isPersistedCanvasState(value.state);
}
