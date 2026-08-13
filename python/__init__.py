"""Backend package for the LayerForge ComfyUI custom node.

The runtime modules are intentionally imported explicitly by the entry point:
``node`` owns the ComfyUI node, ``routes`` owns HTTP/WebSocket registration,
``image_utils`` owns tensor conversions, and ``matting`` owns BiRefNet.
"""
