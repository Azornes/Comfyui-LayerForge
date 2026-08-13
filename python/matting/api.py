"""HTTP endpoints for model status and background-removal execution."""

import traceback

from aiohttp import web
from server import PromptServer

from ..image_utils import convert_base64_to_tensor, convert_tensor_to_base64
from ..node import log
from .backends.birefnet import (
    _find_existing_birefnet_remote_checkpoint,
    _find_local_birefnet_model,
    _get_birefnet_remote_model,
    _get_comfy_birefnet_loader,
)
from .backends.rmbg import (
    _find_existing_rmbg_model,
    _find_local_rmbg_model,
    _get_rmbg_model_loader,
    _get_rmbg_model_status_message,
    _get_rmbg_remote_model,
)
from .options import _get_birefnet_model_options
from .paths import _get_birefnet_base_paths
from .service import BiRefNetMatting

_matting_lock = None


def _matting_status_response(
    available,
    reason,
    message,
    *,
    status=200,
    **details,
):
    return web.json_response(
        {
            "available": available,
            "reason": reason,
            "message": message,
            **details,
        },
        status=status,
    )


async def check_matting_model(request):
    """Report whether the selected background-removal model is ready."""
    try:
        model_options = _get_birefnet_model_options()
        requested_model = request.query.get("model_path") or "auto"
        remote_birefnet_model = _get_birefnet_remote_model(requested_model)
        remote_rmbg_model = _get_rmbg_remote_model(requested_model)

        local_rmbg_path = None
        if not remote_rmbg_model and requested_model != "auto":
            local_rmbg_path = _find_local_rmbg_model(requested_model)

        if remote_rmbg_model or local_rmbg_path:
            if _get_rmbg_model_loader() is None:
                return _matting_status_response(
                    False,
                    "unsupported_rmbg",
                    _get_rmbg_model_status_message(),
                    model_path=requested_model,
                    models=model_options,
                )

            if remote_rmbg_model:
                local_model_path = _find_existing_rmbg_model(remote_rmbg_model)
                if local_model_path:
                    log.info(f"Selected BRIA RMBG model is ready at {local_model_path}")
                    return _matting_status_response(
                        True,
                        "ready",
                        "Selected model is ready to use",
                        model_path=local_model_path,
                        selected_model=remote_rmbg_model["label"],
                        models=model_options,
                    )

                log.info(f"Selected BRIA RMBG model is not downloaded: {remote_rmbg_model['label']}")
                return _matting_status_response(
                    False,
                    "not_downloaded",
                    f"{remote_rmbg_model['label']} will be downloaded automatically on first use.",
                    model_path=requested_model,
                    selected_model=remote_rmbg_model["label"],
                    models=model_options,
                )

            return _matting_status_response(
                True,
                "ready",
                "Selected model is ready to use",
                model_path=local_rmbg_path,
                selected_model=local_rmbg_path,
                models=model_options,
            )

        if _get_comfy_birefnet_loader() is None:
            return _matting_status_response(
                False,
                "unsupported_comfyui",
                "This ComfyUI version does not provide the native BiRefNet background-removal loader.",
                models=model_options,
            )

        if remote_birefnet_model:
            local_model_path = _find_existing_birefnet_remote_checkpoint(remote_birefnet_model)
            if local_model_path:
                log.info(f"Selected BiRefNet model is ready at {local_model_path}")
                return _matting_status_response(
                    True,
                    "ready",
                    "Selected model is ready to use",
                    model_path=local_model_path,
                    selected_model=remote_birefnet_model["label"],
                    models=model_options,
                )

            log.info(f"Selected BiRefNet model is not downloaded: {remote_birefnet_model['label']}")
            return _matting_status_response(
                False,
                "not_downloaded",
                f"{remote_birefnet_model['label']} will be downloaded automatically on first use.",
                model_path=requested_model,
                selected_model=remote_birefnet_model["label"],
                models=model_options,
            )

        if requested_model != "auto":
            local_model_path = _find_local_birefnet_model(requested_model)
            if local_model_path:
                log.info(f"Selected BiRefNet model is ready at {local_model_path}")
                return _matting_status_response(
                    True,
                    "ready",
                    "Selected model is ready to use",
                    model_path=local_model_path,
                    selected_model=local_model_path,
                    models=model_options,
                )

            return _matting_status_response(
                False,
                "selected_model_unavailable",
                "The selected BiRefNet checkpoint is not available or is not compatible with ComfyUI.",
                model_path=requested_model,
                models=model_options,
            )

        local_model_path = _find_local_birefnet_model()
        if local_model_path:
            log.info(f"BiRefNet model files detected at {local_model_path}")
            return _matting_status_response(
                True,
                "ready",
                "Model is ready to use",
                model_path=local_model_path,
                models=model_options,
            )

        searched_paths = _get_birefnet_base_paths()
        log.info(f"BiRefNet model not found in any of: {searched_paths}")
        return _matting_status_response(
            False,
            "not_downloaded",
            "The BiRefNet checkpoint will be downloaded automatically on first use (requires internet connection).",
            model_path=searched_paths[0] if searched_paths else None,
            models=model_options,
        )
    except Exception as error:
        log.error(f"Error checking matting model: {error}")
        return _matting_status_response(
            False,
            "error",
            f"Error checking model status: {error}",
            status=500,
        )


