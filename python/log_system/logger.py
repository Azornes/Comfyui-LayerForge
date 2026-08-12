"""
@author: Azornes
@title: AzLogs
@version: 2.0.1
@description: Logging Setup - Central logging system

Features:
- Different log levels (DEBUG, INFO, WARN, ERROR)
- Ability to enable/disable logs globally or per module
- Colored logs in console
- Log file rotation
- Configuration via environment variables
"""
import json
import logging
import os
import re
import sys
import threading
import time
import traceback
from enum import IntEnum
from logging.handlers import RotatingFileHandler


# Log levels
class LogLevel(IntEnum):
    DEBUG = 10
    INFO = 20
    WARN = 30
    ERROR = 40
    FATAL = 50
    NONE = 100


# Level mapping
LEVEL_MAP = {
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.WARN: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
    LogLevel.FATAL: logging.CRITICAL,
    LogLevel.NONE: logging.CRITICAL + 1,
}

# ANSI reset sequence (all coloring uses LEVEL_THEME RGB values)
ANSI_RESET = "\033[0m"

# RGB color theme per log level
LEVEL_THEME = {
    "DEBUG": (155, 89, 182),     # #9B59B6
    "INFO": (46, 204, 113),      # #2ECC71
    "WARN": (243, 156, 18),      # #F39C12
    "ERROR": (192, 57, 43),      # #C0392B
    "FATAL": (231, 76, 60),      # #E74C3C — brighter red than ERROR
}

# Default configuration
DEFAULT_CONFIG = {
    "global_level": LogLevel.INFO,
    "module_settings": {},
    "use_colors": True,
    "log_to_file": False,
    "log_dir": "logs",
    "max_file_size_mb": 10,
    "backup_count": 5,
    "timestamp_format": "%H:%M:%S",
    "level_field_width": 5,
    "source_field_width": 0,
}


_WINDOWS_VT_PROCESSING_ENABLED = False


def rotated_log_filename(default_name):
    """Keep the .log extension at the end of rotated log filenames."""
    match = re.fullmatch(r"(.+)\.log\.(\d+)", str(default_name or ""))
    if not match:
        return default_name
    return f"{match.group(1)}.{match.group(2)}.log"


def parse_rotated_log_filename(filename):
    """Return the log family and rotation number for the current filename style."""
    name = os.path.basename(str(filename or ""))
    match = re.fullmatch(r"(.+)\.(\d+)\.log", name)
    if match:
        return match.group(1), int(match.group(2))

    if name.endswith(".log"):
        return name[:-4], 0
    return None


def _enable_windows_virtual_terminal_processing():
    """Enable ANSI escape sequence handling for classic Windows consoles."""
    global _WINDOWS_VT_PROCESSING_ENABLED
    if _WINDOWS_VT_PROCESSING_ENABLED or os.name != "nt":
        return

    try:
        import ctypes

        enable_virtual_terminal_processing = 0x0004
        std_handles = (-11, -12)
        invalid_handle_value = ctypes.c_void_p(-1).value

        kernel32 = ctypes.windll.kernel32
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        enabled_any = False
        for std_handle in std_handles:
            handle = kernel32.GetStdHandle(std_handle)
            if handle in (None, 0, invalid_handle_value):
                continue

            mode = ctypes.c_uint32()
            if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                continue

            new_mode = mode.value | enable_virtual_terminal_processing
            if new_mode != mode.value:
                kernel32.SetConsoleMode(handle, new_mode)

            enabled_any = True

        _WINDOWS_VT_PROCESSING_ENABLED = enabled_any
    except Exception:
        return


