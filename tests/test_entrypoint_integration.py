import asyncio
import base64
import importlib.util
import io
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _record_matting_responses(monkeypatch, node_module):
    responses = []

    def json_response(payload, **kwargs):
        response = SimpleNamespace(payload=payload, status=kwargs.get("status", 200))
        responses.append(response)
        return response

    monkeypatch.setattr(node_module.web, "json_response", json_response, raising=False)
    return responses


def _run_matting_model_check(node_module, model_path=None):
    query = {} if model_path is None else {"model_path": model_path}
    request = SimpleNamespace(query=query)
    return asyncio.run(node_module.check_matting_model(request))


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
    from python.log_system.logger import logger

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
        matting_api=sys.modules[f"{package_name}.python.matting.api"],
        matting_birefnet=sys.modules[f"{package_name}.python.matting.backends.birefnet"],
        matting_rmbg=sys.modules[f"{package_name}.python.matting.backends.rmbg"],
        matting_catalog=sys.modules[f"{package_name}.python.matting.catalog"],
        matting_options=sys.modules[f"{package_name}.python.matting.options"],
        matting_paths=sys.modules[f"{package_name}.python.matting.paths"],
        matting_settings=sys.modules[f"{package_name}.python.matting.settings"],
        matting_service=sys.modules[f"{package_name}.python.matting.service"],
        matting_progress=sys.modules[f"{package_name}.python.matting.progress"],
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
    assert inputs["optional"]["input_image"] == ("IMAGE",)
    assert inputs["optional"]["input_mask"] == ("MASK",)
    transport_inputs = {
        name: value
        for name, value in inputs["optional"].items()
        if name.startswith("input_image_")
    }
    assert len(transport_inputs) == 32
    assert all(value == ("IMAGE", {"hidden": True}) for value in transport_inputs.values())


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
        ("GET", "/matting/settings"),
        ("POST", "/matting/settings"),
        ("GET", "/matting/check-model"),
        ("GET", "/matting/progress"),
        ("POST", "/matting"),
    }

    assert expected <= registered


def test_matting_settings_are_persisted_without_exposing_the_token(layerforge_runtime, monkeypatch, tmp_path):
    settings_module = layerforge_runtime.matting_settings
    settings_file = tmp_path / "layerforge_settings.json"
    monkeypatch.setattr(settings_module, "SETTINGS_FILE", settings_file)

    saved = settings_module.save_settings(
        {
            "model_path": "remote:rmbg_2_0",
            "mode": "mask_only_inverted",
            "threshold": 0.75,
            "hf_token": "hf-test-token",
        }
    )

    assert saved["model_path"] == "remote:rmbg_2_0"
    assert saved["mode"] == "mask_only_inverted"
    assert saved["threshold"] == 0.75
    assert settings_module.get_huggingface_token() == "hf-test-token"
    public_settings = settings_module.get_public_settings()
    assert public_settings["hf_token_configured"] is True
    assert "hf_token" not in public_settings
    assert settings_file.exists()

    settings_module.save_settings({"clear_hf_token": True})
    assert settings_module.get_huggingface_token() == ""


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


def test_tensor_input_payloads_preserve_ordered_multiple_image_inputs(layerforge_runtime):
    import torch
    from PIL import Image

    node_class = layerforge_runtime.node.LayerForgeNode
    node_class._canvas_data_storage.clear()
    node_class._canvas_cache["persistent_cache"] = {}
    node = node_class()

    red = torch.tensor(
        [[[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ]]],
        dtype=torch.float32,
    )
    green = red.clone()
    green[..., 0] = 0
    green[..., 1] = 1

    # Deliberately pass the transport inputs out of numeric order. The node
    # must preserve the port order used by the virtual multi-input frontend.
    node.process_canvas_image(
        False,
        False,
        False,
        0,
        "multi-input",
        input_image_2=green,
        input_image_1=red,
    )
    payload = node_class._canvas_data_storage["multi-input_input"]

    assert "input_image" not in payload
    assert len(payload["input_images"]) == 2
    decoded = [
        Image.open(io.BytesIO(base64.b64decode(item["data"].split(",", 1)[1])))
        for item in payload["input_images"]
    ]
    assert decoded[0].getpixel((0, 0)) == (255, 0, 0)
    assert decoded[1].getpixel((0, 0)) == (0, 255, 0)


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

    service_module = layerforge_runtime.matting_service
    calls = {}

    class NativeBiRefNet:
        def encode_image(self, image):
            calls["shape"] = tuple(image.shape)
            calls["dtype"] = image.dtype
            return torch.full((image.shape[0], image.shape[1], image.shape[2]), 0.75)

    monkeypatch.setattr(
        service_module,
        "_get_comfy_birefnet_loader",
        lambda: lambda path: NativeBiRefNet(),
    )
    monkeypatch.setattr(
        service_module,
        "_ensure_birefnet_checkpoint",
        lambda model_path=None: "native-birefnet.safetensors",
    )
    service_module.BiRefNetMatting._model_cache.clear()

    image = torch.rand((1, 3, 2, 4), dtype=torch.float32)
    matted_image, alpha_mask = service_module.BiRefNetMatting().execute(
        image,
        model_path=None,
        threshold=0,
        refinement=1,
    )

    assert calls == {"shape": (1, 2, 4, 3), "dtype": torch.float32}
    assert tuple(matted_image.shape) == (1, 3, 2, 4)
    assert tuple(alpha_mask.shape) == (1, 1, 2, 4)


