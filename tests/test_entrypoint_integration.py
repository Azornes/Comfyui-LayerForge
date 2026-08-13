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

    tqdm = ModuleType("tqdm")
    tqdm.tqdm = lambda iterable, *args, **kwargs: iterable
    monkeypatch.setitem(sys.modules, "tqdm", tqdm)

    # Avoid creating project log files while the entry point is imported.
    from python.log_system import logger

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
        node=sys.modules[f"{package_name}.python.node"],
        image_utils=sys.modules[f"{package_name}.python.image_utils"],
        matting=sys.modules[f"{package_name}.python.matting"],
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

    node_class = layerforge_runtime.node.LayerForgeNode
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

    node_module = layerforge_runtime.image_utils
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

    roundtrip_image = Image.open(io.BytesIO(base64.b64decode(roundtrip.split(",", 1)[1])))
    assert roundtrip_image.mode == "RGB"
    assert roundtrip_image.size == (2, 2)
    assert roundtrip_image.getpixel((0, 0)) == (255, 0, 0)


def test_tensor_input_payloads_preserve_single_and_batch_image_contract(layerforge_runtime):
    import torch
    from PIL import Image

    node_class = layerforge_runtime.node.LayerForgeNode
    node_class._canvas_data_storage.clear()
    node_class._canvas_cache["persistent_cache"] = {}
    node = node_class()
    single_image = torch.tensor(
        [[
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 1.0], [1.0, 1.0, 1.0]],
        ]],
        dtype=torch.float32,
    )

    node.process_canvas_image(False, False, False, 0, "single-input", input_image=single_image)
    single_payload = node_class._canvas_data_storage["single-input_input"]
    single_image_data = base64.b64decode(single_payload["input_image"].split(",", 1)[1])
    single_decoded = Image.open(io.BytesIO(single_image_data))

    assert single_payload["input_image_width"] == 2
    assert single_payload["input_image_height"] == 2
    assert single_decoded.size == (2, 2)
    assert single_decoded.getpixel((0, 0)) == (255, 0, 0)

    batch_image = torch.stack((single_image[0], single_image[0] * 0.5))
    node.process_canvas_image(False, False, False, 0, "batch-input", input_image=batch_image)
    batch_payload = node_class._canvas_data_storage["batch-input_input"]

    assert "input_image" not in batch_payload
    assert [item["width"] for item in batch_payload["input_images_batch"]] == [2, 2]
    assert [item["height"] for item in batch_payload["input_images_batch"]] == [2, 2]
    assert all(item["data"].startswith("data:image/png;base64,") for item in batch_payload["input_images_batch"])


def test_latest_image_helpers_preserve_filtering_and_time_semantics(layerforge_runtime, monkeypatch, tmp_path):
    node_module = layerforge_runtime.node
    node_class = node_module.LayerForgeNode
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    first_image = output_dir / "first.png"
    second_image = output_dir / "second.JPG"
    ignored_file = output_dir / "ignored.txt"
    ignored_directory = output_dir / "folder.png"
    first_image.write_bytes(b"first")
    second_image.write_bytes(b"second")
    ignored_file.write_bytes(b"ignored")
    ignored_directory.mkdir()

    monkeypatch.setattr(
        node_module.folder_paths,
        "get_output_directory",
        lambda: str(output_dir),
        raising=False,
    )
    creation_times = {
        str(first_image): 10,
        str(second_image): 20,
    }
    monkeypatch.setattr(node_module.os.path, "getctime", lambda path: creation_times[path])
    assert node_class.get_latest_image() == str(second_image)

    modification_times = {
        str(first_image): 30,
        str(second_image): 20,
    }
    monkeypatch.setattr(node_module.os.path, "getmtime", lambda path: modification_times[path])
    assert node_class.get_latest_images(0) == [str(second_image), str(first_image)]
    assert node_class.get_latest_images(25) == [str(first_image)]


