import {app, ComfyApp} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {removeImage} from "./db.js";
import {MaskTool} from "./MaskTool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasLayersPanel} from "./CanvasLayersPanel.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
import {CanvasIO} from "./CanvasIO.js";
import {ImageReferenceManager} from "./ImageReferenceManager.js";
import {BatchPreviewManager} from "./BatchPreviewManager.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import {mask_editor_showing, mask_editor_listen_for_cancel} from "./utils/mask_utils.js";
import { debounce } from "./utils/CommonUtils.js";

const useChainCallback = (original, next) => {
  if (original === undefined || original === null) {
    return next;
  }
  return function(...args) {
    const originalReturn = original.apply(this, args);
    const nextReturn = next.apply(this, args);
    return nextReturn === undefined ? originalReturn : nextReturn;
  };
};

const log = createModuleLogger('Canvas');

/**
 * Canvas - Fasada dla systemu rysowania
 *
 * Klasa Canvas pełni rolę fasady, oferując uproszczony interfejs wysokiego poziomu
 * dla złożonego systemu rysowania. Zamiast eksponować wszystkie metody modułów,
 * udostępnia tylko kluczowe operacje i umożliwia bezpośredni dostęp do modułów
 * gdy potrzebna jest bardziej szczegółowa kontrola.
 */
