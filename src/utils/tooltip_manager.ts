export interface TooltipOptions {
    html?: boolean;
    interactive?: boolean;
    persistent?: boolean;
    onDismiss?: () => void;
}

const TOOLTIP_SELECTOR = '[data-tooltip], [title]';
const TOOLTIP_BOUND_ATTRIBUTE = 'lfTooltipBound';

/**
 * Owns the single LayerForge tooltip and binds tooltip metadata added to
 * registered UI roots. Native `title` attributes are normalized to
 * `data-tooltip` so the browser cannot display a second tooltip alongside it.
 */
export class TooltipManager {
    private tooltipElement: HTMLDivElement | null = null;
    private tooltipTarget: HTMLElement | null = null;
    private readonly observedRoots = new Map<HTMLElement, MutationObserver>();
    private viewportFrame: number | null = null;
    private hideTimer: number | null = null;
    private tooltipDismissCallback: (() => void) | null = null;
    private viewportListenersAttached = false;
    private tooltipInteractionListenersAttached = false;
    private documentListenersAttached = false;

    observeRoot(root: HTMLElement): () => void {
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

    unobserveRoot(root: HTMLElement): void {
        this.observedRoots.get(root)?.disconnect();
        this.observedRoots.delete(root);
        this.hideTooltip(root);
    }

    bindTooltips(container: HTMLElement): void {
        const targets: HTMLElement[] = [];

        if (container.matches?.(TOOLTIP_SELECTOR)) {
            targets.push(container);
        }
        container.querySelectorAll<HTMLElement>(TOOLTIP_SELECTOR).forEach((target) => {
            targets.push(target);
        });

        targets.forEach((target) => {
            this.normalizeTooltipTarget(target);
            if (target.dataset[TOOLTIP_BOUND_ATTRIBUTE] === '1') return;

            target.dataset[TOOLTIP_BOUND_ATTRIBUTE] = '1';
            target.addEventListener('mouseenter', () => {
                this.cancelScheduledHide();
                this.showTooltip(target);
            });
            target.addEventListener('focus', () => this.showTooltip(target));
            target.addEventListener('mouseleave', () => this.handleTargetLeave(target));
            target.addEventListener('blur', () => this.handleTargetLeave(target));
        });
    }

    private handleTargetLeave(target: HTMLElement): void {
        if (
            this.tooltipTarget === target
            && this.tooltipElement?.getAttribute('data-persistent') === 'true'
        ) {
            return;
        }

        if (
            this.tooltipTarget === target
            && this.tooltipElement?.getAttribute('data-interactive') === 'true'
        ) {
            this.scheduleHide(target);
            return;
        }

        this.hideTooltip(target);
    }

    scheduleHideTooltip(scope?: HTMLElement): void {
        this.scheduleHide(scope);
    }

    private scheduleHide(scope?: HTMLElement): void {
        this.cancelScheduledHide();

        if (typeof window === 'undefined') {
            this.hideTooltip(scope);
            return;
        }

        this.hideTimer = window.setTimeout(() => {
            this.hideTimer = null;
            this.hideTooltip(scope);
        }, 120);
    }

    private cancelScheduledHide(): void {
        if (this.hideTimer === null) return;

        if (typeof window !== 'undefined') {
            window.clearTimeout(this.hideTimer);
        }
        this.hideTimer = null;
    }

    normalizeTooltipTarget(target: HTMLElement): void {
        const title = target.getAttribute('title');
        if (title !== null && !target.hasAttribute('data-tooltip')) {
            target.setAttribute('data-tooltip', title);
        }
        if (target.hasAttribute('title')) {
            target.removeAttribute('title');
        }
    }

    setTooltip(target: HTMLElement, text: string, options: TooltipOptions = {}): void {
        if (!target) return;

        if (text) {
            target.setAttribute('data-tooltip', text);
        } else {
            target.removeAttribute('data-tooltip');
        }

        if (options.html) {
            target.setAttribute('data-tooltip-html', 'true');
        } else {
            target.removeAttribute('data-tooltip-html');
        }

        target.removeAttribute('title');
        this.bindTooltips(target);
    }

    removeTooltip(target: HTMLElement): void {
        target.removeAttribute('data-tooltip');
        target.removeAttribute('data-tooltip-html');
        target.removeAttribute('title');
        this.hideTooltip(target);
    }

    showTooltip(target: HTMLElement, contentOverride?: string, options: TooltipOptions = {}): void {
        this.cancelScheduledHide();
        if (!target || !this.ensureTooltipElement()) return;
        if ('isConnected' in target && !target.isConnected) return;

        if (this.tooltipTarget && this.tooltipTarget !== target) {
            this.hideTooltip();
        }

        this.normalizeTooltipTarget(target);
        const content = contentOverride !== undefined
            ? contentOverride
            : target.getAttribute('data-tooltip');
        if (!content) return;

        const tooltip = this.tooltipElement;
        if (!tooltip) return;

        this.tooltipTarget = target;
        tooltip.replaceChildren();
        const renderAsHtml = options.html || target.getAttribute('data-tooltip-html') === 'true';
        const isInteractive = renderAsHtml && options.interactive !== false;
        tooltip.setAttribute('data-content-mode', renderAsHtml ? 'html' : 'text');
        if (isInteractive) {
            tooltip.setAttribute('data-interactive', 'true');
        } else {
            tooltip.removeAttribute('data-interactive');
        }
        if (options.persistent) {
            tooltip.setAttribute('data-persistent', 'true');
        } else {
            tooltip.removeAttribute('data-persistent');
        }
        this.tooltipDismissCallback = options.onDismiss ?? null;
        if (renderAsHtml) {
            tooltip.innerHTML = content;
        } else {
            tooltip.textContent = content;
        }

        tooltip.style.display = 'block';
        tooltip.setAttribute('data-visible', 'true');
        tooltip.setAttribute('aria-hidden', 'false');
        this.positionTooltip(target);
    }

    isVisibleFor(target: HTMLElement): boolean {
        return this.tooltipTarget === target && this.tooltipElement?.style.display === 'block';
    }

    hideTooltip(scope?: HTMLElement): void {
        if (scope && this.tooltipTarget && scope !== this.tooltipTarget && !scope.contains(this.tooltipTarget)) {
            return;
        }

        this.cancelScheduledHide();
        this.tooltipTarget = null;
        const dismissCallback = this.tooltipDismissCallback;
        this.tooltipDismissCallback = null;
        if (!this.tooltipElement) {
            dismissCallback?.();
            return;
        }

        this.tooltipElement.style.display = 'none';
        this.tooltipElement.style.maxHeight = '';
        this.tooltipElement.replaceChildren();
        this.tooltipElement.removeAttribute('data-visible');
        this.tooltipElement.removeAttribute('data-content-mode');
        this.tooltipElement.removeAttribute('data-interactive');
        this.tooltipElement.removeAttribute('data-persistent');
        this.tooltipElement.setAttribute('aria-hidden', 'true');
        dismissCallback?.();
    }

    destroy(): void {
        this.observedRoots.forEach((observer) => observer.disconnect());
        this.observedRoots.clear();
        this.hideTooltip();

        if (this.tooltipInteractionListenersAttached && this.tooltipElement) {
            this.tooltipElement.removeEventListener('mouseenter', this.handleTooltipMouseEnter);
            this.tooltipElement.removeEventListener('mouseleave', this.handleTooltipMouseLeave);
            this.tooltipInteractionListenersAttached = false;
        }

        if (this.viewportFrame !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(this.viewportFrame);
            this.viewportFrame = null;
        }

        if (this.viewportListenersAttached && typeof window !== 'undefined') {
            window.removeEventListener('resize', this.handleViewportChange);
            window.removeEventListener('scroll', this.handleViewportChange, true);
            this.viewportListenersAttached = false;
        }

        if (this.documentListenersAttached && typeof document !== 'undefined') {
            document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
            document.removeEventListener('keydown', this.handleDocumentKeyDown, true);
            this.documentListenersAttached = false;
        }

        this.tooltipElement?.remove();
        this.tooltipElement = null;
    }

    private ensureTooltipElement(): HTMLDivElement | null {
        if (typeof document === 'undefined' || !document.body) return null;
        if (this.tooltipElement?.isConnected) return this.tooltipElement;

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

        if (!this.tooltipInteractionListenersAttached) {
            this.tooltipElement.addEventListener('mouseenter', this.handleTooltipMouseEnter);
            this.tooltipElement.addEventListener('mouseleave', this.handleTooltipMouseLeave);
            this.tooltipInteractionListenersAttached = true;
        }

        if (!this.documentListenersAttached) {
            document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
            document.addEventListener('keydown', this.handleDocumentKeyDown, true);
            this.documentListenersAttached = true;
        }

        if (!this.viewportListenersAttached && typeof window !== 'undefined') {
            window.addEventListener('resize', this.handleViewportChange);
            window.addEventListener('scroll', this.handleViewportChange, true);
            this.viewportListenersAttached = true;
        }

        return this.tooltipElement;
    }

    private readonly handleTooltipMouseEnter = (): void => {
        this.cancelScheduledHide();
    };

    private readonly handleTooltipMouseLeave = (): void => {
        if (this.tooltipElement?.getAttribute('data-persistent') === 'true') return;
        this.scheduleHide();
    };

    private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
        if (
            !this.tooltipTarget
            || this.tooltipElement?.getAttribute('data-persistent') !== 'true'
        ) {
            return;
        }

        const eventTarget = event.target;
        if (
            eventTarget instanceof Node
            && (this.tooltipTarget.contains(eventTarget) || this.tooltipElement?.contains(eventTarget))
        ) {
            return;
        }

        this.hideTooltip();
    };

    private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
        if (
            event.key !== 'Escape'
            || !this.tooltipTarget
            || this.tooltipElement?.getAttribute('data-persistent') !== 'true'
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.hideTooltip();
    };

    private readonly handleViewportChange = (): void => {
        if (!this.tooltipTarget || !this.tooltipElement) return;
        if (this.viewportFrame !== null || typeof window === 'undefined') return;

        this.viewportFrame = window.requestAnimationFrame(() => {
            this.viewportFrame = null;
            if (this.tooltipTarget) {
                this.positionTooltip(this.tooltipTarget);
            }
        });
    };

    private positionTooltip(target: HTMLElement): void {
        if (!this.tooltipElement || this.tooltipTarget !== target) return;

        const rect = target.getBoundingClientRect();
        this.tooltipElement.style.maxHeight = '';
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
