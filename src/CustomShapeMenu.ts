import {createModuleLogger} from "./utils/LoggerUtils.js";
import { addStylesheet, getUrl } from "./utils/ResourceManager.js";
import type { Canvas } from './Canvas';

const log = createModuleLogger('CustomShapeMenu');

export class CustomShapeMenu {
    private canvas: Canvas;
    private element: HTMLDivElement | null;
    private worldX: number;
    private worldY: number;
    private uiInitialized: boolean;
    private tooltip: HTMLDivElement | null;
    private isMinimized: boolean = false;

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
            this._updateMinimizedState();
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
        
        addStylesheet(getUrl('./css/custom_shape_menu.css'));
        
        this.element = document.createElement('div');
        this.element.id = 'layerforge-custom-shape-menu';

        // --- MINIMIZED BAR ---
        const minimizedBar = document.createElement('div');
        minimizedBar.className = 'custom-shape-minimized-bar';
        minimizedBar.textContent = "Custom Output Area Active";
        minimizedBar.style.display = 'none';
        minimizedBar.style.cursor = 'pointer';
        minimizedBar.onclick = () => {
            this.isMinimized = false;
            this._updateMinimizedState();
        };
        this.element.appendChild(minimizedBar);

        // --- FULL MENU ---
        const fullMenu = document.createElement('div');
        fullMenu.className = 'custom-shape-full-menu';

        // Minimize button (top right)
        const minimizeBtn = document.createElement('button');
        minimizeBtn.innerHTML = "–";
        minimizeBtn.title = "Minimize menu";
        minimizeBtn.className = 'custom-shape-minimize-btn';
        minimizeBtn.style.position = 'absolute';
        minimizeBtn.style.top = '4px';
        minimizeBtn.style.right = '4px';
        minimizeBtn.style.width = '24px';
        minimizeBtn.style.height = '24px';
        minimizeBtn.style.border = 'none';
        minimizeBtn.style.background = 'transparent';
        minimizeBtn.style.color = '#888';
        minimizeBtn.style.fontSize = '20px';
        minimizeBtn.style.cursor = 'pointer';
        minimizeBtn.onclick = (e) => {
            e.stopPropagation();
            this.isMinimized = true;
            this._updateMinimizedState();
        };
        fullMenu.appendChild(minimizeBtn);

        // Create menu content
        const lines = [
            "Custom Output Area Active"
        ];

        lines.forEach(line => {
            const lineElement = document.createElement('div');
            lineElement.textContent = line;
            lineElement.className = 'menu-line';
            fullMenu.appendChild(lineElement);
        });

        // Create a container for the entire shape mask feature set
        const featureContainer = document.createElement('div');
        featureContainer.id = 'shape-mask-feature-container';
        featureContainer.className = 'feature-container';

