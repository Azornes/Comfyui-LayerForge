import {createModuleLogger} from "./utils/LoggerUtils.js";
import type { ImageDataPixel } from './types';

const log = createModuleLogger('ImageCache');

export class ImageCache {
    private cache: Map<string, ImageDataPixel>;

    constructor() {
        this.cache = new Map();
    }

    set(key: string, imageData: ImageDataPixel): void {
        log.info("Caching image data for key:", key);
        this.cache.set(key, imageData);
    }

    get(key: string): ImageDataPixel | undefined {
        const data = this.cache.get(key);
        log.debug("Retrieved cached data for key:", key, !!data);
        return data;
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    clear(): void {
        log.info("Clearing image cache");
        this.cache.clear();
    }
}
