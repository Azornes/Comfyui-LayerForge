import {removeImage, getAllImageIds} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('ImageReferenceManager');

export class ImageReferenceManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.imageReferences = new Map(); // imageId -> count
        this.imageLastUsed = new Map();   // imageId -> timestamp
        this.gcInterval = 5 * 60 * 1000;  // 5 minut (nieużywane)
        this.maxAge = 30 * 60 * 1000;     // 30 minut bez użycia
        this.gcTimer = null;
        this.isGcRunning = false;
        
        // Nie uruchamiamy automatycznego GC
        // this.startGarbageCollection();
    }

    /**
     * Uruchamia automatyczne garbage collection
     */
    startGarbageCollection() {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
        }
        
        this.gcTimer = setInterval(() => {
            this.performGarbageCollection();
        }, this.gcInterval);
        
        log.info("Garbage collection started with interval:", this.gcInterval / 1000, "seconds");
    }

    /**
     * Zatrzymuje automatyczne garbage collection
     */
    stopGarbageCollection() {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }
        log.info("Garbage collection stopped");
    }

    /**
     * Dodaje referencję do obrazu
     * @param {string} imageId - ID obrazu
     */
    addReference(imageId) {
        if (!imageId) return;
        
        const currentCount = this.imageReferences.get(imageId) || 0;
        this.imageReferences.set(imageId, currentCount + 1);
        this.imageLastUsed.set(imageId, Date.now());
        
        log.debug(`Added reference to image ${imageId}, count: ${currentCount + 1}`);
    }

    /**
     * Usuwa referencję do obrazu
     * @param {string} imageId - ID obrazu
     */
    removeReference(imageId) {
        if (!imageId) return;
        
        const currentCount = this.imageReferences.get(imageId) || 0;
        if (currentCount <= 1) {
            this.imageReferences.delete(imageId);
            log.debug(`Removed last reference to image ${imageId}`);
        } else {
            this.imageReferences.set(imageId, currentCount - 1);
            log.debug(`Removed reference to image ${imageId}, count: ${currentCount - 1}`);
        }
    }

    /**
     * Aktualizuje referencje na podstawie aktualnego stanu canvas
     */
    updateReferences() {
        log.debug("Updating image references...");
        
        // Wyczyść stare referencje
        this.imageReferences.clear();
        
        // Zbierz wszystkie używane imageId
        const usedImageIds = this.collectAllUsedImageIds();
        
        // Dodaj referencje dla wszystkich używanych obrazów
        usedImageIds.forEach(imageId => {
            this.addReference(imageId);
        });
        
        log.info(`Updated references for ${usedImageIds.size} unique images`);
    }

    /**
     * Zbiera wszystkie używane imageId z różnych źródeł
     * @returns {Set<string>} Zbiór używanych imageId
     */
    collectAllUsedImageIds() {
        const usedImageIds = new Set();
        
        // 1. Aktualne warstwy
        this.canvas.layers.forEach(layer => {
            if (layer.imageId) {
                usedImageIds.add(layer.imageId);
            }
        });
        
        // 2. Historia undo
        if (this.canvas.canvasState && this.canvas.canvasState.layersUndoStack) {
            this.canvas.canvasState.layersUndoStack.forEach(layersState => {
                layersState.forEach(layer => {
                    if (layer.imageId) {
                        usedImageIds.add(layer.imageId);
                    }
                });
            });
        }
        
        // 3. Historia redo
        if (this.canvas.canvasState && this.canvas.canvasState.layersRedoStack) {
            this.canvas.canvasState.layersRedoStack.forEach(layersState => {
                layersState.forEach(layer => {
                    if (layer.imageId) {
                        usedImageIds.add(layer.imageId);
                    }
                });
            });
        }
        
        log.debug(`Collected ${usedImageIds.size} used image IDs`);
        return usedImageIds;
    }

    /**
     * Znajduje nieużywane obrazy
     * @param {Set<string>} usedImageIds - Zbiór używanych imageId
     * @returns {Array<string>} Lista nieużywanych imageId
     */
    async findUnusedImages(usedImageIds) {
        try {
            // Pobierz wszystkie imageId z bazy danych
            const allImageIds = await getAllImageIds();
            const unusedImages = [];
            const now = Date.now();
            
            for (const imageId of allImageIds) {
                // Sprawdź czy obraz nie jest używany
                if (!usedImageIds.has(imageId)) {
                    const lastUsed = this.imageLastUsed.get(imageId) || 0;
                    const age = now - lastUsed;
                    
                    // Usuń tylko stare obrazy (grace period)
                    if (age > this.maxAge) {
                        unusedImages.push(imageId);
                    } else {
                        log.debug(`Image ${imageId} is unused but too young (age: ${Math.round(age/1000)}s)`);
                    }
                }
            }
            
            log.debug(`Found ${unusedImages.length} unused images ready for cleanup`);
            return unusedImages;
        } catch (error) {
            log.error("Error finding unused images:", error);
            return [];
        }
    }

    /**
     * Czyści nieużywane obrazy
     * @param {Array<string>} unusedImages - Lista nieużywanych imageId
     */
    async cleanupUnusedImages(unusedImages) {
        if (unusedImages.length === 0) {
            log.debug("No unused images to cleanup");
            return;
        }
        
        log.info(`Starting cleanup of ${unusedImages.length} unused images`);
        let cleanedCount = 0;
        let errorCount = 0;
        
        for (const imageId of unusedImages) {
            try {
                // Usuń z bazy danych
                await removeImage(imageId);
                
                // Usuń z cache
                if (this.canvas.imageCache && this.canvas.imageCache.has(imageId)) {
                    this.canvas.imageCache.delete(imageId);
                }
                
                // Usuń z tracking
                this.imageReferences.delete(imageId);
                this.imageLastUsed.delete(imageId);
                
                cleanedCount++;
                log.debug(`Cleaned up image: ${imageId}`);
                
            } catch (error) {
                errorCount++;
                log.error(`Error cleaning up image ${imageId}:`, error);
            }
        }
        
        log.info(`Garbage collection completed: ${cleanedCount} images cleaned, ${errorCount} errors`);
    }

    /**
     * Wykonuje pełne garbage collection
     */
    async performGarbageCollection() {
        if (this.isGcRunning) {
            log.debug("Garbage collection already running, skipping");
            return;
        }
        
        this.isGcRunning = true;
        log.info("Starting garbage collection...");
        
        try {
            // 1. Aktualizuj referencje
            this.updateReferences();
            
            // 2. Zbierz wszystkie używane imageId
            const usedImageIds = this.collectAllUsedImageIds();
            
            // 3. Znajdź nieużywane obrazy
            const unusedImages = await this.findUnusedImages(usedImageIds);
            
            // 4. Wyczyść nieużywane obrazy
            await this.cleanupUnusedImages(unusedImages);
            
        } catch (error) {
            log.error("Error during garbage collection:", error);
        } finally {
            this.isGcRunning = false;
        }
    }

    /**
     * Ręczne uruchomienie garbage collection
     */
    async manualGarbageCollection() {
        log.info("Manual garbage collection triggered");
        await this.performGarbageCollection();
    }

    /**
     * Zwraca statystyki garbage collection
     * @returns {Object} Statystyki
     */
    getStats() {
        return {
            trackedImages: this.imageReferences.size,
            totalReferences: Array.from(this.imageReferences.values()).reduce((sum, count) => sum + count, 0),
            isRunning: this.isGcRunning,
            gcInterval: this.gcInterval,
            maxAge: this.maxAge
        };
    }

    /**
     * Czyści wszystkie dane (przy usuwaniu canvas)
     */
    destroy() {
        this.stopGarbageCollection();
        this.imageReferences.clear();
        this.imageLastUsed.clear();
        log.info("ImageReferenceManager destroyed");
    }
}
