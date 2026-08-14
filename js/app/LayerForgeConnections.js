// Graph integration for virtual image links and multi-image prompt transport.
// @ts-ignore
import { app } from "../../../scripts/app.js";
import { addLayerForgeImageInputLink, getLayerForgeImageInputLinks, getLayerForgeImageInputSlot, LAYERFORGE_MAX_IMAGE_INPUTS, removeLayerForgeImageInputLink, } from "../utils/MultiImageInputUtils.js";
export const canvasNodeInstances = new Map();
let layerForgeQuickCreateMenu = null;
let layerForgeQuickCreateCanvas = null;
let layerForgeQuickCreateCleanup = null;
let layerForgeQuickCreatePending = false;
let layerForgeQuickCreateToken = 0;
let layerForgeLastCapturedDropAt = 0;
let layerForgeSuppressNativeDropUntil = 0;
export const isLayerForgeTransportInput = (name) => /^input_image_\d+$/i.test(String(name || ""));
const getLayerForgeGraphLink = (node, linkId) => {
    const graph = node?.graph || app.graph;
    if (!graph || linkId == null)
        return null;
    for (const links of [graph.links, graph._links]) {
        if (!links)
            continue;
        if (typeof links.get === 'function') {
            const link = links.get(linkId) ?? links.get(String(linkId));
            if (link)
                return link;
        }
        const link = links[linkId] ?? links[String(linkId)];
        if (link)
            return link;
    }
    return null;
};
const getLayerForgeSlotIndex = (slots, rawSlot) => {
    if (!Array.isArray(slots))
        return -1;
    if (typeof rawSlot === 'number')
        return slots[rawSlot] ? rawSlot : -1;
    for (const key of ['slot_index', 'slot', 'index']) {
        const value = rawSlot?.[key];
        if (typeof value === 'number' && slots[value])
            return value;
    }
    if (rawSlot) {
        const directIndex = slots.indexOf(rawSlot);
        if (directIndex >= 0)
            return directIndex;
        const name = typeof rawSlot === 'string' ? rawSlot : rawSlot?.name;
        if (name)
            return slots.findIndex(slot => slot?.name === name);
    }
    return -1;
};
const getLayerForgePendingConnectorLink = (canvas) => {
    const renderLinks = canvas?.linkConnector?.renderLinks;
    const link = renderLinks?.[0] || renderLinks?.at?.(0);
    if (!link)
        return null;
    const endpointNode = link.node
        || link.fromNode
        || link.originNode
        || link.sourceNode
        || link.toNode
        || link.targetNode
        || link.inputNode
        || link.outputNode;
    const endpointSlot = link.fromSlot ?? link.slot ?? link.output ?? link.input ?? link.toSlot ?? {};
    if (!endpointNode)
        return null;
    const inputIndex = getLayerForgeSlotIndex(endpointNode.inputs, endpointSlot);
    const outputIndex = getLayerForgeSlotIndex(endpointNode.outputs, endpointSlot);
    const toType = String(link.toType || link.targetType || link.targetSlotType || '').toLowerCase();
    let direction = toType.includes('output') ? 'from_input' : 'from_output';
    if (inputIndex >= 0 && outputIndex < 0)
        direction = 'from_input';
    if (outputIndex >= 0 && inputIndex < 0)
        direction = 'from_output';
    if (direction === 'from_input') {
        const input = endpointNode.inputs?.[inputIndex] || endpointSlot;
        const inputName = String(input?.name || '');
        if (endpointNode?.comfyClass !== 'LayerForgeNode'
            && endpointNode?.type !== 'LayerForgeNode')
            return null;
        if (inputName !== 'input_image' && !isLayerForgeTransportInput(inputName))
            return null;
        return {
            direction,
            targetNode: endpointNode,
            targetSlot: inputIndex,
        };
    }
    const output = endpointNode.outputs?.[outputIndex] || endpointSlot || {};
    return {
        direction,
        sourceNode: endpointNode,
        sourceSlot: Math.max(0, outputIndex),
        sourceType: String(output?.type || output?.datatype || output?.name || 'IMAGE'),
    };
};
const getLayerForgePointerGraphPosition = (canvas, event) => {
    if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) {
        return [event.canvasX, event.canvasY];
    }
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
        return [
            (event.clientX - rect.left) / scale - offset[0],
            (event.clientY - rect.top) / scale - offset[1],
        ];
    }
    return [0, 0];
};
const getLayerForgeConnectionPosition = (node, isInput, slotIndex) => {
    const normalize = (point) => {
        if (!point || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))
            return null;
        return [Number(point[0]), Number(point[1])];
    };
    const modernPosition = normalize(isInput
        ? node?.getInputPos?.(slotIndex)
        : node?.getOutputPos?.(slotIndex));
    if (modernPosition)
        return modernPosition;
    try {
        if (typeof node?.getConnectionPos === 'function') {
            const output = [0, 0];
            const legacyPosition = normalize(node.getConnectionPos(isInput, slotIndex, output)) || normalize(output);
            if (legacyPosition)
                return legacyPosition;
        }
    }
    catch {
        // Fall through to stable LiteGraph geometry for older frontend builds.
    }
    const position = node?.pos || [0, 0];
    const size = node?.size || [160, 0];
    const slotY = Number(position[1] || 0) + 40 + Math.max(0, slotIndex) * 20;
    return [
        Number(position[0] || 0) + (isInput ? 0 : Number(size[0] || 160)),
        slotY,
    ];
};
const getLayerForgeVirtualLinkGeometry = (targetNode, link) => {
    const graph = targetNode?.graph || app.graph;
    const sourceNode = graph?.getNodeById?.(Number(link?.source_id));
    if (!sourceNode)
        return null;
    const inputSlot = getLayerForgeImageInputSlot(targetNode);
    const inputIndex = Math.max(0, targetNode?.inputs?.indexOf(inputSlot) ?? 0);
    const source = getLayerForgeConnectionPosition(sourceNode, false, Number(link?.source_slot) || 0);
    const target = getLayerForgeConnectionPosition(targetNode, true, inputIndex);
    if (!source || !target)
        return null;
    const midpoint = [
        (source[0] + target[0]) / 2,
        (source[1] + target[1]) / 2,
    ];
    return { source, target, midpoint, sourceNode };
};
const getLayerForgeVirtualLinkColor = (link) => {
    const colors = globalThis.LGraphCanvas?.link_type_colors || {};
    const rawType = String(link?.source_type || 'IMAGE');
    for (const candidate of [rawType, rawType.toUpperCase(), rawType.toLowerCase()]) {
        if (colors[candidate])
            return colors[candidate];
    }
    return '#5aa9f0';
};
const drawLayerForgeVirtualLinks = (canvas, context) => {
    const graph = canvas?.graph || app.graph;
    if (!graph?._nodes || canvas.links_render_mode === globalThis.LiteGraph?.HIDDEN_LINK)
        return;
    for (const targetNode of graph._nodes) {
        if (targetNode?.comfyClass !== 'LayerForgeNode' && targetNode?.type !== 'LayerForgeNode')
            continue;
        const links = getLayerForgeImageInputLinks(targetNode);
        links.forEach((link, index) => {
            const geometry = getLayerForgeVirtualLinkGeometry(targetNode, link);
            if (!geometry)
                return;
            const highlighted = Boolean(targetNode.selected || geometry.sourceNode.selected);
            const color = highlighted ? '#ffffff' : getLayerForgeVirtualLinkColor(link);
            const width = Number(canvas.connections_width) || 3;
            const controlOffset = 80;
            context.save();
            context.lineJoin = 'round';
            context.shadowBlur = 0;
            context.shadowColor = 'transparent';
            context.beginPath();
            context.moveTo(geometry.source[0], geometry.source[1]);
            context.bezierCurveTo(geometry.source[0] + controlOffset, geometry.source[1], geometry.target[0] - controlOffset, geometry.target[1], geometry.target[0], geometry.target[1]);
            context.lineWidth = width + 4;
            context.strokeStyle = canvas.render_connections_border !== false && !canvas.low_quality
                ? 'rgba(0, 0, 0, 0.5)'
                : 'transparent';
            if (context.strokeStyle !== 'transparent')
                context.stroke();
            context.beginPath();
            context.moveTo(geometry.source[0], geometry.source[1]);
            context.bezierCurveTo(geometry.source[0] + controlOffset, geometry.source[1], geometry.target[0] - controlOffset, geometry.target[1], geometry.target[0], geometry.target[1]);
            context.lineWidth = width;
            context.strokeStyle = color;
            context.stroke();
            if (canvas.linkMarkerShape !== 0 && (canvas.ds?.scale ?? 1) >= 0.6 && canvas.highquality_render !== false) {
                context.beginPath();
                context.arc(geometry.midpoint[0], geometry.midpoint[1], 5, 0, Math.PI * 2);
                context.fillStyle = color;
                context.fill();
                context.fillStyle = highlighted ? '#222' : '#fff';
                context.font = 'bold 7px sans-serif';
                context.textAlign = 'center';
                context.textBaseline = 'middle';
                context.fillText(String(index + 1), geometry.midpoint[0], geometry.midpoint[1] + 0.3);
            }
            context.restore();
        });
    }
};
const getLayerForgeGraphPosition = (canvas, event) => {
    try {
        canvas?.adjustMouseEvent?.(event);
    }
    catch {
        // Older LiteGraph builds may not expose adjustMouseEvent.
    }
    if (Array.isArray(canvas?.graph_mouse))
        return [canvas.graph_mouse[0], canvas.graph_mouse[1]];
    if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) {
        return [event.canvasX, event.canvasY];
    }
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
        return [
            (event.clientX - rect.left) / scale - offset[0],
            (event.clientY - rect.top) / scale - offset[1],
        ];
    }
    return [0, 0];
};
const hitTestLayerForgeVirtualLinks = (graph, x, y) => {
    let best = null;
    for (const targetNode of graph?._nodes || []) {
        if (targetNode?.comfyClass !== 'LayerForgeNode' && targetNode?.type !== 'LayerForgeNode')
            continue;
        getLayerForgeImageInputLinks(targetNode).forEach((link, index) => {
            const geometry = getLayerForgeVirtualLinkGeometry(targetNode, link);
            if (!geometry)
                return;
            const distance = Math.hypot(x - geometry.midpoint[0], y - geometry.midpoint[1]);
            if (distance <= 18 && (!best || distance < best.distance)) {
                best = {
                    targetNode,
                    index,
                    point: geometry.midpoint,
                    distance,
                };
            }
        });
    }
    return best;
};
const getLayerForgeClientPosition = (canvas, point) => {
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    if (!rect)
        return null;
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    return {
        x: rect.left + (point[0] + offset[0]) * scale,
        y: rect.top + (point[1] + offset[1]) * scale,
    };
};
const openLayerForgeVirtualLinkMenu = (canvas, hit, event) => {
    const ContextMenu = globalThis.LiteGraph?.ContextMenu;
    if (typeof ContextMenu !== 'function')
        return;
    const clientPoint = getLayerForgeClientPosition(canvas, hit.point);
    const clientX = Number.isFinite(event?.clientX) ? event.clientX : clientPoint?.x || 0;
    const clientY = Number.isFinite(event?.clientY) ? event.clientY : clientPoint?.y || 0;
    const PointerEventConstructor = globalThis.PointerEvent;
    const MouseEventConstructor = globalThis.MouseEvent;
    let menuEvent;
    try {
        const EventConstructor = PointerEventConstructor || MouseEventConstructor;
        menuEvent = EventConstructor
            ? new EventConstructor('pointerdown', {
                clientX,
                clientY,
                bubbles: true,
                cancelable: true,
            })
            : { clientX, clientY };
    }
    catch {
        menuEvent = { clientX, clientY };
    }
    let menuInstance = null;
    const closeMenu = () => {
        menuInstance?.close?.();
        menuInstance?.remove?.();
    };
    menuInstance = new ContextMenu([
        {
            content: 'Remove connection',
            callback: () => {
                if (removeLayerForgeImageInputLink(hit.targetNode, hit.index)) {
                    hit.targetNode.setDirtyCanvas?.(true, true);
                    canvas?.setDirty?.(true, true);
                    canvas?.graph?.setDirtyCanvas?.(true, true);
                    app.graph?.change?.();
                }
                closeMenu();
            },
        },
    ], { event: menuEvent });
};
const clearLayerForgeTemporaryConnector = (canvas) => {
    const connector = canvas?.linkConnector;
    connector?.reset?.();
    if (Array.isArray(connector?.renderLinks))
        connector.renderLinks.length = 0;
    canvas?.setDirty?.(true, true);
    (canvas?.graph || app.graph)?.setDirtyCanvas?.(true, true);
};
const createLayerForgeLoadImageNode = (canvas, targetNode, position) => {
    const graph = canvas?.graph || app.graph;
    const LiteGraph = globalThis.LiteGraph;
    if (!graph || typeof LiteGraph?.createNode !== 'function' || !targetNode)
        return false;
    if (getLayerForgeImageInputLinks(targetNode).length >= LAYERFORGE_MAX_IMAGE_INPUTS)
        return false;
    const node = LiteGraph.createNode('LoadImage');
    if (!node)
        return false;
    node.pos = [position[0], position[1]];
    graph.add(node);
    const imageOutputIndex = Math.max(0, node.outputs?.findIndex((output) => {
        const type = String(output?.type || output?.datatype || output?.name || '').toUpperCase();
        return type.includes('IMAGE');
    }) ?? 0);
    const outputPosition = getLayerForgeConnectionPosition(node, false, imageOutputIndex);
    if (outputPosition) {
        node.pos = [
            Number(node.pos?.[0] || 0) + position[0] - outputPosition[0],
            Number(node.pos?.[1] || 0) + position[1] - outputPosition[1],
        ];
    }
    const output = node.outputs?.[imageOutputIndex];
    addLayerForgeImageInputLink(targetNode, {
        source_id: Number(node.id),
        source_slot: imageOutputIndex,
        source_type: String(output?.type || 'IMAGE'),
    });
    node.setDirtyCanvas?.(true, true);
    targetNode.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
    return true;
};
const getLayerForgeQuickCreateMenuEvent = (detail) => {
    const clientX = Number(detail?.clientX) || 0;
    const clientY = Number(detail?.clientY) || 0;
    const PointerEventConstructor = globalThis.PointerEvent;
    const MouseEventConstructor = globalThis.MouseEvent;
    try {
        const EventConstructor = PointerEventConstructor || MouseEventConstructor;
        return EventConstructor
            ? new EventConstructor('pointerdown', {
                clientX,
                clientY,
                bubbles: true,
                cancelable: true,
            })
            : { clientX, clientY };
    }
    catch {
        return { clientX, clientY };
    }
};
const closeLayerForgeNativeNodeSearchSoon = () => {
    const documentObject = globalThis.document;
    if (!documentObject)
        return;
    const close = () => {
        const container = documentObject.querySelector?.('.node-search-box-dialog-mask, .invisible-dialog-root, .comfy-vue-node-search-container');
        const input = container?.querySelector?.('input')
            || documentObject.querySelector?.('input[id^="comfy-vue-node-search-box-input-"]');
        if (!container && !input)
            return;
        const KeyboardEventConstructor = globalThis.KeyboardEvent;
        if (typeof KeyboardEventConstructor !== 'function')
            return;
        const init = {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
        };
        input?.dispatchEvent?.(new KeyboardEventConstructor('keydown', init));
        container?.dispatchEvent?.(new KeyboardEventConstructor('keydown', init));
        documentObject.dispatchEvent?.(new KeyboardEventConstructor('keydown', init));
    };
    for (const delay of [0, 16, 50, 120])
        setTimeout(close, delay);
};
const openLayerForgeQuickCreateMenu = (canvas, targetNode, detail) => {
    const ContextMenu = globalThis.LiteGraph?.ContextMenu;
    if (typeof ContextMenu !== 'function' || !targetNode)
        return;
    layerForgeQuickCreateMenu?.close?.();
    layerForgeQuickCreateMenu?.remove?.();
    layerForgeQuickCreateMenu = null;
    const position = [
        Number(detail?.canvasX) || 0,
        Number(detail?.canvasY) || 0,
    ];
    const finish = () => {
        clearLayerForgeTemporaryConnector(canvas);
        layerForgeQuickCreatePending = false;
        layerForgeQuickCreateMenu?.close?.();
        layerForgeQuickCreateMenu?.remove?.();
        layerForgeQuickCreateMenu = null;
    };
    const menuInstance = new ContextMenu([
        {
            content: 'Load image',
            callback: () => {
                createLayerForgeLoadImageNode(canvas, targetNode, position);
                finish();
            },
        },
    ], { event: getLayerForgeQuickCreateMenuEvent(detail) });
    layerForgeQuickCreateMenu = menuInstance;
    menuInstance.controller?.signal?.addEventListener?.('abort', () => {
        if (layerForgeQuickCreateMenu !== menuInstance)
            return;
        clearLayerForgeTemporaryConnector(canvas);
        layerForgeQuickCreatePending = false;
        layerForgeQuickCreateMenu = null;
    }, { once: true });
};
const getLayerForgeTargetInputState = (pending) => {
    const targetNode = pending?.targetNode;
    const input = getLayerForgeImageInputSlot(targetNode);
    return {
        inputLinkId: input?.link ?? null,
        virtualLinkCount: getLayerForgeImageInputLinks(targetNode).length,
    };
};
const scheduleLayerForgeQuickCreateMenu = (canvas, event, pending) => {
    if (pending?.direction !== 'from_input' || !pending.targetNode)
        return false;
    const token = ++layerForgeQuickCreateToken;
    const [canvasX, canvasY] = getLayerForgePointerGraphPosition(canvas, event);
    const detail = {
        clientX: event?.clientX,
        clientY: event?.clientY,
        canvasX,
        canvasY,
        originalEvent: event,
    };
    const linkSnapshot = { ...pending };
    const before = getLayerForgeTargetInputState(linkSnapshot);
    const graph = canvas?.graph || app.graph;
    const beforeGraphVersion = Number(graph?._version) || 0;
    const releaseConnectorHold = holdLayerForgeConnectorReset(canvas);
    layerForgeQuickCreatePending = true;
    layerForgeSuppressNativeDropUntil = performance.now() + 1000;
    closeLayerForgeNativeNodeSearchSoon();
    const checkConnected = () => {
        if (token !== layerForgeQuickCreateToken)
            return true;
        const current = getLayerForgeTargetInputState(linkSnapshot);
        const graphVersion = Number(graph?._version) || 0;
        return current.inputLinkId != null
            || current.virtualLinkCount > before.virtualLinkCount
            || graphVersion > beforeGraphVersion;
    };
    const openIfStillEmpty = () => {
        if (token !== layerForgeQuickCreateToken) {
            releaseConnectorHold?.();
            return;
        }
        if (checkConnected()) {
            releaseConnectorHold?.();
            layerForgeQuickCreatePending = false;
            clearLayerForgeTemporaryConnector(canvas);
            return;
        }
        releaseConnectorHold?.();
        layerForgeQuickCreatePending = false;
        openLayerForgeQuickCreateMenu(canvas, linkSnapshot.targetNode, detail);
    };
    setTimeout(openIfStillEmpty, 70);
    return true;
};
const holdLayerForgeConnectorReset = (canvas) => {
    const events = canvas?.linkConnector?.events;
    if (!events)
        return null;
    const preventReset = (event) => event?.preventDefault?.();
    events.addEventListener?.('reset', preventReset, { once: true });
    return () => events.removeEventListener?.('reset', preventReset, { once: true });
};
const hasLayerForgePendingConnection = (canvas) => Boolean(canvas?.connecting_node
    || canvas?.connectingNode
    || canvas?.connecting_input
    || canvas?.connectingInput
    || canvas?.linkConnector?.renderLinks?.length);
