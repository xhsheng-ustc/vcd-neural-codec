const SIZES = {360: [640, 360], 540: [960, 540],
  720: [1280, 720], 1080: [1920, 1080]};
const $ = id => document.getElementById(id);
const params = new URL(location.href).searchParams;
const resolution = SIZES[params.get('resolution')] ? Number(params.get('resolution')) : 360;
const [WIDTH, HEIGHT] = SIZES[resolution];
const input = $('input-view'), output = $('output-view');
input.width = output.width = WIDTH;
input.height = output.height = HEIGHT;
const inputCtx = input.getContext('2d', {willReadFrequently: true});
const outputCtx = output.getContext('2d');
const camera = $('camera');
const worker = new Worker('./src/codec.worker.js', {type: 'module'});
let ready = false, busy = false, cameraStream = null, cameraTimer = null;
let totalBytes = 0, captureStartedAt = 0, lastFrameAt = 0;

$('resolution').value = String(resolution);
$('source-size').textContent = `SOURCE · ${WIDTH} × ${HEIGHT}`;
$('decoded-size').textContent = `DECODED · ${WIDTH} × ${HEIGHT}`;

function status(message, kind = '') {
  $('status').textContent = message;
  $('dot').className = `dot ${kind}`;
}

function setButtons() {
  $('camera-start').disabled = !ready || Boolean(cameraStream);
  $('camera-stop').disabled = !cameraStream;
  $('backend').disabled = Boolean(cameraStream);
  $('resolution').disabled = Boolean(cameraStream);
}

function sendFrame(rgba) {
  if (!ready || busy) return;
  busy = true;
  const data = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  worker.postMessage({type: 'frame', rgba: data, qpi: $('qpi').value,
    qpp: $('qpp').value, intraPeriod: $('period').value}, [data]);
}

function captureCamera() {
  if (!cameraStream || busy || !ready || camera.readyState < 2) return;
  inputCtx.drawImage(camera, 0, 0, WIDTH, HEIGHT);
  sendFrame(inputCtx.getImageData(0, 0, WIDTH, HEIGHT).data);
}

function updateMetrics(message) {
  const now = performance.now();
  totalBytes += message.bytes;
  const elapsedSeconds = Math.max((now - captureStartedAt) / 1000, 0.001);
  $('bitrate').textContent = (totalBytes * 8 / elapsedSeconds / 1000).toFixed(1);
  $('fps').textContent = lastFrameAt ? (1000 / (now - lastFrameAt)).toFixed(2) : '—';
  lastFrameAt = now;
  $('encode-time').textContent = message.encodeMs.toFixed(0);
  $('decode-time').textContent = message.decodeMs.toFixed(0);
  $('frame-size').textContent = String(message.bytes);
  $('psnr').textContent = Number.isFinite(message.psnr) ? message.psnr.toFixed(2) : '∞';
  $('frame-tag').textContent = `${message.frameType} frame · #${message.frameNumber} · ${message.backend.toUpperCase()}`;
}

worker.onmessage = event => {
  const message = event.data;
  if (message.type === 'progress') { status(`Loading model: ${message.message}`); return; }
  if (message.type === 'ready') {
    ready = true; busy = false;
    $('backend').value = message.backend;
    status(`Ready · ${message.backend === 'webgpu' ? 'GPU / WebGPU' : 'CPU / WASM'}`, 'ready');
    setButtons();
    return;
  }
  if (message.type === 'error') {
    busy = false;
    status(`Error: ${message.message.split('\n')[0]}`, 'error');
    console.error(message.message);
    setButtons();
    return;
  }
  if (message.type === 'frame') {
    outputCtx.putImageData(new ImageData(new Uint8ClampedArray(message.rgba), WIDTH, HEIGHT), 0, 0);
    updateMetrics(message);
    busy = false;
    status(cameraStream ? 'Encoding and decoding camera video' : 'Camera stopped', 'ready');
  }
};

$('camera-start').onclick = async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({audio: false,
      video: {width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 30}}});
    camera.srcObject = cameraStream;
    await camera.play();
    const settings = cameraStream.getVideoTracks()[0].getSettings();
    $('source-tag').textContent = `Camera ${settings.width || ''} × ${settings.height || ''}`;
    worker.postMessage({type: 'forceI'});
    totalBytes = captureStartedAt = lastFrameAt = 0;
    captureStartedAt = performance.now();
    cameraTimer = setInterval(captureCamera, 33);
    status('Camera active', 'ready');
    setButtons();
  } catch (error) {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    status(`Camera unavailable: ${error.message}`, 'error');
    setButtons();
  }
};

$('camera-stop').onclick = () => {
  clearInterval(cameraTimer);
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  camera.srcObject = null;
  $('source-tag').textContent = 'Camera off';
  status('Camera stopped', 'ready');
  setButtons();
};

function reloadWith(name, value) {
  const url = new URL(location.href);
  url.searchParams.set(name, value);
  location.href = url.href;
}
$('backend').onchange = () => reloadWith('backend', $('backend').value);
$('resolution').onchange = () => reloadWith('resolution', $('resolution').value);
for (const name of ['qpi', 'qpp']) {
  $(name).oninput = () => $(`${name}-value`).textContent = $(name).value;
}

setButtons();
const initialBackend = params.get('backend') || (navigator.gpu ? 'webgpu' : 'wasm');
$('backend').value = initialBackend;
worker.postMessage({type: 'init', backend: initialBackend, resolution});
