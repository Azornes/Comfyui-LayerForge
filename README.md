
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

-   **Multi-Layer Editing:** Add, arrange, and manage multiple image layers.
-   **Full Transformation Controls:** Move, scale, and rotate layers with mouse or keyboard shortcuts.
-   **Blend Modes & Opacity:** Apply 12 common blend modes (`Overlay`, `Multiply`, etc.) and adjust opacity on a per-layer basis.
-   **Drag & Drop:** Drop image files directly onto the canvas to create new layers.
-   **Precise Alignment:** Snap layers to a grid (`Ctrl` key) for perfect positioning.
-   **Dynamic Canvas:** Resize the entire canvas with a live preview of the new dimensions.
-   **Workflow Integration:**
    -   Import the last generated image directly into a layer.
    -   Outputs a final composite **image** and a combined alpha **mask**.

---

## 🚀 Installation

1.  Navigate to your ComfyUI `custom_nodes` directory.
    ```bash
    cd ComfyUI/custom_nodes/
    ```
2.  Clone this repository:
    ```bash
    git clone https://github.com/YOUR_USERNAME/LayerForge.git
    ```
3.  Restart ComfyUI.

---

## 🖱️ Controls

### Layer Controls (When one or more layers are selected)

| Action                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| **Mouse Drag**            | Move selected layer(s).                                                  |
| `Ctrl` + **Mouse Drag**   | Move selected layer(s) with **grid snapping**.                           |
| `Ctrl` + **Click**        | Add or remove a layer from the current selection.                        |
| **Mouse Wheel**           | Scale selected layer(s) up or down.                                      |
| `Shift` + **Mouse Wheel** | Rotate selected layer(s).                                                |
| `Shift` + **Click**       | Open the **Blend Mode & Opacity** menu for the clicked layer.            |
| `Delete` Key              | Remove all selected layers.                                              |
| **Arrow Keys**            | Nudge selected layer(s) by 1 pixel.                                      |
| `Shift` + **Arrow Keys**  | Nudge selected layer(s) by 10 pixels.                                    |
| `[` / `]` Keys            | Rotate selected layer(s) by 1 degree.                                    |
| `Shift` + `[` / `]` Keys  | Rotate selected layer(s) by 10 degrees.                                  |

### Canvas & Global Controls

| Action                      | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| **Drag Background**         | Pan the canvas viewport.                                     |
| **Mouse Wheel**             | Zoom the viewport in or out (centered on the cursor).        |
| **Drag & Drop Image File**  | Add a new image layer from a file on your disk.              |
| `Shift` + **Drag Empty Space** | Define a new canvas size with a live preview.              |
| **Double-Click Empty Space**  | Deselect all layers.                                         |

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