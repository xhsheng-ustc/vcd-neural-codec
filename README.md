# VCD neural video codec

Run the VCD video codec directly in your browser: capture camera video, encode
I/P frames, transmit the resulting bitstream through a local loopback, and
display the decoded video.

**[Open the browser demo](https://xhsheng-ustc.github.io/vcd-neural-codec/)**

Choose 360p, 540p, 720p, or 1080p and run on WebGPU or CPU/WebAssembly.
Adjust I-frame QP, P-frame QP, and the I-frame interval in the page.
CBR mode, Y/U/V PSNR, and side-by-side comparisons with H.264, HEVC, AV1,
VP8, and MLVC are also available where the browser supports them.

ONNX Runtime Web is distributed under the MIT license in
[`vendor/ort/LICENSE`](vendor/ort/LICENSE).
