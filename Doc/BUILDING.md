# Building the Frontend

LayerForge uses TypeScript for its frontend source and compiles it to JavaScript for use in the browser.

## Requirements

- [Node.js](https://nodejs.org/), which includes npm

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

## Watch mode

To rebuild automatically whenever TypeScript, CSS, or HTML files in `src` change, run:

```powershell
.\\node_modules\\.bin\\nodemon.cmd --watch src --ext ts,css,html --exec .\\build.bat
```

This uses `nodemon` to watch the `src` directory and run `build.bat` after a source change.
