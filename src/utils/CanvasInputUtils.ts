import type { AddMode } from '../shared/types';

export function isFitOnAddEnabled(
    widgets?: readonly { name: string; value?: unknown }[]
): boolean {
    const fitOnAddWidget = widgets?.find(widget => widget.name === 'fit_on_add');
    return Boolean(fitOnAddWidget?.value);
}

export function getImageAddMode(
    widgets?: readonly { name: string; value?: unknown }[]
): Extract<AddMode, 'fit' | 'center'> {
    return isFitOnAddEnabled(widgets) ? 'fit' : 'center';
}
