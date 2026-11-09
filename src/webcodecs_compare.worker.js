import {rgbaToYuv444, yuv420Psnr} from './color.js';

const CANDIDATES = {
  h264: ['avc1.640028', 'avc1.4d4028', 'avc1.42e028'],
  hevc: ['hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0'],
  av1: ['av01.0.08M.08', 'av01.0.04M.08'],
  vp8: ['vp8'],
};

let encoder = null;
let decoder = null;
let codecName = '';
let codecId = '';
let width = 0;
let height = 0;
let targetKbps = 300;
let sourceFrames = new Map();
let frameCount = 0;
let totalBits = 0;
let decodedCount = 0;
let decodedBits = 0;
let bitsByTimestamp = new Map();
let canvas;
let context;
let sourceCanvas;
let sourceContext;

function close() {
  try { encoder?.close(); } catch {}
  try { decoder?.close(); } catch {}
  encoder = decoder = null;
  sourceFrames.clear();
  bitsByTimestamp.clear();
}

async function chooseCodec(name, kbps) {
  if (!globalThis.VideoEncoder || !globalThis.VideoDecoder) {
    throw new Error('WebCodecs video encoding is unavailable in this browser');
  }
  for (const codec of CANDIDATES[name] || []) {
    const config = {codec, width, height, bitrate: kbps * 1000,
                    framerate: 30, latencyMode: 'realtime'};
    if (name === 'h264') config.avc = {format: 'annexb'};
    try {
      const enc = await VideoEncoder.isConfigSupported(config);
      const dec = await VideoDecoder.isConfigSupported({codec, codedWidth: width,
                                                       codedHeight: height});
      if (enc.supported && dec.supported) return {codec, config: enc.config};
    } catch {}
  }
  throw new Error(`${name.toUpperCase()} encoding/decoding is not supported here`);
}

async function outputFrame(frame) {
  try {
    const original = sourceFrames.get(frame.timestamp);
    if (!original) return;
    sourceFrames.delete(frame.timestamp);
    decodedBits += bitsByTimestamp.get(frame.timestamp) || 0;
    bitsByTimestamp.delete(frame.timestamp);
    context.drawImage(frame, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const a = rgbaToYuv444(original, width, height, height);
    const b = rgbaToYuv444(rgba, width, height, height);
    const [psnrY, psnrU, psnrV] = yuv420Psnr(a, b, width, height);
    decodedCount++;
    const result = new Uint8ClampedArray(rgba);
    self.postMessage({type: 'frame', codec: codecName, rgba: result.buffer,
      bits: decodedBits, frames: decodedCount, targetKbps,
      actualKbps: decodedBits * 30 / decodedCount / 1000,
      psnrY, psnrU, psnrV}, [result.buffer]);
  } catch (error) {
    self.postMessage({type: 'error', message: error.message || String(error)});
  } finally { frame.close(); }
}

self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'stop') { close(); return; }
    if (message.type === 'init') {
      close();
      codecName = message.codec;
      width = message.width;
      height = message.height;
      targetKbps = message.targetKbps;
      totalBits = decodedBits = decodedCount = frameCount = 0;
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d', {willReadFrequently: true});
      sourceCanvas = new OffscreenCanvas(width, height);
      sourceContext = sourceCanvas.getContext('2d');
      const selected = await chooseCodec(codecName, targetKbps);
      codecId = selected.codec;
      decoder = new VideoDecoder({output: outputFrame,
        error: error => self.postMessage({type: 'error', message: String(error)})});
      encoder = new VideoEncoder({output: (chunk, metadata) => {
        try {
          if (metadata?.decoderConfig) decoder.configure(metadata.decoderConfig);
          else if (decoder.state === 'unconfigured') decoder.configure({codec: codecId,
            codedWidth: width, codedHeight: height});
          totalBits += chunk.byteLength * 8;
          bitsByTimestamp.set(chunk.timestamp, (bitsByTimestamp.get(chunk.timestamp) || 0) +
            chunk.byteLength * 8);
          decoder.decode(chunk);
        } catch (error) {
          self.postMessage({type: 'error', message: error.message || String(error)});
        }
      }, error: error => self.postMessage({type: 'error', message: String(error)})});
      encoder.configure(selected.config);
      self.postMessage({type: 'ready', codec: codecName, codecId});
      return;
    }
    if (message.type === 'target' && encoder) {
      const next = Math.min(20000, Math.max(25, Number(message.targetKbps) || 300));
      if (Math.abs(next - targetKbps) / targetKbps > 0.15) {
        const selected = await chooseCodec(codecName, next);
        encoder.configure(selected.config);
        targetKbps = next;
      }
      return;
    }
    if (message.type === 'frame' && encoder) {
      if (encoder.encodeQueueSize > 2) {
        self.postMessage({type: 'skipped'});
        return;
      }
      const rgba = new Uint8ClampedArray(message.rgba);
      const timestamp = message.frameId * 33333;
      sourceFrames.set(timestamp, rgba);
      if (sourceFrames.size > 32) sourceFrames.delete(sourceFrames.keys().next().value);
      const image = new ImageData(rgba, width, height);
      sourceContext.putImageData(image, 0, 0);
      const frame = new VideoFrame(sourceCanvas, {timestamp});
      encoder.encode(frame, {keyFrame: frameCount % 30 === 0});
      frame.close();
      frameCount++;
    }
  } catch (error) {
    self.postMessage({type: 'error', message: error.message || String(error)});
  }
};
