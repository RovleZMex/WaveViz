import { AudioEngine, DemoSource } from './audio.js';
import { Renderer } from './renderer.js';
import { buildSegments, resetBeam, resetLevels, WEIGHTED, MAX_SEGS, SEG_FLOATS } from './modes.js';
import { exportVideo } from './export.js';
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
  if (!key || ['mode', 'xyMode', 'bands', 'bandLayout'].includes(key)) resetBeam();
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
  if (!file || exporting) return;
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
  $('export').disabled = false;
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
  if (e.target.matches('input[type=text]') || exporting || dlg.open) return;
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
// Width in pixels of the part of the canvas the picture is fitted to (the settings
// panel covers the rest).
let viewW = 0;
function drawGrid() {
  const w = renderer.width, h = renderer.height;
  if (!w) return;
  gridCanvas.width = w;
  gridCanvas.height = h;
  if (!settings.grid) return;
  const g = gridCanvas.getContext('2d');
  const [r, gr, b] = hexToRgb(settings.color).map((v) => Math.round(v * 255));
  const step = Math.min(viewW, h) / 10 * settings.zoom;
  const cx = Math.round(viewW / 2) + 0.5, cy = Math.round(h / 2) + 0.5;
  const lines = (alpha, every) => {
    g.strokeStyle = `rgba(${r},${gr},${b},${alpha})`;
    g.beginPath();
    for (let i = -Math.ceil(cx / step); i <= (w - cx) / step; i++) {
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
// For the figure modes (tunnel, sphere, singer): light per unit of line length instead.
const LINE_ENERGY = 0.003;

// Where each band goes when they are shown apart: stacked rows for the waveform,
// concentric rings for radial, side by side for XY.
// xr, yr: half-extents of the visible area in normalized units.
function bandLayout(s, band, xr, yr) {
  if (band < 0 || s.bandLayout !== 'split') return null;
  const k = band - 1;
  if (s.mode === 'wave') return { sx: 1, sy: 0.36, ox: 0, oy: -k * 0.62 * yr };
  if (s.mode === 'radial') { const sc = [0.45, 0.72, 1][band]; return { sx: sc, sy: sc, ox: 0, oy: 0 }; }
  // XY: three cells along the longer side of the view, each figure sized to its cell
  // (zoom still scales the figures, but the cells stay put so nothing drifts off screen).
  const wide = xr >= yr;
  const cell = Math.min((wide ? xr : yr) / 3, wide ? yr : xr) * s.zoom * 0.85;
  return wide
    ? { sx: cell, sy: cell, ox: k * xr * 2 / 3, oy: 0 }
    : { sx: cell, sy: cell, ox: 0, oy: -k * yr * 2 / 3 };
}

// Symmetry copies: a rotation (and optional mirror) matrix plus a color for each.
function makeCopies(s, hex) {
  const [hue, sat, lum] = rgbToHsl(hexToRgb(hex));
  const copies = [];
  const base = (s.rotation + spinAngle) * Math.PI / 180;
  for (let k = 0; k < s.symmetry; k++) {
    const a = base + k * Math.PI * 2 / s.symmetry;
    const c = Math.cos(a), sn = Math.sin(a);
    const color = hslToRgb((hue + hueShift + 360 * s.hueSpread * k / s.symmetry) % 360, sat, lum);
    copies.push({ mat: [c, sn, -sn, c], color });
    if (s.mirror) copies.push({ mat: [-c, -sn, -sn, c], color });
  }
  return copies;
}

let lastNow = performance.now();
let lastPos = 0;
let lastSrc = null;
let spinAngle = 0;
let hueShift = 0;
let exporting = false;

// Draws one frame. o: { w, h, vw, px, src, pos, prevPos, dt, live }
// vw is the width of the area the picture is fitted to (see viewW).
// px is device pixels per CSS pixel, so widths look the same at any output resolution.
function renderFrame(o) {
  const s = settings;
  const { w, h, dt, live } = o;
  const minDim = Math.min(o.vw, h);
  if (live) {
    spinAngle += s.spin * dt;
    hueShift = (hueShift + s.hueSpeed * dt) % 360;
  }
  // With the animation off, go back to the configured angle and color.
  if (s.spin === 0) spinAngle = 0;
  if (s.hueSpeed === 0) hueShift = 0;

  // While paused the last frame is redrawn from scratch every time, so settings stay live.
  const tau = s.persistence;
  const decay = live && tau > 0 ? Math.exp(-dt / tau) : 0;
  const light = s.intensity * minDim * minDim * (live ? dt / (tau + 1 / 60) : 1) * (s.bands ? 0.7 : 1);
  const weighted = WEIGHTED.has(s.mode);
  const xr = o.vw / minDim / s.zoom, yr = h / minDim / s.zoom;

  // One layer for the whole signal, or one per frequency band.
  const layers = s.bands
    ? [
      { band: 0, gain: s.gainLow, color: s.colorLow },
      { band: 1, gain: s.gainMid, color: s.colorMid },
      { band: 2, gain: s.gainHigh, color: s.colorHigh },
    ]
    : [{ band: -1, gain: 1, color: s.color }];

  renderer.begin(decay);
  for (const layer of layers) {
    const ctx = { src: o.src, pos: o.pos, prevPos: o.prevPos, live, xr, yr, gain: s.gain * layer.gain };
    const count = buildSegments(s, ctx, segs, layer.band, bandLayout(s, layer.band, xr, yr));
    if (!count || layer.gain <= 0) continue;
    if (weighted) {
      const k = light * LINE_ENERGY;
      for (let i = 0; i < count; i++) segs[i * SEG_FLOATS + 4] *= k;
    } else {
      const each = light * ENERGY[s.mode] / count;
      for (let i = 0; i < count; i++) segs[i * SEG_FLOATS + 4] = each;
    }
    renderer.draw({
      segs, count,
      copies: makeCopies(s, layer.color),
      sigma: s.beamWidth * o.px,
      scale: minDim / 2 * s.zoom,
      cx: o.vw / 2,
    });
  }
  renderer.end({ glow: s.glow, glowSize: s.glowSize, glowScale: o.px, bg: hexToRgb(s.background) });
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000));
  lastNow = now;
  if (exporting) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.round(window.innerWidth * dpr));
  const h = Math.max(2, Math.round(window.innerHeight * dpr));
  // Keep the picture clear of the settings panel while it is showing.
  const cl = document.body.classList;
  const panelShown = !cl.contains('hide-ui') && !cl.contains('hide-panel') && window.innerWidth >= 900;
  const vw = w - (panelShown ? Math.round(314 * dpr) : 0);
  const resized = renderer.resize(w, h);
  if (resized || vw !== viewW) { viewW = vw; drawGrid(); }
  if (resized) resetBeam();

  const src = audio.buffer ? audio : demo;
  const live = src === demo || audio.playing;
  const pos = src.visualSample;
  if (src !== lastSrc) { lastSrc = src; lastPos = pos; resetBeam(); }

  renderFrame({ w, h, vw, px: dpr, src, pos, prevPos: lastPos, dt, live });
  lastPos = pos;

  $('play').textContent = audio.playing ? '⏸' : '▶';
  if (audio.buffer && !seeking) {
    $('cur').textContent = fmtTime(audio.time);
    $('seek').value = audio.duration ? audio.time / audio.duration * 1000 : 0;
  }
}

