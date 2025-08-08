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
try:
    from transformers import AutoModelForImageSegmentation, PretrainedConfig
    from requests.exceptions import ConnectionError as RequestsConnectionError
    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False
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
    from python.logger import logger, LogLevel, debug, info, warn, error, exception
    from python.config import LOG_LEVEL

    logger.set_module_level('canvas_node', LogLevel[LOG_LEVEL])

    logger.configure({
        'log_to_file': True,
        'log_dir': os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
    })

    log_debug = lambda *args, **kwargs: debug('canvas_node', *args, **kwargs)
    log_info = lambda *args, **kwargs: info('canvas_node', *args, **kwargs)
    log_warn = lambda *args, **kwargs: warn('canvas_node', *args, **kwargs)
    log_error = lambda *args, **kwargs: error('canvas_node', *args, **kwargs)
    log_exception = lambda *args: exception('canvas_node', *args)
    
    log_info("Logger initialized for canvas_node")
except ImportError as e:

    print(f"Warning: Logger module not available: {e}")

    def log_debug(*args): print("[DEBUG]", *args)
    def log_info(*args): print("[INFO]", *args)
    def log_warn(*args): print("[WARN]", *args)
    def log_error(*args): print("[ERROR]", *args)
    def log_exception(*args):
        print("[ERROR]", *args)
        traceback.print_exc()

torch.set_float32_matmul_precision('high')


class BiRefNetConfig(PretrainedConfig):
    model_type = "BiRefNet"

    def __init__(self, bb_pretrained=False, **kwargs):
        self.bb_pretrained = bb_pretrained
        super().__init__(**kwargs)