def test_websocket_and_cached_image_decoding_preserve_image_and_mask_modes(layerforge_runtime):
    from PIL import Image

    node_class = layerforge_runtime.node.LayerForgeNode
    node_class._canvas_data_storage.clear()
    node_class._canvas_cache["persistent_cache"] = {}

    image = Image.new("RGBA", (2, 1), (255, 0, 0, 128))
    mask = Image.new("L", (2, 1), 128)

    def encode(pil_image):
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    node_class._canvas_data_storage["decode-node"] = {
        "image": encode(image),
        "mask": encode(mask),
    }
    node = node_class()
    processed_image, processed_mask = node.process_canvas_image(
        False,
        False,
        False,
        0,
        "decode-node",
    )

    assert tuple(processed_image.shape) == (1, 1, 2, 3)
    assert tuple(processed_mask.shape) == (1, 1, 2)

    node.store_image(encode(image))
    assert node.cached_image.mode == "RGBA"
    assert node.cached_image.size == (2, 1)


def test_matting_adapter_uses_native_loader_and_bhwc_input(layerforge_runtime, monkeypatch):
    import torch

    node_module = layerforge_runtime.matting
    calls = {}

    class NativeBiRefNet:
        def encode_image(self, image):
            calls["shape"] = tuple(image.shape)
            calls["dtype"] = image.dtype
            return torch.full((image.shape[0], image.shape[1], image.shape[2]), 0.75)

    monkeypatch.setattr(
        node_module,
        "_get_comfy_birefnet_loader",
        lambda: lambda path: NativeBiRefNet(),
    )
    monkeypatch.setattr(
        node_module,
        "_ensure_birefnet_checkpoint",
        lambda model_path=None: "native-birefnet.safetensors",
    )
    node_module.BiRefNetMatting._model_cache.clear()

    image = torch.rand((1, 3, 2, 4), dtype=torch.float32)
    matted_image, alpha_mask = node_module.BiRefNetMatting().execute(
        image,
        model_path=None,
        threshold=0,
        refinement=1,
    )

    assert calls == {"shape": (1, 2, 4, 3), "dtype": torch.float32}
    assert tuple(matted_image.shape) == (1, 3, 2, 4)
    assert tuple(alpha_mask.shape) == (1, 1, 2, 4)


def test_matting_adapter_supports_inverted_and_mask_only_modes(layerforge_runtime, monkeypatch):
    import torch

    node_module = layerforge_runtime.matting

    class NativeBiRefNet:
        def encode_image(self, image):
            return torch.full((image.shape[0], image.shape[1], image.shape[2]), 0.75)

    monkeypatch.setattr(
        node_module,
        "_get_comfy_birefnet_loader",
        lambda: lambda path: NativeBiRefNet(),
    )
    monkeypatch.setattr(
        node_module,
        "_ensure_birefnet_checkpoint",
        lambda model_path=None: "native-birefnet.safetensors",
    )
    node_module.BiRefNetMatting._model_cache.clear()

    image = torch.ones((1, 3, 2, 4), dtype=torch.float32)
    matting = node_module.BiRefNetMatting()

    removed_foreground, inverted_mask = matting.execute(
        image,
        model_path=None,
        threshold=0.5,
        refinement=1,
        mode="remove_foreground",
    )
    mask_preview, preview_mask = matting.execute(
        image,
        model_path=None,
        threshold=0.5,
        refinement=1,
        mode="mask_only",
    )

    assert torch.allclose(removed_foreground, torch.zeros_like(removed_foreground))
    assert torch.allclose(inverted_mask, torch.zeros_like(inverted_mask))
    assert torch.allclose(mask_preview, torch.ones_like(mask_preview))
    assert torch.allclose(preview_mask, torch.ones_like(preview_mask))


