// Page logic: read the chosen file with ffmpeg.wasm, convert it to Ogg Theora + Vorbis (.ogv) or Vorbis (.ogg) with
// the same ffmpeg command as the docs' "Making a video file", show progress, and offer the result as a download.
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

const $ = (id) => document.getElementById(id);
const drop = $('drop'), picker = $('file'), sourceText = $('source');
const modeSel = $('mode'), widthIn = $('width'), fpsIn = $('fps'), bitrateIn = $('bitrate'), qualityIn = $('quality');
const convertBtn = $('convert'), cancelBtn = $('cancel');
const progressBox = $('progress-box'), progressBar = $('progress'), progressText = $('progress-text');
const status = $('status'), result = $('result'), info = $('info'), sizeWarning = $('size-warning'), saveBtn = $('save');

let ffmpeg = null;      // loaded FFmpeg, or null
let file = null;        // the chosen File
let probe = null;       // what ffmpeg read from it
let output = null;      // {blob, name}
let busy = false;
let canceled = false;
let logLines = [];
let onTime = null;      // progress callback while a pass runs

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
  const out = { duration: null, width: 0, height: 0, fps: 0, audio: false, video: false };
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  if (d) out.duration = parseTime(d[1], d[2], d[3]);
  for (const line of lines) {
    if (!/Stream #\d+:\d+/.test(line)) continue;
    if (/: Audio:/.test(line)) out.audio = true;
    if (/: Video:/.test(line) && !/attached pic/.test(line) && !out.video) {
      const s = /, (\d{2,5})x(\d{2,5})/.exec(line);
      const r = /([\d.]+) fps/.exec(line) || /([\d.]+) tbr/.exec(line);
      if (s) { out.video = true; out.width = Number(s[1]); out.height = Number(s[2]); }
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
  return readInfo(logLines);
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

function commands(s, input) {
  const audio = ['-c:a', 'libvorbis', '-q:a', String(s.quality), '-ac', '2', '-ar', '44100'];
  if (s.mode === 'audio') return [['-y', '-i', input, '-vn', ...audio, '/work/out.ogg']];
  const vf = 'scale=' + s.width + ':-2' + (s.fps ? ',fps=' + s.fps : '');
  const video = ['-vf', vf, '-c:v', 'libtheora', '-b:v', s.bitrate + 'k'];
  return [
    ['-y', '-i', input, ...video, '-pass', '1', '-passlogfile', '/work/pass', '-an', '-f', 'ogg', '/dev/null'],
    ['-y', '-i', input, ...video, '-pass', '2', '-passlogfile', '/work/pass', ...audio, '/work/out.ogv'],
  ];
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
    if (probe.duration > 60) note = 'Long videos take a while: a minute of 1080p at 60 fps takes about 12 minutes. A smaller width or 30 fps is faster.';
    setStatus(note);
  } catch (e) {
    probe = null;
    setStatus('Could not read ' + f.name + ': ' + e.message, 'error');
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
  setBusy(true);
  setStatus('');
  progressBar.value = 0;
  progressText.textContent = 'Starting...';
  const started = performance.now();
  const runs = commands(s, '/in/' + file.name);
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
    output = { blob: new Blob([data], { type: s.mode === 'audio' ? 'audio/ogg' : 'video/ogg' }), name: gameName(file.name, ext) };
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
  } catch (e) {
    onTime = null;
    setBusy(false);
    if (canceled) return;
    setStatus('The conversion failed: ' + e.message, 'error');
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
modeSel.addEventListener('change', showMode);
convertBtn.addEventListener('click', convert);
cancelBtn.addEventListener('click', cancel);
saveBtn.addEventListener('click', save);
showMode();
