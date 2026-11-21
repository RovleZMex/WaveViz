// Visualization modes: turn audio samples into line segments for the beam renderer.
// Segments are written to `out` as [x0, y0, x1, y1, energy] in normalized units
// (1.0 = half of the smaller screen dimension).

export const MAX_SEGS = 20000;
export const SEG_FLOATS = 5;

const MAX_WINDOW = 8192;
const L = new Float32Array(MAX_WINDOW * 2 + 2048);
const R = new Float32Array(L.length);

// Last beam position, so the XY trace is continuous from one frame to the next.
const beam = { valid: false, x: 0, y: 0 };

export function resetBeam() { beam.valid = false; }

// ctx: { src, pos, prevPos, live, xr } — xr is the half-width of the screen in normalized units.
export function buildSegments(s, ctx, out) {
  switch (s.mode) {
    case 'wave': beam.valid = false; return wave(s, ctx, out);
    case 'radial': beam.valid = false; return radial(s, ctx, out);
    default: return xy(s, ctx, out);
  }
}

function xy(s, { src, pos, prevPos, live }, out) {
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
  src.read(pos - n + 1 - d, n + d, L, R);

  const g = s.gain;
  let px = beam.x, py = beam.y, c = 0;
  for (let i = 0; i < n; i++) {
    const j = i + d;
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
function readWindow(s, src, pos, N) {
  const S = s.trigger ? Math.min(N, 2048) : 0;
  src.read(pos - (N + S) + 1, N + S, L, R);
  let t = S;
  if (S) {
    let lp = L[0] + R[0], prev = lp;
    for (let k = 1; k <= S; k++) {
      lp += 0.05 * (L[k] + R[k] - lp);
      if (prev < 0 && lp >= 0) t = k;
      prev = lp;
    }
  }
  return t;
}

function windowSize(s, src) {
  return Math.max(64, Math.min(MAX_WINDOW, Math.round(s.timebaseMs / 1000 * src.sampleRate)));
}

function wave(s, { src, pos, xr }, out) {
  const N = windowSize(s, src);
  const t = readWindow(s, src, pos, N);
  const w = xr * 0.96;
  const g = s.gain;
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

function radial(s, { src, pos }, out) {
  const N = windowSize(s, src);
  const t = readWindow(s, src, pos, N);
  const g = s.gain * 0.4;
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