        // Add main auto-apply checkbox to the new container
        const checkboxContainer = this._createCheckbox(
            'auto-apply-checkbox',
            () => this.canvas.autoApplyShapeMask,
            'Auto-apply shape mask',
            (e) => {
                this.canvas.autoApplyShapeMask = (e.target as HTMLInputElement).checked;
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
            'expansion-checkbox',
            () => this.canvas.shapeMaskExpansion,
            'Expand/Contract mask',
            (e) => {
                this.canvas.shapeMaskExpansion = (e.target as HTMLInputElement).checked;
                this._updateUI();
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            },
            "Dilate (expand) or erode (contract) the shape mask. Positive values expand the mask outward, negative values shrink it inward."
        );
        featureContainer.appendChild(expansionContainer);

        // Add expansion slider container
        const expansionSliderContainer = document.createElement('div');
        expansionSliderContainer.id = 'expansion-slider-container';
        expansionSliderContainer.className = 'slider-container';

        const expansionSliderLabel = document.createElement('div');
        expansionSliderLabel.textContent = 'Expansion amount:';
        expansionSliderLabel.className = 'slider-label';

        const expansionSlider = document.createElement('input');
        expansionSlider.type = 'range';
        expansionSlider.min = '-300';
        expansionSlider.max = '300';
        expansionSlider.value = String(this.canvas.shapeMaskExpansionValue);

        const expansionValueDisplay = document.createElement('div');
        expansionValueDisplay.className = 'slider-value-display';

        let expansionValueBeforeDrag = this.canvas.shapeMaskExpansionValue;

        const updateExpansionSliderDisplay = () => {
            const value = parseInt(expansionSlider.value);
            this.canvas.shapeMaskExpansionValue = value;
            expansionValueDisplay.textContent = value > 0 ? `+${value}px` : `${value}px`;
        };

        let isExpansionDragging = false;
        
        expansionSlider.onmousedown = () => { 
            isExpansionDragging = true;
            expansionValueBeforeDrag = this.canvas.shapeMaskExpansionValue; // Store value before dragging
        };
        
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
                const finalValue = parseInt(expansionSlider.value);
                
                // If value changed during drag, remove old mask with previous expansion value
                if (expansionValueBeforeDrag !== finalValue) {
                    // Temporarily set the previous value to remove the old mask properly
                    const tempValue = this.canvas.shapeMaskExpansionValue;
                    this.canvas.shapeMaskExpansionValue = expansionValueBeforeDrag;
                    this.canvas.maskTool.removeShapeMask();
                    this.canvas.shapeMaskExpansionValue = tempValue; // Restore current value
                    log.info(`Removed old shape mask with expansion: ${expansionValueBeforeDrag}px before applying new value: ${finalValue}px`);
                }
                
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
            'feather-checkbox',
            () => this.canvas.shapeMaskFeather,
            'Feather edges',
            (e) => {
                this.canvas.shapeMaskFeather = (e.target as HTMLInputElement).checked;
                this._updateUI();
                if (this.canvas.autoApplyShapeMask) {
                    this.canvas.maskTool.hideShapePreview();
                    this.canvas.maskTool.applyShapeMask();
                    this.canvas.render();
                }
            },
            "Softens the edges of the shape mask by creating a gradual transition from opaque to transparent."
        );
        featureContainer.appendChild(featherContainer);

        // Add feather slider container
        const featherSliderContainer = document.createElement('div');
        featherSliderContainer.id = 'feather-slider-container';
        featherSliderContainer.className = 'slider-container';

        const featherSliderLabel = document.createElement('div');
        featherSliderLabel.textContent = 'Feather amount:';
        featherSliderLabel.className = 'slider-label';

        const featherSlider = document.createElement('input');
        featherSlider.type = 'range';
        featherSlider.min = '0';
        featherSlider.max = '300';
        featherSlider.value = String(this.canvas.shapeMaskFeatherValue);

        const featherValueDisplay = document.createElement('div');
        featherValueDisplay.className = 'slider-value-display';

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

        fullMenu.appendChild(featureContainer);

        // Create output area extension container
        const extensionContainer = document.createElement('div');
        extensionContainer.id = 'output-area-extension-container';
        extensionContainer.className = 'feature-container';

        // Add main extension checkbox
        const extensionCheckboxContainer = this._createCheckbox(
            'extension-checkbox',
            () => this.canvas.outputAreaExtensionEnabled,
            'Extend output area',
            (e) => {
                this.canvas.outputAreaExtensionEnabled = (e.target as HTMLInputElement).checked;
                 if (this.canvas.outputAreaExtensionEnabled) {
                    this.canvas.originalCanvasSize = { width: this.canvas.width, height: this.canvas.height };
                    this.canvas.outputAreaExtensions = { ...this.canvas.lastOutputAreaExtensions };
                } else {
                    this.canvas.lastOutputAreaExtensions = { ...this.canvas.outputAreaExtensions };
                    this.canvas.outputAreaExtensions = { top: 0, bottom: 0, left: 0, right: 0 };
                }
                this._updateExtensionUI();
                this._updateCanvasSize();
                this.canvas.render();
            },
            "Allows extending the output area boundaries in all directions without changing the custom shape."
        );
        extensionContainer.appendChild(extensionCheckboxContainer);

        // Create sliders container
        const slidersContainer = document.createElement('div');
        slidersContainer.id = 'extension-sliders-container';
        slidersContainer.className = 'slider-container';

