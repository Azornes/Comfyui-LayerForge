"""
@author: Azornes
@title: AzLogs
@version: 2.0.1
@description: Logging Initializer
"""
import logging
import os
import traceback

_logger = logging.getLogger(__name__)
_initialized = False
_project_root = None
_default_module_name = __name__

try:
    from .config import LOG_LEVEL, LOG_MODULE_NAME, PROJECT_ALIASES, USE_COLORS
    from .logger import LogLevel, debug, error, exception, fatal, info, logger, warn

    def _find_project_root(start_path):
        current = os.path.dirname(os.path.abspath(start_path))
        while current:
            if os.path.isdir(os.path.join(current, ".git")):
                return current
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        return os.path.dirname(os.path.dirname(os.path.abspath(start_path)))

    _project_root = _find_project_root(__file__)
    _default_module_name = (
        LOG_MODULE_NAME
        if LOG_MODULE_NAME is not None
        else os.path.basename(_project_root)
    )

    logger.set_global_level(LogLevel[LOG_LEVEL])

    logger.configure(
        {
            "log_to_file": True,
            "log_dir": os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"),
            "use_colors": (
                    logger.config["use_colors"]
                    if "AZLOGS_USE_COLORS" in os.environ
                    else USE_COLORS
            ),
        }
    )

    _initialized = True
except ImportError as e:
    _initialized = False
    _logger.error(f"Failed to initialize logger: {e}")
    # Provide fallback values when import fails
    LOG_MODULE_NAME = None
    PROJECT_ALIASES = []


def _normalize_module_name(module_name):
    """Normalize a dotted module name for display in logs.

    Strips common prefixes (custom_nodes, project aliases) and ``__init__``
    suffixes to produce a clean, readable module path.

    ComfyUI sets ``__name__`` to hybrid values like
    ``E:\\...\\comfyui-model-resolver.core.sources.model_list`` where the
    first dotted segment is a full OS path.  We detect this and convert
    the path portion to a dotted name before applying the normal logic.
    """
    module_name = str(module_name or "").strip()
    if not module_name or module_name == "__main__":
        return _default_module_name

    # --- path-to-dots conversion (required for ComfyUI's __name__) ---
    if os.sep in module_name or "/" in module_name:
        # Replace all path separators with dots so the rest of the logic
        # can work uniformly on dotted segments.
        normalized = module_name.replace("\\", ".").replace("/", ".")
        # Remove drive letter prefix (e.g. "E:." → "")
        if len(normalized) >= 2 and normalized[1] == ":":
            normalized = normalized[2:].lstrip(".")
        # Strip .py extension if present
        if normalized.endswith(".py"):
            normalized = normalized[:-3]
        module_name = normalized

    parts = [p for p in module_name.split(".") if p]
    if not parts:
        return _default_module_name

    # Strip __init__ suffix
    if parts[-1] == "__init__":
        parts = parts[:-1]

    # Strip LOG_MODULE_NAME prefix if present (re-added later)
    if LOG_MODULE_NAME and parts and parts[0] == LOG_MODULE_NAME:
        parts = parts[1:]

    # Strip custom_nodes.<package_name> prefix
    if "custom_nodes" in parts:
        idx = parts.index("custom_nodes")
        parts = parts[idx + 2:]  # skip custom_nodes + package folder

    # Strip project aliases from config
    for alias in PROJECT_ALIASES:
        if alias in parts:
            parts = parts[parts.index(alias) + 1:]
            break

    # Re-insert LOG_MODULE_NAME prefix at the start
    package_name = LOG_MODULE_NAME or os.path.basename(_project_root or "")
    if package_name and (not parts or parts[0] != package_name):
        parts.insert(0, package_name)

    cleaned = ".".join(parts).strip(".")
    return cleaned or _default_module_name


# Number of internal call frames between ModuleLogger methods and
# Python's logging.Logger.log().  Used to compute the correct
# ``stacklevel`` so that log records report the *caller's* file and
# line number instead of an internal wrapper.
#
# Call chain: ModuleLogger.method → module-level func → AzLogsLogger.log → logging.Logger.log
_INTERNAL_FRAMES = 3


class ModuleLogger:
    """Per-module logger with a fixed module name.

    Usage:
        log = create_module_logger(__name__)
        log.debug("message")
        log.info("message")
        log.info("downloaded", extra={"model": "xyz"})
    """

    def __init__(self, module_name):
        self.module_name = module_name

    def debug(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            debug(self.module_name, *args, **kwargs)
        else:
            print(f"[DEBUG] [{self.module_name}]", *args)

    def info(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            info(self.module_name, *args, **kwargs)
        else:
            print(f"[INFO] [{self.module_name}]", *args)

    def warning(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            warn(self.module_name, *args, **kwargs)
        else:
            print(f"[WARN] [{self.module_name}]", *args)

    def warn(self, *args, **kwargs):
        self.warning(*args, **kwargs)

    def error(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            error(self.module_name, *args, **kwargs)
        else:
            print(f"[ERROR] [{self.module_name}]", *args)

    def exception(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            exception(self.module_name, *args, **kwargs)
        else:
            print(f"[ERROR] [{self.module_name}]", *args)
            traceback.print_exc()

    def fatal(self, *args, **kwargs):
        if _initialized:
            kwargs["stacklevel"] = kwargs.pop("stacklevel", 1) + _INTERNAL_FRAMES
            fatal(self.module_name, *args, **kwargs)
        else:
            print(f"[FATAL] [{self.module_name}]", *args)


def create_module_logger(module_name=None):
    """Create a ModuleLogger with a normalized module name.

    Args:
        module_name: Dotted module name, typically ``__name__``.
            Required for proper module identification.

    Returns:
        A :class:`ModuleLogger` instance.
    """
    resolved_name = _normalize_module_name(module_name or _default_module_name)
    return ModuleLogger(resolved_name)
