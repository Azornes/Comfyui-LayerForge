import base64
import importlib.util
import io
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class RecordingRoutes:
    """Minimal PromptServer route registry for integration tests."""

    def __init__(self):
        self.registered = {}

    def _decorator(self, method, path):
        def register(handler):
            self.registered[(method, path)] = handler
            return handler

        return register

    def get(self, path):
        return self._decorator("GET", path)

    def post(self, path):
        return self._decorator("POST", path)


def _install_runtime_stubs(monkeypatch, tmp_path):
    routes = RecordingRoutes()

    folder_paths = ModuleType("folder_paths")
    folder_paths.models_dir = str(tmp_path / "models")
    monkeypatch.setitem(sys.modules, "folder_paths", folder_paths)

    server = ModuleType("server")
    server.PromptServer = SimpleNamespace(
        instance=SimpleNamespace(routes=routes, send_sync=lambda *args, **kwargs: None)
    )
    monkeypatch.setitem(sys.modules, "server", server)

    aiohttp = ModuleType("aiohttp")
    aiohttp.web = SimpleNamespace()
    monkeypatch.setitem(sys.modules, "aiohttp", aiohttp)

    import numpy as np
    import torch

    class ToTensor:
        def __call__(self, image):
            array = np.array(image, copy=True)
            tensor = torch.from_numpy(array).float() / 255.0
            if tensor.dim() == 2:
                return tensor
            return tensor.permute(2, 0, 1)

    torchvision = ModuleType("torchvision")
    torchvision.transforms = SimpleNamespace(ToTensor=ToTensor)
    monkeypatch.setitem(sys.modules, "torchvision", torchvision)

    transformers = ModuleType("transformers")

    class PretrainedConfig:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    transformers.PretrainedConfig = PretrainedConfig
    transformers.AutoModelForImageSegmentation = SimpleNamespace()
    monkeypatch.setitem(sys.modules, "transformers", transformers)

    tqdm = ModuleType("tqdm")
    tqdm.tqdm = lambda iterable, *args, **kwargs: iterable
    monkeypatch.setitem(sys.modules, "tqdm", tqdm)

    # Avoid creating project log files while the entry point is imported.
    from python.logger import logger

    monkeypatch.setattr(logger, "configure", lambda config: logger)

    return routes


def _import_layerforge(monkeypatch, tmp_path):
    routes = _install_runtime_stubs(monkeypatch, tmp_path)
    package_name = "_layerforge_test_package"
    package_path = PROJECT_ROOT / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        package_name,
        package_path,
        submodule_search_locations=[str(PROJECT_ROOT)],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    assert spec.loader is not None
    spec.loader.exec_module(package)

    return SimpleNamespace(
        entrypoint=package,
        canvas_node=sys.modules[f"{package_name}.canvas_node"],
        routes=routes,
        package_name=package_name,
    )


@pytest.fixture
def layerforge_runtime(monkeypatch, tmp_path):
    runtime = _import_layerforge(monkeypatch, tmp_path)
    yield runtime

    for module_name in list(sys.modules):
        if module_name == runtime.package_name or module_name.startswith(f"{runtime.package_name}."):
            sys.modules.pop(module_name, None)


def test_entrypoint_exports_node_contract_and_frontend_directory(layerforge_runtime):
    entrypoint = layerforge_runtime.entrypoint
    node_class = entrypoint.NODE_CLASS_MAPPINGS["LayerForgeNode"]

    assert entrypoint.WEB_DIRECTORY == "./js"
    assert entrypoint.__all__ == [
        "NODE_CLASS_MAPPINGS",
        "NODE_DISPLAY_NAME_MAPPINGS",
        "WEB_DIRECTORY",
    ]
    assert node_class.RETURN_TYPES == ("IMAGE", "MASK")
    assert node_class.RETURN_NAMES == ("image", "mask")
    assert node_class.FUNCTION == "process_canvas_image"
    assert node_class.CATEGORY == "azNodes > LayerForge"

    inputs = node_class.INPUT_TYPES()
    assert set(inputs) == {"required", "optional", "hidden"}
    assert {
        "fit_on_add",
        "show_preview",
        "auto_refresh_after_generation",
        "trigger",
        "node_id",
    } <= set(inputs["required"])
    assert inputs["optional"] == {"input_image": ("IMAGE",), "input_mask": ("MASK",)}


def test_entrypoint_registers_backend_route_contract(layerforge_runtime):
    registered = set(layerforge_runtime.routes.registered)
    expected = {
        ("GET", "/layerforge/canvas_ws"),
        ("GET", "/layerforge/get_input_data/{node_id}"),
        ("POST", "/layerforge/clear_input_data/{node_id}"),
        ("GET", "/ycnode/get_canvas_data/{node_id}"),
        ("GET", "/layerforge/get-latest-images/{since}"),
        ("GET", "/ycnode/get_latest_image"),
        ("POST", "/ycnode/load_image_from_path"),
        ("GET", "/matting/check-model"),
        ("POST", "/matting"),
    }

    assert expected <= registered


def test_tensor_input_normalization_preserves_comfyui_shapes(layerforge_runtime):
    import torch

    node_class = layerforge_runtime.canvas_node.LayerForgeNode
    node_class._canvas_cache["persistent_cache"] = {}
    node = node_class()

    chw_image = torch.ones((1, 3, 2, 4), dtype=torch.float32)
    normalized_image = node.add_image_to_canvas(chw_image)
    assert tuple(normalized_image.shape) == (2, 4, 3)

    small_mask = torch.zeros((1, 2, 2), dtype=torch.float32)
    resized_mask = node.add_mask_to_canvas(small_mask, torch.zeros((4, 4, 3)))
    assert tuple(resized_mask.shape) == (4, 4)


def test_base64_image_conversion_preserves_rgb_and_alpha(layerforge_runtime):
    import torch
    from PIL import Image

    node_module = layerforge_runtime.canvas_node
    image = Image.new("RGBA", (2, 1), (255, 0, 0, 128))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    tensor, alpha = node_module.convert_base64_to_tensor(encoded)

    assert tuple(tensor.shape) == (1, 3, 1, 2)
    assert tuple(alpha.shape) == (1, 1, 2)
    assert float(alpha[0, 0, 0]) == pytest.approx(128 / 255, abs=0.01)

    rgb_tensor = torch.tensor(
        [
            [
                [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                [[0.0, 0.0, 1.0], [1.0, 1.0, 1.0]],
            ]
        ],
        dtype=torch.float32,
    )
    roundtrip = node_module.convert_tensor_to_base64(rgb_tensor)
    assert roundtrip.startswith("data:image/png;base64,")


def test_empty_execution_returns_comfyui_compatible_fallback_tensors(layerforge_runtime):
    node_class = layerforge_runtime.canvas_node.LayerForgeNode
    node_class._canvas_data_storage.clear()
    node_class._canvas_cache["persistent_cache"] = {}
    node = node_class()

    image, mask = node.process_canvas_image(
        False,
        False,
        False,
        0,
        "test-node",
    )

    assert tuple(image.shape) == (1, 512, 512, 3)
    assert tuple(mask.shape) == (1, 512, 512)