def test_matting_model_options_include_downloadable_official_variants(layerforge_runtime, monkeypatch):
    node_module = layerforge_runtime.matting

    monkeypatch.setattr(node_module, "_iter_birefnet_checkpoint_paths", lambda: iter(()))

    options = node_module._get_birefnet_model_options()
    remote_options = [option for option in options if option["source"] == "remote"]

    assert remote_options
    assert all(option["path"].startswith("remote:") for option in remote_options)
    assert all(option["downloaded"] is False for option in remote_options)
    assert all(option["description"] for option in remote_options)
    assert all(option["url"].startswith("https://huggingface.co/") for option in remote_options)
    assert all(option["project_url"] == "https://github.com/ZhengPeng7/BiRefNet" for option in remote_options)
    assert any(option["path"] == "remote:portrait" for option in remote_options)
    portrait = next(option for option in node_module._BIREFNET_MODEL_CATALOG if option["id"] == "portrait")
    assert portrait["local_filename"] == "BiRefNet-portrait.safetensors"


def test_selected_remote_matting_model_is_sent_to_downloader(layerforge_runtime, monkeypatch):
    node_module = layerforge_runtime.matting
    selected_model = next(
        model for model in node_module._BIREFNET_MODEL_CATALOG if model["id"] == "portrait"
    )
    downloaded = {}

    monkeypatch.setattr(node_module, "_is_native_birefnet_checkpoint", lambda path: False)

    def fake_download(model=None):
        downloaded["model"] = model
        return "downloaded-portrait.safetensors"

    monkeypatch.setattr(node_module, "_download_birefnet_checkpoint", fake_download)

    result = node_module._ensure_birefnet_checkpoint("remote:portrait")

    assert result == "downloaded-portrait.safetensors"
    assert downloaded["model"] is selected_model


def test_legacy_automatic_checkpoint_gets_friendly_filename(layerforge_runtime, monkeypatch, tmp_path):
    node_module = layerforge_runtime.matting
    model_dir = Path(tmp_path) / "models" / "background_removal"
    model_dir.mkdir(parents=True)
    legacy_path = model_dir / "model.safetensors"
    legacy_path.write_bytes(b"legacy checkpoint")

    monkeypatch.setattr(
        node_module,
        "_is_native_birefnet_checkpoint",
        lambda path: Path(path).resolve() == legacy_path.resolve(),
    )

    result = node_module._find_existing_birefnet_default_checkpoint()
    friendly_path = model_dir / "BiRefNet-general.safetensors"

    assert Path(result) == friendly_path
    assert friendly_path.exists()
    assert not legacy_path.exists()


def test_legacy_remote_checkpoint_gets_friendly_filename(layerforge_runtime, monkeypatch, tmp_path):
    node_module = layerforge_runtime.matting
    model = next(model for model in node_module._BIREFNET_MODEL_CATALOG if model["id"] == "portrait")
    managed_dir = Path(tmp_path) / "managed" / model["id"]
    managed_dir.mkdir(parents=True)
    legacy_path = managed_dir / model["filename"]
    friendly_path = managed_dir / model["local_filename"]
    legacy_path.write_bytes(b"legacy checkpoint")

    monkeypatch.setattr(
        node_module,
        "_get_birefnet_remote_checkpoint_path",
        lambda selected_model: str(friendly_path) if selected_model is model else None,
    )
    monkeypatch.setattr(
        node_module,
        "_get_birefnet_remote_legacy_checkpoint_path",
        lambda selected_model: str(legacy_path) if selected_model is model else None,
    )
    monkeypatch.setattr(
        node_module,
        "_is_native_birefnet_checkpoint",
        lambda path: Path(path).resolve() == legacy_path.resolve(),
    )

    result = node_module._find_existing_birefnet_remote_checkpoint(model)

    assert Path(result) == friendly_path
    assert friendly_path.exists()
    assert not legacy_path.exists()


def test_empty_execution_returns_comfyui_compatible_fallback_tensors(layerforge_runtime):
    node_class = layerforge_runtime.node.LayerForgeNode
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
