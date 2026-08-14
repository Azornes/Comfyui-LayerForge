"""BRIA RMBG 2.0 backend using the local Transformers model."""

import os
import threading
from typing import ClassVar

import torch
import torch.nn.functional as F

from ...node import log
from ..catalog import _RMBG_MODEL_CATALOG, _RMBG_REMOTE_PREFIX
from ..paths import _get_rmbg_model_directory
from ..progress import call_huggingface_download
from ..settings import get_huggingface_token


def _get_rmbg_transformers_status():
    """Inspect the installed Transformers API without changing the environment."""
    try:
        import transformers
    except ModuleNotFoundError as error:
        if error.name == "transformers":
            return {
                "loader": None,
                "message": (
                    "BRIA RMBG 2.0 requires the 'transformers' package in the active ComfyUI environment. "
                    "Install or update it manually if you want to use this model."
                ),
            }
        return {
            "loader": None,
            "message": (
                "The installed Transformers package could not be loaded for BRIA RMBG 2.0: "
                f"{error}. Check the active ComfyUI environment and update Transformers manually if needed."
            ),
        }
    except Exception as error:
        return {
            "loader": None,
            "message": (
                "The installed Transformers package could not be loaded for BRIA RMBG 2.0: "
                f"{error}. Update Transformers manually if needed."
            ),
        }

    version = getattr(transformers, "__version__", "unknown")
    try:
        loader = getattr(transformers, "AutoModelForImageSegmentation", None)
        from_pretrained = getattr(loader, "from_pretrained", None)
    except Exception as error:
        return {
            "loader": None,
            "message": (
                f"Installed Transformers version {version} is not supported for BRIA RMBG 2.0: {error}. "
                "Update Transformers manually if you want to use this model."
            ),
        }

    if not callable(loader) or not callable(from_pretrained):
        return {
            "loader": None,
            "message": (
                f"Installed Transformers version {version} is not supported for BRIA RMBG 2.0. "
                "It does not provide the required AutoModelForImageSegmentation API. "
                "Update Transformers manually if you want to use this model."
            ),
        }

    return {"loader": loader, "message": None, "version": version}


def _get_rmbg_model_loader():
    """Return the Transformers loader used by BRIA RMBG 2.0, when installed."""
    status = _get_rmbg_transformers_status()
    if status["loader"] is None:
        log.debug(status["message"])
    return status["loader"]


def _get_rmbg_model_status_message():
    """Return an actionable message for a missing or incompatible Transformers install."""
    return _get_rmbg_transformers_status()["message"]


def _is_rmbg_model_directory(path):
    """Check whether a directory contains the files needed by RMBG 2.0."""
    if not path or not os.path.isdir(path):
        return False

    required_files = (
        "config.json",
        "preprocessor_config.json",
        "birefnet.py",
        "BiRefNet_config.py",
    )
    has_weights = any(
        os.path.isfile(os.path.join(path, filename))
        for filename in ("model.safetensors", "pytorch_model.bin")
    )
    return has_weights and all(os.path.isfile(os.path.join(path, filename)) for filename in required_files)


def _get_rmbg_remote_model(model_path):
    """Resolve a client-facing BRIA RMBG model identifier from the catalog."""
    if not isinstance(model_path, str) or not model_path.startswith(_RMBG_REMOTE_PREFIX):
        return None

    model_id = model_path[len(_RMBG_REMOTE_PREFIX) :]
    return next((model for model in _RMBG_MODEL_CATALOG if model["id"] == model_id), None)


def _find_existing_rmbg_model(model):
    """Return an installed BRIA RMBG model directory, when available."""
    model_directory = _get_rmbg_model_directory(model)
    if _is_rmbg_model_directory(model_directory):
        return model_directory
    return None


def _find_local_rmbg_model(model_path=None):
    """Find a local BRIA RMBG model directory, optionally matching a selection."""
    if model_path and model_path != "auto":
        requested = os.path.abspath(model_path)
        return requested if _is_rmbg_model_directory(requested) else None

    for model in _RMBG_MODEL_CATALOG:
        model_directory = _find_existing_rmbg_model(model)
        if model_directory:
            return model_directory
    return None


