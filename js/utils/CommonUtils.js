/**
 * Generuje unikalny identyfikator UUID
 * @returns {string} UUID w formacie xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
/**
 * Funkcja snap do siatki
 * @param {number} value - Wartość do przyciągnięcia
 * @param {number} gridSize - Rozmiar siatki (domyślnie 64)
 * @returns {number} Wartość przyciągnięta do siatki
 */
export function snapToGrid(value, gridSize = 64) {
    return Math.round(value / gridSize) * gridSize;
}
/**
 * Oblicza dostosowanie snap dla warstwy
 * @param {Object} layer - Obiekt warstwy
 * @param {number} gridSize - Rozmiar siatki
 * @param {number} snapThreshold - Próg przyciągania
 * @returns {Point} Obiekt z dx i dy
 */
export function getSnapAdjustment(layer, gridSize = 64, snapThreshold = 10) {
    if (!layer) {
        return { x: 0, y: 0 };
    }
    const layerEdges = {
        left: layer.x,
        right: layer.x + layer.width,
        top: layer.y,
        bottom: layer.y + layer.height
    };
    const x_adjustments = [
        { type: 'x', delta: snapToGrid(layerEdges.left, gridSize) - layerEdges.left },
        { type: 'x', delta: snapToGrid(layerEdges.right, gridSize) - layerEdges.right }
    ].map(adj => ({ ...adj, abs: Math.abs(adj.delta) }));
    const y_adjustments = [
        { type: 'y', delta: snapToGrid(layerEdges.top, gridSize) - layerEdges.top },
        { type: 'y', delta: snapToGrid(layerEdges.bottom, gridSize) - layerEdges.bottom }
    ].map(adj => ({ ...adj, abs: Math.abs(adj.delta) }));
    const bestXSnap = x_adjustments
        .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
        .sort((a, b) => a.abs - b.abs)[0];
    const bestYSnap = y_adjustments
        .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
        .sort((a, b) => a.abs - b.abs)[0];
    return {
        x: bestXSnap ? bestXSnap.delta : 0,
        y: bestYSnap ? bestYSnap.delta : 0
    };
}
/**
 * Konwertuje współrzędne świata na lokalne
 * @param {number} worldX - Współrzędna X w świecie
 * @param {number} worldY - Współrzędna Y w świecie
 * @param {any} layerProps - Właściwości warstwy
 * @returns {Point} Lokalne współrzędne {x, y}
 */
export function worldToLocal(worldX, worldY, layerProps) {
    const dx = worldX - layerProps.centerX;
    const dy = worldY - layerProps.centerY;
    const rad = -layerProps.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos
    };
}
/**
 * Konwertuje współrzędne lokalne na świat
 * @param {number} localX - Lokalna współrzędna X
 * @param {number} localY - Lokalna współrzędna Y
 * @param {any} layerProps - Właściwości warstwy
 * @returns {Point} Współrzędne świata {x, y}
 */
export function localToWorld(localX, localY, layerProps) {
    const rad = layerProps.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: layerProps.centerX + localX * cos - localY * sin,
        y: layerProps.centerY + localX * sin + localY * cos
    };
}
/**
 * Konwertuje współrzędne świata na wyśrodkowane współrzędne lokalne warstwy.
 */
export function worldToLayerLocal(worldX, worldY, layer) {
    return worldToLocal(worldX, worldY, {
        centerX: layer.x + layer.width / 2,
        centerY: layer.y + layer.height / 2,
        rotation: layer.rotation
    });
}
/**
 * Sprawdza punkt w lokalnych, wyśrodkowanych współrzędnych prostokątnej warstwy.
 */
export function isPointInLayerLocalBounds(localPoint, width, height) {
    return Math.abs(localPoint.x) <= width / 2 && Math.abs(localPoint.y) <= height / 2;
}
/**
 * Sprawdza, czy punkt świata znajduje się w obróconej warstwie.
 */
export function isPointInRotatedLayer(worldX, worldY, layer) {
    return isPointInLayerLocalBounds(worldToLayerLocal(worldX, worldY, layer), layer.width, layer.height);
}
/**
 * Zwraca narożniki warstwy w światowym układzie współrzędnych.
 * W trybie crop-aware używa widocznego fragmentu crop bounds, zachowując
 * istniejącą obsługę flipH i flipV.
 */
