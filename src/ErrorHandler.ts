/**
 * ErrorHandler - Centralna obsługa błędów
 * Eliminuje powtarzalne wzorce obsługi błędów w całym projekcie
 */

import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('ErrorHandler');

/**
 * Typy błędów w aplikacji
 */
export const ErrorTypes = {
    VALIDATION: 'VALIDATION_ERROR',
    NETWORK: 'NETWORK_ERROR',
    FILE_IO: 'FILE_IO_ERROR',
    CANVAS: 'CANVAS_ERROR',
    IMAGE_PROCESSING: 'IMAGE_PROCESSING_ERROR',
    STATE_MANAGEMENT: 'STATE_MANAGEMENT_ERROR',
    USER_INPUT: 'USER_INPUT_ERROR',
    SYSTEM: 'SYSTEM_ERROR'
} as const;

export type ErrorType = typeof ErrorTypes[keyof typeof ErrorTypes];

interface ErrorHistoryEntry {
    timestamp: string;
    type: ErrorType;
    message: string;
    context?: string;
}

interface ErrorStats {
    totalErrors: number;
    errorCounts: { [key: string]: number };
    recentErrors: ErrorHistoryEntry[];
    errorsByType: { [key: string]: ErrorHistoryEntry[] };
}

/**
 * Klasa błędu aplikacji z dodatkowymi informacjami
 */
export class AppError extends Error {
    details: any;
    originalError: Error | null;
    timestamp: string;
    type: ErrorType;
    constructor(message: string, type: ErrorType = ErrorTypes.SYSTEM, details: any = null, originalError: Error | null = null) {
        super(message);
        this.name = 'AppError';
        this.type = type;
        this.details = details;
        this.originalError = originalError;
        this.timestamp = new Date().toISOString();
        if ((Error as any).captureStackTrace) {
            (Error as any).captureStackTrace(this, AppError);
        }
    }
}

/**
 * Handler błędów z automatycznym logowaniem i kategoryzacją
 */
export class ErrorHandler {
    private errorCounts: Map<ErrorType, number>;
    private errorHistory: ErrorHistoryEntry[];
    private maxHistorySize: number;

    constructor() {
        this.errorCounts = new Map();
        this.errorHistory = [];
        this.maxHistorySize = 100;
    }

    /**
     * Obsługuje błąd z automatycznym logowaniem
     * @param {Error | AppError | string} error - Błąd do obsłużenia
     * @param {string} context - Kontekst wystąpienia błędu
     * @param {object} additionalInfo - Dodatkowe informacje
     * @returns {AppError} Znormalizowany błąd
     */
    handle(error: Error | AppError | string, context = 'Unknown', additionalInfo: object = {}): AppError {
        const normalizedError = this.normalizeError(error, context, additionalInfo);
        this.logError(normalizedError, context);
        this.recordError(normalizedError);
        this.incrementErrorCount(normalizedError.type);

        return normalizedError;
    }

    /**
     * Normalizuje błąd do standardowego formatu
     * @param {Error | AppError | string} error - Błąd do znormalizowania
     * @param {string} context - Kontekst
     * @param {object} additionalInfo - Dodatkowe informacje
     * @returns {AppError} Znormalizowany błąd
     */
    normalizeError(error: Error | AppError | string, context: string, additionalInfo: object): AppError {
        if (error instanceof AppError) {
            return error;
        }

        if (error instanceof Error) {
            const type = this.categorizeError(error, context);
            return new AppError(
                error.message,
                type,
                {context, ...additionalInfo},
                error
            );
        }

        if (typeof error === 'string') {
            return new AppError(
                error,
                ErrorTypes.SYSTEM,
                {context, ...additionalInfo}
            );
        }

        return new AppError(
            'Unknown error occurred',
            ErrorTypes.SYSTEM,
            {context, originalError: error, ...additionalInfo}
        );
    }

    /**
     * Kategoryzuje błąd na podstawie wiadomości i kontekstu
     * @param {Error} error - Błąd do skategoryzowania
     * @param {string} context - Kontekst
     * @returns {ErrorType} Typ błędu
     */
    categorizeError(error: Error, context: string): ErrorType {
        const message = error.message.toLowerCase();
        if (message.includes('fetch') || message.includes('network') ||
            message.includes('connection') || message.includes('timeout')) {
            return ErrorTypes.NETWORK;
        }
        if (message.includes('file') || message.includes('read') ||
            message.includes('write') || message.includes('path')) {
            return ErrorTypes.FILE_IO;
        }
        if (message.includes('invalid') || message.includes('required') ||
            message.includes('validation') || message.includes('format')) {
            return ErrorTypes.VALIDATION;
        }
        if (message.includes('image') || message.includes('canvas') ||
            message.includes('blob') || message.includes('tensor')) {
            return ErrorTypes.IMAGE_PROCESSING;
        }
        if (message.includes('state') || message.includes('cache') ||
            message.includes('storage')) {
            return ErrorTypes.STATE_MANAGEMENT;
        }
        if (context.toLowerCase().includes('canvas')) {
            return ErrorTypes.CANVAS;
        }

        return ErrorTypes.SYSTEM;
    }

    /**
     * Loguje błąd z odpowiednim poziomem
     * @param {AppError} error - Błąd do zalogowania
     * @param {string} context - Kontekst
     */
    logError(error: AppError, context: string): void {
        const logMessage = `[${error.type}] ${error.message}`;
        const logDetails = {
            context,
            timestamp: error.timestamp,
            details: error.details,
            stack: error.stack
        };
        switch (error.type) {
            case ErrorTypes.VALIDATION:
            case ErrorTypes.USER_INPUT:
                log.warn(logMessage, logDetails);
                break;
            case ErrorTypes.NETWORK:
                log.error(logMessage, logDetails);
                break;
            default:
                log.error(logMessage, logDetails);
        }
    }

