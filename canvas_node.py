from PIL import Image, ImageOps
import hashlib
import torch
import numpy as np
import folder_paths
from server import PromptServer
from aiohttp import web
import os
from tqdm import tqdm
from torchvision import transforms
from transformers import AutoModelForImageSegmentation, PretrainedConfig
import torch.nn.functional as F
import traceback
import uuid
import time
import base64
from PIL import Image
import io
import sys
import os

# Dodaj ścieżkę do katalogu python/ do sys.path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'python'))

# Importuj logger
try:
    from python.logger import logger, LogLevel, debug, info, warn, error, exception
    
    # Konfiguracja loggera dla modułu canvas_node
    logger.set_module_level('canvas_node', LogLevel.INFO)  # Domyślnie INFO, można zmienić na DEBUG
    
    # Włącz logowanie do pliku
    logger.configure({
        'log_to_file': True,
        'log_dir': os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
    })
    
    # Funkcje pomocnicze dla modułu
    log_debug = lambda *args, **kwargs: debug('canvas_node', *args, **kwargs)
    log_info = lambda *args, **kwargs: info('canvas_node', *args, **kwargs)
    log_warn = lambda *args, **kwargs: warn('canvas_node', *args, **kwargs)
    log_error = lambda *args, **kwargs: error('canvas_node', *args, **kwargs)
    log_exception = lambda *args: exception('canvas_node', *args)
    
    log_info("Logger initialized for canvas_node")
except ImportError as e:
    # Fallback jeśli logger nie jest dostępny
    print(f"Warning: Logger module not available: {e}")
    
    # Proste funkcje zastępcze
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


