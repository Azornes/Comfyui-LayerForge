"""Shared image serialization helpers for LayerForge backend boundaries."""

import base64
import io

from PIL import Image


def _bytes_to_data_url(data: bytes, mime_type: str) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def pil_to_data_url(
    image: Image.Image,
    *,
    image_format: str = "PNG",
    mime_type: str = "image/png",
) -> str:
    """Serialize a PIL image using the existing PNG data-URL contract."""
    buffer = io.BytesIO()
    image.save(buffer, format=image_format)
    return _bytes_to_data_url(buffer.getvalue(), mime_type)


def file_to_data_url(path: str, *, mime_type: str = "image/png") -> str:
    """Read an image file without transforming its bytes into a data URL."""
    with open(path, "rb") as image_file:
        return _bytes_to_data_url(image_file.read(), mime_type)


__all__ = ["file_to_data_url", "pil_to_data_url"]
