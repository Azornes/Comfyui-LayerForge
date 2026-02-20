import { createModuleLogger } from "./utils/LoggerUtils.js";
import { iconLoader, LAYERFORGE_TOOLS } from "./utils/IconLoader.js";
import { createCanvas } from "./utils/CommonUtils.js";
import { addStylesheet, getUrl } from "./utils/ResourceManager.js";
import type { Canvas } from './Canvas';
import type { Layer } from './types';

const log = createModuleLogger('CanvasLayersPanel');

export class CanvasLayersPanel {
    private canvas: Canvas;
    private container: HTMLElement | null;
    private layersContainer: HTMLElement | null;
    private draggedElements: Layer[];
    private dragInsertionLine: HTMLElement | null;
    private isMultiSelecting: boolean;
    private lastSelectedIndex: number;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this.container = null;
        this.layersContainer = null;
        this.draggedElements = [];
        this.dragInsertionLine = null;
        this.isMultiSelecting = false;
        this.lastSelectedIndex = -1;

        this.handleLayerClick = this.handleLayerClick.bind(this);
        this.handleDragStart = this.handleDragStart.bind(this);
        this.handleDragOver = this.handleDragOver.bind(this);
        this.handleDragEnd = this.handleDragEnd.bind(this);
        this.handleDrop = this.handleDrop.bind(this);

        // Preload icons
        this.initializeIcons();

        // Load CSS for layers panel
        addStylesheet(getUrl('./css/layers_panel.css'));