export function getLayerWorldCorners(layer, options = {}) {
    const center = {
        centerX: layer.x + layer.width / 2,
        centerY: layer.y + layer.height / 2,
        rotation: layer.rotation
    };
    let localCorners;
    if (options.cropAware && layer.cropMode && layer.cropBounds && layer.originalWidth && layer.originalHeight) {
        const layerScaleX = layer.width / layer.originalWidth;
        const layerScaleY = layer.height / layer.originalHeight;
        const cropWidth = layer.cropBounds.width * layerScaleX;
        const cropHeight = layer.cropBounds.height * layerScaleY;
        const effectiveCropX = layer.flipH
            ? layer.originalWidth - (layer.cropBounds.x + layer.cropBounds.width)
            : layer.cropBounds.x;
        const effectiveCropY = layer.flipV
            ? layer.originalHeight - (layer.cropBounds.y + layer.cropBounds.height)
            : layer.cropBounds.y;
        const cropOffsetX = effectiveCropX * layerScaleX;
        const cropOffsetY = effectiveCropY * layerScaleY;
        localCorners = [
            { x: cropOffsetX, y: cropOffsetY },
            { x: cropOffsetX + cropWidth, y: cropOffsetY },
            { x: cropOffsetX + cropWidth, y: cropOffsetY + cropHeight },
            { x: cropOffsetX, y: cropOffsetY + cropHeight }
        ].map(point => ({
            x: point.x - layer.width / 2,
            y: point.y - layer.height / 2
        }));
    }
    else {
        const halfW = layer.width / 2;
        const halfH = layer.height / 2;
        localCorners = [
            { x: -halfW, y: -halfH },
            { x: halfW, y: -halfH },
            { x: halfW, y: halfH },
            { x: -halfW, y: halfH }
        ];
    }
    return localCorners.map(point => localToWorld(point.x, point.y, center));
}
/**
 * Oblicza prostokąt obejmujący podane punkty.
 */
export function getBoundsFromPoints(points) {
    if (points.length === 0) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    const minX = Math.min(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const maxX = Math.max(...points.map(point => point.x));
    const maxY = Math.max(...points.map(point => point.y));
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}
/**
 * Oblicza światowy bounding box warstwy.
 */
export function getLayerWorldBounds(layer, options = {}) {
    return getBoundsFromPoints(getLayerWorldCorners(layer, options));
}
/**
 * Klonuje warstwy (bez klonowania obiektów Image dla oszczędności pamięci)
 * @param {Layer[]} layers - Tablica warstw do sklonowania
 * @returns {Layer[]} Sklonowane warstwy
 */
export function cloneLayers(layers) {
    return layers.map(layer => ({ ...layer }));
}
/**
 * Tworzy sygnaturę stanu warstw (dla porównań)
 * @param {Layer[]} layers - Tablica warstw
 * @returns {string} Sygnatura JSON
 */
export function getStateSignature(layers) {
    return JSON.stringify(layers.map((layer, index) => {
        const sig = {
            index: index,
            x: Math.round(layer.x * 100) / 100, // Round to avoid floating point precision issues
            y: Math.round(layer.y * 100) / 100,
            width: Math.round(layer.width * 100) / 100,
            height: Math.round(layer.height * 100) / 100,
            rotation: Math.round((layer.rotation || 0) * 100) / 100,
            zIndex: layer.zIndex,
            blendMode: layer.blendMode || 'normal',
            opacity: layer.opacity !== undefined ? Math.round(layer.opacity * 100) / 100 : 1,
            flipH: !!layer.flipH,
            flipV: !!layer.flipV
        };
        if (layer.imageId) {
            sig.imageId = layer.imageId;
        }
        if (layer.image && layer.image.src) {
            sig.imageSrc = layer.image.src.substring(0, 100); // First 100 chars to avoid huge signatures
        }
        return sig;
    }));
}
/**
 * Debounce funkcja - opóźnia wykonanie funkcji
 * @param {Function} func - Funkcja do wykonania
 * @param {number} wait - Czas oczekiwania w ms
 * @param {boolean} immediate - Czy wykonać natychmiast
 * @returns {(...args: any[]) => void} Funkcja z debounce
 */
export function debounce(func, wait, immediate) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate)
                func.apply(this, args);
        };
        const callNow = immediate && !timeout;
        if (timeout)
            clearTimeout(timeout);
        timeout = window.setTimeout(later, wait);
        if (callNow)
            func.apply(this, args);
    };
}
/**
 * Throttle funkcja - ogranicza częstotliwość wykonania
 * @param {Function} func - Funkcja do wykonania
 * @param {number} limit - Limit czasu w ms
 * @returns {(...args: any[]) => void} Funkcja z throttle
 */
