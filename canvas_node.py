from PIL import Image, ImageOps
import hashlib
import torch
import numpy as np
import folder_paths
from server import PromptServer
from aiohttp import web
import asyncio
import threading
import os
from tqdm import tqdm
from torchvision import transforms
import torch.nn.functional as F
import traceback
import uuid
import time
import base64
from PIL import Image
import io
import sys
import os

try:
    from python.log_system import create_module_logger

    log = create_module_logger(__name__)

    log.info("Logger initialized for canvas_node")
except ImportError as e:

    print(f"Warning: Logger module not available: {e}")

    class _FallbackLogger:
        @staticmethod
        def debug(*args, **kwargs): print("[DEBUG]", *args)

        @staticmethod
        def info(*args, **kwargs): print("[INFO]", *args)

        @staticmethod
        def warning(*args, **kwargs): print("[WARN]", *args)

        @staticmethod
        def error(*args, **kwargs): print("[ERROR]", *args)

        @staticmethod
        def exception(*args, **kwargs):
            print("[ERROR]", *args)
            traceback.print_exc()

        @staticmethod
        def fatal(*args, **kwargs): print("[FATAL]", *args)

    log = _FallbackLogger()

torch.set_float32_matmul_precision('high')


def _get_comfy_birefnet_loader():
    """Return ComfyUI's native BiRefNet loader when it is available."""
    try:
        from comfy.bg_removal_model import load

        return load
    except Exception as error:
        log.debug(f"Native ComfyUI BiRefNet loader is unavailable: {error}")
        return None


