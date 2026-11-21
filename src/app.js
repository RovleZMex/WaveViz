import { AudioEngine, DemoSource } from './audio.js';
import { Renderer } from './renderer.js';
import { buildSegments, resetBeam, MAX_SEGS, SEG_FLOATS } from './modes.js';
import { BUILTIN, DEFAULTS, sanitize, loadSettings, saveSettings, loadUserPresets, saveUserPresets } from './presets.js';
import { buildPanel } from './ui.js';

const $ = (id) => document.getElementById(id);

const settings = loadSettings();
let userPresets = loadUserPresets();
const audio = new AudioEngine();
const demo = new DemoSource();
const segs = new Float32Array(MAX_SEGS * SEG_FLOATS);

let renderer;
try {
  renderer = new Renderer($('gl'));
} catch (err) {
  document.body.textContent = `No se pudo iniciar el render: ${err.message}`;
  throw err;
}

// ---------- helpers ----------

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// ---------- settings panel & presets ----------

let saveTimer = 0;
function onSettingsChanged(key) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings), 300);
  if (!key || key === 'grid' || key === 'color' || key === 'zoom') drawGrid();
  if (!key || key === 'mode' || key === 'xyMode') resetBeam();
}

const refreshPanel = buildPanel($('controls'), settings, onSettingsChanged);

function applySettings(next) {
  Object.assign(settings, sanitize(next));
  refreshPanel();
  onSettingsChanged();
}

