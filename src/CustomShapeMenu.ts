import {createModuleLogger} from "./utils/LoggerUtils.js";
import type { Canvas } from './Canvas';

const log = createModuleLogger('CustomShapeMenu');

export class CustomShapeMenu {
    private canvas: Canvas;
    private element: HTMLDivElement | null;
    private worldX: number;
    private worldY: number;
    private uiInitialized: boolean;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this.element = null;
        this.worldX = 0;
        this.worldY = 0;
        this.uiInitialized = false;
    }

    show(): void {
        if (!this.canvas.outputAreaShape) {
            return;
        }

        this._createUI();
        
        if (this.element) {
            this.element.style.display = 'block';
        }

        // Position in top-left corner of viewport (closer to edge)
        const viewLeft = this.canvas.viewport.x;
        const viewTop = this.canvas.viewport.y;
        this.worldX = viewLeft + (8 / this.canvas.viewport.zoom);
        this.worldY = viewTop + (8 / this.canvas.viewport.zoom);

        this.updateScreenPosition();
    }

    hide(): void {
        if (this.element) {
            this.element.remove();
            this.element = null;
            this.uiInitialized = false;
        }
    }

    updateScreenPosition(): void {
        if (!this.element) return;

        const screenX = (this.worldX - this.canvas.viewport.x) * this.canvas.viewport.zoom;
        const screenY = (this.worldY - this.canvas.viewport.y) * this.canvas.viewport.zoom;

        this.element.style.transform = `translate(${screenX}px, ${screenY}px)`;
    }

    private _createUI(): void {
        if (this.uiInitialized) return;
        
        this.element = document.createElement('div');
        this.element.id = 'layerforge-custom-shape-menu';
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
            flex-direction: column;
            gap: 4px;
            font-family: sans-serif;
            font-size: 12px;
            z-index: 1001;
            border: 1px solid #555;
            user-select: none;
            min-width: 200px;
        `;

        // Create menu content
        const lines = [
            "🎯 Custom Output Area Active",
            "Press Shift+S to modify shape",
            "Shape defines generation area"
        ];

        lines.forEach(line => {
            const lineElement = document.createElement('div');
            lineElement.textContent = line;
            lineElement.style.cssText = `
                margin: 2px 0;
                line-height: 18px;
            `;
            this.element!.appendChild(lineElement);
        });

        // Add main auto-apply checkbox
        const checkboxContainer = this._createCheckbox(
            () => `${this.canvas.autoApplyShapeMask ? "☑" : "☐"} Auto-apply shape mask`,
            () => {
                this.canvas.autoApplyShapeMask = !this.canvas.autoApplyShapeMask;
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    log.info("Auto-apply shape mask enabled - mask applied automatically");
                } else {
                    this.canvas.maskTool.removeShapeMask();
                    log.info("Auto-apply shape mask disabled - mask removed automatically");
                }
                
                this._updateUI();
                this.canvas.render();
            }
        );
        this.element.appendChild(checkboxContainer);

        // Add expansion checkbox (only visible when auto-apply is enabled)
        const expansionContainer = this._createCheckbox(
            () => `${this.canvas.shapeMaskExpansion ? "☑" : "☐"} Expand/Contract mask`,
            () => {
                this.canvas.shapeMaskExpansion = !this.canvas.shapeMaskExpansion;
                this._updateUI();
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            }
        );
        expansionContainer.id = 'expansion-checkbox';
        this.element.appendChild(expansionContainer);

        // Add expansion slider container (only visible when expansion is enabled)
        const expansionSliderContainer = document.createElement('div');
        expansionSliderContainer.id = 'expansion-slider-container';
        expansionSliderContainer.style.cssText = `
            margin: 6px 0;
            padding: 4px 8px;
            display: none;
        `;

        const expansionSliderLabel = document.createElement('div');
        expansionSliderLabel.textContent = 'Expansion amount:';
        expansionSliderLabel.style.cssText = `
            font-size: 11px;
            margin-bottom: 4px;
            color: #ccc;
        `;

        const expansionSlider = document.createElement('input');
        expansionSlider.type = 'range';
        expansionSlider.min = '-300';
        expansionSlider.max = '300';
        expansionSlider.value = '0';
        expansionSlider.style.cssText = `
            width: 100%;
            height: 4px;
            background: #555;
            outline: none;
            border-radius: 2px;
        `;

        const expansionValueDisplay = document.createElement('div');
        expansionValueDisplay.style.cssText = `
            font-size: 10px;
            text-align: center;
            margin-top: 2px;
            color: #aaa;
        `;

        const updateExpansionSliderDisplay = () => {
            const value = parseInt(expansionSlider.value);
            this.canvas.shapeMaskExpansionValue = value;
            expansionValueDisplay.textContent = value > 0 ? `+${value}px` : `${value}px`;
        };

        // Add preview system for expansion slider
        let expansionTimeout: number | null = null;
        let isExpansionDragging = false;
        
        expansionSlider.onmousedown = () => {
            isExpansionDragging = true;
        };
        
        expansionSlider.oninput = () => {
            updateExpansionSliderDisplay();
            
            if (this.canvas.autoApplyShapeMask) {
                // Clear previous timeout
                if (expansionTimeout) {
                    clearTimeout(expansionTimeout);
                }
                
                if (isExpansionDragging) {
                    // Show blue preview line while dragging - NO mask application
                    const featherValue = this.canvas.shapeMaskFeather ? this.canvas.shapeMaskFeatherValue : 0;
                    this.canvas.maskTool.showShapePreview(this.canvas.shapeMaskExpansionValue, featherValue);
                } else {
                    // Apply mask immediately for programmatic changes (not user dragging)
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask(false);
                    this.canvas.render();
                }
                
                // Clear any pending timeout - we only apply mask on mouseup now
                if (expansionTimeout) {
                    clearTimeout(expansionTimeout);
                    expansionTimeout = null;
                }
            }
        };
        
        expansionSlider.onmouseup = () => {
            isExpansionDragging = false;
            if (this.canvas.autoApplyShapeMask) {
                // Apply final mask immediately when user releases slider
                this.canvas.maskTool.hideShapePreview();
                this.canvas.maskTool.applyShapeMask(true);
                this.canvas.render();
            }
        };

        updateExpansionSliderDisplay();

        expansionSliderContainer.appendChild(expansionSliderLabel);
        expansionSliderContainer.appendChild(expansionSlider);
        expansionSliderContainer.appendChild(expansionValueDisplay);
        this.element.appendChild(expansionSliderContainer);

        // Add feather checkbox (only visible when auto-apply is enabled)
        const featherContainer = this._createCheckbox(
            () => `${this.canvas.shapeMaskFeather ? "☑" : "☐"} Feather edges`,
            () => {
                this.canvas.shapeMaskFeather = !this.canvas.shapeMaskFeather;
                this._updateUI();
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            }
        );
        featherContainer.id = 'feather-checkbox';
        this.element.appendChild(featherContainer);

        // Add feather slider container (only visible when feather is enabled)
        const featherSliderContainer = document.createElement('div');
        featherSliderContainer.id = 'feather-slider-container';
        featherSliderContainer.style.cssText = `
            margin: 6px 0;
            padding: 4px 8px;
            display: none;
        `;

        const featherSliderLabel = document.createElement('div');
        featherSliderLabel.textContent = 'Feather amount:';
        featherSliderLabel.style.cssText = `
            font-size: 11px;
            margin-bottom: 4px;
            color: #ccc;
        `;

        const featherSlider = document.createElement('input');
        featherSlider.type = 'range';
        featherSlider.min = '0';
        featherSlider.max = '300';
        featherSlider.value = '0';
        featherSlider.style.cssText = `
            width: 100%;
            height: 4px;
            background: #555;
            outline: none;
            border-radius: 2px;
        `;

        const featherValueDisplay = document.createElement('div');
        featherValueDisplay.style.cssText = `
            font-size: 10px;
            text-align: center;
            margin-top: 2px;
            color: #aaa;
        `;

        const updateFeatherSliderDisplay = () => {
            const value = parseInt(featherSlider.value);
            this.canvas.shapeMaskFeatherValue = value;
            featherValueDisplay.textContent = `${value}px`;
        };

        // Add preview system for feather slider (mirrors expansion slider)
        let featherTimeout: number | null = null;
        let isFeatherDragging = false;
        
        featherSlider.onmousedown = () => {
            isFeatherDragging = true;
        };
        
        featherSlider.oninput = () => {
            updateFeatherSliderDisplay();
            
            if (this.canvas.autoApplyShapeMask) {
                if (isFeatherDragging) {
                    // Show blue preview line while dragging
                    const expansionValue = this.canvas.shapeMaskExpansion ? this.canvas.shapeMaskExpansionValue : 0;
                    this.canvas.maskTool.showShapePreview(expansionValue, this.canvas.shapeMaskFeatherValue);
                } else {
                    // Apply immediately for programmatic changes
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask(false);
                    this.canvas.render();
                }
            }
        };
        
        featherSlider.onmouseup = () => {
            isFeatherDragging = false;
            if (this.canvas.autoApplyShapeMask) {
                // Apply final mask when user releases slider
                this.canvas.maskTool.hideShapePreview();
                this.canvas.maskTool.applyShapeMask(true); // true = save state
                this.canvas.render();
            }
        };

        updateFeatherSliderDisplay();

        featherSliderContainer.appendChild(featherSliderLabel);
        featherSliderContainer.appendChild(featherSlider);
        featherSliderContainer.appendChild(featherValueDisplay);
        this.element.appendChild(featherSliderContainer);

        // Add to DOM
        if (this.canvas.canvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.element);
        } else {
            log.error("Could not find parent node to attach custom shape menu.");
        }
        
        this.uiInitialized = true;
        this._updateUI();
        
        // Add viewport change listener to update shape preview when zooming/panning
        this._addViewportChangeListener();
    }

    private _createCheckbox(textFn: () => string, clickHandler: () => void): HTMLDivElement {
        const container = document.createElement('div');
        container.style.cssText = `
            margin: 6px 0 2px 0;
            padding: 4px 8px;
            border-radius: 5px;
            cursor: pointer;
            transition: background-color 0.2s;
            line-height: 18px;
        `;

        container.onmouseover = () => {
            container.style.backgroundColor = '#555';
        };
        
        container.onmouseout = () => {
            container.style.backgroundColor = 'transparent';
        };

        const updateText = () => {
            container.textContent = textFn();
        };

        updateText();
        container.onclick = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            clickHandler();
            updateText();
        };

        return container;
    }

    private _updateUI(): void {
        if (!this.element) return;

        // Update expansion checkbox visibility
        const expansionCheckbox = this.element.querySelector('#expansion-checkbox') as HTMLElement;
        if (expansionCheckbox) {
            expansionCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'block' : 'none';
        }

        // Update expansion slider container visibility
        const expansionSliderContainer = this.element.querySelector('#expansion-slider-container') as HTMLElement;
        if (expansionSliderContainer) {
            expansionSliderContainer.style.display = 
                (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskExpansion) ? 'block' : 'none';
        }

        // Update feather checkbox visibility
        const featherCheckbox = this.element.querySelector('#feather-checkbox') as HTMLElement;
        if (featherCheckbox) {
            featherCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'block' : 'none';
        }

        // Update feather slider container visibility
        const featherSliderContainer = this.element.querySelector('#feather-slider-container') as HTMLElement;
        if (featherSliderContainer) {
            featherSliderContainer.style.display = 
                (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskFeather) ? 'block' : 'none';
        }

        // Update checkbox texts
        const checkboxes = this.element.querySelectorAll('div[style*="cursor: pointer"]');
        checkboxes.forEach((checkbox, index) => {
            if (index === 0) { // Main checkbox
                checkbox.textContent = `${this.canvas.autoApplyShapeMask ? "☑" : "☐"} Auto-apply shape mask`;
            } else if (index === 1) { // Expansion checkbox
                checkbox.textContent = `${this.canvas.shapeMaskExpansion ? "☑" : "☐"} Expand/Contract mask`;
            } else if (index === 2) { // Feather checkbox
                checkbox.textContent = `${this.canvas.shapeMaskFeather ? "☑" : "☐"} Feather edges`;
            }
        });
    }

    /**
     * Add viewport change listener to update shape preview when zooming/panning
     */
    private _addViewportChangeListener(): void {
        // Store previous viewport state to detect changes
        let previousViewport = {
            x: this.canvas.viewport.x,
            y: this.canvas.viewport.y,
            zoom: this.canvas.viewport.zoom
        };

        // Check for viewport changes in render loop
        const checkViewportChange = () => {
            if (this.canvas.maskTool.shapePreviewVisible) {
                const current = this.canvas.viewport;
                
                // Check if viewport has changed
                if (current.x !== previousViewport.x || 
                    current.y !== previousViewport.y || 
                    current.zoom !== previousViewport.zoom) {
                    
                    // Update shape preview with current expansion/feather values
                    const expansionValue = this.canvas.shapeMaskExpansionValue || 0;
                    const featherValue = this.canvas.shapeMaskFeather ? (this.canvas.shapeMaskFeatherValue || 0) : 0;
                    this.canvas.maskTool.showShapePreview(expansionValue, featherValue);
                    
                    // Update previous viewport state
                    previousViewport = {
                        x: current.x,
                        y: current.y,
                        zoom: current.zoom
                    };
                }
            }
            
            // Continue checking if UI is still active
            if (this.uiInitialized) {
                requestAnimationFrame(checkViewportChange);
            }
        };

        // Start the viewport change detection
        requestAnimationFrame(checkViewportChange);
    }
}
