"""Progress reporting for background-removal model downloads."""

import threading
import time


_MIN_PROGRESS_INTERVAL = 0.1
_MIN_PROGRESS_DELTA = 0.5
_PROGRESS_STATE_TTL = 120.0
_progress_state_lock = threading.Lock()
_progress_state = {}


def _progress_state_key(node_id):
    return str(node_id) if node_id is not None else "_global"


def send_matting_status(status, *, node_id=None, **details):
    """Send a best-effort Matting status event to the ComfyUI frontend."""
    payload = {"status": status}
    if node_id is not None:
        payload["node_id"] = str(node_id)
    payload.update({key: value for key, value in details.items() if value is not None})

    state_key = _progress_state_key(node_id)
    with _progress_state_lock:
        _progress_state[state_key] = {
            **payload,
            "updated_at": time.monotonic(),
        }

    try:
        from server import PromptServer

        PromptServer.instance.send_sync("matting_status", payload)
    except Exception:
        # Progress reporting must never interrupt a model download or inference.
        pass


def get_matting_status(node_id=None):
    """Return the latest in-process status for a Matting operation."""
    state_key = _progress_state_key(node_id)
    now = time.monotonic()
    with _progress_state_lock:
        state = _progress_state.get(state_key)
        if state is None:
            return {"status": "idle"}
        if now - state["updated_at"] > _PROGRESS_STATE_TTL:
            _progress_state.pop(state_key, None)
            return {"status": "idle"}
        return {key: value for key, value in state.items() if key != "updated_at"}


class _FallbackTqdm:
    """Small fallback used only when an older environment lacks tqdm imports."""

    def __init__(self, *args, **kwargs):
        del args
        self.total = kwargs.get("total")
        self.n = kwargs.get("initial", 0)
        self.unit = kwargs.get("unit") or "it"

    def update(self, amount=1):
        self.n += amount

    def close(self):
        return None

    def refresh(self):
        return None

    def set_description(self, *args, **kwargs):
        del args, kwargs

    def __enter__(self):
        return self

    def __exit__(self, *args):
        del args
        self.close()


def _get_tqdm_base():
    try:
        from huggingface_hub.utils import tqdm as huggingface_tqdm

        return huggingface_tqdm
    except Exception:
        try:
            from tqdm.auto import tqdm

            return tqdm
        except Exception:
            return _FallbackTqdm


class MattingProgressAdapter:
    """Track downloaded bytes independently of tqdm's terminal state."""

    def __init__(self, model_label, node_id=None, total_size=0, initial=0):
        self.model_label = model_label
        self.node_id = node_id
        self.total_size = self._coerce_bytes(total_size)
        self.downloaded = self._coerce_bytes(initial)
        self.last_reported = -1.0
        self.last_report_time = 0.0
        self.last_update_time = time.monotonic()
        self.last_downloaded = self.downloaded
        self._publish(force=True)

    @staticmethod
    def _coerce_bytes(value):
        try:
            return max(0, int(float(value or 0)))
        except (TypeError, ValueError):
            return 0

    def set_total(self, total_size):
        total = self._coerce_bytes(total_size)
        if total > self.total_size:
            self.total_size = total

    def _publish(self, downloaded=None, speed=0, force=False):
        if downloaded is not None:
            self.downloaded = max(self.downloaded, self._coerce_bytes(downloaded))
        if self.total_size > 0:
            self.downloaded = min(self.downloaded, self.total_size)

        progress = (
            min(100.0, round(self.downloaded / self.total_size * 100, 1))
            if self.total_size > 0
            else 0.0
        )

        now = time.monotonic()
        if not force and progress < 100.0:
            if now - self.last_report_time < _MIN_PROGRESS_INTERVAL:
                if abs(progress - self.last_reported) < _MIN_PROGRESS_DELTA:
                    return

        self.last_reported = progress
        self.last_report_time = now
        payload = {
            "model": self.model_label,
            "progress": progress,
            "downloaded_bytes": self.downloaded,
            "total_bytes": self.total_size,
            "speed": max(0, self._coerce_bytes(speed)),
        }
        send_matting_status("downloading", node_id=self.node_id, **payload)

    def update(self, byte_delta=1):
        """Accept a byte delta from an HTTP or Xet transfer."""
        delta = self._coerce_bytes(byte_delta)
        now = time.monotonic()
        elapsed = now - self.last_update_time
        downloaded = self.downloaded + delta
        speed = (downloaded - self.last_downloaded) / elapsed if elapsed > 0 else 0
        self.last_update_time = now
        self.last_downloaded = downloaded
        self._publish(downloaded, speed=speed)

    def close(self):
        self._publish(force=True)


def create_huggingface_tqdm_class(model_label, node_id=None):
    """Create a Hugging Face-compatible tqdm class that reports byte progress."""
    base_tqdm = _get_tqdm_base()

    class MattingProgressTqdm(base_tqdm):
        def __init__(self, *args, **kwargs):
            self._matting_unit = kwargs.get("unit")
            self._matting_progress = None
            super().__init__(*args, **kwargs)
            if self._is_byte_unit():
                self._matting_progress = MattingProgressAdapter(
                    model_label,
                    node_id,
                    total_size=getattr(self, "total", kwargs.get("total", 0)),
                    initial=kwargs.get("initial", 0),
                )

        def update(self, amount=1):
            result = super().update(amount)
            if self._matting_progress is not None:
                self._matting_progress.set_total(getattr(self, "total", 0))
                self._matting_progress.update(amount)
            return result

        def close(self):
            if self._matting_progress is not None:
                self._matting_progress.set_total(getattr(self, "total", 0))
                self._matting_progress.close()
            return super().close()

        def _is_byte_unit(self):
            unit = str(
                self._matting_unit
                or getattr(self, "unit", None)
                or getattr(self, "_unit", None)
                or ""
            ).lower()
            return unit in {"b", "bytes"}

    return MattingProgressTqdm


def call_huggingface_download(download_function, download_kwargs, model_label, node_id=None):
    """Call a Hub downloader with progress, falling back for older Hub APIs."""
    call_kwargs = dict(download_kwargs)
    call_kwargs["tqdm_class"] = create_huggingface_tqdm_class(model_label, node_id)

    while True:
        try:
            return download_function(**call_kwargs)
        except TypeError as error:
            error_text = str(error)
            unsupported_keyword = next(
                (
                    keyword
                    for keyword in ("tqdm_class", "local_dir_use_symlinks")
                    if keyword in call_kwargs and keyword in error_text
                ),
                None,
            )
            if unsupported_keyword is None:
                raise
            call_kwargs.pop(unsupported_keyword)


__all__ = [
    "call_huggingface_download",
    "create_huggingface_tqdm_class",
    "get_matting_status",
    "MattingProgressAdapter",
    "send_matting_status",
]