        log.info('CanvasLayersPanel initialized');
    }

    private async initializeIcons(): Promise<void> {
        try {
            await iconLoader.preloadToolIcons();
            log.debug('Icons preloaded successfully');
        } catch (error) {
            log.warn('Failed to preload icons, using fallbacks:', error);
        }
    }

    private createIconElement(toolName: string, size: number = 16): HTMLElement {
        const iconContainer = document.createElement('div');
        iconContainer.className = 'icon-container';
        iconContainer.style.width = `${size}px`;
        iconContainer.style.height = `${size}px`;

        const icon = iconLoader.getIcon(toolName);
        if (icon) {
            if (icon instanceof HTMLImageElement) {
                const img = icon.cloneNode() as HTMLImageElement;
                img.style.width = `${size}px`;
                img.style.height = `${size}px`;
                iconContainer.appendChild(img);
            } else if (icon instanceof HTMLCanvasElement) {
                const { canvas, ctx } = createCanvas(size, size);
                if (ctx) {
                    ctx.drawImage(icon, 0, 0, size, size);
                }
                iconContainer.appendChild(canvas);
            }
        } else {
            // Fallback text
            iconContainer.classList.add('fallback-text');
            iconContainer.textContent = toolName.charAt(0).toUpperCase();
            iconContainer.style.fontSize = `${size * 0.6}px`;
        }

        return iconContainer;
    }

    private createVisibilityIcon(isVisible: boolean): HTMLElement {
        if (isVisible) {
            return this.createIconElement(LAYERFORGE_TOOLS.VISIBILITY, 16);
        } else {
            // Create a "hidden" version of the visibility icon
            const iconContainer = document.createElement('div');
            iconContainer.className = 'icon-container visibility-hidden';
            iconContainer.style.width = '16px';
            iconContainer.style.height = '16px';

            const icon = iconLoader.getIcon(LAYERFORGE_TOOLS.VISIBILITY);
            if (icon) {
                if (icon instanceof HTMLImageElement) {
                    const img = icon.cloneNode() as HTMLImageElement;
                    img.style.width = '16px';
                    img.style.height = '16px';
                    iconContainer.appendChild(img);
                } else if (icon instanceof HTMLCanvasElement) {
                    const { canvas, ctx } = createCanvas(16, 16);
                    if (ctx) {
                        ctx.globalAlpha = 0.3;
                        ctx.drawImage(icon, 0, 0, 16, 16);
                    }
                    iconContainer.appendChild(canvas);
                }
            } else {
                // Fallback
                iconContainer.classList.add('fallback-text');
                iconContainer.textContent = 'H';
                iconContainer.style.fontSize = '10px';
            }

            return iconContainer;
        }
    }

    createPanelStructure(): HTMLElement {
        this.container = document.createElement('div');
        this.container.className = 'layers-panel';
        this.container.tabIndex = 0; // Umożliwia fokus na panelu
        this.container.innerHTML = `
            <div class="layers-panel-header">
                <div class="master-visibility-toggle" title="Toggle all layers visibility"></div>
                <span class="layers-panel-title">Layers</span>
                <div class="layers-panel-controls">
                    <button class="layers-btn" id="delete-layer-btn" title="Delete layer"></button>
                </div>
            </div>
            <div class="layers-container" id="layers-container">
                <!-- Lista warstw będzie renderowana tutaj -->
            </div>
        `;

        this.layersContainer = this.container.querySelector<HTMLElement>('#layers-container');

        // Setup event listeners dla przycisków
        this.setupControlButtons();
        this.setupMasterVisibilityToggle();

        // Dodaj listener dla klawiatury, aby usuwanie działało z panelu
        this.container.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                this.deleteSelectedLayers();
                return;
            }

            // Handle Ctrl+C/V for layer copy/paste when panel has focus
            if (e.ctrlKey || e.metaKey) {
                if (e.key.toLowerCase() === 'c') {
                    if (this.canvas.canvasSelection.selectedLayers.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.canvas.canvasLayers.copySelectedLayers();
                        log.info('Layers copied from panel');
                    }
                } else if (e.key.toLowerCase() === 'v') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.canvas.canvasLayers.internalClipboard.length > 0) {
                        this.canvas.canvasLayers.pasteLayers();
                        log.info('Layers pasted from panel');
                    }
                }
            }
        });

        log.debug('Panel structure created');
        return this.container;
    }


    setupControlButtons(): void {
        if (!this.container) return;
        const deleteBtn = this.container.querySelector('#delete-layer-btn') as HTMLButtonElement;

        // Add delete icon to button
        if (deleteBtn) {
            const deleteIcon = this.createIconElement(LAYERFORGE_TOOLS.DELETE, 16);
            deleteBtn.appendChild(deleteIcon);
        }

        deleteBtn?.addEventListener('click', () => {
            log.info('Delete layer button clicked');
            this.deleteSelectedLayers();
        });

        // Initial button state update
        this.updateButtonStates();
    }

    setupMasterVisibilityToggle(): void {
        if (!this.container) return;
        const toggleContainer = this.container.querySelector('.master-visibility-toggle') as HTMLElement;
        if (!toggleContainer) return;

        const updateToggleState = () => {
            const total = this.canvas.layers.length;
            const visibleCount = this.canvas.layers.filter(l => l.visible).length;
            toggleContainer.innerHTML = '';

            const checkboxContainer = document.createElement('div');
            checkboxContainer.className = 'checkbox-container';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = 'master-visibility-checkbox';

            const customCheckbox = document.createElement('span');
            customCheckbox.className = 'custom-checkbox';

            checkboxContainer.appendChild(checkbox);
            checkboxContainer.appendChild(customCheckbox);

            if (visibleCount === 0) {
                checkbox.checked = false;
                checkbox.indeterminate = false;
                customCheckbox.classList.remove('checked', 'indeterminate');
            } else if (visibleCount === total) {
                checkbox.checked = true;
                checkbox.indeterminate = false;
                customCheckbox.classList.add('checked');
                customCheckbox.classList.remove('indeterminate');
            } else {
                checkbox.checked = false;
                checkbox.indeterminate = true;
                customCheckbox.classList.add('indeterminate');
                customCheckbox.classList.remove('checked');
            }

            checkboxContainer.addEventListener('click', (e) => {
                e.stopPropagation();
                let newVisible: boolean;
                if (checkbox.indeterminate) {
                    newVisible = false; // hide all when mixed
                } else if (checkbox.checked) {
                    newVisible = false; // toggle to hide all
                } else {
                    newVisible = true; // toggle to show all
                }

                this.canvas.layers.forEach(layer => {
                    layer.visible = newVisible;
                });
                this.canvas.render();
                this.canvas.requestSaveState();
                updateToggleState();
                this.renderLayers();
            });

            toggleContainer.appendChild(checkboxContainer);
        };

        updateToggleState();
        this._updateMasterVisibilityToggle = updateToggleState;
    }

    private _updateMasterVisibilityToggle?: () => void;

    renderLayers(): void {
        if (!this.layersContainer) {
            log.warn('Layers container not initialized');
            return;
        }

        // Wyczyść istniejącą zawartość
        this.layersContainer.innerHTML = '';

        // Usuń linię wstawiania jeśli istnieje
        this.removeDragInsertionLine();

        // Sortuj warstwy według zIndex (od najwyższej do najniższej)
        const sortedLayers = [...this.canvas.layers].sort((a: Layer, b: Layer) => b.zIndex - a.zIndex);

        sortedLayers.forEach((layer: Layer, index: number) => {
            const layerElement = this.createLayerElement(layer, index);
            if (this.layersContainer)
                this.layersContainer.appendChild(layerElement);
        });

        if (this._updateMasterVisibilityToggle) this._updateMasterVisibilityToggle();
        log.debug(`Rendered ${sortedLayers.length} layers`);
    }

    createLayerElement(layer: Layer, index: number): HTMLElement {
        const layerRow = document.createElement('div');
        layerRow.className = 'layer-row';
        layerRow.draggable = true;
        layerRow.dataset.layerIndex = String(index);

        const isSelected = this.canvas.canvasSelection.selectedLayers.includes(layer);
        if (isSelected) {
            layerRow.classList.add('selected');
        }

        // Ustawienie domyślnych właściwości jeśli nie istnieją
        if (!layer.name) {
            layer.name = this.ensureUniqueName(`Layer ${layer.zIndex + 1}`, layer);
        } else {
            // Sprawdź unikalność istniejącej nazwy (np. przy duplikowaniu)
            layer.name = this.ensureUniqueName(layer.name, layer);
        }

        layerRow.innerHTML = `
            <div class="layer-visibility-toggle" data-layer-index="${index}" title="Toggle layer visibility"></div>
            <div class="layer-thumbnail" data-layer-index="${index}"></div>
            <span class="layer-name" data-layer-index="${index}">${layer.name}</span>
        `;

        // Add visibility icon
        const visibilityToggle = layerRow.querySelector<HTMLElement>('.layer-visibility-toggle');
        if (visibilityToggle) {
            const visibilityIcon = this.createVisibilityIcon(layer.visible);
            visibilityToggle.appendChild(visibilityIcon);
        }

        const thumbnailContainer = layerRow.querySelector<HTMLElement>('.layer-thumbnail');
        if (thumbnailContainer) {
            this.generateThumbnail(layer, thumbnailContainer);
        }

        this.setupLayerEventListeners(layerRow, layer, index);

        return layerRow;
    }

    generateThumbnail(layer: Layer, thumbnailContainer: HTMLElement): void {
        if (!layer.image) {
            thumbnailContainer.style.background = '#4a4a4a';
            return;
        }

        const { canvas, ctx } = createCanvas(48, 48, '2d', { willReadFrequently: true });
        if (!ctx) return;

        const scale = Math.min(48 / layer.image.width, 48 / layer.image.height);
        const scaledWidth = layer.image.width * scale;
        const scaledHeight = layer.image.height * scale;

        // Wycentruj obraz
        const x = (48 - scaledWidth) / 2;
        const y = (48 - scaledHeight) / 2;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(layer.image, x, y, scaledWidth, scaledHeight);

        thumbnailContainer.appendChild(canvas);
    }

    setupLayerEventListeners(layerRow: HTMLElement, layer: Layer, index: number): void {
        layerRow.addEventListener('mousedown', (e: MouseEvent) => {
            const nameElement = layerRow.querySelector<HTMLElement>('.layer-name');
            if (nameElement && nameElement.classList.contains('editing')) {
                return;
            }
            this.handleLayerClick(e, layer, index);
        });

        // --- PRAWY PRZYCISK: ODJAZNACZ LAYER ---
        layerRow.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                const newSelection = this.canvas.canvasSelection.selectedLayers.filter((l: Layer) => l !== layer);
                this.canvas.updateSelection(newSelection);
                this.updateSelectionAppearance();
                this.updateButtonStates();
            }
        });

        layerRow.addEventListener('dblclick', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const nameElement = layerRow.querySelector<HTMLElement>('.layer-name');
            if (nameElement) {
                this.startEditingLayerName(nameElement, layer);
            }
        });

        // Add visibility toggle event listener
        const visibilityToggle = layerRow.querySelector<HTMLElement>('.layer-visibility-toggle');
        if (visibilityToggle) {
            visibilityToggle.addEventListener('click', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleLayerVisibility(layer);
            });
        }

        layerRow.addEventListener('dragstart', (e: DragEvent) => this.handleDragStart(e, layer, index));
        layerRow.addEventListener('dragover', this.handleDragOver.bind(this));
        layerRow.addEventListener('dragend', this.handleDragEnd.bind(this));
        layerRow.addEventListener('drop', (e: DragEvent) => this.handleDrop(e, index));
    }

    handleLayerClick(e: MouseEvent, layer: Layer, index: number): void {
        const isCtrlPressed = e.ctrlKey || e.metaKey;
        const isShiftPressed = e.shiftKey;

        // Aktualizuj wewnętrzny stan zaznaczenia w obiekcie canvas
        // Ta funkcja NIE powinna już wywoływać onSelectionChanged w panelu.
        this.canvas.updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index);

        // Aktualizuj tylko wygląd (klasy CSS), bez niszczenia DOM
        this.updateSelectionAppearance();
        this.updateButtonStates();

        // Focus the canvas so keyboard shortcuts (like Ctrl+C/V) work for layer operations
        this.canvas.canvas.focus();

        log.debug(`Layer clicked: ${layer.name}, selection count: ${this.canvas.canvasSelection.selectedLayers.length}`);
    }

    startEditingLayerName(nameElement: HTMLElement, layer: Layer): void {
        const currentName = layer.name;
        nameElement.classList.add('editing');

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.style.width = '100%';

        nameElement.innerHTML = '';
        nameElement.appendChild(input);

        input.focus();
        input.select();

        const finishEditing = () => {
            let newName = input.value.trim() || `Layer ${layer.zIndex + 1}`;
            newName = this.ensureUniqueName(newName, layer);
            layer.name = newName;
            nameElement.classList.remove('editing');
            nameElement.textContent = newName;

            this.canvas.saveState();
            log.info(`Layer renamed to: ${newName}`);
        };

        input.addEventListener('blur', finishEditing);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                finishEditing();
            } else if (e.key === 'Escape') {
                nameElement.classList.remove('editing');
                nameElement.textContent = currentName;
            }
        });
    }

    ensureUniqueName(proposedName: string, currentLayer: Layer): string {
        const existingNames = this.canvas.layers
            .filter((layer: Layer) => layer !== currentLayer)
            .map((layer: Layer) => layer.name);

        if (!existingNames.includes(proposedName)) {
            return proposedName;
        }

        // Sprawdź czy nazwa już ma numerację w nawiasach
        const match = proposedName.match(/^(.+?)\s*\((\d+)\)$/);
        let baseName, startNumber;

        if (match) {
            baseName = match[1].trim();
            startNumber = parseInt(match[2]) + 1;
        } else {
            baseName = proposedName;
            startNumber = 1;
        }

        // Znajdź pierwszą dostępną numerację
        let counter = startNumber;
        let uniqueName;

        do {
            uniqueName = `${baseName} (${counter})`;
            counter++;
        } while (existingNames.includes(uniqueName));

        return uniqueName;
    }

    toggleLayerVisibility(layer: Layer): void {
        layer.visible = !layer.visible;

        // If layer became invisible and is selected, deselect it
        if (!layer.visible && this.canvas.canvasSelection.selectedLayers.includes(layer)) {
            const newSelection = this.canvas.canvasSelection.selectedLayers.filter((l: Layer) => l !== layer);
            this.canvas.updateSelection(newSelection);
        }

        this.canvas.render();
        this.canvas.requestSaveState();

        // Update the eye icon in the panel
        this.renderLayers();

        log.info(`Layer "${layer.name}" visibility toggled to: ${layer.visible}`);
    }

    deleteSelectedLayers(): void {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            log.debug('No layers selected for deletion');
            return;
        }

        log.info(`Deleting ${this.canvas.canvasSelection.selectedLayers.length} selected layers`);
        this.canvas.removeSelectedLayers();
        this.renderLayers();
    }

    handleDragStart(e: DragEvent, layer: Layer, index: number): void {
        if (!this.layersContainer || !e.dataTransfer) return;
        const editingElement = this.layersContainer.querySelector('.layer-name.editing');
        if (editingElement) {
            e.preventDefault();
            return;
        }

        // Jeśli przeciągana warstwa nie jest zaznaczona, zaznacz ją
        if (!this.canvas.canvasSelection.selectedLayers.includes(layer)) {
            this.canvas.updateSelection([layer]);
            this.renderLayers();
        }

        this.draggedElements = [...this.canvas.canvasSelection.selectedLayers];
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');

        this.layersContainer.querySelectorAll('.layer-row').forEach((row: Element, idx: number) => {
            const sortedLayers = [...this.canvas.layers].sort((a: Layer, b: Layer) => b.zIndex - a.zIndex);
            if (this.draggedElements.includes(sortedLayers[idx])) {
                row.classList.add('dragging');
            }
        });

        log.debug(`Started dragging ${this.draggedElements.length} layers`);
    }

    handleDragOver(e: DragEvent): void {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        const layerRow = e.currentTarget as HTMLElement;
        const rect = layerRow.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const isUpperHalf = e.clientY < midpoint;

        this.showDragInsertionLine(layerRow, isUpperHalf);
    }

    showDragInsertionLine(targetRow: HTMLElement, isUpperHalf: boolean): void {
        this.removeDragInsertionLine();

        const line = document.createElement('div');
        line.className = 'drag-insertion-line';

        if (isUpperHalf) {
            line.style.top = '-1px';
        } else {
            line.style.bottom = '-1px';
        }

        targetRow.style.position = 'relative';
        targetRow.appendChild(line);
        this.dragInsertionLine = line;
    }

    removeDragInsertionLine(): void {
        if (this.dragInsertionLine) {
            this.dragInsertionLine.remove();
            this.dragInsertionLine = null;
        }
    }

    handleDrop(e: DragEvent, targetIndex: number): void {
        e.preventDefault();
        this.removeDragInsertionLine();

        if (this.draggedElements.length === 0 || !(e.currentTarget instanceof HTMLElement)) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const isUpperHalf = e.clientY < midpoint;

        // Oblicz docelowy indeks
        let insertIndex = targetIndex;
        if (!isUpperHalf) {
            insertIndex = targetIndex + 1;
        }

        // Użyj nowej, centralnej funkcji do przesuwania warstw
        this.canvas.canvasLayers.moveLayers(this.draggedElements, { toIndex: insertIndex });

        log.info(`Dropped ${this.draggedElements.length} layers at position ${insertIndex}`);
    }

    handleDragEnd(e: DragEvent): void {
        this.removeDragInsertionLine();
        if (!this.layersContainer) return;
        this.layersContainer.querySelectorAll('.layer-row').forEach((row: Element) => {
            row.classList.remove('dragging');
        });

        this.draggedElements = [];
    }

    onLayersChanged(): void {
        this.renderLayers();
    }

    updateSelectionAppearance(): void {
        if (!this.layersContainer) return;
        const sortedLayers = [...this.canvas.layers].sort((a: Layer, b: Layer) => b.zIndex - a.zIndex);
        const layerRows = this.layersContainer.querySelectorAll('.layer-row');

        layerRows.forEach((row: Element, index: number) => {
            const layer = sortedLayers[index];
            if (this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                row.classList.add('selected');
            } else {
                row.classList.remove('selected');
            }
        });
    }

    /**
     * Aktualizuje stan przycisków w zależności od zaznaczenia warstw
     */
    updateButtonStates(): void {
        if (!this.container) return;

        const deleteBtn = this.container.querySelector('#delete-layer-btn') as HTMLButtonElement;
        const hasSelectedLayers = this.canvas.canvasSelection.selectedLayers.length > 0;

        if (deleteBtn) {
            deleteBtn.disabled = !hasSelectedLayers;
            deleteBtn.title = hasSelectedLayers
                ? `Delete ${this.canvas.canvasSelection.selectedLayers.length} selected layer(s)`
                : 'No layers selected';
        }

        log.debug(`Button states updated - delete button ${hasSelectedLayers ? 'enabled' : 'disabled'}`);
    }

    /**
     * Aktualizuje panel gdy zmieni się zaznaczenie (wywoływane z zewnątrz).
     * Zamiast pełnego renderowania, tylko aktualizujemy wygląd.
     */
    onSelectionChanged(): void {
        this.updateSelectionAppearance();
        this.updateButtonStates();
    }

    destroy(): void {
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
        this.container = null;
        this.layersContainer = null;
        this.draggedElements = [];
        this.removeDragInsertionLine();

        log.info('CanvasLayersPanel destroyed');
    }
}