def test_matting_adapter_translates_comfyui_interrupt(layerforge_runtime, monkeypatch):
    import torch

    service_module = layerforge_runtime.matting_service

    class FakeInterruptProcessingException(BaseException):
        pass

    comfy_module = ModuleType("comfy")
    model_management = ModuleType("comfy.model_management")
    model_management.InterruptProcessingException = FakeInterruptProcessingException
    comfy_module.model_management = model_management
    monkeypatch.setitem(sys.modules, "comfy", comfy_module)
    monkeypatch.setitem(sys.modules, "comfy.model_management", model_management)

    class InterruptingBiRefNet:
        def encode_image(self, image):
            del image
            raise FakeInterruptProcessingException()

    monkeypatch.setattr(
        service_module,
        "_get_comfy_birefnet_loader",
        lambda: lambda path: InterruptingBiRefNet(),
    )
    monkeypatch.setattr(
        service_module,
        "_ensure_birefnet_checkpoint",
        lambda model_path=None: "interrupting-birefnet.safetensors",
    )
    service_module.BiRefNetMatting._model_cache.clear()

    with pytest.raises(service_module.MattingInterruptedError, match="interrupted"):
        service_module.BiRefNetMatting().execute(
            torch.ones((1, 3, 2, 4), dtype=torch.float32),
            model_path=None,
            threshold=0,
            refinement=1,
        )


def test_matting_model_status_preserves_unsupported_and_error_responses(layerforge_runtime, monkeypatch):
    api_module = layerforge_runtime.matting_api
    responses = _record_matting_responses(monkeypatch, api_module)

    monkeypatch.setattr(api_module, "_get_comfy_birefnet_loader", lambda: None)
    unsupported = _run_matting_model_check(api_module)

    assert unsupported.payload["available"] is False
    assert unsupported.payload["reason"] == "unsupported_comfyui"
    assert unsupported.payload["message"] == (
        "This ComfyUI version does not provide the native BiRefNet background-removal loader."
    )
    assert unsupported.payload["models"]
    assert unsupported.status == 200

    monkeypatch.setattr(api_module, "_get_comfy_birefnet_loader", lambda: object())

    def fail_to_read_options():
        raise RuntimeError("catalog unavailable")

    monkeypatch.setattr(api_module, "_get_birefnet_model_options", fail_to_read_options)
    failed = _run_matting_model_check(api_module)

    assert failed.payload == {
        "available": False,
        "reason": "error",
        "message": "Error checking model status: catalog unavailable",
    }
    assert failed.status == 500
    assert len(responses) == 2


def test_matting_model_status_preserves_remote_model_responses(layerforge_runtime, monkeypatch):
    api_module = layerforge_runtime.matting_api
    responses = _record_matting_responses(monkeypatch, api_module)
    model_options = [{"path": "remote:portrait", "label": "Portrait"}]
    remote_model = {"label": "Portrait"}

    monkeypatch.setattr(api_module, "_get_comfy_birefnet_loader", lambda: object())
    monkeypatch.setattr(api_module, "_get_birefnet_model_options", lambda: model_options)
    monkeypatch.setattr(api_module, "_get_birefnet_remote_model", lambda path: remote_model)
    monkeypatch.setattr(
        api_module,
        "_find_existing_birefnet_remote_checkpoint",
        lambda model: "/models/portrait.safetensors",
    )

    ready = _run_matting_model_check(api_module, "remote:portrait")

    assert ready.payload == {
        "available": True,
        "reason": "ready",
        "message": "Selected model is ready to use",
        "model_path": "/models/portrait.safetensors",
        "selected_model": "Portrait",
        "models": model_options,
    }
    assert ready.status == 200

    monkeypatch.setattr(api_module, "_find_existing_birefnet_remote_checkpoint", lambda model: None)
    missing = _run_matting_model_check(api_module, "remote:portrait")

    assert missing.payload == {
        "available": False,
        "reason": "not_downloaded",
        "message": "Portrait will be downloaded automatically on first use.",
        "model_path": "remote:portrait",
        "selected_model": "Portrait",
        "models": model_options,
    }
    assert missing.status == 200
    assert len(responses) == 2


