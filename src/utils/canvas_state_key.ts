import {generateUUID} from "./common_utils.js";

const WORKFLOW_ID_PROPERTY = "__layerForgeWorkflowId";
const WORKFLOW_EXTRA_ID = "layerforgeWorkflowId";

function getRootGraph(node: any): any | null {
    const graph = node?.graph;
    return graph?.rootGraph ?? graph ?? null;
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string" && typeof value !== "number") {
        return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Gets the identity of the workflow containing a LayerForge node.
 *
 * Current ComfyUI versions expose this as rootGraph.id. The extra fallback
 * keeps the state isolated on older versions and persists a generated ID in
 * the workflow data when the graph supports an `extra` object.
 */
export function getWorkflowIdentity(node: any): string {
    const rootGraph = getRootGraph(node);
    if (!rootGraph) {
        const nodeIdentity = asNonEmptyString(node?.[WORKFLOW_ID_PROPERTY]);
        if (nodeIdentity) {
            return nodeIdentity;
        }

        const generatedNodeIdentity = `session-${generateUUID()}`;
        if (node && typeof node === "object") {
            node[WORKFLOW_ID_PROPERTY] = generatedNodeIdentity;
        }
        return generatedNodeIdentity;
    }

    const graphId = asNonEmptyString(rootGraph.id);
    if (graphId) {
        return graphId;
    }

    const extraId = asNonEmptyString(rootGraph.extra?.[WORKFLOW_EXTRA_ID]);
    if (extraId) {
        rootGraph[WORKFLOW_ID_PROPERTY] = extraId;
        return extraId;
    }

    const generatedId = asNonEmptyString(rootGraph[WORKFLOW_ID_PROPERTY]) ?? generateUUID();
    rootGraph[WORKFLOW_ID_PROPERTY] = generatedId;

    if (!rootGraph.extra || typeof rootGraph.extra !== "object") {
        rootGraph.extra = {};
    }
    if (!asNonEmptyString(rootGraph.extra[WORKFLOW_EXTRA_ID])) {
        rootGraph.extra[WORKFLOW_EXTRA_ID] = generatedId;
    }

    return generatedId;
}

/**
 * Returns the IndexedDB key for one node in one workflow.
 * Node IDs are only unique inside a workflow, so they must never be used
 * alone as a persistent LayerForge state key.
 */
export function getCanvasStateKey(node: any): string {
    const nodeId = asNonEmptyString(node?.id);
    if (!nodeId) {
        throw new Error("Cannot create a LayerForge state key without a node ID.");
    }

    return `layerforge:workflow:${getWorkflowIdentity(node)}:node:${nodeId}`;
}
