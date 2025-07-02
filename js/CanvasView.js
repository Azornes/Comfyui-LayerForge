import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {$el} from "../../scripts/ui.js";

import {Canvas} from "./Canvas.js";
import {clearAllCanvasStates} from "./db.js";
import {ImageCache} from "./ImageCache.js";
import {generateUniqueFileName} from "./utils/CommonUtils.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";

const log = createModuleLogger('Canvas_view');

async function createCanvasWidget(node, widget, app) {
    const canvas = new Canvas(node, widget, {
        onStateChange: () => updateOutput()
    });
    const imageCache = new ImageCache();

    const style = document.createElement('style');
    style.textContent = `
        .painter-button {
            background: linear-gradient(to bottom, #4a4a4a, #3a3a3a);
            border: 1px solid #2a2a2a;
            border-radius: 4px;
            color: #ffffff;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 80px;
            text-align: center;
            margin: 2px;
            text-shadow: 0 1px 1px rgba(0,0,0,0.2);
        }

        .painter-button:hover {
            background: linear-gradient(to bottom, #5a5a5a, #4a4a4a);
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .painter-button:active {
            background: linear-gradient(to bottom, #3a3a3a, #4a4a4a);
            transform: translateY(1px);
        }
        
        .painter-button:disabled,
        .painter-button:disabled:hover {
            background: #555;
            color: #888;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
            border-color: #444;
        }

        .painter-button.primary {
            background: linear-gradient(to bottom, #4a6cd4, #3a5cc4);
            border-color: #2a4cb4;
        }

        .painter-button.primary:hover {
            background: linear-gradient(to bottom, #5a7ce4, #4a6cd4);
        }

        .painter-controls {
            background: linear-gradient(to bottom, #404040, #383838);
            border-bottom: 1px solid #2a2a2a;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 8px;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-start;
        }

       .painter-slider-container {
           display: flex;
           align-items: center;
           gap: 8px;
           color: #fff;
           font-size: 12px;
       }

       .painter-slider-container input[type="range"] {
           width: 80px;
       }


        .painter-button-group {
            display: flex;
            align-items: center;
            gap: 6px;
            background-color: rgba(0,0,0,0.2);
            padding: 4px;
            border-radius: 6px;
        }

        .painter-clipboard-group {
            display: flex;
            align-items: center;
            gap: 2px;
            background-color: rgba(0,0,0,0.15);
            padding: 3px;
            border-radius: 6px;
            border: 1px solid rgba(255,255,255,0.1);
            position: relative;
        }

        .painter-clipboard-group::before {
            content: "";
            position: absolute;
            top: -2px;
            left: 50%;
            transform: translateX(-50%);
            width: 20px;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(74, 108, 212, 0.6), transparent);
            border-radius: 1px;
        }

        .painter-clipboard-group .painter-button {
            margin: 1px;
        }

        .painter-separator {
            width: 1px;
            height: 28px;
            background-color: #2a2a2a;
            margin: 0 8px;
        }

        .painter-container {
            background: #607080;  /* 带蓝色的灰色背景 */
            border: 1px solid #4a5a6a;
            border-radius: 6px;
            box-shadow: inset 0 0 10px rgba(0,0,0,0.1);
            transition: border-color 0.3s ease; /* Dodano dla płynnej zmiany ramki */
        }
        
        .painter-container.drag-over {
            border-color: #00ff00; /* Zielona ramka podczas przeciągania */
            border-style: dashed;
        }

        .painter-dialog {
            background: #404040;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            padding: 20px;
            color: #ffffff;
        }

        .painter-dialog input {
            background: #303030;
            border: 1px solid #505050;
            border-radius: 4px;
            color: #ffffff;
            padding: 4px 8px;
            margin: 4px;
            width: 80px;
        }

        .painter-dialog button {
            background: #505050;
            border: 1px solid #606060;
            border-radius: 4px;
            color: #ffffff;
            padding: 4px 12px;
            margin: 4px;
            cursor: pointer;
        }

        .painter-dialog button:hover {
            background: #606060;
        }

        .blend-opacity-slider {
            width: 100%;
            margin: 5px 0;
            display: none;
        }

        .blend-mode-active .blend-opacity-slider {
            display: block;
        }

        .blend-mode-item {
            padding: 5px;
            cursor: pointer;
            position: relative;
        }

        .blend-mode-item.active {
            background-color: rgba(0,0,0,0.1);
        }
        
                .blend-mode-item.active {
            background-color: rgba(0,0,0,0.1);
        }

        .painter-tooltip {
            position: fixed;
            display: none;
            background: #3a3a3a;
            color: #f0f0f0;
            border: 1px solid #555;
            border-radius: 8px;
            padding: 12px 18px;
            z-index: 9999;
            font-size: 13px;
            line-height: 1.7;
            width: auto;
            max-width: min(500px, calc(100vw - 40px));
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            pointer-events: none;
            transform-origin: top left;
            transition: transform 0.2s ease;
            will-change: transform;
        }

        .painter-tooltip.scale-down {
            transform: scale(0.9);
            transform-origin: top;
        }

        .painter-tooltip.scale-down-more {
            transform: scale(0.8);
            transform-origin: top;
        }

        .painter-tooltip table {
            width: 100%;
            border-collapse: collapse;
            margin: 8px 0;
        }

        .painter-tooltip table td {
            padding: 2px 8px;
            vertical-align: middle;
        }

        .painter-tooltip table td:first-child {
            width: auto;
            white-space: nowrap;
            min-width: fit-content;
        }

        .painter-tooltip table td:last-child {
            width: auto;
        }

        .painter-tooltip table tr:nth-child(odd) td {
            background-color: rgba(0,0,0,0.1);
        }

        @media (max-width: 600px) {
            .painter-tooltip {
                font-size: 11px;
                padding: 8px 12px;
            }
            .painter-tooltip table td {
                padding: 2px 4px;
            }
            .painter-tooltip kbd {
                padding: 1px 4px;
                font-size: 10px;
            }
            .painter-tooltip table td:first-child {
                width: 40%;
            }
            .painter-tooltip table td:last-child {
                width: 60%;
            }
            .painter-tooltip h4 {
                font-size: 12px;
                margin-top: 8px;
                margin-bottom: 4px;
            }
        }

        @media (max-width: 400px) {
            .painter-tooltip {
                font-size: 10px;
                padding: 6px 8px;
            }
            .painter-tooltip table td {
                padding: 1px 3px;
            }
            .painter-tooltip kbd {
                padding: 0px 3px;
                font-size: 9px;
            }
            .painter-tooltip table td:first-child {
                width: 35%;
            }
            .painter-tooltip table td:last-child {
                width: 65%;
            }
            .painter-tooltip h4 {
                font-size: 11px;
                margin-top: 6px;
                margin-bottom: 3px;
            }
        }

        .painter-tooltip::-webkit-scrollbar {
            width: 8px;
        }

        .painter-tooltip::-webkit-scrollbar-track {
            background: #2a2a2a;
            border-radius: 4px;
        }

        .painter-tooltip::-webkit-scrollbar-thumb {
            background: #555;
            border-radius: 4px;
        }

        .painter-tooltip::-webkit-scrollbar-thumb:hover {
            background: #666;
        }
        
        .painter-tooltip h4 {
            margin-top: 10px;
            margin-bottom: 5px;
            color: #4a90e2; /* Jasnoniebieski akcent */
            border-bottom: 1px solid #555;
            padding-bottom: 4px;
        }

        .painter-tooltip ul {
            list-style: none;
            padding-left: 10px;
            margin: 0;
        }
        
        .painter-tooltip kbd {
            background-color: #2a2a2a;
            border: 1px solid #1a1a1a;
            border-radius: 3px;
            padding: 2px 6px;
            font-family: monospace;
            font-size: 12px;
            color: #d0d0d0;
        }
        
        .painter-container.has-focus {
            /* Używamy box-shadow, aby stworzyć efekt zewnętrznej ramki,
               która nie wpłynie na rozmiar ani pozycję elementu. */
            box-shadow: 0 0 0 2px white;
            /* Możesz też zmienić kolor istniejącej ramki, ale box-shadow jest bardziej wyrazisty */
            /* border-color: white; */
        }

        .painter-button.matting-button {
            position: relative;
            transition: all 0.3s ease;
        }

        .painter-button.matting-button.loading {
            padding-right: 36px; /* Make space for spinner */
            cursor: wait;
        }

        .painter-button.matting-button .matting-spinner {
            display: none;
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: matting-spin 1s linear infinite;
        }

        .painter-button.matting-button.loading .matting-spinner {
            display: block;
        }

        @keyframes matting-spin {
            to {
                transform: translateY(-50%) rotate(360deg);
            }
        }
    `;
    style.textContent += `
        .painter-modal-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(0, 0, 0, 0.8);
            z-index: 111;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .painter-modal-content {
            width: 90vw;
            height: 90vh;
            background-color: #353535;
            border: 1px solid #222;
            border-radius: 8px;
            box-shadow: 0 5px 25px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            position: relative;
        }


    `;
    document.head.appendChild(style);

    const helpTooltip = $el("div.painter-tooltip", {
        id: `painter-help-tooltip-${node.id}`,
    });

    const standardShortcuts = `
        <h4>Canvas Control</h4>
        <table>
            <tr><td><kbd>Click + Drag</kbd></td><td>Pan canvas view</td></tr>
            <tr><td><kbd>Mouse Wheel</kbd></td><td>Zoom view in/out</td></tr>
            <tr><td><kbd>Shift + Click (background)</kbd></td><td>Start resizing canvas area</td></tr>
            <tr><td><kbd>Shift + Ctrl + Click</kbd></td><td>Start moving entire canvas</td></tr>
            <tr><td><kbd>Single Click (background)</kbd></td><td>Deselect all layers</td></tr>
        </table>

        <h4>Clipboard & I/O</h4>
        <table>
            <tr><td><kbd>Ctrl + C</kbd></td><td>Copy selected layer(s)</td></tr>
            <tr><td><kbd>Ctrl + V</kbd></td><td>Paste from clipboard (image or internal layers)</td></tr>
            <tr><td><kbd>Drag & Drop Image File</kbd></td><td>Add image as a new layer</td></tr>
        </table>

        <h4>Layer Interaction</h4>
        <table>
            <tr><td><kbd>Click + Drag</kbd></td><td>Move selected layer(s)</td></tr>
            <tr><td><kbd>Ctrl + Click</kbd></td><td>Add/Remove layer from selection</td></tr>
            <tr><td><kbd>Alt + Drag</kbd></td><td>Clone selected layer(s)</td></tr>
            <tr><td><kbd>Right Click</kbd></td><td>Show blend mode & opacity menu</td></tr>
            <tr><td><kbd>Mouse Wheel</kbd></td><td>Scale layer (snaps to grid)</td></tr>
            <tr><td><kbd>Ctrl + Mouse Wheel</kbd></td><td>Fine-scale layer</td></tr>
            <tr><td><kbd>Shift + Mouse Wheel</kbd></td><td>Rotate layer by 5°</td></tr>
            <tr><td><kbd>Arrow Keys</kbd></td><td>Nudge layer by 1px</td></tr>
            <tr><td><kbd>Shift + Arrow Keys</kbd></td><td>Nudge layer by 10px</td></tr>
            <tr><td><kbd>[</kbd> or <kbd>]</kbd></td><td>Rotate by 1°</td></tr>
            <tr><td><kbd>Shift + [</kbd> or <kbd>]</kbd></td><td>Rotate by 10°</td></tr>
            <tr><td><kbd>Delete</kbd></td><td>Delete selected layer(s)</td></tr>
        </table>

        <h4>Transform Handles (on selected layer)</h4>
        <table>
            <tr><td><kbd>Drag Corner/Side</kbd></td><td>Resize layer</td></tr>
            <tr><td><kbd>Drag Rotation Handle</kbd></td><td>Rotate layer</td></tr>
            <tr><td><kbd>Hold Shift</kbd></td><td>Keep aspect ratio / Snap rotation to 15°</td></tr>
            <tr><td><kbd>Hold Ctrl</kbd></td><td>Snap to grid</td></tr>
        </table>
    `;

    const maskShortcuts = `
        <h4>Mask Mode</h4>
        <table>
            <tr><td><kbd>Click + Drag</kbd></td><td>Paint on the mask</td></tr>
            <tr><td><kbd>Middle Mouse Button + Drag</kbd></td><td>Pan canvas view</td></tr>
            <tr><td><kbd>Mouse Wheel</kbd></td><td>Zoom view in/out</td></tr>
            <tr><td><strong>Brush Controls</strong></td><td>Use sliders to control brush <strong>Size</strong>, <strong>Strength</strong>, and <strong>Hardness</strong></td></tr>
            <tr><td><strong>Clear Mask</strong></td><td>Remove the entire mask</td></tr>
            <tr><td><strong>Exit Mode</strong></td><td>Click the "Draw Mask" button again</td></tr>
        </table>
    `;

    document.body.appendChild(helpTooltip);
    const controlPanel = $el("div.painterControlPanel", {}, [
        $el("div.controls.painter-controls", {
            style: {
                position: "absolute",
                top: "0",
                left: "0",
                right: "0",
                zIndex: "10",
            },

            onresize: (entries) => {
                const controlsHeight = entries[0].target.offsetHeight;
                canvasContainer.style.top = (controlsHeight + 10) + "px";
            }
        }, [
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    id: `open-editor-btn-${node.id}`,
                    textContent: "⛶",
                    title: "Open in Editor",
                    style: {minWidth: "40px", maxWidth: "40px", fontWeight: "bold"},
                }),
                $el("button.painter-button", {
                    textContent: "?",
                    title: "Show shortcuts",
                    style: {
                        minWidth: "30px",
                        maxWidth: "30px",
                        fontWeight: "bold",
                    },
                    onmouseenter: (e) => {
                        if (canvas.maskTool.isActive) {
                            helpTooltip.innerHTML = maskShortcuts;
                        } else {
                            helpTooltip.innerHTML = standardShortcuts;
                        }

                        helpTooltip.style.visibility = 'hidden';
                        helpTooltip.style.display = 'block';

                        const buttonRect = e.target.getBoundingClientRect();
                        const tooltipRect = helpTooltip.getBoundingClientRect();
                        const viewportWidth = window.innerWidth;
                        const viewportHeight = window.innerHeight;

                        let left = buttonRect.left;
                        let top = buttonRect.bottom + 5;

                        if (left + tooltipRect.width > viewportWidth) {
                            left = viewportWidth - tooltipRect.width - 10;
                        }

                        if (top + tooltipRect.height > viewportHeight) {

                            top = buttonRect.top - tooltipRect.height - 5;
                        }

                        if (left < 10) left = 10;

                        if (top < 10) top = 10;

                        helpTooltip.style.left = `${left}px`;
                        helpTooltip.style.top = `${top}px`;
                        helpTooltip.style.visibility = 'visible';
                    },
                    onmouseleave: () => {
                        helpTooltip.style.display = 'none';
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Add Image",
                    title: "Add image from file",
                    onclick: () => {
                        const fitOnAddWidget = node.widgets.find(w => w.name === "fit_on_add");
                        const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = async (e) => {
                            for (const file of e.target.files) {
                                const reader = new FileReader();
                                reader.onload = (event) => {
                                    const img = new Image();
                                    img.onload = () => {
                                        canvas.addLayer(img, {}, addMode);
                                    };
                                    img.src = event.target.result;
                                };
                                reader.readAsDataURL(file);
                            }
                        };
                        input.click();
                    }
                }),
                $el("button.painter-button.primary", {
                    textContent: "Import Input",
                    title: "Import image from another node",
                    onclick: () => canvas.canvasIO.importLatestImage()
                }),
                $el("div.painter-clipboard-group", {}, [
                    $el("button.painter-button.primary", {
                        textContent: "Paste Image",
                        title: "Paste image from clipboard",
                        onclick: () => {

                            const fitOnAddWidget = node.widgets.find(w => w.name === "fit_on_add");
                            const addMode = fitOnAddWidget && fitOnAddWidget.value ? 'fit' : 'center';
                            canvas.canvasLayers.handlePaste(addMode);
                        }
                    }),
                    $el("button.painter-button", {
                        id: `clipboard-toggle-${node.id}`,
                        textContent: "📋 System",
                        title: "Toggle clipboard source: System Clipboard",
                        style: {
                            minWidth: "100px",
                            fontSize: "11px",
                            backgroundColor: "#4a4a4a"
                        },
                        onclick: (e) => {
                            const button = e.target;
                            if (canvas.canvasLayers.clipboardPreference === 'system') {
                                canvas.canvasLayers.clipboardPreference = 'clipspace';
                                button.textContent = "📋 Clipspace";
                                button.title = "Toggle clipboard source: ComfyUI Clipspace";
                                button.style.backgroundColor = "#4a6cd4";
                            } else {
                                canvas.canvasLayers.clipboardPreference = 'system';
                                button.textContent = "📋 System";
                                button.title = "Toggle clipboard source: System Clipboard";
                                button.style.backgroundColor = "#4a4a4a";
                            }
                            log.info(`Clipboard preference toggled to: ${canvas.canvasLayers.clipboardPreference}`);
                        },
                        onmouseenter: (e) => {
                            const currentPreference = canvas.canvasLayers.clipboardPreference;
                            let tooltipContent = '';
                            
                            if (currentPreference === 'system') {
                                tooltipContent = `
                                    <h4>📋 System Clipboard Mode</h4>
                                    <table>
                                        <tr><td><kbd>Ctrl + C</kbd></td><td>Copy selected layers to internal clipboard + <strong>system clipboard</strong> as flattened image</td></tr>
                                        <tr><td><kbd>Ctrl + V</kbd></td><td><strong>Priority:</strong></td></tr>
                                        <tr><td></td><td>1️⃣ Internal clipboard (copied layers)</td></tr>
                                        <tr><td></td><td>2️⃣ System clipboard (images, screenshots)</td></tr>
                                        <tr><td></td><td>3️⃣ System clipboard (file paths, URLs)</td></tr>
                                        <tr><td><kbd>Paste Image</kbd></td><td>Same as Ctrl+V but respects fit_on_add setting</td></tr>
                                        <tr><td><kbd>Drag & Drop</kbd></td><td>Load images directly from files</td></tr>
                                    </table>
                                    <div style="margin-top: 8px; padding: 6px; background: rgba(255,165,0,0.2); border: 1px solid rgba(255,165,0,0.4); border-radius: 4px; font-size: 11px;">
                                        ⚠️ <strong>Security Note:</strong> "Paste Image" button for external images may not work due to browser security restrictions. Use Ctrl+V instead or Drag & Drop.
                                    </div>
                                    <div style="margin-top: 8px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 11px;">
                                        💡 <strong>Best for:</strong> Working with screenshots, copied images, file paths, and urls.
                                    </div>
                                `;
                            } else {
                                tooltipContent = `
                                    <h4>📋 ComfyUI Clipspace Mode</h4>
                                    <table>
                                        <tr><td><kbd>Ctrl + C</kbd></td><td>Copy selected layers to internal clipboard + <strong>ComfyUI Clipspace</strong> as flattened image</td></tr>
                                        <tr><td><kbd>Ctrl + V</kbd></td><td><strong>Priority:</strong></td></tr>
                                        <tr><td></td><td>1️⃣ Internal clipboard (copied layers)</td></tr>
                                        <tr><td></td><td>2️⃣ ComfyUI Clipspace (workflow images)</td></tr>
                                        <tr><td></td><td>3️⃣ System clipboard (fallback)</td></tr>
                                        <tr><td><kbd>Paste Image</kbd></td><td>Same as Ctrl+V but respects fit_on_add setting</td></tr>
                                        <tr><td><kbd>Drag & Drop</kbd></td><td>Load images directly from files</td></tr>
                                    </table>
                                    <div style="margin-top: 8px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 11px;">
                                        💡 <strong>Best for:</strong> ComfyUI workflow integration and node-to-node image transfer
                                    </div>
                                `;
                            }

                            helpTooltip.innerHTML = tooltipContent;
                            helpTooltip.style.visibility = 'hidden';
                            helpTooltip.style.display = 'block';

                            const buttonRect = e.target.getBoundingClientRect();
                            const tooltipRect = helpTooltip.getBoundingClientRect();
                            const viewportWidth = window.innerWidth;
                            const viewportHeight = window.innerHeight;

                            let left = buttonRect.left;
                            let top = buttonRect.bottom + 5;

                            if (left + tooltipRect.width > viewportWidth) {
                                left = viewportWidth - tooltipRect.width - 10;
                            }

                            if (top + tooltipRect.height > viewportHeight) {
                                top = buttonRect.top - tooltipRect.height - 5;
                            }

                            if (left < 10) left = 10;
                            if (top < 10) top = 10;

                            helpTooltip.style.left = `${left}px`;
                            helpTooltip.style.top = `${top}px`;
                            helpTooltip.style.visibility = 'visible';
                        },
                        onmouseleave: () => {
                            helpTooltip.style.display = 'none';
                        }
                    })
                ]),
            ]),

            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Output Area Size",
                    title: "Set the size of the output area",
                    onclick: () => {
                        const dialog = $el("div.painter-dialog", {
                            style: {
                                position: 'fixed',
                                left: '50%',
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                zIndex: '9999'
                            }
                        }, [
                            $el("div", {
                                style: {
                                    color: "white",
                                    marginBottom: "10px"
                                }
                            }, [
                                $el("label", {
                                    style: {
                                        marginRight: "5px"
                                    }
                                }, [
                                    $el("span", {}, ["Width: "])
                                ]),
                                $el("input", {
                                    type: "number",
                                    id: "canvas-width",
                                    value: canvas.width,
                                    min: "1",
                                    max: "4096"
                                })
                            ]),
                            $el("div", {
                                style: {
                                    color: "white",
                                    marginBottom: "10px"
                                }
                            }, [
                                $el("label", {
                                    style: {
                                        marginRight: "5px"
                                    }
                                }, [
                                    $el("span", {}, ["Height: "])
                                ]),
                                $el("input", {
                                    type: "number",
                                    id: "canvas-height",
                                    value: canvas.height,
                                    min: "1",
                                    max: "4096"
                                })
                            ]),
                            $el("div", {
                                style: {
                                    textAlign: "right"
                                }
                            }, [
                                $el("button", {
                                    id: "cancel-size",
                                    textContent: "Cancel"
                                }),
                                $el("button", {
                                    id: "confirm-size",
                                    textContent: "OK"
                                })
                            ])
                        ]);
                        document.body.appendChild(dialog);

                        document.getElementById('confirm-size').onclick = () => {
                            const width = parseInt(document.getElementById('canvas-width').value) || canvas.width;
                            const height = parseInt(document.getElementById('canvas-height').value) || canvas.height;
                            canvas.updateOutputAreaSize(width, height);
                            document.body.removeChild(dialog);

                        };

                        document.getElementById('cancel-size').onclick = () => {
                            document.body.removeChild(dialog);
                        };
                    }
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Remove Layer",
                    title: "Remove selected layer(s)",
                    onclick: () => canvas.removeSelectedLayers()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Up",
                    title: "Move selected layer(s) up",
                    onclick: () => canvas.canvasLayers.moveLayerUp()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Layer Down",
                    title: "Move selected layer(s) down",
                    onclick: () => canvas.canvasLayers.moveLayerDown()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Fuse",
                    title: "Flatten and merge selected layers into a single layer",
                    onclick: () => canvas.canvasLayers.fuseLayers()
                }),
            ]),

            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection", {
                    textContent: "Rotate +90°",
                    title: "Rotate selected layer(s) by +90 degrees",
                    onclick: () => canvas.canvasLayers.rotateLayer(90)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Scale +5%",
                    title: "Increase size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(1.05)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Scale -5%",
                    title: "Decrease size of selected layer(s) by 5%",
                    onclick: () => canvas.canvasLayers.resizeLayer(0.95)
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Mirror H",
                    title: "Mirror selected layer(s) horizontally",
                    onclick: () => canvas.canvasLayers.mirrorHorizontal()
                }),
                $el("button.painter-button.requires-selection", {
                    textContent: "Mirror V",
                    title: "Mirror selected layer(s) vertically",
                    onclick: () => canvas.canvasLayers.mirrorVertical()
                }),
            ]),

            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button.requires-selection.matting-button", {
                    textContent: "Matting",
                    title: "Perform background removal on the selected layer",
                    onclick: async (e) => {
                        const button = e.target.closest('.matting-button');
                        if (button.classList.contains('loading')) return;

                        const spinner = $el("div.matting-spinner");
                        button.appendChild(spinner);
                        button.classList.add('loading');

                        try {
                            if (canvas.selectedLayers.length !== 1) throw new Error("Please select exactly one image layer for matting.");

                            const selectedLayer = canvas.selectedLayers[0];
                            const selectedLayerIndex = canvas.layers.indexOf(selectedLayer);
                            const imageData = await canvas.canvasLayers.getLayerImageData(selectedLayer);
                            const response = await fetch("/matting", {
                                method: "POST",
                                headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({image: imageData})
                            });

                            if (!response.ok) throw new Error(`Server error: ${response.status} - ${response.statusText}`);

                            const result = await response.json();
                            const mattedImage = new Image();
                            mattedImage.src = result.matted_image;
                            await mattedImage.decode();
                            const newLayer = {...selectedLayer, image: mattedImage};
                            delete newLayer.imageId;
                            canvas.layers[selectedLayerIndex] = newLayer;
                            canvas.updateSelection([newLayer]);
                            canvas.render();
                            canvas.saveState();
                        } catch (error) {
                            log.error("Matting error:", error);
                            alert(`Error during matting process: ${error.message}`);
                        } finally {
                            button.classList.remove('loading');
                            button.removeChild(spinner);
                        }
                    }
                }),
                $el("button.painter-button", {
                    id: `undo-button-${node.id}`,
                    textContent: "Undo",
                    title: "Undo last action",
                    disabled: true,
                    onclick: () => canvas.canvasState.undo()
                }),
                $el("button.painter-button", {
                    id: `redo-button-${node.id}`,
                    textContent: "Redo",
                    title: "Redo last undone action",
                    disabled: true,
                    onclick: () => canvas.canvasState.redo()
                }),
            ]),
            $el("div.painter-separator"),
            $el("div.painter-button-group", {id: "mask-controls"}, [
                $el("button.painter-button", {
                    textContent: "Edit Mask",
                    title: "Open the current canvas view in the mask editor",
                    onclick: () => {
                        canvas.startMaskEditor();
                    }
                }),
                $el("button.painter-button", {
                    id: "mask-mode-btn",
                    textContent: "Draw Mask",
                    title: "Toggle mask drawing mode",
                    onclick: () => {
                        const maskBtn = controlPanel.querySelector('#mask-mode-btn');
                        const maskControls = controlPanel.querySelector('#mask-controls');

                        if (canvas.maskTool.isActive) {
                            canvas.maskTool.deactivate();
                            maskBtn.classList.remove('primary');
                            maskControls.querySelectorAll('.mask-control').forEach(c => c.style.display = 'none');
                        } else {
                            canvas.maskTool.activate();
                            maskBtn.classList.add('primary');
                            maskControls.querySelectorAll('.mask-control').forEach(c => c.style.display = 'flex');
                        }

                        setTimeout(() => canvas.render(), 0);
                    }
                }),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-size-slider", textContent: "Size:"}),
                    $el("input", {
                        id: "brush-size-slider",
                        type: "range",
                        min: "1",
                        max: "200",
                        value: "20",
                        oninput: (e) => canvas.maskTool.setBrushSize(parseInt(e.target.value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-strength-slider", textContent: "Strength:"}),
                    $el("input", {
                        id: "brush-strength-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => canvas.maskTool.setBrushStrength(parseFloat(e.target.value))
                    })
                ]),
                $el("div.painter-slider-container.mask-control", {style: {display: 'none'}}, [
                    $el("label", {for: "brush-hardness-slider", textContent: "Hardness:"}),
                    $el("input", {
                        id: "brush-hardness-slider",
                        type: "range",
                        min: "0",
                        max: "1",
                        step: "0.05",
                        value: "0.5",
                        oninput: (e) => canvas.maskTool.setBrushHardness(parseFloat(e.target.value))
                    })
                ]),
                $el("button.painter-button.mask-control", {
                    textContent: "Clear Mask",
                    title: "Clear the entire mask",
                    style: {display: 'none'},
                    onclick: () => {
                        if (confirm("Are you sure you want to clear the mask?")) {
                            canvas.maskTool.clear();
                            canvas.render();
                        }
                    }
                })
            ]),

            $el("div.painter-separator"),
            $el("div.painter-button-group", {}, [
                $el("button.painter-button", {
                    textContent: "Run GC",
                    title: "Run Garbage Collection to clean unused images",
                    style: {backgroundColor: "#4a7c59", borderColor: "#3a6c49"},
                    onclick: async () => {
                        try {
                            const stats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats before cleanup:", stats);

                            await canvas.imageReferenceManager.manualGarbageCollection();

                            const newStats = canvas.imageReferenceManager.getStats();
                            log.info("GC Stats after cleanup:", newStats);

                            alert(`Garbage collection completed!\nTracked images: ${newStats.trackedImages}\nTotal references: ${newStats.totalReferences}\nOperations: ${canvas.imageReferenceManager.operationCount}/${canvas.imageReferenceManager.operationThreshold}`);
                        } catch (e) {
                            log.error("Failed to run garbage collection:", e);
                            alert("Error running garbage collection. Check the console for details.");
                        }
                    }
                }),
                $el("button.painter-button", {
                    textContent: "Clear Cache",
                    title: "Clear all saved canvas states from browser storage",
                    style: {backgroundColor: "#c54747", borderColor: "#a53737"},
                    onclick: async () => {
                        if (confirm("Are you sure you want to clear all saved canvas states? This action cannot be undone.")) {
                            try {
                                await clearAllCanvasStates();
                                alert("Canvas cache cleared successfully!");
                            } catch (e) {
                                log.error("Failed to clear canvas cache:", e);
                                alert("Error clearing canvas cache. Check the console for details.");
                            }
                        }
                    }
                })
            ])
        ]),
        $el("div.painter-separator")
    ]);


    const updateButtonStates = () => {
        const selectionCount = canvas.selectedLayers.length;
        const hasSelection = selectionCount > 0;
        controlPanel.querySelectorAll('.requires-selection').forEach(btn => {
            // Special handling for Fuse button - requires at least 2 layers
            if (btn.textContent === 'Fuse') {
                btn.disabled = selectionCount < 2;
            } else {
                btn.disabled = !hasSelection;
            }
        });
        const mattingBtn = controlPanel.querySelector('.matting-button');
        if (mattingBtn && !mattingBtn.classList.contains('loading')) {
            mattingBtn.disabled = selectionCount !== 1;
        }
    };

    canvas.onSelectionChange = updateButtonStates;

    const undoButton = controlPanel.querySelector(`#undo-button-${node.id}`);
    const redoButton = controlPanel.querySelector(`#redo-button-${node.id}`);

    canvas.onHistoryChange = ({canUndo, canRedo}) => {
        if (undoButton) undoButton.disabled = !canUndo;
        if (redoButton) redoButton.disabled = !canRedo;
    };

    updateButtonStates();
    canvas.updateHistoryButtons();


    const resizeObserver = new ResizeObserver((entries) => {
        const controlsHeight = entries[0].target.offsetHeight;
        canvasContainer.style.top = (controlsHeight + 10) + "px";
    });

    resizeObserver.observe(controlPanel.querySelector('.controls'));

    const triggerWidget = node.widgets.find(w => w.name === "trigger");

    const updateOutput = async () => {
        triggerWidget.value = (triggerWidget.value + 1) % 99999999;

        try {
            const new_preview = new Image();
            const blob = await canvas.getFlattenedCanvasWithMaskAsBlob();
            if (blob) {
                new_preview.src = URL.createObjectURL(blob);
                await new Promise(r => new_preview.onload = r);
                node.imgs = [new_preview];
            } else {
                node.imgs = [];
            }
        } catch (error) {
            console.error("Error updating node preview:", error);
        }

    };

    // Tworzenie panelu warstw
    const layersPanel = canvas.canvasLayersPanel.createPanelStructure();
    
    const canvasContainer = $el("div.painterCanvasContainer.painter-container", {
        style: {
            position: "absolute",
            top: "60px",
            left: "10px",
            right: "320px", // Zostawiamy miejsce na panel warstw
            bottom: "10px",
            overflow: "hidden"
        }
    }, [canvas.canvas]);

    // Kontener dla panelu warstw
    const layersPanelContainer = $el("div.painterLayersPanelContainer", {
        style: {
            position: "absolute",
            top: "60px",
            right: "10px",
            width: "300px",
            bottom: "10px",
            overflow: "hidden"
        }
    }, [layersPanel]);

    canvas.canvas.addEventListener('focus', () => {
        canvasContainer.classList.add('has-focus');
    });

    canvas.canvas.addEventListener('blur', () => {
        canvasContainer.classList.remove('has-focus');
    });


    node.onResize = function () {
        canvas.render();
    };


    const mainContainer = $el("div.painterMainContainer", {
        style: {
            position: "relative",
            width: "100%",
            height: "100%"
        }
    }, [controlPanel, canvasContainer, layersPanelContainer]);



    const mainWidget = node.addDOMWidget("mainContainer", "widget", mainContainer);

    node.size = [500, 500];

    const openEditorBtn = controlPanel.querySelector(`#open-editor-btn-${node.id}`);
    let backdrop = null;
    let modalContent = null;
    let originalParent = null;
    let isEditorOpen = false;

    const closeEditor = () => {
        originalParent.appendChild(mainContainer);
        document.body.removeChild(backdrop);

        isEditorOpen = false;
        openEditorBtn.textContent = "⛶";
        openEditorBtn.title = "Open in Editor";

        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };

    openEditorBtn.onclick = () => {
        if (isEditorOpen) {
            closeEditor();
            return;
        }

        originalParent = mainContainer.parentNode;
        if (!originalParent) {
            log.error("Could not find original parent of the canvas container!");
            return;
        }

        backdrop = $el("div.painter-modal-backdrop");
        modalContent = $el("div.painter-modal-content");

        modalContent.appendChild(mainContainer);
        backdrop.appendChild(modalContent);
        document.body.appendChild(backdrop);

        isEditorOpen = true;
        openEditorBtn.textContent = "X";
        openEditorBtn.title = "Close Editor";

        setTimeout(() => {
            canvas.render();
            if (node.onResize) {
                node.onResize();
            }
        }, 0);
    };
    if (!window.canvasExecutionStates) {
        window.canvasExecutionStates = new Map();
    }
    node.canvasWidget = canvas;

    setTimeout(() => {
        canvas.loadInitialState();
        // Renderuj panel warstw po załadowaniu stanu
        if (canvas.canvasLayersPanel) {
            canvas.canvasLayersPanel.renderLayers();
        }
    }, 100);

    const showPreviewWidget = node.widgets.find(w => w.name === "show_preview");
    if (showPreviewWidget) {
        const originalCallback = showPreviewWidget.callback;

        showPreviewWidget.callback = function (value) {
            if (originalCallback) {
                originalCallback.call(this, value);
            }

            if (canvas && canvas.setPreviewVisibility) {
                canvas.setPreviewVisibility(value);
            }

            if (node.graph && node.graph.canvas) {
                node.setDirtyCanvas(true, true);
            }
        };


    }


    return {
        canvas: canvas,
        panel: controlPanel
    };
}