requestAnimationFrame(frame);

// ---------- video export ----------

const dlg = $('exportDlg');
let cancelExport = false;

$('export').addEventListener('click', () => {
  $('exInfo').textContent = 'Se exporta la canción completa con los ajustes actuales, en MP4.';
  $('exProgress').hidden = true;
  dlg.showModal();
});
$('exCancel').addEventListener('click', () => { if (exporting) cancelExport = true; else dlg.close(); });
dlg.addEventListener('cancel', (e) => { if (exporting) { e.preventDefault(); cancelExport = true; } });
$('exStart').addEventListener('click', runExport);

async function runExport() {
  if (exporting || !audio.buffer) return;
  const [W, H] = $('exRes').value.split('x').map(Number);
  const fps = Number($('exFps').value);
  const sr = audio.sampleRate;
  // Same beam and glow size relative to the picture as in the window right now.
  const px = Math.min(W, H) / Math.min(window.innerWidth, window.innerHeight);

  audio.pause();
  exporting = true;
  cancelExport = false;
  document.body.classList.add('exporting');
  $('exStart').disabled = true;
  $('exRes').disabled = $('exFps').disabled = true;
  $('exCancel').textContent = 'Cancelar';
  $('exProgress').hidden = false;
  $('exProgress').value = 0;

  const saved = { spinAngle, hueShift };
  spinAngle = 0;
  hueShift = 0;
  renderer.resize(W, H);
  renderer.begin(0);
  viewW = W;
  drawGrid();
  resetBeam();
  resetLevels();

  // Each frame is the beam picture plus the graticule, flattened into one canvas.
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d');
  let prevPos = -Math.round(sr / fps);
  const started = performance.now();

  try {
    const result = await exportVideo({
      L: audio.L, R: audio.R, sampleRate: sr, width: W, height: H, fps,
      isCancelled: () => cancelExport,
      drawFrame(pos) {
        renderFrame({ w: W, h: H, vw: W, px, src: audio, pos, prevPos, dt: 1 / fps, live: true });
        prevPos = pos;
        g.drawImage($('gl'), 0, 0);
        if (settings.grid) g.drawImage(gridCanvas, 0, 0);
        return out;
      },
      onProgress(fraction) {
        $('exProgress').value = fraction;
        const elapsed = (performance.now() - started) / 1000;
        const left = fraction > 0.02 ? ` · faltan ~${fmtTime(elapsed / fraction - elapsed)}` : '';
        $('exInfo').textContent = `Renderizando ${Math.round(fraction * 100)}%${left}`;
      },
    });
    if (result) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(result.blob);
      a.download = `${($('title').textContent || 'waveviz').replace(/[\\/:*?"<>|]+/g, '_')}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      const compat = result.video === 'avc' && result.audio === 'aac' ? '' : ` (códecs ${result.video}/${result.audio})`;
      toast(`Video exportado${compat}`);
      dlg.close();
    } else {
      $('exInfo').textContent = 'Exportación cancelada.';
    }
  } catch (err) {
    console.error(err);
    $('exInfo').textContent = `No se pudo exportar: ${err.message}`;
  } finally {
    exporting = false;
    document.body.classList.remove('exporting');
    $('exStart').disabled = false;
    $('exRes').disabled = $('exFps').disabled = false;
    $('exCancel').textContent = 'Cerrar';
    $('exProgress').hidden = true;
    ({ spinAngle, hueShift } = saved);
    lastSrc = null; // makes the live loop start a fresh trace
    viewW = 0; // and redraw the graticule for the window
    resetLevels();
  }
}
