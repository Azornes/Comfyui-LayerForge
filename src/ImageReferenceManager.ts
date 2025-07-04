import {removeImage, getAllImageIds} from "./db.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import type { Canvas } from './Canvas';
import type { Layer, CanvasState } from './types';

const log = createModuleLogger('ImageReferenceManager');

interface GarbageCollectionStats {
    trackedImages: number;
    totalReferences: number;
    isRunning: boolean;
    gcInterval: number;
    maxAge: number;
}

export class ImageReferenceManager {
    private canvas: Canvas & { canvasState: CanvasState };
    private gcInterval: number;
    private gcTimer: number | null;
    private imageLastUsed: Map<string, number>;
    private imageReferences: Map<string, number>;
    private isGcRunning: boolean;
    private maxAge: number;
    public operationCount: number;
    public operationThreshold: number;

    constructor(canvas: Canvas & { canvasState: CanvasState }) {
        this.canvas = canvas;
        this.imageReferences = new Map(); // imageId -> count
        this.imageLastUsed = new Map();   // imageId -> timestamp
        this.gcInterval = 5 * 60 * 1000;  // 5 minut (nieużywane)
        this.maxAge = 30 * 60 * 1000;     // 30 minut bez użycia
        this.gcTimer = null;
        this.isGcRunning = false;
        this.operationCount = 0;
        this.operationThreshold = 500;   // Uruchom GC po 500 operacjach
    }

    /**
     * Uruchamia automatyczne garbage collection
     */
    startGarbageCollection(): void {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
        }

        this.gcTimer = window.setInterval(() => {
            this.performGarbageCollection();
        }, this.gcInterval);

        log.info("Garbage collection started with interval:", this.gcInterval / 1000, "seconds");
    }

    /**
     * Zatrzymuje automatyczne garbage collection
     */
    stopGarbageCollection(): void {
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
    addReference(imageId: string): void {
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
    removeReference(imageId: string): void {
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
    updateReferences(): void {
        log.debug("Updating image references...");
        this.imageReferences.clear();
        const usedImageIds = this.collectAllUsedImageIds();
        usedImageIds.forEach(imageId => {
            this.addReference(imageId);
        });

        log.info(`Updated references for ${usedImageIds.size} unique images`);
    }

    /**
     * Zbiera wszystkie używane imageId z różnych źródeł
     * @returns {Set<string>} Zbiór używanych imageId
     */
    collectAllUsedImageIds(): Set<string> {
        const usedImageIds = new Set<string>();
        this.canvas.layers.forEach((layer: Layer) => {
            if (layer.imageId) {
                usedImageIds.add(layer.imageId);
            }
        });
        if (this.canvas.canvasState && this.canvas.canvasState.layersUndoStack) {
            this.canvas.canvasState.layersUndoStack.forEach((layersState: Layer[]) => {
                layersState.forEach((layer: Layer) => {
                    if (layer.imageId) {
                        usedImageIds.add(layer.imageId);
                    }
                });
            });
        }

        if (this.canvas.canvasState && this.canvas.canvasState.layersRedoStack) {
            this.canvas.canvasState.layersRedoStack.forEach((layersState: Layer[]) => {
                layersState.forEach((layer: Layer) => {
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
     * @returns {Promise<string[]>} Lista nieużywanych imageId
     */
    async findUnusedImages(usedImageIds: Set<string>): Promise<string[]> {
        try {
            const allImageIds = await getAllImageIds();
            const unusedImages: string[] = [];
            const now = Date.now();

            for (const imageId of allImageIds) {
                if (!usedImageIds.has(imageId)) {
                    const lastUsed = this.imageLastUsed.get(imageId) || 0;
                    const age = now - lastUsed;

                    if (age > this.maxAge) {
                        unusedImages.push(imageId);
                    } else {
                        log.debug(`Image ${imageId} is unused but too young (age: ${Math.round(age / 1000)}s)`);
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
     * @param {string[]} unusedImages - Lista nieużywanych imageId
     */
    async cleanupUnusedImages(unusedImages: string[]): Promise<void> {
        if (unusedImages.length === 0) {
            log.debug("No unused images to cleanup");
            return;
        }

        log.info(`Starting cleanup of ${unusedImages.length} unused images`);
        let cleanedCount = 0;
        let errorCount = 0;

        for (const imageId of unusedImages) {
            try {

                await removeImage(imageId);

                if (this.canvas.imageCache && this.canvas.imageCache.has(imageId)) {
                    this.canvas.imageCache.delete(imageId);
                }

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
    async performGarbageCollection(): Promise<void> {
        if (this.isGcRunning) {
            log.debug("Garbage collection already running, skipping");
            return;
        }

        this.isGcRunning = true;
        log.info("Starting garbage collection...");

        try {

            this.updateReferences();

            const usedImageIds = this.collectAllUsedImageIds();

            const unusedImages = await this.findUnusedImages(usedImageIds);

            await this.cleanupUnusedImages(unusedImages);

        } catch (error) {
            log.error("Error during garbage collection:", error);
        } finally {
            this.isGcRunning = false;
        }
    }

    /**
     * Zwiększa licznik operacji i sprawdza czy uruchomić GC
     */
    incrementOperationCount(): void {
        this.operationCount++;
        log.debug(`Operation count: ${this.operationCount}/${this.operationThreshold}`);

        if (this.operationCount >= this.operationThreshold) {
            log.info(`Operation threshold reached (${this.operationThreshold}), triggering garbage collection`);
            this.operationCount = 0; // Reset counter

            setTimeout(() => {
                this.performGarbageCollection();
            }, 100);
        }
    }

    /**
     * Resetuje licznik operacji
     */
    resetOperationCount(): void {
        this.operationCount = 0;
        log.debug("Operation count reset");
    }

    /**
     * Ustawia próg operacji dla automatycznego GC
     * @param {number} threshold - Nowy próg operacji
     */
    setOperationThreshold(threshold: number): void {
        this.operationThreshold = Math.max(1, threshold);
        log.info(`Operation threshold set to: ${this.operationThreshold}`);
    }

    /**
     * Ręczne uruchomienie garbage collection
     */
    async manualGarbageCollection(): Promise<void> {
        log.info("Manual garbage collection triggered");
        await this.performGarbageCollection();
    }

    /**
     * Zwraca statystyki garbage collection
     * @returns {GarbageCollectionStats} Statystyki
     */
    getStats(): GarbageCollectionStats {
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
    destroy(): void {
        this.stopGarbageCollection();
        this.imageReferences.clear();
        this.imageLastUsed.clear();
        log.info("ImageReferenceManager destroyed");
    }
}
