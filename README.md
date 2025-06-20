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

### 🟩 When a Single Layer(Photo) is Selected

| Action           | Description                                   |
|------------------| --------------------------------------------- |
| 🔁 Mouse wheel   | Scale layer in/out                            |
| ⇧ + Mouse wheel  | Rotate layer clockwise / counterclockwise     |
| 🖱️ Drag         | Move layer freely                             |
| Ctrl + Drag      | Move layer with **grid snapping**             |
| ⇧ + Click again  | Open **Blend Mode** and opacity menu          |
| Delete        | Remove selected layer                         |
| e + ⌨️ Arrow keys | Nudge layer                  |
| ⌨️ \[ / ]        | Rotate layer by -1° / +1° |


### 🟦 When Multiple Layers Are Selected

| Action                    | Description                                 |
|---------------------------| ------------------------------------------- |
| Ctrl + Click other layers | Add/remove from selection                   |
| 🖱️ Drag                  | Move all selected layers together           |
| Ctrl + Drag                  | Move with **snapping to grid**              |
| ⇧ + Click on one          | Open **blend mode** for that specific layer |
| Delete                    | Remove all selected layers                  |

### ⬜ When No Layer is Selected

| Action                            | Description                              |
| --------------------------------- | ---------------------------------------- |
| 🖱️ Drag background               | Pan the canvas                           |
| 🖱️ Mouse wheel                   | Zoom in/out (focused on cursor position) |
| ⇧ + Drag in empty space           | Start **canvas resize** region           |
| 🖱️ Click layer                   | Select it                                |
| Double click or click empty space | Deselect all layers                      |



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