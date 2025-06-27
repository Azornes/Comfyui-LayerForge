import {createModuleLogger} from "./utils/LoggerUtils.js";
const log = createModuleLogger('ImageCache');

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
