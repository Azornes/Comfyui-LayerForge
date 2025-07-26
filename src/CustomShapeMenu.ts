import {createModuleLogger} from "./utils/LoggerUtils.js";
import type { Canvas } from './Canvas';

const log = createModuleLogger('CustomShapeMenu');

export class CustomShapeMenu {
    private canvas: Canvas;
    private element: HTMLDivElement | null;
    private worldX: number;
    private worldY: number;
    private uiInitialized: boolean;
    private tooltip: HTMLDivElement | null;

    constructor(canvas: Canvas) {
        this.canvas = canvas;
        this.element = null;
        this.worldX = 0;
        this.worldY = 0;
        this.uiInitialized = false;
        this.tooltip = null;
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
        this.hideTooltip();
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
            "🎯 Custom Output Area Active"
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

        // Create a container for the entire shape mask feature set
        const featureContainer = document.createElement('div');
        featureContainer.id = 'shape-mask-feature-container';
        featureContainer.style.cssText = `
            background-color: #282828;
            border-radius: 6px;
            margin-top: 6px;
            padding: 4px 0;
            border: 1px solid #444;
        `;

        // Add main auto-apply checkbox to the new container
        const checkboxContainer = this._createCheckbox(
            () => `${this.canvas.autoApplyShapeMask ? "☑" : "☐"} Auto-apply shape mask`,
            () => {
                this.canvas.autoApplyShapeMask = !this.canvas.autoApplyShapeMask;
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    log.info("Auto-apply shape mask enabled - mask applied automatically");
                } else {
                    this.canvas.maskTool.removeShapeMask();
                    this.canvas.shapeMaskExpansion = false;
                    this.canvas.shapeMaskFeather = false;
                    log.info("Auto-apply shape mask disabled - mask area removed and sub-options reset.");
                }
                
                this._updateUI();
                this.canvas.render();
            },
            "Automatically applies a mask based on the custom output area shape. When enabled, the mask will be applied to all layers within the shape boundary."
        );
        featureContainer.appendChild(checkboxContainer);
        
        // Add expansion checkbox
        const expansionContainer = this._createCheckbox(
            () => `${this.canvas.shapeMaskExpansion ? "☑" : "☐"} Expand/Contract mask`,
            () => {
                this.canvas.shapeMaskExpansion = !this.canvas.shapeMaskExpansion;
                this._updateUI();
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            },
            "Dilate (expand) or erode (contract) the shape mask. Positive values expand the mask outward, negative values shrink it inward."
        );
        expansionContainer.id = 'expansion-checkbox';
        featureContainer.appendChild(expansionContainer);

        // Add expansion slider container
        const expansionSliderContainer = document.createElement('div');
        expansionSliderContainer.id = 'expansion-slider-container';
        expansionSliderContainer.style.cssText = `
            margin: 0 8px 6px 8px;
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
        expansionSlider.value = String(this.canvas.shapeMaskExpansionValue);
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

        let isExpansionDragging = false;
        
        expansionSlider.onmousedown = () => { isExpansionDragging = true; };
        
        expansionSlider.oninput = () => {
            updateExpansionSliderDisplay();
            if (this.canvas.autoApplyShapeMask) {
                if (isExpansionDragging) {
                    const featherValue = this.canvas.shapeMaskFeather ? this.canvas.shapeMaskFeatherValue : 0;
                    this.canvas.maskTool.showShapePreview(this.canvas.shapeMaskExpansionValue, featherValue);
                } else {
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask(false);
                    this.canvas.render();
                }
            }
        };
        
        expansionSlider.onmouseup = () => {
            isExpansionDragging = false;
            if (this.canvas.autoApplyShapeMask) {
                this.canvas.maskTool.hideShapePreview();
                this.canvas.maskTool.applyShapeMask(true);
                this.canvas.render();
            }
        };

        updateExpansionSliderDisplay();

        expansionSliderContainer.appendChild(expansionSliderLabel);
        expansionSliderContainer.appendChild(expansionSlider);
        expansionSliderContainer.appendChild(expansionValueDisplay);
        featureContainer.appendChild(expansionSliderContainer);

        // Add feather checkbox
        const featherContainer = this._createCheckbox(
            () => `${this.canvas.shapeMaskFeather ? "☑" : "☐"} Feather edges`,
            () => {
                this.canvas.shapeMaskFeather = !this.canvas.shapeMaskFeather;
                this._updateUI();
                
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            },
            "Softens the edges of the shape mask by creating a gradual transition from opaque to transparent."
        );
        featherContainer.id = 'feather-checkbox';
        featureContainer.appendChild(featherContainer);

        // Add feather slider container
        const featherSliderContainer = document.createElement('div');
        featherSliderContainer.id = 'feather-slider-container';
        featherSliderContainer.style.cssText = `
            margin: 0 8px 6px 8px;
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
        featherSlider.value = String(this.canvas.shapeMaskFeatherValue);
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
        
