// @ts-ignore
import { api } from "../../../scripts/api.js";
// @ts-ignore
import { app } from "../../../scripts/app.js";
const PROGRESS_ROOT_ID = "lf-workflow-progress";
const API_QUEUE_PATCH_KEY = "__layerForgeWorkflowProgressPatch";
const COMPLETION_HIDE_DELAY_MS = 900;
const ERROR_HIDE_DELAY_MS = 2200;
const asDetail = (event) => {
    const detail = event.detail;
    return detail && typeof detail === "object" ? detail : {};
};
const asIdentifier = (value) => {
    if (value === null || value === undefined) {
        return null;
    }
    const identifier = String(value).trim();
    return identifier.length > 0 ? identifier : null;
};
const asFiniteNumber = (value) => {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
};
const clampPercent = (value) => Math.min(100, Math.max(0, value));
const getPromptFromArguments = (args) => {
    for (const argument of args) {
        if (!argument || typeof argument !== "object") {
            continue;
        }
        const output = argument.output;
        if (output && typeof output === "object" && !Array.isArray(output)) {
            return { output: output };
        }
    }
    return null;
};
/**
 * Displays ComfyUI execution progress without touching the LayerForge render loop.
 * The service listens to the same websocket events used by ComfyUI's own UI.
 */
export class WorkflowProgressController {
    constructor() {
        this.root = null;
        this.completedFill = null;
        this.activeFill = null;
        this.labelElement = null;
        this.promptInfos = new Map();
        this.currentPromptId = null;
        this.currentPromptInfo = null;
        this.completedNodeIds = new Set();
        this.totalNodes = 0;
        this.currentNodeId = null;
        this.currentNodeLabel = "";
        this.currentStep = null;
        this.maxSteps = null;
        this.queueRemaining = null;
        this.state = "idle";
        this.statusText = "Idle";
        this.hideTimer = null;
        this.apiQueuePatch = null;
        this.listenersAttached = false;
        this.fullscreenActive = false;
        this.handleStatus = (event) => {
            const detail = asDetail(event);
            const queueRemaining = asFiniteNumber(detail.exec_info?.queue_remaining);
            if (queueRemaining === null) {
                return;
            }
            this.queueRemaining = Math.max(0, Math.floor(queueRemaining));
            if (this.state === "idle" && this.queueRemaining > 0) {
                this.state = "queued";
                this.statusText = "Workflow queued";
                this.show();
            }
            this.render();
        };
        this.handleExecutionStart = (event) => {
            const detail = asDetail(event);
            this.cancelHide();
            this.currentPromptId = asIdentifier(detail.prompt_id);
            this.currentPromptInfo = this.currentPromptId
                ? this.promptInfos.get(this.currentPromptId) || null
                : null;
            this.completedNodeIds.clear();
            this.totalNodes = this.currentPromptInfo?.totalNodes || this.getFallbackNodeCount();
            this.currentNodeId = null;
            this.currentNodeLabel = "";
            this.currentStep = null;
            this.maxSteps = null;
            this.state = "running";
            this.statusText = "Workflow running";
            this.show();
            this.render();
        };
        this.handleExecutionCached = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            if (Array.isArray(detail.nodes)) {
                detail.nodes.forEach((nodeId) => {
                    const identifier = asIdentifier(nodeId);
                    if (identifier) {
                        this.completedNodeIds.add(identifier);
                    }
                });
            }
            this.render();
        };
        this.handleExecuting = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            const nodeId = asIdentifier(detail.node);
            if (!nodeId) {
                if (this.currentNodeId) {
                    this.completedNodeIds.add(this.currentNodeId);
                }
                this.currentNodeId = null;
                this.currentNodeLabel = "";
                this.currentStep = null;
                this.maxSteps = null;
                this.render();
                return;
            }
            if (this.currentNodeId && this.currentNodeId !== nodeId) {
                this.completedNodeIds.add(this.currentNodeId);
            }
            this.currentNodeId = nodeId;
            this.currentNodeLabel = this.getNodeLabel(nodeId, detail.display_node);
            this.currentStep = null;
            this.maxSteps = null;
            this.state = "running";
            this.show();
            this.render();
        };
        this.handleProgress = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            const nodeId = asIdentifier(detail.node);
            if (nodeId && nodeId !== this.currentNodeId) {
                if (this.currentNodeId) {
                    this.completedNodeIds.add(this.currentNodeId);
                }
                this.currentNodeId = nodeId;
                this.currentNodeLabel = this.getNodeLabel(nodeId);
            }
            const value = asFiniteNumber(detail.value);
            const max = asFiniteNumber(detail.max);
            this.currentStep = value === null ? null : Math.max(0, value);
            this.maxSteps = max === null ? null : Math.max(0, max);
            this.state = "running";
            this.show();
            this.render();
        };
        this.handleExecuted = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            const nodeId = asIdentifier(detail.node);
            if (nodeId) {
                this.completedNodeIds.add(nodeId);
                if (nodeId === this.currentNodeId) {
                    this.currentNodeId = null;
                    this.currentStep = null;
                    this.maxSteps = null;
                }
            }
            this.render();
        };
        this.handleExecutionSuccess = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            this.state = "success";
            this.currentNodeId = null;
            this.currentStep = null;
            this.maxSteps = null;
            this.statusText = "Workflow complete";
            this.render(true);
            this.scheduleHide(COMPLETION_HIDE_DELAY_MS);
            this.clearPrompt(detail.prompt_id);
        };
        this.handleExecutionError = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            this.state = "error";
            const errorType = asIdentifier(detail.exception_type);
            const errorMessage = asIdentifier(detail.exception_message);
            this.statusText = errorMessage || errorType
                ? `Workflow failed: ${errorMessage || errorType}`
                : "Workflow failed";
            this.render();
            this.scheduleHide(ERROR_HIDE_DELAY_MS);
            this.clearPrompt(detail.prompt_id);
        };
        this.handleExecutionInterrupted = (event) => {
            const detail = asDetail(event);
            if (!this.acceptPromptEvent(detail)) {
                return;
            }
            this.state = "error";
            this.statusText = "Workflow interrupted";
            this.render();
            this.scheduleHide(ERROR_HIDE_DELAY_MS);
            this.clearPrompt(detail.prompt_id);
        };
    }
    setFullscreenActive(active) {
        this.fullscreenActive = active;
        if (!active) {
            this.root?.classList.remove("lf-workflow-progress-visible");
            this.root?.setAttribute("aria-hidden", "true");
            return;
        }
        if (this.state !== "idle") {
            this.show();
            this.render();
        }
    }
    mount() {
        if (this.listenersAttached || typeof document === "undefined" || !document.body) {
            return;
        }
        this.createRoot();
        this.attachApiListeners();
        this.attachQueuePromptInterceptor();
        this.listenersAttached = true;
    }
    destroy() {
        if (!this.listenersAttached) {
            return;
        }
        const comfyApi = api;
        comfyApi.removeEventListener?.("status", this.handleStatus);
        comfyApi.removeEventListener?.("execution_start", this.handleExecutionStart);
        comfyApi.removeEventListener?.("execution_cached", this.handleExecutionCached);
        comfyApi.removeEventListener?.("executing", this.handleExecuting);
        comfyApi.removeEventListener?.("progress", this.handleProgress);
        comfyApi.removeEventListener?.("executed", this.handleExecuted);
        comfyApi.removeEventListener?.("execution_success", this.handleExecutionSuccess);
        comfyApi.removeEventListener?.("execution_error", this.handleExecutionError);
        comfyApi.removeEventListener?.("execution_interrupted", this.handleExecutionInterrupted);
        if (this.apiQueuePatch) {
            this.apiQueuePatch.listeners.delete(this);
            if (this.apiQueuePatch.listeners.size === 0 && comfyApi[API_QUEUE_PATCH_KEY]?.original) {
                comfyApi.queuePrompt = this.apiQueuePatch.original;
                delete comfyApi[API_QUEUE_PATCH_KEY];
            }
        }
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        this.root?.remove();
        this.root = null;
        this.completedFill = null;
        this.activeFill = null;
        this.labelElement = null;
        this.listenersAttached = false;
    }
    registerQueuedPrompt(promptId, prompt) {
        const nodeLabels = new Map();
        const nodeEntries = Object.entries(prompt.output);
        for (const [nodeId, node] of nodeEntries) {
            const title = asIdentifier(node?._meta?.title);
            const classType = asIdentifier(node?.class_type);
            if (title || classType) {
                nodeLabels.set(nodeId, title || classType || nodeId);
            }
        }
        const promptInfo = {
            totalNodes: nodeEntries.length,
            nodeLabels,
        };
        this.promptInfos.set(promptId, promptInfo);
        if (this.currentPromptId === promptId) {
            this.currentPromptInfo = promptInfo;
            this.totalNodes = promptInfo.totalNodes;
            this.render();
            return;
        }
        if (this.state === "idle" || this.state === "queued") {
            this.state = "queued";
            this.statusText = "Workflow queued";
            this.show();
            this.render();
        }
    }
    createRoot() {
        const existingRoot = document.getElementById(PROGRESS_ROOT_ID);
        if (existingRoot instanceof HTMLDivElement) {
            this.root = existingRoot;
            this.completedFill = existingRoot.querySelector(".lf-workflow-progress-completed");
            this.activeFill = existingRoot.querySelector(".lf-workflow-progress-active");
            this.labelElement = existingRoot.querySelector(".lf-workflow-progress-label");
            return;
        }
        const root = document.createElement("div");
        root.id = PROGRESS_ROOT_ID;
        root.className = "lf-workflow-progress";
        root.setAttribute("role", "progressbar");
        root.setAttribute("aria-label", "Workflow progress");
        root.setAttribute("aria-valuemin", "0");
        root.setAttribute("aria-valuemax", "100");
        root.setAttribute("aria-valuenow", "0");
        root.setAttribute("aria-hidden", "true");
        const completedFill = document.createElement("div");
        completedFill.className = "lf-workflow-progress-completed";
        completedFill.setAttribute("aria-hidden", "true");
        const activeFill = document.createElement("div");
        activeFill.className = "lf-workflow-progress-active";
        activeFill.setAttribute("aria-hidden", "true");
        const labelElement = document.createElement("span");
        labelElement.className = "lf-workflow-progress-label";
        labelElement.setAttribute("aria-hidden", "true");
        root.append(completedFill, activeFill, labelElement);
        document.body.appendChild(root);
        this.root = root;
        this.completedFill = completedFill;
        this.activeFill = activeFill;
        this.labelElement = labelElement;
    }
    attachApiListeners() {
        const comfyApi = api;
        if (typeof comfyApi.addEventListener !== "function") {
            return;
        }
        comfyApi.addEventListener("status", this.handleStatus);
        comfyApi.addEventListener("execution_start", this.handleExecutionStart);
        comfyApi.addEventListener("execution_cached", this.handleExecutionCached);
        comfyApi.addEventListener("executing", this.handleExecuting);
        comfyApi.addEventListener("progress", this.handleProgress);
        comfyApi.addEventListener("executed", this.handleExecuted);
        comfyApi.addEventListener("execution_success", this.handleExecutionSuccess);
        comfyApi.addEventListener("execution_error", this.handleExecutionError);
        comfyApi.addEventListener("execution_interrupted", this.handleExecutionInterrupted);
    }
    attachQueuePromptInterceptor() {
        const comfyApi = api;
        const existingPatch = comfyApi[API_QUEUE_PATCH_KEY];
        if (existingPatch) {
            existingPatch.listeners.add(this);
            this.apiQueuePatch = existingPatch;
            return;
        }
        const originalQueuePrompt = comfyApi.queuePrompt;
        if (typeof originalQueuePrompt !== "function") {
            return;
        }
        const patch = {
            original: originalQueuePrompt,
            listeners: new Set([this]),
        };
        const wrappedQueuePrompt = async function (...args) {
            const prompt = getPromptFromArguments(args);
            const response = await patch.original.apply(this, args);
            const promptId = asIdentifier(response?.prompt_id);
            if (promptId && prompt) {
                patch.listeners.forEach((listener) => listener.registerQueuedPrompt(promptId, prompt));
            }
            return response;
        };
        try {
            comfyApi.queuePrompt = wrappedQueuePrompt;
            comfyApi[API_QUEUE_PATCH_KEY] = patch;
            this.apiQueuePatch = patch;
        }
        catch {
            // A third-party frontend can expose a read-only queuePrompt. Events still provide
            // useful node and step progress, so leave the controller active without the prompt hook.
        }
    }
    acceptPromptEvent(detail) {
        const promptId = asIdentifier(detail.prompt_id);
        if (promptId && this.currentPromptId && promptId !== this.currentPromptId) {
            return false;
        }
        if (!this.currentPromptId && promptId) {
            this.currentPromptId = promptId;
            this.currentPromptInfo = this.promptInfos.get(promptId) || null;
            this.totalNodes = this.currentPromptInfo?.totalNodes || this.getFallbackNodeCount();
        }
        return true;
    }
    getFallbackNodeCount() {
        const graph = app?.graph;
        const nodes = Array.isArray(graph?._nodes)
            ? graph._nodes
            : Array.isArray(graph?.nodes)
                ? graph.nodes
                : [];
        return nodes.length;
    }
    getNodeLabel(nodeId, displayNodeId) {
        const displayIdentifier = asIdentifier(displayNodeId);
        const labelFromPrompt = this.currentPromptInfo?.nodeLabels.get(nodeId)
            || (displayIdentifier ? this.currentPromptInfo?.nodeLabels.get(displayIdentifier) : undefined);
        if (labelFromPrompt) {
            return labelFromPrompt;
        }
        const graphNode = app?.graph?.getNodeById?.(Number(displayIdentifier || nodeId));
        return asIdentifier(graphNode?.title)
            || asIdentifier(graphNode?.type)
            || `Node ${displayIdentifier || nodeId}`;
    }
    clearPrompt(promptId) {
        const identifier = asIdentifier(promptId);
        if (identifier) {
            this.promptInfos.delete(identifier);
        }
        this.currentPromptId = null;
        this.currentPromptInfo = null;
    }
    show() {
        this.cancelHide();
        if (!this.fullscreenActive) {
            return;
        }
        this.root?.classList.add("lf-workflow-progress-visible");
        this.root?.setAttribute("aria-hidden", "false");
    }
    scheduleHide(delay) {
        this.cancelHide();
        this.hideTimer = window.setTimeout(() => {
            this.hideTimer = null;
            this.state = "idle";
            this.statusText = "Idle";
            this.root?.classList.remove("lf-workflow-progress-visible", "lf-workflow-progress-indeterminate", "lf-workflow-progress-error", "lf-workflow-progress-success");
            this.root?.setAttribute("aria-hidden", "true");
            this.completedFill?.style.setProperty("width", "0%");
            this.activeFill?.style.setProperty("width", "0%");
            this.labelElement?.replaceChildren();
        }, delay);
    }
    cancelHide() {
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }
    render(forceComplete = false) {
        if (!this.root || !this.completedFill || !this.activeFill) {
            return;
        }
        const completedCount = this.completedNodeIds.size;
        const totalNodes = Math.max(this.totalNodes, completedCount);
        const completedPercent = totalNodes > 0
            ? clampPercent((completedCount / totalNodes) * 100)
            : 0;
        let activePercent = completedPercent;
        if (this.currentStep !== null && this.maxSteps !== null && this.maxSteps > 0 && totalNodes > 0) {
            const stepFraction = Math.min(1, Math.max(0, this.currentStep / this.maxSteps));
            activePercent = clampPercent(((completedCount + stepFraction) / totalNodes) * 100);
        }
        if (forceComplete || this.state === "success") {
            activePercent = 100;
        }
        this.completedFill.style.width = `${completedPercent}%`;
        this.activeFill.style.width = `${activePercent}%`;
        this.root.classList.toggle("lf-workflow-progress-indeterminate", this.state === "running" && totalNodes === 0);
        this.root.classList.toggle("lf-workflow-progress-error", this.state === "error");
        this.root.classList.toggle("lf-workflow-progress-success", this.state === "success");
        this.root.setAttribute("aria-valuenow", String(Math.round(activePercent)));
        const queueSuffix = this.queueRemaining === null ? "" : ` · Queue ${this.queueRemaining}`;
        const nodeSuffix = this.currentNodeLabel ? ` · ${this.currentNodeLabel}` : "";
        const progressSuffix = totalNodes > 0 && this.state === "running"
            ? ` · ${Math.round(activePercent)}%`
            : "";
        const label = `${this.statusText}${progressSuffix}${nodeSuffix}${queueSuffix}`;
        this.root.setAttribute("aria-label", label);
        this.root.dataset.status = label;
        if (this.labelElement) {
            this.labelElement.textContent = label;
        }
    }
}
let installedController = null;
let fullscreenEditorCount = 0;
export const installWorkflowProgress = () => {
    if (installedController) {
        return;
    }
    installedController = new WorkflowProgressController();
    installedController.mount();
    installedController.setFullscreenActive(fullscreenEditorCount > 0);
};
export const setWorkflowProgressFullscreen = (active) => {
    fullscreenEditorCount = active
        ? fullscreenEditorCount + 1
        : Math.max(0, fullscreenEditorCount - 1);
    installedController?.setFullscreenActive(fullscreenEditorCount > 0);
};
