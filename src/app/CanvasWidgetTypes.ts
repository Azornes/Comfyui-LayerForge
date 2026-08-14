import type { Canvas } from "../canvas/Canvas.js";

export interface CanvasWidget {
    canvas: Canvas;
    panel: HTMLDivElement;
    destroy?: () => void;
}
