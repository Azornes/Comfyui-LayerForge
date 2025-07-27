import { createModuleLogger } from "./LoggerUtils.js";
import { createCanvas } from "./CommonUtils.js";
import { withErrorHandling, createValidationError } from "../ErrorHandler.js";

const log = createModuleLogger('IconLoader');

// Define tool constants for LayerForge
export const LAYERFORGE_TOOLS = {
    VISIBILITY: 'visibility',
    MOVE: 'move',
    ROTATE: 'rotate',
    SCALE: 'scale',
    DELETE: 'delete',
    DUPLICATE: 'duplicate',
    BLEND_MODE: 'blend_mode',
    OPACITY: 'opacity',
    MASK: 'mask',
    BRUSH: 'brush',
    ERASER: 'eraser',
    SHAPE: 'shape',
    SETTINGS: 'settings'
} as const;

// SVG Icons for LayerForge tools
const LAYERFORGE_TOOL_ICONS = {
    [LAYERFORGE_TOOLS.VISIBILITY]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.MOVE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.ROTATE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12,6V9L16,5L12,1V4A8,8 0 0,0 4,12C4,13.57 4.46,15.03 5.24,16.26L6.7,14.8C6.25,13.97 6,13 6,12A6,6 0 0,1 12,6M18.76,7.74L17.3,9.2C17.74,10.04 18,11 18,12A6,6 0 0,1 12,18V15L8,19L12,23V20A8,8 0 0,0 20,12C20,10.43 19.54,8.97 18.76,7.74Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.SCALE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M22,18V22H18V20H20V18H22M22,6V10H20V8H18V6H22M2,6V10H4V8H6V6H2M2,18V22H6V20H4V18H2M16,8V10H14V12H16V14H14V16H12V14H10V12H12V10H10V8H12V6H14V8H16Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.DELETE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.DUPLICATE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.BLEND_MODE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20V4Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.OPACITY]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12,20A6,6 0 0,1 6,14C6,10 12,3.25 12,3.25S18,10 18,14A6,6 0 0,1 12,20Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.MASK]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="#ffffff" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="#ffffff"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.BRUSH]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M15.4565 9.67503L15.3144 9.53297C14.6661 8.90796 13.8549 8.43369 12.9235 8.18412C10.0168 7.40527 7.22541 9.05273 6.43185 12.0143C6.38901 12.1742 6.36574 12.3537 6.3285 12.8051C6.17423 14.6752 5.73449 16.0697 4.5286 17.4842C6.78847 18.3727 9.46572 18.9986 11.5016 18.9986C13.9702 18.9986 16.1644 17.3394 16.8126 14.9202C17.3306 12.9869 16.7513 11.0181 15.4565 9.67503ZM13.2886 6.21301L18.2278 2.37142C18.6259 2.0618 19.1922 2.09706 19.5488 2.45367L22.543 5.44787C22.8997 5.80448 22.9349 6.37082 22.6253 6.76891L18.7847 11.7068C19.0778 12.8951 19.0836 14.1721 18.7444 15.4379C17.8463 18.7897 14.8142 20.9986 11.5016 20.9986C8 20.9986 3.5 19.4967 1 17.9967C4.97978 14.9967 4.04722 13.1865 4.5 11.4967C5.55843 7.54658 9.34224 5.23935 13.2886 6.21301ZM16.7015 8.09161C16.7673 8.15506 16.8319 8.21964 16.8952 8.28533L18.0297 9.41984L20.5046 6.23786L18.7589 4.4921L15.5769 6.96698L16.7015 8.09161Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.ERASER]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M8.58564 8.85449L3.63589 13.8042L8.83021 18.9985L9.99985 18.9978V18.9966H11.1714L14.9496 15.2184L8.58564 8.85449ZM9.99985 7.44027L16.3638 13.8042L19.1922 10.9758L12.8283 4.61185L9.99985 7.44027ZM13.9999 18.9966H20.9999V20.9966H11.9999L8.00229 20.9991L1.51457 14.5113C1.12405 14.1208 1.12405 13.4877 1.51457 13.0971L12.1212 2.49053C12.5117 2.1 13.1449 2.1 13.5354 2.49053L21.3136 10.2687C21.7041 10.6592 21.7041 11.2924 21.3136 11.6829L13.9999 18.9966Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.SHAPE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M3 4H21C21.5523 4 22 4.44772 22 5V19C22 19.5523 21.5523 20 21 20H3C2.44772 20 2 19.5523 2 19V5C2 4.44772 2.44772 4 3 4ZM4 6V18H20V6H4Z"/></svg>')}`,
    
    [LAYERFORGE_TOOLS.SETTINGS]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.22,8.95 2.27,9.22 2.46,9.37L4.5,11L5.13,18.93C5.17,19.18 5.38,19.36 5.63,19.36H18.37C18.62,19.36 18.83,19.18 18.87,18.93L19.5,11L21.54,9.37Z"/></svg>')}`
};