    /**
     * Zapisuje błąd w historii
     * @param {AppError} error - Błąd do zapisania
     */
    recordError(error: AppError): void {
        this.errorHistory.push({
            timestamp: error.timestamp,
            type: error.type,
            message: error.message,
            context: error.details?.context
        });
        if (this.errorHistory.length > this.maxHistorySize) {
            this.errorHistory.shift();
        }
    }

    /**
     * Zwiększa licznik błędów dla danego typu
     * @param {ErrorType} errorType - Typ błędu
     */
    incrementErrorCount(errorType: ErrorType): void {
        const current = this.errorCounts.get(errorType) || 0;
        this.errorCounts.set(errorType, current + 1);
    }

    /**
     * Zwraca statystyki błędów
     * @returns {ErrorStats} Statystyki błędów
     */
    getErrorStats(): ErrorStats {
        const errorCountsObj: { [key: string]: number } = {};
        for (const [key, value] of this.errorCounts.entries()) {
            errorCountsObj[key] = value;
        }
        return {
            totalErrors: this.errorHistory.length,
            errorCounts: errorCountsObj,
            recentErrors: this.errorHistory.slice(-10),
            errorsByType: this.groupErrorsByType()
        };
    }

    /**
     * Grupuje błędy według typu
     * @returns {{ [key: string]: ErrorHistoryEntry[] }} Błędy pogrupowane według typu
     */
    groupErrorsByType(): { [key: string]: ErrorHistoryEntry[] } {
        const grouped: { [key: string]: ErrorHistoryEntry[] } = {};
        this.errorHistory.forEach((error) => {
            if (!grouped[error.type]) {
                grouped[error.type] = [];
            }
            grouped[error.type].push(error);
        });
        return grouped;
    }

    /**
     * Czyści historię błędów
     */
    clearHistory(): void {
        this.errorHistory = [];
        this.errorCounts.clear();
        log.info('Error history cleared');
    }
}

const errorHandler = new ErrorHandler();

/**
 * Wrapper funkcji z automatyczną obsługą błędów
 * @param {Function} fn - Funkcja do opakowania
 * @param {string} context - Kontekst wykonania
 * @returns {Function} Opakowana funkcja
 */
export function withErrorHandling<T extends (...args: any[]) => any>(
    fn: T, 
    context: string
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async function(this: any, ...args: Parameters<T>): Promise<ReturnType<T>> {
        try {
            return await fn.apply(this, args);
        } catch (error) {
            const handledError = errorHandler.handle(error as Error, context, {
                functionName: fn.name,
                arguments: args.length
            });
            throw handledError;
        }
    };
}

/**
 * Decorator dla metod klasy z automatyczną obsługą błędów
 * @param {string} context - Kontekst wykonania
 */
export function handleErrors(context: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            try {
                return await originalMethod.apply(this, args);
            } catch (error) {
                const handledError = errorHandler.handle(error as Error, `${context}.${propertyKey}`, {
                    className: target.constructor.name,
                    methodName: propertyKey,
                    arguments: args.length
                });
                throw handledError;
            }
        };

        return descriptor;
    };
}

/**
 * Funkcja pomocnicza do tworzenia błędów walidacji
 * @param {string} message - Wiadomość błędu
 * @param {object} details - Szczegóły walidacji
 * @returns {AppError} Błąd walidacji
 */
export function createValidationError(message: string, details: object = {}): AppError {
    return new AppError(message, ErrorTypes.VALIDATION, details);
}

/**
 * Funkcja pomocnicza do tworzenia błędów sieciowych
 * @param {string} message - Wiadomość błędu
 * @param {object} details - Szczegóły sieci
 * @returns {AppError} Błąd sieciowy
 */
export function createNetworkError(message: string, details: object = {}): AppError {
    return new AppError(message, ErrorTypes.NETWORK, details);
}

/**
 * Funkcja pomocnicza do tworzenia błędów plików
 * @param {string} message - Wiadomość błędu
 * @param {object} details - Szczegóły pliku
 * @returns {AppError} Błąd pliku
 */
export function createFileError(message: string, details: object = {}): AppError {
    return new AppError(message, ErrorTypes.FILE_IO, details);
}

/**
 * Funkcja pomocnicza do bezpiecznego wykonania operacji
 * @param {() => Promise<T>} operation - Operacja do wykonania
 * @param {T} fallbackValue - Wartość fallback w przypadku błędu
 * @param {string} context - Kontekst operacji
 * @returns {Promise<T>} Wynik operacji lub wartość fallback
 */
export async function safeExecute<T>(operation: () => Promise<T>, fallbackValue: T, context = 'SafeExecute'): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        errorHandler.handle(error as Error, context);
        return fallbackValue;
    }
}

/**
 * Funkcja do retry operacji z exponential backoff
 * @param {() => Promise<T>} operation - Operacja do powtórzenia
 * @param {number} maxRetries - Maksymalna liczba prób
 * @param {number} baseDelay - Podstawowe opóźnienie w ms
 * @param {string} context - Kontekst operacji
 * @returns {Promise<T>} Wynik operacji
 */
export async function retryWithBackoff<T>(operation: () => Promise<T>, maxRetries = 3, baseDelay = 1000, context = 'RetryOperation'): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;

            if (attempt === maxRetries) {
                break;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            log.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {error: lastError.message, context});
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw errorHandler.handle(lastError!, context, {attempts: maxRetries + 1});
}

export {errorHandler};
export default errorHandler;
