"""BiRefNet model discovery, download, inference, and HTTP endpoints."""

import hashlib
import os
import shutil
import threading
import traceback
from typing import ClassVar

import folder_paths
import torch
import torch.nn.functional as F
from aiohttp import web
from server import PromptServer
from torchvision import transforms

from .image_utils import convert_base64_to_tensor, convert_tensor_to_base64
from .node import log

_BIREFNET_REPOSITORY = "ZhengPeng7/BiRefNet"
_BIREFNET_FILENAME = "model.safetensors"
_BIREFNET_DEFAULT_LOCAL_FILENAME = "BiRefNet-general.safetensors"
_BIREFNET_PROJECT_URL = "https://github.com/ZhengPeng7/BiRefNet"
_BIREFNET_REMOTE_PREFIX = "remote:"
_BIREFNET_REMOTE_DIRECTORY = "layerforge_birefnet"
_BIREFNET_REQUIRED_KEYS = {
    "bb.layers.1.blocks.0.attn.relative_position_index",
    "bb.layers.2.blocks.17.attn.qkv.weight",
}
_BIREFNET_MODEL_CATALOG = (
    {
        "id": "general",
        "label": "BiRefNet — General",
        "description": "The best starting point for everyday images and general background removal.",
        "repo_id": "ZhengPeng7/BiRefNet",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-general.safetensors",
    },
    {
        "id": "high_resolution",
        "label": "BiRefNet — High Resolution",
        "description": "High-resolution segmentation for detailed edges and larger source images; it uses more memory.",
        "repo_id": "ZhengPeng7/BiRefNet_HR",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HR.safetensors",
    },
    {
        "id": "portrait",
        "label": "BiRefNet — Portrait",
        "description": "Portrait matting for people, hair, and portrait-focused cutouts.",
        "repo_id": "ZhengPeng7/BiRefNet-portrait",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-portrait.safetensors",
    },
    {
        "id": "matting",
        "label": "BiRefNet — Matting",
        "description": "General matting with a focus on soft alpha edges such as hair and semi-transparent details.",
        "repo_id": "ZhengPeng7/BiRefNet-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-matting.safetensors",
    },
    {
        "id": "high_resolution_matting",
        "label": "BiRefNet — High Resolution Matting",
        "description": "High-resolution general matting for fine details; it requires more memory than the standard matting model.",
        "repo_id": "ZhengPeng7/BiRefNet_HR-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HR-matting.safetensors",
    },
    {
        "id": "dynamic",
        "label": "BiRefNet — Dynamic",
        "description": "Dynamic-shape segmentation for inputs with varying aspect ratios and resolutions.",
        "repo_id": "ZhengPeng7/BiRefNet_dynamic",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet_dynamic.safetensors",
    },
    {
        "id": "dynamic_matting",
        "label": "BiRefNet — Dynamic Matting",
        "description": "Dynamic-shape matting for arbitrary input sizes, with a focus on soft alpha edges.",
        "repo_id": "ZhengPeng7/BiRefNet_dynamic-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet_dynamic-matting.safetensors",
    },
    {
        "id": "hrsod",
        "label": "BiRefNet — HRSOD",
        "description": "High-resolution salient-object detection; useful when the main subject should stand out from its surroundings.",
        "repo_id": "ZhengPeng7/BiRefNet-HRSOD",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HRSOD.safetensors",
    },
    {
        "id": "dis5k",
        "label": "BiRefNet — DIS5K",
        "description": "Dichotomous image segmentation trained for clean foreground/background separation.",
        "repo_id": "ZhengPeng7/BiRefNet-DIS5K",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-DIS5K.safetensors",
    },
    {
        "id": "cod",
        "label": "BiRefNet — COD",
        "description": "Camouflaged-object detection; use it for subjects that blend into their background.",
        "repo_id": "ZhengPeng7/BiRefNet-COD",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-COD.safetensors",
    },
)


def _get_comfy_birefnet_loader():
    """Return ComfyUI's native BiRefNet loader when it is available."""
    try:
        from comfy.bg_removal_model import load

        return load
    except Exception as error:
        log.debug(f"Native ComfyUI BiRefNet loader is unavailable: {error}")
        return None


