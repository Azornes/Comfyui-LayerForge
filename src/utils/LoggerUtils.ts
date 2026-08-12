/**
 * Backward-compatible exports for the LayerForge logging helpers.
 *
 * The canonical implementation lives in `src/log_system/log_funcs.ts`.
 */
export {
    createAutoLogger,
    createModuleLogger,
    logMethod,
    withErrorLogging,
} from '../log_system/log_funcs.js';
export type { Logger } from '../log_system/log_funcs.js';
