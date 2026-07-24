# SoftBench Renderer

PS1-style fixed-point software rasterizer plugin for [Blockbench](https://www.blockbench.net/).

Replaces the WebGL viewport with a retro software-rendered view featuring authentic PlayStation 1 aesthetic.

## Features

- **Fixed-point half-space triangle rasterization** with a 640x400 default resolution and pixel-perfect CSS upscale
- **Bayer 4x4 dithering** for smooth fog and color banding
- **Per-pixel distance fog** with configurable near/far range
- **15-bit color quantization** (5 bits per channel) for authentic PS1 color banding
- **Flat shading** with directional face lighting
- **Nearest-neighbor texture sampling** with face UV support
- **Near-plane clipping** (Sutherland-Hodgman algorithm)
- **Full hierarchical group transforms** via Three.js `matrixWorld`
- **Support for cubes, meshes, and billboards**
- **Selection, move, rotate, and scale** with undo/redo
- **Software raycasting** for click-to-select
- **Transform gizmo** rendering in move, rotate, and scale modes

## Installation

1. Open Blockbench (desktop, v4.8.0+)
2. Go to **File > Plugins > Search Online**
3. Search for **Softbench Renderer** and install it

Or manually copy `softbench_renderer.js` into your Blockbench plugins folder.

## Usage

Toggle the software renderer with:

- **Ctrl+Shift+P**
- **View > Software Renderer**

### Camera Controls

| Input | Action |
|-------|--------|
| **Left-click drag** | Orbit |
| **Right-click drag** | Pan |
| **Scroll wheel** | Zoom |
| **W/A/S/D** | Move forward/left/back/right |
| **R/F** | Move up/down |

### Edit Mode

| Key | Action |
|-----|--------|
| **G** | Switch to Move mode |
| **E** | Switch to Rotate mode |
| **T** | Switch to Scale mode |
| **Escape** | Deselect and return to Orbit mode |
| **Delete/Backspace** | Delete selected element |
| **H** | Toggle element visibility |
| **Ctrl+Z** | Undo |
| **Ctrl+Shift+Z** | Redo |
| **Left-click** | Select element (in Orbit mode) |

## License

Public domain ([Unlicense](https://unlicense.org)). See [SoftBench/LICENSE](SoftBench/LICENSE).
