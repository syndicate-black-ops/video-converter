// Page logic: read the chosen file with ffmpeg.wasm, convert it to Ogg Theora + Vorbis (.ogv) or Vorbis (.ogg) with
// the same ffmpeg command as the docs' "Making a video file", show progress, and offer the result as a download.
// A preview encodes short samples with the same command in their own ffmpeg instances, for stills and a size estimate.
import { FFmpeg } from './vendor/ffmpeg/index.js';

const CORE_URL = new URL('vendor/core/ffmpeg-core.js', location.href).href;
const WASM_URL = new URL('vendor/core/ffmpeg-core.wasm', location.href).href;

// Game limits (docs Video page, "Video files") and the download limit a server sends by itself
const MAX_SIZE = 2048;
const MAX_FPS = 240;
const MAX_BYTES = 128 * 1024 * 1024;
const SERVER_SEND_BYTES = 10 * 1024 * 1024;
// Approximate Vorbis bitrates (kbit/s, 44100 Hz stereo) for -q:a 0..10, for the size estimate
const VORBIS_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500];
// Share of the work in pass 1 (measure only) and pass 2 (writes the file)
const PASS1_SHARE = 0.4;
// ?debug in the address writes ffmpeg's log to the browser console; ?debug=av1 also lets an AV1 video run (and fail),
// which the test uses to check that the page recovers from a failed run
const DEBUG = new URLSearchParams(location.search).has('debug');
const TRY_AV1 = new URLSearchParams(location.search).get('debug') === 'av1';
// The ffmpeg.wasm core has no AV1 decoder (FFmpeg's own one needs graphics hardware)
const AV1_TEXT = 'This video uses AV1, which this page can\'t read. Download it as MP4 (H.264) instead, or convert it with the ffmpeg command on the Video page';

const $ = (id) => document.getElementById(id);
const drop = $('drop'), picker = $('file'), sourceText = $('source');
const modeSel = $('mode'), widthIn = $('width'), fpsIn = $('fps'), bitrateIn = $('bitrate'), qualityIn = $('quality');
const convertBtn = $('convert'), cancelBtn = $('cancel');
const progressBox = $('progress-box'), progressBar = $('progress'), progressText = $('progress-text');
const status = $('status'), result = $('result'), info = $('info'), sizeWarning = $('size-warning'), saveBtn = $('save');
const previewBox = $('preview'), stillsBox = $('stills'), estimateText = $('estimate'), estimateWarning = $('estimate-warning');
const previewSlow = $('preview-slow'), previewRun = $('preview-run');
const previewProgressBox = $('preview-progress-box'), previewProgress = $('preview-progress'), previewProgressText = $('preview-progress-text');
const lightbox = $('lightbox'), lbImg = $('lb-img'), lbCap = $('lb-cap'), lbPrev = $('lb-prev'), lbNext = $('lb-next'), lbClose = $('lb-close');

let ffmpeg = null;      // loaded FFmpeg, or null
let file = null;        // the chosen File
let probe = null;       // what ffmpeg read from it
let output = null;      // {blob, name}
let busy = false;
let canceled = false;
let logLines = [];
let onTime = null;      // progress callback while a pass runs
const previewWorkers = []; // {ff, file, samples} per preview sample (only the first in the slow mode)
let previewToken = 0;   // a newer preview makes older ones stop
let previewRunning = false;
let previewAgain = false; // settings changed while a preview ran
let speedFile = null;   // the file whose preview speed was measured
let slowFile = null;    // the file whose preview runs only on request, one sample at a time
let previewTimer = null;
let stillURLs = [];
let stills = [];        // {url, start} of the shown stills, for the lightbox
let lightboxIndex = 0;
let lightboxReturn = null;
let sampleProgress = []; // per sample, 0..1
let shownProgress = 0;
// Preview samples at the start, a third and two thirds into the video; 0.8 s is the shortest that keeps the size
// estimate within 25% on hard-to-encode videos (Theora's rate control needs that long to settle)
const SAMPLE_SECONDS = 0.8;
const SAMPLE_POINTS = [0, 1 / 3, 2 / 3];
const AUDIO_SAMPLE_SECONDS = 5;
const PREVIEW_DELAY_MS = 600;
// A preview that would take longer than this (slow browser or computer) runs only when asked; the time is projected
// from the first sample's decoding, which takes about an eighth of a whole preview
const PREVIEW_MAX_SECONDS = 40;
const DECODE_TO_PREVIEW = 8;
// A decoded sample is kept uncompressed (fast to read again, and lossless codecs need far more memory at 4K); its
// length is cut so that it stays under this size
const RAW_SAMPLE_BYTES = 160 * 1024 * 1024;
// Sources with bigger frames than this (more than 1080p) decode their samples one after the other, to save memory
const BIG_FRAME_BYTES = 4 * 1024 * 1024;

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || '';
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
}