        let isFeatherDragging = false;
        
        featherSlider.onmousedown = () => { isFeatherDragging = true; };
        
        featherSlider.oninput = () => {
            updateFeatherSliderDisplay();
            if (this.canvas.autoApplyShapeMask) {
                if (isFeatherDragging) {
                    const expansionValue = this.canvas.shapeMaskExpansion ? this.canvas.shapeMaskExpansionValue : 0;
                    this.canvas.maskTool.showShapePreview(expansionValue, this.canvas.shapeMaskFeatherValue);
                } else {
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask(false);
                    this.canvas.render();
                }
            }
        };
        
        featherSlider.onmouseup = () => {
            isFeatherDragging = false;
            if (this.canvas.autoApplyShapeMask) {
                this.canvas.maskTool.hideShapePreview();
                this.canvas.maskTool.applyShapeMask(true); // true = save state
                this.canvas.render();
            }
        };

        updateFeatherSliderDisplay();

        featherSliderContainer.appendChild(featherSliderLabel);
        featherSliderContainer.appendChild(featherSlider);
        featherSliderContainer.appendChild(featherValueDisplay);
        featureContainer.appendChild(featherSliderContainer);

        this.element.appendChild(featureContainer);

        // Create output area extension container
        const extensionContainer = document.createElement('div');
        extensionContainer.id = 'output-area-extension-container';
        extensionContainer.style.cssText = `
            background-color: #282828;
            border-radius: 6px;
            margin-top: 6px;
            padding: 4px 0;
            border: 1px solid #444;
        `;

        // Add main extension checkbox
        const extensionCheckboxContainer = this._createCheckbox(
            () => `${this.canvas.outputAreaExtensionEnabled ? "☑" : "☐"} Extend output area`,
            () => {
                this.canvas.outputAreaExtensionEnabled = !this.canvas.outputAreaExtensionEnabled;
                
                if (this.canvas.outputAreaExtensionEnabled) {
                    // When enabling, capture current canvas size as the baseline
                    this.canvas.originalCanvasSize = { 
                        width: this.canvas.width, 
                        height: this.canvas.height 
                    };
                    // Restore last saved extensions instead of starting from zero
                    this.canvas.outputAreaExtensions = { ...this.canvas.lastOutputAreaExtensions };
                    log.info(`Captured current canvas size as baseline: ${this.canvas.width}x${this.canvas.height}`);
                    log.info(`Restored last extensions:`, this.canvas.outputAreaExtensions);
                } else {
                    // Save current extensions before disabling
                    this.canvas.lastOutputAreaExtensions = { ...this.canvas.outputAreaExtensions };
                    // Reset current extensions when disabled (but keep the saved ones)
                    this.canvas.outputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
                    log.info(`Saved extensions for later:`, this.canvas.lastOutputAreaExtensions);
                }
                
                this._updateExtensionUI();
                this._updateCanvasSize(); // Update canvas size when toggling
                this.canvas.render();
                log.info(`Output area extension ${this.canvas.outputAreaExtensionEnabled ? 'enabled' : 'disabled'}`);
            },
            "Allows extending the output area boundaries in all directions without changing the custom shape."
        );
        extensionContainer.appendChild(extensionCheckboxContainer);

        // Create sliders container
        const slidersContainer = document.createElement('div');
        slidersContainer.id = 'extension-sliders-container';
        slidersContainer.style.cssText = `
            margin: 0 8px 6px 8px;
            padding: 4px 8px;
            display: none;
        `;