def _get_birefnet_base_paths():
    """Return native ComfyUI and legacy locations that may contain BiRefNet."""
    paths = []
    get_folder_paths = getattr(folder_paths, "get_folder_paths", None)
    if callable(get_folder_paths):
        try:
            paths.extend(get_folder_paths("background_removal"))
        except (KeyError, TypeError):
            pass

    comfy_models_dir = getattr(folder_paths, "models_dir", None)
    if comfy_models_dir:
        paths.extend(
            [
                os.path.join(comfy_models_dir, "background_removal"),
                os.path.join(comfy_models_dir, "RMBG", "BiRefNet"),
                os.path.join(comfy_models_dir, "BiRefNet"),
            ]
        )

    unique_paths = []
    seen = set()
    for path in paths:
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized not in seen:
            seen.add(normalized)
            unique_paths.append(path)
    return unique_paths


def _is_native_birefnet_checkpoint(path):
    """Check the checkpoint signature without loading all weights into memory."""
    if not os.path.isfile(path) or not path.lower().endswith(".safetensors"):
        return False

    try:
        from safetensors import safe_open

        with safe_open(path, framework="pt") as checkpoint:
            return _BIREFNET_REQUIRED_KEYS.issubset(checkpoint.keys())
    except Exception as error:
        log.debug(f"Unable to inspect BiRefNet checkpoint {path}: {error}")
        return False


def _iter_birefnet_checkpoint_paths():
    """Yield candidate checkpoints from native and legacy model directories."""
    for base_path in _get_birefnet_base_paths():
        if not os.path.isdir(base_path):
            continue

        for root, directories, files in os.walk(base_path):
            directories[:] = [
                directory
                for directory in directories
                if directory not in {
                    ".git",
                    ".no_exist",
                    ".cache",
                    "__pycache__",
                    "refs",
                    "snapshots",
                    "blobs",
                }
                and not directory.startswith("models--")
            ]
            for filename in sorted(files):
                if filename.lower().endswith(".safetensors"):
                    yield os.path.join(root, filename)


def _find_local_birefnet_model(model_path=None):
    """Find a full BiRefNet checkpoint accepted by ComfyUI's native loader."""
    candidates = []
    seen = set()
    for path in _iter_birefnet_checkpoint_paths():
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized in seen:
            continue
        seen.add(normalized)
        if _is_native_birefnet_checkpoint(path):
            candidates.append(path)

    if model_path and model_path != "auto":
        requested = os.path.normcase(os.path.normpath(os.path.abspath(model_path)))
        for candidate in candidates:
            if os.path.normcase(os.path.normpath(os.path.abspath(candidate))) == requested:
                return candidate
        return None

    if not candidates:
        return None

    priority = {
        "birefnet.safetensors": 0,
        "model.safetensors": 1,
        "birefnet-general.safetensors": 2,
        "birefnet-hr.safetensors": 3,
    }
    return min(
        candidates,
        key=lambda path: (priority.get(os.path.basename(path).lower(), 10), path.lower()),
    )


def _get_birefnet_remote_model(model_path):
    """Resolve a client-facing remote model identifier from the fixed catalog."""
    if not isinstance(model_path, str) or not model_path.startswith(_BIREFNET_REMOTE_PREFIX):
        return None

    model_id = model_path[len(_BIREFNET_REMOTE_PREFIX) :]
    return next((model for model in _BIREFNET_MODEL_CATALOG if model["id"] == model_id), None)


def _get_birefnet_remote_checkpoint_path(model):
    """Return the managed local path for a catalog model."""
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None
    return os.path.join(
        base_paths[0],
        _BIREFNET_REMOTE_DIRECTORY,
        model["id"],
        model["local_filename"],
    )


def _get_birefnet_remote_legacy_checkpoint_path(model):
    """Return the pre-friendly-name path used by earlier LayerForge builds."""
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None
    return os.path.join(
        base_paths[0],
        _BIREFNET_REMOTE_DIRECTORY,
        model["id"],
        model["filename"],
    )


def _migrate_birefnet_checkpoint(
    checkpoint_path,
    legacy_path,
    *,
    log_description,
    success_suffix="to",
):
    """Return an existing friendly checkpoint or migrate its legacy filename."""
    if checkpoint_path and _is_native_birefnet_checkpoint(checkpoint_path):
        return checkpoint_path

    if (
        not checkpoint_path
        or not legacy_path
        or legacy_path == checkpoint_path
        or not _is_native_birefnet_checkpoint(legacy_path)
    ):
        return None

    try:
        os.makedirs(os.path.dirname(checkpoint_path), exist_ok=True)
        os.replace(legacy_path, checkpoint_path)
        log.info(f"Renamed {log_description} {success_suffix} {checkpoint_path}")
        return checkpoint_path
    except OSError as error:
        log.warning(f"Unable to rename {log_description} {legacy_path}: {error}")
        return legacy_path


