// @ts-ignore
import { api } from "../../scripts/api.js";
import { MaskTool } from "./MaskTool.js";
import { ShapeTool } from "./ShapeTool.js";
import { CustomShapeMenu } from "./CustomShapeMenu.js";
import { CanvasState } from "./CanvasState.js";
import { CanvasInteractions } from "./CanvasInteractions.js";
import { CanvasLayers } from "./CanvasLayers.js";
import { CanvasLayersPanel } from "./CanvasLayersPanel.js";
import { CanvasRenderer } from "./CanvasRenderer.js";
import { CanvasIO } from "./CanvasIO.js";
import { ImageReferenceManager } from "./ImageReferenceManager.js";
import { BatchPreviewManager } from "./BatchPreviewManager.js";
import { createModuleLogger } from "./utils/LoggerUtils.js";
import { debounce, createCanvas } from "./utils/CommonUtils.js";
import { MaskEditorIntegration } from "./MaskEditorIntegration.js";
import { CanvasSelection } from "./CanvasSelection.js";
const useChainCallback = (original, next) => {
    if (original === undefined || original === null) {
        return next;
    }
    return function (...args) {
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
        const { canvas, ctx } = createCanvas(0, 0, '2d', { willReadFrequently: true });
        if (!ctx)
            throw new Error("Could not create canvas context");
        this.canvas = canvas;
        this.ctx = ctx;
        this.width = 512;
        this.height = 512;
        this.layers = [];
        this.onStateChange = callbacks.onStateChange;
        this.onHistoryChange = callbacks.onHistoryChange;
        this.onViewportChange = null;
        this.lastMousePosition = { x: 0, y: 0 };
        this.viewport = {
            x: -(this.width / 1.5),
            y: -(this.height / 2),
            zoom: 0.8,
        };
        const { canvas: offscreenCanvas, ctx: offscreenCtx } = createCanvas(0, 0, '2d', {
            alpha: false,
            willReadFrequently: true
        });
        this.offscreenCanvas = offscreenCanvas;
        this.offscreenCtx = offscreenCtx;
        // Create overlay canvas for brush cursor and other lightweight overlays
        const { canvas: overlayCanvas, ctx: overlayCtx } = createCanvas(0, 0, '2d', {
            alpha: true,
            willReadFrequently: false
        });
        if (!overlayCtx)
            throw new Error("Could not create overlay canvas context");
        this.overlayCanvas = overlayCanvas;
        this.overlayCtx = overlayCtx;
        this.canvasContainer = null;
        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.pendingInputDataCheck = null;
        this.inputDataLoaded = false;
        this.imageCache = new Map();
        this.requestSaveState = () => { };
        this.outputAreaShape = null;
        this.autoApplyShapeMask = false;
        this.shapeMaskExpansion = false;
        this.shapeMaskExpansionValue = 0;
        this.shapeMaskFeather = false;
        this.shapeMaskFeatherValue = 0;
        this.outputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        this.outputAreaExtensionEnabled = false;
        this.outputAreaExtensionPreview = null;
        this.lastOutputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
        this.originalCanvasSize = { width: this.width, height: this.height };
        this.originalOutputAreaPosition = { x: -(this.width / 4), y: -(this.height / 4) };
        // Initialize outputAreaBounds centered in viewport, similar to how canvas resize/move work
        this.outputAreaBounds = {
            x: -(this.width / 4),
            y: -(this.height / 4),
            width: this.width,
            height: this.height
        };
        this.maskTool = new MaskTool(this, { onStateChange: this.onStateChange });
        this.shapeTool = new ShapeTool(this);
        this.customShapeMenu = new CustomShapeMenu(this);
        this.maskEditorIntegration = new MaskEditorIntegration(this);
        this.canvasState = new CanvasState(this);
        this.canvasSelection = new CanvasSelection(this);
        this.canvasInteractions = new CanvasInteractions(this);
        this.canvasLayers = new CanvasLayers(this);
        this.canvasLayersPanel = new CanvasLayersPanel(this);
        this.canvasRenderer = new CanvasRenderer(this);
        this.canvasIO = new CanvasIO(this);
        this.imageReferenceManager = new ImageReferenceManager(this);
        this.batchPreviewManagers = [];
        this.pendingBatchContext = null;
        this.interaction = this.canvasInteractions.interaction;
        this.previewVisible = false;
        this.isMouseOver = false;
        this._initializeModules();
        this._setupCanvas();
        log.debug('Canvas widget element:', this.node);
        log.info('Canvas initialized', {
            nodeId: this.node.id,
            dimensions: { width: this.width, height: this.height },
            viewport: this.viewport
        });
        this.previewVisible = false;
    }
    async waitForWidget(name, node, interval = 100, timeout = 20000) {
        const startTime = Date.now();
        return new Promise((resolve, reject) => {
            const check = () => {
                const widget = node.widgets.find((w) => w.name === name);
                if (widget) {
                    resolve(widget);
                }
                else if (Date.now() - startTime > timeout) {
                    reject(new Error(`Widget "${name}" not found within timeout.`));
                }
                else {
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
            }
            else {
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
            this.render();
        }
        else {
            log.warn("$$canvas-image-preview widget not found in Canvas.js");
        }
    }
    /**
     * Inicjalizuje moduły systemu canvas
     * @private
     */
    _initializeModules() {
        log.debug('Initializing Canvas modules...');
        // Stwórz opóźnioną wersję funkcji zapisu stanu
        this.requestSaveState = debounce(() => this.saveState(), 500);
        this._setupAutoRefreshHandlers();
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
        this.layers = this.layers.map((layer) => ({
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
        log.debug('Saving canvas state', { replaceLast, layersCount: this.layers.length });
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
        if (!layerIds || layerIds.length === 0)
            return;
        const initialCount = this.layers.length;
        this.saveState();
        this.layers = this.layers.filter((l) => !layerIds.includes(l.id));
        // If the current selection was part of the removal, clear it
        const newSelection = this.canvasSelection.selectedLayers.filter((l) => !layerIds.includes(l.id));
        this.canvasSelection.updateSelection(newSelection);
        this.render();
        this.saveState();
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        log.info(`Removed ${initialCount - this.layers.length} layers by ID.`);
    }
    removeSelectedLayers() {
        return this.canvasSelection.removeSelectedLayers();
    }
    /**
     * Aktualizuje zaznaczenie warstw i powiadamia wszystkie komponenty.
     * To jest "jedyne źródło prawdy" o zmianie zaznaczenia.
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection) {
        return this.canvasSelection.updateSelection(newSelection);
    }
    /**
     * Logika aktualizacji zaznaczenia, wywoływana przez panel warstw.
     */
    updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index) {
        return this.canvasSelection.updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index);
    }
    defineOutputAreaWithShape(shape) {
        this.canvasInteractions.defineOutputAreaWithShape(shape);
    }
    /**
     * Zmienia rozmiar obszaru wyjściowego
     * @param {number} width - Nowa szerokość
     * @param {number} height - Nowa wysokość
     * @param {boolean} saveHistory - Czy zapisać w historii
     */
    updateOutputAreaSize(width, height, saveHistory = true) {
        const result = this.canvasLayers.updateOutputAreaSize(width, height, saveHistory);
        // Update mask canvas to ensure it covers the new output area
        this.maskTool.updateMaskCanvasForOutputArea();
        return result;
    }
    /**
     * Ustawia nowy rozmiar output area zgodnie z nowym systemem (resetuje rozszerzenia, pozycję, rozmiar)
     * (Fasada: deleguje do CanvasLayers)
     */
    setOutputAreaSize(width, height) {
        this.canvasLayers.setOutputAreaSize(width, height);
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
    _setupAutoRefreshHandlers() {
        let lastExecutionStartTime = 0;
        // Helper function to get auto-refresh value from node widget
        const getAutoRefreshValue = () => {
            const widget = this.node.widgets.find((w) => w.name === 'auto_refresh_after_generation');
            return widget ? widget.value : false;
        };
        const handleExecutionStart = () => {
            // Check for input data when execution starts, but don't reset the flag
            log.debug('Execution started, checking for input data...');
            // On start, only allow images; mask should load on mask-connect or after execution completes
            this.canvasIO.checkForInputData({ allowImage: true, allowMask: false, reason: 'execution_start' });
            if (getAutoRefreshValue()) {
                lastExecutionStartTime = Date.now();
                // Store a snapshot of the context for the upcoming batch
                this.pendingBatchContext = {
                    // For the menu position - position relative to outputAreaBounds, not canvas center
                    spawnPosition: {
                        x: this.outputAreaBounds.x + this.outputAreaBounds.width / 2,
                        y: this.outputAreaBounds.y + this.outputAreaBounds.height
                    },
                    // For the image placement - use actual outputAreaBounds instead of hardcoded (0,0)
                    outputArea: {
                        x: this.outputAreaBounds.x,
                        y: this.outputAreaBounds.y,
                        width: this.outputAreaBounds.width,
                        height: this.outputAreaBounds.height
                    }
                };
                log.debug(`Execution started, pending batch context captured:`, this.pendingBatchContext);
                this.render(); // Trigger render to show the pending outline immediately
            }
        };
        const handleExecutionSuccess = async () => {
            // Always check for input data after execution completes
            log.debug('Execution success, checking for input data...');
            await this.canvasIO.checkForInputData({ allowImage: true, allowMask: true, reason: 'execution_success' });
            if (getAutoRefreshValue()) {
                log.info('Auto-refresh triggered, importing latest images.');
                if (!this.pendingBatchContext) {
                    log.warn("execution_start did not fire, cannot process batch. Awaiting next execution.");
                    return;
                }
                // Use the captured output area for image import
                const newLayers = await this.canvasIO.importLatestImages(lastExecutionStartTime, this.pendingBatchContext.outputArea);
                if (newLayers && newLayers.length > 1) {
                    const newManager = new BatchPreviewManager(this, this.pendingBatchContext.spawnPosition, this.pendingBatchContext.outputArea);
                    this.batchPreviewManagers.push(newManager);
                    newManager.show(newLayers);
                }
                // Consume the context
                this.pendingBatchContext = null;
                // Final render to clear the outline if it was the last one
                this.render();
            }
        };
        api.addEventListener('execution_start', handleExecutionStart);
        api.addEventListener('execution_success', handleExecutionSuccess);
        this.node.onRemoved = useChainCallback(this.node.onRemoved, () => {
            log.info('Node removed, cleaning up auto-refresh listeners.');
            api.removeEventListener('execution_start', handleExecutionStart);
            api.removeEventListener('execution_success', handleExecutionSuccess);
        });
        log.debug('Auto-refresh handlers setup complete, reading from node widget: auto_refresh_after_generation');
    }
    /**
     * Uruchamia edytor masek
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask = null, sendCleanImage = true) {
        return this.maskEditorIntegration.startMaskEditor(predefinedMask, sendCleanImage);
    }
    /**
     * Inicjalizuje podstawowe właściwości canvas
     */
    initCanvas() {
        // Don't set canvas.width/height here - let the render loop handle it based on clientWidth/clientHeight
        // this.width and this.height are for the OUTPUT AREA, not the display canvas
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
        if (!this.offscreenCanvas)
            throw new Error("Offscreen canvas not initialized");
        const scaleX = this.offscreenCanvas.width / rect.width;
        const scaleY = this.offscreenCanvas.height / rect.height;
        const mouseX_Buffer = mouseX_DOM * scaleX;
        const mouseY_Buffer = mouseY_DOM * scaleY;
        const worldX = (mouseX_Buffer / this.viewport.zoom) + this.viewport.x;
        const worldY = (mouseY_Buffer / this.viewport.zoom) + this.viewport.y;
        return { x: worldX, y: worldY };
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
        return { x: mouseX_Canvas, y: mouseY_Canvas };
    }
    /**
     * Aktualizuje zaznaczenie po operacji historii
     */
    updateSelectionAfterHistory() {
        return this.canvasSelection.updateSelectionAfterHistory();
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
}
