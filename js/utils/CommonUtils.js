/**
 * CommonUtils - Wspólne funkcje pomocnicze
 * Eliminuje duplikację funkcji używanych w różnych modułach
 */

/**
 * Generuje unikalny identyfikator UUID
 * @returns {string} UUID w formacie xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
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
 * @returns {Object} Obiekt z dx i dy
 */
export function getSnapAdjustment(layer, gridSize = 64, snapThreshold = 10) {
    if (!layer) {
        return {dx: 0, dy: 0};
    }

    const layerEdges = {
        left: layer.x,
        right: layer.x + layer.width,
        top: layer.y,
        bottom: layer.y + layer.height
    };
    
    const x_adjustments = [
        {type: 'x', delta: snapToGrid(layerEdges.left, gridSize) - layerEdges.left},
        {type: 'x', delta: snapToGrid(layerEdges.right, gridSize) - layerEdges.right}
    ];

    const y_adjustments = [
        {type: 'y', delta: snapToGrid(layerEdges.top, gridSize) - layerEdges.top},
        {type: 'y', delta: snapToGrid(layerEdges.bottom, gridSize) - layerEdges.bottom}
    ];
    
    x_adjustments.forEach(adj => adj.abs = Math.abs(adj.delta));
    y_adjustments.forEach(adj => adj.abs = Math.abs(adj.delta));
    
    const bestXSnap = x_adjustments
        .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
        .sort((a, b) => a.abs - b.abs)[0];
    const bestYSnap = y_adjustments
        .filter(adj => adj.abs < snapThreshold && adj.abs > 1e-9)
        .sort((a, b) => a.abs - b.abs)[0];
        
    return {
        dx: bestXSnap ? bestXSnap.delta : 0,
        dy: bestYSnap ? bestYSnap.delta : 0
    };
}

/**
 * Konwertuje współrzędne świata na lokalne
 * @param {number} worldX - Współrzędna X w świecie
 * @param {number} worldY - Współrzędna Y w świecie
 * @param {Object} layerProps - Właściwości warstwy
 * @returns {Object} Lokalne współrzędne {x, y}
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
 * @param {Object} layerProps - Właściwości warstwy
 * @returns {Object} Współrzędne świata {x, y}
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
 * Klonuje warstwy (bez klonowania obiektów Image dla oszczędności pamięci)
 * @param {Array} layers - Tablica warstw do sklonowania
 * @returns {Array} Sklonowane warstwy
 */
export function cloneLayers(layers) {
    return layers.map(layer => {
        const newLayer = {...layer};
        return newLayer;
    });
}

/**
 * Tworzy sygnaturę stanu warstw (dla porównań)
 * @param {Array} layers - Tablica warstw
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
            opacity: layer.opacity !== undefined ? Math.round(layer.opacity * 100) / 100 : 1
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
 * @returns {Function} Funkcja z debounce
 */
export function debounce(func, wait, immediate) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func(...args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func(...args);
    };
}

/**
 * Throttle funkcja - ogranicza częstotliwość wykonania
 * @param {Function} func - Funkcja do wykonania
 * @param {number} limit - Limit czasu w ms
 * @returns {Function} Funkcja z throttle
 */
export function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
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
 * @param {Object} contextOptions - Opcje kontekstu
 * @returns {Object} Obiekt z canvas i ctx
 */
export function createCanvas(width, height, contextType = '2d', contextOptions = {}) {
    const canvas = document.createElement('canvas');
    if (width) canvas.width = width;
    if (height) canvas.height = height;
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
 * @param {string|number} nodeId - Identyfikator node-a
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
