import type { Layer } from '../types';

/**
 * CommonUtils - Wspólne funkcje pomocnicze
 * Eliminuje duplikację funkcji używanych w różnych modułach
 */

export interface Point {
    x: number;
    y: number;
}

/**
 * Generuje unikalny identyfikator UUID
 * @returns {string} UUID w formacie xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID(): string {
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
export function snapToGrid(value: number, gridSize = 64): number {
    return Math.round(value / gridSize) * gridSize;
}

/**
 * Oblicza dostosowanie snap dla warstwy
 * @param {Object} layer - Obiekt warstwy
 * @param {number} gridSize - Rozmiar siatki
 * @param {number} snapThreshold - Próg przyciągania
 * @returns {Point} Obiekt z dx i dy
 */
export function getSnapAdjustment(layer: Layer, gridSize = 64, snapThreshold = 10): Point {
    if (!layer) {
        return {x: 0, y: 0};
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
    ].map(adj => ({ ...adj, abs: Math.abs(adj.delta) }));

    const y_adjustments = [
        {type: 'y', delta: snapToGrid(layerEdges.top, gridSize) - layerEdges.top},
        {type: 'y', delta: snapToGrid(layerEdges.bottom, gridSize) - layerEdges.bottom}
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
export function worldToLocal(worldX: number, worldY: number, layerProps: { centerX: number, centerY: number, rotation: number }): Point {
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
export function localToWorld(localX: number, localY: number, layerProps: { centerX: number, centerY: number, rotation: number }): Point {
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
 * @param {Layer[]} layers - Tablica warstw do sklonowania
 * @returns {Layer[]} Sklonowane warstwy
 */
export function cloneLayers(layers: Layer[]): Layer[] {
    return layers.map(layer => ({ ...layer }));
}

/**
 * Tworzy sygnaturę stanu warstw (dla porównań)
 * @param {Layer[]} layers - Tablica warstw
 * @returns {string} Sygnatura JSON
 */
export function getStateSignature(layers: Layer[]): string {
    return JSON.stringify(layers.map((layer, index) => {
        const sig: any = {
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
export function debounce(func: (...args: any[]) => void, wait: number, immediate?: boolean): (...args: any[]) => void {
    let timeout: number | null;
    return function executedFunction(this: any, ...args: any[]) {
        const later = () => {
            timeout = null;
            if (!immediate) func.apply(this, args);
        };
        const callNow = immediate && !timeout;
        if (timeout) clearTimeout(timeout);
        timeout = window.setTimeout(later, wait);
        if (callNow) func.apply(this, args);
    };
}

/**
 * Throttle funkcja - ogranicza częstotliwość wykonania
 * @param {Function} func - Funkcja do wykonania
 * @param {number} limit - Limit czasu w ms
 * @returns {(...args: any[]) => void} Funkcja z throttle
 */
export function throttle(func: (...args: any[]) => void, limit: number): (...args: any[]) => void {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
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
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * Interpolacja liniowa między dwoma wartościami
 * @param {number} start - Wartość początkowa
 * @param {number} end - Wartość końcowa
 * @param {number} factor - Współczynnik interpolacji (0-1)
 * @returns {number} Interpolowana wartość
 */
export function lerp(start: number, end: number, factor: number): number {
    return start + (end - start) * factor;
}

/**
 * Konwertuje stopnie na radiany
 * @param {number} degrees - Stopnie
 * @returns {number} Radiany
 */
export function degreesToRadians(degrees: number): number {
    return degrees * Math.PI / 180;
}

/**
 * Konwertuje radiany na stopnie
 * @param {number} radians - Radiany
 * @returns {number} Stopnie
 */
export function radiansToDegrees(radians: number): number {
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
export function createCanvas(width: number, height: number, contextType = '2d', contextOptions: any = {}): { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D | null } {
    const canvas = document.createElement('canvas');
    if (width) canvas.width = width;
    if (height) canvas.height = height;
    const ctx = canvas.getContext(contextType, contextOptions) as CanvasRenderingContext2D | null;
    return { canvas, ctx };
}

/**
 * Normalizuje wartość do zakresu Uint8 (0-255)
 * @param {number} value - Wartość do znormalizowania (0-1)
 * @returns {number} Wartość w zakresie 0-255
 */
export function normalizeToUint8(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/**
 * Generuje unikalną nazwę pliku z identyfikatorem node-a
 * @param {string} baseName - Podstawowa nazwa pliku
 * @param {string | number} nodeId - Identyfikator node-a
 * @returns {string} Unikalna nazwa pliku
 */
export function generateUniqueFileName(baseName: string, nodeId: string | number): string {
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
export function isPointInRect(pointX: number, pointY: number, rectX: number, rectY: number, rectWidth: number, rectHeight: number): boolean {
    return pointX >= rectX && pointX <= rectX + rectWidth &&
        pointY >= rectY && pointY <= rectY + rectHeight;
}
