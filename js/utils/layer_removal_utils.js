export function removeLayersWithLifecycle(canvas, shouldRemove, onRemoved) {
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