def test_matting_model_status_preserves_local_and_automatic_responses(layerforge_runtime, monkeypatch):
    api_module = layerforge_runtime.matting_api
    responses = _record_matting_responses(monkeypatch, api_module)
    model_options = [{"path": "/models/custom.safetensors", "label": "custom.safetensors"}]

    monkeypatch.setattr(api_module, "_get_comfy_birefnet_loader", lambda: object())
    monkeypatch.setattr(api_module, "_get_birefnet_model_options", lambda: model_options)
    monkeypatch.setattr(api_module, "_get_birefnet_remote_model", lambda path: None)
    monkeypatch.setattr(
        api_module,
        "_find_local_birefnet_model",
        lambda model_path=None: "/models/custom.safetensors",
    )

    selected = _run_matting_model_check(api_module, "/models/custom.safetensors")

    assert selected.payload == {
        "available": True,
        "reason": "ready",
        "message": "Selected model is ready to use",
        "model_path": "/models/custom.safetensors",
        "selected_model": "/models/custom.safetensors",
        "models": model_options,
    }
    assert selected.status == 200

    monkeypatch.setattr(api_module, "_find_local_birefnet_model", lambda model_path=None: None)
    unavailable = _run_matting_model_check(api_module, "/models/missing.safetensors")

    assert unavailable.payload == {
        "available": False,
        "reason": "selected_model_unavailable",
        "message": "The selected BiRefNet checkpoint is not available or is not compatible with ComfyUI.",
        "model_path": "/models/missing.safetensors",
        "models": model_options,
    }
    assert unavailable.status == 200

    monkeypatch.setattr(
        api_module,
        "_find_local_birefnet_model",
        lambda model_path=None: "/models/automatic.safetensors",
    )
    automatic = _run_matting_model_check(api_module)

    assert automatic.payload == {
        "available": True,
        "reason": "ready",
        "message": "Model is ready to use",
        "model_path": "/models/automatic.safetensors",
        "models": model_options,
    }
    assert automatic.status == 200

    monkeypatch.setattr(api_module, "_find_local_birefnet_model", lambda model_path=None: None)
    monkeypatch.setattr(
        api_module,
        "_get_birefnet_base_paths",
        lambda: ["/models/background_removal"],
    )
    not_downloaded = _run_matting_model_check(api_module)

    assert not_downloaded.payload == {
        "available": False,
        "reason": "not_downloaded",
        "message": "The BiRefNet checkpoint will be downloaded automatically on first use (requires internet connection).",
        "model_path": "/models/background_removal",
        "models": model_options,
    }
    assert not_downloaded.status == 200
    assert len(responses) == 4


def test_matting_adapter_supports_inverted_and_mask_only_modes(layerforge_runtime, monkeypatch):
    import torch

    service_module = layerforge_runtime.matting_service

    class NativeBiRefNet:
        def encode_image(self, image):
            return torch.full((image.shape[0], image.shape[1], image.shape[2]), 0.75)

    monkeypatch.setattr(
        service_module,
        "_get_comfy_birefnet_loader",
        lambda: lambda path: NativeBiRefNet(),
    )
    monkeypatch.setattr(
        service_module,
        "_ensure_birefnet_checkpoint",
        lambda model_path=None: "native-birefnet.safetensors",
    )
    service_module.BiRefNetMatting._model_cache.clear()

    image = torch.ones((1, 3, 2, 4), dtype=torch.float32)
    matting = service_module.BiRefNetMatting()

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
    inverted_mask_preview, inverted_preview_mask = matting.execute(
        image,
        model_path=None,
        threshold=0.5,
        refinement=1,
        mode="mask_only_inverted",
    )

    assert torch.allclose(removed_foreground, torch.zeros_like(removed_foreground))
    assert torch.allclose(inverted_mask, torch.zeros_like(inverted_mask))
    assert torch.allclose(mask_preview, torch.ones_like(mask_preview))
    assert torch.allclose(preview_mask, torch.ones_like(preview_mask))
    assert torch.allclose(inverted_mask_preview, torch.zeros_like(inverted_mask_preview))
    assert torch.allclose(inverted_preview_mask, torch.zeros_like(inverted_preview_mask))