class LayerForgeNode:
    _canvas_data_storage = {}
    _storage_lock = threading.Lock()
    
    _canvas_cache = {
        'image': None,
        'mask': None,
        'data_flow_status': {},
        'persistent_cache': {},
        'last_execution_id': None
    }


    _websocket_data = {}
    _websocket_listeners = {}

    def __init__(self):
        super().__init__()
        self.flow_id = str(uuid.uuid4())
        self.node_id = None  # Will be set when node is created

        if self.__class__._canvas_cache['persistent_cache']:
            self.restore_cache()

    def restore_cache(self):
        try:
            persistent = self.__class__._canvas_cache['persistent_cache']
            current_execution = self.get_execution_id()

            if current_execution != self.__class__._canvas_cache['last_execution_id']:
                log.info(f"New execution detected: {current_execution}")
                self.__class__._canvas_cache['image'] = None
                self.__class__._canvas_cache['mask'] = None
                self.__class__._canvas_cache['last_execution_id'] = current_execution
            else:

                if persistent.get('image') is not None:
                    self.__class__._canvas_cache['image'] = persistent['image']
                    log.info("Restored image from persistent cache")
                if persistent.get('mask') is not None:
                    self.__class__._canvas_cache['mask'] = persistent['mask']
                    log.info("Restored mask from persistent cache")
        except Exception as e:
            log.error(f"Error restoring cache: {str(e)}")

    def get_execution_id(self):

        try:

            return str(int(time.time() * 1000))
        except Exception as e:
            log.error(f"Error getting execution ID: {str(e)}")
            return None

    def update_persistent_cache(self):

        try:
            self.__class__._canvas_cache['persistent_cache'] = {
                'image': self.__class__._canvas_cache['image'],
                'mask': self.__class__._canvas_cache['mask']
            }
            log.debug("Updated persistent cache")
        except Exception as e:
            log.error(f"Error updating persistent cache: {str(e)}")

    def track_data_flow(self, stage, status, data_info=None):

        flow_status = {
            'timestamp': time.time(),
            'stage': stage,
            'status': status,
            'data_info': data_info
        }
        log.debug(f"Data Flow [{self.flow_id}] - Stage: {stage}, Status: {status}")
        if data_info:
            log.debug(f"Data Info: {data_info}")

        self.__class__._canvas_cache['data_flow_status'][self.flow_id] = flow_status

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fit_on_add": ("BOOLEAN", {"default": False, "label_on": "Fit on Add/Paste", "label_off": "Default Behavior"}),
                "show_preview": ("BOOLEAN", {"default": False, "label_on": "Show Preview", "label_off": "Hide Preview"}),
                "auto_refresh_after_generation": ("BOOLEAN", {"default": False, "label_on": "True", "label_off": "False"}),
                "trigger": ("INT", {"default": 0, "min": 0, "max": 99999999, "step": 1}),
                "node_id": ("STRING", {"default": "0"}),
            },
            "optional": {
                "input_image": ("IMAGE",),
                "input_mask": ("MASK",),
            },
            "hidden": {
                "prompt": ("PROMPT",),
                "unique_id": ("UNIQUE_ID",),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "process_canvas_image"
    CATEGORY = "azNodes > LayerForge"

    def add_image_to_canvas(self, input_image):

        try:

            if not isinstance(input_image, torch.Tensor):
                raise ValueError("Input image must be a torch.Tensor")

            if input_image.dim() == 4:
                input_image = input_image.squeeze(0)

            if input_image.dim() == 3 and input_image.shape[0] in [1, 3]:
                input_image = input_image.permute(1, 2, 0)

            return input_image

        except Exception as e:
            log.error(f"Error in add_image_to_canvas: {str(e)}")
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
                        mode='bilinear',
                        align_corners=False
                    ).squeeze()

            return input_mask

        except Exception as e:
            log.error(f"Error in add_mask_to_canvas: {str(e)}")
            return None

    _processing_lock = threading.Lock()

    def process_canvas_image(self, fit_on_add, show_preview, auto_refresh_after_generation, trigger, node_id, input_image=None, input_mask=None, prompt=None, unique_id=None):
        
        try:

            if not self.__class__._processing_lock.acquire(blocking=False):
                log.warning(f"Process already in progress for node {node_id}, skipping...")

                return self.get_cached_data()

            log.info(f"Lock acquired. Starting process_canvas_image for node_id: {node_id} (fallback unique_id: {unique_id})")

            # Always store fresh input data, even if None, to clear stale data
            log.info(f"Storing input data for node {node_id} - Image: {input_image is not None}, Mask: {input_mask is not None}")
            
            with self.__class__._storage_lock:
                input_data = {}
                
                if input_image is not None:
                    # Convert image tensor(s) to base64 - handle batch
                    if isinstance(input_image, torch.Tensor):
                        # Ensure correct shape [B, H, W, C]
                        if input_image.dim() == 3:
                            input_image = input_image.unsqueeze(0)
                        
                        batch_size = input_image.shape[0]
                        log.info(f"Processing batch of {batch_size} image(s)")
                        
                        if batch_size == 1:
                            # Single image - keep backward compatibility
                            img_np = (input_image.squeeze(0).cpu().numpy() * 255).astype(np.uint8)
                            pil_img = Image.fromarray(img_np, 'RGB')
                            
                            # Convert to base64
                            buffered = io.BytesIO()
                            pil_img.save(buffered, format="PNG")
                            img_str = base64.b64encode(buffered.getvalue()).decode()
                            input_data['input_image'] = f"data:image/png;base64,{img_str}"
                            input_data['input_image_width'] = pil_img.width
                            input_data['input_image_height'] = pil_img.height
                            log.debug(f"Stored single input image: {pil_img.width}x{pil_img.height}")
                        else:
                            # Multiple images - store as array
                            images_array = []
                            for i in range(batch_size):
                                img_np = (input_image[i].cpu().numpy() * 255).astype(np.uint8)
                                pil_img = Image.fromarray(img_np, 'RGB')
                                
                                # Convert to base64
                                buffered = io.BytesIO()
                                pil_img.save(buffered, format="PNG")
                                img_str = base64.b64encode(buffered.getvalue()).decode()
                                images_array.append({
                                    'data': f"data:image/png;base64,{img_str}",
                                    'width': pil_img.width,
                                    'height': pil_img.height
                                })
                                log.debug(f"Stored batch image {i+1}/{batch_size}: {pil_img.width}x{pil_img.height}")
                            
                            input_data['input_images_batch'] = images_array
                            log.info(f"Stored batch of {batch_size} images")
                
                if input_mask is not None:
                    # Convert mask tensor to base64
                    if isinstance(input_mask, torch.Tensor):
                        # Ensure correct shape
                        if input_mask.dim() == 2:
                            input_mask = input_mask.unsqueeze(0)
                        if input_mask.dim() == 3 and input_mask.shape[0] == 1:
                            input_mask = input_mask.squeeze(0)
                        
                        # Convert to numpy and then to PIL
                        mask_np = (input_mask.cpu().numpy() * 255).astype(np.uint8)
                        pil_mask = Image.fromarray(mask_np, 'L')
                        
                        # Convert to base64
                        mask_buffered = io.BytesIO()
                        pil_mask.save(mask_buffered, format="PNG")
                        mask_str = base64.b64encode(mask_buffered.getvalue()).decode()
                        input_data['input_mask'] = f"data:image/png;base64,{mask_str}"
                        log.debug(f"Stored input mask: {pil_mask.width}x{pil_mask.height}")
                
                input_data['fit_on_add'] = fit_on_add
                
                # Store in a special key for input data (overwrites any previous data)
                self.__class__._canvas_data_storage[f"{node_id}_input"] = input_data

            storage_key = node_id
            
            processed_image = None
            processed_mask = None

            with self.__class__._storage_lock:
                canvas_data = self.__class__._canvas_data_storage.pop(storage_key, None)

            if canvas_data:
                log.info(f"Canvas data found for node {storage_key} from WebSocket")
                if canvas_data.get('image'):
                    image_data = canvas_data['image'].split(',')[1]
                    image_bytes = base64.b64decode(image_data)
                    pil_image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
                    image_array = np.array(pil_image).astype(np.float32) / 255.0
                    processed_image = torch.from_numpy(image_array)[None,]
                    log.debug(f"Image loaded from WebSocket, shape: {processed_image.shape}")

                if canvas_data.get('mask'):
                    mask_data = canvas_data['mask'].split(',')[1]
                    mask_bytes = base64.b64decode(mask_data)
                    pil_mask = Image.open(io.BytesIO(mask_bytes)).convert('L')
                    mask_array = np.array(pil_mask).astype(np.float32) / 255.0
                    processed_mask = torch.from_numpy(mask_array)[None,]
                    log.debug(f"Mask loaded from WebSocket, shape: {processed_mask.shape}")
            else:
                log.warning(f"No canvas data found for node {storage_key} in WebSocket cache.")

            if processed_image is None:
                log.warning(f"Processed image is still None, creating default blank image.")
                processed_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            if processed_mask is None:
                log.warning(f"Processed mask is still None, creating default blank mask.")
                processed_mask = torch.zeros((1, 512, 512), dtype=torch.float32)

            log.debug(f"About to return output - Image shape: {processed_image.shape}, Mask shape: {processed_mask.shape}")
            
            self.update_persistent_cache()
            
            log.info(f"Successfully returning processed image and mask")
            return (processed_image, processed_mask)

        except Exception as e:
            log.exception(f"Error in process_canvas_image: {str(e)}")
            return (None, None)
            
        finally:

            if self.__class__._processing_lock.locked():
                self.__class__._processing_lock.release()
                log.debug(f"Process completed for node {node_id}, lock released")

    def get_cached_data(self):
        return {
            'image': self.__class__._canvas_cache['image'],
            'mask': self.__class__._canvas_cache['mask']
        }

    @classmethod
    def api_get_data(cls, node_id):
        try:
            return {
                'success': True,
                'data': cls._canvas_cache
            }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    @classmethod
    def get_latest_image(cls):
        output_dir = folder_paths.get_output_directory()
        files = [os.path.join(output_dir, f) for f in os.listdir(output_dir) if
                 os.path.isfile(os.path.join(output_dir, f))]

        image_files = [f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.gif'))]

        if not image_files:
            return None

        latest_image_path = max(image_files, key=os.path.getctime)
        return latest_image_path

    @classmethod
    def get_latest_images(cls, since_timestamp=0):
        output_dir = folder_paths.get_output_directory()
        files = []
        for f_name in os.listdir(output_dir):
            file_path = os.path.join(output_dir, f_name)
            if os.path.isfile(file_path) and file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.gif')):
                try:
                    mtime = os.path.getmtime(file_path)
                    if mtime > since_timestamp:
                        files.append((mtime, file_path))
                except OSError:
                    continue
        
        files.sort(key=lambda x: x[0])
        
        return [f[1] for f in files]

    @classmethod
    def get_flow_status(cls, flow_id=None):

        if flow_id:
            return cls._canvas_cache['data_flow_status'].get(flow_id)
        return cls._canvas_cache['data_flow_status']

    @classmethod
    def _cleanup_old_websocket_data(cls):
        """Clean up old WebSocket data from invalid nodes or data older than 5 minutes"""
        try:
            current_time = time.time()
            cleanup_threshold = 300  # 5 minutes
            
            nodes_to_remove = []
            for node_id, data in cls._websocket_data.items():

                if node_id < 0:
                    nodes_to_remove.append(node_id)
                    continue

                if current_time - data.get('timestamp', 0) > cleanup_threshold:
                    nodes_to_remove.append(node_id)
                    continue
            
            for node_id in nodes_to_remove:
                del cls._websocket_data[node_id]
                log.debug(f"Cleaned up old WebSocket data for node {node_id}")
            
            if nodes_to_remove:
                log.info(f"Cleaned up {len(nodes_to_remove)} old WebSocket entries")
                
        except Exception as e:
            log.error(f"Error during WebSocket cleanup: {str(e)}")

    @classmethod
    def setup_routes(cls):
        @PromptServer.instance.routes.get("/layerforge/canvas_ws")
        async def handle_canvas_websocket(request):
            ws = web.WebSocketResponse(max_msg_size=33554432)
            await ws.prepare(request)
            
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    try:
                        data = msg.json()
                        node_id = data.get('nodeId')
                        if not node_id:
                            await ws.send_json({'status': 'error', 'message': 'nodeId is required'})
                            continue
                        
                        image_data = data.get('image')
                        mask_data = data.get('mask')
                        
                        with cls._storage_lock:
                            cls._canvas_data_storage[node_id] = {
                                'image': image_data,
                                'mask': mask_data,
                                'timestamp': time.time()
                            }
                        
                        log.info(f"Received canvas data for node {node_id} via WebSocket")

                        ack_payload = {
                            'type': 'ack',
                            'nodeId': node_id,
                            'status': 'success'
                        }
                        await ws.send_json(ack_payload)
                        log.debug(f"Sent ACK for node {node_id}")
                        
                    except Exception as e:
                        log.error(f"Error processing WebSocket message: {e}")
                        await ws.send_json({'status': 'error', 'message': str(e)})
                elif msg.type == web.WSMsgType.ERROR:
                    log.error(f"WebSocket connection closed with exception {ws.exception()}")

            log.info("WebSocket connection closed")
            return ws

        @PromptServer.instance.routes.get("/layerforge/get_input_data/{node_id}")
        async def get_input_data(request):
            try:
                node_id = request.match_info["node_id"]
                log.debug(f"Checking for input data for node: {node_id}")
                
                with cls._storage_lock:
                    input_key = f"{node_id}_input"
                    input_data = cls._canvas_data_storage.get(input_key, None)
                
                if input_data:
                    log.info(f"Input data found for node {node_id}, sending to frontend")
                    return web.json_response({
                        'success': True,
                        'has_input': True,
                        'data': input_data
                    })
                else:
                    log.debug(f"No input data found for node {node_id}")
                    return web.json_response({
                        'success': True,
                        'has_input': False
                    })
                    
            except Exception as e:
                log.error(f"Error in get_input_data: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.post("/layerforge/clear_input_data/{node_id}")
        async def clear_input_data(request):
            try:
                node_id = request.match_info["node_id"]
                log.info(f"Clearing input data for node: {node_id}")
                
                with cls._storage_lock:
                    input_key = f"{node_id}_input"
                    if input_key in cls._canvas_data_storage:
                        del cls._canvas_data_storage[input_key]
                        log.info(f"Input data cleared for node {node_id}")
                    else:
                        log.debug(f"No input data to clear for node {node_id}")
                
                return web.json_response({
                    'success': True,
                    'message': f'Input data cleared for node {node_id}'
                })
                    
            except Exception as e:
                log.error(f"Error in clear_input_data: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.get("/ycnode/get_canvas_data/{node_id}")
        async def get_canvas_data(request):
            try:
                node_id = request.match_info["node_id"]
                log.debug(f"Received request for node: {node_id}")

                cache_data = cls._canvas_cache
                log.debug(f"Cache content: {cache_data}")
                log.debug(f"Image in cache: {cache_data['image'] is not None}")

                response_data = {
                    'success': True,
                    'data': {
                        'image': None,
                        'mask': None
                    }
                }

                if cache_data['image'] is not None:
                    pil_image = cache_data['image']
                    buffered = io.BytesIO()
                    pil_image.save(buffered, format="PNG")
                    img_str = base64.b64encode(buffered.getvalue()).decode()
                    response_data['data']['image'] = f"data:image/png;base64,{img_str}"

                if cache_data['mask'] is not None:
                    pil_mask = cache_data['mask']
                    mask_buffer = io.BytesIO()
                    pil_mask.save(mask_buffer, format="PNG")
                    mask_str = base64.b64encode(mask_buffer.getvalue()).decode()
                    response_data['data']['mask'] = f"data:image/png;base64,{mask_str}"

                return web.json_response(response_data)

            except Exception as e:
                log.error(f"Error in get_canvas_data: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                })

        @PromptServer.instance.routes.get("/layerforge/get-latest-images/{since}")
        async def get_latest_images_route(request):
            try:
                since_timestamp = float(request.match_info.get('since', 0))
                # JS Timestamps are in milliseconds, Python's are in seconds
                latest_image_paths = cls.get_latest_images(since_timestamp / 1000.0)

                images_data = []
                for image_path in latest_image_paths:
                    with open(image_path, "rb") as f:
                        encoded_string = base64.b64encode(f.read()).decode('utf-8')
                        images_data.append(f"data:image/png;base64,{encoded_string}")
                
                return web.json_response({
                    'success': True,
                    'images': images_data
                })
            except Exception as e:
                log.error(f"Error in get_latest_images_route: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.get("/ycnode/get_latest_image")
        async def get_latest_image_route(request):
            try:
                latest_image_path = cls.get_latest_image()
                if latest_image_path:
                    with open(latest_image_path, "rb") as f:
                        encoded_string = base64.b64encode(f.read()).decode('utf-8')
                    return web.json_response({
                        'success': True,
                        'image_data': f"data:image/png;base64,{encoded_string}"
                    })
                else:
                    return web.json_response({
                        'success': False,
                        'error': 'No images found in output directory.'
                    }, status=404)
            except Exception as e:
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.post("/ycnode/load_image_from_path")
        async def load_image_from_path_route(request):
            try:
                data = await request.json()
                file_path = data.get('file_path')
                
                if not file_path:
                    return web.json_response({
                        'success': False,
                        'error': 'file_path is required'
                    }, status=400)
                
                log.info(f"Attempting to load image from path: {file_path}")
                
                # Check if file exists and is accessible
                if not os.path.exists(file_path):
                    log.warning(f"File not found: {file_path}")
                    return web.json_response({
                        'success': False,
                        'error': f'File not found: {file_path}'
                    }, status=404)
                
                # Check if it's an image file
                valid_extensions = ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.ico', '.avif')
                if not file_path.lower().endswith(valid_extensions):
                    return web.json_response({
                        'success': False,
                        'error': f'Invalid image file extension. Supported: {valid_extensions}'
                    }, status=400)
                
                # Try to load and convert the image
                try:
                    with Image.open(file_path) as img:
                        # Convert to RGB if necessary
                        if img.mode != 'RGB':
                            img = img.convert('RGB')
                        
                        # Convert to base64
                        buffered = io.BytesIO()
                        img.save(buffered, format="PNG")
                        img_str = base64.b64encode(buffered.getvalue()).decode('utf-8')
                        
                        log.info(f"Successfully loaded image from path: {file_path}")
                        return web.json_response({
                            'success': True,
                            'image_data': f"data:image/png;base64,{img_str}",
                            'width': img.width,
                            'height': img.height
                        })
                        
                except Exception as img_error:
                    log.error(f"Error processing image file {file_path}: {str(img_error)}")
                    return web.json_response({
                        'success': False,
                        'error': f'Error processing image file: {str(img_error)}'
                    }, status=500)
                    
            except Exception as e:
                log.error(f"Error in load_image_from_path_route: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

    def store_image(self, image_data):

        if isinstance(image_data, str) and image_data.startswith('data:image'):
            image_data = image_data.split(',')[1]
            image_bytes = base64.b64decode(image_data)
            self.cached_image = Image.open(io.BytesIO(image_bytes))
        else:
            self.cached_image = image_data

    def get_cached_image(self):

        if self.cached_image:
            buffered = io.BytesIO()
            self.cached_image.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode()
            return f"data:image/png;base64,{img_str}"
        return None


_BIREFNET_REPOSITORY = "ZhengPeng7/BiRefNet"
_BIREFNET_FILENAME = "model.safetensors"
_BIREFNET_REQUIRED_KEYS = {
    "bb.layers.1.blocks.0.attn.relative_position_index",
    "bb.layers.2.blocks.17.attn.qkv.weight",
}


def _get_birefnet_base_paths():
    """Return native ComfyUI and legacy locations that may contain BiRefNet."""
    paths = []

    get_folder_paths = getattr(folder_paths, "get_folder_paths", None)
    if callable(get_folder_paths):
        try:
            paths.extend(get_folder_paths("background_removal"))
        except (KeyError, TypeError):
            pass

    comfy_models_dir = getattr(folder_paths, "models_dir", None)
    if comfy_models_dir:
        paths.extend([
            os.path.join(comfy_models_dir, "background_removal"),
            os.path.join(comfy_models_dir, "RMBG", "BiRefNet"),
            os.path.join(comfy_models_dir, "BiRefNet"),
        ])

    unique_paths = []
    seen = set()
    for path in paths:
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized not in seen:
            seen.add(normalized)
            unique_paths.append(path)

    return unique_paths


def _is_native_birefnet_checkpoint(path):
    """Check the checkpoint signature without loading all weights into memory."""
    if not os.path.isfile(path) or not path.lower().endswith(".safetensors"):
        return False

    try:
        from safetensors import safe_open

        with safe_open(path, framework="pt") as checkpoint:
            keys = checkpoint.keys()
            return _BIREFNET_REQUIRED_KEYS.issubset(keys)
    except Exception as error:
        log.debug(f"Unable to inspect BiRefNet checkpoint {path}: {error}")
        return False


def _iter_birefnet_checkpoint_paths():
    """Yield candidate checkpoints from native and legacy model directories."""
    for base_path in _get_birefnet_base_paths():
        if not os.path.isdir(base_path):
            continue

        for root, directories, files in os.walk(base_path):
            directories[:] = [
                directory for directory in directories
                if directory not in {".git", ".no_exist", "__pycache__"}
            ]
            for filename in sorted(files):
                if filename.lower().endswith(".safetensors"):
                    yield os.path.join(root, filename)


def _find_local_birefnet_model():
    """Find a full BiRefNet checkpoint accepted by ComfyUI's native loader."""
    candidates = []
    seen = set()
    for path in _iter_birefnet_checkpoint_paths():
        normalized = os.path.normcase(os.path.normpath(path))
        if normalized in seen:
            continue
        seen.add(normalized)
        if _is_native_birefnet_checkpoint(path):
            candidates.append(path)

    if not candidates:
        return None

    priority = {
        "birefnet.safetensors": 0,
        "model.safetensors": 1,
        "birefnet-general.safetensors": 2,
        "birefnet-hr.safetensors": 3,
    }
    return min(
        candidates,
        key=lambda path: (priority.get(os.path.basename(path).lower(), 10), path.lower()),
    )


def _get_birefnet_download_dir():
    paths = _get_birefnet_base_paths()
    if not paths:
        raise RuntimeError("ComfyUI did not expose a background_removal model directory")

    download_dir = paths[0]
    os.makedirs(download_dir, exist_ok=True)
    return download_dir


def _download_birefnet_checkpoint():
    """Download the standard full BiRefNet checkpoint into ComfyUI's model path."""
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise RuntimeError(
            "Automatic BiRefNet download requires the 'huggingface_hub' package. "
            "Install the LayerForge requirements or place a compatible checkpoint in "
            "ComfyUI/models/background_removal/."
        ) from error

    download_dir = _get_birefnet_download_dir()
    log.info(f"Downloading BiRefNet from Hugging Face into {download_dir}...")

    try:
        downloaded_path = hf_hub_download(
            repo_id=_BIREFNET_REPOSITORY,
            filename=_BIREFNET_FILENAME,
            local_dir=download_dir,
            local_dir_use_symlinks=False,
        )
    except TypeError:
        # Older huggingface_hub versions do not accept local_dir_use_symlinks.
        downloaded_path = hf_hub_download(
            repo_id=_BIREFNET_REPOSITORY,
            filename=_BIREFNET_FILENAME,
            local_dir=download_dir,
        )

    if not _is_native_birefnet_checkpoint(downloaded_path):
        raise RuntimeError(
            f"Downloaded file is not a ComfyUI-compatible BiRefNet checkpoint: {downloaded_path}"
        )

    log.info(f"BiRefNet checkpoint is ready at {downloaded_path}")
    return downloaded_path


def _ensure_birefnet_checkpoint():
    return _find_local_birefnet_model() or _download_birefnet_checkpoint()


class BiRefNetMatting:
    _model_cache = {}
    _model_cache_lock = threading.Lock()

    def __init__(self):
        self.model = None
        self.model_path = None

    def load_model(self, model_path=None):
        del model_path  # The native loader resolves the actual checkpoint path below.
        loader = _get_comfy_birefnet_loader()
        if loader is None:
            raise RuntimeError(
                "This ComfyUI version does not provide the native BiRefNet background-removal loader."
            )

        checkpoint_path = _ensure_birefnet_checkpoint()
        with self._model_cache_lock:
            if checkpoint_path not in self._model_cache:
                log.info(f"Loading BiRefNet with ComfyUI's native loader from {checkpoint_path}")
                model = loader(checkpoint_path)
                if model is None:
                    raise RuntimeError(
                        f"ComfyUI did not recognize the BiRefNet checkpoint: {checkpoint_path}"
                    )
                self._model_cache[checkpoint_path] = model
            else:
                log.debug(f"Using cached native BiRefNet model from {checkpoint_path}")

            self.model = self._model_cache[checkpoint_path]
            self.model_path = checkpoint_path

        return self.model

    def preprocess_image(self, image):
        if not isinstance(image, torch.Tensor):
            image = transforms.ToTensor()(image).unsqueeze(0)

        if image.dim() == 3:
            if image.shape[0] in (1, 3, 4):
                image = image.movedim(0, -1).unsqueeze(0)
            else:
                image = image.unsqueeze(0)
        elif image.dim() == 4 and image.shape[1] in (1, 3, 4):
            image = image.movedim(1, -1)

        if image.dim() != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError(f"Expected an image tensor in BCHW or BHWC format, got {tuple(image.shape)}")

        if image.shape[-1] == 1:
            image = image.expand(-1, -1, -1, 3)
        elif image.shape[-1] == 4:
            image = image[..., :3]

        return image.to(dtype=torch.float32).contiguous()

    def execute(self, image, model_path, threshold=0.5, refinement=1):
        try:
            PromptServer.instance.send_sync("matting_status", {"status": "processing"})

            del refinement
            image_tensor = self.preprocess_image(image)
            original_size = (image_tensor.shape[1], image_tensor.shape[2])
            log.debug(f"Original size: {original_size}")
            self.load_model(model_path)
            log.debug(f"Processed image shape: {image_tensor.shape}, dtype: {image_tensor.dtype}")

            with torch.no_grad():
                result = self.model.encode_image(image_tensor)
                if result.dim() == 3:
                    result = result.unsqueeze(1)
                elif result.dim() == 2:
                    result = result.unsqueeze(0).unsqueeze(0)
                else:
                    raise ValueError(f"Unexpected BiRefNet output shape: {tuple(result.shape)}")

                result = result.to(device=image_tensor.device, dtype=torch.float32)
                if result.shape[-2:] != original_size:
                    result = F.interpolate(
                        result,
                        size=original_size,
                        mode="bilinear",
                        align_corners=False,
                    )
                result = result.clamp(0.0, 1.0)
                log.debug(f"Native BiRefNet output shape: {result.shape}, dtype: {result.dtype}")

                if threshold > 0:
                    result = (result > threshold).to(dtype=torch.float32)

                alpha_mask = result
                masked_image = image_tensor.movedim(-1, 1) * alpha_mask

                PromptServer.instance.send_sync("matting_status", {"status": "completed"})

                return (masked_image, alpha_mask)

        except Exception:
            PromptServer.instance.send_sync("matting_status", {"status": "error"})
            raise

    @classmethod
    def IS_CHANGED(cls, image, model_path, threshold, refinement):

        m = hashlib.md5()
        m.update(str(image).encode())
        m.update(str(model_path).encode())
        m.update(str(threshold).encode())
        m.update(str(refinement).encode())
        return m.hexdigest()


_matting_lock = None

@PromptServer.instance.routes.get("/matting/check-model")
async def check_matting_model(request):
    """Check if the matting model is available and ready to use"""
    try:
        if _get_comfy_birefnet_loader() is None:
            return web.json_response({
                "available": False,
                "reason": "unsupported_comfyui",
                "message": "This ComfyUI version does not provide the native BiRefNet background-removal loader."
            })

        local_model_path = _find_local_birefnet_model()

        if local_model_path:
            log.info(f"BiRefNet model files detected at {local_model_path}")
            return web.json_response({
                "available": True,
                "reason": "ready",
                "message": "Model is ready to use",
                "model_path": local_model_path
            })

        searched_paths = _get_birefnet_base_paths()
        log.info(f"BiRefNet model not found in any of: {searched_paths}")
        return web.json_response({
            "available": False,
            "reason": "not_downloaded",
            "message": "The BiRefNet checkpoint will be downloaded automatically on first use (requires internet connection).",
            "model_path": searched_paths[0] if searched_paths else None
        })

    except Exception as e:
        log.error(f"Error checking matting model: {str(e)}")
        return web.json_response({
            "available": False,
            "reason": "error",
            "message": f"Error checking model status: {str(e)}"
        }, status=500)

@PromptServer.instance.routes.post("/matting")
async def matting(request):
    global _matting_lock

    if _matting_lock is not None:
        log.warning("Matting already in progress, rejecting request")
        return web.json_response({
            "error": "Another matting operation is in progress",
            "details": "Please wait for the current operation to complete"
        }, status=429)

    _matting_lock = True
    try:
        log.info("Received matting request")
        data = await request.json()

        matting_instance = BiRefNetMatting()

        image_tensor, original_alpha = convert_base64_to_tensor(data["image"])
        log.debug(f"Input image shape: {image_tensor.shape}")

        matted_image, alpha_mask = matting_instance.execute(
            image_tensor,
            "BiRefNet/model.safetensors",
            threshold=data.get("threshold", 0.5),
            refinement=data.get("refinement", 1)
        )

        result_image = convert_tensor_to_base64(matted_image, alpha_mask, original_alpha)
        result_mask = convert_tensor_to_base64(alpha_mask)

        return web.json_response({
            "matted_image": result_image,
            "alpha_mask": result_mask
        })

    except RuntimeError as e:
        log.error(f"Runtime error during matting: {e}")
        return web.json_response({
            "error": "Matting Model Error",
            "details": str(e)
        }, status=500)
    except Exception as e:
        log.exception(f"Error in matting endpoint: {e}")
        error_text = str(e).lower()
        if any(
            marker in error_text
            for marker in ("offline", "connection", "timed out", "huggingface", "localentrynotfound")
        ):
            return web.json_response({
                "error": "Network Connection Error",
                "details": "Failed to download the BiRefNet model from Hugging Face. Please check your internet connection."
            }, status=400)

        return web.json_response({
            "error": "An unexpected error occurred",
            "details": traceback.format_exc()
        }, status=500)
    finally:
        _matting_lock = None
        log.debug("Matting lock released")


def convert_base64_to_tensor(base64_str):
    import base64
    import io

    try:

        img_data = base64.b64decode(base64_str.split(',')[1])
        img = Image.open(io.BytesIO(img_data))

        has_alpha = img.mode == 'RGBA'
        alpha = None
        if has_alpha:
            alpha = img.split()[3]

            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=alpha)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        transform = transforms.ToTensor()
        img_tensor = transform(img).unsqueeze(0)  # [1, C, H, W]

        if has_alpha:
            alpha_tensor = transforms.ToTensor()(alpha).unsqueeze(0)  # [1, 1, H, W]
            return img_tensor, alpha_tensor

        return img_tensor, None

    except Exception as e:
        log.error(f"Error in convert_base64_to_tensor: {str(e)}")
        raise


def convert_tensor_to_base64(tensor, alpha_mask=None, original_alpha=None):
    import base64
    import io

    try:

        tensor = tensor.cpu()

        if tensor.dim() == 4:
            tensor = tensor.squeeze(0)  # 移除batch维度
        if tensor.dim() == 3 and tensor.shape[0] in [1, 3]:
            tensor = tensor.permute(1, 2, 0)

        img_array = (tensor.numpy() * 255).astype(np.uint8)

        if alpha_mask is not None and original_alpha is not None:

            alpha_mask = alpha_mask.cpu().squeeze().numpy()
            alpha_mask = (alpha_mask * 255).astype(np.uint8)

            original_alpha = original_alpha.cpu().squeeze().numpy()
            original_alpha = (original_alpha * 255).astype(np.uint8)

            combined_alpha = np.minimum(alpha_mask, original_alpha)

            img = Image.fromarray(img_array, mode='RGB')
            alpha_img = Image.fromarray(combined_alpha, mode='L')
            img.putalpha(alpha_img)
        else:

            if img_array.shape[-1] == 1:
                img_array = img_array.squeeze(-1)
                img = Image.fromarray(img_array, mode='L')
            else:
                img = Image.fromarray(img_array, mode='RGB')

        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        img_str = base64.b64encode(buffer.getvalue()).decode()

        return f"data:image/png;base64,{img_str}"

    except Exception as e:
        log.error(f"Error in convert_tensor_to_base64: {str(e)}")
        log.debug(f"Tensor shape: {tensor.shape}, dtype: {tensor.dtype}")
        raise
