"""Shared model selection, preprocessing, inference, and output handling."""

import hashlib
import threading
from typing import ClassVar

import torch
import torch.nn.functional as F
from server import PromptServer
from torchvision import transforms

from ..node import log
from .backends.birefnet import _ensure_birefnet_checkpoint, _get_comfy_birefnet_loader
from .backends.rmbg import (
    RMBG2Model,
    _ensure_rmbg_model,
    _find_local_rmbg_model,
    _get_rmbg_model_loader,
    _get_rmbg_model_status_message,
    _get_rmbg_remote_model,
)


class BiRefNetMatting:
    """Background-removal adapter for native BiRefNet and BRIA RMBG 2.0."""

    _model_cache: ClassVar[dict] = {}
    _model_cache_lock = threading.Lock()

    def __init__(self):
        self.model = None
        self.model_path = None

    def load_model(self, model_path=None):
        """Load the selected backend and reuse its process-wide model cache."""
        rmbg_model = _get_rmbg_remote_model(model_path)
        local_rmbg_path = None
        if not rmbg_model and model_path and model_path != "auto":
            local_rmbg_path = _find_local_rmbg_model(model_path)

        if rmbg_model or local_rmbg_path:
            if _get_rmbg_model_loader() is None:
                raise RuntimeError(_get_rmbg_model_status_message())
            model_directory = _ensure_rmbg_model(model_path)
            self.model = RMBG2Model.load(model_directory)
            self.model_path = model_directory
            return self.model

        loader = _get_comfy_birefnet_loader()
        if loader is None:
            raise RuntimeError(
                "This ComfyUI version does not provide the native BiRefNet background-removal loader."
            )

        checkpoint_path = _ensure_birefnet_checkpoint(model_path)
        with self._model_cache_lock:
            if checkpoint_path not in self._model_cache:
                log.info(f"Loading BiRefNet with ComfyUI's native loader from {checkpoint_path}")
                model = loader(checkpoint_path)
                if model is None:
                    raise RuntimeError(
                        f"ComfyUI did not recognize the BiRefNet checkpoint: {checkpoint_path}"
                    )
                self._model_cache[checkpoint_path] = model
            else:
                log.debug(f"Using cached native BiRefNet model from {checkpoint_path}")

            self.model = self._model_cache[checkpoint_path]
            self.model_path = checkpoint_path

        return self.model

    def preprocess_image(self, image):
        if not isinstance(image, torch.Tensor):
            image = transforms.ToTensor()(image).unsqueeze(0)

        if image.dim() == 3:
            if image.shape[0] in (1, 3, 4):
                image = image.movedim(0, -1).unsqueeze(0)
            else:
                image = image.unsqueeze(0)
        elif image.dim() == 4 and image.shape[1] in (1, 3, 4):
            image = image.movedim(1, -1)

        if image.dim() != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError(f"Expected an image tensor in BCHW or BHWC format, got {tuple(image.shape)}")

        if image.shape[-1] == 1:
            image = image.expand(-1, -1, -1, 3)
        elif image.shape[-1] == 4:
            image = image[..., :3]

        return image.to(dtype=torch.float32).contiguous()

    def execute(self, image, model_path, threshold=0.5, refinement=1, mode="remove_background"):
        try:
            PromptServer.instance.send_sync("matting_status", {"status": "processing"})
            del refinement
            if mode not in {"remove_background", "remove_foreground", "mask_only"}:
                raise ValueError(f"Unsupported matting mode: {mode}")

            threshold = float(threshold)
            if not 0.0 <= threshold <= 1.0:
                raise ValueError("Matting threshold must be between 0 and 1")

            image_tensor = self.preprocess_image(image)
            original_size = (image_tensor.shape[1], image_tensor.shape[2])
            log.debug(f"Original size: {original_size}")
            self.load_model(model_path)
            log.debug(f"Processed image shape: {image_tensor.shape}, dtype: {image_tensor.dtype}")

            with torch.no_grad():
                result = self.model.encode_image(image_tensor)
                if result.dim() == 3:
                    result = result.unsqueeze(1)
                elif result.dim() == 2:
                    result = result.unsqueeze(0).unsqueeze(0)
                else:
                    raise ValueError(f"Unexpected background-removal output shape: {tuple(result.shape)}")

                result = result.to(device=image_tensor.device, dtype=torch.float32)
                if result.shape[-2:] != original_size:
                    result = F.interpolate(
                        result,
                        size=original_size,
                        mode="bilinear",
                        align_corners=False,
                    )
                result = result.clamp(0.0, 1.0)
                log.debug(f"Background-removal output shape: {result.shape}, dtype: {result.dtype}")

                if threshold > 0:
                    result = (result > threshold).to(dtype=torch.float32)

                alpha_mask = 1.0 - result if mode == "remove_foreground" else result
                if mode == "mask_only":
                    masked_image = alpha_mask.expand(-1, 3, -1, -1)
                else:
                    masked_image = image_tensor.movedim(-1, 1) * alpha_mask

                PromptServer.instance.send_sync("matting_status", {"status": "completed"})
                return masked_image, alpha_mask
        except Exception:
            PromptServer.instance.send_sync("matting_status", {"status": "error"})
            raise

    @classmethod
    def IS_CHANGED(cls, image, model_path, threshold, refinement, mode="remove_background"):
        digest = hashlib.md5()
        digest.update(str(image).encode())
        digest.update(str(model_path).encode())
        digest.update(str(threshold).encode())
        digest.update(str(refinement).encode())
        digest.update(str(mode).encode())
        return digest.hexdigest()


__all__ = ["BiRefNetMatting"]