export class Canvas {
    constructor(node, widget, callbacks = {}) {
        this.node = node;
        this.widget = widget;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', {willReadFrequently: true});
        this.width = 512;
        this.height = 512;
        this.layers = [];
        this.selectedLayer = null;
        this.selectedLayers = [];
        this.onSelectionChange = null;
        this.onStateChange = callbacks.onStateChange || null;
        this.lastMousePosition = {x: 0, y: 0};

        this.viewport = {
            x: -(this.width / 4),
            y: -(this.height / 4),
            zoom: 0.8,
        };

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', {
            alpha: false
        });

        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.imageCache = new Map();

        this._initializeModules(callbacks);

        this._setupCanvas();

        this.interaction = this.canvasInteractions.interaction;

        log.debug('Canvas widget element:', this.node);
        log.info('Canvas initialized', {
            nodeId: this.node.id,
            dimensions: {width: this.width, height: this.height},
            viewport: this.viewport
        });

        this.setPreviewVisibility(false);
    }


    async waitForWidget(name, node, interval = 100, timeout = 20000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const check = () => {
                const widget = node.widgets.find(w => w.name === name);
                if (widget) {
                    resolve(widget);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error(`Widget "${name}" not found within timeout.`));
                } else {
                    setTimeout(check, interval);
                }
            };

            check();
        });
    }


    /**
     * Kontroluje widoczność podglądu canvas
     * @param {boolean} visible - Czy podgląd ma być widoczny
     */
    async setPreviewVisibility(visible) {
        this.previewVisible = visible;
        log.info("Canvas preview visibility set to:", visible);

        const imagePreviewWidget = await this.waitForWidget("$$canvas-image-preview", this.node);
        if (imagePreviewWidget) {
            log.debug("Found $$canvas-image-preview widget, controlling visibility");

            if (visible) {
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = false;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = true;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = false;
                }
                imagePreviewWidget.computeSize = function () {
                    return [0, 250]; // Szerokość 0 (auto), wysokość 250
                };
            } else {
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = true;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = false;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = true;
                }

                imagePreviewWidget.computeSize = function () {
                    return [0, 0]; // Szerokość 0, wysokość 0
                };
            }
            this.render()
        } else {
            log.warn("$$canvas-image-preview widget not found in Canvas.js");
        }
    }

    /**
     * Inicjalizuje moduły systemu canvas
     * @private
     */
    _initializeModules(callbacks) {
        log.debug('Initializing Canvas modules...');

        // Stwórz opóźnioną wersję funkcji zapisu stanu
        this.requestSaveState = debounce(this.saveState.bind(this), 500);

        this._addAutoRefreshToggle();
        this.maskTool = new MaskTool(this, {onStateChange: this.onStateChange});
        this.canvasState = new CanvasState(this);
        this.canvasInteractions = new CanvasInteractions(this);
        this.canvasLayers = new CanvasLayers(this);
        this.canvasLayersPanel = new CanvasLayersPanel(this);
        this.canvasRenderer = new CanvasRenderer(this);
        this.canvasIO = new CanvasIO(this);
        this.imageReferenceManager = new ImageReferenceManager(this);
        this.batchPreviewManager = new BatchPreviewManager(this);

        log.debug('Canvas modules initialized successfully');
    }

    /**
     * Konfiguruje podstawowe właściwości canvas
     * @private
     */
    _setupCanvas() {
        this.initCanvas();
        this.canvasInteractions.setupEventListeners();
        this.canvasIO.initNodeData();

        this.layers = this.layers.map(layer => ({
            ...layer,
            opacity: 1
        }));
    }


    /**
     * Ładuje stan canvas z bazy danych
     */
    async loadInitialState() {
        log.info("Loading initial state for node:", this.node.id);
        const loaded = await this.canvasState.loadStateFromDB();
        if (!loaded) {
            log.info("No saved state found, initializing from node data.");
            await this.canvasIO.initNodeData();
        }
        this.saveState();
        this.render();

        // Dodaj to wywołanie, aby panel renderował się po załadowaniu stanu
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
    }

    /**
     * Zapisuje obecny stan
     * @param {boolean} replaceLast - Czy zastąpić ostatni stan w historii
     */
    saveState(replaceLast = false) {
        log.debug('Saving canvas state', {replaceLast, layersCount: this.layers.length});
        this.canvasState.saveState(replaceLast);
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    /**
     * Cofnij ostatnią operację
     */
    undo() {
        log.info('Performing undo operation');
        const historyInfo = this.canvasState.getHistoryInfo();
        log.debug('History state before undo:', historyInfo);

        this.canvasState.undo();
        this.incrementOperationCount();
        this._notifyStateChange();

        // Powiadom panel warstw o zmianie stanu warstw
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
            this.canvasLayersPanel.onSelectionChanged();
        }

        log.debug('Undo completed, layers count:', this.layers.length);
    }


    /**
     * Ponów cofniętą operację
     */
    redo() {
        log.info('Performing redo operation');
        const historyInfo = this.canvasState.getHistoryInfo();
        log.debug('History state before redo:', historyInfo);

        this.canvasState.redo();
        this.incrementOperationCount();
        this._notifyStateChange();

        // Powiadom panel warstw o zmianie stanu warstw
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
            this.canvasLayersPanel.onSelectionChanged();
        }

        log.debug('Redo completed, layers count:', this.layers.length);
    }

    /**
     * Renderuje canvas
     */
    render() {
        this.canvasRenderer.render();
    }

    /**
     * Dodaje warstwę z obrazem
     * @param {Image} image - Obraz do dodania
     * @param {Object} layerProps - Właściwości warstwy
     * @param {string} addMode - Tryb dodawania
     */
    async addLayer(image, layerProps = {}, addMode = 'default') {
        const result = await this.canvasLayers.addLayerWithImage(image, layerProps, addMode);
        
        // Powiadom panel warstw o dodaniu nowej warstwy
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        
        return result;
    }

    /**
     * Usuwa wybrane warstwy
     */
    removeLayersByIds(layerIds) {
        if (!layerIds || layerIds.length === 0) return;

        const initialCount = this.layers.length;
        this.saveState();
        this.layers = this.layers.filter(l => !layerIds.includes(l.id));
        
        // If the current selection was part of the removal, clear it
        const newSelection = this.selectedLayers.filter(l => !layerIds.includes(l.id));
        this.updateSelection(newSelection);
        
        this.render();
        this.saveState();

        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        log.info(`Removed ${initialCount - this.layers.length} layers by ID.`);
    }

    removeSelectedLayers() {
        if (this.selectedLayers.length > 0) {
            log.info('Removing selected layers', {
                layersToRemove: this.selectedLayers.length,
                totalLayers: this.layers.length
            });

            this.saveState();
            this.layers = this.layers.filter(l => !this.selectedLayers.includes(l));
            
            this.updateSelection([]); 
            
            this.render();
            this.saveState();

            if (this.canvasLayersPanel) {
                this.canvasLayersPanel.onLayersChanged();
            }

            log.debug('Layers removed successfully, remaining layers:', this.layers.length);
        } else {
            log.debug('No layers selected for removal');
        }
    }

    /**
     * Duplikuje zaznaczone warstwy (w pamięci, bez zapisu stanu)
     */
    duplicateSelectedLayers() {
        if (this.selectedLayers.length === 0) return [];

        const newLayers = [];
        const sortedLayers = [...this.selectedLayers].sort((a,b) => a.zIndex - b.zIndex);
        
        sortedLayers.forEach(layer => {
            const newLayer = {
                ...layer,
                id: `layer_${+new Date()}_${Math.random().toString(36).substr(2, 9)}`,
                zIndex: this.layers.length, // Nowa warstwa zawsze na wierzchu
            };
            this.layers.push(newLayer);
            newLayers.push(newLayer);
        });

        // Aktualizuj zaznaczenie, co powiadomi panel (ale nie renderuje go całego)
        this.updateSelection(newLayers);
        
        // Powiadom panel o zmianie struktury, aby się przerysował
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        
        log.info(`Duplicated ${newLayers.length} layers (in-memory).`);
        return newLayers;
    }

    /**
     * Aktualizuje zaznaczenie warstw i powiadamia wszystkie komponenty.
     * To jest "jedyne źródło prawdy" o zmianie zaznaczenia.
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection) {
        const previousSelection = this.selectedLayers.length;
        this.selectedLayers = newSelection || [];
        this.selectedLayer = this.selectedLayers.length > 0 ? this.selectedLayers[this.selectedLayers.length - 1] : null;
        
        // Sprawdź, czy zaznaczenie faktycznie się zmieniło, aby uniknąć pętli
        const hasChanged = previousSelection !== this.selectedLayers.length || 
                           this.selectedLayers.some((layer, i) => this.selectedLayers[i] !== (newSelection || [])[i]);

        if (!hasChanged && previousSelection > 0) {
           // return; // Zablokowane na razie, może powodować problemy
        }

        log.debug('Selection updated', {
            previousCount: previousSelection,
            newCount: this.selectedLayers.length,
            selectedLayerIds: this.selectedLayers.map(l => l.id || 'unknown')
        });
        
        // 1. Zrenderuj ponownie canvas, aby pokazać nowe kontrolki transformacji
        this.render();

        // 2. Powiadom inne części aplikacji (jeśli są)
        if (this.onSelectionChange) {
            this.onSelectionChange();
        }

        // 3. Powiadom panel warstw, aby zaktualizował swój wygląd
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onSelectionChanged();
        }
    }

    /**
     * Logika aktualizacji zaznaczenia, wywoływana przez panel warstw.
     */
    updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index) {
        let newSelection = [...this.selectedLayers];
        let selectionChanged = false;

        if (isShiftPressed && this.canvasLayersPanel.lastSelectedIndex !== -1) {
            const sortedLayers = [...this.layers].sort((a, b) => b.zIndex - a.zIndex);
            const startIndex = Math.min(this.canvasLayersPanel.lastSelectedIndex, index);
            const endIndex = Math.max(this.canvasLayersPanel.lastSelectedIndex, index);
            
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
            this.canvasLayersPanel.lastSelectedIndex = index;
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
            this.canvasLayersPanel.lastSelectedIndex = index;
        }

        // Aktualizuj zaznaczenie tylko jeśli faktycznie się zmieniło
        if (selectionChanged) {
            this.updateSelection(newSelection);
        }
    }

    /**
     * Zmienia rozmiar obszaru wyjściowego
     * @param {number} width - Nowa szerokość
     * @param {number} height - Nowa wysokość
     * @param {boolean} saveHistory - Czy zapisać w historii
     */
    updateOutputAreaSize(width, height, saveHistory = true) {
        return this.canvasLayers.updateOutputAreaSize(width, height, saveHistory);
    }

    /**
     * Eksportuje spłaszczony canvas jako blob
     */
    async getFlattenedCanvasAsBlob() {
        return this.canvasLayers.getFlattenedCanvasAsBlob();
    }

    /**
     * Eksportuje spłaszczony canvas z maską jako kanałem alpha
     */
    async getFlattenedCanvasWithMaskAsBlob() {
        return this.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
    }

    /**
     * Importuje najnowszy obraz
     */
    async importLatestImage() {
        return this.canvasIO.importLatestImage();
    }

    _addAutoRefreshToggle() {
        let autoRefreshEnabled = false;
        let lastExecutionStartTime = 0;

        const handleExecutionStart = () => {
            lastExecutionStartTime = Date.now();
            log.debug(`Execution started, timestamp set to: ${lastExecutionStartTime}`);
        };

        const handleExecutionSuccess = async () => {
            if (autoRefreshEnabled) {
                log.info('Auto-refresh triggered, importing latest images.');
                const newLayers = await this.canvasIO.importLatestImages(lastExecutionStartTime);

                if (newLayers && newLayers.length > 0) {
                    this.batchPreviewManager.addLayers(newLayers);
                }
            }
        };

        this.node.addWidget(
            'toggle',
            'Auto-refresh after generation',
            false,
            (value) => {
                autoRefreshEnabled = value;
                log.debug('Auto-refresh toggled:', value);
            }, {
                serialize: false
            }
        );

        api.addEventListener('execution_start', handleExecutionStart);
        api.addEventListener('execution_success', handleExecutionSuccess);

        this.node.onRemoved = useChainCallback(this.node.onRemoved, () => {
            log.info('Node removed, cleaning up auto-refresh listeners.');
            api.removeEventListener('execution_start', handleExecutionStart);
            api.removeEventListener('execution_success', handleExecutionSuccess);
        });
    }


    /**
     * Uruchamia edytor masek
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask = null, sendCleanImage = true) {
        log.info('Starting mask editor', {
            hasPredefinedMask: !!predefinedMask,
            sendCleanImage,
            layersCount: this.layers.length
        });

        this.savedMaskState = await this.saveMaskState();
        this.maskEditorCancelled = false;

        if (!predefinedMask && this.maskTool && this.maskTool.maskCanvas) {
            try {
                log.debug('Creating mask from current mask tool');
                predefinedMask = await this.createMaskFromCurrentMask();
                log.debug('Mask created from current mask tool successfully');
            } catch (error) {
                log.warn("Could not create mask from current mask:", error);
            }
        }

        this.pendingMask = predefinedMask;

        let blob;
        if (sendCleanImage) {
            log.debug('Getting flattened canvas as blob (clean image)');
            blob = await this.canvasLayers.getFlattenedCanvasAsBlob();
        } else {
            log.debug('Getting flattened canvas for mask editor (with mask)');
            blob = await this.canvasLayers.getFlattenedCanvasForMaskEditor();
        }

        if (!blob) {
            log.warn("Canvas is empty, cannot open mask editor.");
            return;
        }

        log.debug('Canvas blob created successfully, size:', blob.size);

        try {
            const formData = new FormData();
            const filename = `layerforge-mask-edit-${+new Date()}.png`;
            formData.append("image", blob, filename);
            formData.append("overwrite", "true");
            formData.append("type", "temp");

            log.debug('Uploading image to server:', filename);

            const response = await api.fetchApi("/upload/image", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`Failed to upload image: ${response.statusText}`);
            }
            const data = await response.json();

            log.debug('Image uploaded successfully:', data);

            const img = new Image();
            img.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
            await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = rej;
            });

            this.node.imgs = [img];

            log.info('Opening ComfyUI mask editor');
            ComfyApp.copyToClipspace(this.node);
            ComfyApp.clipspace_return_node = this.node;
            ComfyApp.open_maskeditor();

            this.editorWasShowing = false;
            this.waitWhileMaskEditing();

            this.setupCancelListener();

            if (predefinedMask) {
                log.debug('Will apply predefined mask when editor is ready');
                this.waitForMaskEditorAndApplyMask();
            }

        } catch (error) {
            log.error("Error preparing image for mask editor:", error);
            alert(`Error: ${error.message}`);
        }
    }


    /**
     * Inicjalizuje podstawowe właściwości canvas
     */
    initCanvas() {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.border = '1px solid black';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.backgroundColor = '#606060';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.tabIndex = 0;
        this.canvas.style.outline = 'none';
    }

    /**
     * Pobiera współrzędne myszy w układzie świata
     * @param {MouseEvent} e - Zdarzenie myszy
     */
    getMouseWorldCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();

        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        const scaleX = this.offscreenCanvas.width / rect.width;
        const scaleY = this.offscreenCanvas.height / rect.height;

        const mouseX_Buffer = mouseX_DOM * scaleX;
        const mouseY_Buffer = mouseY_DOM * scaleY;

        const worldX = (mouseX_Buffer / this.viewport.zoom) + this.viewport.x;
        const worldY = (mouseY_Buffer / this.viewport.zoom) + this.viewport.y;

        return {x: worldX, y: worldY};
    }

    /**
     * Pobiera współrzędne myszy w układzie widoku
     * @param {MouseEvent} e - Zdarzenie myszy
     */
    getMouseViewCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        const mouseX_Canvas = mouseX_DOM * scaleX;
        const mouseY_Canvas = mouseY_DOM * scaleY;

        return {x: mouseX_Canvas, y: mouseY_Canvas};
    }

    /**
     * Aktualizuje zaznaczenie po operacji historii
     */
    updateSelectionAfterHistory() {
        const newSelectedLayers = [];
        if (this.selectedLayers) {
            this.selectedLayers.forEach(sl => {
                const found = this.layers.find(l => l.id === sl.id);
                if (found) newSelectedLayers.push(found);
            });
        }
        this.updateSelection(newSelectedLayers);
    }

    /**
     * Aktualizuje przyciski historii
     */
    updateHistoryButtons() {
        if (this.onHistoryChange) {
            const historyInfo = this.canvasState.getHistoryInfo();
            this.onHistoryChange({
                canUndo: historyInfo.canUndo,
                canRedo: historyInfo.canRedo
            });
        }
    }

    /**
     * Zwiększa licznik operacji (dla garbage collection)
     */
    incrementOperationCount() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.incrementOperationCount();
        }
    }

    /**
     * Czyści zasoby canvas
     */
    destroy() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.destroy();
        }
        log.info("Canvas destroyed");
    }

    /**
     * Powiadamia o zmianie stanu
     * @private
     */
    _notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange();
        }
    }


    /**
     * Czeka na otwarcie mask editora i automatycznie nakłada predefiniowaną maskę
     */
    waitForMaskEditorAndApplyMask() {
        let attempts = 0;
        const maxAttempts = 100; // Zwiększone do 10 sekund oczekiwania

        const checkEditor = () => {
            attempts++;

            if (mask_editor_showing(app)) {

                const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');
                let editorReady = false;

                if (useNewEditor) {

                    const MaskEditorDialog = window.MaskEditorDialog;
                    if (MaskEditorDialog && MaskEditorDialog.instance) {

                        try {
                            const messageBroker = MaskEditorDialog.instance.getMessageBroker();
                            if (messageBroker) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via MessageBroker");
                            }
                        } catch (e) {

                            editorReady = false;
                        }
                    }

                    if (!editorReady) {
                        const maskEditorElement = document.getElementById('maskEditor');
                        if (maskEditorElement && maskEditorElement.style.display !== 'none') {

                            const canvas = maskEditorElement.querySelector('canvas');
                            if (canvas) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via DOM element");
                            }
                        }
                    }
                } else {

                    const maskCanvas = document.getElementById('maskCanvas');
                    editorReady = maskCanvas && maskCanvas.getContext && maskCanvas.width > 0;
                    if (editorReady) {
                        log.info("Old mask editor detected as ready");
                    }
                }

                if (editorReady) {

                    log.info("Applying mask to editor after", attempts * 100, "ms wait");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 300);
                } else if (attempts < maxAttempts) {

                    if (attempts % 10 === 0) {
                        log.info("Waiting for mask editor to be ready... attempt", attempts, "/", maxAttempts);
                    }
                    setTimeout(checkEditor, 100);
                } else {
                    log.warn("Mask editor timeout - editor not ready after", maxAttempts * 100, "ms");

                    log.info("Attempting to apply mask anyway...");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 100);
                }
            } else if (attempts < maxAttempts) {

                setTimeout(checkEditor, 100);
            } else {
                log.warn("Mask editor timeout - editor not showing after", maxAttempts * 100, "ms");
                this.pendingMask = null;
            }
        };

        checkEditor();
    }

    /**
     * Nakłada maskę na otwarty mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski do nałożenia
     */
    async applyMaskToEditor(maskData) {
        try {

            const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');

            if (useNewEditor) {

                const MaskEditorDialog = window.MaskEditorDialog;
                if (MaskEditorDialog && MaskEditorDialog.instance) {

                    await this.applyMaskToNewEditor(maskData);
                } else {
                    log.warn("New editor setting enabled but instance not found, trying old editor");
                    await this.applyMaskToOldEditor(maskData);
                }
            } else {

                await this.applyMaskToOldEditor(maskData);
            }

            log.info("Predefined mask applied to mask editor successfully");
        } catch (error) {
            log.error("Failed to apply predefined mask to editor:", error);

            try {
                log.info("Trying alternative mask application method...");
                await this.applyMaskToOldEditor(maskData);
                log.info("Alternative method succeeded");
            } catch (fallbackError) {
                log.error("Alternative method also failed:", fallbackError);
            }
        }
    }

    /**
     * Nakłada maskę na nowy mask editor (przez MessageBroker)
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToNewEditor(maskData) {

        const MaskEditorDialog = window.MaskEditorDialog;
        if (!MaskEditorDialog || !MaskEditorDialog.instance) {
            throw new Error("New mask editor instance not found");
        }

        const editor = MaskEditorDialog.instance;
        const messageBroker = editor.getMessageBroker();

        const maskCanvas = await messageBroker.pull('maskCanvas');
        const maskCtx = await messageBroker.pull('maskCtx');
        const maskColor = await messageBroker.pull('getMaskColor');

        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);

        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(processedMask, 0, 0);

        messageBroker.publish('saveState');
    }

    /**
     * Nakłada maskę na stary mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToOldEditor(maskData) {

        const maskCanvas = document.getElementById('maskCanvas');
        if (!maskCanvas) {
            throw new Error("Old mask editor canvas not found");
        }

        const maskCtx = maskCanvas.getContext('2d', {willReadFrequently: true});

        const maskColor = {r: 255, g: 255, b: 255};
        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);

        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(processedMask, 0, 0);
    }

    /**
     * Przetwarza maskę do odpowiedniego formatu dla editora
     * @param {Image|HTMLCanvasElement} maskData - Oryginalne dane maski
     * @param {number} targetWidth - Docelowa szerokość
     * @param {number} targetHeight - Docelowa wysokość
     * @param {Object} maskColor - Kolor maski {r, g, b}
     * @returns {HTMLCanvasElement} Przetworzona maska
     */async processMaskForEditor(maskData, targetWidth, targetHeight, maskColor) {
        // Współrzędne przesunięcia (pan) widoku edytora
        const panX = this.maskTool.x;
        const panY = this.maskTool.y;

        log.info("Processing mask for editor:", {
            sourceSize: {width: maskData.width, height: maskData.height},
            targetSize: {width: targetWidth, height: targetHeight},
            viewportPan: {x: panX, y: panY}
        });

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});

        const sourceX = -panX;
        const sourceY = -panY;

        tempCtx.drawImage(
            maskData,       // Źródło: pełna maska z "output area"
            sourceX,        // sx: Prawdziwa współrzędna X na dużej masce (np. 1000)
            sourceY,        // sy: Prawdziwa współrzędna Y na dużej masce (np. 1000)
            targetWidth,    // sWidth: Szerokość wycinanego fragmentu
            targetHeight,   // sHeight: Wysokość wycinanego fragmentu
            0,              // dx: Gdzie wkleić w płótnie docelowym (zawsze 0)
            0,              // dy: Gdzie wkleić w płótnie docelowym (zawsze 0)
            targetWidth,    // dWidth: Szerokość wklejanego obrazu
            targetHeight    // dHeight: Wysokość wklejanego obrazu
        );

        log.info("Mask viewport cropped correctly.", {
            source: "maskData",
            cropArea: {x: sourceX, y: sourceY, width: targetWidth, height: targetHeight}
        });

        // Reszta kodu (zmiana koloru) pozostaje bez zmian
        const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha > 0) {
                data[i] = maskColor.r;
                data[i + 1] = maskColor.g;
                data[i + 2] = maskColor.b;
            }
        }

        tempCtx.putImageData(imageData, 0, 0);

        log.info("Mask processing completed - color applied.");
        return tempCanvas;
    }

    /**
     * Tworzy obiekt Image z obecnej maski canvas
     * @returns {Promise<Image>} Promise zwracający obiekt Image z maską
     */
    async createMaskFromCurrentMask() {
        if (!this.maskTool || !this.maskTool.maskCanvas) {
            throw new Error("No mask canvas available");
        }

        return new Promise((resolve, reject) => {
            const maskImage = new Image();
            maskImage.onload = () => resolve(maskImage);
            maskImage.onerror = reject;
            maskImage.src = this.maskTool.maskCanvas.toDataURL();
        });
    }

    waitWhileMaskEditing() {
        if (mask_editor_showing(app)) {
            this.editorWasShowing = true;
        }

        if (!mask_editor_showing(app) && this.editorWasShowing) {
            this.editorWasShowing = false;
            setTimeout(() => this.handleMaskEditorClose(), 100);
        } else {
            setTimeout(this.waitWhileMaskEditing.bind(this), 100);
        }
    }

    /**
     * Zapisuje obecny stan maski przed otwarciem editora
     * @returns {Object} Zapisany stan maski
     */
    async saveMaskState() {
        if (!this.maskTool || !this.maskTool.maskCanvas) {
            return null;
        }

        const maskCanvas = this.maskTool.maskCanvas;
        const savedCanvas = document.createElement('canvas');
        savedCanvas.width = maskCanvas.width;
        savedCanvas.height = maskCanvas.height;
        const savedCtx = savedCanvas.getContext('2d', {willReadFrequently: true});
        savedCtx.drawImage(maskCanvas, 0, 0);

        return {
            maskData: savedCanvas,
            maskPosition: {
                x: this.maskTool.x,
                y: this.maskTool.y
            }
        };
    }

    /**
     * Przywraca zapisany stan maski
     * @param {Object} savedState - Zapisany stan maski
     */
    async restoreMaskState(savedState) {
        if (!savedState || !this.maskTool) {
            return;
        }

        if (savedState.maskData) {
            const maskCtx = this.maskTool.maskCtx;
            maskCtx.clearRect(0, 0, this.maskTool.maskCanvas.width, this.maskTool.maskCanvas.height);
            maskCtx.drawImage(savedState.maskData, 0, 0);
        }

        if (savedState.maskPosition) {
            this.maskTool.x = savedState.maskPosition.x;
            this.maskTool.y = savedState.maskPosition.y;
        }

        this.render();
        log.info("Mask state restored after cancel");
    }

    /**
     * Konfiguruje nasłuchiwanie na przycisk Cancel w mask editorze
     */
    setupCancelListener() {
        mask_editor_listen_for_cancel(app, () => {
            log.info("Mask editor cancel button clicked");
            this.maskEditorCancelled = true;
        });
    }

    /**
     * Sprawdza czy mask editor został anulowany i obsługuje to odpowiednio
     */
    async handleMaskEditorClose() {
        log.info("Handling mask editor close");
        log.debug("Node object after mask editor close:", this.node);

        if (this.maskEditorCancelled) {
            log.info("Mask editor was cancelled - restoring original mask state");

            if (this.savedMaskState) {
                await this.restoreMaskState(this.savedMaskState);
            }

            this.maskEditorCancelled = false;
            this.savedMaskState = null;

            return;
        }

        if (!this.node.imgs || !this.node.imgs.length === 0 || !this.node.imgs[0].src) {
            log.warn("Mask editor was closed without a result.");
            return;
        }

        log.debug("Processing mask editor result, image source:", this.node.imgs[0].src.substring(0, 100) + '...');

        const resultImage = new Image();
        resultImage.src = this.node.imgs[0].src;

        try {
            await new Promise((resolve, reject) => {
                resultImage.onload = resolve;
                resultImage.onerror = reject;
            });

            log.debug("Result image loaded successfully", {
                width: resultImage.width,
                height: resultImage.height
            });
        } catch (error) {
            log.error("Failed to load image from mask editor.", error);
            this.node.imgs = [];
            return;
        }

        log.debug("Creating temporary canvas for mask processing");
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});

        tempCtx.drawImage(resultImage, 0, 0, this.width, this.height);

        log.debug("Processing image data to create mask");
        const imageData = tempCtx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const originalAlpha = data[i + 3];
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255 - originalAlpha;
        }

        tempCtx.putImageData(imageData, 0, 0);

        log.debug("Converting processed mask to image");
        const maskAsImage = new Image();
        maskAsImage.src = tempCanvas.toDataURL();
        await new Promise(resolve => maskAsImage.onload = resolve);

        const maskCtx = this.maskTool.maskCtx;
        const destX = -this.maskTool.x;
        const destY = -this.maskTool.y;

        log.debug("Applying mask to canvas", {destX, destY});

        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.clearRect(destX, destY, this.width, this.height);

        maskCtx.drawImage(maskAsImage, destX, destY);

        this.render();
        this.saveState();

        log.debug("Creating new preview image");
        const new_preview = new Image();

        const blob = await this.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        if (blob) {
            new_preview.src = URL.createObjectURL(blob);
            await new Promise(r => new_preview.onload = r);
            this.node.imgs = [new_preview];
            log.debug("New preview image created successfully");
        } else {
            this.node.imgs = [];
            log.warn("Failed to create preview blob");
        }

        this.render();

        this.savedMaskState = null;
        log.info("Mask editor result processed successfully");
    }
}
