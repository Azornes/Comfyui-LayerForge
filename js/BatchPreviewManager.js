import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('BatchPreviewManager');
export class BatchPreviewManager {
    constructor(canvas, initialPosition = { x: 0, y: 0 }, generationArea = null) {
        this.canvas = canvas;
        this.active = false;
        this.layers = [];
        this.currentIndex = 0;
        this.element = null;
        this.counterElement = null;
        this.uiInitialized = false;
        this.maskWasVisible = false;
        this.worldX = initialPosition.x;
        this.worldY = initialPosition.y;
        this.isDragging = false;
        this.generationArea = generationArea;
    }
    updateScreenPosition(viewport) {
        if (!this.active || !this.element)
            return;
        const screenX = (this.worldX - viewport.x) * viewport.zoom;
        const screenY = (this.worldY - viewport.y) * viewport.zoom;
        const scale = 1;
        this.element.style.transform = `translate(${screenX}px, ${screenY}px) scale(${scale})`;
    }
    _createUI() {
        if (this.uiInitialized)
            return;
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
            if (e.target.tagName === 'BUTTON')
                return;
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = true;
            const handleMouseMove = (moveEvent) => {
                if (this.isDragging) {
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
        const cancelButton = this._createButton('&#10006;', 'Cancel All');
        const closeButton = this._createButton('&#10162;', 'Close');
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
        if (this.canvas.canvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.element);
        }
        else {
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
        // Auto-hide mask logic
        this.maskWasVisible = this.canvas.maskTool.isOverlayVisible;
        if (this.maskWasVisible) {
            this.canvas.maskTool.toggleOverlayVisibility();
            const toggleBtn = document.getElementById(`toggle-mask-btn-${this.canvas.node.id}`);
            if (toggleBtn) {
                toggleBtn.classList.remove('primary');
                const iconContainer = toggleBtn.querySelector('.mask-icon-container');
                if (iconContainer) {
                    iconContainer.style.opacity = '0.5';
                }
            }
            this.canvas.render();
        }
        log.info(`Showing batch preview for ${layers.length} layers.`);
        this.layers = layers;
        this.currentIndex = 0;
        if (this.element) {
            this.element.style.display = 'flex';
        }
        this.active = true;
        if (this.element) {
            const menuWidthInWorld = this.element.offsetWidth / this.canvas.viewport.zoom;
            const paddingInWorld = 20 / this.canvas.viewport.zoom;
            this.worldX -= menuWidthInWorld / 2;
            this.worldY += paddingInWorld;
        }
        // Hide all batch layers initially, then show only the first one
        this.layers.forEach((layer) => {
            layer.visible = false;
        });
        this._update();
    }
    hide() {
        log.info('Hiding batch preview.');
        if (this.element) {
            this.element.remove();
        }
        this.active = false;
        const index = this.canvas.batchPreviewManagers.indexOf(this);
        if (index > -1) {
            this.canvas.batchPreviewManagers.splice(index, 1);
        }
        this.canvas.render();
        if (this.maskWasVisible && !this.canvas.maskTool.isOverlayVisible) {
            this.canvas.maskTool.toggleOverlayVisibility();
            const toggleBtn = document.getElementById(`toggle-mask-btn-${String(this.canvas.node.id)}`);
            if (toggleBtn) {
                toggleBtn.classList.add('primary');
                const iconContainer = toggleBtn.querySelector('.mask-icon-container');
                if (iconContainer) {
                    iconContainer.style.opacity = '1';
                }
            }
        }
        this.maskWasVisible = false;
        // Only make visible the layers that were part of the batch preview
        this.layers.forEach((layer) => {
            layer.visible = true;
        });
        // Update the layers panel to reflect visibility changes
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }
        this.canvas.render();
    }
    navigate(direction) {
        this.currentIndex += direction;
        if (this.currentIndex < 0) {
            this.currentIndex = this.layers.length - 1;
        }
        else if (this.currentIndex >= this.layers.length) {
            this.currentIndex = 0;
        }
        this._update();
    }
    confirm() {
        const layerToKeep = this.layers[this.currentIndex];
        log.info(`Confirming selection: Keeping layer ${layerToKeep.id}.`);
        const layersToDelete = this.layers.filter((l) => l.id !== layerToKeep.id);
        const layerIdsToDelete = layersToDelete.map((l) => l.id);
        this.canvas.removeLayersByIds(layerIdsToDelete);
        log.info(`Deleted ${layersToDelete.length} other layers.`);
        this.hide();
    }
    cancelAndRemoveAll() {
        log.info('Cancel clicked. Removing all new layers.');
        const layerIdsToDelete = this.layers.map((l) => l.id);
        this.canvas.removeLayersByIds(layerIdsToDelete);
        log.info(`Deleted all ${layerIdsToDelete.length} new layers.`);
        this.hide();
    }
    _update() {
        if (this.counterElement) {
            this.counterElement.textContent = `${this.currentIndex + 1} / ${this.layers.length}`;
        }
        this._focusOnLayer(this.layers[this.currentIndex]);
    }
    _focusOnLayer(layer) {
        if (!layer)
            return;
        log.debug(`Focusing on layer ${layer.id} using visibility toggle`);
        // Hide all batch layers first
        this.layers.forEach((l) => {
            l.visible = false;
        });
        // Show only the current layer
        layer.visible = true;
        // Deselect only this layer if it is selected
        const selected = this.canvas.canvasSelection.selectedLayers;
        if (selected && selected.includes(layer)) {
            this.canvas.updateSelection(selected.filter((l) => l !== layer));
        }
        // Update the layers panel to reflect visibility changes
        if (this.canvas.canvasLayersPanel) {
            this.canvas.canvasLayersPanel.onLayersChanged();
        }
        this.canvas.render();
    }
}