def _get_console_output_stream():
    """Return the console stream that preserves ANSI colors under wrapped launchers."""
    for stream_name in ("__stdout__", "__stderr__", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        if getattr(stream, "closed", False):
            continue
        return stream
    return None


class SafeRotatingFileHandler(RotatingFileHandler):
    """Rotating file handler that disables itself if a launcher breaks its stream."""

    def __init__(self, *args, **kwargs):
        self._disabled_by_stream_error = False
        super().__init__(*args, **kwargs)
        self.namer = rotated_log_filename

    def emit(self, record):
        if self._disabled_by_stream_error:
            return

        try:
            if self.stream is not None and self.maxBytes > 0:
                tell = getattr(self.stream, "tell", None)
                if not callable(tell):
                    raise OSError(
                        "Log file stream does not support tell(); disabling file logs"
                    )
            super().emit(record)
        except Exception:
            self.handleError(record)

    def handleError(self, record):
        self._disabled_by_stream_error = True
        try:
            self.close()
        except Exception:
            pass


class DirectConsoleHandler(logging.Handler):
    """Console handler that writes directly to the original console stream."""

    terminator = "\n"

    def __init__(self, stream=None):
        super().__init__()
        self.stream = stream

    def emit(self, record):
        try:
            stream = self.stream or _get_console_output_stream()
            if stream is None:
                return
            stream.write(self.format(record) + self.terminator)
            stream.flush()
        except Exception:
            self.handleError(record)


class ColoredFormatter(logging.Formatter):
    """Formatter that adds colors to console logs"""

    def __init__(
        self,
        fmt=None,
        datefmt=None,
        use_colors=True,
        level_field_width=DEFAULT_CONFIG["level_field_width"],
        source_field_width=DEFAULT_CONFIG["source_field_width"],
        include_milliseconds=True,
        include_brackets=True,
    ):
        super().__init__(fmt, datefmt)
        self.use_colors = use_colors
        self.level_field_width = self._field_width(level_field_width)
        self.source_field_width = self._field_width(source_field_width)
        self.include_milliseconds = include_milliseconds
        self.include_brackets = include_brackets

    def format(self, record):
        # Get the formatted message from the record
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + self.formatException(record.exc_info)

        levelname = self._display_level_name(record.levelname)
        level = self._format_level(levelname)
        logger_name = self._display_logger_name(record.name)
        logger_root, logger_detail = self._split_logger_name(logger_name)
        source = (
            f"({logger_detail}:{record.lineno})"
            if logger_detail
            else f"({logger_root}:{record.lineno})"
        )
        if self.source_field_width:
            source = source.ljust(self.source_field_width)

        timestamp = self._format_time(record)
        separator = " "
        root_label = logger_root
        if self.include_brackets:
            timestamp = f"[{timestamp}]"
            root_label = f"[{root_label}]"
        if self.use_colors:
            level = self._color_level_badge(levelname, level)
            timestamp = self._color_context_badge(timestamp)
            root_label = self._color_context_badge(root_label)
            separator = self._color_separator(levelname, separator)
            message = self._color_message(levelname, message)
            return f"{level}{timestamp}{separator}{root_label}{separator} {message} {source}"

        return f"{level} {timestamp} {root_label} {message} {source}"

    def _field_width(self, value):
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    def _display_logger_name(self, name):
        return str(name or "").removeprefix("azlogs.")

    def _split_logger_name(self, name):
        parts = str(name or "").split(".", 1)
        if len(parts) == 1:
            return parts[0], ""
        return parts[0], parts[1]

    def _display_level_name(self, levelname):
        name = str(levelname or "")
        if name == "WARNING":
            return "WARN"
        if name == "CRITICAL":
            return "FATAL"
        return name

    def _format_level(self, levelname):
        if self.include_brackets:
            width = self.level_field_width + 2
            return f"[{levelname}]".ljust(width)
        return levelname.ljust(self.level_field_width)

    def _format_time(self, record):
        timestamp = time.strftime(
            self.datefmt or "%H:%M:%S", self.converter(record.created)
        )
        if self.include_milliseconds:
            return f"{timestamp}.{int(record.msecs):03d}"
        return timestamp

    def _color_level_badge(self, levelname, text):
        rgb = LEVEL_THEME.get(levelname)
        if not rgb:
            return text
        r, g, b = rgb
        return f"\033[1;97;48;2;{r};{g};{b}m {text} {ANSI_RESET}"

    def _color_context_badge(self, text):
        return f"\033[97;48;2;38;63;76m {text} {ANSI_RESET}"

    def _color_separator(self, levelname, text):
        rgb = LEVEL_THEME.get(levelname)
        if not rgb:
            return text
        r, g, b = rgb
        return f"\033[48;2;{r};{g};{b}m{text}{ANSI_RESET}"

    def _color_message(self, levelname, text):
        rgb = LEVEL_THEME.get(levelname)
        if not rgb:
            # Fallback: cyan for unknown levels
            return f"\033[96m{text}{ANSI_RESET}"
        r, g, b = rgb
        return f"\033[38;2;{r};{g};{b}m{text}{ANSI_RESET}"


class AzLogsLogger:
    """Main logger class for AzLogs"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.config = DEFAULT_CONFIG.copy()
        self.enabled = True
        self.loggers = {}
        self.file_handlers = {}
        self._lock = threading.RLock()

        # Load configuration from environment variables
        self._load_config_from_env()

        self._initialized = True

    def _load_config_from_env(self):
        """Load configuration from environment variables"""

        # Global level
        if "AZLOGS_LOG_LEVEL" in os.environ:
            level_name = os.environ["AZLOGS_LOG_LEVEL"].upper()
            if hasattr(LogLevel, level_name):
                self.config["global_level"] = getattr(LogLevel, level_name)

        # Module settings
        if "AZLOGS_MODULE_LEVELS" in os.environ:
            try:
                module_settings = json.loads(os.environ["AZLOGS_MODULE_LEVELS"])
                for module, level_name in module_settings.items():
                    if hasattr(LogLevel, level_name.upper()):
                        self.config["module_settings"][module] = getattr(
                            LogLevel, level_name.upper()
                        )
            except json.JSONDecodeError:
                pass

        # Other settings
        if "AZLOGS_USE_COLORS" in os.environ:
            self.config["use_colors"] = (
                os.environ["AZLOGS_USE_COLORS"].lower() == "true"
            )

        if "AZLOGS_LOG_TO_FILE" in os.environ:
            self.config["log_to_file"] = (
                os.environ["AZLOGS_LOG_TO_FILE"].lower() == "true"
            )

        if "AZLOGS_LOG_DIR" in os.environ:
            self.config["log_dir"] = os.environ["AZLOGS_LOG_DIR"]

        if "AZLOGS_MAX_FILE_SIZE_MB" in os.environ:
            try:
                self.config["max_file_size_mb"] = int(
                    os.environ["AZLOGS_MAX_FILE_SIZE_MB"]
                )
            except ValueError:
                pass

        if "AZLOGS_BACKUP_COUNT" in os.environ:
            try:
                self.config["backup_count"] = int(os.environ["AZLOGS_BACKUP_COUNT"])
            except ValueError:
                pass

    def configure(self, config):
        """Configure the logger"""
        self.config.update(config)
        self.reset_loggers()

        if self.config.get("use_colors"):
            _enable_windows_virtual_terminal_processing()

        # If file logging is enabled, ensure the directory exists
        if self.config.get("log_to_file") and self.config.get("log_dir"):
            try:
                os.makedirs(self.config["log_dir"], exist_ok=True)
            except OSError as e:
                # This is a fatal situation, so use print
                print(
                    f"[FATAL] Could not create log directory: {self.config['log_dir']}. Error: {e}"
                )
                traceback.print_exc()
                # Disable file logging to avoid further errors
                self.config["log_to_file"] = False

        return self

    def set_enabled(self, enabled):
        """Enable/disable the logger globally"""
        self.enabled = enabled
        return self

    def set_global_level(self, level):
        """Set global logging level"""
        self.config["global_level"] = level
        return self

    def set_module_level(self, module, level):
        """Set logging level for a specific module"""
        self.config["module_settings"][module] = level
        return self

    def is_level_enabled(self, module, level):
        """Check if a given logging level is active for the module"""
        if not self.enabled:
            return False

        # Determine effective logging level, considering module and global settings
        effective_level = self.config["module_settings"].get(
            module, self.config["global_level"]
        )

        # If effective level is NONE, logging is completely disabled
        if effective_level == LogLevel.NONE:
            return False

        # Otherwise check if log level is high enough
        return level >= effective_level

    def _sanitize_logger_name(self, value):
        """Sanitize logger/module names for safe filesystem usage."""
        sanitized = re.sub(r'[<>:"/\\|?*\s]+', "_", str(value or "")).strip("._")
        return sanitized or "default"

    def _root_module_name(self, module):
        """Return the top-level logger name used for shared log files."""
        return str(module or "default").split(".", 1)[0] or "default"

    def _get_log_file(self, module):
        safe_root = self._sanitize_logger_name(self._root_module_name(module))
        return os.path.join(self.config["log_dir"], f"azlogs_{safe_root}.log")

    def _get_file_handler(self, module):
        """Get or create a shared rotating file handler for the root module."""
        log_file = self._get_log_file(module)
        # Fast path without lock
        if log_file in self.file_handlers:
            return self.file_handlers[log_file]

        with self._lock:
            # Double-check after acquiring lock
            if log_file in self.file_handlers:
                return self.file_handlers[log_file]

            os.makedirs(self.config["log_dir"], exist_ok=True)
            file_handler = SafeRotatingFileHandler(
                log_file,
                maxBytes=self.config["max_file_size_mb"] * 1024 * 1024,
                backupCount=self.config["backup_count"],
                encoding="utf-8",
            )
            file_formatter = ColoredFormatter(
                datefmt="%Y-%m-%d %H:%M:%S",
                use_colors=False,
                source_field_width=self.config["source_field_width"],
                include_milliseconds=True,
            )
            file_handler.setFormatter(file_formatter)
            self.file_handlers[log_file] = file_handler
            return file_handler

    def reset_loggers(self):
        """Remove configured handlers so new settings are applied cleanly."""
        with self._lock:
            handlers_to_close = set()

            for module in self.loggers:
                configured_logger = logging.getLogger(f"azlogs.{module}")
                for handler in list(configured_logger.handlers):
                    configured_logger.removeHandler(handler)
                    if isinstance(handler, RotatingFileHandler):
                        handlers_to_close.add(handler)

            for handler in self.file_handlers.values():
                handlers_to_close.add(handler)

            for handler in handlers_to_close:
                handler.close()

            self.loggers = {}
            self.file_handlers = {}
        return self

    def _get_logger(self, module):
        """Get or create a logger for the module"""
        # Fast path without lock
        if module in self.loggers:
            return self.loggers[module]

        with self._lock:
            # Double-check after acquiring lock
            if module in self.loggers:
                return self.loggers[module]

            # Create new logger
            new_logger = logging.getLogger(f"azlogs.{module}")
            new_logger.setLevel(logging.DEBUG)  # Set lowest level, filtering will be done later
            new_logger.propagate = False

            # Add console handler
            if self.config["use_colors"]:
                _enable_windows_virtual_terminal_processing()

            console_stream = _get_console_output_stream()
            console_handler = DirectConsoleHandler(console_stream)
            console_formatter = ColoredFormatter(
                fmt="[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s",
                datefmt=self.config["timestamp_format"],
                use_colors=self.config["use_colors"],
                level_field_width=self.config["level_field_width"],
                source_field_width=self.config["source_field_width"],
                include_brackets=False,
            )
            console_handler.setFormatter(console_formatter)
            new_logger.addHandler(console_handler)

            # Add file handler if file logging is enabled
            if self.config["log_to_file"]:
                try:
                    file_handler = self._get_file_handler(module)
                    new_logger.addHandler(file_handler)
                except OSError as e:
                    self.config["log_to_file"] = False
                    new_logger.warning(
                        "AzLogs: disabling file logging after handler setup failed for %s: %s",
                        self._get_log_file(module),
                        e,
                    )

            self.loggers[module] = new_logger
            return new_logger

    def log(self, module, level, *args, **kwargs):
        """Write log"""
        if not self.is_level_enabled(module, level):
            return

        logger = self._get_logger(module)

        # Convert arguments to string
        message = " ".join(str(arg) for arg in args)

        # Extract known kwargs
        exc_info = kwargs.get("exc_info")
        stacklevel = kwargs.get("stacklevel", 1)
        extra = kwargs.get("extra")

        # Map LogLevel to logging level
        log_level = LEVEL_MAP.get(level, logging.INFO)

        # Write log
        logger.log(log_level, message, exc_info=exc_info, stacklevel=stacklevel, extra=extra)

    def debug(self, module, *args, **kwargs):
        """Log at DEBUG level"""
        self.log(module, LogLevel.DEBUG, *args, **kwargs)

    def info(self, module, *args, **kwargs):
        """Log at INFO level"""
        self.log(module, LogLevel.INFO, *args, **kwargs)

    def warn(self, module, *args, **kwargs):
        """Log at WARN level"""
        self.log(module, LogLevel.WARN, *args, **kwargs)

    def error(self, module, *args, **kwargs):
        """Log at ERROR level"""
        self.log(module, LogLevel.ERROR, *args, **kwargs)

    def exception(self, module, *args, **kwargs):
        """Log exception at ERROR level"""
        kwargs["exc_info"] = True
        self.log(module, LogLevel.ERROR, *args, **kwargs)

    def fatal(self, module, *args, **kwargs):
        """Log at FATAL level"""
        self.log(module, LogLevel.FATAL, *args, **kwargs)


# Singleton
logger = AzLogsLogger()


# Helper functions
def debug(module, *args, **kwargs):
    """Log at DEBUG level"""
    logger.log(module, LogLevel.DEBUG, *args, **kwargs)


def info(module, *args, **kwargs):
    """Log at INFO level"""
    logger.log(module, LogLevel.INFO, *args, **kwargs)


def warn(module, *args, **kwargs):
    """Log at WARN level"""
    logger.log(module, LogLevel.WARN, *args, **kwargs)


def error(module, *args, **kwargs):
    """Log at ERROR level"""
    logger.log(module, LogLevel.ERROR, *args, **kwargs)


def exception(module, *args, **kwargs):
    """Log exception at ERROR level"""
    kwargs["exc_info"] = True
    logger.log(module, LogLevel.ERROR, *args, **kwargs)


def fatal(module, *args, **kwargs):
    """Log at FATAL level"""
    logger.log(module, LogLevel.FATAL, *args, **kwargs)


# Function to quickly enable/disable debugging
def set_debug(enabled=True):
    """Enable/disable debugging globally"""
    if enabled:
        logger.set_global_level(LogLevel.DEBUG)
    else:
        logger.set_global_level(LogLevel.INFO)
    return logger


# Function to enable/disable file logging
def set_file_logging(enabled=True, log_dir=None):
    """Enable/disable logging to file"""
    logger.config["log_to_file"] = enabled
    if log_dir:
        logger.config["log_dir"] = log_dir
        os.makedirs(log_dir, exist_ok=True)

    # Reset loggers to apply new settings
    logger.reset_loggers()
    return logger
