"""Offline LayerForge backend benchmark.

This script measures tensor/image conversion and adapter overhead only. It does
not start ComfyUI, download models, or run a real matting checkpoint.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COMFY_ROOT = Path(r"E:\AI\AI\ComfyUI\ComfyUI_Easy\All_Nodes\ComfyUI")


def _install_import_paths() -> Path:
    comfy_root = Path(os.environ.get("LAYERFORGE_COMFY_ROOT", DEFAULT_COMFY_ROOT))
    sys.path.insert(0, str(REPOSITORY_ROOT))
    if comfy_root.exists():
        sys.path.insert(0, str(comfy_root))
    return comfy_root


def _parse_positive_list(value: str) -> list[int]:
    result = [int(item.strip()) for item in value.split(",") if item.strip()]
    if not result or any(item <= 0 for item in result):
        raise argparse.ArgumentTypeError(f"Expected positive integers, got: {value}")
    return result


def _percentile(sorted_values: list[float], fraction: float) -> float:
    index = min(len(sorted_values) - 1, max(0, math.ceil(len(sorted_values) * fraction) - 1))
    return sorted_values[index]


def _measure(operation, iterations: int) -> dict[str, float]:
    for _ in range(min(2, iterations)):
        operation()

    samples = []
    for _ in range(iterations):
        started_at = time.perf_counter()
        operation()
        samples.append((time.perf_counter() - started_at) * 1000)

    samples.sort()
    return {
        "median_ms": _percentile(samples, 0.5),
        "p95_ms": _percentile(samples, 0.95),
        "min_ms": samples[0],
        "max_ms": samples[-1],
    }


def _rounded(value):
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    if isinstance(value, float):
        return round(value, 3)
    return value


def _run_conversion_benchmarks(torch, image_utils, node_module, serialization, sizes, iterations):
    from PIL import Image

    output = {}
    for height, width in sizes:
        tensor = torch.rand((1, 3, height, width), dtype=torch.float32)
        encoded = image_utils.convert_tensor_to_base64(tensor)
        sample = tensor[0].permute(1, 2, 0)
        mask_tensor = torch.rand((height, width), dtype=torch.float32)

        def serialize_mask():
            mask_array = (mask_tensor.cpu().numpy() * 255).astype("uint8")
            return serialization.pil_to_data_url(Image.fromarray(mask_array, "L"))

        output[f"{height}x{width}"] = {
            "tensor_to_base64": _measure(
                lambda: image_utils.convert_tensor_to_base64(tensor), iterations
            ),
            "base64_to_tensor": _measure(
                lambda: image_utils.convert_base64_to_tensor(encoded), iterations
            ),
            "node_serialize_rgb_sample": _measure(
                lambda: node_module.LayerForgeNode._serialize_rgb_tensor_sample(sample), iterations
            ),
            "mask_tensor_to_base64": _measure(serialize_mask, iterations),
            "encoded_bytes": len(encoded.encode("ascii")),
        }

    return output


def _run_batch_benchmarks(torch, node_module, batch_size: int, batch_counts, iterations):
    output = {}
    for batch_count in batch_counts:
        batch = torch.rand((batch_count, batch_size, batch_size, 3), dtype=torch.float32)

        def serialize_batch():
            return [
                node_module.LayerForgeNode._serialize_rgb_tensor_sample(batch[index])
                for index in range(batch_count)
            ]

        stats = _measure(serialize_batch, iterations)
        output[str(batch_count)] = {
            **stats,
            "batch_size": batch_size,
            "per_sample_median_ms": stats["median_ms"] / batch_count,
        }

    return output


def _run_fake_matting_benchmarks(torch, rmbg_module, sizes, iterations):
    class FakeModel:
        def __call__(self, image):
            return torch.zeros((image.shape[0], 1, 256, 256), device=image.device)

    adapter = rmbg_module.RMBG2Model(FakeModel(), torch.device("cpu"))
    output = {}
    for height, width in sizes:
        image = torch.rand((1, height, width, 3), dtype=torch.float32)
        output[f"{height}x{width}"] = _measure(
            lambda: adapter.encode_image(image), iterations
        )
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=_parse_positive_list, default=[512, 1024, 2048])
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--batch-counts", type=_parse_positive_list, default=[1, 4, 8, 16])
    parser.add_argument("--skip-matting", action="store_true")
    args = parser.parse_args()

    if args.iterations < 1 or args.batch_size < 1:
        parser.error("--iterations and --batch-size must be positive")

    comfy_root = _install_import_paths()

    try:
        import torch

        from python import image_utils
        from python import image_serialization as serialization
        from python import node as node_module
    except Exception as error:
        print(
            "Unable to import the LayerForge runtime. Set LAYERFORGE_COMFY_ROOT "
            f"to the active ComfyUI root. Current root: {comfy_root}\n{error}",
            file=sys.stderr,
        )
        return 2

    sizes = [(size, size) for size in args.sizes]
    report = {
        "benchmark": "layerforge-backend-offline",
        "runtime": {
            "python": sys.version.split()[0],
            "torch": torch.__version__,
            "torch_threads": torch.get_num_threads(),
            "device": "cpu",
            "comfy_root": str(comfy_root),
        },
        "config": {
            "sizes": args.sizes,
            "iterations": args.iterations,
            "batch_size": args.batch_size,
            "batch_counts": args.batch_counts,
        },
        "image_conversion": _run_conversion_benchmarks(
            torch, image_utils, node_module, serialization, sizes, args.iterations
        ),
        "batch_serialization": _run_batch_benchmarks(
            torch, node_module, args.batch_size, args.batch_counts, args.iterations
        ),
        "skipped": [],
    }

    if args.skip_matting:
        report["skipped"].append({
            "benchmark": "fake_matting_adapter",
            "reason": "Disabled with --skip-matting",
        })
    else:
        try:
            from python.matting.backends import rmbg as rmbg_module

            report["fake_matting_adapter"] = _run_fake_matting_benchmarks(
                torch, rmbg_module, sizes, args.iterations
            )
        except Exception as error:
            report["skipped"].append({
                "benchmark": "fake_matting_adapter",
                "reason": f"Adapter import failed: {error}",
            })

    print(json.dumps(_rounded(report), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
