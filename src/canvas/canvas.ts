// @ts-ignore
import {api} from "../../../scripts/api.js";
// @ts-ignore
import {app} from "../../../scripts/app.js";
// @ts-ignore
import {ComfyApp} from "../../../scripts/app.js";

import {removeImage} from "../persistence/db.js";
import {MaskTool} from "../mask/mask_tool.js";
import {ShapeTool} from "./shape_tool.js";
import {CustomShapeMenu} from "./custom_shape_menu.js";
import {CanvasState} from "./canvas_state.js";
import {CanvasInteractions} from "./canvas_interactions.js";
import {CanvasLayers} from "./canvas_layers.js";
import {CanvasLayersPanel} from "./canvas_layers_panel.js";
import {CanvasRenderer} from "./canvas_renderer.js";
import {CanvasIO} from "../io/canvas_io.js";
import {ImageReferenceManager} from "../persistence/image_reference_manager.js";
import {BatchPreviewManager} from "./batch_preview_manager.js";
import {ImageCache} from "../media/image_cache.js";
import {createModuleLogger} from "../log_system/log_funcs.js";
import { debounce, createCanvas } from "../utils/common_utils.js";
import {MaskEditorIntegration} from "../mask/mask_editor_integration.js";
import {CanvasSelection} from "./canvas_selection.js";
import {removeLayersWithLifecycle} from "../utils/layer_removal_utils.js";
import type { ComfyNode, Layer, Viewport, Point, AddMode, Shape, OutputAreaBounds } from '../shared/types';

const useChainCallback = (original: any, next: any) => {
  if (original === undefined || original === null) {
    return next;
  }
  return function(this: any, ...args: any[]) {
    const originalReturn = original.apply(this, args);
    const nextReturn = next.apply(this, args);
    return nextReturn === undefined ? originalReturn : nextReturn;
  };
};

const log = createModuleLogger('Canvas');

const CANVAS_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";
const NATIVE_PREVIEW_HEIGHT = 180;

export const configureCanvasImagePreviewWidget = (imagePreviewWidget: any, visible: boolean): void => {
    const previewHeight = visible ? NATIVE_PREVIEW_HEIGHT : 0;

    if (imagePreviewWidget.options) {
        imagePreviewWidget.options.hidden = !visible;
        imagePreviewWidget.options.visible = visible;
        imagePreviewWidget.options.getMinHeight = () => previewHeight;
        imagePreviewWidget.options.getHeight = () => previewHeight;
        imagePreviewWidget.options.getMaxHeight = () => previewHeight;
    }
    imagePreviewWidget.hidden = !visible;
    if ('visible' in imagePreviewWidget) {
        imagePreviewWidget.visible = visible;
    }

    // Recent ComfyUI versions use computeLayoutSize(), while older versions
    // use computeSize(). Configure both before the widget enters the node.
    imagePreviewWidget.computeLayoutSize = () => ({
        minHeight: previewHeight,
        maxHeight: previewHeight,
        minWidth: visible ? 1 : 0,
    });
    imagePreviewWidget.computeSize = () => [0, previewHeight];
};

/**
 * Canvas - Fasada dla systemu rysowania
 *
 * Klasa Canvas pełni rolę fasady, oferując uproszczony interfejs wysokiego poziomu
 * dla złożonego systemu rysowania. Zamiast eksponować wszystkie metody modułów,
 * udostępnia tylko kluczowe operacje i umożliwia bezpośredni dostęp do modułów
 * gdy potrzebna jest bardziej szczegółowa kontrola.
 */
export class Canvas {
    batchPreviewManagers: BatchPreviewManager[];
    canvas: HTMLCanvasElement;
    canvasContainer: HTMLDivElement | null;
    canvasIO: CanvasIO;
    canvasInteractions: CanvasInteractions;
    canvasLayers: CanvasLayers;
    canvasLayersPanel: CanvasLayersPanel;
    maskEditorIntegration: MaskEditorIntegration;
    canvasRenderer: CanvasRenderer;
    canvasSelection: CanvasSelection;
    canvasState: CanvasState;
    ctx: CanvasRenderingContext2D;
    dataInitialized: boolean;
    height: number;
    imageCache: ImageCache;
    imageReferenceManager: ImageReferenceManager;
    interaction: any;
    isMouseOver: boolean;
    lastMousePosition: Point;
    layers: Layer[];
    maskTool: MaskTool;
    shapeTool: ShapeTool;
    customShapeMenu: CustomShapeMenu;
    outputAreaShape: Shape | null;
    autoApplyShapeMask: boolean;
    shapeMaskExpansion: boolean;
    shapeMaskExpansionValue: number;
    shapeMaskFeather: boolean;
    shapeMaskFeatherValue: number;
    outputAreaExtensions: { top: number, bottom: number, left: number, right: number };
    outputAreaExtensionEnabled: boolean;
    outputAreaExtensionPreview: { top: number, bottom: number, left: number, right: number } | null;
    lastOutputAreaExtensions: { top: number, bottom: number, left: number, right: number };
    originalCanvasSize: { width: number, height: number };
    originalOutputAreaPosition: { x: number, y: number };
    outputAreaBounds: OutputAreaBounds;
    node: ComfyNode;
    offscreenCanvas: HTMLCanvasElement;
    offscreenCtx: CanvasRenderingContext2D | null;
    overlayCanvas: HTMLCanvasElement;
    overlayCtx: CanvasRenderingContext2D;
    onHistoryChange: ((historyInfo: { canUndo: boolean; canRedo: boolean; }) => void) | undefined;
    onViewportChange: (() => void) | null;
    onStateChange: (() => void) | undefined;
    pendingBatchContext: any;
    pendingDataCheck: number | null;
    pendingInputDataCheck: number | null;
    inputDataLoaded: boolean;
    initialStateLoaded: boolean;
    private initialStateLoadPromise: Promise<void> | null;
    lastLoadedImageSrc?: string;
    lastLoadedLinkId?: string | number;
    lastLoadedMaskLinkId?: string | number;
    previewVisible: boolean;
    requestSaveState: () => void;
    viewport: Viewport;
    widget: any;
    width: number;