// Tool colors for LayerForge
const LAYERFORGE_TOOL_COLORS = {
    [LAYERFORGE_TOOLS.VISIBILITY]: '#4285F4',
    [LAYERFORGE_TOOLS.MOVE]: '#34A853',
    [LAYERFORGE_TOOLS.ROTATE]: '#FBBC05',
    [LAYERFORGE_TOOLS.SCALE]: '#EA4335',
    [LAYERFORGE_TOOLS.DELETE]: '#FF6D01',
    [LAYERFORGE_TOOLS.DUPLICATE]: '#46BDC6',
    [LAYERFORGE_TOOLS.BLEND_MODE]: '#9C27B0',
    [LAYERFORGE_TOOLS.OPACITY]: '#8BC34A',
    [LAYERFORGE_TOOLS.MASK]: '#607D8B',
    [LAYERFORGE_TOOLS.BRUSH]: '#4285F4',
    [LAYERFORGE_TOOLS.ERASER]: '#FBBC05',
    [LAYERFORGE_TOOLS.SHAPE]: '#FF6D01',
    [LAYERFORGE_TOOLS.SETTINGS]: '#F06292'
};

export interface IconCache {
    [key: string]: HTMLCanvasElement | HTMLImageElement;
}

export class IconLoader {
    private _iconCache: IconCache = {};
    private _loadingPromises: Map<string, Promise<HTMLImageElement>> = new Map();

    constructor() {
        log.info('IconLoader initialized');
    }

    /**
     * Preload all LayerForge tool icons
     */
    preloadToolIcons = withErrorHandling(async (): Promise<void> => {
        log.info('Starting to preload LayerForge tool icons');
        
        const loadPromises = Object.keys(LAYERFORGE_TOOL_ICONS).map(tool => {
            return this.loadIcon(tool);
        });

        await Promise.all(loadPromises);
        log.info(`Successfully preloaded ${loadPromises.length} tool icons`);
    }, 'IconLoader.preloadToolIcons');

    /**
     * Load a specific icon by tool name
     */
    loadIcon = withErrorHandling(async (tool: string): Promise<HTMLImageElement> => {
        if (!tool) {
            throw createValidationError("Tool name is required", { tool });
        }

        // Check if already cached
        if (this._iconCache[tool] && this._iconCache[tool] instanceof HTMLImageElement) {
            return this._iconCache[tool] as HTMLImageElement;
        }

        // Check if already loading
        if (this._loadingPromises.has(tool)) {
            return this._loadingPromises.get(tool)!;
        }

        // Create fallback canvas first
        const fallbackCanvas = this.createFallbackIcon(tool);
        this._iconCache[tool] = fallbackCanvas;

        // Start loading the SVG icon
        const loadPromise = new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            
            img.onload = () => {
                this._iconCache[tool] = img;
                this._loadingPromises.delete(tool);
                log.debug(`Successfully loaded icon for tool: ${tool}`);
                resolve(img);
            };

            img.onerror = (error) => {
                log.warn(`Failed to load SVG icon for tool: ${tool}, using fallback`);
                this._loadingPromises.delete(tool);
                // Keep the fallback canvas in cache
                reject(error);
            };

            const iconData = LAYERFORGE_TOOL_ICONS[tool as keyof typeof LAYERFORGE_TOOL_ICONS];
            if (iconData) {
                img.src = iconData;
            } else {
                log.warn(`No icon data found for tool: ${tool}`);
                reject(createValidationError(`No icon data for tool: ${tool}`, { tool, availableTools: Object.keys(LAYERFORGE_TOOL_ICONS) }));
            }
        });

        this._loadingPromises.set(tool, loadPromise);
        return loadPromise;
    }, 'IconLoader.loadIcon');

    /**
     * Create a fallback canvas icon with colored background and text
     */
    private createFallbackIcon(tool: string): HTMLCanvasElement {
        const { canvas, ctx } = createCanvas(24, 24);
        
        if (!ctx) {
            log.error('Failed to get canvas context for fallback icon');
            return canvas;
        }

        // Fill background with tool color
        const color = LAYERFORGE_TOOL_COLORS[tool as keyof typeof LAYERFORGE_TOOL_COLORS] || '#888888';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 24, 24);

        // Add border
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, 23, 23);

        // Add text
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const firstChar = tool.charAt(0).toUpperCase();
        ctx.fillText(firstChar, 12, 12);

        return canvas;
    }

    /**
     * Get cached icon (canvas or image)
     */
    getIcon(tool: string): HTMLCanvasElement | HTMLImageElement | null {
        return this._iconCache[tool] || null;
    }

    /**
     * Check if icon is loaded (as image, not fallback canvas)
     */
    isIconLoaded(tool: string): boolean {
        return this._iconCache[tool] instanceof HTMLImageElement;
    }

    /**
     * Clear all cached icons
     */
    clearCache(): void {
        this._iconCache = {};
        this._loadingPromises.clear();
        log.info('Icon cache cleared');
    }

    /**
     * Get all available tool names
     */
    getAvailableTools(): string[] {
        return Object.values(LAYERFORGE_TOOLS);
    }

    /**
     * Get tool color
     */
    getToolColor(tool: string): string {
        return LAYERFORGE_TOOL_COLORS[tool as keyof typeof LAYERFORGE_TOOL_COLORS] || '#888888';
    }
}

// Export singleton instance
export const iconLoader = new IconLoader();

// Export for external use
export { LAYERFORGE_TOOL_ICONS, LAYERFORGE_TOOL_COLORS };
