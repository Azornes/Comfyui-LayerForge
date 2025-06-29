import { app, ComfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {removeImage} from "./db.js";
import {MaskTool} from "./MaskTool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
import {CanvasIO} from "./CanvasIO.js";
import {ImageReferenceManager} from "./ImageReferenceManager.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import { mask_editor_showing } from "./utils/mask_utils.js";

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
        this.ctx = this.canvas.getContext('2d');
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
        
        // Inicjalizacja modułów
        this._initializeModules(callbacks);
        
        // Podstawowa konfiguracja
        this._setupCanvas();
        
        // Delegacja interaction dla kompatybilności wstecznej
        this.interaction = this.canvasInteractions.interaction;
    }

    /**
     * Inicjalizuje moduły systemu canvas
     * @private
     */
    _initializeModules(callbacks) {
        // Moduły są publiczne dla bezpośredniego dostępu gdy potrzebne
        this.maskTool = new MaskTool(this, {onStateChange: this.onStateChange});
        this.canvasState = new CanvasState(this);
        this.canvasInteractions = new CanvasInteractions(this);
        this.canvasLayers = new CanvasLayers(this);
        this.canvasRenderer = new CanvasRenderer(this);
        this.canvasIO = new CanvasIO(this);
        this.imageReferenceManager = new ImageReferenceManager(this);
    }

    /**
     * Konfiguruje podstawowe właściwości canvas
     * @private
     */
    _setupCanvas() {
        this.initCanvas();
        this.canvasInteractions.setupEventListeners();
        this.canvasIO.initNodeData();
        
        // Inicjalizacja warstw z domyślną przezroczystością
        this.layers = this.layers.map(layer => ({
            ...layer,
            opacity: 1
        }));
    }

    // ==========================================
    // GŁÓWNE OPERACJE FASADY
    // ==========================================

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
    }

    /**
     * Zapisuje obecny stan
     * @param {boolean} replaceLast - Czy zastąpić ostatni stan w historii
     */
    saveState(replaceLast = false) {
        this.canvasState.saveState(replaceLast);
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    /**
     * Cofnij ostatnią operację
     */
    undo() {
        this.canvasState.undo();
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    /**
     * Ponów cofniętą operację
     */
    redo() {
        this.canvasState.redo();
        this.incrementOperationCount();
        this._notifyStateChange();
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
        return this.canvasLayers.addLayerWithImage(image, layerProps, addMode);
    }

    /**
     * Usuwa wybrane warstwy
     */
    removeSelectedLayers() {
        if (this.selectedLayers.length > 0) {
            this.saveState();
            this.layers = this.layers.filter(l => !this.selectedLayers.includes(l));
            this.updateSelection([]);
            this.render();
            this.saveState();
        }
    }

    /**
     * Aktualizuje zaznaczenie warstw
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection) {
        this.selectedLayers = newSelection || [];
        this.selectedLayer = this.selectedLayers.length > 0 ? this.selectedLayers[this.selectedLayers.length - 1] : null;
        if (this.onSelectionChange) {
            this.onSelectionChange();
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

    // ==========================================
    // OPERACJE NA MASCE
    // ==========================================

    /**
     * Uruchamia edytor masek
     */
    async startMaskEditor() {
        // Dla edytora masek używamy zwykłego spłaszczonego obrazu bez alpha
        const blob = await this.canvasLayers.getFlattenedCanvasAsBlob();
        if (!blob) {
            log.warn("Canvas is empty, cannot open mask editor.");
            return;
        }

        try {
            const formData = new FormData();
            const filename = `layerforge-mask-edit-${+new Date()}.png`;
            formData.append("image", blob, filename);
            formData.append("overwrite", "true");
            formData.append("type", "temp");

            const response = await api.fetchApi("/upload/image", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`Failed to upload image: ${response.statusText}`);
            }
            const data = await response.json();
            
            const img = new Image();
            img.src = api.apiURL(`/view?filename=${encodeURIComponent(data.name)}&type=${data.type}&subfolder=${data.subfolder}`);
            await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = rej;
            });
            
            this.node.imgs = [img];

            ComfyApp.copyToClipspace(this.node);
            ComfyApp.clipspace_return_node = this.node;
            ComfyApp.open_maskeditor();
            
            this.editorWasShowing = false;
            this.waitWhileMaskEditing();

        } catch (error) {
            log.error("Error preparing image for mask editor:", error);
            alert(`Error: ${error.message}`);
        }
    }

    // ==========================================
    // METODY POMOCNICZE
    // ==========================================

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

        return { x: mouseX_Canvas, y: mouseY_Canvas };
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

    // ==========================================
    // METODY DLA EDYTORA MASEK
    // ==========================================

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

    async handleMaskEditorClose() {
        console.log("Node object after mask editor close:", this.node);
        if (!this.node.imgs || !this.node.imgs.length === 0 || !this.node.imgs[0].src) {
            log.warn("Mask editor was closed without a result.");
            return;
        }

        const resultImage = new Image();
        resultImage.src = this.node.imgs[0].src;

        try {
            await new Promise((resolve, reject) => {
                resultImage.onload = resolve;
                resultImage.onerror = reject;
            });
        } catch (error) {
            log.error("Failed to load image from mask editor.", error);
            this.node.imgs = [];
            return;
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d');
        
        tempCtx.drawImage(resultImage, 0, 0, this.width, this.height);

        const imageData = tempCtx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const originalAlpha = data[i + 3];
            data[i]     = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255 - originalAlpha;
        }

        tempCtx.putImageData(imageData, 0, 0);

        const maskAsImage = new Image();
        maskAsImage.src = tempCanvas.toDataURL();
        await new Promise(resolve => maskAsImage.onload = resolve);
        
        const maskCtx = this.maskTool.maskCtx;
        const destX = -this.maskTool.x;
        const destY = -this.maskTool.y;
        
        maskCtx.globalCompositeOperation = 'screen';
        maskCtx.drawImage(maskAsImage, destX, destY);
        maskCtx.globalCompositeOperation = 'source-over';
        
        this.render();
        this.saveState();
        
        const new_preview = new Image();
        // Użyj nowej metody z maską jako kanałem alpha
        const blob = await this.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
        if (blob) {
            new_preview.src = URL.createObjectURL(blob);
            await new Promise(r => new_preview.onload = r);
            this.node.imgs = [new_preview];
        } else {
            this.node.imgs = [];
        }

        this.render();
    }
}
