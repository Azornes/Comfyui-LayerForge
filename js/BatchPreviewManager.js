import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('BatchPreviewManager');

export class BatchPreviewManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.active = false;
        this.layers = [];
        this.currentIndex = 0;
        this.element = null;
        this.uiInitialized = false;
        this.maskWasVisible = false;

        // Position in canvas world coordinates
        this.worldX = 0;
        this.worldY = 0;
        this.isDragging = false;
    }

    updateScreenPosition(viewport) {
        if (!this.active || !this.element) return;

        // Translate world coordinates to screen coordinates
        const screenX = (this.worldX - viewport.x) * viewport.zoom;
        const screenY = (this.worldY - viewport.y) * viewport.zoom;
        
        // We can also scale the menu with zoom, but let's keep it constant for now for readability
        const scale = 1; // viewport.zoom; 

        // Use transform for performance
        this.element.style.transform = `translate(${screenX}px, ${screenY}px) scale(${scale})`;
    }

    _createUI() {
        if (this.uiInitialized) return;
        
        this.element = document.createElement('div');
        this.element.id = 'layerforge-batch-preview';
        this.element.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            background-color: #333;
            color: white;
            padding: 8px 15px;
            border-radius: 10px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            display: none;
            align-items: center;
            gap: 15px;
            font-family: sans-serif;
            z-index: 1001;
            border: 1px solid #555;
            cursor: move;
            user-select: none;
        `;

        this.element.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;

            e.preventDefault();
            e.stopPropagation();

            this.isDragging = true;
            
            const handleMouseMove = (moveEvent) => {
                if (this.isDragging) {
                    // Convert screen pixel movement to world coordinate movement
                    const deltaX = moveEvent.movementX / this.canvas.viewport.zoom;
                    const deltaY = moveEvent.movementY / this.canvas.viewport.zoom;

                    this.worldX += deltaX;
                    this.worldY += deltaY;
                    
                    // The render loop will handle updating the screen position, but we need to trigger it.
                    this.canvas.render();
                }
            };

            const handleMouseUp = () => {
                this.isDragging = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        const prevButton = this._createButton('&#9664;', 'Previous'); // Left arrow
        const nextButton = this._createButton('&#9654;', 'Next'); // Right arrow
        const confirmButton = this._createButton('&#10004;', 'Confirm'); // Checkmark
        const cancelButton = this._createButton('&#10006;', 'Cancel All'); // X mark
        const closeButton = this._createButton('&#10162;', 'Close'); // Door icon

        this.counterElement = document.createElement('span');
        this.counterElement.style.minWidth = '40px';
        this.counterElement.style.textAlign = 'center';
        this.counterElement.style.fontWeight = 'bold';

        prevButton.onclick = () => this.navigate(-1);
        nextButton.onclick = () => this.navigate(1);
        confirmButton.onclick = () => this.confirm();
        cancelButton.onclick = () => this.cancelAndRemoveAll();
        closeButton.onclick = () => this.hide();

        this.element.append(prevButton, this.counterElement, nextButton, confirmButton, cancelButton, closeButton);
        if (this.canvas.canvas.parentNode) {
            this.canvas.canvas.parentNode.appendChild(this.element);
        } else {
            log.error("Could not find parent node to attach batch preview UI.");
        }
        this.uiInitialized = true;
    }

    _createButton(innerHTML, title) {
        const button = document.createElement('button');
        button.innerHTML = innerHTML;
        button.title = title;
        button.style.cssText = `
            background: #555;
            color: white;
            border: 1px solid #777;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        button.onmouseover = () => button.style.background = '#666';
        button.onmouseout = () => button.style.background = '#555';
        return button;
    }

    show(layers) {
        if (!layers || layers.length <= 1) {
            return;
        }

        this._createUI();

        // Set initial position to be centered horizontally and just below the output area
        const menuWidthInWorld = this.element.offsetWidth / this.canvas.viewport.zoom;
        const paddingInWorld = 20 / this.canvas.viewport.zoom; // 20px padding in screen space

        this.worldX = (this.canvas.width / 2) - (menuWidthInWorld / 2);
        this.worldY = this.canvas.height + paddingInWorld;

        // Auto-hide mask logic
        this.maskWasVisible = this.canvas.maskTool.isOverlayVisible;
        if (this.maskWasVisible) {
            this.canvas.maskTool.toggleOverlayVisibility();
            const toggleBtn = document.getElementById(`toggle-mask-btn-${this.canvas.node.id}`);
            if (toggleBtn) {
                toggleBtn.classList.remove('primary');
                toggleBtn.textContent = "Hide Mask";
            }
            this.canvas.render();
        }

        log.info(`Showing batch preview for ${layers.length} layers.`);
        this.layers = layers;
        this.currentIndex = 0;
        this.element.style.display = 'flex';
        this.active = true;
        this._update();
    }

    hide() {
        log.info('Hiding batch preview.');
        this.element.style.display = 'none';
        this.active = false;
        this.layers = [];
        this.currentIndex = 0;

        // Restore mask visibility if it was hidden by this manager
        if (this.maskWasVisible && !this.canvas.maskTool.isOverlayVisible) {
            this.canvas.maskTool.toggleOverlayVisibility();
            const toggleBtn = document.getElementById(`toggle-mask-btn-${this.canvas.node.id}`);
            if (toggleBtn) {
                toggleBtn.classList.add('primary');
                toggleBtn.textContent = "Show Mask";
            }
        }
        this.maskWasVisible = false; // Reset state

        // Make all layers visible again upon closing
        this.canvas.layers.forEach(l => l.visible = true);
        this.canvas.render();
    }

    navigate(direction) {
        this.currentIndex += direction;
        if (this.currentIndex < 0) {
            this.currentIndex = this.layers.length - 1;
        } else if (this.currentIndex >= this.layers.length) {
            this.currentIndex = 0;
        }
        this._update();
    }

    confirm() {
        const layerToKeep = this.layers[this.currentIndex];
        log.info(`Confirming selection: Keeping layer ${layerToKeep.id}.`);

        const layersToDelete = this.layers.filter(l => l.id !== layerToKeep.id);
        const layerIdsToDelete = layersToDelete.map(l => l.id);

        this.canvas.removeLayersByIds(layerIdsToDelete);
        log.info(`Deleted ${layersToDelete.length} other layers.`);

        this.hide();
    }

    cancelAndRemoveAll() {
        log.info('Cancel clicked. Removing all new layers.');

        const layerIdsToDelete = this.layers.map(l => l.id);
        this.canvas.removeLayersByIds(layerIdsToDelete);
        log.info(`Deleted all ${layerIdsToDelete.length} new layers.`);

        this.hide();
    }

    _update() {
        this.counterElement.textContent = `${this.currentIndex + 1} / ${this.layers.length}`;
        this._focusOnLayer(this.layers[this.currentIndex]);
    }

    _focusOnLayer(layer) {
        if (!layer) return;
        log.debug(`Focusing on layer ${layer.id}`);

        // Move the selected layer to the top of the layer stack
        this.canvas.canvasLayers.moveLayers([layer], { toIndex: 0 });
        
        this.canvas.updateSelection([layer]);
        
        // Render is called by moveLayers, but we call it again to be safe
        this.canvas.render();
    }
}