def _is_model_download_error(error):
    error_text = str(error).lower()
    return any(
        marker in error_text
        for marker in (
            "offline",
            "connection",
            "timed out",
            "huggingface",
            "localentrynotfound",
            "gated",
            "401",
            "access approval",
            "credentials",
            "permission",
        )
    )


async def matting(request):
    global _matting_lock

    if _matting_lock is not None:
        log.warning("Matting already in progress, rejecting request")
        return web.json_response(
            {
                "error": "Another matting operation is in progress",
                "details": "Please wait for the current operation to complete",
            },
            status=429,
        )

    _matting_lock = True
    try:
        log.info("Received matting request")
        data = await request.json()
        matting_instance = BiRefNetMatting()
        image_tensor, original_alpha = convert_base64_to_tensor(data["image"])
        log.debug(f"Input image shape: {image_tensor.shape}")

        mode = data.get("mode", "remove_background")
        model_path = data.get("model_path") or "auto"
        matted_image, alpha_mask = matting_instance.execute(
            image_tensor,
            model_path,
            threshold=data.get("threshold", 0.5),
            refinement=data.get("refinement", 1),
            mode=mode,
        )

        if mode == "mask_only":
            result_image = convert_tensor_to_base64(alpha_mask)
        else:
            result_image = convert_tensor_to_base64(matted_image, alpha_mask, original_alpha)
        result_mask = convert_tensor_to_base64(alpha_mask)
        # Draw Mask uses white pixels as the area to remove, while matting uses
        # white pixels as the area to keep.
        draw_mask = 1.0 - alpha_mask

        return web.json_response(
            {
                "matted_image": result_image,
                "alpha_mask": result_mask,
                "draw_mask": convert_tensor_to_base64(draw_mask),
                "mode": mode,
                "model_path": matting_instance.model_path,
            }
        )
    except RuntimeError as error:
        log.error(f"Runtime error during matting: {error}")
        if _is_model_download_error(error):
            return web.json_response(
                {
                    "error": "Model Download Error",
                    "details": "Failed to download the selected background-removal model from Hugging Face. Check internet access, gated-model approval, and Hugging Face credentials.",
                },
                status=400,
            )
        return web.json_response(
            {
                "error": "Matting Model Error",
                "details": str(error),
            },
            status=500,
        )
    except Exception as error:
        log.exception(f"Error in matting endpoint: {error}")
        if _is_model_download_error(error):
            return web.json_response(
                {
                    "error": "Network Connection Error",
                    "details": "Failed to download the selected background-removal model from Hugging Face. Check internet access, gated-model approval, and Hugging Face credentials.",
                },
                status=400,
            )

        return web.json_response(
            {
                "error": "An unexpected error occurred",
                "details": traceback.format_exc(),
            },
            status=500,
        )
    finally:
        _matting_lock = None
        log.debug("Matting lock released")


def register_matting_routes():
    """Register matting endpoints without import-time decorators."""
    PromptServer.instance.routes.get("/matting/check-model")(check_matting_model)
    PromptServer.instance.routes.post("/matting")(matting)


__all__ = ["check_matting_model", "matting", "register_matting_routes"]
