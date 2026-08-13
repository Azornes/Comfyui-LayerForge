"""Public compatibility facade for LayerForge background-removal support."""

import folder_paths
from aiohttp import web

from .api import (
    check_matting_model,
    get_matting_settings,
    matting,
    register_matting_routes,
    save_matting_settings,
)
from .backends.birefnet import (
    _download_birefnet_checkpoint,
    _ensure_birefnet_checkpoint,
    _find_existing_birefnet_default_checkpoint,
    _find_existing_birefnet_remote_checkpoint,
    _find_local_birefnet_model,
    _get_birefnet_remote_model,
    _get_comfy_birefnet_loader,
    _is_native_birefnet_checkpoint,
    _iter_birefnet_checkpoint_paths,
)
from .backends.rmbg import (
    RMBG2Model,
    _download_rmbg_model,
    _ensure_rmbg_model,
    _find_existing_rmbg_model,
    _find_local_rmbg_model,
    _get_rmbg_model_loader,
    _get_rmbg_model_status_message,
    _get_rmbg_transformers_status,
    _get_rmbg_remote_model,
    _is_rmbg_model_directory,
)
from .catalog import (
    _BIREFNET_DEFAULT_LOCAL_FILENAME,
    _BIREFNET_FILENAME,
    _BIREFNET_MODEL_CATALOG,
    _BIREFNET_PROJECT_URL,
    _BIREFNET_REMOTE_PREFIX,
    _BIREFNET_REPOSITORY,
    _BIREFNET_REQUIRED_KEYS,
    _RMBG_MODEL_CATALOG,
    _RMBG_REMOTE_PREFIX,
)
from .options import _get_birefnet_model_options
from .paths import (
    _get_birefnet_base_paths,
    _get_birefnet_default_checkpoint_path,
    _get_birefnet_download_dir,
    _get_birefnet_remote_checkpoint_path,
    _get_managed_birefnet_paths,
    _get_rmbg_model_directory,
    _get_rmbg_model_roots,
)
from .service import BiRefNetMatting
from .settings import (
    DEFAULT_SETTINGS,
    SETTINGS_FILE,
    get_huggingface_token,
    get_public_settings,
    load_settings,
    save_settings,
)


__all__ = [
    "BiRefNetMatting",
    "RMBG2Model",
    "check_matting_model",
    "get_matting_settings",
    "matting",
    "register_matting_routes",
    "save_matting_settings",
    "DEFAULT_SETTINGS",
    "SETTINGS_FILE",
    "get_huggingface_token",
    "get_public_settings",
    "load_settings",
    "save_settings",
    "_BIREFNET_DEFAULT_LOCAL_FILENAME",
    "_BIREFNET_FILENAME",
    "_BIREFNET_MODEL_CATALOG",
    "_BIREFNET_PROJECT_URL",
    "_BIREFNET_REMOTE_PREFIX",
    "_BIREFNET_REPOSITORY",
    "_BIREFNET_REQUIRED_KEYS",
    "_RMBG_MODEL_CATALOG",
    "_RMBG_REMOTE_PREFIX",
    "_download_birefnet_checkpoint",
    "_download_rmbg_model",
    "_ensure_birefnet_checkpoint",
    "_ensure_rmbg_model",
    "_find_existing_birefnet_default_checkpoint",
    "_find_existing_birefnet_remote_checkpoint",
    "_find_existing_rmbg_model",
    "_find_local_birefnet_model",
    "_find_local_rmbg_model",
    "_get_birefnet_model_options",
    "_get_birefnet_remote_checkpoint_path",
    "_get_birefnet_remote_model",
    "_get_comfy_birefnet_loader",
    "_get_rmbg_model_directory",
    "_get_rmbg_model_loader",
    "_get_rmbg_model_status_message",
    "_get_rmbg_transformers_status",
    "_get_rmbg_remote_model",
    "_is_native_birefnet_checkpoint",
    "_is_rmbg_model_directory",
]
