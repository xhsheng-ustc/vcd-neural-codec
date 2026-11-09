import * as ort from '../vendor/ort/ort.all.mjs';
import {IFrameCodec} from './iframe.js';
import {PFrameCodec} from './pframe.js';
import {rgbaToYuv444, yuv444ToRgba, yuv420Psnr} from './color.js';
import {RateController} from './rate_control.js';

const SIZES = {360: [640, 360, 384], 540: [960, 540, 576],
  720: [1280, 720, 768], 1080: [1920, 1080, 1088]};
let width = 640;
let height = 360;
let modelHeight = 384;
const BASE = new URL('../models/dynamic', import.meta.url).href;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let iEncoder, iDecoder, pEncoder, pDecoder;
let backend = 'wasm';
let frameNumber = 0;
let previousQpi = 63;
let previousQpp = 63;
let forceI = true;
let rateController = null;
let previousMode = 'cq';

function log(message) { self.postMessage({type: 'progress', message}); }

async function initialize(requested, resolution) {
  if (!SIZES[resolution]) throw new Error('Unsupported resolution');
  [width, height, modelHeight] = SIZES[resolution];
  backend = requested;
  const runtimeFile = 'ort-wasm-simd-threaded.jsep.wasm';
  const runtimeUrl = new URL(`../vendor/ort/${runtimeFile}`, import.meta.url);
  const compressed = await fetch(`${runtimeUrl}.gz`);
  if (compressed.ok) {
    ort.env.wasm.wasmBinary = new Uint8Array(await new Response(
      compressed.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  try {
    const i = await IFrameCodec.load(ort, BASE, 63, backend, log);
    const p = await PFrameCodec.load(ort, BASE, 63, backend, log);
    iEncoder = i;
    iDecoder = new IFrameCodec(ort, i.sessions, i.runtime, 63);
    pEncoder = p;
    pDecoder = new PFrameCodec(ort, p.sessions, p.runtime, 63);
  } catch (error) {
    if (requested !== 'webgpu') throw error;
    log(`WebGPU failed; switching to CPU: ${error.message}`);
    backend = 'wasm';
    const i = await IFrameCodec.load(ort, BASE, 63, backend, log);
    const p = await PFrameCodec.load(ort, BASE, 63, backend, log);
    iEncoder = i;
    iDecoder = new IFrameCodec(ort, i.sessions, i.runtime, 63);
    pEncoder = p;
    pDecoder = new PFrameCodec(ort, p.sessions, p.runtime, 63);
  }
  frameNumber = 0;
  forceI = true;
  rateController = null;
  previousMode = 'cq';
  self.postMessage({type: 'ready', backend, width, height, resolution});
}

async function processFrame(message) {
  const period = Math.max(1, Math.floor(Number(message.intraPeriod) || 150));
  const mode = message.mode === 'cbr' ? 'cbr' : 'cq';
  if (mode !== previousMode) {
    rateController = null;
    previousMode = mode;
    forceI = true;
  }
  if (mode === 'cbr') {
    const target = Math.min(20000, Math.max(25, Number(message.targetKbps) || 100));
    if (!rateController || rateController.targetKbps !== target) {
      rateController = new RateController(target, previousQpi, previousQpp);
      forceI = true;
    }
  }
  const qpi = mode === 'cbr' ? rateController.choose(true)
    : Math.min(63, Math.max(0, Number(message.qpi) || 0));
  const qpp = mode === 'cbr' ? rateController.choose(false)
    : Math.min(63, Math.max(0, Number(message.qpp) || 0));
  if (qpi !== previousQpi || qpp !== previousQpp) {
    if (qpi !== previousQpi) {
      iEncoder = new IFrameCodec(ort, iEncoder.sessions, iEncoder.runtime, qpi);
      iDecoder = new IFrameCodec(ort, iDecoder.sessions, iDecoder.runtime, qpi);
    }
    pEncoder.setQp(qpp);
    pDecoder.setQp(qpp);
    previousQpi = qpi;
    previousQpp = qpp;
    if (mode === 'cq') forceI = true;
  }
  const isI = forceI || frameNumber % period === 0;
  const input = rgbaToYuv444(new Uint8ClampedArray(message.rgba), width, height, modelHeight);
  const start = performance.now();
  const encoded = isI ? await iEncoder.encode(input) : await pEncoder.encode(input);
  const encodedAt = performance.now();
  // The Uint8Array is the real rANS bitstream. Decode only from these bytes.
  const decoded = isI
    ? await iDecoder.decode(encoded.stream, modelHeight, width)
    : await pDecoder.decode(encoded.stream, modelHeight, width);
  const decodedAt = performance.now();
  if (isI) {
    pEncoder.setReference(decoded.reconstructed);
    pDecoder.setReference(decoded.reconstructed);
  }
  const rgba = yuv444ToRgba(decoded.reconstructed, width, height);
  const psnr = yuv420Psnr(input, decoded.reconstructed, width, height);
  if (rateController) rateController.update(isI, period, encoded.stream.length * 8);
  frameNumber++;
  forceI = false;
  self.postMessage({type: 'frame', rgba: rgba.buffer, frameType: isI ? 'I' : 'P',
    bytes: encoded.stream.length, encodeMs: encodedAt - start,
    decodeMs: decodedAt - encodedAt, psnrY: psnr[0], psnrU: psnr[1], psnrV: psnr[2],
    frameNumber, backend, width, height, qp: isI ? qpi : qpp}, [rgba.buffer]);
}

self.onmessage = async event => {
  try {
    const message = event.data;
    if (message.type === 'init') await initialize(message.backend, message.resolution);
    if (message.type === 'frame') await processFrame(message);
    if (message.type === 'forceI') forceI = true;
  } catch (error) {
    self.postMessage({type: 'error', message: error.stack || String(error)});
  }
};
