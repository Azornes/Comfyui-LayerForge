<h1 align="center">LayerForge – Advanced Canvas Editor for ComfyUI 🎨</h1>


<p align="center"><i>LayerForge is an advanced canvas node for ComfyUI, providing a Photoshop-like layer-based editing experience directly within your workflow. It extends the concept of a simple canvas with multi-layer support, masking, blend modes, precise transformations, and seamless integration with other nodes.</i></p>

<p align="center">

<a href="https://registry.comfy.org/publishers/azornes/nodes/layerforge" style="display:inline-flex; align-items:center; gap:6px;">
  <img alt="ComfyUI" src="https://img.shields.io/badge/ComfyUI-1a1a1a?style=for-the-badge&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAASFBMVEVHcEwYLtsYLtkXLtkXLdkYLtkWLdcFIdoAD95uerfI1XLR3mq3xIP8/yj0/zvw/0FSYMP5/zKMmKQtPNOuuozj8FOhrZW7x4FMWFFbAAAABnRSTlMAUrPX87KxijklAAAA00lEQVR4AX3SBw6DMAxA0UzbrIzO+9+02GkEpoWP9hPZZs06Hw75aI3k4W/+wkQtnGZNhF1I34BzalQcxkmasY0b9raklNcvLYU1GNiiOeVWauOa/XS526gRyzpV/7HeUOG9Jp6vcsvUrCPeKg/3KBKBQhoTD1dQggPWzPVfFOIgo85/kR4y6oB/8SlIEh7wvmTuKd3wgLVW1sTfRBoR7oWVqy/U2NcrWDYMINE7NUuJuoV+2fhaWmnbjzcOWnRv7XbiLh/Y9dNUqk2y0QcNwTu7wgf+/BhsPUhf4QAAAABJRU5ErkJggg==" />
  <img alt="Downloads" src="https://img.shields.io/badge/dynamic/json?color=%230D2A4A&label=&query=downloads&url=https://gist.githubusercontent.com/Azornes/912463d4edd123956066a7aaaa3ef835/raw/top_layerforge.json&style=for-the-badge" />
</a>
<a href='https://github.com/Azornes/Comfyui-LayerForge'>
  <img alt='GitHub Clones' src='https://img.shields.io/badge/dynamic/json?color=2F80ED&label=Clone&query=count&url=https://gist.githubusercontent.com/Azornes/5fa586b9e6938f48638fad37a1d146ae/raw/clone.json&logo=github&style=for-the-badge'>
</a>
  <a href="https://visitorbadge.io/status?path=https%3A%2F%2Fgithub.com%2FAzornes%2FComfyui-LayerForge">
    <img src="https://api.visitorbadge.io/api/combined?path=https%3A%2F%2Fgithub.com%2FAzornes%2FComfyui-LayerForge&countColor=%2337d67a&style=for-the-badge&labelStyle=none" />
  </a>
  <img alt="Python 3.10+" src="https://img.shields.io/badge/-Python_3.10+-4B8BBE?logo=python&logoColor=FFFFFF&style=for-the-badge&logoWidth=20">
  <img alt="JavaScript" src="https://img.shields.io/badge/-JavaScript-000000?logo=javascript&logoColor=F7DF1E&style=for-the-badge&logoWidth=20">
</p>

### Why LayerForge?

- **Full Creative Control:** Move beyond simple image inputs. Composite, mask, and blend multiple elements without
  leaving ComfyUI.
- **Intuitive UI:** Familiar controls like drag-and-drop, keyboard shortcuts, and a pannable/zoomable viewport make
  editing fast and easy.

---

https://github.com/user-attachments/assets/90fffb9a-dae2-4d19-aca2-5d47600f0a01

https://github.com/user-attachments/assets/9c7ce1de-873b-4a3b-8579-0fc67642af3a

## ✨ Key Features

- **Freeform Inpainting Area:** Draw any custom (non-rectangular) area directly inside the image for inpainting. The tool generates content that is coherent with the rest of the image, without requiring a brush.
- **Persistent & Stateful:** Your work is automatically saved to the browser's IndexedDB, preserving your full canvas
  state (layers, positions, etc.) even after a page reload.
- **Multi-Layer Editing:** Add, arrange, and manage multiple image layers with z-ordering.
- **Advanced Masking Tool:** A dedicated masking mode with adjustable brush size, strength, and softness. Masks have
  their own separate undo/redo history.
- **Full Transformation Controls:** Precisely move, scale, and rotate layers with mouse or keyboard shortcuts.
- **Blend Modes & Opacity:** Apply 12 common blend modes (`Overlay`, `Multiply`, etc.) and adjust opacity on a per-layer
  basis via a context menu.
- **Comprehensive Undo/Redo:** Full history support for both layer manipulations and mask drawing.
- **Seamless I/O:**
    - **Drag & Drop** image files to create new layers.
    - **Copy & Paste** images directly from your system clipboard.
    - Import the last generated image from your workflow with one click.
- **AI-Powered Matting:** Optional background removal for any layer using the `BiRefNet` model.
- **Efficient Memory Management:** An automatic garbage collection system cleans up unused image data to keep the
  browser's storage footprint low.
- **Workflow Integration:** Outputs a final composite **image** and a combined alpha **mask**, ready for any other
  ComfyUI node.

---

## 🚀 Installation