class CanvasNode:
    _canvas_cache = {
        'image': None,
        'mask': None,
        'cache_enabled': True,
        'data_flow_status': {},
        'persistent_cache': {},
        'last_execution_id': None
    }

    def __init__(self):
        super().__init__()
        self.flow_id = str(uuid.uuid4())

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
                "canvas_image": ("STRING", {"default": "canvas_image.png"}),
                "trigger": ("INT", {"default": 0, "min": 0, "max": 99999999, "step": 1, "hidden": True}),
                "output_switch": ("BOOLEAN", {"default": True}),
                "cache_enabled": ("BOOLEAN", {"default": True, "label": "Enable Cache"})
            },
            "optional": {
                "input_image": ("IMAGE",),
                "input_mask": ("MASK",)
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

    # Zmienna blokująca równoczesne wykonania
    _processing_lock = None
    
    def process_canvas_image(self, canvas_image, trigger, output_switch, cache_enabled, input_image=None,
                             input_mask=None):
        try:
            # Sprawdź czy już trwa przetwarzanie
            if self.__class__._processing_lock is not None:
                log_warn(f"Process already in progress, waiting for completion...")
                return ()  # Zwróć pusty wynik, aby uniknąć równoczesnych przetworzeń
                
            # Ustaw blokadę
            self.__class__._processing_lock = True
            
            current_execution = self.get_execution_id()
            log_info(f"Starting process_canvas_image - execution ID: {current_execution}, trigger: {trigger}")
            log_debug(f"Canvas image filename: {canvas_image}")
            log_debug(f"Output switch: {output_switch}, Cache enabled: {cache_enabled}")
            log_debug(f"Input image provided: {input_image is not None}")
            log_debug(f"Input mask provided: {input_mask is not None}")

            if current_execution != self.__class__._canvas_cache['last_execution_id']:
                log_info(f"New execution detected: {current_execution} (previous: {self.__class__._canvas_cache['last_execution_id']})")

                self.__class__._canvas_cache['image'] = None
                self.__class__._canvas_cache['mask'] = None
                self.__class__._canvas_cache['last_execution_id'] = current_execution
            else:
                log_debug(f"Same execution ID, using cached data")

            if input_image is not None:
                log_info("Input image received, converting to PIL Image...")

                if isinstance(input_image, torch.Tensor):
                    if input_image.dim() == 4:
                        input_image = input_image.squeeze(0)  # 移除batch维度

                    if input_image.shape[0] == 3:  # 如果是[C, H, W]格式
                        input_image = input_image.permute(1, 2, 0)

                    image_array = (input_image.cpu().numpy() * 255).astype(np.uint8)

                    if len(image_array.shape) == 2:  # 如果是灰度图
                        image_array = np.stack([image_array] * 3, axis=-1)
                    elif len(image_array.shape) == 3 and image_array.shape[-1] != 3:
                        image_array = np.transpose(image_array, (1, 2, 0))

                    try:

                        pil_image = Image.fromarray(image_array, 'RGB')
                        log_debug("Successfully converted to PIL Image")

                        self.__class__._canvas_cache['image'] = pil_image
                        log_debug(f"Image stored in cache with size: {pil_image.size}")
                    except Exception as e:
                        log_error(f"Error converting to PIL Image: {str(e)}")
                        log_debug(f"Array shape: {image_array.shape}, dtype: {image_array.dtype}")
                        raise

            if input_mask is not None:
                log_info("Input mask received, converting to PIL Image...")
                if isinstance(input_mask, torch.Tensor):
                    if input_mask.dim() == 4:
                        input_mask = input_mask.squeeze(0)
                    if input_mask.dim() == 3 and input_mask.shape[0] == 1:
                        input_mask = input_mask.squeeze(0)

                    mask_array = (input_mask.cpu().numpy() * 255).astype(np.uint8)
                    pil_mask = Image.fromarray(mask_array, 'L')
                    log_debug("Successfully converted mask to PIL Image")

                    self.__class__._canvas_cache['mask'] = pil_mask
                    log_debug(f"Mask stored in cache with size: {pil_mask.size}")

            self.__class__._canvas_cache['cache_enabled'] = cache_enabled

            try:
                # Wczytaj obraz bez maski
                image_without_mask_name = canvas_image.replace('.png', '_without_mask.png')
                path_image_without_mask = folder_paths.get_annotated_filepath(image_without_mask_name)
                log_debug(f"Canvas image name: {canvas_image}")
                log_debug(f"Looking for image without mask: {image_without_mask_name}")
                log_debug(f"Full path: {path_image_without_mask}")
                
                # Sprawdź czy plik istnieje
                if not os.path.exists(path_image_without_mask):
                    log_warn(f"Image without mask not found at: {path_image_without_mask}")
                    # Spróbuj znaleźć plik w katalogu input
                    input_dir = folder_paths.get_input_directory()
                    alternative_path = os.path.join(input_dir, image_without_mask_name)
                    log_debug(f"Trying alternative path: {alternative_path}")
                    if os.path.exists(alternative_path):
                        path_image_without_mask = alternative_path
                        log_info(f"Found image at alternative path: {alternative_path}")
                    else:
                        raise FileNotFoundError(f"Image file not found: {image_without_mask_name}")
                
                i = Image.open(path_image_without_mask)
                i = ImageOps.exif_transpose(i)
                if i.mode not in ['RGB', 'RGBA']:
                    i = i.convert('RGB')
                image = np.array(i).astype(np.float32) / 255.0
                if i.mode == 'RGBA':
                    rgb = image[..., :3]
                    alpha = image[..., 3:]
                    image = rgb * alpha + (1 - alpha) * 0.5
                processed_image = torch.from_numpy(image)[None,]
                log_debug(f"Successfully loaded image without mask, shape: {processed_image.shape}")
            except Exception as e:
                log_error(f"Error loading image without mask: {str(e)}")
                processed_image = torch.ones((1, 512, 512, 3), dtype=torch.float32)
                log_debug(f"Using default image, shape: {processed_image.shape}")

            try:
                # Wczytaj maskę
                path_image = folder_paths.get_annotated_filepath(canvas_image)
                path_mask = path_image.replace('.png', '_mask.png')
                log_debug(f"Canvas image path: {path_image}")
                log_debug(f"Looking for mask at: {path_mask}")
                
                # Sprawdź czy plik maski istnieje
                if not os.path.exists(path_mask):
                    log_warn(f"Mask not found at: {path_mask}")
                    # Spróbuj znaleźć plik w katalogu input
                    input_dir = folder_paths.get_input_directory()
                    mask_name = canvas_image.replace('.png', '_mask.png')
                    alternative_mask_path = os.path.join(input_dir, mask_name)
                    log_debug(f"Trying alternative mask path: {alternative_mask_path}")
                    if os.path.exists(alternative_mask_path):
                        path_mask = alternative_mask_path
                        log_info(f"Found mask at alternative path: {alternative_mask_path}")
                
                if os.path.exists(path_mask):
                    log_debug(f"Mask file exists, loading...")
                    mask = Image.open(path_mask).convert('L')
                    mask = np.array(mask).astype(np.float32) / 255.0
                    processed_mask = torch.from_numpy(mask)[None,]
                    log_debug(f"Successfully loaded mask, shape: {processed_mask.shape}")
                else:
                    log_debug(f"Mask file does not exist, creating default mask")
                    processed_mask = torch.ones((1, processed_image.shape[1], processed_image.shape[2]),
                                                dtype=torch.float32)
                    log_debug(f"Default mask created, shape: {processed_mask.shape}")
            except Exception as e:
                log_error(f"Error loading mask: {str(e)}")
                processed_mask = torch.ones((1, processed_image.shape[1], processed_image.shape[2]),
                                            dtype=torch.float32)
                log_debug(f"Fallback mask created, shape: {processed_mask.shape}")

            if not output_switch:
                log_debug(f"Output switch is OFF, returning empty tuple")
                return ()

            log_debug(f"About to return output - Image shape: {processed_image.shape}, Mask shape: {processed_mask.shape}")
            log_debug(f"Image tensor info - dtype: {processed_image.dtype}, device: {processed_image.device}")
            log_debug(f"Mask tensor info - dtype: {processed_mask.dtype}, device: {processed_mask.device}")
            
            self.update_persistent_cache()
            
            log_info(f"Successfully returning processed image and mask")
            return (processed_image, processed_mask)

        except Exception as e:
            log_exception(f"Error in process_canvas_image: {str(e)}")
            return ()
            
        finally:
            # Zwolnij blokadę
            self.__class__._processing_lock = None
            log_debug(f"Process completed, lock released")

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
    def get_flow_status(cls, flow_id=None):

        if flow_id:
            return cls._canvas_cache['data_flow_status'].get(flow_id)
        return cls._canvas_cache['data_flow_status']

    @classmethod
    def setup_routes(cls):
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
                    log_debug(f"Model type: {type(self.model)}")
                    log_debug(f"Model device: {next(self.model.parameters()).device}")

                except Exception as e:
                    log_error(f"Failed to load model: {str(e)}")
                    raise

            else:
                self.model = self.model_cache[model_path]
                log_debug("Using cached model")

            return True

        except Exception as e:
            log_error(f"Error loading model: {str(e)}")
            log_exception("Model loading failed")
            return False

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

            if not self.load_model(model_path):
                raise RuntimeError("Failed to load model")

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


# Zmienna blokująca równoczesne wywołania matting
_matting_lock = None

@PromptServer.instance.routes.post("/matting")
async def matting(request):
    global _matting_lock
    
    # Sprawdź czy już trwa przetwarzanie
    if _matting_lock is not None:
        log_warn("Matting already in progress, rejecting request")
        return web.json_response({
            "error": "Another matting operation is in progress",
            "details": "Please wait for the current operation to complete"
        }, status=429)  # 429 Too Many Requests
        
    # Ustaw blokadę
    _matting_lock = True
    
    try:
        log_info("Received matting request")
        data = await request.json()

        matting = BiRefNetMatting()

        image_tensor, original_alpha = convert_base64_to_tensor(data["image"])
        log_debug(f"Input image shape: {image_tensor.shape}")

        matted_image, alpha_mask = matting.execute(
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

    except Exception as e:
        log_exception(f"Error in matting endpoint: {str(e)}")
        return web.json_response({
            "error": str(e),
            "details": traceback.format_exc()
        }, status=500)
    finally:
        # Zwolnij blokadę
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
