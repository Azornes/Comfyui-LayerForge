/**
 * UI-agnostic undo/redo storage for immutable snapshots.
 *
 * The stack owns its snapshots through the supplied clone function. This
 * keeps history independent from the mutable objects used by canvas and mask
 * adapters while leaving rendering and persistence to their callers.
 */
export class HistoryStack {
    constructor(options) {
        this.undoEntries = [];
        this.redoEntries = [];
        this.cloneSnapshot = options.clone;
        this.snapshotsEqual = options.equals;
        this.historyLimit = Math.max(1, Math.floor(options.historyLimit ?? 100));
    }
    get undoStack() {
        return this.undoEntries;
    }
    get redoStack() {
        return this.redoEntries;
    }
    push(value, replaceLast = false) {
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
    undo() {
        if (this.undoEntries.length <= 1)
            return null;
        const current = this.undoEntries.pop();
        if (current !== undefined) {
            this.redoEntries.push(current);
        }
        const previous = this.undoEntries[this.undoEntries.length - 1];
        return previous === undefined ? null : this.cloneSnapshot(previous);
    }
    redo() {
        const next = this.redoEntries.pop();
        if (next === undefined)
            return null;
        this.undoEntries.push(next);
        return this.cloneSnapshot(next);
    }
    clear() {
        this.undoEntries.length = 0;
        this.redoEntries.length = 0;
    }
    getHistoryInfo() {
        return {
            undoCount: this.undoEntries.length,
            redoCount: this.redoEntries.length,
            canUndo: this.undoEntries.length > 1,
            canRedo: this.redoEntries.length > 0,
            historyLimit: this.historyLimit,
        };
    }
}