def test_matting_model_options_include_downloadable_official_variants(layerforge_runtime, monkeypatch):
    birefnet_module = layerforge_runtime.matting_birefnet
    options_module = layerforge_runtime.matting_options
    catalog_module = layerforge_runtime.matting_catalog

    monkeypatch.setattr(birefnet_module, "_iter_birefnet_checkpoint_paths", lambda: iter(()))

    options = options_module._get_birefnet_model_options()
    remote_options = [option for option in options if option["source"] == "remote"]

    assert remote_options
    assert all(option["path"].startswith("remote:") for option in remote_options)
    assert all(option["downloaded"] is False for option in remote_options)
    assert all(option["description"] for option in remote_options)
    assert all(option["url"].startswith("https://huggingface.co/") for option in remote_options)
    birefnet_options = [option for option in remote_options if option["backend"] == "birefnet"]
    assert all(option["project_url"] == "https://github.com/ZhengPeng7/BiRefNet" for option in birefnet_options)
    assert any(option["path"] == "remote:portrait" for option in remote_options)
    portrait = next(option for option in catalog_module._BIREFNET_MODEL_CATALOG if option["id"] == "portrait")
    assert portrait["local_filename"] == "BiRefNet-portrait.safetensors"

    rmbg_option = next(option for option in remote_options if option["path"] == "remote:rmbg_2_0")
    assert rmbg_option["backend"] == "rmbg"
    assert rmbg_option["label"] == "BRIA RMBG 2.0"
    assert rmbg_option["project_url"] == "https://github.com/Bria-AI/RMBG-2.0"


def test_selected_remote_matting_model_is_sent_to_downloader(layerforge_runtime, monkeypatch):
    birefnet_module = layerforge_runtime.matting_birefnet
    catalog_module = layerforge_runtime.matting_catalog
    selected_model = next(
        model for model in catalog_module._BIREFNET_MODEL_CATALOG if model["id"] == "portrait"
    )
    downloaded = {}

    monkeypatch.setattr(birefnet_module, "_is_native_birefnet_checkpoint", lambda path: False)

    def fake_download(model=None):
        downloaded["model"] = model
        return "downloaded-portrait.safetensors"

    monkeypatch.setattr(birefnet_module, "_download_birefnet_checkpoint", fake_download)

    result = birefnet_module._ensure_birefnet_checkpoint("remote:portrait")

    assert result == "downloaded-portrait.safetensors"
    assert downloaded["model"] is selected_model


def test_remote_matting_checkpoint_path_uses_background_removal_root(layerforge_runtime):
    import folder_paths

    catalog_module = layerforge_runtime.matting_catalog
    paths_module = layerforge_runtime.matting_paths
    model = next(model for model in catalog_module._BIREFNET_MODEL_CATALOG if model["id"] == "portrait")

    expected = Path(folder_paths.models_dir) / "background_removal" / model[
        "local_filename"
    ]

    assert Path(paths_module._get_birefnet_remote_checkpoint_path(model)) == expected


def test_remote_matting_download_uses_background_removal_root(layerforge_runtime, monkeypatch, tmp_path):
    birefnet_module = layerforge_runtime.matting_birefnet
    catalog_module = layerforge_runtime.matting_catalog
    model = next(model for model in catalog_module._BIREFNET_MODEL_CATALOG if model["id"] == "portrait")
    download = {}

    def fake_hf_hub_download(**kwargs):
        download.update(kwargs)
        downloaded_path = Path(kwargs["local_dir"]) / kwargs["filename"]
        downloaded_path.write_bytes(b"checkpoint")
        return str(downloaded_path)

    huggingface_hub = ModuleType("huggingface_hub")
    huggingface_hub.hf_hub_download = fake_hf_hub_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", huggingface_hub)
    monkeypatch.setattr(birefnet_module, "_is_native_birefnet_checkpoint", lambda path: True)

    result = birefnet_module._download_birefnet_checkpoint(model)
    expected_dir = Path(tmp_path) / "models" / "background_removal"

    assert Path(download["local_dir"]) == expected_dir
    assert "layerforge_birefnet" not in Path(download["local_dir"]).parts
    assert Path(result) == expected_dir / model["local_filename"]
    assert Path(result).exists()


def test_model_download_progress_reports_bytes_to_the_frontend(layerforge_runtime, monkeypatch):
    progress_module = layerforge_runtime.matting_progress
    events = []
    monkeypatch.setattr(
        sys.modules["server"].PromptServer.instance,
        "send_sync",
        lambda *args: events.append(args),
    )

    progress_class = progress_module.create_huggingface_tqdm_class("Test model", node_id="42")
    progress = progress_class(total=100, initial=0, unit="B", disable=True)
    progress.update(25)
    progress.update(75)
    progress.close()

    download_events = [event for event in events if event[1]["status"] == "downloading"]
    assert download_events
    assert download_events[-1][1]["node_id"] == "42"
    assert download_events[-1][1]["progress"] == 100.0
    assert download_events[-1][1]["downloaded_bytes"] == 100
    assert download_events[-1][1]["total_bytes"] == 100
    progress_module.send_matting_status("completed", node_id="42")
    assert progress_module.get_matting_status("42")["status"] == "completed"


