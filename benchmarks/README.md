# LayerForge offline benchmarks

These benchmarks are deliberately separate from the functional test suite. They
measure the expensive data and pixel paths without starting ComfyUI or
downloading a model.

## Frontend JavaScript

This measures the real LayerForge mask pixel helpers, layer snapshot cloning,
and state signatures:

```powershell
npm run benchmark -- --sizes 512,1024,2048 --layer-counts 1,4,8,16 --iterations 5
```

Use `--format json` for machine-readable output. The Node benchmark does not
pretend that canvas stubs represent real rasterization; use the browser harness
for that part.

## Backend Python

Run it with the embedded Python used by the active Easy ComfyUI installation:

```powershell
rtk proxy E:\AI\AI\ComfyUI\ComfyUI_Easy\All_Nodes\python_embeded\python.exe benchmarks\backend.py --sizes 512,1024,2048 --iterations 5
```

The script measures tensor/data-URL conversion, per-sample and batch PNG
serialization, plus preprocessing/postprocessing around a fake RMBG model. It
never loads a checkpoint. Set `LAYERFORGE_COMFY_ROOT` if the active ComfyUI
root differs from the project default.

## Real browser Canvas 2D and PNG export

The browser harness measures representative compositing for 1, 4, 8, and 16
layers, crop/blend/mask variants, PNG export, and the actual LayerForge distance
transform implementation. It is not a ComfyUI workflow test; it uses only a
local browser Canvas implementation.

Start a static server with the repository explicitly selected as its document
root. This works even when the terminal is currently in another directory:

```powershell
rtk proxy E:\AI\AI\ComfyUI\ComfyUI_Easy\All_Nodes\python_embeded\python.exe -m http.server 8765 --directory E:\AI\AI\ComfyUI\ComfyUI_Windows_portable\ComfyUI\custom_nodes\Comfyui-LayerForge
```

Open:

```text
http://127.0.0.1:8765/benchmarks/browser.html
```

For the larger matrix, set the size field to `512,1024,2048`. Keep the same
browser, zoom, hardware acceleration setting, and iteration count when comparing
two revisions. Benchmark output is printed in the page and is not written to the
repository.

## Interpreting results

Compare median and p95 on the same machine. Warm-up samples are discarded. A
browser render median above roughly 16 ms is likely to affect 60 FPS interaction;
PNG export is a separate operation and should not be confused with the per-frame
render budget. Model inference is intentionally excluded from the fake matting
measurement and must be benchmarked separately with a specific checkpoint and
device.
