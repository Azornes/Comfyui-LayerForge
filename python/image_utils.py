"""Image and tensor conversion helpers shared by LayerForge endpoints."""

import base64
import io

import numpy as np
from PIL import Image
from torchvision import transforms

from .node import log


def convert_base64_to_tensor(base64_str):
    """Convert a data-URL image into a BCHW tensor and optional alpha tensor."""
    try:
        img_data = base64.b64decode(base64_str.split(",")[1])
        img = Image.open(io.BytesIO(img_data))

        has_alpha = img.mode == "RGBA"
        alpha = None
        if has_alpha:
            alpha = img.split()[3]
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=alpha)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img_tensor = transforms.ToTensor()(img).unsqueeze(0)
        if has_alpha:
            alpha_tensor = transforms.ToTensor()(alpha).unsqueeze(0)
            return img_tensor, alpha_tensor

        return img_tensor, None
    except Exception as error:
        log.error(f"Error in convert_base64_to_tensor: {error}")
        raise


def convert_tensor_to_base64(tensor, alpha_mask=None, original_alpha=None):
    """Convert a tensor to a PNG data URL, optionally preserving alpha."""
    try:
        tensor = tensor.cpu()

        if tensor.dim() == 4:
            tensor = tensor.squeeze(0)
        if tensor.dim() == 3 and tensor.shape[0] in [1, 3]:
            tensor = tensor.permute(1, 2, 0)

        img_array = (tensor.numpy() * 255).astype(np.uint8)

        if alpha_mask is not None and original_alpha is not None:
            alpha_mask = (alpha_mask.cpu().squeeze().numpy() * 255).astype(np.uint8)
            original_alpha = (original_alpha.cpu().squeeze().numpy() * 255).astype(np.uint8)
            combined_alpha = np.minimum(alpha_mask, original_alpha)

            img = Image.fromarray(img_array, mode="RGB")
            img.putalpha(Image.fromarray(combined_alpha, mode="L"))
        elif img_array.shape[-1] == 1:
            img = Image.fromarray(img_array.squeeze(-1), mode="L")
        else:
            img = Image.fromarray(img_array, mode="RGB")

        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        img_str = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{img_str}"
    except Exception as error:
        log.error(f"Error in convert_tensor_to_base64: {error}")
        log.debug(f"Tensor shape: {tensor.shape}, dtype: {tensor.dtype}")
        raise


__all__ = ["convert_base64_to_tensor", "convert_tensor_to_base64"]
