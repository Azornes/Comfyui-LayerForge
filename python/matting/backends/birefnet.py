"""BiRefNet backend using ComfyUI's native background-removal loader."""

import os
import shutil

from ...node import log
from ..catalog import (
    _BIREFNET_DEFAULT_LOCAL_FILENAME,
    _BIREFNET_FILENAME,
    _BIREFNET_MODEL_CATALOG,
    _BIREFNET_REPOSITORY,
    _BIREFNET_REQUIRED_KEYS,
    _BIREFNET_REMOTE_PREFIX,
)
from ..paths import (
    _get_birefnet_base_paths,
    _get_birefnet_default_checkpoint_path,
    _get_birefnet_download_dir,
    _get_birefnet_remote_checkpoint_path,
    _get_rmbg_model_roots,
)
from ..settings import get_huggingface_token


def _get_comfy_birefnet_loader():
    """Return ComfyUI's native BiRefNet loader when it is available."""
    try:
        from comfy.bg_removal_model import load

        return load
    except Exception as error:
        log.debug(f"Native ComfyUI BiRefNet loader is unavailable: {error}")
        return None


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
    """Yield candidate checkpoints from current ComfyUI model directories."""
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
    managed_rmbg_roots = _get_rmbg_model_roots()
    for path in _iter_birefnet_checkpoint_paths():
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized in seen:
            continue
        seen.add(normalized)
        normalized_absolute = os.path.normcase(os.path.normpath(os.path.abspath(path)))
        if any(
            normalized_absolute == root or normalized_absolute.startswith(root + os.sep)
            for root in managed_rmbg_roots
        ):
            continue
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


def _find_existing_birefnet_remote_checkpoint(model):
    """Return an installed managed remote checkpoint, when available."""
    checkpoint_path = _get_birefnet_remote_checkpoint_path(model)
    if checkpoint_path and _is_native_birefnet_checkpoint(checkpoint_path):
        return checkpoint_path
    return None


def _find_existing_birefnet_default_checkpoint():
    """Return the automatic checkpoint when its current friendly filename exists."""
    checkpoint_path = _get_birefnet_default_checkpoint_path()
    if checkpoint_path and _is_native_birefnet_checkpoint(checkpoint_path):
        return checkpoint_path
    return None


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
        download_dir = _get_birefnet_download_dir()
        model_label = model["label"]
        target_path = _get_birefnet_remote_checkpoint_path(model)

    log.info(f"Downloading {model_label} from Hugging Face into {download_dir}...")
    download_kwargs = {
        "repo_id": repository,
        "filename": filename,
        "local_dir": download_dir,
        "local_dir_use_symlinks": False,
    }
    token = get_huggingface_token()
    if token:
        download_kwargs["token"] = token
    try:
        downloaded_path = hf_hub_download(**download_kwargs)
    except TypeError:
        download_kwargs.pop("local_dir_use_symlinks", None)
        downloaded_path = hf_hub_download(**download_kwargs)

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
    """Resolve or download the selected BiRefNet checkpoint."""
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


__all__ = [
    "_download_birefnet_checkpoint",
    "_ensure_birefnet_checkpoint",
    "_find_existing_birefnet_default_checkpoint",
    "_find_existing_birefnet_remote_checkpoint",
    "_find_local_birefnet_model",
    "_get_comfy_birefnet_loader",
    "_get_birefnet_remote_model",
    "_is_native_birefnet_checkpoint",
    "_iter_birefnet_checkpoint_paths",
]
