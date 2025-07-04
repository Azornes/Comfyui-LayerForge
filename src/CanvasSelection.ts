import { createModuleLogger } from "./utils/LoggerUtils.js";

const log = createModuleLogger('CanvasSelection');

export class CanvasSelection {
    canvas: any;
    onSelectionChange: any;
    selectedLayer: any;
    selectedLayers: any;
    constructor(canvas: any) {
        this.canvas = canvas;
        this.selectedLayers = [];
        this.selectedLayer = null;
        this.onSelectionChange = null;
    }

    /**
     * Duplikuje zaznaczone warstwy (w pamięci, bez zapisu stanu)
     */
    duplicateSelectedLayers() {
        if (this.selectedLayers.length === 0) return [];

        const newLayers: any = [];
        const sortedLayers = [...this.selectedLayers].sort((a,b) => a.zIndex - b.zIndex);
        
        sortedLayers.forEach(layer => {
            const newLayer = {
                ...layer,
                id: `layer_${+new Date()}_${Math.random().toString(36).substr(2, 9)}`,
                zIndex: this.canvas.layers.length, // Nowa warstwa zawsze na wierzchu
            };
            this.canvas.layers.push(newLayer);
            newLayers.push(newLayer);
        });

        // Aktualizuj zaznaczenie, co powiadomi panel (ale nie renderuje go całego)
        this.updateSelection(newLayers);
        
        // Powiadom panel o zmianie struktury, aby się przerysował
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }
        
        log.info(`Duplicated ${newLayers.length} layers (in-memory).`);
        return newLayers;
    }

    /**
     * Aktualizuje zaznaczenie warstw i powiadamia wszystkie komponenty.
     * To jest "jedyne źródło prawdy" o zmianie zaznaczenia.
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection: any) {
        const previousSelection = this.selectedLayers.length;
        this.selectedLayers = newSelection || [];
        this.selectedLayer = this.selectedLayers.length > 0 ? this.selectedLayers[this.selectedLayers.length - 1] : null;
        
        // Sprawdź, czy zaznaczenie faktycznie się zmieniło, aby uniknąć pętli
        const hasChanged = previousSelection !== this.selectedLayers.length || 
                           this.selectedLayers.some((layer: any, i: any) => this.selectedLayers[i] !== (newSelection || [])[i]);

        if (!hasChanged && previousSelection > 0) {
           // return; // Zablokowane na razie, może powodować problemy
        }

        log.debug('Selection updated', {
            previousCount: previousSelection,
            newCount: this.selectedLayers.length,
            selectedLayerIds: this.selectedLayers.map((l: any) => l.id || 'unknown')
        });
        
        // 1. Zrenderuj ponownie canvas, aby pokazać nowe kontrolki transformacji
        this.canvas.render();

        // 2. Powiadom inne części aplikacji (jeśli są)
        if (this.onSelectionChange) {
            this.onSelectionChange();
        }

        // 3. Powiadom panel warstw, aby zaktualizował swój wygląd
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onSelectionChanged();
        }
    }

    /**
     * Logika aktualizacji zaznaczenia, wywoływana przez panel warstw.
     */
    updateSelectionLogic(layer: any, isCtrlPressed: any, isShiftPressed: any, index: any) {
        let newSelection = [...this.selectedLayers];
        let selectionChanged = false;

        if (isShiftPressed && this.canvas.canvasLayersPanel.lastSelectedIndex !== -1) {
            const sortedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);
            const startIndex = Math.min(this.canvas.canvasLayersPanel.lastSelectedIndex, index);
            const endIndex = Math.max(this.canvas.canvasLayersPanel.lastSelectedIndex, index);
            
            newSelection = [];
            for (let i = startIndex; i <= endIndex; i++) {
                if (sortedLayers[i]) {
                    newSelection.push(sortedLayers[i]);
                }
            }
            selectionChanged = true;
        } else if (isCtrlPressed) {
            const layerIndex = newSelection.indexOf(layer);
            if (layerIndex === -1) {
                newSelection.push(layer);
            } else {
                newSelection.splice(layerIndex, 1);
            }
            this.canvas.canvasLayersPanel.lastSelectedIndex = index;
            selectionChanged = true;
        } else {
            // Jeśli kliknięta warstwa nie jest częścią obecnego zaznaczenia,
            // wyczyść zaznaczenie i zaznacz tylko ją.
            if (!this.selectedLayers.includes(layer)) {
                newSelection = [layer];
                selectionChanged = true;
            }
            // Jeśli kliknięta warstwa JEST już zaznaczona (potencjalnie z innymi),
            // NIE rób nic, aby umożliwić przeciąganie całej grupy.
            this.canvas.canvasLayersPanel.lastSelectedIndex = index;
        }

        // Aktualizuj zaznaczenie tylko jeśli faktycznie się zmieniło
        if (selectionChanged) {
            this.updateSelection(newSelection);
        }
    }

    removeSelectedLayers() {
        if (this.selectedLayers.length > 0) {
            log.info('Removing selected layers', {
                layersToRemove: this.selectedLayers.length,
                totalLayers: this.canvas.layers.length
            });

            this.canvas.saveState();
            this.canvas.layers = this.canvas.layers.filter((l: any) => !this.selectedLayers.includes(l));
            
            this.updateSelection([]); 
            
            this.canvas.render();
            this.canvas.saveState();

            if (this.canvas.canvasLayersPanel) {
                this.canvas.canvasLayersPanel.onLayersChanged();
            }

            log.debug('Layers removed successfully, remaining layers:', this.canvas.layers.length);
        } else {
            log.debug('No layers selected for removal');
        }
    }

    /**
     * Aktualizuje zaznaczenie po operacji historii
     */
    updateSelectionAfterHistory() {
        const newSelectedLayers: any = [];
        if (this.selectedLayers) {
            this.selectedLayers.forEach((sl: any) => {
                const found = this.canvas.layers.find((l: any) => l.id === sl.id);
                if (found) newSelectedLayers.push(found);
            });
        }
        this.updateSelection(newSelectedLayers);
    }
}