const shouldSuppressLayerForgeNativeDrop = (type) => (type === 'dropped-on-canvas'
    && Boolean(layerForgeQuickCreateMenu || layerForgeQuickCreatePending)
    && performance.now() < layerForgeSuppressNativeDropUntil);
const primeLayerForgeInputDropSuppression = (canvas) => {
    const pending = getLayerForgePendingConnectorLink(canvas);
    if (pending?.direction !== 'from_input')
        return false;
    layerForgeQuickCreatePending = true;
    layerForgeSuppressNativeDropUntil = performance.now() + 1000;
    return true;
};
const installLayerForgeQuickCreateCapture = (canvas) => {
    const events = canvas?.linkConnector?.events;
    if (!canvas?.canvas || !events)
        return false;
    if (canvas === layerForgeQuickCreateCanvas && canvas.__layerForgeQuickCreateInstalled)
        return true;
    layerForgeQuickCreateCleanup?.();
    layerForgeQuickCreateCleanup = null;
    layerForgeQuickCreateCanvas = canvas;
    canvas.__layerForgeQuickCreateInstalled = true;
    const handler = (event) => {
        if (layerForgeQuickCreateMenu
            || event?.target?.closest?.('.litecontextmenu'))
            return;
        if (event?.button > 0 || performance.now() - layerForgeLastCapturedDropAt < 80)
            return;
        const pending = getLayerForgePendingConnectorLink(canvas);
        if (!pending)
            return;
        const [x, y] = getLayerForgePointerGraphPosition(canvas, event);
        if (pending.direction === 'from_output') {
            const target = (canvas.graph?._nodes || []).find((node) => {
                if (node?.comfyClass !== 'LayerForgeNode' && node?.type !== 'LayerForgeNode')
                    return false;
                const inputSlot = getLayerForgeImageInputSlot(node);
                const inputIndex = Math.max(0, node.inputs?.indexOf(inputSlot) ?? 0);
                const dot = getLayerForgeConnectionPosition(node, true, inputIndex);
                return dot && Math.hypot(x - dot[0], y - dot[1]) <= 18;
            });
            if (!target || !pending.sourceNode || target === pending.sourceNode)
                return;
            const added = addLayerForgeImageInputLink(target, {
                source_id: Number(pending.sourceNode.id),
                source_slot: Number(pending.sourceSlot) || 0,
                source_type: pending.sourceType || 'IMAGE',
            });
            if (!added)
                return;
            layerForgeLastCapturedDropAt = performance.now();
            event.preventDefault?.();
            event.stopPropagation?.();
            event.stopImmediatePropagation?.();
            clearLayerForgeTemporaryConnector(canvas);
            return;
        }
        if (scheduleLayerForgeQuickCreateMenu(canvas, event, pending)) {
            layerForgeLastCapturedDropAt = performance.now();
            closeLayerForgeNativeNodeSearchSoon();
            event.preventDefault?.();
            event.stopPropagation?.();
            event.stopImmediatePropagation?.();
        }
    };
    const pointerTargets = [
        globalThis.window,
        globalThis.document,
        canvas.canvas,
    ];
    for (const target of pointerTargets) {
        target?.addEventListener?.('pointerup', handler, true);
        target?.addEventListener?.('mouseup', handler, true);
    }
    const originalDispatch = typeof events.dispatch === 'function' ? events.dispatch : null;
    const originalDispatchEvent = typeof events.dispatchEvent === 'function' ? events.dispatchEvent : null;
    let wrappedDispatch = null;
    let wrappedDispatchEvent = null;
    if (originalDispatch) {
        wrappedDispatch = function dispatchWithLayerForgeDropGuard(type, detail) {
            if (type === 'before-drop-links')
                primeLayerForgeInputDropSuppression(canvas);
            if (shouldSuppressLayerForgeNativeDrop(type))
                return false;
            return originalDispatch.call(events, type, detail);
        };
        events.dispatch = wrappedDispatch;
    }
    if (originalDispatchEvent) {
        wrappedDispatchEvent = function dispatchEventWithLayerForgeDropGuard(event) {
            if (event?.type === 'before-drop-links')
                primeLayerForgeInputDropSuppression(canvas);
            if (shouldSuppressLayerForgeNativeDrop(event?.type)) {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                return false;
            }
            return originalDispatchEvent.call(events, event);
        };
        events.dispatchEvent = wrappedDispatchEvent;
    }
    const beforeDropLinksHandler = () => {
        primeLayerForgeInputDropSuppression(canvas);
    };
    const droppedOnCanvasHandler = (event) => {
        if (shouldSuppressLayerForgeNativeDrop(event?.type)) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            event?.stopImmediatePropagation?.();
        }
    };
    events.addEventListener?.('before-drop-links', beforeDropLinksHandler, { capture: true });
    events.addEventListener?.('dropped-on-canvas', droppedOnCanvasHandler, { capture: true });
    layerForgeQuickCreateCleanup = () => {
        for (const target of pointerTargets) {
            target?.removeEventListener?.('pointerup', handler, true);
            target?.removeEventListener?.('mouseup', handler, true);
        }
        events.removeEventListener?.('before-drop-links', beforeDropLinksHandler, { capture: true });
        events.removeEventListener?.('dropped-on-canvas', droppedOnCanvasHandler, { capture: true });
        if (wrappedDispatch && events.dispatch === wrappedDispatch)
            events.dispatch = originalDispatch;
        if (wrappedDispatchEvent && events.dispatchEvent === wrappedDispatchEvent) {
            events.dispatchEvent = originalDispatchEvent;
        }
        canvas.__layerForgeQuickCreateInstalled = false;
        if (layerForgeQuickCreateCanvas === canvas)
            layerForgeQuickCreateCanvas = null;
        layerForgeQuickCreatePending = false;
    };
    return true;
};
export const installLayerForgeVirtualWirePatch = () => {
    const canvas = app.canvas;
    if (!canvas)
        return;
    installLayerForgeQuickCreateCapture(canvas);
    if (canvas.__layerForgeVirtualWirePatched || typeof canvas.drawConnections !== 'function')
        return;
    const originalDrawConnections = canvas.drawConnections;
    canvas.__layerForgeVirtualWirePatched = true;
    canvas.drawConnections = function drawConnectionsWithLayerForgeLinks(context) {
        const result = originalDrawConnections.apply(this, arguments);
        const connectionContext = context || this.bgctx || this.ctx;
        const onConnectionLayer = connectionContext?.canvas === this?.bgcanvas
            || connectionContext === this?.bgctx
            || !this?.bgcanvas;
        if (connectionContext && onConnectionLayer) {
            drawLayerForgeVirtualLinks(this, connectionContext);
        }
        return result;
    };
    const originalProcessMouseDown = canvas.processMouseDown;
    canvas.processMouseDown = function processMouseDownWithLayerForgeLinks(event) {
        if (!hasLayerForgePendingConnection(this)) {
            const [x, y] = getLayerForgeGraphPosition(this, event);
            const hit = hitTestLayerForgeVirtualLinks(this.graph || app.graph, x, y);
            if (hit) {
                openLayerForgeVirtualLinkMenu(this, hit, event);
                event?.preventDefault?.();
                event?.stopImmediatePropagation?.();
                return true;
            }
        }
        return originalProcessMouseDown?.apply(this, arguments);
    };
    const linkPointerHandler = (event) => {
        if (hasLayerForgePendingConnection(canvas))
            return;
        const [x, y] = getLayerForgeGraphPosition(canvas, event);
        const hit = hitTestLayerForgeVirtualLinks(canvas.graph || app.graph, x, y);
        if (!hit)
            return;
        openLayerForgeVirtualLinkMenu(canvas, hit, event);
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
    };
    canvas.canvas?.addEventListener?.('pointerdown', linkPointerHandler, true);
};
const convertLayerForgeImageConnection = (node, inputIndex, linkInfo = null) => {
    if (!node || node.__layerForgeVirtualWireClearing)
        return false;
    const input = node.inputs?.[inputIndex];
    if (!input || (String(input.name || '') !== 'input_image' && !isLayerForgeTransportInput(input.name))) {
        return false;
    }
    const graph = node.graph || app.graph;
    const linkId = input.link ?? linkInfo?.id ?? linkInfo?.link_id ?? linkInfo?.linkId;
    const nativeLink = getLayerForgeGraphLink(node, linkId) || linkInfo;
    if (!nativeLink)
        return false;
    const sourceId = Number(nativeLink.origin_id ?? nativeLink.originId ?? nativeLink.from_id ?? nativeLink.fromId);
    const sourceSlot = Number(nativeLink.origin_slot ?? nativeLink.originSlot ?? nativeLink.from_slot ?? nativeLink.fromSlot ?? 0);
    if (!Number.isFinite(sourceId) || !Number.isFinite(sourceSlot) || sourceId === Number(node.id))
        return false;
    const sourceNode = graph?.getNodeById?.(sourceId);
    const sourceType = sourceNode?.outputs?.[sourceSlot]?.type
        || nativeLink.type
        || 'IMAGE';
    addLayerForgeImageInputLink(node, {
        source_id: sourceId,
        source_slot: sourceSlot,
        source_type: String(sourceType),
    });
    node.__layerForgeVirtualWireClearing = true;
    try {
        if (input.link != null && typeof node.disconnectInput === 'function') {
            node.disconnectInput(inputIndex);
        }
        else if (linkId != null && typeof graph?.removeLink === 'function') {
            graph.removeLink(linkId);
        }
        if (node.inputs?.[inputIndex])
            node.inputs[inputIndex].link = null;
    }
    finally {
        node.__layerForgeVirtualWireClearing = false;
    }
    node.setDirtyCanvas?.(true, true);
    graph?.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
    return true;
};
export const scheduleLayerForgeImageConnectionConversion = (node, inputIndex, linkInfo = null) => {
    setTimeout(() => convertLayerForgeImageConnection(node, inputIndex, linkInfo), 0);
    if (!linkInfo)
        setTimeout(() => convertLayerForgeImageConnection(node, inputIndex), 50);
};
export const pruneLayerForgeTransportInputs = (node) => {
    if (!Array.isArray(node?.inputs))
        return;
    for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
        const input = node.inputs[index];
        if (!isLayerForgeTransportInput(input?.name))
            continue;
        if (input.link != null)
            convertLayerForgeImageConnection(node, index);
        if (input.link != null)
            continue;
        if (typeof node.removeInput === 'function')
            node.removeInput(index);
        else
            node.inputs.splice(index, 1);
    }
};
export const installLayerForgeMultiImagePromptPatch = () => {
    const appWithPrompt = app;
    const originalGraphToPrompt = appWithPrompt.graphToPrompt;
    if (typeof originalGraphToPrompt !== 'function' || originalGraphToPrompt.__layerForgeMultiImagePatched)
        return;
    const graphToPrompt = async function (...args) {
        const promptData = await originalGraphToPrompt.apply(this, args);
        const output = promptData?.output;
        if (!output)
            return promptData;
        for (const node of app.graph?._nodes || []) {
            if (node?.comfyClass !== 'LayerForgeNode' && node?.type !== 'LayerForgeNode')
                continue;
            const promptNode = output[String(node.id)];
            if (!promptNode)
                continue;
            promptNode.inputs || (promptNode.inputs = {});
            for (let index = 1; index <= LAYERFORGE_MAX_IMAGE_INPUTS; index += 1) {
                delete promptNode.inputs[`input_image_${index}`];
            }
            const links = getLayerForgeImageInputLinks(node)
                .filter(link => output[String(link.source_id)]);
            if (links.length === 0)
                continue;
            delete promptNode.inputs.input_image;
            links.forEach((link, index) => {
                promptNode.inputs[`input_image_${index + 1}`] = [String(link.source_id), link.source_slot];
            });
        }
        return promptData;
    };
    graphToPrompt.__layerForgeMultiImagePatched = true;
    appWithPrompt.graphToPrompt = graphToPrompt;
};
