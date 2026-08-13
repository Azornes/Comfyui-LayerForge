import {createModuleLogger} from "./log_system/log_funcs.js";
import type { CachedImage, ImageCacheContract } from './types';

const log = createModuleLogger('ImageCache');

export class ImageCache implements ImageCacheContract {
    private cache: Map<string, CachedImage>;

    constructor() {
        this.cache = new Map();
    }

    set(key: string, image: CachedImage): void {
        log.info("Caching image for key:", key);
        this.cache.set(key, image);
    }

    get(key: string): CachedImage | undefined {
        const image = this.cache.get(key);
        log.debug("Retrieved cached image for key:", key, !!image);
        return image;
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    delete(key: string): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        log.info("Clearing image cache");
        this.cache.clear();
    }
}