def test_matting_progress_status_is_available_without_websocket_delivery(layerforge_runtime):
    progress_module = layerforge_runtime.matting_progress

    progress_module.send_matting_status(
        "downloading",
        node_id="poll-node",
        progress=37.5,
        downloaded_bytes=375,
        total_bytes=1000,
    )

    assert progress_module.get_matting_status("poll-node") == {
        "status": "downloading",
        "node_id": "poll-node",
        "progress": 37.5,
        "downloaded_bytes": 375,
        "total_bytes": 1000,
    }
    progress_module.send_matting_status("completed", node_id="poll-node")


def test_rmbg_model_path_uses_background_removal_subdirectory(layerforge_runtime):
    import folder_paths

    catalog_module = layerforge_runtime.matting_catalog
    paths_module = layerforge_runtime.matting_paths
    model = catalog_module._RMBG_MODEL_CATALOG[0]

    expected = Path(folder_paths.models_dir) / "background_removal" / "RMBG-2.0"

    assert Path(paths_module._get_rmbg_model_directory(model)) == expected


def test_rmbg_checkpoint_is_not_selected_as_native_birefnet(layerforge_runtime, monkeypatch, tmp_path):
    birefnet_module = layerforge_runtime.matting_birefnet
    model_dir = Path(tmp_path) / "models" / "background_removal" / "RMBG-2.0"
    model_dir.mkdir(parents=True)
    checkpoint_path = model_dir / "model.safetensors"
    checkpoint_path.write_bytes(b"RMBG checkpoint")

    monkeypatch.setattr(birefnet_module, "_get_birefnet_base_paths", lambda: [str(model_dir.parent)])
    monkeypatch.setattr(birefnet_module, "_iter_birefnet_checkpoint_paths", lambda: iter((str(checkpoint_path),)))
    monkeypatch.setattr(birefnet_module, "_is_native_birefnet_checkpoint", lambda path: True)

    assert birefnet_module._find_local_birefnet_model() is None


def test_rmbg_download_uses_background_removal_subdirectory(layerforge_runtime, monkeypatch, tmp_path):
    rmbg_module = layerforge_runtime.matting_rmbg
    catalog_module = layerforge_runtime.matting_catalog
    model = catalog_module._RMBG_MODEL_CATALOG[0]
    download = {}

    def fake_snapshot_download(**kwargs):
        download.update(kwargs)
        model_dir = Path(kwargs["local_dir"])
        model_dir.mkdir(parents=True, exist_ok=True)
        for filename in (
            "config.json",
            "preprocessor_config.json",
            "birefnet.py",
            "BiRefNet_config.py",
            "model.safetensors",
        ):
            (model_dir / filename).write_bytes(b"model")
        return str(model_dir)

    huggingface_hub = ModuleType("huggingface_hub")
    huggingface_hub.snapshot_download = fake_snapshot_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", huggingface_hub)
    monkeypatch.setattr(rmbg_module, "get_huggingface_token", lambda: "hf-test-token")

    result = rmbg_module._download_rmbg_model(model)
    expected_dir = Path(tmp_path) / "models" / "background_removal" / "RMBG-2.0"

    assert Path(download["local_dir"]) == expected_dir
    assert download["repo_id"] == "briaai/RMBG-2.0"
    assert "*.safetensors" in download["allow_patterns"]
    assert download["token"] == "hf-test-token"
    assert Path(result) == expected_dir
    assert rmbg_module._is_rmbg_model_directory(result)


def test_rmbg_adapter_returns_batched_hw_mask(layerforge_runtime):
    import torch

    class FakeRMBGModel:
        def __call__(self, image):
            return (None, torch.zeros((image.shape[0], 1, 1024, 1024), device=image.device))

    adapter = layerforge_runtime.matting_rmbg.RMBG2Model(
        FakeRMBGModel(),
        torch.device("cpu"),
    )
    image = torch.rand((1, 2, 3, 4), dtype=torch.float32)

    mask = adapter.encode_image(image)

    assert tuple(mask.shape) == (1, 2, 3)
    assert torch.allclose(mask, torch.full((1, 2, 3), 0.5))


def test_rmbg_model_status_does_not_require_native_birefnet_loader(layerforge_runtime, monkeypatch):
    api_module = layerforge_runtime.matting_api
    _record_matting_responses(monkeypatch, api_module)

    monkeypatch.setattr(api_module, "_get_rmbg_model_loader", lambda: object())
    monkeypatch.setattr(api_module, "_find_existing_rmbg_model", lambda model: None)

    status = _run_matting_model_check(api_module, "remote:rmbg_2_0")

    assert status.payload["available"] is False
    assert status.payload["reason"] == "not_downloaded"
    assert status.payload["selected_model"] == "BRIA RMBG 2.0"
    assert status.payload["model_path"] == "remote:rmbg_2_0"


