# ComfyUI loads this file as a package. Pytest also sees the repository-level
# __init__.py while discovering tests, where relative imports have no package
# context and the ComfyUI runtime is not available. Keep that discovery path
# inert while preserving the normal package bootstrap.
LayerForgeNode = None
if __package__:
    from .python.node import LayerForgeNode

    LayerForgeNode.setup_routes()

NODE_CLASS_MAPPINGS = {
    "LayerForgeNode": LayerForgeNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LayerForgeNode": "Layer Forge (Editor, outpaintintg, Canvas Node)"
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
