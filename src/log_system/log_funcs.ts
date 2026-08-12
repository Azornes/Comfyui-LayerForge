/**
 * AzLogs helper functions.
 *
 * This is the typed LayerForge port of Model Resolver's log system helper
 * module. Keeping these helpers in their own module lets every frontend
 * feature create a consistent module-scoped logger.
 */

import { logger } from './logger.js';

export interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    exception: (...args: any[]) => void;
    fatal: (...args: any[]) => void;
}

/** Create a logger object with a fixed module name. */
export function createModuleLogger(moduleName: string): Logger {
    return {
        debug: (...args: any[]) => logger.debug(moduleName, ...args),
        info: (...args: any[]) => logger.info(moduleName, ...args),
        warn: (...args: any[]) => logger.warn(moduleName, ...args),
        error: (...args: any[]) => logger.error(moduleName, ...args),
        exception: (...args: any[]) => logger.exception(moduleName, ...args),
        fatal: (...args: any[]) => logger.fatal(moduleName, ...args),
    };
}

/** Create a logger using the first JavaScript filename found in the stack. */
export function createAutoLogger(): Logger {
    const stack = new Error().stack;
    const match = stack?.match(/\/([^/]+)\.js/);
    const moduleName = match ? match[1] : 'Unknown';
    return createModuleLogger(moduleName);
}

/** Wrap an async operation with start, completion, and failure logging. */
export function withErrorLogging<T extends (...args: any[]) => any>(
    operation: T,
    log: Logger,
    operationName: string,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
    return async function (this: unknown, ...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
        try {
            log.debug(`Starting ${operationName}`);
            const result = await operation.apply(this, args);
            log.debug(`Completed ${operationName}`);
            return result;
        } catch (error) {
            log.error(`Error in ${operationName}:`, error);
            throw error;
        }
    };
}

/** Decorate a class method with start, completion, and failure logging. */
export function logMethod(log: Logger, methodName?: string) {
    return function (
        _target: object,
        propertyKey: string | symbol,
        descriptor: PropertyDescriptor,
    ): PropertyDescriptor {
        const originalMethod = descriptor.value as (...args: any[]) => any;
        descriptor.value = async function (this: unknown, ...args: any[]) {
            const name = methodName || String(propertyKey);
            try {
                log.debug(`${name} started`);
                const result = await originalMethod.apply(this, args);
                log.debug(`${name} completed`);
                return result;
            } catch (error) {
                log.error(`${name} failed:`, error);
                throw error;
            }
        };
        return descriptor;
    };
}
