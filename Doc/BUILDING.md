# Building the Frontend

LayerForge uses TypeScript for its frontend source and compiles it to JavaScript for use in the browser.

## Requirements

- [Node.js](https://nodejs.org/), which includes npm
- Python checks are documented in [TESTING.md](TESTING.md).

## Install dependencies

Before the first build, open a terminal in the project root and install the development dependencies:

```powershell
npm install
```

## Build the project

Run the following command from the project root to compile TypeScript and copy the CSS and HTML assets:

```powershell
.\\build.bat
```

The build script:

1. Copies files from `src/css` to `js/css`.
2. Copies files from `src/templates` to `js/templates`.
3. Compiles TypeScript files from `src` into JavaScript files in `js`.

The generated files in `js/` are served by ComfyUI. Keep `src/` as the source of truth and rebuild after changing TypeScript, CSS, or template files.

## Source layout

The frontend is organized by responsibility:

- `src/canvas_view.ts` is the stable ComfyUI bootstrap. Its implementation is in `src/app/canvas_view.ts`.
- `src/app/layer_forge_connections.ts` contains graph identity, workflow
  connections, and ComfyUI event/WebSocket integration used by the canvas.
- `src/canvas/` contains the canvas runtime, layers, state, rendering, selection, tools, and interactions.
- `src/canvas/canvas_history.ts` contains the bounded undo/redo snapshot model.
- `src/io/` contains ComfyUI input and output handling.
- `src/mask/` contains mask editing, mask algorithms, and detector/editor integrations.
- `src/mask/mask_result_utils.ts` contains shared mask-result conversion and
  application helpers; SAM and matting integrations retain their own side
  effects.
- `src/media/` contains image, blob, upload, preview, and export helpers.
- `src/media/image_cache.ts` contains the in-memory image cache. IndexedDB image
  persistence and reference tracking remain in `src/persistence/`.
- `src/persistence/` contains IndexedDB and image-reference persistence.
- `src/persistence/contracts.ts` contains shared persisted-state and worker
  message contracts.
- `src/shared/` contains shared types and error handling.
- `src/utils/` contains smaller cross-cutting browser and ComfyUI helpers.

ComfyUI scans the generated web directory recursively. Only `js/canvas_view.js` invokes `registerLayerForgeExtension`; `js/app/canvas_view.js` exports the registration function without invoking it, preventing duplicate extension registration.

## Watch mode

To rebuild automatically whenever TypeScript, CSS, or HTML files in `src` change, run:

```powershell
.\\node_modules\\.bin\\nodemon.cmd --watch src --ext ts,css,html --exec .\\build.bat
```

This uses `nodemon` to watch the `src` directory and run `build.bat` after a source change.