    constructor(node: ComfyNode, widget: any, callbacks: { onStateChange?: () => void, onHistoryChange?: (historyInfo: { canUndo: boolean; canRedo: boolean; }) => void } = {}) {
        this.node = node;
        this.widget = widget;
        // These contexts only draw and blit rendered frames. Keeping them on
        // the normal compositor path allows the browser to use GPU-backed
        // canvas acceleration instead of preparing for frequent pixel reads.
        const { canvas, ctx } = createCanvas(0, 0, '2d');
        if (!ctx) throw new Error("Could not create canvas context");
        this.canvas = canvas;
        this.ctx = ctx;
        this.width = 512;
        this.height = 512;
        this.layers = [];
        this.onStateChange = callbacks.onStateChange;
        this.onHistoryChange = callbacks.onHistoryChange;
        this.onViewportChange = null;
        this.lastMousePosition = {x: 0, y: 0};

        this.viewport = {
            x: -(this.width / 1.5),
            y: -(this.height / 2),
            zoom: 0.8,
        };

        const { canvas: offscreenCanvas, ctx: offscreenCtx } = createCanvas(0, 0, '2d', {
            alpha: false
        });
        this.offscreenCanvas = offscreenCanvas;
        this.offscreenCtx = offscreenCtx;
        
        // Create overlay canvas for brush cursor and other lightweight overlays
        const { canvas: overlayCanvas, ctx: overlayCtx } = createCanvas(0, 0, '2d', {
            alpha: true,
            willReadFrequently: false
        });
        if (!overlayCtx) throw new Error("Could not create overlay canvas context");
        this.overlayCanvas = overlayCanvas;
        this.overlayCtx = overlayCtx;
        
        this.canvasContainer = null;

        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.pendingInputDataCheck = null;
        this.inputDataLoaded = false;
        this.initialStateLoaded = false;
        this.initialStateLoadPromise = null;
        this.imageCache = new ImageCache();

        this.requestSaveState = () => {};
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
        this.maskTool = new MaskTool(this, {onStateChange: this.onStateChange});
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
            dimensions: {width: this.width, height: this.height},
            viewport: this.viewport
        });

        this.previewVisible = false;
    }

    async waitForWidget(name: any, node: any, interval = 100, timeout = 20000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const check = () => {
                const widget = node.widgets.find((w: any) => w.name === name);
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
    async setPreviewVisibility(visible: boolean) {
        this.previewVisible = visible;
        log.info("Canvas preview visibility set to:", visible);

        let imagePreviewWidget = this.node.widgets?.find((widget: any) => widget.name === CANVAS_IMAGE_PREVIEW_WIDGET) as any;
        if (!imagePreviewWidget) {
            imagePreviewWidget = await this.waitForWidget(CANVAS_IMAGE_PREVIEW_WIDGET, this.node).catch(() => null) as any;
        }
        if (imagePreviewWidget) {
            log.debug("Found $$canvas-image-preview widget, controlling visibility");

            configureCanvasImagePreviewWidget(imagePreviewWidget, visible);

            this.node.setDirtyCanvas?.(true, true);
            this.render();
        } else {
            log.warn("$$canvas-image-preview widget not found in canvas.js");
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
        // Input images are checked after IndexedDB state has been restored in
        // loadInitialState(). Starting the check here races with state loading
        // and can create a second copy of every connected input image.

        this.layers = this.layers.map((layer: Layer) => ({
            ...layer,
            opacity: 1
        }));
    }

    /**
     * Ładuje stan canvas z bazy danych
     */
    async loadInitialState() {
        if (this.initialStateLoadPromise) {
            return this.initialStateLoadPromise;
        }

        const loadPromise = this._loadInitialState();
        this.initialStateLoadPromise = loadPromise;
        try {
            await loadPromise;
        } finally {
            if (this.initialStateLoadPromise === loadPromise) {
                this.initialStateLoadPromise = null;
            }
        }
    }

    private async _loadInitialState() {
        log.info("Loading initial state for node:", this.node.id);
        const loaded = await this.canvasState.loadStateFromDB();
        this.initialStateLoaded = true;

        if (!loaded) {
            log.info("No saved state found, initializing from node data.");
            await this.canvasIO.initNodeData();
        } else {
            // A workflow can be restored with connected inputs. Check them
            // only after the persisted layers are present so the input loader
            // can recognize already imported images.
            await this.canvasIO.checkForInputData({
                allowImage: true,
                allowMask: false,
                reason: 'initial_state_loaded',
            });
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
    render(preserveZoomSnapshot = false) {
        if (!preserveZoomSnapshot) {
            this.canvasRenderer.invalidateZoomSnapshot();
        }
        this.canvasRenderer.render();
    }

    /**
     * Dodaje warstwę z obrazem
     * @param {Image} image - Obraz do dodania
     * @param {Object} layerProps - Właściwości warstwy
     * @param {string} addMode - Tryb dodawania
     */
    async addLayer(image: HTMLImageElement, layerProps = {}, addMode: AddMode = 'default') {
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
    removeLayersByIds(layerIds: string[]) {
        if (!layerIds || layerIds.length === 0) return;

        removeLayersWithLifecycle(
            this,
            layer => layerIds.includes(layer.id),
            removedCount => log.info(`Removed ${removedCount} layers by ID.`),
        );
    }

    removeSelectedLayers() {
        return this.canvasSelection.removeSelectedLayers();
    }

    /**
     * Aktualizuje zaznaczenie warstw i powiadamia wszystkie komponenty.
     * To jest "jedyne źródło prawdy" o zmianie zaznaczenia.
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection: any) {
        return this.canvasSelection.updateSelection(newSelection);
    }

    /**
     * Logika aktualizacji zaznaczenia, wywoływana przez panel warstw.
     */
    updateSelectionLogic(layer: Layer, isCtrlPressed: boolean, isShiftPressed: boolean, index: number) {
        return this.canvasSelection.updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index);
    }

    defineOutputAreaWithShape(shape: Shape): void {
        this.canvasInteractions.defineOutputAreaWithShape(shape);
    }

    /**
     * Zmienia rozmiar obszaru wyjściowego
     * @param {number} width - Nowa szerokość
     * @param {number} height - Nowa wysokość
     * @param {boolean} saveHistory - Czy zapisać w historii
     */
    updateOutputAreaSize(width: number, height: number, saveHistory = true) {
        const result = this.canvasLayers.updateOutputAreaSize(width, height, saveHistory);
        
        // Update mask canvas to ensure it covers the new output area
        this.maskTool.updateMaskCanvasForOutputArea();
        
        return result;
    }

    /**
     * Ustawia nowy rozmiar output area zgodnie z nowym systemem (resetuje rozszerzenia, pozycję, rozmiar)
     * (Fasada: deleguje do CanvasLayers)
     */
    setOutputAreaSize(width: number, height: number) {
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
        const getAutoRefreshValue = (): boolean => {
            const widget = this.node.widgets.find((w: any) => w.name === 'auto_refresh_after_generation');
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
                const newLayers = await this.canvasIO.importLatestImages(
                    lastExecutionStartTime,
                    this.pendingBatchContext.outputArea
                );

                if (newLayers && newLayers.length > 1) {
                    const newManager = new BatchPreviewManager(
                        this,
                        this.pendingBatchContext.spawnPosition,
                        this.pendingBatchContext.outputArea 
                    );
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

        (this.node as any).onRemoved = useChainCallback((this.node as any).onRemoved, () => {
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
    async startMaskEditor(predefinedMask: HTMLImageElement | HTMLCanvasElement | null = null, sendCleanImage: boolean = true) {
        return this.maskEditorIntegration.startMaskEditor(predefinedMask as any, sendCleanImage);
    }

    /**
     * Inicjalizuje podstawowe właściwości canvas
     */
    initCanvas() {
        // Don't set canvas.width/height here - let the render loop handle it based on clientWidth/clientHeight
        // this.width and this.height are for the OUTPUT AREA, not the display canvas
        this.canvas.style.border = '1px solid rgba(255, 255, 255, 0.18)';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.backgroundColor = 'transparent';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.tabIndex = 0;
        this.canvas.style.outline = 'none';
    }

    /**
     * Pobiera współrzędne myszy w układzie świata
     * @param {MouseEvent} e - Zdarzenie myszy
     */
    getMouseWorldCoordinates(e: any) {
        const rect = this.canvas.getBoundingClientRect();

        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        if (!this.offscreenCanvas) throw new Error("Offscreen canvas not initialized");
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
    getMouseViewCoordinates(e: any) {
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
