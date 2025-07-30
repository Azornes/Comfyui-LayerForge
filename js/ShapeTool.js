import { createModuleLogger } from "./utils/LoggerUtils.js";
const log = createModuleLogger('ShapeTool');
export class ShapeTool {
    constructor(canvas) {
        this.isActive = false;
        this.canvas = canvas;
        this.shape = {
            points: [],
            isClosed: false,
        };
    }
    toggle() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            log.info('ShapeTool activated. Press "S" to exit.');
            this.reset();
        }
        else {
            log.info('ShapeTool deactivated.');
            this.reset();
        }
        this.canvas.render();
    }
    activate() {
        if (!this.isActive) {
            this.isActive = true;
            log.info('ShapeTool activated. Hold Shift+S to draw.');
            this.reset();
            this.canvas.render();
        }
    }
    deactivate() {
        if (this.isActive) {
            this.isActive = false;
            log.info('ShapeTool deactivated.');
            this.reset();
            this.canvas.render();
        }
    }
    addPoint(point) {
        if (this.shape.isClosed) {
            this.reset();
        }
        // Check if the new point is close to the start point to close the shape
        if (this.shape.points.length > 2) {
            const firstPoint = this.shape.points[0];
            const dx = point.x - firstPoint.x;
            const dy = point.y - firstPoint.y;
            if (Math.sqrt(dx * dx + dy * dy) < 10 / this.canvas.viewport.zoom) {
                this.closeShape();
                return;
            }
        }
        this.shape.points.push(point);
        this.canvas.render();
    }
    closeShape() {
        if (this.shape.points.length > 2) {
            this.shape.isClosed = true;
            log.info('Shape closed with', this.shape.points.length, 'points.');
            this.canvas.defineOutputAreaWithShape(this.shape);
            this.reset();
        }
        this.canvas.render();
    }
    getBoundingBox() {
        if (this.shape.points.length === 0) {
            return null;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.shape.points.forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        });
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }
    reset() {
        this.shape = {
            points: [],
            isClosed: false,
        };
        log.info('ShapeTool reset.');
        this.canvas.render();
    }
    render(ctx) {
        if (this.shape.points.length === 0) {
            return;
        }
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
        ctx.lineWidth = 2 / this.canvas.viewport.zoom;
        ctx.setLineDash([8 / this.canvas.viewport.zoom, 4 / this.canvas.viewport.zoom]);
        ctx.beginPath();
        const startPoint = this.shape.points[0];
        ctx.moveTo(startPoint.x, startPoint.y);
        for (let i = 1; i < this.shape.points.length; i++) {
            ctx.lineTo(this.shape.points[i].x, this.shape.points[i].y);
        }
        if (this.shape.isClosed) {
            ctx.closePath();
            ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
            ctx.fill();
        }
        else if (this.isActive) {
            // Draw a line to the current mouse position
            ctx.lineTo(this.canvas.lastMousePosition.x, this.canvas.lastMousePosition.y);
        }
        ctx.stroke();
        // Draw vertices
        const mouse = this.canvas.lastMousePosition;
        const firstPoint = this.shape.points[0];
        let highlightFirst = false;
        if (!this.shape.isClosed && this.shape.points.length > 2 && mouse) {
            const dx = mouse.x - firstPoint.x;
            const dy = mouse.y - firstPoint.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 10 / this.canvas.viewport.zoom) {
                highlightFirst = true;
            }
        }
        this.shape.points.forEach((point, index) => {
            ctx.beginPath();
            if (index === 0 && highlightFirst) {
                ctx.arc(point.x, point.y, 8 / this.canvas.viewport.zoom, 0, 2 * Math.PI);
                ctx.fillStyle = 'yellow';
            }
            else {
                ctx.arc(point.x, point.y, 4 / this.canvas.viewport.zoom, 0, 2 * Math.PI);
                ctx.fillStyle = 'rgba(0, 255, 255, 1)';
            }
            ctx.fill();
        });
        ctx.restore();
    }
}
