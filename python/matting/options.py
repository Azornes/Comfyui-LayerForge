"""Model-selector options assembled from local files and supported catalogs."""

import os

from .backends.birefnet import (
    _find_existing_birefnet_default_checkpoint,
    _find_existing_birefnet_remote_checkpoint,
    _is_native_birefnet_checkpoint,
    _iter_birefnet_checkpoint_paths,
)
from .backends.rmbg import _find_existing_rmbg_model
from .catalog import _BIREFNET_MODEL_CATALOG, _BIREFNET_PROJECT_URL, _BIREFNET_REMOTE_PREFIX
from .catalog import _RMBG_MODEL_CATALOG, _RMBG_REMOTE_PREFIX
from .paths import _get_birefnet_base_paths, _get_managed_birefnet_paths, _get_rmbg_model_roots


def _is_path_under_root(path, root):
    normalized_path = os.path.normcase(os.path.normpath(os.path.abspath(path)))
    return normalized_path == root or normalized_path.startswith(root + os.sep)


def _get_birefnet_model_options():
    """Return local models and official BiRefNet/RMBG models for the selector."""
    _find_existing_birefnet_default_checkpoint()

    local_options = []
    seen = set()
    base_paths = _get_birefnet_base_paths()
    managed_paths = _get_managed_birefnet_paths(base_paths)
    managed_rmbg_roots = _get_rmbg_model_roots(base_paths)

    for path in _iter_birefnet_checkpoint_paths():
        normalized = os.path.normcase(os.path.normpath(os.path.abspath(path)))
        if normalized in seen or not _is_native_birefnet_checkpoint(path):
            continue
        if normalized in managed_paths or any(
            _is_path_under_root(path, root) for root in managed_rmbg_roots
        ):
            continue

        seen.add(normalized)
        label = os.path.basename(path)
        for base_path in base_paths:
            try:
                relative_path = os.path.relpath(path, base_path)
            except ValueError:
                continue
            if relative_path == os.pardir or relative_path.startswith(os.pardir + os.sep):
                continue
            label = relative_path.replace(os.sep, "/")
            break

        local_options.append(
            {
                "path": path,
                "label": label,
                "source": "local",
                "backend": "birefnet",
                "downloaded": True,
            }
        )

    for model in _RMBG_MODEL_CATALOG:
        model_directory = _find_existing_rmbg_model(model)
        if not model_directory:
            continue
        local_options.append(
            {
                "path": model_directory,
                "label": model["label"],
                "description": model["description"],
                "url": model["url"],
                "project_url": model["project_url"],
                "source": "local",
                "backend": model["backend"],
                "downloaded": True,
            }
        )

    remote_options = []
    for model in _BIREFNET_MODEL_CATALOG:
        checkpoint_path = _find_existing_birefnet_remote_checkpoint(model)
        remote_options.append(
            {
                "path": f"{_BIREFNET_REMOTE_PREFIX}{model['id']}",
                "label": model["label"],
                "description": model["description"],
                "url": f"https://huggingface.co/{model['repo_id']}",
                "project_url": _BIREFNET_PROJECT_URL,
                "source": "remote",
                "backend": "birefnet",
                "downloaded": bool(checkpoint_path and _is_native_birefnet_checkpoint(checkpoint_path)),
            }
        )

    for model in _RMBG_MODEL_CATALOG:
        model_directory = _find_existing_rmbg_model(model)
        remote_options.append(
            {
                "path": f"{_RMBG_REMOTE_PREFIX}{model['id']}",
                "label": model["label"],
                "description": model["description"],
                "url": model["url"],
                "project_url": model["project_url"],
                "source": "remote",
                "backend": model["backend"],
                "downloaded": bool(model_directory),
            }
        )

    local_options.sort(key=lambda option: option["label"].lower())
    return local_options + remote_options


__all__ = ["_get_birefnet_model_options"]
