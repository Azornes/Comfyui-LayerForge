/**
 * AzLogs helper functions.
 *
 * This is the typed LayerForge port of Model Resolver's log system helper
 * module. Keeping these helpers in their own module lets every frontend
 * feature create a consistent module-scoped logger.
 */
import { logger } from './logger.js';
/** Create a logger object with a fixed module name. */
export function createModuleLogger(moduleName) {
    return {
        debug: (...args) => logger.debug(moduleName, ...args),
        info: (...args) => logger.info(moduleName, ...args),
        warn: (...args) => logger.warn(moduleName, ...args),
        error: (...args) => logger.error(moduleName, ...args),
        exception: (...args) => logger.exception(moduleName, ...args),
        fatal: (...args) => logger.fatal(moduleName, ...args),
    };
}
/** Create a logger using the first JavaScript filename found in the stack. */
export function createAutoLogger() {
    const stack = new Error().stack;
    const match = stack?.match(/\/([^/]+)\.js/);
    const moduleName = match ? match[1] : 'Unknown';
    return createModuleLogger(moduleName);
}
/** Wrap an async operation with start, completion, and failure logging. */
export function withErrorLogging(operation, log, operationName) {
    return async function (...args) {
        try {
            log.debug(`Starting ${operationName}`);
            const result = await operation.apply(this, args);
            log.debug(`Completed ${operationName}`);
            return result;
        }
        catch (error) {
            log.error(`Error in ${operationName}:`, error);
            throw error;
        }
    };
}
/** Decorate a class method with start, completion, and failure logging. */
export function logMethod(log, methodName) {
    return function (_target, propertyKey, descriptor) {
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args) {
            const name = methodName || String(propertyKey);
            try {
                log.debug(`${name} started`);
                const result = await originalMethod.apply(this, args);
                log.debug(`${name} completed`);
                return result;
            }
            catch (error) {
                log.error(`${name} failed:`, error);
                throw error;
            }
        };
        return descriptor;
    };
}
