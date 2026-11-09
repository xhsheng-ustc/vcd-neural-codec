const SIZES = {360: [640, 360], 540: [960, 540],
  720: [1280, 720], 1080: [1920, 1080]};
const $ = id => document.getElementById(id);
const params = new URL(location.href).searchParams;
const resolution = SIZES[params.get('resolution')] ? Number(params.get('resolution')) : 540;
const [WIDTH, HEIGHT] = SIZES[resolution];
const input = $('input-view'), output = $('output-view');
input.width = output.width = WIDTH;
input.height = output.height = HEIGHT;
const inputCtx = input.getContext('2d', {willReadFrequently: true});
const outputCtx = output.getContext('2d');
const comparisonView = $('comparison-view');
comparisonView.width = WIDTH;
comparisonView.height = HEIGHT;
const comparisonCtx = comparisonView.getContext('2d');
const camera = $('camera');
const worker = new Worker('./src/codec.worker.js', {type: 'module'});
let ready = false, busy = false, cameraStream = null, cameraTimer = null;
let totalBytes = 0, totalFrames = 0, captureStartedAt = 0, lastFrameAt = 0;
let compareWorker = null, compareReady = false, compareBusy = false;
let compareFrameId = 0, compareTarget = 300;
let compareBackend = '';

$('resolution').value = String(resolution);
$('source-size').textContent = `SOURCE · ${WIDTH} × ${HEIGHT}`;
$('decoded-size').textContent = `DECODED · ${WIDTH} × ${HEIGHT}`;
$('comparison-size').textContent = `COMPARISON · ${WIDTH} × ${HEIGHT}`;

function rateTarget() {
  if ($('rate-mode').value === 'cbr') {
    return Math.min(20000, Math.max(25, Number($('target-kbps').value) || 100));
  }
  return Math.min(20000, Math.max(25, Number($('bitrate-30').textContent) || 300));
}

function formatPsnr(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

function resetStatistics() {
  totalBytes = totalFrames = lastFrameAt = 0;
  captureStartedAt = performance.now();
  for (const id of ['bitrate', 'bitrate-30', 'fps', 'encode-time', 'decode-time',
                     'frame-size', 'psnr-y', 'psnr-u', 'psnr-v', 'frame-qp',
                     'target-actual']) $(id).textContent = '—';
  $('rate-limit-note').textContent = '';
}

function setComparison() {
  compareWorker?.terminate();
  compareWorker = null;
  compareReady = compareBusy = false;
  compareBackend = '';
  compareFrameId = 0;
  const codec = $('compare-codec').value;
  const active = Boolean(codec);
  $('comparison-card').classList.toggle('hidden', !active);
  $('comparison-metrics').classList.toggle('hidden', !active);
  document.querySelector('.video-grid').classList.toggle('comparing', active);
  if (!active) return;
  const label = $('compare-codec').selectedOptions[0].textContent;
  $('comparison-title').textContent = label;
  $('comparison-metrics-title').textContent = `${label} · live statistics`;
  $('compare-status').textContent = 'Loading';
  $('comparison-note').textContent = '';
  for (const id of ['compare-target-actual', 'compare-psnr-y',
                     'compare-psnr-u', 'compare-psnr-v', 'compare-qp']) $(id).textContent = '—';
  comparisonCtx.clearRect(0, 0, WIDTH, HEIGHT);
  compareTarget = rateTarget();
  const workerPath = codec === 'mlvc' ? './src/mlvc_compare.worker.js'
    : './src/webcodecs_compare.worker.js';
  compareWorker = new Worker(workerPath, {type: 'module'});
  const thisWorker = compareWorker;
  thisWorker.onmessage = event => {
    if (thisWorker !== compareWorker) return;
    const message = event.data;
    if (message.type === 'ready') {
      compareReady = true;
      compareBusy = false;
      compareBackend = message.backend
        ? (message.backend === 'wasm' ? 'CPU / WASM' : message.backend.toUpperCase())
        : codec === 'mlvc' ? compareBackend : 'WEBCODECS';
      $('compare-status').textContent = 'Ready';
      $('comparison-note').textContent = message.note || '';
    } else if (message.type === 'frame') {
      compareBusy = false;
      comparisonCtx.putImageData(new ImageData(
        new Uint8ClampedArray(message.rgba), WIDTH, HEIGHT), 0, 0);
      $('compare-status').textContent = `Frame ${message.frames} · ${compareBackend}`;
      $('compare-target-actual').textContent =
        `${message.targetKbps.toFixed(0)} / ${message.actualKbps.toFixed(1)}`;
      $('compare-psnr-y').textContent = formatPsnr(message.psnrY);
      $('compare-psnr-u').textContent = formatPsnr(message.psnrU);
      $('compare-psnr-v').textContent = formatPsnr(message.psnrV);
      $('compare-qp').textContent = Number.isInteger(message.qp)
        ? String(message.qp) : (message.rateMode === 'constant' ? 'Browser CBR' : 'Browser VBR');
      $('compare-qp-label').textContent = message.codec === 'mlvc'
        ? 'MLVC q-index' : 'Encoder QP / mode';
    } else if (message.type === 'skipped') {
      compareBusy = false;
    } else if (message.type === 'error') {
      compareBusy = false;
      $('compare-status').textContent = 'Unavailable';
      $('comparison-note').textContent = message.message.split('\n')[0];
      console.error(message.message);
    }
  };
  thisWorker.onerror = event => {
    if (thisWorker === compareWorker) {
      compareBusy = false;
      $('compare-status').textContent = 'Unavailable';
      $('comparison-note').textContent = event.message;
    }
  };
  thisWorker.postMessage({type: 'init', codec, width: WIDTH, height: HEIGHT,
    resolution, backend: $('backend').value, intraPeriod: Number($('period').value),
    targetKbps: compareTarget});
}

function resetComparison() {
  if (!compareWorker || !compareReady) return;
  compareReady = compareBusy = false;
  compareFrameId = 0;
  compareTarget = rateTarget();
  for (const id of ['compare-target-actual', 'compare-psnr-y',
                     'compare-psnr-u', 'compare-psnr-v', 'compare-qp']) $(id).textContent = '—';
  compareWorker.postMessage($('compare-codec').value === 'mlvc'
    ? {type: 'reset'} : {type: 'init', codec: $('compare-codec').value,
      width: WIDTH, height: HEIGHT, targetKbps: compareTarget});
}

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
  const mlvcCompare = $('compare-codec').value === 'mlvc';
  if (compareWorker && compareReady && (!mlvcCompare || !compareBusy)) {
    const comparisonData = data.slice(0);
    if (mlvcCompare) compareBusy = true;
    compareWorker.postMessage({type: 'frame', rgba: comparisonData,
      width: WIDTH, height: HEIGHT, frameId: compareFrameId++}, [comparisonData]);
  }
  worker.postMessage({type: 'frame', rgba: data, qpi: $('qpi').value,
    qpp: $('qpp').value, intraPeriod: $('period').value,
    mode: $('rate-mode').value, targetKbps: rateTarget()}, [data]);
}

