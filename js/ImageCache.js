export class ImageCache {
    constructor() {
        this.cache = new Map();
    }

    set(key, imageData) {
        console.log("Caching image data for key:", key);
        this.cache.set(key, imageData);
    }

    get(key) {
        const data = this.cache.get(key);
        console.log("Retrieved cached data for key:", key, !!data);
        return data;
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        console.log("Clearing image cache");
        this.cache.clear();
    }
}