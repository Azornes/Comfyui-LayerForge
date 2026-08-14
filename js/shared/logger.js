/**
 * Backward-compatible exports for the LayerForge logger.
 *
 * The canonical implementation lives in `src/log_system/logger.ts` and is
 * compiled to `js/log_system/logger.js` for ComfyUI.
 */
export * from '../log_system/logger.js';
export { default } from '../log_system/logger.js';
