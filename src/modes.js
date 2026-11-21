// Visualization modes: turn audio samples into line segments for the beam renderer.
// Segments are written to `out` as [x0, y0, x1, y1, energy] in normalized units
// (1.0 = half of the smaller screen dimension).

export const MAX_SEGS = 20000;
export const SEG_FLOATS = 5;

const MAX_WINDOW = 8192;
// Samples filtered before the part we draw, so the band filters have settled by then.
const WARM = 2048;
const L = new Float32Array(MAX_WINDOW * 2 + 2048 + WARM);
const R = new Float32Array(L.length);

// Last beam position per layer (full signal + 3 bands), so the XY trace is
// continuous from one frame to the next.
const beams = [0, 1, 2, 3].map(() => ({ valid: false, x: 0, y: 0 }));

export function resetBeam() { for (const b of beams) b.valid = false; }

// Running peak level per layer, for automatic gain.
const levels = [0, 0, 0, 0];
export function resetLevels() { levels.fill(0); }

// Scales the samples so the loudest recent peak sits at a fixed size on screen.
// Fast attack, slow release, so quiet passages grow back gradually.
function normalize(band, base, n) {
  let peak = 0;
  for (let i = base; i < base + n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const env = levels[band + 1] = Math.max(peak, levels[band + 1] * 0.995);
  const k = 0.7 / Math.max(env, 0.02);
  for (let i = base; i < base + n; i++) { L[i] *= k; R[i] *= k; }
}

// ctx: { src, pos, prevPos, live, xr, gain } — xr is the half-width of the screen in normalized units.
// band: -1 = full signal, 0 = lows, 1 = mids, 2 = highs.
// layout (optional): { sx, sy, ox, oy } scales and offsets the result, to place bands side by side.
export function buildSegments(s, ctx, out, band = -1, layout = null) {
  const beam = beams[band + 1];
  let c;
  if (s.mode === 'wave') { beam.valid = false; c = wave(s, ctx, out, band); }
  else if (s.mode === 'radial') { beam.valid = false; c = radial(s, ctx, out, band); }
  else c = xy(s, ctx, out, band, beam);
  if (layout) {
    const { sx, sy, ox, oy } = layout;
    for (let i = 0; i < c; i++) {
      const o = i * SEG_FLOATS;
      out[o] = out[o] * sx + ox; out[o + 1] = out[o + 1] * sy + oy;
      out[o + 2] = out[o + 2] * sx + ox; out[o + 3] = out[o + 3] * sy + oy;
    }
  }
  return c;
}

// Second-order Butterworth low/high-pass, in place.
function biquad(a, len, high, f, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr;
  const c = Math.cos(w), alpha = Math.sin(w) / 1.41421356, a0 = 1 + alpha;
  const b0 = (high ? 1 + c : 1 - c) / 2 / a0;
  const b1 = (high ? -(1 + c) : 1 - c) / a0;
  const a1 = -2 * c / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    a[i] = y;
  }
}

// Reads n samples starting at `start` into L/R, isolating one frequency band if asked
// (4th-order Linkwitz-Riley crossover). Returns the index where sample `start` landed.
function fetch(s, src, start, n, band) {
  if (band < 0) {
    src.read(start, n, L, R);
    if (s.autoLevel) normalize(band, 0, n);
    return 0;
  }
  const len = n + WARM, sr = src.sampleRate;
  src.read(start - WARM, len, L, R);
  const lo = s.crossLow, hi = Math.max(s.crossHigh, lo * 1.5);
  for (const ch of [L, R]) {
    for (let pass = 0; pass < 2; pass++) {
      if (band > 0) biquad(ch, len, true, band === 1 ? lo : hi, sr);
      if (band < 2) biquad(ch, len, false, band === 0 ? lo : hi, sr);
    }
  }
  if (s.autoLevel) normalize(band, WARM, n);
  return WARM;
}