export function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}
/**
 * Ogranicza wartość do zakresu
 * @param {number} value - Wartość do ograniczenia
 * @param {number} min - Minimalna wartość
 * @param {number} max - Maksymalna wartość
 * @returns {number} Ograniczona wartość
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
/**
 * Interpolacja liniowa między dwoma wartościami
 * @param {number} start - Wartość początkowa
 * @param {number} end - Wartość końcowa
 * @param {number} factor - Współczynnik interpolacji (0-1)
 * @returns {number} Interpolowana wartość
 */
export function lerp(start, end, factor) {
    return start + (end - start) * factor;
}
/**
 * Konwertuje stopnie na radiany
 * @param {number} degrees - Stopnie
 * @returns {number} Radiany
 */
export function degreesToRadians(degrees) {
    return degrees * Math.PI / 180;
}
/**
 * Konwertuje radiany na stopnie
 * @param {number} radians - Radiany
 * @returns {number} Stopnie
 */
export function radiansToDegrees(radians) {
    return radians * 180 / Math.PI;
}
/**
 * Tworzy canvas z kontekstem - eliminuje duplikaty w kodzie
 * @param {number} width - Szerokość canvas
 * @param {number} height - Wysokość canvas
 * @param {string} contextType - Typ kontekstu (domyślnie '2d')
 * @param {object} contextOptions - Opcje kontekstu
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D | null}} Obiekt z canvas i ctx
 */
export function createCanvas(width, height, contextType = '2d', contextOptions = {}) {
    const canvas = document.createElement('canvas');
    if (width)
        canvas.width = width;
    if (height)
        canvas.height = height;
    const ctx = canvas.getContext(contextType, contextOptions);
    return { canvas, ctx };
}
/**
 * Normalizuje wartość do zakresu Uint8 (0-255)
 * @param {number} value - Wartość do znormalizowania (0-1)
 * @returns {number} Wartość w zakresie 0-255
 */
export function normalizeToUint8(value) {
    return Math.max(0, Math.min(255, Math.round(value * 255)));
}
/**
 * Generuje unikalną nazwę pliku z identyfikatorem node-a
 * @param {string} baseName - Podstawowa nazwa pliku
 * @param {string | number} nodeId - Identyfikator node-a
 * @returns {string} Unikalna nazwa pliku
 */
export function generateUniqueFileName(baseName, nodeId) {
    const nodePattern = new RegExp(`_node_${nodeId}(?:_node_\\d+)*`);
    if (nodePattern.test(baseName)) {
        const cleanName = baseName.replace(/_node_\d+/g, '');
        const extension = cleanName.split('.').pop();
        const nameWithoutExt = cleanName.replace(`.${extension}`, '');
        return `${nameWithoutExt}_node_${nodeId}.${extension}`;
    }
    const extension = baseName.split('.').pop();
    const nameWithoutExt = baseName.replace(`.${extension}`, '');
    return `${nameWithoutExt}_node_${nodeId}.${extension}`;
}
/**
 * Sprawdza czy punkt jest w prostokącie
 * @param {number} pointX - X punktu
 * @param {number} pointY - Y punktu
 * @param {number} rectX - X prostokąta
 * @param {number} rectY - Y prostokąta
 * @param {number} rectWidth - Szerokość prostokąta
 * @param {number} rectHeight - Wysokość prostokąta
 * @returns {boolean} Czy punkt jest w prostokącie
 */
export function isPointInRect(pointX, pointY, rectX, rectY, rectWidth, rectHeight) {
    return pointX >= rectX && pointX <= rectX + rectWidth &&
        pointY >= rectY && pointY <= rectY + rectHeight;
}