def test_rmbg_reports_an_unsupported_transformers_api(layerforge_runtime, monkeypatch):
    rmbg_module = layerforge_runtime.matting_rmbg
    transformers = ModuleType("transformers")
    transformers.__version__ = "0.0-test"
    monkeypatch.setitem(sys.modules, "transformers", transformers)

    status = rmbg_module._get_rmbg_transformers_status()

    assert status["loader"] is None
    assert "0.0-test" in status["message"]
    assert "not supported" in status["message"]
    assert "AutoModelForImageSegmentation" in status["message"]
    assert rmbg_module._get_rmbg_model_loader() is None


def test_legacy_automatic_checkpoint_is_not_migrated(layerforge_runtime, monkeypatch, tmp_path):
    birefnet_module = layerforge_runtime.matting_birefnet
    model_dir = Path(tmp_path) / "models" / "background_removal"
    model_dir.mkdir(parents=True)
    legacy_path = model_dir / "model.safetensors"
    friendly_path = model_dir / "BiRefNet-general.safetensors"
    legacy_path.write_bytes(b"legacy checkpoint")

    monkeypatch.setattr(
        birefnet_module,
        "_is_native_birefnet_checkpoint",
        lambda path: Path(path).resolve() == friendly_path.resolve() and Path(path).is_file(),
    )

    result = birefnet_module._find_existing_birefnet_default_checkpoint()

    assert result is None
    assert legacy_path.exists()
    assert not friendly_path.exists()


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


def test_legacy_route_handlers_cover_cache_and_file_responses(layerforge_runtime, monkeypatch, tmp_path):
    from PIL import Image

    routes_module = sys.modules[f"{layerforge_runtime.package_name}.python.routes"]
    responses = _record_matting_responses(monkeypatch, routes_module)
    node_class = layerforge_runtime.node.LayerForgeNode
    node_class._canvas_data_storage.clear()
    node_class._canvas_cache["image"] = Image.new("RGB", (2, 1), (255, 0, 0))
    node_class._canvas_cache["mask"] = Image.new("L", (2, 1), 128)

    class JsonRequest:
        def __init__(self, payload):
            self.payload = payload
            self.match_info = {}

        async def json(self):
            return self.payload

    get_input = layerforge_runtime.routes.registered[("GET", "/layerforge/get_input_data/{node_id}")]
    clear_input = layerforge_runtime.routes.registered[("POST", "/layerforge/clear_input_data/{node_id}")]
    get_canvas = layerforge_runtime.routes.registered[("GET", "/ycnode/get_canvas_data/{node_id}")]
    get_latest_images = layerforge_runtime.routes.registered[("GET", "/layerforge/get-latest-images/{since}")]
    get_latest_image = layerforge_runtime.routes.registered[("GET", "/ycnode/get_latest_image")]
    load_image = layerforge_runtime.routes.registered[("POST", "/ycnode/load_image_from_path")]

    node_class._canvas_data_storage["route-node_input"] = {"input_image": "image-data"}
    input_request = JsonRequest(None)
    input_request.match_info = {"node_id": "route-node"}
    found = asyncio.run(get_input(input_request))
    assert found.payload == {"success": True, "has_input": True, "data": {"input_image": "image-data"}}

    cleared = asyncio.run(clear_input(input_request))
    assert cleared.payload["success"] is True
    assert "route-node_input" not in node_class._canvas_data_storage
    missing = asyncio.run(get_input(input_request))
    assert missing.payload == {"success": True, "has_input": False}

    canvas_response = asyncio.run(get_canvas(JsonRequest(None)))
    assert canvas_response.payload["success"] is True
    assert canvas_response.payload["data"]["image"].startswith("data:image/png;base64,")
    assert canvas_response.payload["data"]["mask"].startswith("data:image/png;base64,")

    latest_paths = [str(tmp_path / "first.png"), str(tmp_path / "second.png")]
    monkeypatch.setattr(
        node_class,
        "get_latest_images",
        classmethod(lambda cls, since: latest_paths if since == 1.5 else []),
    )
    monkeypatch.setattr(routes_module, "file_to_data_url", lambda path: f"data:{path}")
    latest_request = JsonRequest(None)
    latest_request.match_info = {"since": "1500"}
    latest_response = asyncio.run(get_latest_images(latest_request))
    assert latest_response.payload == {
        "success": True,
        "images": [f"data:{path}" for path in latest_paths],
    }

    monkeypatch.setattr(node_class, "get_latest_image", classmethod(lambda cls: latest_paths[1]))
    latest_image_response = asyncio.run(get_latest_image(JsonRequest(None)))
    assert latest_image_response.payload == {"success": True, "image_data": f"data:{latest_paths[1]}"}

    image_path = tmp_path / "loaded.png"
    Image.new("RGBA", (3, 2), (255, 0, 0, 128)).save(image_path)
    loaded = asyncio.run(load_image(JsonRequest({"file_path": str(image_path)})))
    assert loaded.payload["success"] is True
    assert loaded.payload["width"] == 3
    assert loaded.payload["height"] == 2

    not_found = asyncio.run(load_image(JsonRequest({"file_path": str(tmp_path / "missing.png")})))
    assert not_found.status == 404
    invalid_path = tmp_path / "file.txt"
    invalid_path.write_text("not an image", encoding="utf-8")
    invalid = asyncio.run(load_image(JsonRequest({"file_path": str(invalid_path)})))
    assert invalid.status == 400
    required = asyncio.run(load_image(JsonRequest({})))
    assert required.status == 400

    corrupt_path = tmp_path / "corrupt.png"
    corrupt_path.write_bytes(b"not-an-image")
    corrupt = asyncio.run(load_image(JsonRequest({"file_path": str(corrupt_path)})))
    assert corrupt.status == 500
    assert len(responses) >= 10


