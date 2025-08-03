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
    SETTINGS: 'settings',
    SYSTEM_CLIPBOARD: 'system_clipboard',
    CLIPSPACE: 'clipspace',
    CROP: 'crop',
    TRANSFORM: 'transform',
};
// SVG Icons for LayerForge tools
const SYSTEM_CLIPBOARD_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm5 15H7v-2h10v2zm0-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
const CLIPSPACE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">  <defs>    <mask id="cutout">      <rect width="100%" height="100%" fill="white"/>           <path         d="M5.485 23.76c-.568 0-1.026-.207-1.325-.598-.307-.402-.387-.964-.22-1.54l.672-2.315a.605.605 0 00-.1-.536.622.622 0 00-.494-.243H2.085c-.568 0-1.026-.207-1.325-.598-.307-.403-.387-.964-.22-1.54l2.31-7.917.255-.87c.343-1.18 1.592-2.14 2.786-2.14h2.313c.276 0 .519-.18.595-.442l.764-2.633C9.906 1.208 11.155.249 12.35.249l4.945-.008h3.62c.568 0 1.027.206 1.325.597.307.402.387.964.22 1.54l-1.035 3.566c-.343 1.178-1.593 2.137-2.787 2.137l-4.956.01H11.37a.618.618 0 00-.594.441l-1.928 6.604a.605.605 0 00.1.537c.118.153.3.243.495.243l3.275-.006h3.61c.568 0 1.026.206 1.325.598.307.402.387.964.22 1.54l-1.036 3.565c-.342 1.179-1.592 2.138-2.786 2.138l-4.957.01h-3.61z"         fill="black"         transform="translate(4.8 4.8) scale(0.6)"      />    </mask>  </defs>  <path     d="M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1z"     fill="#ffffff"     mask="url(#cutout)"  /></svg>`;
const CROP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M17 15h3V7c0-1.1-.9-2-2-2H10v3h7v7zM7 18V1H4v4H0v3h4v10c0 2 1 3 3 3h10v4h3v-4h4v-3H24z"/></svg>';
const TRANSFORM_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffffff"><path d="M11.3 17.096c.092-.044.34-.052 1.028-.044l.912.008.124.124c.184.184.184.408.004.584l-.128.132-.896.012c-.72.008-.924 0-1.036-.048-.18-.072-.284-.264-.256-.452.028-.168.092-.248.248-.316Zm-3.164 0c.096-.044.328-.052 1.036-.044l.916.008.116.132c.16.18.16.396 0 .576l-.116.132-.876.012c-.552.008-.928-.004-1.02-.032-.388-.112-.428-.62-.056-.784Zm-4.6-1.168.112-.096 1.42.004 1.424.004.116.116.116.116V17.48v1.408l-.116.116-.116.116H5.068h-1.42l-.112-.096-.112-.096L3.42 17.48V16.032l.112-.096ZM4.78 12.336c.104-.104.168-.136.284-.136s.18.032.284.136l.136.136v.964.964l-.116.128c-.1.112-.144.132-.304.132s-.204-.02-.304-.132L4.644 14.4l-.004-.964v-.964l.136-.136Zm8.868-.648c-.008-.024-.004-.048.008-.048s1.504.512 3.312 1.136c1.812.624 4.252 1.464 5.424 1.868 1.168.404 2.128.744 2.128.76 0 .012-.24.108-.528.212-.292.104-1.468.52-2.616.928l-2.08.74-.936 2.62c-.512 1.44-.944 2.616-.956 2.616-.016 0-.86-2.424-1.88-5.392-1.02-2.964-1.864-5.412-1.876-5.44ZM19.292 9.08c.216-.088.432-.02.548.168.076.124.08.188.072 1.06l-.012.928-.116.12c-.1.104-.148.124-.304.124s-.204-.02-.304-.124l-.116-.12-.012-.928c-.008-.872-.004-.936.072-1.06.044-.072.12-.148.172-.168Zm-14.516.096c.104-.104.168-.136.284-.136s.18.032.284.136l.136.136v.956c0 1.064-.004 1.088-.268 1.2-.18.072-.376.012-.492-.148-.076-.104-.08-.172-.08-1.06V9.312l.136-.136ZM19.192 6c.096-.088.168-.116.288-.116s.192.028.288.116l.132.116V7.1v.98l-.116.12c-.1.104-.148.124-.304.124s-.204-.02-.304-.124l-.116-.12V7.096 6.112l.132-.116ZM4.816 5.964c.048-.044.152-.072.256-.072.144 0 .196.02.292.124l.116.124v.98.968l-.116.116c-.092.092-.152.116-.284.116-.408 0-.44-.28-.44-1.22s.012-1.016.176-1.148Zm9.516-3.192.14-.136.968.004h.968l.112.116c.152.152.188.3.108.468-.124.252-.196.276-1.044.288-.42.008-.84.004-.936-.012-.24-.036-.38-.192-.436-.408-.02-.156-.008-.184.12-.312Zm-3.156-.268.136.136h.956c1.064 0 1.088.004 1.2.268.072.172.016.372-.136.492-.096.076-.16.08-1.06.08h-.96l-.136-.136c-.104-.104-.136-.168-.136-.284s.032-.18.136-.284Zm-3.16 0 .136.136h.96c.94 0 .964.004 1.068.088.2.176.196.508-.004.668-.1.08-.156.084-1.064.084h-.96l-.136-.136c-.188-.188-.188-.38 0-.568Zm10.04-1.14c.044-.02.712-.032 1.476-.028l1.396.008.096.112.096.112v1.424 1.5l-.116.116-.116.116L19.48 4.72H18.072l-.116-.116-.116-.116V3.072c0-1.524.004-1.544.216-1.632ZM3.62 1.456c.184-.08 2.74-.08 2.896 0 .196.104.204.164.204 1.604s-.008 1.5-.204 1.604c-.148.076-2.732.084-2.896.008-.212-.096-.22-.148-.22-1.608s.008-1.516.22-1.608Z"/></svg>';
const LAYERFORGE_TOOL_ICONS = {
    [LAYERFORGE_TOOLS.SYSTEM_CLIPBOARD]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SYSTEM_CLIPBOARD_ICON_SVG)}`,
    [LAYERFORGE_TOOLS.CLIPSPACE]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(CLIPSPACE_ICON_SVG)}`,
    [LAYERFORGE_TOOLS.CROP]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(CROP_ICON_SVG)}`,
    [LAYERFORGE_TOOLS.TRANSFORM]: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(TRANSFORM_ICON_SVG)}`,
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
    [LAYERFORGE_TOOLS.SETTINGS]: '#F06292',
    [LAYERFORGE_TOOLS.CROP]: '#EA4335',
    [LAYERFORGE_TOOLS.TRANSFORM]: '#34A853',
};
export class IconLoader {
    constructor() {
        this._iconCache = {};
        this._loadingPromises = new Map();
        /**
         * Preload all LayerForge tool icons
         */
        this.preloadToolIcons = withErrorHandling(async () => {
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
        this.loadIcon = withErrorHandling(async (tool) => {
            if (!tool) {
                throw createValidationError("Tool name is required", { tool });
            }
            // Check if already cached
            if (this._iconCache[tool] && this._iconCache[tool] instanceof HTMLImageElement) {
                return this._iconCache[tool];
            }
            // Check if already loading
            if (this._loadingPromises.has(tool)) {
                return this._loadingPromises.get(tool);
            }
            // Create fallback canvas first
            const fallbackCanvas = this.createFallbackIcon(tool);
            this._iconCache[tool] = fallbackCanvas;
            // Start loading the SVG icon
            const loadPromise = new Promise((resolve, reject) => {
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
                const iconData = LAYERFORGE_TOOL_ICONS[tool];
                if (iconData) {
                    img.src = iconData;
                }
                else {
                    log.warn(`No icon data found for tool: ${tool}`);
                    reject(createValidationError(`No icon data for tool: ${tool}`, { tool, availableTools: Object.keys(LAYERFORGE_TOOL_ICONS) }));
                }
            });
            this._loadingPromises.set(tool, loadPromise);
            return loadPromise;
        }, 'IconLoader.loadIcon');
        log.info('IconLoader initialized');
    }
    /**
     * Create a fallback canvas icon with colored background and text
     */
    createFallbackIcon(tool) {
        const { canvas, ctx } = createCanvas(24, 24);
        if (!ctx) {
            log.error('Failed to get canvas context for fallback icon');
            return canvas;
        }
        // Fill background with tool color
        const color = LAYERFORGE_TOOL_COLORS[tool] || '#888888';
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
    getIcon(tool) {
        return this._iconCache[tool] || null;
    }
    /**
     * Check if icon is loaded (as image, not fallback canvas)
     */
    isIconLoaded(tool) {
        return this._iconCache[tool] instanceof HTMLImageElement;
    }
    /**
     * Clear all cached icons
     */
    clearCache() {
        this._iconCache = {};
        this._loadingPromises.clear();
        log.info('Icon cache cleared');
    }
    /**
     * Get all available tool names
     */
    getAvailableTools() {
        return Object.values(LAYERFORGE_TOOLS);
    }
    /**
     * Get tool color
     */
    getToolColor(tool) {
        return LAYERFORGE_TOOL_COLORS[tool] || '#888888';
    }
}
// Export singleton instance
export const iconLoader = new IconLoader();
// Export for external use
export { LAYERFORGE_TOOL_ICONS, LAYERFORGE_TOOL_COLORS };