def _download_rmbg_model(model, node_id=None):
    """Download the BRIA RMBG 2.0 repository into ComfyUI's model path."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "BRIA RMBG 2.0 download requires the 'huggingface_hub' package. "
            "Install the LayerForge requirements or place the model files in "
            "ComfyUI/models/background_removal/RMBG-2.0/."
        ) from error

    model_directory = _get_rmbg_model_directory(model)
    if not model_directory:
        raise RuntimeError("ComfyUI did not expose a background_removal model directory")

    os.makedirs(model_directory, exist_ok=True)
    log.info(f"Downloading {model['label']} from Hugging Face into {model_directory}...")
    download_kwargs = {
        "repo_id": model["repo_id"],
        "local_dir": model_directory,
        "allow_patterns": ["*.json", "*.py", "*.safetensors"],
    }
    token = get_huggingface_token()
    if token:
        download_kwargs["token"] = token
    try:
        call_huggingface_download(
            snapshot_download,
            download_kwargs,
            model["label"],
            node_id=node_id,
        )
    except Exception as error:
        raise RuntimeError(
            "Unable to download BRIA RMBG 2.0. Accept the model's gated access on "
            "Hugging Face and ensure the configured Hugging Face credentials can access it."
        ) from error

    if not _is_rmbg_model_directory(model_directory):
        raise RuntimeError(
            f"Downloaded {model['label']} is incomplete or is not a valid Transformers model: "
            f"{model_directory}"
        )

    log.info(f"{model['label']} model is ready at {model_directory}")
    return model_directory


def _ensure_rmbg_model(model_path, node_id=None):
    """Resolve or download the selected BRIA RMBG 2.0 model directory."""
    remote_model = _get_rmbg_remote_model(model_path)
    if remote_model:
        model_directory = _find_existing_rmbg_model(remote_model)
        if model_directory:
            return model_directory
        if node_id is None:
            return _download_rmbg_model(remote_model)
        return _download_rmbg_model(remote_model, node_id=node_id)

    model_directory = _find_local_rmbg_model(model_path)
    if model_directory:
        return model_directory

    raise RuntimeError(
        "The selected BRIA RMBG 2.0 model is not available or is incomplete. "
        "Place its files in ComfyUI/models/background_removal/RMBG-2.0/ or download it from the model selector."
    )


class RMBG2Model:
    """Adapter for BRIA RMBG 2.0 loaded through Transformers."""

    _model_cache: ClassVar[dict] = {}
    _model_cache_lock = threading.Lock()
    _image_size = 1024

    def __init__(self, model, device):
        self.model = model
        self.device = device

    @classmethod
    def load(cls, model_directory):
        status = _get_rmbg_transformers_status()
        loader = status["loader"]
        if loader is None:
            raise RuntimeError(status["message"])

        cache_key = os.path.normcase(os.path.normpath(os.path.abspath(model_directory)))
        with cls._model_cache_lock:
            if cache_key not in cls._model_cache:
                device = _get_rmbg_device()
                log.info(f"Loading BRIA RMBG 2.0 from {model_directory} on {device}")
                try:
                    model = loader.from_pretrained(
                        model_directory,
                        trust_remote_code=True,
                        local_files_only=True,
                    )
                except Exception as error:
                    version = status.get("version", "unknown")
                    raise RuntimeError(
                        f"BRIA RMBG 2.0 could not be loaded with installed Transformers version {version}. "
                        "This version may not support the model's remote code; update Transformers manually "
                        f"if needed. Original error: {error}"
                    ) from error
                model.eval().to(device)
                cls._model_cache[cache_key] = cls(model, device)
            else:
                log.debug(f"Using cached BRIA RMBG 2.0 model from {model_directory}")

            return cls._model_cache[cache_key]

    def encode_image(self, image):
        if image.dim() != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError(f"Expected a BHWC image tensor, got {tuple(image.shape)}")

        original_size = (image.shape[1], image.shape[2])
        input_image = image.movedim(-1, 1)
        if input_image.shape[1] == 1:
            input_image = input_image.expand(-1, 3, -1, -1)
        elif input_image.shape[1] == 4:
            input_image = input_image[:, :3]

        input_image = input_image.to(device=self.device, dtype=torch.float32)
        input_image = F.interpolate(
            input_image,
            size=(self._image_size, self._image_size),
            mode="bilinear",
            align_corners=False,
        )
        mean = input_image.new_tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
        std = input_image.new_tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)

        with torch.no_grad():
            prediction = self.model((input_image - mean) / std)
            if isinstance(prediction, (tuple, list)):
                prediction = prediction[-1]
            elif hasattr(prediction, "logits"):
                prediction = prediction.logits

            if not isinstance(prediction, torch.Tensor):
                raise ValueError("BRIA RMBG 2.0 returned an unsupported prediction type")
            if prediction.dim() == 3:
                prediction = prediction.unsqueeze(1)
            if prediction.dim() != 4:
                raise ValueError(f"Unexpected BRIA RMBG 2.0 output shape: {tuple(prediction.shape)}")

            alpha_mask = prediction.sigmoid()
            alpha_mask = F.interpolate(
                alpha_mask,
                size=original_size,
                mode="bilinear",
                align_corners=False,
            )

        return alpha_mask[:, 0].clamp(0.0, 1.0).to(device=image.device, dtype=torch.float32)


def _get_rmbg_device():
    """Use ComfyUI's active torch device when available."""
    try:
        import comfy.model_management as model_management

        return model_management.get_torch_device()
    except Exception as error:
        log.debug(f"Unable to resolve ComfyUI's model device for RMBG 2.0: {error}")
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


__all__ = [
    "RMBG2Model",
    "_download_rmbg_model",
    "_ensure_rmbg_model",
    "_find_existing_rmbg_model",
    "_find_local_rmbg_model",
    "_get_rmbg_model_loader",
    "_get_rmbg_model_status_message",
    "_get_rmbg_remote_model",
    "_get_rmbg_transformers_status",
    "_is_rmbg_model_directory",
]