class BiRefNet(torch.nn.Module):
    def __init__(self, config):
        super().__init__()

        self.encoder = torch.nn.Sequential(
            torch.nn.Conv2d(3, 64, kernel_size=3, padding=1),
            torch.nn.ReLU(inplace=True),
            torch.nn.Conv2d(64, 64, kernel_size=3, padding=1),
            torch.nn.ReLU(inplace=True)
        )

        self.decoder = torch.nn.Sequential(
            torch.nn.Conv2d(64, 32, kernel_size=3, padding=1),
            torch.nn.ReLU(inplace=True),
            torch.nn.Conv2d(32, 1, kernel_size=1)
        )

    def forward(self, x):
        features = self.encoder(x)
        output = self.decoder(features)
        return [output]


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
                log_info(f"New execution detected: {current_execution}")
                self.__class__._canvas_cache['image'] = None
                self.__class__._canvas_cache['mask'] = None
                self.__class__._canvas_cache['last_execution_id'] = current_execution
            else:

                if persistent.get('image') is not None:
                    self.__class__._canvas_cache['image'] = persistent['image']
                    log_info("Restored image from persistent cache")
                if persistent.get('mask') is not None:
                    self.__class__._canvas_cache['mask'] = persistent['mask']
                    log_info("Restored mask from persistent cache")
        except Exception as e:
            log_error(f"Error restoring cache: {str(e)}")

    def get_execution_id(self):

        try:

            return str(int(time.time() * 1000))
        except Exception as e:
            log_error(f"Error getting execution ID: {str(e)}")
            return None

    def update_persistent_cache(self):

        try:
            self.__class__._canvas_cache['persistent_cache'] = {
                'image': self.__class__._canvas_cache['image'],
                'mask': self.__class__._canvas_cache['mask']
            }
            log_debug("Updated persistent cache")
        except Exception as e:
            log_error(f"Error updating persistent cache: {str(e)}")

    def track_data_flow(self, stage, status, data_info=None):

        flow_status = {
            'timestamp': time.time(),
            'stage': stage,
            'status': status,
            'data_info': data_info
        }
        log_debug(f"Data Flow [{self.flow_id}] - Stage: {stage}, Status: {status}")
        if data_info:
            log_debug(f"Data Info: {data_info}")

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
            log_error(f"Error in add_image_to_canvas: {str(e)}")
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
            log_error(f"Error in add_mask_to_canvas: {str(e)}")
            return None

    _processing_lock = threading.Lock()

    def process_canvas_image(self, fit_on_add, show_preview, auto_refresh_after_generation, trigger, node_id, input_image=None, input_mask=None, prompt=None, unique_id=None):
        
        try:

            if not self.__class__._processing_lock.acquire(blocking=False):
                log_warn(f"Process already in progress for node {node_id}, skipping...")

                return self.get_cached_data()

            log_info(f"Lock acquired. Starting process_canvas_image for node_id: {node_id} (fallback unique_id: {unique_id})")

            # Handle input image and mask if provided
            if input_image is not None or input_mask is not None:
                log_info(f"Input data detected for node {node_id} - Image: {input_image is not None}, Mask: {input_mask is not None}")
                
                # Store input data for frontend to retrieve
                with self.__class__._storage_lock:
                    input_data = {}
                    
                    if input_image is not None:
                        # Convert image tensor(s) to base64 - handle batch
                        if isinstance(input_image, torch.Tensor):
                            # Ensure correct shape [B, H, W, C]
                            if input_image.dim() == 3:
                                input_image = input_image.unsqueeze(0)
                            
                            batch_size = input_image.shape[0]
                            log_info(f"Processing batch of {batch_size} image(s)")
                            
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
                                log_debug(f"Stored single input image: {pil_img.width}x{pil_img.height}")
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
                                    log_debug(f"Stored batch image {i+1}/{batch_size}: {pil_img.width}x{pil_img.height}")
                                
                                input_data['input_images_batch'] = images_array
                                log_info(f"Stored batch of {batch_size} images")
                    
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
                            log_debug(f"Stored input mask: {pil_mask.width}x{pil_mask.height}")
                    
                    input_data['fit_on_add'] = fit_on_add
                    
                    # Store in a special key for input data
                    self.__class__._canvas_data_storage[f"{node_id}_input"] = input_data

            storage_key = node_id
            
            processed_image = None
            processed_mask = None

            with self.__class__._storage_lock:
                canvas_data = self.__class__._canvas_data_storage.pop(storage_key, None)

            if canvas_data:
                log_info(f"Canvas data found for node {storage_key} from WebSocket")
                if canvas_data.get('image'):
                    image_data = canvas_data['image'].split(',')[1]
                    image_bytes = base64.b64decode(image_data)
                    pil_image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
                    image_array = np.array(pil_image).astype(np.float32) / 255.0
                    processed_image = torch.from_numpy(image_array)[None,]
                    log_debug(f"Image loaded from WebSocket, shape: {processed_image.shape}")

                if canvas_data.get('mask'):
                    mask_data = canvas_data['mask'].split(',')[1]
                    mask_bytes = base64.b64decode(mask_data)
                    pil_mask = Image.open(io.BytesIO(mask_bytes)).convert('L')
                    mask_array = np.array(pil_mask).astype(np.float32) / 255.0
                    processed_mask = torch.from_numpy(mask_array)[None,]
                    log_debug(f"Mask loaded from WebSocket, shape: {processed_mask.shape}")
            else:
                log_warn(f"No canvas data found for node {storage_key} in WebSocket cache.")

            if processed_image is None:
                log_warn(f"Processed image is still None, creating default blank image.")
                processed_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            if processed_mask is None:
                log_warn(f"Processed mask is still None, creating default blank mask.")
                processed_mask = torch.zeros((1, 512, 512), dtype=torch.float32)

            log_debug(f"About to return output - Image shape: {processed_image.shape}, Mask shape: {processed_mask.shape}")
            
            self.update_persistent_cache()
            
            log_info(f"Successfully returning processed image and mask")
            return (processed_image, processed_mask)

        except Exception as e:
            log_exception(f"Error in process_canvas_image: {str(e)}")
            return (None, None)
            
        finally:

            if self.__class__._processing_lock.locked():
                self.__class__._processing_lock.release()
                log_debug(f"Process completed for node {node_id}, lock released")

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
                log_debug(f"Cleaned up old WebSocket data for node {node_id}")
            
            if nodes_to_remove:
                log_info(f"Cleaned up {len(nodes_to_remove)} old WebSocket entries")
                
        except Exception as e:
            log_error(f"Error during WebSocket cleanup: {str(e)}")

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
                        
                        log_info(f"Received canvas data for node {node_id} via WebSocket")

                        ack_payload = {
                            'type': 'ack',
                            'nodeId': node_id,
                            'status': 'success'
                        }
                        await ws.send_json(ack_payload)
                        log_debug(f"Sent ACK for node {node_id}")
                        
                    except Exception as e:
                        log_error(f"Error processing WebSocket message: {e}")
                        await ws.send_json({'status': 'error', 'message': str(e)})
                elif msg.type == web.WSMsgType.ERROR:
                    log_error(f"WebSocket connection closed with exception {ws.exception()}")

            log_info("WebSocket connection closed")
            return ws

        @PromptServer.instance.routes.get("/layerforge/get_input_data/{node_id}")
        async def get_input_data(request):
            try:
                node_id = request.match_info["node_id"]
                log_debug(f"Checking for input data for node: {node_id}")
                
                with cls._storage_lock:
                    input_key = f"{node_id}_input"
                    input_data = cls._canvas_data_storage.get(input_key, None)
                
                if input_data:
                    log_info(f"Input data found for node {node_id}, sending to frontend")
                    return web.json_response({
                        'success': True,
                        'has_input': True,
                        'data': input_data
                    })
                else:
                    log_debug(f"No input data found for node {node_id}")
                    return web.json_response({
                        'success': True,
                        'has_input': False
                    })
                    
            except Exception as e:
                log_error(f"Error in get_input_data: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.post("/layerforge/clear_input_data/{node_id}")
        async def clear_input_data(request):
            try:
                node_id = request.match_info["node_id"]
                log_info(f"Clearing input data for node: {node_id}")
                
                with cls._storage_lock:
                    input_key = f"{node_id}_input"
                    if input_key in cls._canvas_data_storage:
                        del cls._canvas_data_storage[input_key]
                        log_info(f"Input data cleared for node {node_id}")
                    else:
                        log_debug(f"No input data to clear for node {node_id}")
                
                return web.json_response({
                    'success': True,
                    'message': f'Input data cleared for node {node_id}'
                })
                    
            except Exception as e:
                log_error(f"Error in clear_input_data: {str(e)}")
                return web.json_response({
                    'success': False,
                    'error': str(e)
                }, status=500)

        @PromptServer.instance.routes.get("/ycnode/get_canvas_data/{node_id}")
        async def get_canvas_data(request):
            try:
                node_id = request.match_info["node_id"]
                log_debug(f"Received request for node: {node_id}")

                cache_data = cls._canvas_cache
                log_debug(f"Cache content: {cache_data}")
                log_debug(f"Image in cache: {cache_data['image'] is not None}")

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
                log_error(f"Error in get_canvas_data: {str(e)}")
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
                log_error(f"Error in get_latest_images_route: {str(e)}")
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
                
                log_info(f"Attempting to load image from path: {file_path}")
                
                # Check if file exists and is accessible
                if not os.path.exists(file_path):
                    log_warn(f"File not found: {file_path}")
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
                        
                        log_info(f"Successfully loaded image from path: {file_path}")
                        return web.json_response({
                            'success': True,
                            'image_data': f"data:image/png;base64,{img_str}",
                            'width': img.width,
                            'height': img.height
                        })
                        
                except Exception as img_error:
                    log_error(f"Error processing image file {file_path}: {str(img_error)}")
                    return web.json_response({
                        'success': False,
                        'error': f'Error processing image file: {str(img_error)}'
                    }, status=500)
                    
            except Exception as e:
                log_error(f"Error in load_image_from_path_route: {str(e)}")
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


class BiRefNetMatting:
    def __init__(self):
        self.model = None
        self.model_path = None
        self.model_cache = {}

        self.base_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                      "models")

    def load_model(self, model_path):
        from json.decoder import JSONDecodeError
        try:
            if model_path not in self.model_cache:
                full_model_path = os.path.join(self.base_path, "BiRefNet")
                log_info(f"Loading BiRefNet model from {full_model_path}...")
                try:
                    self.model = AutoModelForImageSegmentation.from_pretrained(
                        "ZhengPeng7/BiRefNet",
                        trust_remote_code=True,
                        cache_dir=full_model_path
                    )
                    self.model.eval()
                    if torch.cuda.is_available():
                        self.model = self.model.cuda()
                    self.model_cache[model_path] = self.model
                    log_info("Model loaded successfully from Hugging Face")
                except JSONDecodeError as e:                    
                    log_error(f"JSONDecodeError: Failed to load model from {full_model_path}. The model's config.json may be corrupted.")
                    raise RuntimeError(
                        "The matting model's configuration file (config.json) appears to be corrupted. "
                        f"Please manually delete the directory '{full_model_path}' and try again. "
                        "This will force a fresh download of the model."
                    ) from e
                except Exception as e:
                    log_error(f"Failed to load model from Hugging Face: {str(e)}")
                    # Re-raise with a more informative message
                    raise RuntimeError(
                        "Failed to download or load the matting model. "
                        "This could be due to a network issue, file permissions, or a corrupted model cache. "
                        f"Please check your internet connection and the model cache path: {full_model_path}. "
                        f"Original error: {str(e)}"
                    ) from e
            else:
                self.model = self.model_cache[model_path]
                log_debug("Using cached model")

        except Exception as e:
            # Catch the re-raised exception or any other error
            log_error(f"Error loading model: {str(e)}")
            log_exception("Model loading failed")
            raise  # Re-raise the exception to be caught by the execute method

    def preprocess_image(self, image):

        try:

            if isinstance(image, torch.Tensor):
                if image.dim() == 4:
                    image = image.squeeze(0)
                if image.dim() == 3:
                    image = transforms.ToPILImage()(image)

            transform_image = transforms.Compose([
                transforms.Resize((1024, 1024)),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
            ])

            image_tensor = transform_image(image).unsqueeze(0)

            if torch.cuda.is_available():
                image_tensor = image_tensor.cuda()

            return image_tensor
        except Exception as e:
            log_error(f"Error preprocessing image: {str(e)}")
            return None

    def execute(self, image, model_path, threshold=0.5, refinement=1):
        try:
            PromptServer.instance.send_sync("matting_status", {"status": "processing"})

            self.load_model(model_path)

            if isinstance(image, torch.Tensor):
                original_size = image.shape[-2:] if image.dim() == 4 else image.shape[-2:]
            else:
                original_size = image.size[::-1]

            log_debug(f"Original size: {original_size}")

            processed_image = self.preprocess_image(image)
            if processed_image is None:
                raise Exception("Failed to preprocess image")

            log_debug(f"Processed image shape: {processed_image.shape}")

            with torch.no_grad():
                outputs = self.model(processed_image)
                result = outputs[-1].sigmoid().cpu()
                log_debug(f"Model output shape: {result.shape}")

                if result.dim() == 3:
                    result = result.unsqueeze(1)  # 添加通道维度
                elif result.dim() == 2:
                    result = result.unsqueeze(0).unsqueeze(0)  # 添加batch和通道维度

                log_debug(f"Reshaped result shape: {result.shape}")

                result = F.interpolate(
                    result,
                    size=(original_size[0], original_size[1]),  # 明确指定高度和宽度
                    mode='bilinear',
                    align_corners=True
                )
                log_debug(f"Resized result shape: {result.shape}")

                result = result.squeeze()  # 移除多余的维度
                ma = torch.max(result)
                mi = torch.min(result)
                result = (result - mi) / (ma - mi)

                if threshold > 0:
                    result = (result > threshold).float()

                alpha_mask = result.unsqueeze(0).unsqueeze(0)  # 确保mask是 [1, 1, H, W]
                if isinstance(image, torch.Tensor):
                    if image.dim() == 3:
                        image = image.unsqueeze(0)
                    masked_image = image * alpha_mask
                else:
                    image_tensor = transforms.ToTensor()(image).unsqueeze(0)
                    masked_image = image_tensor * alpha_mask

                PromptServer.instance.send_sync("matting_status", {"status": "completed"})

                return (masked_image, alpha_mask)

        except Exception as e:

            PromptServer.instance.send_sync("matting_status", {"status": "error"})
            raise e

    @classmethod
    def IS_CHANGED(cls, image, model_path, threshold, refinement):

        m = hashlib.md5()
        m.update(str(image).encode())
        m.update(str(model_path).encode())
        m.update(str(threshold).encode())
        m.update(str(refinement).encode())
        return m.hexdigest()

