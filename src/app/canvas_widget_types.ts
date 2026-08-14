import type { Canvas } from "../canvas/canvas.js";

export interface CanvasWidget {
    canvas: Canvas;
    panel: HTMLDivElement;
    destroy?: () => void;
}
