"""LayerForge HTTP and WebSocket route registration."""

import os
import time

from aiohttp import web
from PIL import Image
from server import PromptServer

from .matting import register_matting_routes
from .image_serialization import file_to_data_url, pil_to_data_url
from .node import log


def register_routes(node_class):
    """Register the legacy LayerForge routes and the matting routes."""

    @PromptServer.instance.routes.get("/layerforge/canvas_ws")
    async def handle_canvas_websocket(request):
        ws = web.WebSocketResponse(max_msg_size=33554432)
        await ws.prepare(request)

        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = msg.json()
                    node_id = data.get("nodeId")
                    if not node_id:
                        await ws.send_json({"status": "error", "message": "nodeId is required"})
                        continue

                    with node_class._storage_lock:
                        node_class._canvas_data_storage[node_id] = {
                            "image": data.get("image"),
                            "mask": data.get("mask"),
                            "timestamp": time.time(),
                        }

                    log.info(f"Received canvas data for node {node_id} via WebSocket")
                    await ws.send_json({"type": "ack", "nodeId": node_id, "status": "success"})
                    log.debug(f"Sent ACK for node {node_id}")
                except Exception as error:
                    log.error(f"Error processing WebSocket message: {error}")
                    await ws.send_json({"status": "error", "message": str(error)})
            elif msg.type == web.WSMsgType.ERROR:
                log.error(f"WebSocket connection closed with exception {ws.exception()}")

        log.info("WebSocket connection closed")
        return ws

    @PromptServer.instance.routes.get("/layerforge/get_input_data/{node_id}")
    async def get_input_data(request):
        try:
            node_id = request.match_info["node_id"]
            log.debug(f"Checking for input data for node: {node_id}")
            with node_class._storage_lock:
                input_data = node_class._canvas_data_storage.get(f"{node_id}_input")

            if input_data:
                log.info(f"Input data found for node {node_id}, sending to frontend")
                return web.json_response({"success": True, "has_input": True, "data": input_data})

            log.debug(f"No input data found for node {node_id}")
            return web.json_response({"success": True, "has_input": False})
        except Exception as error:
            log.error(f"Error in get_input_data: {error}")
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.post("/layerforge/clear_input_data/{node_id}")
    async def clear_input_data(request):
        try:
            node_id = request.match_info["node_id"]
            log.info(f"Clearing input data for node: {node_id}")
            with node_class._storage_lock:
                input_key = f"{node_id}_input"
                if input_key in node_class._canvas_data_storage:
                    del node_class._canvas_data_storage[input_key]
                    log.info(f"Input data cleared for node {node_id}")
                else:
                    log.debug(f"No input data to clear for node {node_id}")

            return web.json_response({
                "success": True,
                "message": f"Input data cleared for node {node_id}",
            })
        except Exception as error:
            log.error(f"Error in clear_input_data: {error}")
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.get("/ycnode/get_canvas_data/{node_id}")
    async def get_canvas_data(request):
        del request
        try:
            cache_data = node_class._canvas_cache
            response_data = {
                "success": True,
                "data": {"image": None, "mask": None},
            }

            if cache_data["image"] is not None:
                response_data["data"]["image"] = pil_to_data_url(cache_data["image"])

            if cache_data["mask"] is not None:
                response_data["data"]["mask"] = pil_to_data_url(cache_data["mask"])

            return web.json_response(response_data)
        except Exception as error:
            log.error(f"Error in get_canvas_data: {error}")
            return web.json_response({"success": False, "error": str(error)})

    @PromptServer.instance.routes.get("/layerforge/get-latest-images/{since}")
    async def get_latest_images_route(request):
        try:
            since_timestamp = float(request.match_info.get("since", 0))
            latest_image_paths = node_class.get_latest_images(since_timestamp / 1000.0)
            images_data = []
            for image_path in latest_image_paths:
                images_data.append(file_to_data_url(image_path))

            return web.json_response({"success": True, "images": images_data})
        except Exception as error:
            log.error(f"Error in get_latest_images_route: {error}")
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.get("/ycnode/get_latest_image")
    async def get_latest_image_route(request):
        del request
        try:
            latest_image_path = node_class.get_latest_image()
            if latest_image_path:
                return web.json_response({
                    "success": True,
                    "image_data": file_to_data_url(latest_image_path),
                })

            return web.json_response({
                "success": False,
                "error": "No images found in output directory.",
            }, status=404)
        except Exception as error:
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.post("/ycnode/load_image_from_path")
    async def load_image_from_path_route(request):
        try:
            data = await request.json()
            file_path = data.get("file_path")
            if not file_path:
                return web.json_response({
                    "success": False,
                    "error": "file_path is required",
                }, status=400)

            log.info(f"Attempting to load image from path: {file_path}")
            if not os.path.exists(file_path):
                log.warning(f"File not found: {file_path}")
                return web.json_response({
                    "success": False,
                    "error": f"File not found: {file_path}",
                }, status=404)

            valid_extensions = (
                ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".ico", ".avif"
            )
            if not file_path.lower().endswith(valid_extensions):
                return web.json_response({
                    "success": False,
                    "error": f"Invalid image file extension. Supported: {valid_extensions}",
                }, status=400)

            try:
                with Image.open(file_path) as image:
                    if image.mode != "RGB":
                        image = image.convert("RGB")
                    log.info(f"Successfully loaded image from path: {file_path}")
                    return web.json_response({
                        "success": True,
                        "image_data": pil_to_data_url(image),
                        "width": image.width,
                        "height": image.height,
                    })
            except Exception as image_error:
                log.error(f"Error processing image file {file_path}: {image_error}")
                return web.json_response({
                    "success": False,
                    "error": f"Error processing image file: {image_error}",
                }, status=500)
        except Exception as error:
            log.error(f"Error in load_image_from_path_route: {error}")
            return web.json_response({"success": False, "error": str(error)}, status=500)

    register_matting_routes()


__all__ = ["register_routes"]
