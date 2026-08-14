// Stable frontend entrypoint loaded by ComfyUI.
// The implementation module is also served recursively, so registration is
// intentionally invoked only from this root bootstrap.
import { registerLayerForgeExtension } from "./app/CanvasView.js";
registerLayerForgeExtension();
