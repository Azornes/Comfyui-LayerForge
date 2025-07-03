import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('CanvasLayersPanel');

export class CanvasLayersPanel {
    constructor(canvas) {
        this.canvas = canvas;
        this.container = null;
        this.layersContainer = null;
        this.draggedElements = [];
        this.dragInsertionLine = null;
        this.isMultiSelecting = false;
        this.lastSelectedIndex = -1;
        
        // Binding metod dla event handlerów
        this.handleLayerClick = this.handleLayerClick.bind(this);
        this.handleDragStart = this.handleDragStart.bind(this);
        this.handleDragOver = this.handleDragOver.bind(this);
        this.handleDragEnd = this.handleDragEnd.bind(this);
        this.handleDrop = this.handleDrop.bind(this);
        
        log.info('CanvasLayersPanel initialized');
    }

    /**
     * Tworzy struktur&ecirc; HTML panelu warstw
     */
    createPanelStructure() {
        // Główny kontener panelu
        this.container = document.createElement('div');
        this.container.className = 'layers-panel';
        this.container.tabIndex = 0; // Umożliwia fokus na panelu
        this.container.innerHTML = `
            <div class="layers-panel-header">
                <span class="layers-panel-title">Layers</span>
                <div class="layers-panel-controls">
                    <button class="layers-btn" id="delete-layer-btn" title="Delete layer">🗑</button>
                </div>
            </div>
            <div class="layers-container" id="layers-container">
                <!-- Lista warstw będzie renderowana tutaj -->
            </div>
        `;

        this.layersContainer = this.container.querySelector('#layers-container');
        
        // Dodanie stylów CSS
        this.injectStyles();
        
        // Setup event listeners dla przycisków
        this.setupControlButtons();

        // Dodaj listener dla klawiatury, aby usuwanie działało z panelu
        this.container.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                this.deleteSelectedLayers();
            }
        });
        
        log.debug('Panel structure created');
        return this.container;
    }

    /**
     * Dodaje style CSS do panelu
     */
    injectStyles() {
        const styleId = 'layers-panel-styles';
        if (document.getElementById(styleId)) {
            return; // Style już istnieją
        }

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .layers-panel {
                background: #2a2a2a;
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                padding: 8px;
                height: 100%;
                overflow: hidden;
                font-family: Arial, sans-serif;
                font-size: 12px;
                color: #ffffff;
                user-select: none;
                display: flex;
                flex-direction: column;
            }

            .layers-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding-bottom: 8px;
                border-bottom: 1px solid #3a3a3a;
                margin-bottom: 8px;
            }

            .layers-panel-title {
                font-weight: bold;
                color: #ffffff;
            }

            .layers-panel-controls {
                display: flex;
                gap: 4px;
            }

            .layers-btn {
                background: #3a3a3a;
                border: 1px solid #4a4a4a;
                color: #ffffff;
                padding: 4px 8px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 11px;
            }

            .layers-btn:hover {
                background: #4a4a4a;
            }

            .layers-btn:active {
                background: #5a5a5a;
            }

            .layers-container {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
            }

            .layer-row {
                display: flex;
                align-items: center;
                padding: 6px 4px;
                margin-bottom: 2px;
                border-radius: 3px;
                cursor: pointer;
                transition: background-color 0.15s ease;
                position: relative;
                gap: 6px;
            }

            .layer-row:hover {
                background: rgba(255, 255, 255, 0.05);
            }

            .layer-row.selected {
                background: #2d5aa0 !important;
                box-shadow: inset 0 0 0 1px #4a7bc8;
            }

            .layer-row.dragging {
                opacity: 0.6;
            }


            .layer-thumbnail {
                width: 48px;
                height: 48px;
                border: 1px solid #4a4a4a;
                border-radius: 2px;
                background: transparent;
                position: relative;
                flex-shrink: 0;
                overflow: hidden;
            }

            .layer-thumbnail canvas {
                width: 100%;
                height: 100%;
                display: block;
            }

            .layer-thumbnail::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-image: 
                    linear-gradient(45deg, #555 25%, transparent 25%), 
                    linear-gradient(-45deg, #555 25%, transparent 25%), 
                    linear-gradient(45deg, transparent 75%, #555 75%), 
                    linear-gradient(-45deg, transparent 75%, #555 75%);
                background-size: 8px 8px;
                background-position: 0 0, 0 4px, 4px -4px, -4px 0px;
                z-index: 1;
            }

            .layer-thumbnail canvas {
                position: relative;
                z-index: 2;
            }

            .layer-name {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                padding: 2px 4px;
                border-radius: 2px;
                color: #ffffff;
            }

            .layer-name.editing {
                background: #4a4a4a;
                border: 1px solid #6a6a6a;
                outline: none;
                color: #ffffff;
            }

            .layer-name input {
                background: transparent;
                border: none;
                color: #ffffff;
                font-size: 12px;
                width: 100%;
                outline: none;
            }

            .drag-insertion-line {
                position: absolute;
                left: 0;
                right: 0;
                height: 2px;
                background: #4a7bc8;
                border-radius: 1px;
                z-index: 1000;
                box-shadow: 0 0 4px rgba(74, 123, 200, 0.6);
            }

            .layers-container::-webkit-scrollbar {
                width: 6px;
            }

            .layers-container::-webkit-scrollbar-track {
                background: #2a2a2a;
            }

            .layers-container::-webkit-scrollbar-thumb {
                background: #4a4a4a;
                border-radius: 3px;
            }

            .layers-container::-webkit-scrollbar-thumb:hover {
                background: #5a5a5a;
            }
        `;
        
        document.head.appendChild(style);
        log.debug('Styles injected');
    }

    /**
     * Konfiguruje event listenery dla przycisków kontrolnych
     */
    setupControlButtons() {
        const deleteBtn = this.container.querySelector('#delete-layer-btn');

        deleteBtn?.addEventListener('click', () => {
            log.info('Delete layer button clicked');
            this.deleteSelectedLayers();
        });
    }

    /**
     * Renderuje listę warstw
     */
    renderLayers() {
        if (!this.layersContainer) {
            log.warn('Layers container not initialized');
            return;
        }

        // Wyczyść istniejącą zawartość
        this.layersContainer.innerHTML = '';

        // Usuń linię wstawiania jeśli istnieje
        this.removeDragInsertionLine();

        // Sortuj warstwy według zIndex (od najwyższej do najniższej)
        const sortedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);

        sortedLayers.forEach((layer, index) => {
            const layerElement = this.createLayerElement(layer, index);
            this.layersContainer.appendChild(layerElement);
        });

        log.debug(`Rendered ${sortedLayers.length} layers`);
    }

    /**
     * Tworzy element HTML dla pojedynczej warstwy
     */
    createLayerElement(layer, index) {
        const layerRow = document.createElement('div');
        layerRow.className = 'layer-row';
        layerRow.draggable = true;
        layerRow.dataset.layerIndex = index;
        
        // Sprawdź czy warstwa jest zaznaczona
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
            <div class="layer-thumbnail" data-layer-index="${index}"></div>
            <span class="layer-name" data-layer-index="${index}">${layer.name}</span>
        `;

        // Wygeneruj miniaturkę
        this.generateThumbnail(layer, layerRow.querySelector('.layer-thumbnail'));

        // Event listenery
        this.setupLayerEventListeners(layerRow, layer, index);

        return layerRow;
    }

    /**
     * Generuje miniaturkę warstwy
     */
    generateThumbnail(layer, thumbnailContainer) {
        if (!layer.image) {
            thumbnailContainer.style.background = '#4a4a4a';
            return;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = 48;
        canvas.height = 48;

        // Oblicz skalę zachowując proporcje
        const scale = Math.min(48 / layer.image.width, 48 / layer.image.height);
        const scaledWidth = layer.image.width * scale;
        const scaledHeight = layer.image.height * scale;
        
        // Wycentruj obraz
        const x = (48 - scaledWidth) / 2;
        const y = (48 - scaledHeight) / 2;

        // Narysuj obraz z wyższą jakością
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(layer.image, x, y, scaledWidth, scaledHeight);

        thumbnailContainer.appendChild(canvas);
    }

    /**
     * Konfiguruje event listenery dla elementu warstwy
     */
    setupLayerEventListeners(layerRow, layer, index) {
        // Mousedown handler - zaznaczanie w momencie wciśnięcia przycisku
        layerRow.addEventListener('mousedown', (e) => {
            // Ignoruj, jeśli edytujemy nazwę
            const nameElement = layerRow.querySelector('.layer-name');
            if (nameElement && nameElement.classList.contains('editing')) {
                return;
            }
            this.handleLayerClick(e, layer, index);
        });

        // Double click handler - edycja nazwy
        layerRow.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const nameElement = layerRow.querySelector('.layer-name');
            this.startEditingLayerName(nameElement, layer);
        });

        // Drag handlers
        layerRow.addEventListener('dragstart', (e) => this.handleDragStart(e, layer, index));
        layerRow.addEventListener('dragover', this.handleDragOver);
        layerRow.addEventListener('dragend', this.handleDragEnd);
        layerRow.addEventListener('drop', (e) => this.handleDrop(e, index));
    }

    /**
     * Obsługuje kliknięcie na warstwę, aktualizując stan bez pełnego renderowania.
     */
    handleLayerClick(e, layer, index) {
        const isCtrlPressed = e.ctrlKey || e.metaKey;
        const isShiftPressed = e.shiftKey;

        // Aktualizuj wewnętrzny stan zaznaczenia w obiekcie canvas
        // Ta funkcja NIE powinna już wywoływać onSelectionChanged w panelu.
        this.canvas.updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index);
        
        // Aktualizuj tylko wygląd (klasy CSS), bez niszczenia DOM
        this.updateSelectionAppearance(); 

        log.debug(`Layer clicked: ${layer.name}, selection count: ${this.canvas.canvasSelection.selectedLayers.length}`);
    }


    /**
     * Rozpoczyna edycję nazwy warstwy
     */
    startEditingLayerName(nameElement, layer) {
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


    /**
     * Zapewnia unikalność nazwy warstwy
     */
    ensureUniqueName(proposedName, currentLayer) {
        const existingNames = this.canvas.layers
            .filter(layer => layer !== currentLayer)
            .map(layer => layer.name);
        
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

    /**
     * Usuwa zaznaczone warstwy
     */
    deleteSelectedLayers() {
        if (this.canvas.canvasSelection.selectedLayers.length === 0) {
            log.debug('No layers selected for deletion');
            return;
        }

        log.info(`Deleting ${this.canvas.canvasSelection.selectedLayers.length} selected layers`);
        this.canvas.removeSelectedLayers();
        this.renderLayers();
    }

    /**
     * Rozpoczyna przeciąganie warstwy
     */
    handleDragStart(e, layer, index) {
        // Sprawdź czy jakakolwiek warstwa jest w trybie edycji
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
        e.dataTransfer.setData('text/plain', ''); // Wymagane przez standard

        // Dodaj klasę dragging do przeciąganych elementów
        this.layersContainer.querySelectorAll('.layer-row').forEach((row, idx) => {
            const sortedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);
            if (this.draggedElements.includes(sortedLayers[idx])) {
                row.classList.add('dragging');
            }
        });

        log.debug(`Started dragging ${this.draggedElements.length} layers`);
    }

    /**
     * Obsługuje przeciąganie nad warstwą
     */
    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const layerRow = e.currentTarget;
        const rect = layerRow.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const isUpperHalf = e.clientY < midpoint;

        this.showDragInsertionLine(layerRow, isUpperHalf);
    }

    /**
     * Pokazuje linię wskaźnika wstawiania
     */
    showDragInsertionLine(targetRow, isUpperHalf) {
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

    /**
     * Usuwa linię wskaźnika wstawiania
     */
    removeDragInsertionLine() {
        if (this.dragInsertionLine) {
            this.dragInsertionLine.remove();
            this.dragInsertionLine = null;
        }
    }

    /**
     * Obsługuje upuszczenie warstwy
     */
    handleDrop(e, targetIndex) {
        e.preventDefault();
        this.removeDragInsertionLine();

        if (this.draggedElements.length === 0) return;

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

    /**
     * Kończy przeciąganie
     */
    handleDragEnd(e) {
        this.removeDragInsertionLine();
        
        // Usuń klasę dragging ze wszystkich elementów
        this.layersContainer.querySelectorAll('.layer-row').forEach(row => {
            row.classList.remove('dragging');
        });

        this.draggedElements = [];
    }


    /**
     * Aktualizuje panel gdy zmienią się warstwy
     */
    onLayersChanged() {
        this.renderLayers();
    }

    /**
     * Aktualizuje wygląd zaznaczenia w panelu bez pełnego renderowania.
     */
    updateSelectionAppearance() {
        const sortedLayers = [...this.canvas.layers].sort((a, b) => b.zIndex - a.zIndex);
        const layerRows = this.layersContainer.querySelectorAll('.layer-row');

        layerRows.forEach((row, index) => {
            const layer = sortedLayers[index];
            if (this.canvas.canvasSelection.selectedLayers.includes(layer)) {
                row.classList.add('selected');
            } else {
                row.classList.remove('selected');
            }
        });
    }

    /**
     * Aktualizuje panel gdy zmienią się warstwy (np. dodanie, usunięcie, zmiana kolejności)
     * To jest jedyne miejsce, gdzie powinniśmy w pełni renderować panel.
     */
    onLayersChanged() {
        this.renderLayers();
    }

    /**
     * Aktualizuje panel gdy zmieni się zaznaczenie (wywoływane z zewnątrz).
     * Zamiast pełnego renderowania, tylko aktualizujemy wygląd.
     */
    onSelectionChanged() {
        this.updateSelectionAppearance();
    }

    /**
     * Niszczy panel i czyści event listenery
     */
    destroy() {
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