function fillPresetSelect(selected = '') {
  const sel = $('presetSelect');
  sel.replaceChildren(new Option('— Elegir preset —', ''));
  const group = (label, list, prefix) => {
    if (!list.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    list.forEach((p, i) => og.append(new Option(p.name, `${prefix}:${i}`)));
    sel.append(og);
  };
  group('Incluidos', BUILTIN, 'b');
  group('Mis presets', userPresets, 'u');
  sel.value = selected;
  $('presetDelete').disabled = !selected.startsWith('u:');
}

$('presetSelect').addEventListener('change', (e) => {
  const [kind, index] = e.target.value.split(':');
  const preset = (kind === 'b' ? BUILTIN : userPresets)[index];
  $('presetDelete').disabled = kind !== 'u';
  if (!preset) return;
  applySettings({ ...DEFAULTS, ...preset.settings });
  if (kind === 'u') $('presetName').value = preset.name;
});

$('presetSave').addEventListener('click', () => {
  const name = $('presetName').value.trim();
  if (!name) { toast('Escribe un nombre para el preset'); $('presetName').focus(); return; }
  const preset = { name, settings: { ...settings } };
  let index = userPresets.findIndex((p) => p.name === name);
  if (index >= 0) userPresets[index] = preset; else index = userPresets.push(preset) - 1;
  saveUserPresets(userPresets);
  fillPresetSelect(`u:${index}`);
  toast(`Preset "${name}" guardado`);
});

$('presetDelete').addEventListener('click', () => {
  const [kind, index] = $('presetSelect').value.split(':');
  if (kind !== 'u') return;
  const [removed] = userPresets.splice(Number(index), 1);
  saveUserPresets(userPresets);
  fillPresetSelect();
  toast(`Preset "${removed.name}" borrado`);
});

$('presetExport').addEventListener('click', () => {
  const name = $('presetName').value.trim() || 'preset';
  const blob = new Blob([JSON.stringify({ name, settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\-]+/g, '_')}.waveviz.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('presetImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.settings !== 'object') throw new Error('formato');
    applySettings(data.settings);
    if (typeof data.name === 'string') $('presetName').value = data.name.slice(0, 40);
    toast('Preset importado (pulsa Guardar para conservarlo)');
  } catch {
    toast('Ese archivo no es un preset de WaveViz válido');
  }
});

fillPresetSelect();

// ---------- audio & transport ----------

async function loadFile(file) {
  if (!file) return;
  toast(`Cargando ${file.name}…`);
  try {
    await audio.load(await file.arrayBuffer());
  } catch {
    toast('No se pudo decodificar ese archivo de audio');
    return;
  }
  document.body.classList.add('loaded');
  $('title').textContent = file.name.replace(/\.[^.]+$/, '');
  $('dur').textContent = fmtTime(audio.duration);
  $('play').disabled = false;
  $('seek').disabled = false;
  resetBeam();
  audio.play();
  toast(file.name);
}

$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('play').addEventListener('click', () => audio.toggle());
$('volume').addEventListener('input', (e) => audio.setVolume(parseFloat(e.target.value)));
audio.setVolume(parseFloat($('volume').value));

let seeking = false;
$('seek').addEventListener('input', (e) => {
  seeking = true;
  $('cur').textContent = fmtTime(e.target.value / 1000 * audio.duration);
});
$('seek').addEventListener('change', (e) => {
  seeking = false;
  audio.seek(e.target.value / 1000 * audio.duration);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
$('full').addEventListener('click', toggleFullscreen);
$('toggle').addEventListener('click', () => document.body.classList.toggle('hide-panel'));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text]')) return;
  if (e.code === 'Space') { e.preventDefault(); audio.toggle(); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hide-ui');
  else if (e.key === 'ArrowLeft' && audio.buffer) audio.seek(audio.time - 5);
  else if (e.key === 'ArrowRight' && audio.buffer) audio.seek(audio.time + 5);
  else return;
  if (e.target.matches('button, input[type=range]')) e.target.blur();
});

// ---------- graticule overlay ----------

const gridCanvas = $('grid');
function drawGrid() {
  const w = renderer.width, h = renderer.height;
  if (!w) return;
  gridCanvas.width = w;
  gridCanvas.height = h;
  if (!settings.grid) return;
  const g = gridCanvas.getContext('2d');
  const [r, gr, b] = hexToRgb(settings.color).map((v) => Math.round(v * 255));
  const step = Math.min(w, h) / 10 * settings.zoom;
  const cx = Math.round(w / 2) + 0.5, cy = Math.round(h / 2) + 0.5;
  const lines = (alpha, every) => {
    g.strokeStyle = `rgba(${r},${gr},${b},${alpha})`;
    g.beginPath();
    for (let i = -Math.ceil(cx / step); i <= cx / step; i++) {
      if (!every(i)) continue;
      g.moveTo(Math.round(cx + i * step) + 0.5, 0);
      g.lineTo(Math.round(cx + i * step) + 0.5, h);
    }
    for (let i = -Math.ceil(cy / step); i <= cy / step; i++) {
      if (!every(i)) continue;
      g.moveTo(0, Math.round(cy + i * step) + 0.5);
      g.lineTo(w, Math.round(cy + i * step) + 0.5);
    }
    g.stroke();
  };
  lines(0.07, (i) => i !== 0);
  lines(0.18, (i) => i === 0);
}

// ---------- render loop ----------

// Light deposited per second, relative to screen area. Windowed modes redraw a thin
// line every frame, so they need far less than the XY cloud to look equally bright.
const ENERGY = { xy: 0.02, wave: 0.012, radial: 0.012 };

let lastNow = performance.now();
let lastPos = 0;
let lastSrc = null;
let spinAngle = 0;
let hueShift = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000));
  lastNow = now;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.round(window.innerWidth * dpr));
  const h = Math.max(2, Math.round(window.innerHeight * dpr));
  if (renderer.resize(w, h)) { drawGrid(); resetBeam(); }
  const minDim = Math.min(w, h);

  const src = audio.buffer ? audio : demo;
  const live = src === demo || audio.playing;
  const pos = src.visualSample;
  if (src !== lastSrc) { lastSrc = src; lastPos = pos; resetBeam(); }

  const s = settings;
  const count = buildSegments(s, { src, pos, prevPos: lastPos, live, xr: w / minDim / s.zoom }, segs);
  lastPos = pos;

  // While paused the last frame is redrawn from scratch every time, so settings stay live.
  const tau = s.persistence;
  const decay = live && tau > 0 ? Math.exp(-dt / tau) : 0;
  const total = s.intensity * ENERGY[s.mode] * minDim * minDim * (live ? dt / (tau + 1 / 60) : 1);
  const each = count ? total / count : 0;
  for (let i = 0; i < count; i++) segs[i * SEG_FLOATS + 4] = each;

  if (live) {
    spinAngle += s.spin * dt;
    hueShift = (hueShift + s.hueSpeed * dt) % 360;
  }
  const [hue, sat, lum] = rgbToHsl(hexToRgb(s.color));
  const copies = [];
  const base = (s.rotation + spinAngle) * Math.PI / 180;
  for (let k = 0; k < s.symmetry; k++) {
    const a = base + k * Math.PI * 2 / s.symmetry;
    const c = Math.cos(a), sn = Math.sin(a);
    const color = hslToRgb((hue + hueShift + 360 * s.hueSpread * k / s.symmetry) % 360, sat, lum);
    copies.push({ mat: [c, sn, -sn, c], color });
    if (s.mirror) copies.push({ mat: [-c, -sn, -sn, c], color });
  }

  renderer.render({
    segs, count, decay, copies,
    sigma: s.beamWidth * dpr,
    scale: minDim / 2 * s.zoom,
    glow: s.glow,
    glowSize: s.glowSize,
    bg: hexToRgb(s.background),
  });

  $('play').textContent = audio.playing ? '⏸' : '▶';
  if (audio.buffer && !seeking) {
    $('cur').textContent = fmtTime(audio.time);
    $('seek').value = audio.duration ? audio.time / audio.duration * 1000 : 0;
  }
}

requestAnimationFrame(frame);
