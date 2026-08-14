export const LAYERFORGE_IMAGE_LINKS_PROPERTY = 'layerforge_input_image_links';
export const LAYERFORGE_MAX_IMAGE_INPUTS = 32;
export function getLayerForgeImageInputLinks(node) {
    const rawLinks = node?.properties?.[LAYERFORGE_IMAGE_LINKS_PROPERTY];
    if (!Array.isArray(rawLinks))
        return [];
    const links = [];
    const seen = new Set();
    for (const rawLink of rawLinks) {
        const sourceId = Number(rawLink?.source_id);
        const sourceSlot = Number(rawLink?.source_slot ?? 0);
        if (!Number.isFinite(sourceId) || !Number.isFinite(sourceSlot))
            continue;
        const normalizedSlot = Math.max(0, Math.trunc(sourceSlot));
        const key = `${sourceId}:${normalizedSlot}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        links.push({
            source_id: sourceId,
            source_slot: normalizedSlot,
            source_type: String(rawLink?.source_type || 'IMAGE'),
        });
        if (links.length >= LAYERFORGE_MAX_IMAGE_INPUTS)
            break;
    }
    return links;
}
export function setLayerForgeImageInputLinks(node, links) {
    node.properties || (node.properties = {});
    node.properties[LAYERFORGE_IMAGE_LINKS_PROPERTY] = links
        .slice(0, LAYERFORGE_MAX_IMAGE_INPUTS)
        .map(link => ({
        source_id: Number(link.source_id),
        source_slot: Math.max(0, Math.trunc(Number(link.source_slot) || 0)),
        source_type: String(link.source_type || 'IMAGE'),
    }));
}
export function addLayerForgeImageInputLink(node, link) {
    const links = getLayerForgeImageInputLinks(node);
    const sourceId = Number(link.source_id);
    const sourceSlot = Math.max(0, Math.trunc(Number(link.source_slot) || 0));
    if (!Number.isFinite(sourceId) || links.length >= LAYERFORGE_MAX_IMAGE_INPUTS)
        return false;
    if (links.some(existing => existing.source_id === sourceId && existing.source_slot === sourceSlot)) {
        return false;
    }
    links.push({
        source_id: sourceId,
        source_slot: sourceSlot,
        source_type: String(link.source_type || 'IMAGE'),
    });
    setLayerForgeImageInputLinks(node, links);
    return true;
}
export function removeLayerForgeImageInputLink(node, index) {
    const links = getLayerForgeImageInputLinks(node);
    if (!Number.isInteger(index) || index < 0 || index >= links.length)
        return false;
    links.splice(index, 1);
    setLayerForgeImageInputLinks(node, links);
    return true;
}
export function clearLayerForgeImageInputLinks(node) {
    const links = getLayerForgeImageInputLinks(node);
    if (links.length === 0)
        return 0;
    setLayerForgeImageInputLinks(node, []);
    return links.length;
}
export function getLayerForgeImageInputSlot(node) {
    return node?.inputs?.find((input) => input?.name === 'input_image')
        ?? node?.inputs?.[0]
        ?? null;
}
export function getLayerForgeMaskInputSlot(node) {
    return node?.inputs?.find((input) => input?.name === 'input_mask')
        ?? node?.inputs?.[1]
        ?? null;
}
export function hasLayerForgeImageInput(node) {
    return getLayerForgeImageInputLinks(node).length > 0
        || getLayerForgeImageInputSlot(node)?.link != null;
}
