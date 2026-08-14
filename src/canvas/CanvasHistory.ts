export interface HistoryInfo {
    undoCount: number;
    redoCount: number;
    canUndo: boolean;
    canRedo: boolean;
    historyLimit: number;
}

export interface HistoryStackOptions<T> {
    clone: (value: T) => T;
    equals?: (left: T, right: T) => boolean;
    historyLimit?: number;
}

/**
 * UI-agnostic undo/redo storage for immutable snapshots.
 *
 * The stack owns its snapshots through the supplied clone function. This
 * keeps history independent from the mutable objects used by canvas and mask
 * adapters while leaving rendering and persistence to their callers.
 */
export class HistoryStack<T> {
    private readonly cloneSnapshot: (value: T) => T;
    private readonly snapshotsEqual: ((left: T, right: T) => boolean) | undefined;
    private readonly historyLimit: number;
    private readonly undoEntries: T[] = [];
    private readonly redoEntries: T[] = [];

    constructor(options: HistoryStackOptions<T>) {
        this.cloneSnapshot = options.clone;
        this.snapshotsEqual = options.equals;
        this.historyLimit = Math.max(1, Math.floor(options.historyLimit ?? 100));
    }

    get undoStack(): T[] {
        return this.undoEntries;
    }

    get redoStack(): T[] {
        return this.redoEntries;
    }

    push(value: T, replaceLast = false): boolean {
        if (replaceLast && this.undoEntries.length > 0) {
            this.undoEntries.pop();
        }

        const snapshot = this.cloneSnapshot(value);
        const previous = this.undoEntries[this.undoEntries.length - 1];
        if (previous !== undefined && this.snapshotsEqual?.(previous, snapshot)) {
            return false;
        }

        this.undoEntries.push(snapshot);
        if (this.undoEntries.length > this.historyLimit) {
            this.undoEntries.shift();
        }
        this.redoEntries.length = 0;
        return true;
    }

    undo(): T | null {
        if (this.undoEntries.length <= 1) return null;

        const current = this.undoEntries.pop();
        if (current !== undefined) {
            this.redoEntries.push(current);
        }

        const previous = this.undoEntries[this.undoEntries.length - 1];
        return previous === undefined ? null : this.cloneSnapshot(previous);
    }

    redo(): T | null {
        const next = this.redoEntries.pop();
        if (next === undefined) return null;

        this.undoEntries.push(next);
        return this.cloneSnapshot(next);
    }

    clear(): void {
        this.undoEntries.length = 0;
        this.redoEntries.length = 0;
    }

    getHistoryInfo(): HistoryInfo {
        return {
            undoCount: this.undoEntries.length,
            redoCount: this.redoEntries.length,
            canUndo: this.undoEntries.length > 1,
            canRedo: this.redoEntries.length > 0,
            historyLimit: this.historyLimit,
        };
    }
}
