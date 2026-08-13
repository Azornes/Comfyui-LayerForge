# Testing LayerForge

LayerForge does not require a project-local `venv`. Local Python checks use the
Python runtime bundled with the ComfyUI portable installation. CI creates its
own temporary Python environment with `actions/setup-python`; neither setup
depends on a committed or pre-existing virtual environment.

## Local Windows checks

Run these commands from the LayerForge project directory:

```powershell
$ComfyPython = "..\..\..\python_embeded\python.exe"

& $ComfyPython -m pytest -q
& $ComfyPython -m pytest -q --cov=python --cov-report=term-missing
& $ComfyPython -m ruff check __init__.py python tests
& $ComfyPython -m compileall -q __init__.py python tests
```

The explicit interpreter path is intentional: it keeps tests aligned with the
Python dependencies used by the running ComfyUI installation. If a developer
uses a non-portable ComfyUI installation, the same commands can be run with
that installation's Python executable instead.

## Frontend checks

```powershell
npm test
npm run lint
npx tsc --noEmit
```

After changing TypeScript, CSS, or HTML source files, rebuild the generated
frontend before running the frontend checks:

```powershell
.\build.bat
```

## Continuous integration

The backend CI job follows the same dependency model as
`comfyui-model-resolver`: GitHub Actions provisions Python 3.10, installs the
project with its development dependencies, and runs pytest, coverage, Ruff,
and the syntax check. A local `venv` is not part of the repository contract.
