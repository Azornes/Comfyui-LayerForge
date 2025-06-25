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
        // Obiekty Image nie są klonowane, aby oszczędzać pamięć
        return newLayer;
    });
}

/**
 * Tworzy sygnaturę stanu warstw (dla porównań)
 * @param {Array} layers - Tablica warstw
 * @returns {string} Sygnatura JSON
 */
export function getStateSignature(layers) {
    return JSON.stringify(layers.map(layer => {
        const sig = {...layer};
        if (sig.imageId) {
            sig.imageId = sig.imageId;
        }
        delete sig.image;
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
 * Sprawdza czy wartość jest w zakresie
 * @param {number} value - Wartość do sprawdzenia
 * @param {number} min - Minimalna wartość
 * @param {number} max - Maksymalna wartość
 * @returns {boolean} Czy wartość jest w zakresie
 */
export function isInRange(value, min, max) {
    return value >= min && value <= max;
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
 * Oblicza odległość między dwoma punktami
 * @param {number} x1 - X pierwszego punktu
 * @param {number} y1 - Y pierwszego punktu
 * @param {number} x2 - X drugiego punktu
 * @param {number} y2 - Y drugiego punktu
 * @returns {number} Odległość
 */
export function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
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