        // Helper function to create a slider with preview system
        const createExtensionSlider = (label: string, direction: 'top' | 'bottom' | 'left' | 'right') => {
            const sliderContainer = document.createElement('div');
            sliderContainer.style.cssText = `
                margin: 6px 0;
            `;

            const sliderLabel = document.createElement('div');
            sliderLabel.textContent = label;
            sliderLabel.style.cssText = `
                font-size: 11px;
                margin-bottom: 4px;
                color: #ccc;
            `;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '500';
            slider.value = String(this.canvas.outputAreaExtensions[direction]);
            slider.style.cssText = `
                width: 100%;
                height: 4px;
                background: #555;
                outline: none;
                border-radius: 2px;
            `;

            const valueDisplay = document.createElement('div');
            valueDisplay.style.cssText = `
                font-size: 10px;
                text-align: center;
                margin-top: 2px;
                color: #aaa;
            `;

            const updateDisplay = () => {
                const value = parseInt(slider.value);
                valueDisplay.textContent = `${value}px`;
            };

            let isDragging = false;

            slider.onmousedown = () => {
                isDragging = true;
            };

            slider.oninput = () => {
                updateDisplay();
                
                if (isDragging) {
                    // During dragging, show preview
                    const previewExtensions = { ...this.canvas.outputAreaExtensions };
                    previewExtensions[direction] = parseInt(slider.value);
                    this.canvas.outputAreaExtensionPreview = previewExtensions;
                    this.canvas.render();
                } else {
                    // Not dragging, apply immediately (for keyboard navigation)
                    this.canvas.outputAreaExtensions[direction] = parseInt(slider.value);
                    this._updateCanvasSize();
                    this.canvas.render();
                }
            };

            slider.onmouseup = () => {
                if (isDragging) {
                    isDragging = false;
                    // Apply the final value and clear preview
                    this.canvas.outputAreaExtensions[direction] = parseInt(slider.value);
                    this.canvas.outputAreaExtensionPreview = null;
                    this._updateCanvasSize();
                    this.canvas.render();
                }
            };

            // Handle mouse leave (in case user drags outside)
            slider.onmouseleave = () => {
                if (isDragging) {
                    isDragging = false;
                    // Apply the final value and clear preview
                    this.canvas.outputAreaExtensions[direction] = parseInt(slider.value);
                    this.canvas.outputAreaExtensionPreview = null;
                    this._updateCanvasSize();
                    this.canvas.render();
                }
            };

            updateDisplay();

            sliderContainer.appendChild(sliderLabel);
            sliderContainer.appendChild(slider);
            sliderContainer.appendChild(valueDisplay);
            return sliderContainer;
        };

        // Add all four sliders
        slidersContainer.appendChild(createExtensionSlider('Top extension:', 'top'));
        slidersContainer.appendChild(createExtensionSlider('Bottom extension:', 'bottom'));
        slidersContainer.appendChild(createExtensionSlider('Left extension:', 'left'));
        slidersContainer.appendChild(createExtensionSlider('Right extension:', 'right'));

        extensionContainer.appendChild(slidersContainer);
        this.element.appendChild(extensionContainer);
        
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

    private _createCheckbox(textFn: () => string, clickHandler: () => void, tooltipText?: string): HTMLDivElement {
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

        // Add tooltip if provided
        if (tooltipText) {
            this._addTooltip(container, tooltipText);
        }

        return container;
    }

    private _updateUI(): void {
        if (!this.element) return;

        // Toggle visibility of sub-options based on the main checkbox state
        const expansionCheckbox = this.element.querySelector('#expansion-checkbox') as HTMLElement;
        if (expansionCheckbox) {
            expansionCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'block' : 'none';
        }
        
        const featherCheckbox = this.element.querySelector('#feather-checkbox') as HTMLElement;
        if (featherCheckbox) {
            featherCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'block' : 'none';
        }

        // Update sliders visibility based on their respective checkboxes
        const expansionSliderContainer = this.element.querySelector('#expansion-slider-container') as HTMLElement;
        if (expansionSliderContainer) {
            expansionSliderContainer.style.display = (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskExpansion) ? 'block' : 'none';
        }

        const featherSliderContainer = this.element.querySelector('#feather-slider-container') as HTMLElement;
        if (featherSliderContainer) {
            featherSliderContainer.style.display = (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskFeather) ? 'block' : 'none';
        }

        // Update checkbox texts
        const checkboxes = this.element.querySelectorAll('div[style*="cursor: pointer"]');
        checkboxes.forEach((checkbox, index) => {
            if (index === 0) { // Main checkbox
                checkbox.textContent = `${this.canvas.autoApplyShapeMask ? "☑" : "☐"} Auto-apply shape mask`;
            } else if (index === 1) { // Expansion checkbox
                checkbox.textContent = `${this.canvas.shapeMaskExpansion ? "☑" : "☐"} Dilate/Erode mask`;
            } else if (index === 2) { // Feather checkbox
                checkbox.textContent = `${this.canvas.shapeMaskFeather ? "☑" : "☐"} Feather edges`;
            } else if (index === 3) { // Extension checkbox
                checkbox.textContent = `${this.canvas.outputAreaExtensionEnabled ? "☑" : "☐"} Extend output area`;
            }
        });
    }

