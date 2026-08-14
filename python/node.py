"""Core LayerForge ComfyUI node and its in-memory canvas state."""

import os
import threading
import time
import traceback
import uuid
from typing import ClassVar

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from .image_serialization import data_url_to_pil, pil_to_data_url

_OUTPUT_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".gif")
_MAX_IMAGE_INPUTS = 32

try:
    from .log_system.log_funcs import create_module_logger

    log = create_module_logger(__name__)
    log.info("Logger initialized for LayerForge node")
except ImportError as error:
    print(f"Warning: Logger module not available: {error}")

    class _FallbackLogger:
        @staticmethod
        def debug(*args, **kwargs):
            print("[DEBUG]", *args)

        @staticmethod
        def info(*args, **kwargs):
            print("[INFO]", *args)

        @staticmethod
        def warning(*args, **kwargs):
            print("[WARN]", *args)

        @staticmethod
        def error(*args, **kwargs):
            print("[ERROR]", *args)

        @staticmethod
        def exception(*args, **kwargs):
            print("[ERROR]", *args)
            traceback.print_exc()

        @staticmethod
        def fatal(*args, **kwargs):
            print("[FATAL]", *args)

    log = _FallbackLogger()


torch.set_float32_matmul_precision("high")


class LayerForgeNode:
    """ComfyUI node that stores and processes the LayerForge canvas."""

    _canvas_data_storage: ClassVar[dict] = {}
    _storage_lock = threading.Lock()
    _processing_lock = threading.Lock()
    _routes_registered: ClassVar[bool] = False

    _canvas_cache: ClassVar[dict] = {
        "image": None,
        "mask": None,
        "data_flow_status": {},
        "persistent_cache": {},
        "last_execution_id": None,
    }

    _websocket_data: ClassVar[dict] = {}
    _websocket_listeners: ClassVar[dict] = {}

    def __init__(self):
        super().__init__()
        self.flow_id = str(uuid.uuid4())
        self.node_id = None

        if self.__class__._canvas_cache["persistent_cache"]:
            self.restore_cache()

    def restore_cache(self):
        try:
            persistent = self.__class__._canvas_cache["persistent_cache"]
            current_execution = self.get_execution_id()

            if current_execution != self.__class__._canvas_cache["last_execution_id"]:
                log.info(f"New execution detected: {current_execution}")
                self.__class__._canvas_cache["image"] = None
                self.__class__._canvas_cache["mask"] = None
                self.__class__._canvas_cache["last_execution_id"] = current_execution
            else:
                if persistent.get("image") is not None:
                    self.__class__._canvas_cache["image"] = persistent["image"]
                    log.info("Restored image from persistent cache")
                if persistent.get("mask") is not None:
                    self.__class__._canvas_cache["mask"] = persistent["mask"]
                    log.info("Restored mask from persistent cache")
        except Exception as error:
            log.error(f"Error restoring cache: {error}")

    def get_execution_id(self):
        try:
            return str(int(time.time() * 1000))
        except Exception as error:
            log.error(f"Error getting execution ID: {error}")
            return None

    def update_persistent_cache(self):
        try:
            self.__class__._canvas_cache["persistent_cache"] = {
                "image": self.__class__._canvas_cache["image"],
                "mask": self.__class__._canvas_cache["mask"],
            }
            log.debug("Updated persistent cache")
        except Exception as error:
            log.error(f"Error updating persistent cache: {error}")

    def track_data_flow(self, stage, status, data_info=None):
        flow_status = {
            "timestamp": time.time(),
            "stage": stage,
            "status": status,
            "data_info": data_info,
        }
        log.debug(f"Data Flow [{self.flow_id}] - Stage: {stage}, Status: {status}")
        if data_info:
            log.debug(f"Data Info: {data_info}")

        self.__class__._canvas_cache["data_flow_status"][self.flow_id] = flow_status

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "input_image": ("IMAGE",),
            "input_mask": ("MASK",),
        }
        for index in range(1, _MAX_IMAGE_INPUTS + 1):
            optional[f"input_image_{index}"] = ("IMAGE", {"hidden": True})

        return {
            "required": {
                "fit_on_add": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "Fit on Add/Paste",
                        "label_off": "Default Behavior",
                    },
                ),
                "show_preview": (
                    "BOOLEAN",
                    {"default": False, "label_on": "Show Preview", "label_off": "Hide Preview"},
                ),
                "auto_refresh_after_generation": (
                    "BOOLEAN",
                    {"default": False, "label_on": "True", "label_off": "False"},
                ),
                "trigger": ("INT", {"default": 0, "min": 0, "max": 99999999, "step": 1}),
                "node_id": ("STRING", {"default": "0"}),
            },
            "optional": optional,
            "hidden": {
                "prompt": ("PROMPT",),
                "unique_id": ("UNIQUE_ID",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "process_canvas_image"
    CATEGORY = "azNodes > LayerForge"

    @staticmethod
    def _serialize_rgb_tensor_sample(image_tensor):
        image_array = (image_tensor.cpu().numpy() * 255).astype(np.uint8)
        pil_image = Image.fromarray(image_array, "RGB")
        return {
            "data": pil_to_data_url(pil_image),
            "width": pil_image.width,
            "height": pil_image.height,
        }

    def add_image_to_canvas(self, input_image):
        try:
            if not isinstance(input_image, torch.Tensor):
                raise ValueError("Input image must be a torch.Tensor")

            if input_image.dim() == 4:
                input_image = input_image.squeeze(0)

            if input_image.dim() == 3 and input_image.shape[0] in [1, 3]:
                input_image = input_image.permute(1, 2, 0)

            return input_image
        except Exception as error:
            log.error(f"Error in add_image_to_canvas: {error}")
            return None

    def add_mask_to_canvas(self, input_mask, input_image):
        try:
            if not isinstance(input_mask, torch.Tensor):
                raise ValueError("Input mask must be a torch.Tensor")

            if input_mask.dim() == 4:
                input_mask = input_mask.squeeze(0)
            if input_mask.dim() == 3 and input_mask.shape[0] == 1:
                input_mask = input_mask.squeeze(0)

            if input_image is not None:
                expected_shape = input_image.shape[:2]
                if input_mask.shape != expected_shape:
                    input_mask = F.interpolate(
                        input_mask.unsqueeze(0).unsqueeze(0),
                        size=expected_shape,
                        mode="bilinear",
                        align_corners=False,
                    ).squeeze()

            return input_mask
        except Exception as error:
            log.error(f"Error in add_mask_to_canvas: {error}")
            return None

    def process_canvas_image(
        self,
        fit_on_add,
        show_preview,
        auto_refresh_after_generation,
        trigger,
        node_id,
        input_image=None,
        input_mask=None,
        prompt=None,
        unique_id=None,
        **kwargs,
    ):
        del show_preview, auto_refresh_after_generation, trigger, prompt

        try:
            if not self.__class__._processing_lock.acquire(blocking=False):
                log.warning(f"Process already in progress for node {node_id}, skipping...")
                return self.get_cached_data()

            log.info(
                f"Lock acquired. Starting process_canvas_image for node_id: {node_id} "
                f"(fallback unique_id: {unique_id})"
            )
            log.info(
                f"Storing input data for node {node_id} - "
                f"Image: {input_image is not None}, Mask: {input_mask is not None}"
            )

            with self.__class__._storage_lock:
                input_data = {}

                transport_images = sorted(
                    [
                        (name, value)
                        for name, value in kwargs.items()
                        if name.startswith("input_image_")
                        and name[len("input_image_"):].isdigit()
                        and isinstance(value, torch.Tensor)
                    ],
                    key=lambda item: int(item[0][len("input_image_"):]),
                )

                if transport_images:
                    image_sources = []
                    if isinstance(input_image, torch.Tensor):
                        image_sources.append(("input_image", input_image))
                    image_sources.extend(transport_images)

                    images_array = []
                    for source_name, source_tensor in image_sources:
                        tensor = source_tensor.unsqueeze(0) if source_tensor.dim() == 3 else source_tensor
                        if tensor.dim() != 4:
                            log.warning(
                                f"Skipping {source_name}: expected an IMAGE tensor with 3 or 4 dimensions, "
                                f"got {tuple(source_tensor.shape)}"
                            )
                            continue

                        for index in range(tensor.shape[0]):
                            serialized_image = self._serialize_rgb_tensor_sample(tensor[index])
                            images_array.append(serialized_image)

                    if images_array:
                        input_data["input_images"] = images_array
                        log.info(f"Stored {len(images_array)} image(s) from multiple image inputs")
                elif input_image is not None and isinstance(input_image, torch.Tensor):
                    if input_image.dim() == 3:
                        input_image = input_image.unsqueeze(0)

                    batch_size = input_image.shape[0]
                    log.info(f"Processing batch of {batch_size} image(s)")

                    if batch_size == 1:
                        serialized_image = self._serialize_rgb_tensor_sample(input_image.squeeze(0))
                        input_data["input_image"] = serialized_image["data"]
                        input_data["input_image_width"] = serialized_image["width"]
                        input_data["input_image_height"] = serialized_image["height"]
                        log.debug(
                            f"Stored single input image: {serialized_image['width']}x{serialized_image['height']}"
                        )
                    else:
                        images_array = []
                        for index in range(batch_size):
                            serialized_image = self._serialize_rgb_tensor_sample(input_image[index])
                            images_array.append(serialized_image)
                            log.debug(
                                f"Stored batch image {index + 1}/{batch_size}: "
                                f"{serialized_image['width']}x{serialized_image['height']}"
                            )

                        input_data["input_images_batch"] = images_array
                        log.info(f"Stored batch of {batch_size} images")

                if input_mask is not None and isinstance(input_mask, torch.Tensor):
                    if input_mask.dim() == 2:
                        input_mask = input_mask.unsqueeze(0)
                    if input_mask.dim() == 3 and input_mask.shape[0] == 1:
                        input_mask = input_mask.squeeze(0)

                    mask_np = (input_mask.cpu().numpy() * 255).astype(np.uint8)
                    pil_mask = Image.fromarray(mask_np, "L")
                    input_data["input_mask"] = pil_to_data_url(pil_mask)
                    log.debug(f"Stored input mask: {pil_mask.width}x{pil_mask.height}")

                input_data["fit_on_add"] = fit_on_add
                self.__class__._canvas_data_storage[f"{node_id}_input"] = input_data

            processed_image = None
            processed_mask = None
            with self.__class__._storage_lock:
                canvas_data = self.__class__._canvas_data_storage.pop(node_id, None)

            if canvas_data:
                log.info(f"Canvas data found for node {node_id} from WebSocket")
                if canvas_data.get("image"):
                    pil_image = data_url_to_pil(canvas_data["image"]).convert("RGB")
                    image_array = np.array(pil_image).astype(np.float32) / 255.0
                    processed_image = torch.from_numpy(image_array)[None,]
                    log.debug(f"Image loaded from WebSocket, shape: {processed_image.shape}")

                if canvas_data.get("mask"):
                    pil_mask = data_url_to_pil(canvas_data["mask"]).convert("L")
                    mask_array = np.array(pil_mask).astype(np.float32) / 255.0
                    processed_mask = torch.from_numpy(mask_array)[None,]
                    log.debug(f"Mask loaded from WebSocket, shape: {processed_mask.shape}")
            else:
                log.warning(f"No canvas data found for node {node_id} in WebSocket cache.")

            if processed_image is None:
                log.warning("Processed image is still None, creating default blank image.")
                processed_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            if processed_mask is None:
                log.warning("Processed mask is still None, creating default blank mask.")
                processed_mask = torch.zeros((1, 512, 512), dtype=torch.float32)

            log.debug(
                f"About to return output - Image shape: {processed_image.shape}, "
                f"Mask shape: {processed_mask.shape}"
            )
            self.update_persistent_cache()
            log.info("Successfully returning processed image and mask")
            return processed_image, processed_mask
        except Exception as error:
            log.exception(f"Error in process_canvas_image: {error}")
            return None, None
        finally:
            if self.__class__._processing_lock.locked():
                self.__class__._processing_lock.release()
                log.debug(f"Process completed for node {node_id}, lock released")

    def get_cached_data(self):
        return {
            "image": self.__class__._canvas_cache["image"],
            "mask": self.__class__._canvas_cache["mask"],
        }

    @classmethod
    def api_get_data(cls, node_id):
        del node_id
        try:
            return {"success": True, "data": cls._canvas_cache}
        except Exception as error:
            return {"success": False, "error": str(error)}

    @classmethod
    def get_latest_image(cls):
        image_files = list(cls._iter_output_image_paths())
        if not image_files:
            return None
        return max(image_files, key=os.path.getctime)

    @classmethod
    def get_latest_images(cls, since_timestamp=0):
        files = []
        for file_path in cls._iter_output_image_paths():
            try:
                mtime = os.path.getmtime(file_path)
                if mtime > since_timestamp:
                    files.append((mtime, file_path))
            except OSError:
                continue

        files.sort(key=lambda item: item[0])
        return [item[1] for item in files]

    @classmethod
    def _iter_output_image_paths(cls):
        output_dir = folder_paths.get_output_directory()
        for filename in os.listdir(output_dir):
            file_path = os.path.join(output_dir, filename)
            if os.path.isfile(file_path) and file_path.lower().endswith(_OUTPUT_IMAGE_EXTENSIONS):
                yield file_path

    @classmethod
    def get_flow_status(cls, flow_id=None):
        if flow_id:
            return cls._canvas_cache["data_flow_status"].get(flow_id)
        return cls._canvas_cache["data_flow_status"]

    @classmethod
    def _cleanup_old_websocket_data(cls):
        """Clean up WebSocket data from invalid nodes or entries older than five minutes."""
        try:
            current_time = time.time()
            nodes_to_remove = []
            for node_id, data in cls._websocket_data.items():
                if node_id < 0 or current_time - data.get("timestamp", 0) > 300:
                    nodes_to_remove.append(node_id)

            for node_id in nodes_to_remove:
                del cls._websocket_data[node_id]
                log.debug(f"Cleaned up old WebSocket entry for node {node_id}")

            if nodes_to_remove:
                log.info(f"Cleaned up {len(nodes_to_remove)} old WebSocket entries")
        except Exception as error:
            log.error(f"Error during WebSocket cleanup: {error}")

    @classmethod
    def setup_routes(cls):
        """Register the node and matting HTTP routes once."""
        if cls._routes_registered:
            return

        from .routes import register_routes

        register_routes(cls)
        cls._routes_registered = True

    def store_image(self, image_data):
        if isinstance(image_data, str) and image_data.startswith("data:image"):
            self.cached_image = data_url_to_pil(image_data)
        else:
            self.cached_image = image_data

    def get_cached_image(self):
        if self.cached_image:
            return pil_to_data_url(self.cached_image)
        return None


__all__ = ["LayerForgeNode", "log"]
