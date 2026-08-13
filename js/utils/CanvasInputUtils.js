export function isFitOnAddEnabled(widgets) {
    const fitOnAddWidget = widgets?.find(widget => widget.name === 'fit_on_add');
    return Boolean(fitOnAddWidget?.value);
}
export function getImageAddMode(widgets) {
    return isFitOnAddEnabled(widgets) ? 'fit' : 'center';
}