def _find_existing_birefnet_remote_checkpoint(model):
    """Find a managed remote checkpoint and migrate its old generic filename."""
    return _migrate_birefnet_checkpoint(
        _get_birefnet_remote_checkpoint_path(model),
        _get_birefnet_remote_legacy_checkpoint_path(model),
        log_description="BiRefNet checkpoint",
        success_suffix="to the friendly filename",
    )


def _get_birefnet_model_options():
    """Return local checkpoints and official models available for download."""
    _find_existing_birefnet_default_checkpoint()
    local_options = []
    seen = set()
    managed_roots = [
        os.path.normcase(os.path.normpath(os.path.join(base_path, _BIREFNET_REMOTE_DIRECTORY)))
        for base_path in _get_birefnet_base_paths()
    ]

    for path in _iter_birefnet_checkpoint_paths():
        normalized = os.path.normcase(os.path.normpath(os.path.abspath(path)))
        if normalized in seen or not _is_native_birefnet_checkpoint(path):
            continue
        if any(normalized == root or normalized.startswith(root + os.sep) for root in managed_roots):
            continue

        seen.add(normalized)
        label = os.path.basename(path)
        for base_path in _get_birefnet_base_paths():
            try:
                relative_path = os.path.relpath(path, base_path)
            except ValueError:
                continue
            if relative_path == os.pardir or relative_path.startswith(os.pardir + os.sep):
                continue
            label = relative_path.replace(os.sep, "/")
            break

        local_options.append({
            "path": path,
            "label": label,
            "source": "local",
            "downloaded": True,
        })

    remote_options = []
    for model in _BIREFNET_MODEL_CATALOG:
        checkpoint_path = _find_existing_birefnet_remote_checkpoint(model)
        remote_options.append({
            "path": f"{_BIREFNET_REMOTE_PREFIX}{model['id']}",
            "label": model["label"],
            "description": model["description"],
            "url": f"https://huggingface.co/{model['repo_id']}",
            "project_url": _BIREFNET_PROJECT_URL,
            "source": "remote",
            "downloaded": bool(checkpoint_path and _is_native_birefnet_checkpoint(checkpoint_path)),
        })

    local_options.sort(key=lambda option: option["label"].lower())
    return local_options + remote_options


def _get_birefnet_download_dir():
    paths = _get_birefnet_base_paths()
    if not paths:
        raise RuntimeError("ComfyUI did not expose a background_removal model directory")

    download_dir = paths[0]
    os.makedirs(download_dir, exist_ok=True)
    return download_dir


def _get_birefnet_default_checkpoint_path():
    """Return the friendly path used for the automatic General checkpoint."""
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None
    return os.path.join(base_paths[0], _BIREFNET_DEFAULT_LOCAL_FILENAME)


def _find_existing_birefnet_default_checkpoint():
    """Find the automatic checkpoint and migrate its old generic filename."""
    checkpoint_path = _get_birefnet_default_checkpoint_path()
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None

    legacy_path = os.path.join(base_paths[0], _BIREFNET_FILENAME)
    return _migrate_birefnet_checkpoint(
        checkpoint_path,
        legacy_path,
        log_description="the automatic BiRefNet checkpoint",
    )


