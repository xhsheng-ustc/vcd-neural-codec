# VCD neural video codec in the browser

This static site runs the VCD neural I/P-frame codec entirely in the browser:
camera capture → YUV conversion → ONNX Runtime Web inference → rANS bitstream →
bitstream decoding → reconstructed video. It uses the models derived from
`cvpr2025_image.pth.tar` and `ckpt_epo8.pth.tar`.

## Demo

Once GitHub Pages is enabled for this repository, open
`https://xhsheng-ustc.github.io/vcd-neural-codec/` in recent Edge or Chrome.
Allow camera access, choose a resolution and compute device, then select
**Start camera**. The page supports 360p, 540p, 720p, and 1080p with one shared
set of spatially dynamic ONNX models. It offers GPU/WebGPU and CPU/WebAssembly.

This is a local codec loopback demonstration. It does not connect two browsers
for a video call. Higher resolutions may run slower than the camera frame rate.

## Loading and size

The site contains roughly 215 MiB of files. The I/P codec has 21 ONNX
submodels, which are downloaded and initialized when the page opens. Models
and the ONNX Runtime Web WASM binary are stored as lossless gzip assets and
decompressed in browser memory. Downloads are concurrent; subsequent visits
can use the browser's HTTP cache. The large model set makes first load slower
than codecs with smaller networks.

## Local use

Serve this directory over HTTP, for example:

```sh
python -m http.server 8000
```

Open `http://localhost:8000/`. Browser camera permission requires HTTPS or
localhost.

## Deployment

Publish this repository from the `main` branch, root (`/`) folder in
**Settings → Pages**. The `.nojekyll` file prevents Jekyll processing. All
required assets are tracked as ordinary Git files; Git LFS is not used because
GitHub Pages cannot serve LFS assets directly.

ONNX Runtime Web is distributed under the MIT license in
[`vendor/ort/LICENSE`](vendor/ort/LICENSE).
