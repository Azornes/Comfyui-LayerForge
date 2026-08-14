const TOOLTIP_SELECTOR = '[data-tooltip], [title]';
const TOOLTIP_BOUND_ATTRIBUTE = 'lfTooltipBound';
/**
 * Owns the single LayerForge tooltip and binds tooltip metadata added to
 * registered UI roots. Native `title` attributes are normalized to
 * `data-tooltip` so the browser cannot display a second tooltip alongside it.
 */
export class TooltipManager {
    constructor() {
        this.tooltipElement = null;
        this.tooltipTarget = null;
        this.observedRoots = new Map();
        this.viewportFrame = null;
        this.viewportListenersAttached = false;
        this.handleViewportChange = () => {
            if (!this.tooltipTarget || !this.tooltipElement)
                return;
            if (this.viewportFrame !== null || typeof window === 'undefined')
                return;
            this.viewportFrame = window.requestAnimationFrame(() => {
                this.viewportFrame = null;
                if (this.tooltipTarget) {
                    this.positionTooltip(this.tooltipTarget);
                }
            });
        };
    }
    observeRoot(root) {
        this.ensureTooltipElement();
        this.bindTooltips(root);
        if (!this.observedRoots.has(root) && typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes') {
                        const target = mutation.target;
                        if (target instanceof HTMLElement) {
                            this.bindTooltips(target);
                        }
                        continue;
                    }
                    for (const node of mutation.addedNodes) {
                        if (node instanceof HTMLElement) {
                            this.bindTooltips(node);
                        }
                    }
                }
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['title', 'data-tooltip'],
            });
            this.observedRoots.set(root, observer);
        }
        return () => this.unobserveRoot(root);
    }
    unobserveRoot(root) {
        this.observedRoots.get(root)?.disconnect();
        this.observedRoots.delete(root);
        this.hideTooltip(root);
    }
    bindTooltips(container) {
        const targets = [];
        if (container.matches?.(TOOLTIP_SELECTOR)) {
            targets.push(container);
        }
        container.querySelectorAll(TOOLTIP_SELECTOR).forEach((target) => {
            targets.push(target);
        });
        targets.forEach((target) => {
            this.normalizeTooltipTarget(target);
            if (target.dataset[TOOLTIP_BOUND_ATTRIBUTE] === '1')
                return;
            target.dataset[TOOLTIP_BOUND_ATTRIBUTE] = '1';
            target.addEventListener('mouseenter', () => this.showTooltip(target));
            target.addEventListener('focus', () => this.showTooltip(target));
            target.addEventListener('mouseleave', () => this.hideTooltip(target));
            target.addEventListener('blur', () => this.hideTooltip(target));
        });
    }
    normalizeTooltipTarget(target) {
        const title = target.getAttribute('title');
        if (title !== null && !target.hasAttribute('data-tooltip')) {
            target.setAttribute('data-tooltip', title);
        }
        if (target.hasAttribute('title')) {
            target.removeAttribute('title');
        }
    }
    setTooltip(target, text, options = {}) {
        if (!target)
            return;
        if (text) {
            target.setAttribute('data-tooltip', text);
        }
        else {
            target.removeAttribute('data-tooltip');
        }
        if (options.html) {
            target.setAttribute('data-tooltip-html', 'true');
        }
        else {
            target.removeAttribute('data-tooltip-html');
        }
        target.removeAttribute('title');
        this.bindTooltips(target);
    }
    removeTooltip(target) {
        target.removeAttribute('data-tooltip');
        target.removeAttribute('data-tooltip-html');
        target.removeAttribute('title');
        this.hideTooltip(target);
    }
    showTooltip(target, contentOverride, options = {}) {
        if (!target || !this.ensureTooltipElement())
            return;
        if ('isConnected' in target && !target.isConnected)
            return;
        this.normalizeTooltipTarget(target);
        const content = contentOverride !== undefined
            ? contentOverride
            : target.getAttribute('data-tooltip');
        if (!content)
            return;
        const tooltip = this.tooltipElement;
        if (!tooltip)
            return;
        this.tooltipTarget = target;
        tooltip.replaceChildren();
        if (options.html || target.getAttribute('data-tooltip-html') === 'true') {
            tooltip.innerHTML = content;
        }
        else {
            tooltip.textContent = content;
        }
        tooltip.style.display = 'block';
        tooltip.setAttribute('data-visible', 'true');
        tooltip.setAttribute('aria-hidden', 'false');
        this.positionTooltip(target);
    }
    isVisibleFor(target) {
        return this.tooltipTarget === target && this.tooltipElement?.style.display === 'block';
    }
    hideTooltip(scope) {
        if (scope && this.tooltipTarget && scope !== this.tooltipTarget && !scope.contains(this.tooltipTarget)) {
            return;
        }
        this.tooltipTarget = null;
        if (!this.tooltipElement)
            return;
        this.tooltipElement.style.display = 'none';
        this.tooltipElement.replaceChildren();
        this.tooltipElement.removeAttribute('data-visible');
        this.tooltipElement.setAttribute('aria-hidden', 'true');
    }
    destroy() {
        this.observedRoots.forEach((observer) => observer.disconnect());
        this.observedRoots.clear();
        this.hideTooltip();
        if (this.viewportFrame !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(this.viewportFrame);
            this.viewportFrame = null;
        }
        if (this.viewportListenersAttached && typeof window !== 'undefined') {
            window.removeEventListener('resize', this.handleViewportChange);
            window.removeEventListener('scroll', this.handleViewportChange, true);
            this.viewportListenersAttached = false;
        }
        this.tooltipElement?.remove();
        this.tooltipElement = null;
    }
    ensureTooltipElement() {
        if (typeof document === 'undefined' || !document.body)
            return null;
        if (this.tooltipElement?.isConnected)
            return this.tooltipElement;
        const existing = document.getElementById('lf-global-tooltip');
        this.tooltipElement = existing instanceof HTMLDivElement
            ? existing
            : document.createElement('div');
        this.tooltipElement.id = 'lf-global-tooltip';
        this.tooltipElement.className = 'lf-global-tooltip';
        this.tooltipElement.setAttribute('role', 'tooltip');
        this.tooltipElement.setAttribute('aria-hidden', 'true');
        if (!this.tooltipElement.isConnected) {
            document.body.appendChild(this.tooltipElement);
        }
        if (!this.viewportListenersAttached && typeof window !== 'undefined') {
            window.addEventListener('resize', this.handleViewportChange);
            window.addEventListener('scroll', this.handleViewportChange, true);
            this.viewportListenersAttached = true;
        }
        return this.tooltipElement;
    }
    positionTooltip(target) {
        if (!this.tooltipElement || this.tooltipTarget !== target)
            return;
        const rect = target.getBoundingClientRect();
        const tooltipRect = this.tooltipElement.getBoundingClientRect();
        const margin = 12;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const maxLeft = Math.max(margin, viewportWidth - tooltipRect.width - margin);
        const maxTop = Math.max(margin, viewportHeight - tooltipRect.height - margin);
        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        left = Math.min(Math.max(margin, left), maxLeft);
        let top = rect.top - tooltipRect.height - 10;
        if (top < margin) {
            top = Math.min(maxTop, rect.bottom + 10);
        }
        top = Math.min(Math.max(margin, top), maxTop);
        this.tooltipElement.style.left = `${Math.round(left)}px`;
        this.tooltipElement.style.top = `${Math.round(top)}px`;
    }
}
export const tooltipManager = new TooltipManager();