def _download_birefnet_checkpoint(model=None):
    """Download and validate a full BiRefNet checkpoint into ComfyUI's model path."""
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise RuntimeError(
            "Automatic BiRefNet download requires the 'huggingface_hub' package. "
            "Install the LayerForge requirements or place a compatible checkpoint in "
            "ComfyUI/models/background_removal/."
        ) from error

    if model is None:
        repository = _BIREFNET_REPOSITORY
        filename = _BIREFNET_FILENAME
        download_dir = _get_birefnet_download_dir()
        model_label = "BiRefNet — General"
        target_path = os.path.join(download_dir, _BIREFNET_DEFAULT_LOCAL_FILENAME)
    else:
        repository = model["repo_id"]
        filename = model["filename"]
        download_dir = os.path.join(
            _get_birefnet_download_dir(),
            _BIREFNET_REMOTE_DIRECTORY,
            model["id"],
        )
        os.makedirs(download_dir, exist_ok=True)
        model_label = model["label"]
        target_path = _get_birefnet_remote_checkpoint_path(model)

    log.info(f"Downloading {model_label} from Hugging Face into {download_dir}...")
    try:
        downloaded_path = hf_hub_download(
            repo_id=repository,
            filename=filename,
            local_dir=download_dir,
            local_dir_use_symlinks=False,
        )
    except TypeError:
        downloaded_path = hf_hub_download(
            repo_id=repository,
            filename=filename,
            local_dir=download_dir,
        )

    if not _is_native_birefnet_checkpoint(downloaded_path):
        raise RuntimeError(
            f"Downloaded {model_label} is not a ComfyUI-compatible BiRefNet checkpoint: {downloaded_path}"
        )

    if target_path and os.path.normcase(os.path.abspath(downloaded_path)) != os.path.normcase(
        os.path.abspath(target_path)
    ):
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        try:
            os.replace(downloaded_path, target_path)
        except OSError:
            shutil.copy2(downloaded_path, target_path)
        downloaded_path = target_path

    if target_path and not _is_native_birefnet_checkpoint(downloaded_path):
        raise RuntimeError(
            f"Renamed {model_label} is not a ComfyUI-compatible BiRefNet checkpoint: {downloaded_path}"
        )

    log.info(f"{model_label} checkpoint is ready at {downloaded_path}")
    return downloaded_path


def _ensure_birefnet_checkpoint(model_path=None):
    remote_model = _get_birefnet_remote_model(model_path)
    if remote_model:
        checkpoint_path = _find_existing_birefnet_remote_checkpoint(remote_model)
        if checkpoint_path:
            return checkpoint_path
        return _download_birefnet_checkpoint(remote_model)

    if not model_path or model_path == "auto":
        _find_existing_birefnet_default_checkpoint()

    checkpoint_path = _find_local_birefnet_model(model_path)
    if checkpoint_path:
        return checkpoint_path

    if model_path and model_path != "auto":
        raise RuntimeError("The selected BiRefNet checkpoint is not available or is not compatible with ComfyUI.")

    return _download_birefnet_checkpoint()


class BiRefNetMatting:
    """Adapter around ComfyUI's native BiRefNet loader."""

    _model_cache: ClassVar[dict] = {}
    _model_cache_lock = threading.Lock()

    def __init__(self):
        self.model = None
        self.model_path = None

    def load_model(self, model_path=None):
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
                    raise ValueError(f"Unexpected BiRefNet output shape: {tuple(result.shape)}")

                result = result.to(device=image_tensor.device, dtype=torch.float32)
                if result.shape[-2:] != original_size:
                    result = F.interpolate(
                        result,
                        size=original_size,
                        mode="bilinear",
                        align_corners=False,
                    )
                result = result.clamp(0.0, 1.0)
                log.debug(f"Native BiRefNet output shape: {result.shape}, dtype: {result.dtype}")

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


_matting_lock = None


async def check_matting_model(request):
    """Report whether the selected native BiRefNet checkpoint is ready."""
    try:
        if _get_comfy_birefnet_loader() is None:
            return web.json_response({
                "available": False,
                "reason": "unsupported_comfyui",
                "message": "This ComfyUI version does not provide the native BiRefNet background-removal loader.",
            })

        model_options = _get_birefnet_model_options()
        requested_model = request.query.get("model_path") or "auto"
        remote_model = _get_birefnet_remote_model(requested_model)

        if remote_model:
            local_model_path = _find_existing_birefnet_remote_checkpoint(remote_model)
            if local_model_path:
                log.info(f"Selected BiRefNet model is ready at {local_model_path}")
                return web.json_response({
                    "available": True,
                    "reason": "ready",
                    "message": "Selected model is ready to use",
                    "model_path": local_model_path,
                    "selected_model": remote_model["label"],
                    "models": model_options,
                })

            log.info(f"Selected BiRefNet model is not downloaded: {remote_model['label']}")
            return web.json_response({
                "available": False,
                "reason": "not_downloaded",
                "message": f"{remote_model['label']} will be downloaded automatically on first use.",
                "model_path": requested_model,
                "selected_model": remote_model["label"],
                "models": model_options,
            })

        if requested_model != "auto":
            local_model_path = _find_local_birefnet_model(requested_model)
            if local_model_path:
                log.info(f"Selected BiRefNet model is ready at {local_model_path}")
                return web.json_response({
                    "available": True,
                    "reason": "ready",
                    "message": "Selected model is ready to use",
                    "model_path": local_model_path,
                    "selected_model": local_model_path,
                    "models": model_options,
                })

            return web.json_response({
                "available": False,
                "reason": "selected_model_unavailable",
                "message": "The selected BiRefNet checkpoint is not available or is not compatible with ComfyUI.",
                "model_path": requested_model,
                "models": model_options,
            })

        local_model_path = _find_local_birefnet_model()
        if local_model_path:
            log.info(f"BiRefNet model files detected at {local_model_path}")
            return web.json_response({
                "available": True,
                "reason": "ready",
                "message": "Model is ready to use",
                "model_path": local_model_path,
                "models": model_options,
            })

        searched_paths = _get_birefnet_base_paths()
        log.info(f"BiRefNet model not found in any of: {searched_paths}")
        return web.json_response({
            "available": False,
            "reason": "not_downloaded",
            "message": "The BiRefNet checkpoint will be downloaded automatically on first use (requires internet connection).",
            "model_path": searched_paths[0] if searched_paths else None,
            "models": model_options,
        })
    except Exception as error:
        log.error(f"Error checking matting model: {error}")
        return web.json_response({
            "available": False,
            "reason": "error",
            "message": f"Error checking model status: {error}",
        }, status=500)