def test_matting_settings_and_progress_endpoints_validate_requests(layerforge_runtime, monkeypatch):
    api_module = layerforge_runtime.matting_api
    responses = _record_matting_responses(monkeypatch, api_module)
    saved_payloads = []

    monkeypatch.setattr(
        api_module,
        "get_public_settings",
        lambda: {"model_path": "auto", "hf_token_configured": False},
    )
    monkeypatch.setattr(api_module, "get_matting_status", lambda node_id: {"node_id": node_id, "status": "idle"})
    monkeypatch.setattr(api_module, "save_settings", lambda payload: saved_payloads.append(payload))

    class Request:
        def __init__(self, payload, query=None, error=None):
            self.payload = payload
            self.query = query or {}
            self.error = error

        async def json(self):
            if self.error:
                raise self.error
            return self.payload

    settings = asyncio.run(api_module.get_matting_settings(Request(None)))
    assert settings.payload == {"settings": {"model_path": "auto", "hf_token_configured": False}}

    progress = asyncio.run(api_module.get_matting_progress(Request(None, {"node_id": "node-7"})))
    assert progress.payload == {"node_id": "node-7", "status": "idle"}

    saved = asyncio.run(api_module.save_matting_settings(Request({"mode": "mask_only"})))
    assert saved.payload == {"success": True, "settings": {"model_path": "auto", "hf_token_configured": False}}
    assert saved_payloads == [{"mode": "mask_only"}]

    invalid_json = asyncio.run(api_module.save_matting_settings(Request(None, error=ValueError("bad json"))))
    assert invalid_json.status == 400
    invalid_shape = asyncio.run(api_module.save_matting_settings(Request(["not", "an", "object"])))
    assert invalid_shape.status == 400

    def fail_to_save(payload):
        raise RuntimeError(f"cannot save {payload}")

    monkeypatch.setattr(api_module, "save_settings", fail_to_save)
    failed = asyncio.run(api_module.save_matting_settings(Request({"mode": "remove_background"})))
    assert failed.status == 500
    assert len(responses) == 6


def test_matting_endpoint_returns_masks_and_releases_lock(layerforge_runtime, monkeypatch):
    import torch

    api_module = layerforge_runtime.matting_api
    responses = _record_matting_responses(monkeypatch, api_module)
    calls = []

    class FakeMatting:
        model_path = "loaded-model"

        def execute(self, image, model_path, **kwargs):
            calls.append((tuple(image.shape), model_path, kwargs))
            return image * 0.5, torch.full((1, 1, 2, 2), 0.75)

    monkeypatch.setattr(api_module, "BiRefNetMatting", FakeMatting)
    monkeypatch.setattr(
        api_module,
        "convert_base64_to_tensor",
        lambda encoded: (torch.ones((1, 3, 2, 2)), None),
    )
    monkeypatch.setattr(
        api_module,
        "convert_tensor_to_base64",
        lambda tensor, alpha_mask=None, original_alpha=None: f"encoded-{tuple(tensor.shape)}",
    )

    class Request:
        async def json(self):
            return {
                "image": "data:image/png;base64,stub",
                "model_path": "remote:portrait",
                "mode": "remove_background",
                "threshold": 0.7,
                "refinement": 2,
                "node_id": "node-1",
            }

    response = asyncio.run(api_module.matting(Request()))
    assert response.payload["mode"] == "remove_background"
    assert response.payload["model_path"] == "loaded-model"
    assert response.payload["matted_image"] == "encoded-(1, 3, 2, 2)"
    assert response.payload["alpha_mask"] == "encoded-(1, 1, 2, 2)"
    assert response.payload["draw_mask"] == "encoded-(1, 1, 2, 2)"
    assert calls[0][1] == "remote:portrait"
    assert calls[0][2]["node_id"] == "node-1"
    assert api_module._matting_lock is None

    monkeypatch.setattr(
        api_module,
        "convert_base64_to_tensor",
        lambda encoded: (torch.ones((1, 3, 2, 2)), torch.ones((1, 1, 2, 2))),
    )
    async def mask_json():
        return {
            "image": "data:image/png;base64,stub",
            "mode": "mask_only",
        }

    response = asyncio.run(
        api_module.matting(
            SimpleNamespace(json=mask_json)
        )
    )
    assert response.payload["mode"] == "mask_only"
    assert len(responses) == 2


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (RuntimeError("offline"), 400),
        (RuntimeError("model failed"), 500),
        (ValueError("connection reset"), 400),
        (ValueError("invalid input"), 500),
    ],
)
def test_matting_endpoint_translates_model_errors(layerforge_runtime, monkeypatch, error, status):
    import torch

    api_module = layerforge_runtime.matting_api
    _record_matting_responses(monkeypatch, api_module)

    class FailingMatting:
        def execute(self, *args, **kwargs):
            raise error

    monkeypatch.setattr(api_module, "BiRefNetMatting", FailingMatting)
    monkeypatch.setattr(
        api_module,
        "convert_base64_to_tensor",
        lambda encoded: (torch.ones((1, 3, 2, 2)), None),
    )

    class Request:
        async def json(self):
            return {"image": "data:image/png;base64,stub"}

    response = asyncio.run(api_module.matting(Request()))
    assert response.status == status
    assert api_module._matting_lock is None