### Install via ComfyUI-Manager
* Search `Comfyui-LayerForge` in ComfyUI-Manager and click `Install` button.

### Manual Install
1. Install [ComfyUi](https://github.com/comfyanonymous/ComfyUI).
2. Clone this repo into `custom_modules`:
    ```bash
    cd ComfyUI/custom_nodes/
    git clone https://github.com/Azornes/Comfyui-LayerForge.git
    ```
3. Start up ComfyUI.

---
## 🧪 Workflow Example

For a quick test of **LayerForge**, you can try the example workflow provided below. It demonstrates a basic compositing setup using the node.

**🔗 Download Example Workflow**

![📥 LayerForge\_Example1](https://github.com/user-attachments/assets/1b6e9feb-6549-4ed1-9ad2-011b477b8290)


![📥 LayerForge\_Example2](https://github.com/user-attachments/assets/7e594ebf-a047-46e1-972d-516b0f541743)



**How to load the workflow:**
Click on the image above, then drag and drop it into your ComfyUI workflow window in your browser. The workflow should load automatically.

---


## 🎮 Controls & Shortcuts

### Canvas Control

| Action                       | Description                |
|------------------------------|----------------------------|
| `Click + Drag`               | Pan canvas view            |
| `Mouse Wheel`                | Zoom view in/out           |
| `Shift + Click (background)` | Start resizing canvas area |
| `Shift + Ctrl + Click`       | Start moving entire canvas |
| `Shift + S + Left Click`     | Draw custom shape for output area |
| `Single Click (background)`  | Deselect all layers        |
| `Esc`                        | Close fullscreen editor mode |
| `Double Click (background)`  | Deselect all layers        |

### Clipboard & I/O

| Action                   | Description                                     |
|--------------------------|-------------------------------------------------|
| `Ctrl + C`               | Copy selected layer(s)                          |
| `Ctrl + V`               | Paste from clipboard (image or internal layers) |
| `Drag & Drop Image File` | Add image as a new layer                        |

### Layer Interaction

| Action                | Description                     |
|-----------------------|---------------------------------|
| `Click + Drag`        | Move selected layer(s)          |
| `Ctrl + Click`        | Add/Remove layer from selection |
| `Alt + Drag`          | Clone selected layer(s)         |
| `Right Click`         | Show blend mode & opacity menu  |
| `Mouse Wheel`         | Scale layer (snaps to grid)     |
| `Ctrl + Mouse Wheel`  | Fine-scale layer                |
| `Shift + Mouse Wheel` | Rotate layer by 5°              |
| `Shift + Ctrl + Mouse Wheel` | Snap rotation to 5° increments |
| `Arrow Keys`          | Nudge layer by 1px              |
| `Shift + Arrow Keys`  | Nudge layer by 10px             |
| `[` or `]`            | Rotate by 1°                    |
| `Shift + [` or `]`    | Rotate by 10°                   |
| `Delete`              | Delete selected layer(s)        |

### Transform Handles (on selected layer)

| Action                 | Description                              |
|------------------------|------------------------------------------|
| `Drag Corner/Side`     | Resize layer                             |
| `Drag Rotation Handle` | Rotate layer                             |
| `Hold Shift`           | Keep aspect ratio / Snap rotation to 15° |
| `Hold Ctrl`            | Snap to grid                             |

### Mask Mode

| Action                       | Description                                                           |
|------------------------------|-----------------------------------------------------------------------|
| `Click + Drag`               | Paint on the mask                                                     |
| `Middle Mouse Button + Drag` | Pan canvas view                                                       |
| `Mouse Wheel`                | Zoom view in/out                                                      |
| **Brush Controls**           | Use sliders to control brush **Size**, **Strength**, and **Softness** |
| **Clear Mask**               | Remove the entire mask                                                |
| **Exit Mode**                | Click the "Draw Mask" button again                                    |

## 🧠 Optional: Matting Model (for image cutout)

The "Matting" feature allows you to automatically generate a cutout (alpha mask) for a selected layer. This is an
optional feature and requires a model.

> - **Model Name**: `BiRefNet`
> - **Download from**:
    >
- [Hugging Face](https://huggingface.co/ZhengPeng7/BiRefNet/tree/main) (Recommended)
- [Google Drive](https://drive.google.com/drive/folders/1BCLInCLH89fmTpYoP8Sgs_Eqww28f_wq?usp=sharing)
> - **Installation Path**: Place the model file in `ComfyUI/models/BiRefNet/`.

---

## 🐞 Known Issue:
### `node_id` not auto-filled → black output

In some cases, **ComfyUI doesn't auto-fill the `node_id`** when adding a node.
As a result, the node may produce a **completely black image** or not work at all.

**Workaround:**

* Search node ID in ComfyUI settings.
* In NodesMap check "Enable node ID display"
* Manually enter the correct `node_id` (match the ID Node "LayerForge" shown above the node, on the right side).

> [!WARNING]  
> This is a known issue and not yet fixed.
> Please follow the steps above if your output is black or broken.

---

## 📜 License

This project is licensed under the MIT License. Feel free to use, modify, and distribute.

---

Based on the original [**Comfyui-Ycanvas**](https://github.com/yichengup/Comfyui-Ycanvas) by yichengup. This fork
significantly enhances the editing capabilities for practical compositing workflows inside ComfyUI.
