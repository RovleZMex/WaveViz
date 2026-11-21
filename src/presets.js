// Settings model: defaults, built-in presets, the control schema that drives the
// settings panel, and persistence of the user's own presets.

export const DEFAULTS = {
  mode: 'xy',
  xyMode: 'lr',
  delayMs: 4,
  timebaseMs: 30,
  trigger: true,
  splitStereo: false,
  radius: 0.5,
  gain: 1,
  zoom: 1,
  color: '#3dff6e',
  hueSpeed: 0,
  hueSpread: 0,
  intensity: 1,
  beamWidth: 1.4,
  persistence: 0.12,
  glow: 0.6,
  glowSize: 1,
  rotation: 0,
  spin: 0,
  symmetry: 1,
  mirror: false,
  background: '#020604',
  grid: true,
};

export const BUILTIN = [
  { name: 'Osciloscopio XY', settings: {} },
  {
    name: 'Retrato de fase',
    settings: { xyMode: 'delay', delayMs: 3.5, gain: 1.6, color: '#35c8ff', background: '#01040a', persistence: 0.2, glow: 0.9, grid: false },
  },
  {
    name: 'Mandala',
    settings: {
      xyMode: 'delay', delayMs: 5, gain: 1.5, zoom: 1.1, color: '#ff3d9a', hueSpeed: 25, hueSpread: 0.5,
      persistence: 0.35, glow: 1, glowSize: 1.4, symmetry: 6, mirror: true, spin: 8, background: '#05020a', grid: false,
    },
  },
  {
    name: 'Onda clásica',
    settings: { mode: 'wave', timebaseMs: 25, gain: 1.2, color: '#ffb000', background: '#070400', persistence: 0.08, beamWidth: 1.6 },
  },
  {
    name: 'Anillo',
    settings: {
      mode: 'radial', timebaseMs: 40, gain: 1.5, color: '#b56bff', hueSpeed: 15, persistence: 0.18, glow: 1.1,
      glowSize: 1.5, spin: 12, background: '#04020a', grid: false,
    },
  },
];

const isXY = (s) => s.mode === 'xy';
const isWindowed = (s) => s.mode !== 'xy';

export const SCHEMA = [
  {
    title: 'Visualización',
    items: [
      { key: 'mode', type: 'select', label: 'Modo', options: [['xy', 'Osciloscopio XY'], ['wave', 'Onda'], ['radial', 'Radial']] },
      {
        key: 'xyMode', type: 'select', label: 'Entrada XY', when: isXY,
        options: [['lr', 'Izquierdo → X, Derecho → Y'], ['ms', 'Mid/Side (rotado 45°)'], ['delay', 'Retardo (retrato de fase)']],
      },
      { key: 'delayMs', type: 'range', label: 'Retardo', min: 0.2, max: 20, step: 0.1, unit: ' ms', when: (s) => isXY(s) && s.xyMode === 'delay' },
      { key: 'timebaseMs', type: 'range', label: 'Ventana de tiempo', min: 5, max: 150, step: 1, unit: ' ms', when: isWindowed },
      { key: 'trigger', type: 'check', label: 'Estabilizar (trigger)', when: isWindowed },
      { key: 'splitStereo', type: 'check', label: 'Separar canales L/R', when: (s) => s.mode === 'wave' },
      { key: 'radius', type: 'range', label: 'Radio', min: 0.1, max: 0.9, step: 0.01, when: (s) => s.mode === 'radial' },
      { key: 'gain', type: 'range', label: 'Ganancia de señal', min: 0.1, max: 6, step: 0.05, unit: '×' },
      { key: 'zoom', type: 'range', label: 'Zoom', min: 0.3, max: 2.5, step: 0.01, unit: '×' },
    ],
  },
  {
    title: 'Haz',
    items: [
      { key: 'color', type: 'color', label: 'Color' },
      { key: 'hueSpeed', type: 'range', label: 'Ciclo de color', min: 0, max: 180, step: 1, unit: ' °/s' },
      { key: 'hueSpread', type: 'range', label: 'Arcoíris por simetría', min: 0, max: 1, step: 0.01, when: (s) => s.symmetry > 1 || s.mirror },
      { key: 'intensity', type: 'range', label: 'Intensidad', min: 0.1, max: 5, step: 0.05 },
      { key: 'beamWidth', type: 'range', label: 'Grosor', min: 0.6, max: 6, step: 0.1, unit: ' px' },
      { key: 'persistence', type: 'range', label: 'Persistencia', min: 0, max: 2, step: 0.01, unit: ' s' },
      { key: 'glow', type: 'range', label: 'Resplandor', min: 0, max: 3, step: 0.05 },
      { key: 'glowSize', type: 'range', label: 'Tamaño del resplandor', min: 0.3, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Geometría',
    items: [
      { key: 'rotation', type: 'range', label: 'Rotación', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'spin', type: 'range', label: 'Giro automático', min: -90, max: 90, step: 1, unit: ' °/s' },
      { key: 'symmetry', type: 'range', label: 'Simetría (copias)', min: 1, max: 12, step: 1 },
      { key: 'mirror', type: 'check', label: 'Espejo' },
    ],
  },
  {
    title: 'Fondo',
    items: [
      { key: 'background', type: 'color', label: 'Color de fondo' },
      { key: 'grid', type: 'check', label: 'Retícula' },
    ],
  },
];

// Keeps only known keys with the right type and clamps numbers to their slider range.
export function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const items = new Map(SCHEMA.flatMap((sec) => sec.items).map((it) => [it.key, it]));
  for (const key of Object.keys(DEFAULTS)) {
    const v = raw[key];
    const item = items.get(key);
    if (typeof v !== typeof DEFAULTS[key]) continue;
    if (item.type === 'range') {
      if (Number.isFinite(v)) out[key] = Math.max(item.min, Math.min(item.max, v));
    } else if (item.type === 'select') {
      if (item.options.some(([value]) => value === v)) out[key] = v;
    } else if (item.type === 'color') {
      if (/^#[0-9a-f]{6}$/i.test(v)) out[key] = v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

const SETTINGS_KEY = 'waveviz.settings';
const PRESETS_KEY = 'waveviz.presets';

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function loadSettings() { return sanitize(readJson(SETTINGS_KEY)); }
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

export function loadUserPresets() {
  const list = readJson(PRESETS_KEY);
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({ name: p.name.trim().slice(0, 40), settings: sanitize(p.settings) }));
}

export function saveUserPresets(list) { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); }