_matting_lock = None

@PromptServer.instance.routes.post("/matting")
async def matting(request):
    global _matting_lock

    if not TRANSFORMERS_AVAILABLE:
        log_error("Matting request failed: 'transformers' library is not installed.")
        return web.json_response({
            "error": "Dependency Not Found",
            "details": "The 'transformers' library is required for the matting feature. Please install it by running: pip install transformers"
        }, status=400)

    if _matting_lock is not None:
        log_warn("Matting already in progress, rejecting request")
        return web.json_response({
            "error": "Another matting operation is in progress",
            "details": "Please wait for the current operation to complete"
        }, status=429)

    _matting_lock = True
    try:
        log_info("Received matting request")
        data = await request.json()

        matting_instance = BiRefNetMatting()

        image_tensor, original_alpha = convert_base64_to_tensor(data["image"])
        log_debug(f"Input image shape: {image_tensor.shape}")

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

    except RequestsConnectionError as e:
        log_error(f"Connection error during matting model download: {e}")
        return web.json_response({
            "error": "Network Connection Error",
            "details": "Failed to download the matting model from Hugging Face. Please check your internet connection."
        }, status=400)
    except RuntimeError as e:
        log_error(f"Runtime error during matting: {e}")
        return web.json_response({
            "error": "Matting Model Error",
            "details": str(e)
        }, status=500)
    except Exception as e:
        log_exception(f"Error in matting endpoint: {e}")
        # Check for offline error message from Hugging Face
        if "Offline mode is enabled" in str(e) or "Can't load 'ZhengPeng7/BiRefNet' offline" in str(e):
            return web.json_response({
                "error": "Network Connection Error",
                "details": "Failed to download the matting model from Hugging Face. Please check your internet connection and ensure you are not in offline mode."
            }, status=400)

        return web.json_response({
            "error": "An unexpected error occurred",
            "details": traceback.format_exc()
        }, status=500)
    finally:
        _matting_lock = None
        log_debug("Matting lock released")


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
        log_error(f"Error in convert_base64_to_tensor: {str(e)}")
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
        log_error(f"Error in convert_tensor_to_base64: {str(e)}")
        log_debug(f"Tensor shape: {tensor.shape}, dtype: {tensor.dtype}")
        raise
