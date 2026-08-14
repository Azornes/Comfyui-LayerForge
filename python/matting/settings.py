"""Persistent Matting settings stored next to the LayerForge custom node."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Mapping

SETTINGS_FILE = Path(__file__).resolve().parents[2] / "layerforge_settings.json"
DEFAULT_SETTINGS = {
    "model_path": "",
    "mode": "remove_background",
    "threshold": 0.5,
    "hf_token": "",
}
_VALID_MODES = {"remove_background", "remove_foreground", "mask_only", "mask_only_inverted"}
_SETTINGS_LOCK = threading.RLock()


def _read_settings_file() -> dict[str, Any]:
    try:
        with SETTINGS_FILE.open("r", encoding="utf-8") as settings_file:
            data = json.load(settings_file)
    except (OSError, ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def _normalize_settings(settings: Mapping[str, Any] | None) -> dict[str, Any]:
    data = dict(DEFAULT_SETTINGS)
    raw = dict(settings or {})

    model_path = raw.get("model_path", raw.get("modelPath", DEFAULT_SETTINGS["model_path"]))
    data["model_path"] = str(model_path or "").strip()

    mode = str(raw.get("mode") or DEFAULT_SETTINGS["mode"]).strip()
    data["mode"] = mode if mode in _VALID_MODES else DEFAULT_SETTINGS["mode"]

    try:
        threshold = float(raw.get("threshold", DEFAULT_SETTINGS["threshold"]))
    except (TypeError, ValueError):
        threshold = DEFAULT_SETTINGS["threshold"]
    data["threshold"] = min(1.0, max(0.0, threshold))

    data["hf_token"] = str(raw.get("hf_token") or "").strip()
    return data


def load_settings() -> dict[str, Any]:
    """Load and normalize all settings, including the private Hugging Face token."""
    with _SETTINGS_LOCK:
        return _normalize_settings(_read_settings_file())


def get_public_settings() -> dict[str, Any]:
    """Return settings safe for the frontend without exposing the token."""
    settings = load_settings()
    return {
        "model_path": settings["model_path"],
        "mode": settings["mode"],
        "threshold": settings["threshold"],
        "hf_token_configured": bool(settings["hf_token"]),
        "configured": SETTINGS_FILE.is_file(),
    }


def get_huggingface_token() -> str:
    """Return the configured token for authenticated Hugging Face downloads."""
    return str(load_settings().get("hf_token") or "")


def _write_settings_file(settings: Mapping[str, Any]) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{SETTINGS_FILE.stem}.",
        suffix=".tmp",
        dir=SETTINGS_FILE.parent,
        text=True,
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as settings_file:
            json.dump(dict(settings), settings_file, indent=2)
            settings_file.write("\n")
            settings_file.flush()
            os.fsync(settings_file.fileno())
        os.replace(temporary_name, SETTINGS_FILE)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def save_settings(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and persist Matting settings without logging secret values."""
    if not isinstance(payload, Mapping):
        raise TypeError("Matting settings must be a JSON object")

    with _SETTINGS_LOCK:
        current = load_settings()
        for key in ("model_path", "mode", "threshold"):
            if key in payload:
                current[key] = payload[key]
        if "modelPath" in payload and "model_path" not in payload:
            current["model_path"] = payload["modelPath"]

        if payload.get("clear_hf_token"):
            current["hf_token"] = ""
        elif str(payload.get("hf_token") or "").strip():
            current["hf_token"] = str(payload["hf_token"]).strip()

        normalized = _normalize_settings(current)
        _write_settings_file(normalized)
        return normalized


__all__ = [
    "DEFAULT_SETTINGS",
    "SETTINGS_FILE",
    "get_huggingface_token",
    "get_public_settings",
    "load_settings",
    "save_settings",
]