async def matting(request):
    global _matting_lock

    if _matting_lock is not None:
        log.warning("Matting already in progress, rejecting request")
        return web.json_response({
            "error": "Another matting operation is in progress",
            "details": "Please wait for the current operation to complete",
        }, status=429)

    _matting_lock = True
    try:
        log.info("Received matting request")
        data = await request.json()
        matting_instance = BiRefNetMatting()
        image_tensor, original_alpha = convert_base64_to_tensor(data["image"])
        log.debug(f"Input image shape: {image_tensor.shape}")

        mode = data.get("mode", "remove_background")
        model_path = data.get("model_path") or "auto"
        matted_image, alpha_mask = matting_instance.execute(
            image_tensor,
            model_path,
            threshold=data.get("threshold", 0.5),
            refinement=data.get("refinement", 1),
            mode=mode,
        )

        if mode == "mask_only":
            result_image = convert_tensor_to_base64(alpha_mask)
        else:
            result_image = convert_tensor_to_base64(matted_image, alpha_mask, original_alpha)
        result_mask = convert_tensor_to_base64(alpha_mask)
        # Draw Mask uses white pixels as the area to remove, while matting uses
        # white pixels as the area to keep.
        draw_mask = 1.0 - alpha_mask

        return web.json_response({
            "matted_image": result_image,
            "alpha_mask": result_mask,
            "draw_mask": convert_tensor_to_base64(draw_mask),
            "mode": mode,
            "model_path": matting_instance.model_path,
        })
    except RuntimeError as error:
        log.error(f"Runtime error during matting: {error}")
        return web.json_response({
            "error": "Matting Model Error",
            "details": str(error),
        }, status=500)
    except Exception as error:
        log.exception(f"Error in matting endpoint: {error}")
        error_text = str(error).lower()
        if any(marker in error_text for marker in (
            "offline", "connection", "timed out", "huggingface", "localentrynotfound"
        )):
            return web.json_response({
                "error": "Network Connection Error",
                "details": "Failed to download the BiRefNet model from Hugging Face. Please check your internet connection.",
            }, status=400)

        return web.json_response({
            "error": "An unexpected error occurred",
            "details": traceback.format_exc(),
        }, status=500)
    finally:
        _matting_lock = None
        log.debug("Matting lock released")


def register_matting_routes():
    """Register matting endpoints without import-time decorators."""
    PromptServer.instance.routes.get("/matting/check-model")(check_matting_model)
    PromptServer.instance.routes.post("/matting")(matting)


__all__ = [
    "_BIREFNET_DEFAULT_LOCAL_FILENAME",
    "_BIREFNET_FILENAME",
    "_BIREFNET_MODEL_CATALOG",
    "_BIREFNET_PROJECT_URL",
    "_BIREFNET_REMOTE_PREFIX",
    "BiRefNetMatting",
    "_download_birefnet_checkpoint",
    "_ensure_birefnet_checkpoint",
    "_find_existing_birefnet_default_checkpoint",
    "_find_existing_birefnet_remote_checkpoint",
    "_find_local_birefnet_model",
    "_get_birefnet_model_options",
    "_get_comfy_birefnet_loader",
    "_is_native_birefnet_checkpoint",
    "check_matting_model",
    "matting",
    "register_matting_routes",
]
