import type { Canvas as CanvasClass } from './Canvas';
import type { CanvasLayers } from './CanvasLayers';

export interface Layer {
    id: string;
    image: HTMLImageElement;
    imageId: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    rotation: number;
    zIndex: number;
    blendMode: string;
    opacity: number;
    visible: boolean;
    mask?: Float32Array;
    flipH?: boolean;
    flipV?: boolean;
    blendArea?: number;
}

export interface ComfyNode {
    id: number;
    imgs?: HTMLImageElement[];
    widgets: any[];
    size: [number, number];
    graph: any;
    canvasWidget?: any;
    onResize?: () => void;
    addDOMWidget: (name: string, type: string, element: HTMLElement, options?: any) => any;
    addWidget: (type: string, name: string, value: any, callback?: (value: any) => void, options?: any) => any;
    setDirtyCanvas: (force: boolean, dirty: boolean) => void;
}

declare global {
    interface Window {
        MaskEditorDialog?: {
            instance?: {
                getMessageBroker: () => any;
            };
        };
    }

    interface HTMLElement {
        getContext?(contextId: '2d', options?: any): CanvasRenderingContext2D | null;
        width: number;
        height: number;
    }
}

export interface Canvas {
    layers: Layer[];
    selectedLayer: Layer | null;
    canvasSelection: any;
    lastMousePosition: Point;
    width: number;
    height: number;
    node: ComfyNode;
    viewport: { x: number, y: number, zoom: number };
    canvas: HTMLCanvasElement;
    offscreenCanvas: HTMLCanvasElement;
    isMouseOver: boolean;
    maskTool: any;
    canvasLayersPanel: any;
    canvasState: any;
    widget?: { value: string };
    imageReferenceManager: any;
    imageCache: any;
    dataInitialized: boolean;
    pendingDataCheck: number | null;
    pendingBatchContext: any;
    canvasLayers: any;
    saveState: () => void;
    render: () => void;
    updateSelection: (layers: Layer[]) => void;
    requestSaveState: (immediate?: boolean) => void;
    saveToServer: (fileName: string) => Promise<any>;
    removeLayersByIds: (ids: string[]) => void;
    batchPreviewManagers: any[];
    getMouseWorldCoordinates: (e: MouseEvent) => Point;
    getMouseViewCoordinates: (e: MouseEvent) => Point;
    updateOutputAreaSize: (width: number, height: number) => void;
    undo: () => void;
    redo: () => void;
}

// A simplified interface for the Canvas class, containing only what ClipboardManager needs.
export interface CanvasForClipboard {
    canvasLayers: CanvasLayersForClipboard;
    node: ComfyNode;
}

// A simplified interface for the CanvasLayers class.
export interface CanvasLayersForClipboard {
    internalClipboard: Layer[];
    pasteLayers(): void;
    addLayerWithImage(image: HTMLImageElement, layerProps: Partial<Layer>, addMode: string): Promise<Layer | null>;
}

export type AddMode = 'mouse' | 'fit' | 'center' | 'default';

export type ClipboardPreference = 'system' | 'clipspace';

export interface WebSocketMessage {
    type: string;
    nodeId?: string;
    [key: string]: any;
}

export interface AckCallback {
    resolve: (value: WebSocketMessage | PromiseLike<WebSocketMessage>) => void;
    reject: (reason?: any) => void;
}

export type AckCallbacks = Map<string, AckCallback>;

export interface CanvasState {
    layersUndoStack: Layer[][];
    layersRedoStack: Layer[][];
    maskUndoStack: HTMLCanvasElement[];
    maskRedoStack: HTMLCanvasElement[];
    saveMaskState(): void;
}

export interface Point {
    x: number;
    y: number;
}

export interface Shape {
    points: Point[];
    isClosed: boolean;
}

export interface Viewport {
    x: number;
    y: number;
    zoom: number;
}

export interface Tensor {
    data: Float32Array;
    shape: number[];
    width: number;
    height: number;
}

export interface ImageDataPixel {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}
