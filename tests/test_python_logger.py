import logging
import importlib
import sys

import pytest

from python.log_system.log_funcs import error, exception
from python.log_system.logger import (
    ColoredFormatter,
    LogLevel,
    logger,
    set_debug,
    set_file_logging,
)


@pytest.fixture(autouse=True)
def reset_logger_state():
    original_config = logger.config.copy()
    original_module_settings = logger.config["module_settings"].copy()
    original_enabled = logger.enabled

    logger.reset_loggers()
    logger.set_enabled(True)
    logger.config["module_settings"] = {}
    logger.config["log_to_file"] = False
    yield

    logger.reset_loggers()
    logger.config.clear()
    logger.config.update(original_config)
    logger.config["module_settings"] = original_module_settings
    logger.set_enabled(original_enabled)


def test_log_levels_honor_global_and_module_overrides():
    logger.set_global_level(LogLevel.INFO)

    assert not logger.is_level_enabled("test", LogLevel.DEBUG)
    assert logger.is_level_enabled("test", LogLevel.INFO)

    logger.set_module_level("test", LogLevel.DEBUG)
    assert logger.is_level_enabled("test", LogLevel.DEBUG)

    logger.set_module_level("test", LogLevel.NONE)
    assert not logger.is_level_enabled("test", LogLevel.ERROR)

    logger.set_enabled(False)
    assert not logger.is_level_enabled("other", LogLevel.ERROR)


def test_colored_formatter_contains_timestamp_module_and_level():
    record = logging.LogRecord(
        name="layerforge.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="hello %s",
        args=("world",),
        exc_info=None,
    )
    formatter = ColoredFormatter(datefmt="%H:%M:%S", use_colors=False)

    formatted = formatter.format(record)

    assert "[layerforge]" in formatted
    assert "[INFO]" in formatted
    assert "hello world" in formatted


def test_colored_formatter_includes_exception_details_and_color():
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.LogRecord(
            name="layerforge.test",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="failed",
            args=(),
            exc_info=sys.exc_info(),
        )

    formatter = ColoredFormatter(datefmt="%H:%M:%S", use_colors=True)
    formatted = formatter.format(record)

    assert "\x1b[1;97;" in formatted
    assert "ValueError: boom" in formatted


def test_environment_configuration_parses_valid_and_invalid_values(monkeypatch, tmp_path):
    monkeypatch.setenv("AZLOGS_LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("AZLOGS_MODULE_LEVELS", '{"canvas": "ERROR", "ignored": "unknown"}')
    monkeypatch.setenv("AZLOGS_USE_COLORS", "false")
    monkeypatch.setenv("AZLOGS_LOG_TO_FILE", "true")
    monkeypatch.setenv("AZLOGS_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("AZLOGS_MAX_FILE_SIZE_MB", "2")
    monkeypatch.setenv("AZLOGS_BACKUP_COUNT", "3")

    logger._load_config_from_env()

    assert logger.config["global_level"] == LogLevel.DEBUG
    assert logger.config["module_settings"]["canvas"] == LogLevel.ERROR
    assert logger.config["use_colors"] is False
    assert logger.config["log_to_file"] is True
    assert logger.config["max_file_size_mb"] == 2
    assert logger.config["backup_count"] == 3

    monkeypatch.setenv("AZLOGS_MODULE_LEVELS", "not-json")
    monkeypatch.setenv("AZLOGS_MAX_FILE_SIZE_MB", "not-an-int")
    monkeypatch.setenv("AZLOGS_BACKUP_COUNT", "not-an-int")
    logger._load_config_from_env()

    assert logger.config["module_settings"]["canvas"] == LogLevel.ERROR


def test_configure_disables_file_logging_when_directory_creation_fails(monkeypatch):
    def raise_os_error(*args, **kwargs):
        raise OSError("access denied")

    logger_module = importlib.import_module("python.log_system.logger")
    monkeypatch.setattr(logger_module.os, "makedirs", raise_os_error)
    monkeypatch.setattr(logger_module.traceback, "print_exc", lambda: None)

    logger.configure({"log_to_file": True, "log_dir": "blocked"})

    assert logger.config["log_to_file"] is False


def test_file_logging_writes_to_configured_directory(tmp_path):
    log_directory = tmp_path / "logs"
    set_file_logging(True, str(log_directory))
    logger.set_global_level(LogLevel.INFO)

    logger.info("file-test", "message")
    logger.info("file-test", "second message")

    log_files = list(log_directory.glob("azlogs_*.log"))
    assert len(log_files) == 1
    assert "message" in log_files[0].read_text(encoding="utf-8")

    set_file_logging(False)
    assert logger.config["log_to_file"] is False


def test_error_helpers_forward_messages_and_disabled_logger_skips_output(monkeypatch):
    logger.set_enabled(False)
    logger.log("disabled", LogLevel.INFO, "ignored")
    logger.set_enabled(True)

    calls = []
    monkeypatch.setattr(logger, "log", lambda *args, **kwargs: calls.append((args, kwargs)))

    error("helper", "failure")
    exception("helper", "with traceback")

    assert calls == [
        (("helper", LogLevel.ERROR, "failure"), {}),
        (("helper", LogLevel.ERROR, "with traceback"), {"exc_info": True}),
    ]


def test_set_debug_switches_global_threshold():
    set_debug(True)
    assert logger.config["global_level"] == LogLevel.DEBUG

    set_debug(False)
    assert logger.config["global_level"] == LogLevel.INFO
