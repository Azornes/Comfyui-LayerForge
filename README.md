# LayerForge – Advanced Canvas Node Editor for ComfyUI 🎨

**LayerForge** is an advanced fork of the original `Canvas Node` for ComfyUI, extended with full multi-layer support, masks, blending modes, opacity control, canvas resizing, snapping, and high-precision transformations — all integrated into a node-based workflow.

---

## ✨ Key Features

- 🖼️ Add images to layers from disk or node outputs
- 📐 Move, scale, rotate layers with mouse or keyboard
- 🌈 Blend Modes (e.g. overlay, multiply, soft-light, etc.)
- 🕳️ Per-layer **masking** with full alpha control
- 🔎 Scalable & pannable canvas viewport
- 🎯 Grid snapping with `Ctrl` modifier
- 📤 Export flattened image + mask to server
- 🔃 Import latest generated image from ComfyUI
- 🔧 Canvas resize with live preview overlay

---

## 🖱️ Controls

| Action | Description |
|--------|-------------|
| 🖱️ Click layer | Select layer |
| 🖱️ Shift + Click | Open blend mode menu |
| 🖱️ Double-click or empty area | Deselect layers |
| 🖱️ Scroll | Zoom canvas (no selection) or scale selected layer |
| 🖱️ Shift + Scroll | Rotate selected layer |
| 🖱️ Ctrl + Drag | Enable snapping to grid |
| 🖱️ ALT + Drag | Stretch/compress layer (non-uniform) |
| 🖱️ Shift + drag on empty space | Start canvas resize |
| ⌨️ Delete | Remove selected layer |
| ⌨️ Arrow keys | Move layer (Shift = faster) |
| ⌨️ [ / ] | Rotate selected layer (Shift = snap to 15°) |

---

## 🎨 Blend Mode Menu

When `Shift+Clicking` a selected layer, a **blend mode menu** appears with:
- Available modes: `normal`, `multiply`, `overlay`, etc.
- Per-layer **opacity slider**

Changes are applied live.

---

## 🖼️ Adding Images

Click **"Add Image"** to upload files from your disk.  
Or click **"Import Input"** to fetch the latest generated image from ComfyUI (`/ycnode/get_latest_image`).

---

## 💾 Saving to Server

When saving, the canvas exports two files:
- A **flattened image** (`.png`)
- A **binary mask** (`_mask.png`)

Both are sent to `/upload/image`.

---

## 🧠 Optional: Matting Model (for cutout)

If matting (cutout) is enabled:

- **Model Name**: `models--ZhengPeng7--BiRefNet`
- Download from:
  - [Google Drive](https://drive.google.com/drive/folders/1BCLInCLH89fmTpYoP8Sgs_Eqww28f_wq?usp=sharing)
  - [Baidu](https://pan.baidu.com/s/1PiZvuHcdlcZGoL7WDYnMkA?pwd=nt76)
- Place it in: `models/BiRefNet`


---

## 📜 License

MIT — free to use, modify, and share.

---

Based on the original [`Comfyui-Ycnode`](https://github.com/Yc735/comfyui-ycnode)  
This fork significantly enhances the editing capabilities for practical compositing workflows inside ComfyUI.