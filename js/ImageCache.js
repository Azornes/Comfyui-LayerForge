import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu ImageCache
const log = {
    debug: (...args) => logger.debug('ImageCache', ...args),
    info: (...args) => logger.info('ImageCache', ...args),
    warn: (...args) => logger.warn('ImageCache', ...args),
    error: (...args) => logger.error('ImageCache', ...args)
};

// Konfiguracja loggera dla modułu ImageCache
logger.setModuleLevel('ImageCache', LogLevel.INFO);

export class ImageCache {
    constructor() {
        this.cache = new Map();
    }

    set(key, imageData) {
        log.info("Caching image data for key:", key);
        this.cache.set(key, imageData);
    }

    get(key) {
        const data = this.cache.get(key);
        log.debug("Retrieved cached data for key:", key, !!data);
        return data;
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        log.info("Clearing image cache");
        this.cache.clear();
    }
}