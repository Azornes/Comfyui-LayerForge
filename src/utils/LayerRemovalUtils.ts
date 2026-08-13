import type { Layer } from '../types';

export interface LayerRemovalCanvas {
    layers: Layer[];
    canvasSelection: {
        selectedLayers: Layer[];
        updateSelection: (layers: Layer[]) => void;
    };
    saveState: () => void;
    render: () => void;
    canvasLayersPanel?: {
        onLayersChanged?: () => void;
    };
}

export function removeLayersWithLifecycle(
    canvas: LayerRemovalCanvas,
    shouldRemove: (layer: Layer) => boolean,
    onRemoved: (removedCount: number) => void,
): void {
    const initialCount = canvas.layers.length;

    canvas.saveState();
    canvas.layers = canvas.layers.filter(layer => !shouldRemove(layer));

    const newSelection = canvas.canvasSelection.selectedLayers.filter(layer => !shouldRemove(layer));
    canvas.canvasSelection.updateSelection(newSelection);

    canvas.render();
    canvas.saveState();

    canvas.canvasLayersPanel?.onLayersChanged?.();
    onRemoved(initialCount - canvas.layers.length);
}
