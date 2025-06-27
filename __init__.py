import sys
import os

# Add the custom node's directory to the Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from .canvas_node import CanvasNode

CanvasNode.setup_routes()

NODE_CLASS_MAPPINGS = {
    "CanvasNode": CanvasNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CanvasNode": "Layer Forge (Editor, outpaintintg, Canvas Node)"
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