function captureCamera() {
  if (!cameraStream || busy || !ready || camera.readyState < 2) return;
  inputCtx.drawImage(camera, 0, 0, WIDTH, HEIGHT);
  sendFrame(inputCtx.getImageData(0, 0, WIDTH, HEIGHT).data);
}

function updateMetrics(message) {
  const now = performance.now();
  totalBytes += message.bytes;
  totalFrames++;
  const elapsedSeconds = Math.max((now - captureStartedAt) / 1000, 0.001);
  $('bitrate').textContent = (totalBytes * 8 / elapsedSeconds / 1000).toFixed(1);
  $('bitrate-30').textContent = (totalBytes * 8 * 30 / totalFrames / 1000).toFixed(1);
  $('target-actual').textContent = `${$('rate-mode').value === 'cbr'
    ? rateTarget().toFixed(0) : '—'} / ${$('bitrate-30').textContent}`;
  $('fps').textContent = lastFrameAt ? (1000 / (now - lastFrameAt)).toFixed(2) : '—';
  lastFrameAt = now;
  $('encode-time').textContent = message.encodeMs.toFixed(0);
  $('decode-time').textContent = message.decodeMs.toFixed(0);
  $('frame-size').textContent = String(message.bytes);
  $('psnr-y').textContent = formatPsnr(message.psnrY);
  $('psnr-u').textContent = formatPsnr(message.psnrU);
  $('psnr-v').textContent = formatPsnr(message.psnrV);
  $('frame-qp').textContent = `${message.frameType} · ${message.qp}`;
  const actual = Number($('bitrate-30').textContent);
  const target = rateTarget();
  $('rate-limit-note').textContent = $('rate-mode').value === 'cbr' &&
    totalFrames >= 10 && message.frameType === 'P' &&
    ((message.qp === 63 && actual < target * 0.7) ||
     (message.qp === 0 && actual > target * 1.3))
    ? 'Target cannot be reached for this scene within the available QP range.' : '';
  $('frame-tag').textContent = `${message.frameType} frame · #${message.frameNumber} · ${message.backend.toUpperCase()}`;
  if (compareWorker && compareReady && $('rate-mode').value === 'cq') {
    const next = rateTarget();
    if (Math.abs(next - compareTarget) / compareTarget > 0.15) {
      compareTarget = next;
      compareWorker.postMessage({type: 'target', targetKbps: compareTarget});
    }
  }
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
    resetStatistics();
    if ($('compare-codec').value) {
      if (compareWorker) resetComparison();
      else setComparison();
    }
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
function updateRateControls() {
  const cbr = $('rate-mode').value === 'cbr';
  $('target-setting').classList.toggle('hidden', !cbr);
  $('qpi-setting').classList.toggle('hidden', cbr);
  $('qpp-setting').classList.toggle('hidden', cbr);
  resetStatistics();
  if (compareWorker) {
    compareTarget = rateTarget();
    compareWorker.postMessage({type: 'target', targetKbps: compareTarget});
  }
}
$('rate-mode').onchange = updateRateControls;
$('target-kbps').onchange = updateRateControls;
$('compare-codec').onchange = setComparison;
$('period').onchange = () => compareWorker?.postMessage({
  type: 'period', intraPeriod: Number($('period').value)});
for (const name of ['qpi', 'qpp']) {
  $(name).oninput = () => $(`${name}-value`).textContent = $(name).value;
}

setButtons();
const initialBackend = params.get('backend') || 'webgpu';
$('backend').value = initialBackend;
worker.postMessage({type: 'init', backend: initialBackend, resolution});
