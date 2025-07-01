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
import { mask_editor_showing, mask_editor_listen_for_cancel } from "./utils/mask_utils.js";

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

        console.log('Canvas widget element:', this.node);
                
        // Dodaj metodę do kontroli widoczności podglądu
        this.previewVisible = true; // Domyślnie widoczny
        this.setPreviewVisibility(false);
    }


    async waitForWidget(name, node, interval = 100, timeout = 5000) {
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
        console.log("Canvas preview visibility set to:", visible);
        
        // Znajdź i kontroluj ImagePreviewWidget
        const imagePreviewWidget = await this.waitForWidget("$$canvas-image-preview", this.node);
        if (imagePreviewWidget) {
            console.log("Found $$canvas-image-preview widget, controlling visibility");
            
            if (visible) {
                console.log("=== SHOWING WIDGET ===");
                
                // Pokaż widget
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = false;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = true;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = false;
                }

                console.log("Setting computeSize to fixed height 250");
                imagePreviewWidget.computeSize = function() {
                    return [0, 250]; // Szerokość 0 (auto), wysokość 250
                };
                
                console.log("ImagePreviewWidget shown");
            } else {
                console.log("=== HIDING WIDGET ===");
                
                // Ukryj widget
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = true;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = false;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = true;
                }
                
                imagePreviewWidget.computeSize = function() {
                    return [0, 0]; // Szerokość 0, wysokość 0
                };                
                
                console.log("ImagePreviewWidget hidden with zero size");
            }
            
            console.log("=== FINAL WIDGET STATE ===");
            this.render()
        } else {
            console.warn("$$canvas-image-preview widget not found in Canvas.js");
        }
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
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask = null, sendCleanImage = true) {
        // Zapisz obecny stan maski przed otwarciem editora (dla obsługi Cancel)
        this.savedMaskState = await this.saveMaskState();
        this.maskEditorCancelled = false;
        
        // Jeśli nie ma predefiniowanej maski, stwórz ją z istniejącej maski canvas
        if (!predefinedMask && this.maskTool && this.maskTool.maskCanvas) {
            try {
                predefinedMask = await this.createMaskFromCurrentMask();
            } catch (error) {
                log.warn("Could not create mask from current mask:", error);
            }
        }
        
        // Przechowaj maskę do późniejszego użycia
        this.pendingMask = predefinedMask;
        
        // Wybierz odpowiednią metodę w zależności od parametru sendCleanImage
        let blob;
        if (sendCleanImage) {
            // Wyślij czysty obraz bez maski (domyślne zachowanie)
            blob = await this.canvasLayers.getFlattenedCanvasAsBlob();
        } else {
            // Używamy specjalnej metody która łączy pełny obraz z istniejącą maską
            blob = await this.canvasLayers.getFlattenedCanvasForMaskEditor();
        }
        
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
        
        // Nasłuchuj na przycisk Cancel
        this.setupCancelListener();
        
        // Jeśli mamy predefiniowaną maskę, czekaj na otwarcie editora i nałóż ją
        if (predefinedMask) {
            this.waitForMaskEditorAndApplyMask();
        }

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

    /**
     * Czeka na otwarcie mask editora i automatycznie nakłada predefiniowaną maskę
     */
    waitForMaskEditorAndApplyMask() {
        let attempts = 0;
        const maxAttempts = 100; // Zwiększone do 10 sekund oczekiwania
        
        const checkEditor = () => {
            attempts++;
            
            if (mask_editor_showing(app)) {
                // Editor się otworzył - sprawdź czy jest w pełni zainicjalizowany
                const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');
                let editorReady = false;
                
                if (useNewEditor) {
                    // Sprawdź czy nowy editor jest gotowy - różne metody wykrywania
                    const MaskEditorDialog = window.MaskEditorDialog;
                    if (MaskEditorDialog && MaskEditorDialog.instance) {
                        // Sprawdź czy ma MessageBroker i czy canvas jest dostępny
                        try {
                            const messageBroker = MaskEditorDialog.instance.getMessageBroker();
                            if (messageBroker) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via MessageBroker");
                            }
                        } catch (e) {
                            // MessageBroker jeszcze nie gotowy
                            editorReady = false;
                        }
                    }
                    
                    // Alternatywne wykrywanie - sprawdź czy istnieje element maskEditor
                    if (!editorReady) {
                        const maskEditorElement = document.getElementById('maskEditor');
                        if (maskEditorElement && maskEditorElement.style.display !== 'none') {
                            // Sprawdź czy ma canvas wewnątrz
                            const canvas = maskEditorElement.querySelector('canvas');
                            if (canvas) {
                                editorReady = true;
                                log.info("New mask editor detected as ready via DOM element");
                            }
                        }
                    }
                } else {
                    // Sprawdź czy stary editor jest gotowy
                    const maskCanvas = document.getElementById('maskCanvas');
                    editorReady = maskCanvas && maskCanvas.getContext && maskCanvas.width > 0;
                    if (editorReady) {
                        log.info("Old mask editor detected as ready");
                    }
                }
                
                if (editorReady) {
                    // Editor jest gotowy - nałóż maskę po krótkim opóźnieniu
                    log.info("Applying mask to editor after", attempts * 100, "ms wait");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null; // Wyczyść po użyciu
                    }, 300); // Krótsze opóźnienie gdy już wiemy że jest gotowy
                } else if (attempts < maxAttempts) {
                    // Editor widoczny ale nie gotowy - sprawdź ponownie
                    if (attempts % 10 === 0) {
                        log.info("Waiting for mask editor to be ready... attempt", attempts, "/", maxAttempts);
                    }
                    setTimeout(checkEditor, 100);
                } else {
                    log.warn("Mask editor timeout - editor not ready after", maxAttempts * 100, "ms");
                    // Spróbuj nałożyć maskę mimo wszystko
                    log.info("Attempting to apply mask anyway...");
                    setTimeout(() => {
                        this.applyMaskToEditor(this.pendingMask);
                        this.pendingMask = null;
                    }, 100);
                }
            } else if (attempts < maxAttempts) {
                // Editor jeszcze nie widoczny - sprawdź ponownie
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
            // Sprawdź czy używamy nowego czy starego editora
            const useNewEditor = app.ui.settings.getSettingValue('Comfy.MaskEditor.UseNewEditor');
            
            if (useNewEditor) {
                // Sprawdź czy nowy editor jest rzeczywiście dostępny
                const MaskEditorDialog = window.MaskEditorDialog;
                if (MaskEditorDialog && MaskEditorDialog.instance) {
                    // Nowy editor - użyj MessageBroker
                    await this.applyMaskToNewEditor(maskData);
                } else {
                    log.warn("New editor setting enabled but instance not found, trying old editor");
                    await this.applyMaskToOldEditor(maskData);
                }
            } else {
                // Stary editor - bezpośredni dostęp do canvas
                await this.applyMaskToOldEditor(maskData);
            }
            
            log.info("Predefined mask applied to mask editor successfully");
        } catch (error) {
            log.error("Failed to apply predefined mask to editor:", error);
            // Spróbuj alternatywną metodę
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
        // Pobierz instancję nowego editora
        const MaskEditorDialog = window.MaskEditorDialog;
        if (!MaskEditorDialog || !MaskEditorDialog.instance) {
            throw new Error("New mask editor instance not found");
        }

        const editor = MaskEditorDialog.instance;
        const messageBroker = editor.getMessageBroker();
        
        // Pobierz canvas maski z editora
        const maskCanvas = await messageBroker.pull('maskCanvas');
        const maskCtx = await messageBroker.pull('maskCtx');
        const maskColor = await messageBroker.pull('getMaskColor');

        // Konwertuj maskę do odpowiedniego formatu
        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);
        
        // Nałóż maskę na canvas
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.drawImage(processedMask, 0, 0);
        
        // Zapisz stan dla undo/redo
        messageBroker.publish('saveState');
    }

    /**
     * Nakłada maskę na stary mask editor
     * @param {Image|HTMLCanvasElement} maskData - Dane maski
     */
    async applyMaskToOldEditor(maskData) {
        // Znajdź canvas maski w starym edytorze
        const maskCanvas = document.getElementById('maskCanvas');
        if (!maskCanvas) {
            throw new Error("Old mask editor canvas not found");
        }

        const maskCtx = maskCanvas.getContext('2d');
        
        // Konwertuj maskę do odpowiedniego formatu (dla starego editora używamy białego koloru)
        const maskColor = { r: 255, g: 255, b: 255 };
        const processedMask = await this.processMaskForEditor(maskData, maskCanvas.width, maskCanvas.height, maskColor);
        
        // Nałóż maskę na canvas
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
     */
    async processMaskForEditor(maskData, targetWidth, targetHeight, maskColor) {
        const originalWidth = maskData.width || maskData.naturalWidth || this.width;
        const originalHeight = maskData.height || maskData.naturalHeight || this.height;
        
        log.info("Processing mask for editor:", {
            originalSize: { width: originalWidth, height: originalHeight },
            targetSize: { width: targetWidth, height: targetHeight },
            canvasSize: { width: this.width, height: this.height }
        });

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d');

        // Wyczyść canvas
        tempCtx.clearRect(0, 0, targetWidth, targetHeight);

        // Skaluj maskę do originalSize zamiast targetSize
        // originalSize to prawdziwy rozmiar obrazu w mask editorze
        const scaleToOriginal = Math.min(originalWidth / this.width, originalHeight / this.height);
        
        // Maska powinna pokryć cały obszar originalSize
        const scaledWidth = this.width * scaleToOriginal;
        const scaledHeight = this.height * scaleToOriginal;
        
        // Wyśrodkuj na target canvas (który reprezentuje viewport mask editora)
        const offsetX = (targetWidth - scaledWidth) / 2;
        const offsetY = (targetHeight - scaledHeight) / 2;
        
        tempCtx.drawImage(maskData, offsetX, offsetY, scaledWidth, scaledHeight);
        
        log.info("Mask drawn scaled to original image size:", { 
            originalSize: { width: originalWidth, height: originalHeight },
            targetSize: { width: targetWidth, height: targetHeight },
            canvasSize: { width: this.width, height: this.height },
            scaleToOriginal: scaleToOriginal,
            finalSize: { width: scaledWidth, height: scaledHeight },
            offset: { x: offsetX, y: offsetY }
        });

        // Pobierz dane obrazu i przetwórz je
        const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
        const data = imageData.data;

        // Konwertuj maskę do formatu editora (alpha channel jako maska)
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3]; // Oryginalny kanał alpha
            
            // Ustaw kolor maski
            data[i] = maskColor.r;     // R
            data[i + 1] = maskColor.g; // G
            data[i + 2] = maskColor.b; // B
            data[i + 3] = alpha;       // Zachowaj oryginalny alpha
        }

        // Zapisz przetworzone dane z powrotem
        tempCtx.putImageData(imageData, 0, 0);
        
        log.info("Mask processing completed - full size scaling applied");
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
        
        // Zamiast dodawać maskę (screen), zastąp całą maskę (source-over)
        // Najpierw wyczyść obszar który będzie zastąpiony
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.clearRect(destX, destY, this.width, this.height);
        
        // Teraz narysuj nową maskę
        maskCtx.drawImage(maskAsImage, destX, destY);
        
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

    // ==========================================
    // OBSŁUGA ANULOWANIA MASK EDITORA
    // ==========================================

    /**
     * Zapisuje obecny stan maski przed otwarciem editora
     * @returns {Object} Zapisany stan maski
     */
    async saveMaskState() {
        if (!this.maskTool || !this.maskTool.maskCanvas) {
            return null;
        }

        // Skopiuj dane z mask canvas
        const maskCanvas = this.maskTool.maskCanvas;
        const savedCanvas = document.createElement('canvas');
        savedCanvas.width = maskCanvas.width;
        savedCanvas.height = maskCanvas.height;
        const savedCtx = savedCanvas.getContext('2d');
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

        // Przywróć dane maski
        if (savedState.maskData) {
            const maskCtx = this.maskTool.maskCtx;
            maskCtx.clearRect(0, 0, this.maskTool.maskCanvas.width, this.maskTool.maskCanvas.height);
            maskCtx.drawImage(savedState.maskData, 0, 0);
        }

        // Przywróć pozycję maski
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
        console.log("Node object after mask editor close:", this.node);
        
        // Sprawdź czy editor został anulowany
        if (this.maskEditorCancelled) {
            log.info("Mask editor was cancelled - restoring original mask state");
            
            // Przywróć oryginalny stan maski
            if (this.savedMaskState) {
                await this.restoreMaskState(this.savedMaskState);
            }
            
            // Wyczyść flagi
            this.maskEditorCancelled = false;
            this.savedMaskState = null;
            
            // Nie przetwarzaj wyniku z editora
            return;
        }

        // Kontynuuj normalną obsługę save
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
        
        // Zamiast dodawać maskę (screen), zastąp całą maskę (source-over)
        // Najpierw wyczyść obszar który będzie zastąpiony
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.clearRect(destX, destY, this.width, this.height);
        
        // Teraz narysuj nową maskę
        maskCtx.drawImage(maskAsImage, destX, destY);
        
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
        
        // Wyczyść zapisany stan po pomyślnym save
        this.savedMaskState = null;
    }
}
