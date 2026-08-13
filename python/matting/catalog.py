"""Catalogs and identifiers for LayerForge background-removal models."""

_BIREFNET_REPOSITORY = "ZhengPeng7/BiRefNet"
_BIREFNET_FILENAME = "model.safetensors"
_BIREFNET_DEFAULT_LOCAL_FILENAME = "BiRefNet-general.safetensors"
_BIREFNET_PROJECT_URL = "https://github.com/ZhengPeng7/BiRefNet"
_BIREFNET_REMOTE_PREFIX = "remote:"
_BIREFNET_REQUIRED_KEYS = {
    "bb.layers.1.blocks.0.attn.relative_position_index",
    "bb.layers.2.blocks.17.attn.qkv.weight",
}

_RMBG_REMOTE_PREFIX = "remote:"
_RMBG_MODEL_CATALOG = (
    {
        "id": "rmbg_2_0",
        "label": "BRIA RMBG 2.0",
        "description": (
            "Local BRIA background removal with strong general-purpose segmentation. "
            "Hugging Face access approval is required before the gated weights can be downloaded."
        ),
        "repo_id": "briaai/RMBG-2.0",
        "local_directory": "RMBG-2.0",
        "url": "https://huggingface.co/briaai/RMBG-2.0",
        "project_url": "https://github.com/Bria-AI/RMBG-2.0",
        "backend": "rmbg",
    },
)

_BIREFNET_MODEL_CATALOG = (
    {
        "id": "general",
        "label": "BiRefNet — General",
        "description": "The best starting point for everyday images and general background removal.",
        "repo_id": "ZhengPeng7/BiRefNet",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-general.safetensors",
    },
    {
        "id": "high_resolution",
        "label": "BiRefNet — High Resolution",
        "description": "High-resolution segmentation for detailed edges and larger source images; it uses more memory.",
        "repo_id": "ZhengPeng7/BiRefNet_HR",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HR.safetensors",
    },
    {
        "id": "portrait",
        "label": "BiRefNet — Portrait",
        "description": "Portrait matting for people, hair, and portrait-focused cutouts.",
        "repo_id": "ZhengPeng7/BiRefNet-portrait",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-portrait.safetensors",
    },
    {
        "id": "matting",
        "label": "BiRefNet — Matting",
        "description": "General matting with a focus on soft alpha edges such as hair and semi-transparent details.",
        "repo_id": "ZhengPeng7/BiRefNet-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-matting.safetensors",
    },
    {
        "id": "high_resolution_matting",
        "label": "BiRefNet — High Resolution Matting",
        "description": "High-resolution general matting for fine details; it requires more memory than the standard matting model.",
        "repo_id": "ZhengPeng7/BiRefNet_HR-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HR-matting.safetensors",
    },
    {
        "id": "dynamic",
        "label": "BiRefNet — Dynamic",
        "description": "Dynamic-shape segmentation for inputs with varying aspect ratios and resolutions.",
        "repo_id": "ZhengPeng7/BiRefNet_dynamic",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet_dynamic.safetensors",
    },
    {
        "id": "dynamic_matting",
        "label": "BiRefNet — Dynamic Matting",
        "description": "Dynamic-shape matting for arbitrary input sizes, with a focus on soft alpha edges.",
        "repo_id": "ZhengPeng7/BiRefNet_dynamic-matting",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet_dynamic-matting.safetensors",
    },
    {
        "id": "hrsod",
        "label": "BiRefNet — HRSOD",
        "description": "High-resolution salient-object detection; useful when the main subject should stand out from its surroundings.",
        "repo_id": "ZhengPeng7/BiRefNet-HRSOD",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-HRSOD.safetensors",
    },
    {
        "id": "dis5k",
        "label": "BiRefNet — DIS5K",
        "description": "Dichotomous image segmentation trained for clean foreground/background separation.",
        "repo_id": "ZhengPeng7/BiRefNet-DIS5K",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-DIS5K.safetensors",
    },
    {
        "id": "cod",
        "label": "BiRefNet — COD",
        "description": "Camouflaged-object detection; use it for subjects that blend into the background.",
        "repo_id": "ZhengPeng7/BiRefNet-COD",
        "filename": "model.safetensors",
        "local_filename": "BiRefNet-COD.safetensors",
    },
)


__all__ = [
    "_BIREFNET_DEFAULT_LOCAL_FILENAME",
    "_BIREFNET_FILENAME",
    "_BIREFNET_MODEL_CATALOG",
    "_BIREFNET_PROJECT_URL",
    "_BIREFNET_REMOTE_PREFIX",
    "_BIREFNET_REPOSITORY",
    "_BIREFNET_REQUIRED_KEYS",
    "_RMBG_MODEL_CATALOG",
    "_RMBG_REMOTE_PREFIX",
]
