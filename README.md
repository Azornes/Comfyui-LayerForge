
---
# LayerForge – Advanced Canvas Editor for ComfyUI 🎨

**LayerForge** is an advanced canvas node for ComfyUI, providing a Photoshop-like layer-based editing experience directly within your workflow. It extends the concept of a simple canvas with multi-layer support, masking, blend modes, precise transformations, and seamless integration with other nodes.

### Why LayerForge?
-   **Full Creative Control:** Move beyond simple image inputs. Composite, mask, and blend multiple elements without leaving ComfyUI.
-   **Seamless Integration:** Outputs a final image and a corresponding mask, ready to be piped into any other node (e.g., `VAEEncode`, `Apply Mask`).
-   **Intuitive UI:** Familiar controls like drag-and-drop, keyboard shortcuts, and a pannable/zoomable viewport make editing fast and easy.

---

<!-- 
    ADD A COMPELLING GIF HERE! 
    A short screen recording showing layer dragging, resizing, the blend mode menu, and canvas resizing would be perfect.
-->

## ✨ Key Features

-   **Persistent & Stateful:** Your work is automatically saved to the browser's IndexedDB, preserving your full canvas state (layers, positions, etc.) even after a page reload.
-   **Multi-Layer Editing:** Add, arrange, and manage multiple image layers with z-ordering.
-   **Advanced Masking Tool:** A dedicated masking mode with adjustable brush size, strength, and softness. Masks have their own separate undo/redo history.
-   **Full Transformation Controls:** Precisely move, scale, and rotate layers with mouse or keyboard shortcuts.
-   **Blend Modes & Opacity:** Apply 12 common blend modes (`Overlay`, `Multiply`, etc.) and adjust opacity on a per-layer basis via a context menu.
-   **Comprehensive Undo/Redo:** Full history support for both layer manipulations and mask drawing.
-   **Seamless I/O:**
    -   **Drag & Drop** image files to create new layers.
    -   **Copy & Paste** images directly from your system clipboard.
    -   Import the last generated image from your workflow with one click.
-   **AI-Powered Matting:** Optional background removal for any layer using the `BiRefNet` model.
-   **Efficient Memory Management:** An automatic garbage collection system cleans up unused image data to keep the browser's storage footprint low.
-   **Workflow Integration:** Outputs a final composite **image** and a combined alpha **mask**, ready for any other ComfyUI node.

---

## 🚀 Installation

1.  Navigate to your ComfyUI `custom_nodes` directory.
    ```bash
    cd ComfyUI/custom_nodes/
    ```
2.  Clone this repository:
    ```bash
    git clone https://github.com/Azornes/Comfyui-LayerForge
    ```
3.  Restart ComfyUI.

---

## 🎮 Controls & Shortcuts

### Canvas Control

| Action | Description |
|--------|-------------|
| `Click + Drag` | Pan canvas view |
| `Mouse Wheel` | Zoom view in/out |
| `Shift + Click (background)` | Start resizing canvas area |
| `Shift + Ctrl + Click` | Start moving entire canvas |
| `Double Click (background)` | Deselect all layers |

### Clipboard & I/O

| Action | Description |
|--------|-------------|
| `Ctrl + C` | Copy selected layer(s) |
| `Ctrl + V` | Paste from clipboard (image or internal layers) |
| `Drag & Drop Image File` | Add image as a new layer |

### Layer Interaction

| Action | Description |
|--------|-------------|
| `Click + Drag` | Move selected layer(s) |
| `Ctrl + Click` | Add/Remove layer from selection |
| `Alt + Drag` | Clone selected layer(s) |
| `Shift + Click` | Show blend mode & opacity menu |
| `Mouse Wheel` | Scale layer (snaps to grid) |
| `Ctrl + Mouse Wheel` | Fine-scale layer |
| `Shift + Mouse Wheel` | Rotate layer by 5° |
| `Arrow Keys` | Nudge layer by 1px |
| `Shift + Arrow Keys` | Nudge layer by 10px |
| `[` or `]` | Rotate by 1° |
| `Shift + [` or `]` | Rotate by 10° |
| `Delete` | Delete selected layer(s) |

### Transform Handles (on selected layer)

| Action | Description |
|--------|-------------|
| `Drag Corner/Side` | Resize layer |
| `Drag Rotation Handle` | Rotate layer |
| `Hold Shift` | Keep aspect ratio / Snap rotation to 15° |
| `Hold Ctrl` | Snap to grid |

### Mask Mode

| Action | Description |
|--------|-------------|
| `Click + Drag` | Paint on the mask |
| `Middle Mouse Button + Drag` | Pan canvas view |
| `Mouse Wheel` | Zoom view in/out |
| **Brush Controls** | Use sliders to control brush **Size**, **Strength**, and **Softness** |
| **Clear Mask** | Remove the entire mask |
| **Exit Mode** | Click the "Draw Mask" button again |

---

## 🛠️ Basic Workflow

1.  Add the **LayerForge** node to your graph.
2.  Use the **"Add Image"** button or **Drag & Drop** a file to create a layer.
3.  Use the **"Import Input"** button to load the last generated image from your workflow.
4.  Arrange, resize, and blend your layers as needed.
5.  Connect the outputs to other nodes:
    -   `image` -> `VAE Encode` (for further processing)
    -   `mask` -> `Apply Mask` or `Set Latent Noise Mask`

```
┌────────────────┐
│   Load Image   │
└───────┬────────┘
        │
┌───────▼────────┐      ┌──────────────┐
│   LayerForge   ├──────►  VAE Encode  │
│(output: image) │      └──────────────┘
└───────┬────────┘
        │
┌───────▼────────┐      ┌──────────────┐
│(output: mask)  ├──────► Apply Mask   │
└────────────────┘      └──────────────┘
```

---

## 🧠 Optional: Matting Model (for image cutout)

The "Matting" feature allows you to automatically generate a cutout (alpha mask) for a selected layer. This is an optional feature and requires a model.

> -   **Model Name**: `BiRefNet`
> -   **Download from**:
>     -   [Hugging Face](https://huggingface.co/ZhengPeng7/BiRefNet/tree/main) (Recommended)
>     -   [Google Drive](https://drive.google.com/drive/folders/1BCLInCLH89fmTpYoP8Sgs_Eqww28f_wq?usp=sharing)
> -   **Installation Path**: Place the model file in `ComfyUI/models/BiRefNet/`.

---

## 📜 License

This project is licensed under the MIT License. Feel free to use, modify, and distribute.

---

Based on the original [**Comfyui-Ycanvas**](https://github.com/yichengup/Comfyui-Ycanvas) by yichengup. This fork significantly enhances the editing capabilities for practical compositing workflows inside ComfyUI.
