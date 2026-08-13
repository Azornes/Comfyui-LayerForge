import { createModuleLogger } from "./log_system/log_funcs.js";
const log = createModuleLogger('ImageCache');
export class ImageCache {
    constructor() {
        this.cache = new Map();
    }
    set(key, image) {
        log.info("Caching image for key:", key);
        this.cache.set(key, image);
    }
    get(key) {
        const image = this.cache.get(key);
        log.debug("Retrieved cached image for key:", key, !!image);
        return image;
    }
    has(key) {
        return this.cache.has(key);
    }
    delete(key) {
        return this.cache.delete(key);
    }
    clear() {
        log.info("Clearing image cache");
        this.cache.clear();
    }
}