function minutes(seconds) {
  if (seconds < 10) return 'a few seconds';
  if (seconds < 90) return Math.round(seconds / 10) * 10 + ' seconds';
  return Math.round(seconds / 60) + ' minutes';
}

function parseTime(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// A file name the game accepts: letters, digits, _ and -, one dot before the extension (docs "File names")
function gameName(name, ext) {
  let base = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_');
  base = base.replace(/^[_-]+|[_-]+$/g, '').slice(0, 40) || 'video';
  return base + ext;
}

async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;
  setStatus('Loading the converter (32 MB, only the first time)...');
  const f = new FFmpeg();
  f.on('log', ({ message }) => {
    if (DEBUG) console.log(message);
    logLines.push(message);
    if (logLines.length > 400) logLines.splice(0, 200);
    const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(message);
    if (t && onTime) onTime(parseTime(t[1], t[2], t[3]));
  });
  await f.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
  await f.createDir('/in');
  await f.createDir('/work');
  ffmpeg = f;
  setStatus('');
  return f;
}

async function mountFile(f) {
  try { await f.unmount('/in'); } catch (e) { /* nothing mounted yet */ }
  await f.mount('WORKERFS', { files: [file] }, '/in');
  return '/in/' + file.name;
}

// Reads the duration, picture size, frame rate and sound of a file from ffmpeg's "-i" output
function readInfo(lines) {
  const text = lines.join('\n');
  const out = { duration: null, width: 0, height: 0, fps: 0, audio: false, video: false, codec: '' };
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  if (d) out.duration = parseTime(d[1], d[2], d[3]);
  for (const line of lines) {
    if (!/Stream #\d+:\d+/.test(line)) continue;
    if (/: Audio:/.test(line)) out.audio = true;
    if (/: Video:/.test(line) && !/attached pic/.test(line) && !out.video) {
      const s = /, (\d{2,5})x(\d{2,5})/.exec(line);
      const r = /([\d.]+) fps/.exec(line) || /([\d.]+) tbr/.exec(line);
      const c = /: Video: (\w+)/.exec(line);
      if (s) { out.video = true; out.width = Number(s[1]); out.height = Number(s[2]); out.codec = c ? c[1] : ''; }
      if (r) out.fps = Number(r[1]);
    }
  }
  // Phone videos store the picture sideways with a rotation, which ffmpeg applies before scaling
  const rot = /rotation of (-?[\d.]+) degrees/.exec(text);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [out.width, out.height] = [out.height, out.width];
  return out;
}

async function readFileInfo(f, path) {
  logLines = [];
  await f.exec(['-hide_banner', '-i', path]);
  const info = readInfo(logLines);
  if (info.duration == null && (info.video || info.audio)) {
    // No length in the file (browser recordings): read it through once without decoding
    logLines = [];
    await f.exec(['-hide_banner', '-i', path, '-map', '0', '-c', 'copy', '-f', 'null', '-']);
    let last = null;
    for (const line of logLines) {
      const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
      if (t) last = parseTime(t[1], t[2], t[3]);
    }
    if (last) info.duration = last;
  }
  return info;
}

function describe(p) {
  const parts = [];
  if (p.video) parts.push(p.width + ' x ' + p.height + (p.fps ? ', ' + (Math.round(p.fps * 100) / 100) + ' fps' : ''));
  parts.push(p.duration != null ? clock(p.duration) : 'unknown length');
  parts.push(p.audio ? 'with sound' : 'no sound');
  return parts.join(', ');
}

// The output height scale=W:-2 gives: the width's share of the height, rounded to an even number
function outHeight(w) {
  return Math.round((w * probe.height) / probe.width / 2) * 2;
}

function intIn(input, lo, hi, name) {
  const raw = input.value.trim();
  const v = Number(raw);
  if (raw === '' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(name + ' must be a whole number from ' + lo + ' to ' + hi);
  return v;
}

// Checks the settings against the game limits; returns them, or throws with a message for the mapper
function settings() {
  const s = { mode: modeSel.value, quality: intIn(qualityIn, 0, 10, 'Sound quality') };
  if (s.mode === 'audio') {
    if (!probe.audio) throw new Error('This file has no sound');
    s.estimate = probe.duration ? (VORBIS_KBPS[s.quality] * 1000 * probe.duration) / 8 : null;
    return s;
  }
  if (!probe.video) throw new Error('This file has no video. Choose "Sound only" to make an .ogg');
  if (probe.codec === 'av1' && !TRY_AV1) throw new Error(AV1_TEXT);
  s.width = intIn(widthIn, 16, MAX_SIZE, 'Width');
  if (s.width % 2) throw new Error('Width must be an even number');
  s.height = outHeight(s.width);
  if (s.height > MAX_SIZE) throw new Error('The picture would be ' + s.width + ' x ' + s.height + ', and the game plays up to ' + MAX_SIZE + ' x ' + MAX_SIZE + '. Use a smaller width');
  if (s.height < 2) throw new Error('The picture would be too small. Use a larger width');
  s.fps = fpsIn.value.trim() === '' ? null : intIn(fpsIn, 1, MAX_FPS, 'Frame rate');
  if (s.fps == null && probe.fps > MAX_FPS) throw new Error('This video has ' + probe.fps + ' fps, and the game plays up to ' + MAX_FPS + '. Set a frame rate');
  s.bitrate = intIn(bitrateIn, 100, 20000, 'Bitrate');
  const audioKbps = probe.audio ? VORBIS_KBPS[s.quality] : 0;
  s.estimate = probe.duration ? ((s.bitrate + audioKbps) * 1000 * probe.duration) / 8 : null;
  if (s.estimate && s.estimate > MAX_BYTES) throw new Error('The file would be about ' + mb(s.estimate) + ', and the game plays files up to 128 MB. Use a lower bitrate or a shorter video');
  return s;
}

function videoFilter(s) {
  return 'scale=' + s.width + ':-2' + (s.fps ? ',fps=' + s.fps : '');
}

// The ffmpeg runs for the settings; a preview sample passes its start and length as `cut` (input options), and
// `filtered` when its input already went through the picture filter
function commands(s, input, out = '/work/out', cut = [], passlog = '/work/pass', filtered = false) {
  const audio = ['-c:a', 'libvorbis', '-q:a', String(s.quality), '-ac', '2', '-ar', '44100'];
  if (s.mode === 'audio') return [['-y', ...cut, '-i', input, '-vn', ...audio, out + '.ogg']];
  const video = [...(filtered ? [] : ['-vf', videoFilter(s)]), '-c:v', 'libtheora', '-b:v', s.bitrate + 'k'];
  return [
    ['-y', ...cut, '-i', input, ...video, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'ogg', '/dev/null'],
    ['-y', ...cut, '-i', input, ...video, '-pass', '2', '-passlogfile', passlog, ...audio, out + '.ogv'],
  ];
}

// Bytes of the Ogg header pages (granule position 0, before any data), which a file has once whatever its length
function oggHeaderBytes(data) {
  let pos = 0;
  while (pos + 27 <= data.length && data[pos] === 0x4f && data[pos + 1] === 0x67 && data[pos + 2] === 0x67 && data[pos + 3] === 0x53) {
    let granuleZero = true;
    for (let i = 6; i < 14; i++) if (data[pos + i] !== 0) granuleZero = false;
    if (!granuleZero) break;
    const segments = data[pos + 26];
    let size = 27 + segments;
    for (let i = 0; i < segments; i++) size += data[pos + 27 + i];
    pos += size;
  }
  return pos;
}

// At least one keyframe interval of the output (12 frames) per sample; sound alone is cheap, so it gets more
function sampleSeconds(s) {
  if (s.mode === 'audio') return AUDIO_SAMPLE_SECONDS;
  const length = Math.max(SAMPLE_SECONDS, 12 / (s.fps || probe.fps || 30));
  return Math.min(length, RAW_SAMPLE_BYTES / (frameBytes() * (probe.fps || 30)));
}

function frameBytes() {
  return probe.width * probe.height * 1.5;
}

let decodeQueue = Promise.resolve();

function samplePoints(duration, length) {
  if (!duration) return [[0, length]];
  if (duration <= length * SAMPLE_POINTS.length) return [[0, duration]];
  return SAMPLE_POINTS.map((p) => [Math.min(duration * p, duration - length), length]);
}

function clearPreview(state) {
  closeLightbox();
  for (const u of stillURLs) URL.revokeObjectURL(u);
  stillURLs = [];
  stills = [];
  previewProgressBox.hidden = true;
  previewSlow.hidden = true;
  stillsBox.replaceChildren();
  estimateText.textContent = '';
  estimateWarning.hidden = true;
  delete estimateText.dataset.bytes;
  delete previewBox.dataset.seconds;
  previewBox.dataset.state = state;
  previewBox.hidden = state === 'invalid' || state === 'none';
}

// Ends the preview workers (and their decoded samples); used for a new file and before a conversion
function stopPreview() {
  previewToken++;
  clearTimeout(previewTimer);
  previewAgain = false;
  if (previewRunning) {
    for (const w of previewWorkers) if (w) w.ff.terminate();
    previewWorkers.length = 0;
  }
  previewRunning = false;
}

// A setting changed: a running preview finishes (keeping its decoded samples), then the newest settings run
function schedulePreview(delay = PREVIEW_DELAY_MS) {
  if (!probe || busy) return;
  clearTimeout(previewTimer);
  if (slowFile === file) {
    showSlow();
    return;
  }
  previewBox.dataset.state = 'pending';
  previewTimer = setTimeout(() => {
    if (previewRunning) previewAgain = true; else runPreview();
  }, delay);
}

function log(message) {
  if (DEBUG) console.log('[preview] ' + message);
}

// One ffmpeg per sample, so the samples run side by side; each keeps its decoded sample for later settings
async function previewWorker(i) {
  let w = previewWorkers[i];
  if (!w) {
    const ff = new FFmpeg();
    const nw = { ff, file: null, samples: {}, onTime: null };
    ff.on('log', ({ message }) => {
      if (DEBUG) console.log('[preview ' + i + '] ' + message);
      const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(message);
      if (t && nw.onTime) nw.onTime(parseTime(t[1], t[2], t[3]));
    });
    await ff.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
    await ff.createDir('/in');
    await ff.createDir('/work');
    w = previewWorkers[i] = nw;
  }
  if (w.file !== file) {
    try { await w.ff.unmount('/in'); } catch (e) { /* nothing mounted yet */ }
    await w.ff.mount('WORKERFS', { files: [file] }, '/in');
    w.file = file;
    w.samples = {};
    // The decoded samples of the last file
    for (let i = 0; i < SAMPLE_POINTS.length; i++) {
      try { await w.ff.deleteFile('/work/s' + i + '.nut'); } catch (e) { /* not there */ }
    }
  }
  return w;
}

// Progress of the preview: each sample's stages (start ffmpeg, decode, the encoding passes, the still) by weight,
// and inside a stage ffmpeg's time against the sample's length; the bar shows the samples' average and never goes back
function resetPreviewProgress(count) {
  sampleProgress = new Array(count).fill(0);
  shownProgress = 0;
  previewProgress.value = 0;
  previewProgressText.textContent = 'Preview 0%';
  previewProgressBox.hidden = false;
}

function setSampleProgress(i, fraction) {
  sampleProgress[i] = Math.max(sampleProgress[i] || 0, Math.min(1, fraction));
  const total = sampleProgress.reduce((a, b) => a + b, 0) / sampleProgress.length;
  if (total <= shownProgress) return;
  shownProgress = total;
  previewProgress.value = total;
  previewProgressText.textContent = 'Preview ' + Math.floor(total * 100) + '%';
}

// Runs the stages [{weight, run(onTime)}] of sample i and reports progress as they go; `later` is the weight of
// stages that run afterwards in another call
async function runStages(i, stages, length, later = 0) {
  const sum = stages.reduce((a, st) => a + st.weight, 0) + later;
  let done = 0;
  for (const st of stages) {
    const base = done;
    await st.run((t) => setSampleProgress(i, (base + st.weight * Math.min(1, t / length)) / sum));
    done += st.weight;
    setSampleProgress(i, done / sum);
  }
}

async function exec(w, args) {
  const t0 = performance.now();
  const code = await w.ff.exec(args);
  log(Math.round(performance.now() - t0) + ' ms: ' + args.join(' '));
  if (code !== 0) throw new Error('ffmpeg stopped with code ' + code);
}

// Encodes one sample with the settings; the source is decoded once into an uncompressed (or lossless) file at its
// own size, and every later setting only runs the filter and the encoder on it
// `decodeOnly` stops after decoding (the speed check); `decodedBefore` counts that part as done in the progress
async function previewSample(i, s, start, length, token, decodeOnly = false, decodedBefore = false) {
  const key = start.toFixed(3) + '+' + length.toFixed(3);
  // Samples run side by side in their own ffmpeg, or all in the first one in the slow mode (less memory)
  const wi = slowFile === file ? 0 : i;
  const base = '/work/s' + i;
  const out = base + (s.mode === 'audio' ? '-out.ogg' : '-out.ogv');
  let w = previewWorkers[wi];
  const stages = [];
  const withTime = (fn) => async (onTime) => { w.onTime = onTime; try { await fn(); } finally { w.onTime = null; } };
  const encodeWeight = 3 * (s.mode === 'audio' ? 1 : 2) + (s.mode === 'video' ? 0.3 : 0);
  if (decodedBefore) stages.push({ weight: 5, run: async () => { w = await previewWorker(wi); } });
  else if (!w) stages.push({ weight: 1, run: async () => { w = await previewWorker(wi); } });
  else stages.push({ weight: 0, run: async () => { w = await previewWorker(wi); } });
  // Decoding the source happens once per file and sample, so it only counts when it runs
  const decodes = !w || w.file !== file || w.samples[i] !== key;
  if (decodes) {
    stages.push({ weight: 4, run: withTime(async () => {
      if (w.samples[i] === key) return;
      const t0 = performance.now();
      const decode = () => exec(w, ['-y', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', '/in/' + file.name,
        '-c:v', 'rawvideo', '-c:a', 'pcm_f32le', '-f', 'nut', base + '.nut']);
      if (frameBytes() > BIG_FRAME_BYTES) {
        const turn = decodeQueue.then(decode);
        decodeQueue = turn.catch(() => {});
        await turn;
      } else {
        await decode();
      }
      w.samples[i] = key;
      w.decodeSeconds = (performance.now() - t0) / 1000;
    }) });
  }
  if (decodeOnly) {
    await runStages(i, stages, length, encodeWeight);
    return { decodeSeconds: w.decodeSeconds || 0 };
  }
  for (const run of commands(s, base + '.nut', base + '-out', [], base + '-pass')) {
    stages.push({ weight: 3, run: withTime(async () => {
      if (token !== previewToken) return;
      await exec(w, run);
    }) });
  }
  let png = null;
  if (s.mode === 'video') {
    stages.push({ weight: 0.3, run: async () => {
      if (token !== previewToken) return;
      await exec(w, ['-y', '-ss', (length / 2).toFixed(3), '-i', out, '-frames:v', '1', base + '-still.png']);
      png = await w.ff.readFile(base + '-still.png');
    } });
  }
  await runStages(i, stages, length);
  if (token !== previewToken) return null;
  const bytes = await w.ff.readFile(out);
  return { start, length, bytes, png };
}

// In the slow mode the preview waits for the Preview button; the estimate comes from the bitrate until then
function showSlow() {
  let s;
  try {
    s = settings();
  } catch (e) {
    clearPreview('invalid');
    return;
  }
  previewBox.hidden = false;
  previewBox.dataset.state = 'slow';
  previewSlow.hidden = false;
  showEstimate(s, s.estimate);
}

function showEstimate(s, estimate) {
  const picture = s.mode === 'video' ? ', ' + s.width + ' x ' + s.height + (s.fps ? ' at ' + s.fps + ' fps' : '') : '';
  estimateText.textContent = (estimate ? 'About ' + mb(estimate) : 'Unknown size') + picture;
  if (estimate) estimateText.dataset.bytes = String(Math.round(estimate)); else delete estimateText.dataset.bytes;
  estimateWarning.hidden = true;
  if (estimate > MAX_BYTES) {
    estimateWarning.textContent = 'This is over the 128 MB the game plays. A lower bitrate makes the file smaller.';
    estimateWarning.hidden = false;
  } else if (estimate > SERVER_SEND_BYTES) {
    estimateWarning.textContent = sizeWarning.textContent;
    estimateWarning.hidden = false;
  }
}

async function runPreview(asked = false) {
  if (!probe || busy) return;
  if (slowFile === file && !asked) {
    showSlow();
    return;
  }
  previewSlow.hidden = true;
  let s;
  try {
    s = settings();
  } catch (e) {
    clearPreview('invalid');
    return;
  }
  const token = ++previewToken;
  previewRunning = true;
  previewAgain = false;
  const started = performance.now();
  previewBox.hidden = false;
  previewBox.dataset.state = 'running';
  if (!stillsBox.children.length) estimateText.textContent = '';
  try {
    const points = samplePoints(probe.duration, sampleSeconds(s));
    resetPreviewProgress(points.length);
    let checked = false;
    if (speedFile !== file) {
      // Decode the first sample alone and project the whole preview from it
      const first = await previewSample(0, s, points[0][0], points[0][1], token, true);
      if (token !== previewToken || !first) return;
      speedFile = file;
      checked = true;
      previewBox.dataset.firstDecode = first.decodeSeconds.toFixed(1);
      if (first.decodeSeconds * DECODE_TO_PREVIEW > PREVIEW_MAX_SECONDS) {
        slowFile = file;
        for (const w of previewWorkers.splice(1)) if (w) w.ff.terminate();
        previewProgressBox.hidden = true;
        showSlow();
        return;
      }
    }
    let samples;
    if (slowFile === file) {
      // One sample at a time, which keeps the memory low on the browsers that are slow anyway
      samples = [];
      for (let i = 0; i < points.length; i++) {
        samples.push(await previewSample(i, s, points[i][0], points[i][1], token, false, i === 0 && checked));
        if (token !== previewToken) return;
      }
    } else {
      samples = await Promise.all(points.map(([start, length], i) => previewSample(i, s, start, length, token, false, i === 0 && checked)));
    }
    if (token !== previewToken || samples.includes(null)) return;
    let data = 0, seconds = 0, header = 0;
    for (const u of stillURLs) URL.revokeObjectURL(u);
    stillURLs = [];
    stills = [];
    stillsBox.replaceChildren();
    for (const sm of samples) {
      const h = oggHeaderBytes(sm.bytes);
      header = Math.max(header, h);
      data += sm.bytes.length - h;
      seconds += sm.length;
      if (!sm.png) continue;
      const url = URL.createObjectURL(new Blob([sm.png], { type: 'image/png' }));
      stillURLs.push(url);
      const index = stills.length;
      stills.push({ url, start: sm.start });
      const fig = document.createElement('figure');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'still';
      open.setAttribute('aria-label', 'Show the still at ' + clock(sm.start) + ' at full size');
      open.addEventListener('click', () => openLightbox(index, open));
      const img = document.createElement('img');
      img.alt = 'Preview at ' + clock(sm.start);
      img.width = s.width;
      img.height = s.height;
      img.addEventListener('load', () => { img.dataset.size = img.naturalWidth + 'x' + img.naturalHeight; });
      img.src = url;
      open.append(img);
      const cap = document.createElement('figcaption');
      cap.textContent = clock(sm.start);
      fig.append(open, cap);
      stillsBox.append(fig);
    }
    const estimate = probe.duration ? header + (data / seconds) * probe.duration : null;
    showEstimate(s, estimate);
    previewBox.dataset.seconds = ((performance.now() - started) / 1000).toFixed(1);
    previewBox.dataset.state = previewAgain ? 'pending' : 'done';
  } catch (e) {
    if (token !== previewToken) return;
    clearPreview('error');
    previewBox.hidden = false;
    estimateText.textContent = 'No preview: ' + e.message;
    for (const w of previewWorkers) if (w) w.ff.terminate();
    previewWorkers.length = 0;
  } finally {
    if (token === previewToken) {
      previewRunning = false;
      previewProgressBox.hidden = true;
      if (previewAgain) runPreview();
    }
  }
}

// Lightbox: a still at its real size (smaller only to fit the screen), arrows or swipes step through the stills
function showLightbox(index) {
  lightboxIndex = (index + stills.length) % stills.length;
  const st = stills[lightboxIndex];
  lbImg.src = st.url;
  lbImg.alt = 'Preview at ' + clock(st.start);
  lbCap.textContent = clock(st.start);
  lbImg.onload = () => {
    lbImg.dataset.size = lbImg.naturalWidth + 'x' + lbImg.naturalHeight;
    lbCap.textContent = clock(st.start) + ', ' + lbImg.naturalWidth + ' x ' + lbImg.naturalHeight;
  };
  lbPrev.hidden = lbNext.hidden = stills.length < 2;
}

function openLightbox(index, from) {
  if (!stills.length) return;
  lightboxReturn = from || null;
  showLightbox(index);
  lightbox.hidden = false;
  document.body.classList.add('lightbox-open');
  lbClose.focus();
}

function closeLightbox() {
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  document.body.classList.remove('lightbox-open');
  if (lightboxReturn) lightboxReturn.focus();
}

function setBusy(on) {
  busy = on;
  for (const el of [modeSel, widthIn, fpsIn, bitrateIn, qualityIn]) el.disabled = on;
  drop.classList.toggle('disabled', on);
  convertBtn.hidden = on;
  cancelBtn.hidden = !on;
  progressBox.hidden = !on;
}

function showMode() {
  const audio = modeSel.value === 'audio';
  for (const el of document.querySelectorAll('.video-only')) el.hidden = audio;
}

async function choose(f) {
  if (busy || !f) return;
  stopPreview();
  clearPreview('none');
  file = f;
  probe = null;
  result.hidden = true;
  convertBtn.disabled = true;
  sourceText.textContent = f.name + ' (' + mb(f.size) + ')';
  try {
    const ff = await loadFFmpeg();
    const path = await mountFile(ff);
    setStatus('Reading the video...');
    probe = await readFileInfo(ff, path);
    if (!probe.video && !probe.audio) throw new Error('the browser converter cannot read this file');
    sourceText.textContent = f.name + ': ' + describe(probe);
    if (!probe.video) modeSel.value = 'audio';
    showMode();
    convertBtn.disabled = false;
    let note = '';
    if (probe.codec === 'av1') note = AV1_TEXT;
    if (probe.duration > 60) note = 'Long videos take a while: a minute of 1080p at 60 fps takes about 12 minutes. A smaller width or 30 fps is faster, and so is Chrome or Edge.';
    setStatus(note, probe.codec === 'av1' ? 'error' : '');
    schedulePreview(0);
  } catch (e) {
    probe = null;
    setStatus('Could not read ' + f.name + ': ' + e.message, 'error');
    if (ffmpeg) { ffmpeg.terminate(); ffmpeg = null; }
  }
}

async function convert() {
  if (busy || !probe) return;
  let s;
  try {
    s = settings();
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  result.hidden = true;
  canceled = false;
  const previewDone = previewBox.dataset.state === 'done';
  stopPreview();
  // The conversion gets the memory and processor time of the preview's ffmpeg instances
  for (const w of previewWorkers) if (w) w.ff.terminate();
  previewWorkers.length = 0;
  if (!previewDone) clearPreview('none');
  setBusy(true);
  setStatus('');
  progressBar.value = 0;
  progressText.textContent = 'Starting...';
  const started = performance.now();
  const runs = commands(s, '/in/' + file.name);
  const afterRun = () => { if (!previewDone) schedulePreview(); };
  const shares = runs.length === 2 ? [PASS1_SHARE, 1 - PASS1_SHARE] : [1];
  try {
    const ff = await loadFFmpeg();
    await mountFile(ff);
    let done = 0;
    for (let i = 0; i < runs.length; i++) {
      const label = runs.length === 2 ? ['Measuring the video (step 1 of 2)', 'Writing the file (step 2 of 2)'][i] : 'Writing the file';
      progressText.textContent = label + '...';
      onTime = (t) => {
        if (!probe.duration) return;
        const frac = done + shares[i] * Math.min(1, t / probe.duration);
        progressBar.value = frac;
        const elapsed = (performance.now() - started) / 1000;
        const left = frac > 0.02 ? elapsed / frac - elapsed : null;
        progressText.textContent = label + ': ' + Math.floor(frac * 100) + '%' + (left != null ? ', ' + minutes(left) + ' left' : '');
      };
      logLines = [];
      const code = await ff.exec(runs[i]);
      if (code !== 0) {
        const last = logLines.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-3).join(' ');
        throw new Error(last || 'ffmpeg stopped with code ' + code);
      }
      done += shares[i];
    }
    onTime = null;
    const outPath = s.mode === 'audio' ? '/work/out.ogg' : '/work/out.ogv';
    const data = await ff.readFile(outPath);
    const outInfo = await readFileInfo(ff, outPath);
    for (const p of [outPath, '/work/pass-0.log', '/work/pass-0.log.mbtree']) {
      try { await ff.deleteFile(p); } catch (e) { /* not there */ }
    }
    const ext = s.mode === 'audio' ? '.ogg' : '.ogv';
    output = { blob: new Blob([data], { type: 'application/octet-stream' }), name: gameName(file.name, ext) };
    const took = (performance.now() - started) / 1000;
    info.textContent = [
      'File:     ' + output.name,
      'Size:     ' + mb(output.blob.size),
      'Length:   ' + (outInfo.duration != null ? clock(outInfo.duration) : 'unknown'),
      ...(s.mode === 'video' ? ['Picture:  ' + outInfo.width + ' x ' + outInfo.height + (outInfo.fps ? ', ' + (Math.round(outInfo.fps * 100) / 100) + ' fps' : '')] : []),
      'Sound:    ' + (outInfo.audio ? 'yes' : 'none'),
      'Took:     ' + clock(took),
    ].join('\n');
    sizeWarning.hidden = output.blob.size <= SERVER_SEND_BYTES;
    if (output.blob.size > MAX_BYTES) {
      setStatus('The file is ' + mb(output.blob.size) + ', and the game plays files up to 128 MB. Use a lower bitrate or a shorter video', 'error');
    }
    result.hidden = false;
    setBusy(false);
    afterRun();
  } catch (e) {
    onTime = null;
    setBusy(false);
    afterRun();
    if (canceled) return;
    setStatus('The conversion failed: ' + e.message, 'error');
    // A failed run can leave the ffmpeg instance unusable, so the next run starts a new one
    if (ffmpeg) { ffmpeg.terminate(); ffmpeg = null; }
  }
}

function cancel() {
  if (!busy || !ffmpeg) return;
  const f = ffmpeg;
  canceled = true;
  ffmpeg = null;
  onTime = null;
  f.terminate();
  setBusy(false);
  setStatus('Canceled');
}

function save() {
  if (!output) return;
  const url = URL.createObjectURL(output.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = output.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

drop.addEventListener('click', () => { if (!busy) picker.click(); });
drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); picker.click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) choose(e.dataTransfer.files[0]);
});
picker.addEventListener('change', () => { if (picker.files.length) choose(picker.files[0]); picker.value = ''; });
modeSel.addEventListener('change', () => { showMode(); schedulePreview(); });
for (const el of [widthIn, fpsIn, bitrateIn, qualityIn]) el.addEventListener('input', () => schedulePreview());
convertBtn.addEventListener('click', convert);
cancelBtn.addEventListener('click', cancel);
saveBtn.addEventListener('click', save);
previewRun.addEventListener('click', () => { if (!previewRunning) runPreview(true); });
lbClose.addEventListener('click', closeLightbox);
lbPrev.addEventListener('click', () => showLightbox(lightboxIndex - 1));
lbNext.addEventListener('click', () => showLightbox(lightboxIndex + 1));
lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target.classList.contains('lb-stage')) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') showLightbox(lightboxIndex - 1);
  else if (e.key === 'ArrowRight') showLightbox(lightboxIndex + 1);
  else if (e.key === 'Tab') {
    // Keep the focus inside the lightbox
    const buttons = [lbClose, lbPrev, lbNext].filter((b) => !b.hidden);
    const at = buttons.indexOf(document.activeElement);
    e.preventDefault();
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
});
let touchX = null;
lightbox.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
lightbox.addEventListener('touchend', (e) => {
  if (touchX == null || stills.length < 2) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 40) showLightbox(lightboxIndex + (dx < 0 ? 1 : -1));
});
showMode();