def test_image_tensor_conversion_supports_grayscale_and_alpha(layerforge_runtime):
    import torch
    from PIL import Image

    image_utils = layerforge_runtime.image_utils
    grayscale = Image.new("L", (2, 1), 128)
    buffer = io.BytesIO()
    grayscale.save(buffer, format="PNG")
    encoded = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    grayscale_tensor, alpha = image_utils.convert_base64_to_tensor(encoded)
    assert tuple(grayscale_tensor.shape) == (1, 3, 1, 2)
    assert alpha is None

    rgb_tensor = torch.ones((1, 3, 2, 2), dtype=torch.float32)
    alpha_mask = torch.full((1, 1, 2, 2), 0.25, dtype=torch.float32)
    original_alpha = torch.full((1, 1, 2, 2), 0.75, dtype=torch.float32)
    encoded_rgba = image_utils.convert_tensor_to_base64(rgb_tensor, alpha_mask, original_alpha)
    rgba = Image.open(io.BytesIO(base64.b64decode(encoded_rgba.split(",", 1)[1])))
    assert rgba.mode == "RGBA"
    assert rgba.getpixel((0, 0))[3] == pytest.approx(63, abs=1)

    encoded_l = image_utils.convert_tensor_to_base64(torch.ones((1, 1, 2, 2), dtype=torch.float32))
    grayscale_result = Image.open(io.BytesIO(base64.b64decode(encoded_l.split(",", 1)[1])))
    assert grayscale_result.mode == "L"


def test_node_cache_flow_and_cleanup_helpers_preserve_state(layerforge_runtime, monkeypatch):
    from PIL import Image

    node_class = layerforge_runtime.node.LayerForgeNode
    node_class._canvas_cache.update(
        {
            "image": None,
            "mask": None,
            "data_flow_status": {},
            "persistent_cache": {},
            "last_execution_id": None,
        }
    )
    node_class._websocket_data = {}
    node = node_class()

    image = Image.new("RGB", (2, 1), (0, 255, 0))
    mask = Image.new("L", (2, 1), 255)
    node_class._canvas_cache["image"] = image
    node_class._canvas_cache["mask"] = mask
    node.update_persistent_cache()
    assert node_class._canvas_cache["persistent_cache"] == {"image": image, "mask": mask}

    node.track_data_flow("render", "complete", {"layers": 2})
    assert node.get_flow_status(node.flow_id)["status"] == "complete"
    assert node.get_flow_status()[node.flow_id]["data_info"] == {"layers": 2}
    assert node.get_cached_data() == {"image": image, "mask": mask}
    assert node.api_get_data("node-1")["success"] is True
    node.store_image(image)
    assert node.get_cached_image().startswith("data:image/png;base64,")

    node_class._canvas_cache["persistent_cache"] = {"image": image, "mask": mask}
    node_class._canvas_cache["last_execution_id"] = "execution-1"
    monkeypatch.setattr(node, "get_execution_id", lambda: "execution-1")
    node.restore_cache()
    assert node_class._canvas_cache["image"] is image
    assert node_class._canvas_cache["mask"] is mask

    monkeypatch.setattr(layerforge_runtime.node.time, "time", lambda: 1000)
    node_class._websocket_data = {
        -1: {"timestamp": 999},
        2: {"timestamp": 600},
        3: {"timestamp": 950},
    }
    node_class._cleanup_old_websocket_data()
    assert set(node_class._websocket_data) == {3}

    assert node.add_image_to_canvas("invalid") is None
    assert node.add_mask_to_canvas("invalid", None) is None
    node_class.setup_routes()