function xy(s, { src, pos, prevPos, live, gain }, out, band, beam) {
  const sr = src.sampleRate;
  const d = s.xyMode === 'delay' ? Math.max(1, Math.round(s.delayMs / 1000 * sr)) : 0;
  let n;
  let connect = beam.valid;
  if (live) {
    n = pos - prevPos;
    if (n <= 0) return 0;
    if (n > MAX_WINDOW) { n = MAX_WINDOW; connect = false; } // seek or long stall
  } else {
    n = 2048;
    connect = false;
  }
  const base = fetch(s, src, pos - n + 1 - d, n + d, band);

  const g = gain;
  let px = beam.x, py = beam.y, c = 0;
  for (let k = 0; k < n; k++) {
    const i = base + k, j = i + d;
    let x, y;
    if (s.xyMode === 'ms') {
      x = (L[j] - R[j]) * 0.7071 * g;
      y = (L[j] + R[j]) * 0.7071 * g;
    } else if (s.xyMode === 'delay') {
      x = (L[j] + R[j]) * 0.5 * g;
      y = (L[i] + R[i]) * 0.5 * g;
    } else {
      x = L[j] * g;
      y = R[j] * g;
    }
    if (connect) {
      const o = c * SEG_FLOATS;
      out[o] = px; out[o + 1] = py; out[o + 2] = x; out[o + 3] = y;
      c++;
    }
    connect = true;
    px = x; py = y;
  }
  beam.valid = live;
  beam.x = px; beam.y = py;
  return c;
}

// Reads the latest window of N samples. With trigger on, the window is aligned to a
// rising zero crossing of the low-passed signal so the picture holds still.
// Returns the index in L/R where the window starts.
function readWindow(s, src, pos, N, band) {
  const S = s.trigger ? Math.min(N, 2048) : 0;
  const base = fetch(s, src, pos - (N + S) + 1, N + S, band);
  let t = S;
  if (S) {
    let lp = L[base] + R[base], prev = lp;
    for (let k = 1; k <= S; k++) {
      lp += 0.05 * (L[base + k] + R[base + k] - lp);
      if (prev < 0 && lp >= 0) t = k;
      prev = lp;
    }
  }
  return base + t;
}

function windowSize(s, src) {
  return Math.max(64, Math.min(MAX_WINDOW, Math.round(s.timebaseMs / 1000 * src.sampleRate)));
}

function wave(s, { src, pos, xr, gain }, out, band) {
  const N = windowSize(s, src);
  const t = readWindow(s, src, pos, N, band);
  const w = xr * 0.96;
  const g = gain;
  let c = 0;
  const trace = (pick, amp, offset) => {
    let px = 0, py = 0;
    for (let i = 0; i < N; i++) {
      const x = (-1 + 2 * i / (N - 1)) * w;
      const y = offset + pick(t + i) * amp;
      if (i > 0) {
        const o = c * SEG_FLOATS;
        out[o] = px; out[o + 1] = py; out[o + 2] = x; out[o + 3] = y;
        c++;
      }
      px = x; py = y;
    }
  };
  if (s.splitStereo) {
    trace((i) => L[i], 0.42 * g, 0.47);
    trace((i) => R[i], 0.42 * g, -0.47);
  } else {
    trace((i) => (L[i] + R[i]) * 0.5, 0.8 * g, 0);
  }
  return c;
}

function radial(s, { src, pos, gain }, out, band) {
  const N = windowSize(s, src);
  const t = readWindow(s, src, pos, N, band);
  const g = gain * 0.4;
  const taper = N * 0.06; // fade the ends so the ring closes cleanly
  let c = 0, px = 0, py = 0, fx = 0, fy = 0;
  for (let i = 0; i < N; i++) {
    let k = Math.min(1, i / taper, (N - 1 - i) / taper);
    k = k * k * (3 - 2 * k);
    const r = s.radius + (L[t + i] + R[t + i]) * 0.5 * g * k;
    const a = Math.PI * 2 * i / N;
    const x = Math.sin(a) * r, y = Math.cos(a) * r;
    if (i === 0) { fx = x; fy = y; } else {
      const o = c * SEG_FLOATS;
      out[o] = px; out[o + 1] = py; out[o + 2] = x; out[o + 3] = y;
      c++;
    }
    px = x; py = y;
  }
  const o = c * SEG_FLOATS;
  out[o] = px; out[o + 1] = py; out[o + 2] = fx; out[o + 3] = fy;
  return c + 1;
}