    private _updateExtensionUI(): void {
        if (!this.element) return;

        // Toggle visibility of extension sliders based on the extension checkbox state
        const extensionSlidersContainer = this.element.querySelector('#extension-sliders-container') as HTMLElement;
        if (extensionSlidersContainer) {
            extensionSlidersContainer.style.display = this.canvas.outputAreaExtensionEnabled ? 'block' : 'none';
        }

        // Update slider values if they exist
        if (this.canvas.outputAreaExtensionEnabled) {
            const sliders = extensionSlidersContainer?.querySelectorAll('input[type="range"]');
            const directions: ('top' | 'bottom' | 'left' | 'right')[] = ['top', 'bottom', 'left', 'right'];
            
            sliders?.forEach((slider, index) => {
                const direction = directions[index];
                if (direction) {
                    (slider as HTMLInputElement).value = String(this.canvas.outputAreaExtensions[direction]);
                    // Update the corresponding value display
                    const valueDisplay = slider.parentElement?.querySelector('div:last-child');
                    if (valueDisplay) {
                        valueDisplay.textContent = `${this.canvas.outputAreaExtensions[direction]}px`;
                    }
                }
            });
        }
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

    private _addTooltip(element: HTMLElement, text: string): void {
        element.addEventListener('mouseenter', (e) => {
            this.showTooltip(text, e);
        });

        element.addEventListener('mouseleave', () => {
            this.hideTooltip();
        });

        element.addEventListener('mousemove', (e) => {
            if (this.tooltip && this.tooltip.style.display === 'block') {
                this.updateTooltipPosition(e);
            }
        });
    }

    private showTooltip(text: string, event: MouseEvent): void {
        this.hideTooltip(); // Hide any existing tooltip

        this.tooltip = document.createElement('div');
        this.tooltip.textContent = text;
        this.tooltip.style.cssText = `
            position: fixed;
            background-color: #1a1a1a;
            color: #ffffff;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-family: sans-serif;
            line-height: 1.4;
            max-width: 250px;
            word-wrap: break-word;
            box-shadow: 0 4px 12px rgba(0,0,0,0.6);
            border: 1px solid #444;
            z-index: 10000;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s ease-in-out;
        `;

        document.body.appendChild(this.tooltip);
        this.updateTooltipPosition(event);

        // Fade in the tooltip
        requestAnimationFrame(() => {
            if (this.tooltip) {
                this.tooltip.style.opacity = '1';
            }
        });
    }

    private updateTooltipPosition(event: MouseEvent): void {
        if (!this.tooltip) return;

        const tooltipRect = this.tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let x = event.clientX + 10;
        let y = event.clientY - 10;

        // Adjust if tooltip would go off the right edge
        if (x + tooltipRect.width > viewportWidth) {
            x = event.clientX - tooltipRect.width - 10;
        }

        // Adjust if tooltip would go off the bottom edge
        if (y + tooltipRect.height > viewportHeight) {
            y = event.clientY - tooltipRect.height - 10;
        }

        // Ensure tooltip doesn't go off the left or top edges
        x = Math.max(5, x);
        y = Math.max(5, y);

        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y}px`;
    }

    private hideTooltip(): void {
        if (this.tooltip) {
            this.tooltip.remove();
            this.tooltip = null;
        }
    }

    public _updateCanvasSize(): void {
        if (!this.canvas.outputAreaExtensionEnabled) {
            // When extensions are disabled, return to original custom shape position
            // Use originalOutputAreaPosition instead of current bounds position
            const originalPos = this.canvas.originalOutputAreaPosition;
            this.canvas.outputAreaBounds = { 
                x: originalPos.x,  // ✅ Return to original custom shape position
                y: originalPos.y,  // ✅ Return to original custom shape position
                width: this.canvas.originalCanvasSize.width, 
                height: this.canvas.originalCanvasSize.height 
            };
            this.canvas.updateOutputAreaSize(
                this.canvas.originalCanvasSize.width, 
                this.canvas.originalCanvasSize.height, 
                false
            );
            return;
        }

        const ext = this.canvas.outputAreaExtensions;
        const newWidth = this.canvas.originalCanvasSize.width + ext.left + ext.right;
        const newHeight = this.canvas.originalCanvasSize.height + ext.top + ext.bottom;

        // When extensions are enabled, calculate new bounds relative to original custom shape position
        const originalPos = this.canvas.originalOutputAreaPosition;
        this.canvas.outputAreaBounds = {
            x: originalPos.x - ext.left,  // Adjust position by left extension from original position
            y: originalPos.y - ext.top,   // Adjust position by top extension from original position
            width: newWidth,
            height: newHeight
        };

        // Zmień rozmiar canvas (fizyczny rozmiar dla renderowania)
        this.canvas.updateOutputAreaSize(newWidth, newHeight, false);

        log.info(`Output area bounds updated: x=${this.canvas.outputAreaBounds.x}, y=${this.canvas.outputAreaBounds.y}, w=${newWidth}, h=${newHeight}`);
        log.info(`Extensions: top=${ext.top}, bottom=${ext.bottom}, left=${ext.left}, right=${ext.right}`);
    }
}