const canvasNodeInstances = new Map();

app.registerExtension({
    name: "Comfy.CanvasNode",

    init() {

        const originalQueuePrompt = app.queuePrompt;
        app.queuePrompt = async function (number, prompt) {
            log.info("Preparing to queue prompt...");

            if (canvasNodeInstances.size > 0) {
                log.info(`Found ${canvasNodeInstances.size} CanvasNode(s). Sending data via WebSocket...`);

                const sendPromises = [];
                for (const [nodeId, canvasWidget] of canvasNodeInstances.entries()) {

                    if (app.graph.getNodeById(nodeId) && canvasWidget.canvas && canvasWidget.canvas.canvasIO) {
                        log.debug(`Sending data for canvas node ${nodeId}`);

                        sendPromises.push(canvasWidget.canvas.canvasIO.sendDataViaWebSocket(nodeId));
                    } else {

                        log.warn(`Node ${nodeId} not found in graph, removing from instances map.`);
                        canvasNodeInstances.delete(nodeId);
                    }
                }

                try {

                    await Promise.all(sendPromises);
                    log.info("All canvas data has been sent and acknowledged by the server.");
                } catch (error) {
                    log.error("Failed to send canvas data for one or more nodes. Aborting prompt.", error);


                    alert(`CanvasNode Error: ${error.message}`);
                    return; // Stop execution
                }
            }

            log.info("All pre-prompt tasks complete. Proceeding with original queuePrompt.");

            return originalQueuePrompt.apply(this, arguments);
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType.comfyClass === "CanvasNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                log.debug("CanvasNode onNodeCreated: Base widget setup.");

                const r = onNodeCreated?.apply(this, arguments);

                return r;
            };

            nodeType.prototype.onAdded = async function () {
                log.info(`CanvasNode onAdded, ID: ${this.id}`);
                log.debug(`Available widgets in onAdded:`, this.widgets.map(w => w.name));

                if (this.canvasWidget) {
                    log.warn(`CanvasNode ${this.id} already initialized. Skipping onAdded setup.`);
                    return;
                }

                this.widgets.forEach(w => {
                    log.debug(`Widget name: ${w.name}, type: ${w.type}, value: ${w.value}`);
                });

                const nodeIdWidget = this.widgets.find(w => w.name === "node_id");
                if (nodeIdWidget) {
                    nodeIdWidget.value = String(this.id);
                    log.debug(`Set hidden node_id widget to: ${nodeIdWidget.value}`);
                } else {
                    log.error("Could not find the hidden node_id widget!");
                }


                const canvasWidget = await createCanvasWidget(this, null, app);
                canvasNodeInstances.set(this.id, canvasWidget);
                log.info(`Registered CanvasNode instance for ID: ${this.id}`);
            };

            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                log.info(`Cleaning up canvas node ${this.id}`);

                canvasNodeInstances.delete(this.id);
                log.info(`Deregistered CanvasNode instance for ID: ${this.id}`);

                if (window.canvasExecutionStates) {
                    window.canvasExecutionStates.delete(this.id);
                }

                const tooltip = document.getElementById(`painter-help-tooltip-${this.id}`);
                if (tooltip) {
                    tooltip.remove();
                }
                const backdrop = document.querySelector('.painter-modal-backdrop');
                if (backdrop && backdrop.contains(this.canvasWidget?.canvas)) {
                    document.body.removeChild(backdrop);
                }

                if (this.canvasWidget && this.canvasWidget.destroy) {
                    this.canvasWidget.destroy();
                }

                return onRemoved?.apply(this, arguments);
            };


            const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                originalGetExtraMenuOptions?.apply(this, arguments);

                const self = this;

                const maskEditorIndex = options.findIndex(option =>
                    option && option.content === "Open in MaskEditor"
                );
                if (maskEditorIndex !== -1) {
                    options.splice(maskEditorIndex, 1);
                }

                const newOptions = [
                    {
                        content: "Open in MaskEditor",
                        callback: async () => {
                            try {
                                log.info("Opening LayerForge canvas in MaskEditor");
                                if (self.canvasWidget && self.canvasWidget.startMaskEditor) {
                                    await self.canvasWidget.startMaskEditor();
                                } else {
                                    log.error("Canvas widget not available");
                                    alert("Canvas not ready. Please try again.");
                                }
                            } catch (e) {
                                log.error("Error opening MaskEditor:", e);
                                alert(`Failed to open MaskEditor: ${e.message}`);
                            }
                        },
                    },
                    {
                        content: "Open Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error opening image:", e);
                            }
                        },
                    },
                    {
                        content: "Open Image with Mask Alpha",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error opening image with mask:", e);
                            }
                        },
                    },
                    {
                        content: "Copy Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const item = new ClipboardItem({'image/png': blob});
                                await navigator.clipboard.write([item]);
                                log.info("Image copied to clipboard.");
                            } catch (e) {
                                log.error("Error copying image:", e);
                                alert("Failed to copy image to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Copy Image with Mask Alpha",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                const item = new ClipboardItem({'image/png': blob});
                                await navigator.clipboard.write([item]);
                                log.info("Image with mask alpha copied to clipboard.");
                            } catch (e) {
                                log.error("Error copying image with mask:", e);
                                alert("Failed to copy image with mask to clipboard.");
                            }
                        },
                    },
                    {
                        content: "Save Image",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasAsBlob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error saving image:", e);
                            }
                        },
                    },
                    {
                        content: "Save Image with Mask Alpha",
                        callback: async () => {
                            try {
                                const blob = await self.canvasWidget.getFlattenedCanvasWithMaskAsBlob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'canvas_output_with_mask.png';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch (e) {
                                log.error("Error saving image with mask:", e);
                            }
                        },
                    },
                ];
                if (options.length > 0) {
                    options.unshift({content: "___", disabled: true});
                }
                options.unshift(...newOptions);
            };
        }
    }
});

async function handleImportInput(data) {
    if (data && data.image) {
        const imageData = data.image;
        await importImage(imageData);
    }
}
