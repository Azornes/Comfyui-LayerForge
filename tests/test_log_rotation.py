import logging
import os
import tempfile

from python.log_system.logger import (
    ANSI_RESET,
    ColoredFormatter,
    SafeRotatingFileHandler,
    parse_rotated_log_filename,
    rotated_log_filename,
)


def test_colored_formatter_uses_root_label_and_context_badges():
    formatter = ColoredFormatter(
        use_colors=True,
        include_milliseconds=False,
        include_brackets=True,
    )
    record = logging.LogRecord(
        "azlogs.module",
        logging.INFO,
        "test_file.py",
        12,
        "message",
        (),
        None,
    )

    formatted = formatter.format(record)
    badge_prefix = "\033[97;48;2;38;63;76m "
    timestamp = formatter._format_time(record)

    assert f"{badge_prefix}[{timestamp}] {ANSI_RESET}" in formatted
    assert "[module]" in formatted
    assert formatted.count(badge_prefix) == 2


def test_rotated_log_filename_keeps_log_as_final_extension():
    path = os.path.join("logs", "azlogs_LayerForge.log.3")
    assert rotated_log_filename(path) == os.path.join("logs", "azlogs_LayerForge.3.log")
    assert rotated_log_filename("logs/azlogs_LayerForge.log") == "logs/azlogs_LayerForge.log"


def test_parse_rotated_log_filename_accepts_current_style_and_rejects_legacy():
    assert parse_rotated_log_filename("azlogs_LayerForge.2.log") == ("azlogs_LayerForge", 2)
    assert parse_rotated_log_filename("azlogs_LayerForge.log") == ("azlogs_LayerForge", 0)
    assert parse_rotated_log_filename("other.txt") is None
    assert parse_rotated_log_filename("azlogs_LayerForge.log.2") is None


def test_safe_rotating_file_handler_keeps_log_extension_last():
    with tempfile.TemporaryDirectory() as temp_dir:
        log_path = os.path.join(temp_dir, "azlogs_LayerForge.log")
        test_logger = logging.getLogger(f"test-log-rotation-{id(log_path)}")
        test_logger.handlers.clear()
        test_logger.propagate = False
        test_logger.setLevel(logging.INFO)
        handler = SafeRotatingFileHandler(
            log_path,
            maxBytes=32,
            backupCount=2,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        test_logger.addHandler(handler)

        try:
            test_logger.info("first message large enough to rotate")
            test_logger.info("second message large enough to rotate")
            test_logger.info("third message large enough to rotate")
            handler.flush()
        finally:
            test_logger.removeHandler(handler)
            handler.close()

        files = set(os.listdir(temp_dir))
        assert "azlogs_LayerForge.log" in files
        assert "azlogs_LayerForge.1.log" in files
        assert "azlogs_LayerForge.2.log" in files
        assert "azlogs_LayerForge.log.1" not in files
