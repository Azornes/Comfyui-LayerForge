"""Model-directory and checkpoint-path helpers shared by matting backends."""

import os

import folder_paths

from .catalog import _BIREFNET_DEFAULT_LOCAL_FILENAME, _BIREFNET_MODEL_CATALOG, _RMBG_MODEL_CATALOG


def _get_birefnet_base_paths():
    """Return the current ComfyUI background-removal model locations."""
    paths = []
    get_folder_paths = getattr(folder_paths, "get_folder_paths", None)
    if callable(get_folder_paths):
        try:
            paths.extend(get_folder_paths("background_removal"))
        except (KeyError, TypeError):
            pass

    comfy_models_dir = getattr(folder_paths, "models_dir", None)
    if comfy_models_dir:
        paths.append(os.path.join(comfy_models_dir, "background_removal"))

    unique_paths = []
    seen = set()
    for path in paths:
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized not in seen:
            seen.add(normalized)
            unique_paths.append(path)
    return unique_paths


def _get_birefnet_remote_checkpoint_path(model):
    """Return the managed local path for a catalog BiRefNet model."""
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None
    return os.path.join(base_paths[0], model["local_filename"])


def _get_rmbg_model_directory(model):
    """Return the managed directory containing a local BRIA RMBG model."""
    base_paths = _get_birefnet_base_paths()
    if not base_paths:
        return None
    return os.path.join(base_paths[0], model["local_directory"])


def _get_rmbg_model_roots(base_paths=None):
    """Return normalized roots reserved for managed BRIA RMBG model files."""
    base_paths = _get_birefnet_base_paths() if base_paths is None else base_paths
    return {
        os.path.normcase(os.path.normpath(os.path.abspath(path)))
        for base_path in base_paths
        for model in _RMBG_MODEL_CATALOG
        for path in [os.path.join(base_path, model["local_directory"])]
    }


def _get_birefnet_download_dir():
    """Return and create the shared ComfyUI background-removal directory."""
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


def _get_managed_birefnet_paths(base_paths=None):
    """Return normalized paths reserved for catalog BiRefNet checkpoints."""
    base_paths = _get_birefnet_base_paths() if base_paths is None else base_paths
    return {
        os.path.normcase(os.path.normpath(os.path.abspath(path)))
        for base_path in base_paths
        for model in _BIREFNET_MODEL_CATALOG
        for path in [os.path.join(base_path, model["local_filename"])]
    }


__all__ = [
    "_get_birefnet_base_paths",
    "_get_birefnet_default_checkpoint_path",
    "_get_birefnet_download_dir",
    "_get_birefnet_remote_checkpoint_path",
    "_get_managed_birefnet_paths",
    "_get_rmbg_model_directory",
    "_get_rmbg_model_roots",
]