        // Helper function to create a slider with preview system
        const createExtensionSlider = (label: string, direction: 'top' | 'bottom' | 'left' | 'right') => {
            const sliderContainer = document.createElement('div');
            sliderContainer.className = 'extension-slider-container';

            const sliderLabel = document.createElement('div');
            sliderLabel.textContent = label;
            sliderLabel.className = 'slider-label';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '500';
            slider.value = String(this.canvas.outputAreaExtensions[direction]);

            const valueDisplay = document.createElement('div');
            valueDisplay.className = 'slider-value-display';

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
        fullMenu.appendChild(extensionContainer);

        this.element.appendChild(fullMenu);

        // Add to DOM
        if (this.canvas.canvas.parentElement) {
            this.canvas.canvas.parentElement.appendChild(this.element);
        } else {
            log.error("Could not find parent node to attach custom shape menu.");
        }
        
        this.uiInitialized = true;
        this._updateUI();
        this._updateMinimizedState();
        
        // Add viewport change listener to update shape preview when zooming/panning
        this._addViewportChangeListener();
    }

    private _createCheckbox(
        id: string,
        getChecked: () => boolean,
        text: string,
        clickHandler: (e: Event) => void,
        tooltipText?: string
    ): HTMLLabelElement {
        const container = document.createElement('label');
        container.className = 'checkbox-container';
        container.htmlFor = id;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = getChecked();
        
        const customCheckbox = document.createElement('div');
        customCheckbox.className = 'custom-checkbox';

        const labelText = document.createElement('span');
        labelText.textContent = text;
        
        container.appendChild(input);
        container.appendChild(customCheckbox);
        container.appendChild(labelText);

        // Stop propagation to prevent menu from closing, but allow default checkbox behavior
        container.onclick = (e: MouseEvent) => {
            e.stopPropagation();
        };
        
        input.onchange = (e: Event) => {
            clickHandler(e);
        };

        if (tooltipText) {
            this._addTooltip(container, tooltipText);
        }

        return container;
    }

    private _updateUI(): void {
        if (!this.element) return;

        // Always update only the full menu part
        const fullMenu = this.element.querySelector('.custom-shape-full-menu') as HTMLElement;
        if (!fullMenu) return;

        const setChecked = (id: string, checked: boolean) => {
            const input = fullMenu.querySelector(`#${id}`) as HTMLInputElement;
            if (input) input.checked = checked;
        };

        setChecked('auto-apply-checkbox', this.canvas.autoApplyShapeMask);
        setChecked('expansion-checkbox', this.canvas.shapeMaskExpansion);
        setChecked('feather-checkbox', this.canvas.shapeMaskFeather);
        setChecked('extension-checkbox', this.canvas.outputAreaExtensionEnabled);

        const expansionCheckbox = fullMenu.querySelector('#expansion-checkbox')?.parentElement as HTMLElement;
        if (expansionCheckbox) {
            expansionCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'flex' : 'none';
        }
        
        const featherCheckbox = fullMenu.querySelector('#feather-checkbox')?.parentElement as HTMLElement;
        if (featherCheckbox) {
            featherCheckbox.style.display = this.canvas.autoApplyShapeMask ? 'flex' : 'none';
        }

        const expansionSliderContainer = fullMenu.querySelector('#expansion-slider-container') as HTMLElement;
        if (expansionSliderContainer) {
            expansionSliderContainer.style.display = (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskExpansion) ? 'block' : 'none';
        }

        const featherSliderContainer = fullMenu.querySelector('#feather-slider-container') as HTMLElement;
        if (featherSliderContainer) {
            featherSliderContainer.style.display = (this.canvas.autoApplyShapeMask && this.canvas.shapeMaskFeather) ? 'block' : 'none';
        }
    }

    private _updateMinimizedState(): void {
        if (!this.element) return;
        const minimizedBar = this.element.querySelector('.custom-shape-minimized-bar') as HTMLElement;
        const fullMenu = this.element.querySelector('.custom-shape-full-menu') as HTMLElement;
        if (this.isMinimized) {
            minimizedBar.style.display = 'block';
            fullMenu.style.display = 'none';
        } else {
            minimizedBar.style.display = 'none';
            fullMenu.style.display = 'block';
        }
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
        this.tooltip.className = 'layerforge-tooltip';

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
