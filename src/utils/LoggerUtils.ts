/**
 * LoggerUtils - Centralizacja inicjalizacji loggerów
 * Eliminuje powtarzalny kod inicjalizacji loggera w każdym module
 */

import {logger, LogLevel} from "../logger.js";
import { LOG_LEVEL } from '../config.js';

export interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

/**
 * Tworzy obiekt loggera dla modułu z predefiniowanymi metodami
 * @param {string} moduleName - Nazwa modułu
 * @returns {Logger} Obiekt z metodami logowania
 */
export function createModuleLogger(moduleName: string): Logger {
    logger.setModuleLevel(moduleName, LogLevel[LOG_LEVEL as keyof typeof LogLevel]);

    return {
        debug: (...args: any[]) => logger.debug(moduleName, ...args),
        info: (...args: any[]) => logger.info(moduleName, ...args),
        warn: (...args: any[]) => logger.warn(moduleName, ...args),
        error: (...args: any[]) => logger.error(moduleName, ...args)
    };
}

/**
 * Tworzy logger z automatycznym wykrywaniem nazwy modułu z URL
 * @returns {Logger} Obiekt z metodami logowania
 */
export function createAutoLogger(): Logger {
    const stack = new Error().stack;
    const match = stack?.match(/\/([^\/]+)\.js/);
    const moduleName = match ? match[1] : 'Unknown';

    return createModuleLogger(moduleName);
}

/**
 * Wrapper dla operacji z automatycznym logowaniem błędów
 * @param {Function} operation - Operacja do wykonania
 * @param {Logger} log - Obiekt loggera
 * @param {string} operationName - Nazwa operacji (dla logów)
 * @returns {Function} Opakowana funkcja
 */
export function withErrorLogging<T extends (...args: any[]) => any>(
    operation: T, 
    log: Logger, 
    operationName: string
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async function(this: any, ...args: Parameters<T>): Promise<ReturnType<T>> {
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

/**
 * Decorator dla metod klasy z automatycznym logowaniem
 * @param {Logger} log - Obiekt loggera
 * @param {string} methodName - Nazwa metody
 */
export function logMethod(log: Logger, methodName?: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            try {
                log.debug(`${methodName || propertyKey} started`);
                const result = await originalMethod.apply(this, args);
                log.debug(`${methodName || propertyKey} completed`);
                return result;
            } catch (error) {
                log.error(`${methodName || propertyKey} failed:`, error);
                throw error;
            }
        };

        return descriptor;
    };
}
