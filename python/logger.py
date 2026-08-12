"""Backward-compatible exports for the LayerForge logging system.

The implementation lives in :mod:`python.log_system`, matching the Model
Resolver layout. Existing LayerForge imports can continue using
``python.logger`` while all callers share the same logger instance.
"""

from .log_system.logger import (
    ANSI_RESET,
    DEFAULT_CONFIG,
    LEVEL_MAP,
    LEVEL_THEME,
    AzLogsLogger,
    ColoredFormatter,
    DirectConsoleHandler,
    LogLevel,
    SafeRotatingFileHandler,
    logger,
    parse_rotated_log_filename,
    rotated_log_filename,
    set_debug,
    set_file_logging,
)
from .log_system.log_funcs import (
    create_module_logger,
    debug,
    error,
    exception,
    fatal,
    info,
    warn,
)

LayerForgeLogger = AzLogsLogger

__all__ = [
    "ANSI_RESET",
    "DEFAULT_CONFIG",
    "LEVEL_MAP",
    "LEVEL_THEME",
    "AzLogsLogger",
    "ColoredFormatter",
    "DirectConsoleHandler",
    "LayerForgeLogger",
    "LogLevel",
    "SafeRotatingFileHandler",
    "create_module_logger",
    "debug",
    "error",
    "exception",
    "fatal",
    "info",
    "logger",
    "parse_rotated_log_filename",
    "rotated_log_filename",
    "set_debug",
    "set_file_logging",
    "warn",
]
