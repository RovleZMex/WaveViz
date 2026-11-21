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
  if (s.mode !== 'xy') beam.valid = false;
  let c;
  switch (s.mode) {
    case 'wave': c = wave(s, ctx, out, band); break;
    case 'radial': c = radial(s, ctx, out, band); break;
    case 'tunnel': c = tunnel(s, ctx, out, band); break;
    case 'sphere': c = sphere(s, ctx, out, band); break;
    case 'face': c = face(s, ctx, out, band); break;
    default: c = xy(s, ctx, out, band, beam);
  }
  if (layout) {
    const { sx, sy, ox, oy } = layout;
    const wk = WEIGHTED.has(s.mode) ? Math.min(sx, sy) : 1;
    for (let i = 0; i < c; i++) {
      const o = i * SEG_FLOATS;
      out[o] = out[o] * sx + ox; out[o + 1] = out[o + 1] * sy + oy;
      out[o + 2] = out[o + 2] * sx + ox; out[o + 3] = out[o + 3] * sy + oy;
      out[o + 4] *= wk;
    }
  }
  return c;
}

// Modes that draw a figure rather than a signal trace. They write a weight for each
// segment (its length times a fade factor) so that lines get the same brightness per
// unit length however many there are; the caller turns weights into light.
export const WEIGHTED = new Set(['tunnel', 'sphere', 'face']);

let sink = null, sinkCount = 0;
function seg(x0, y0, x1, y1, fade = 1) {
  if (sinkCount >= MAX_SEGS) return;
  const o = sinkCount++ * SEG_FLOATS;
  sink[o] = x0; sink[o + 1] = y0; sink[o + 2] = x1; sink[o + 3] = y1;
  sink[o + 4] = Math.hypot(x1 - x0, y1 - y0) * fade;
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

// Tunnel: depth is time. Every ring is a snapshot of the waveform, born small at the
// vanishing point and flying toward the viewer, so you travel through the song's past.
function tunnel(s, { src, pos, gain }, out, band) {
  sink = out; sinkCount = 0;
  const sr = src.sampleRate;
  const rings = Math.round(6 + s.detail * 24);
  const step = Math.max(64, Math.round(sr / (1.5 + 6 * s.motion)));
  const N = windowSize(s, src);
  const P = Math.min(N, 720, Math.floor(15000 / rings));
  const newest = Math.floor(pos / step);
  for (let j = 0; j < rings; j++) {
    const m = newest - j;
    const age = (pos - m * step) / step; // 0 = just born, `rings` = passing the camera
    const z = 1 - age / rings;
    const r = 0.1 / (z + 0.05);
    const fade = Math.min(1, age) * Math.min(1, (rings - age) / 1.5);
    const base = fetch(s, src, m * step - N + 1, N, band);
    const twist = m * 0.4;
    const taper = P * 0.06;
    let px = 0, py = 0, fx = 0, fy = 0;
    for (let p = 0; p < P; p++) {
      const i = base + Math.floor(p * N / P);
      let k = Math.min(1, p / taper, (P - 1 - p) / taper);
      k = k * k * (3 - 2 * k);
      const rad = r * (1 + (L[i] + R[i]) * 0.5 * gain * 0.45 * k);
      const a = Math.PI * 2 * p / P + twist;
      const x = Math.sin(a) * rad, y = Math.cos(a) * rad;
      if (p === 0) { fx = x; fy = y; } else seg(px, py, x, y, fade);
      px = x; py = y;
    }
    seg(px, py, fx, fy, fade);
  }
  return sinkCount;
}

// Sphere: the waveform is wound around a globe as one long spiral that pushes the
// surface in and out, then the globe turns in 3D. The far side is drawn dimmer.
function sphere(s, { src, pos, gain }, out, band) {
  sink = out; sinkCount = 0;
  const N = windowSize(s, src);
  const t0 = readWindow(s, src, pos, N, band);
  const M = Math.max(2400, Math.min(6000, N));
  const turns = Math.round(6 + s.detail * 40);
  const t = pos / src.sampleRate;
  const ry = t * 0.5 * s.motion;
  const rx = 0.45 + 0.25 * Math.sin(t * 0.23 * s.motion);
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  const R0 = 0.62, CAM = 2.6;
  let px = 0, py = 0, pf = 0;
  for (let i = 0; i < M; i++) {
    const u = i / (M - 1);
    const th = Math.PI * u, ph = Math.PI * 2 * turns * u;
    const f = u * (N - 1), i0 = Math.min(N - 2, Math.floor(f)), fr = f - i0;
    const a = t0 + i0;
    const smp = ((L[a] + R[a]) * (1 - fr) + (L[a + 1] + R[a + 1]) * fr) * 0.5;
    const st = Math.sin(th);
    const rr = R0 * (1 + smp * gain * 0.35 * Math.sqrt(st));
    const x0 = rr * st * Math.cos(ph), y0 = rr * Math.cos(th), z0 = rr * st * Math.sin(ph);
    const x1 = x0 * cy + z0 * sy, z1 = -x0 * sy + z0 * cy;
    const y2 = y0 * cx - z1 * sx, z2 = y0 * sx + z1 * cx;
    const persp = CAM / (CAM - z2);
    const x = x1 * persp, y = y2 * persp;
    const fade = 0.2 + 0.8 * Math.max(0, Math.min(1, z2 / R0 * 0.5 + 0.5));
    if (i > 0) seg(px, py, x, y, (fade + pf) * 0.5);
    px = x; py = y; pf = fade;
  }
  return sinkCount;
}

// Singer: a face drawn by the beam that performs the song. The mouth opens with the
// volume and its lower lip is the waveform, eyebrows jump with the bass and frown with
// the treble, the eyes widen when it gets loud, the pupils are tiny phase portraits and
// the outline of the head is the waveform itself.
const singers = [0, 1, 2, 3].map(() => ({ lvl: 0, bass: 0, high: 0, max: 1e-3 }));

function face(s, { src, pos, gain, live }, out, band) {
  sink = out; sinkCount = 0;
  const sr = src.sampleRate, N = 1024;
  const base = fetch(s, src, pos - N + 1, N, band);
  const st = singers[band + 1];

  // Loudness overall, of the lows and of the highs, relative to the recent maximum.
  const aLow = 1 - Math.exp(-2 * Math.PI * 150 / sr), aHigh = 1 - Math.exp(-2 * Math.PI * 3000 / sr);
  let lp = 0, lp2 = 0, e = 0, eb = 0, eh = 0;
  for (let i = base; i < base + N; i++) {
    const m = (L[i] + R[i]) * 0.5;
    lp += aLow * (m - lp); lp2 += aHigh * (m - lp2);
    e += m * m; eb += lp * lp; eh += (m - lp2) * (m - lp2);
  }
  const rms = Math.sqrt(e / N);
  st.max = Math.max(rms, st.max * (live ? 0.999 : 1), 1e-4);
  const follow = (key, target) => {
    target = Math.min(1, target);
    st[key] += (target - st[key]) * (target > st[key] ? 0.6 : 0.2);
    return st[key];
  };
  const quiet = rms < 1e-4;
  const lvl = follow('lvl', quiet ? 0 : rms / st.max * gain);
  const bass = follow('bass', quiet ? 0 : Math.sqrt(eb / N) / st.max * 1.3 * gain);
  const high = follow('high', quiet ? 0 : Math.sqrt(eh / N) / st.max * 3 * gain);
  const norm = 0.3 / st.max; // brings samples to roughly ±1
  const mono = (i) => (L[base + i] + R[base + i]) * 0.5 * norm;

  // The whole head bobs and tilts in time.
  const t = pos / sr;
  const bob = 0.05 * Math.sin(Math.PI * 2 * t * s.motion) - 0.06 * bass;
  const tilt = 0.1 * Math.sin(Math.PI * t * s.motion);
  const ct = Math.cos(tilt), sn = Math.sin(tilt);
  const line = (pts) => {
    for (let i = 2; i < pts.length; i += 2) {
      seg(pts[i - 2] * ct - pts[i - 1] * sn, pts[i - 2] * sn + pts[i - 1] * ct + bob,
        pts[i] * ct - pts[i + 1] * sn, pts[i] * sn + pts[i + 1] * ct + bob);
    }
  };

  // Head.
  const head = [];
  const HP = 200;
  for (let p = 0; p <= HP; p++) {
    const a = Math.PI * 2 * p / HP;
    let k = Math.min(1, p / 14, (HP - p) / 14);
    k = k * k * (3 - 2 * k);
    const r = 0.82 + mono(Math.floor(p * (N - 1) / HP)) * 0.05 * k;
    head.push(Math.sin(a) * r, -Math.cos(a) * r);
  }
  line(head);

  for (const side of [-1, 1]) {
    const ex = side * 0.3, ey = 0.2;
    // Eye.
    const rx = 0.14, ry = 0.14 * (0.7 + 0.65 * lvl);
    const eye = [];
    for (let p = 0; p <= 40; p++) {
      const a = Math.PI * 2 * p / 40;
      eye.push(ex + Math.cos(a) * rx, ey + Math.sin(a) * ry);
    }
    line(eye);
    // Pupil: the signal against a delayed copy of itself.
    const pupil = [];
    for (let i = N - 200; i < N; i++) {
      pupil.push(ex + Math.max(-1, Math.min(1, mono(i))) * 0.07, ey + Math.max(-1, Math.min(1, mono(i - 40))) * ry * 0.5);
    }
    line(pupil);
    // Eyebrow.
    const by = 0.44 + 0.14 * bass;
    line([side * 0.16, by - 0.09 * high, side * 0.44, by + 0.03]);
  }

  // Mouth.
  const my = -0.36, half = 0.34 - 0.08 * lvl;
  const upper = [], lower = [];
  for (let p = 0; p <= 48; p++) {
    const u = -1 + 2 * p / 48, shape = 1 - u * u;
    const y = my + 0.07 * u * u;
    upper.push(u * half, y + 0.05 * lvl * shape);
    const wave = Math.max(-1, Math.min(1, mono(N - 1 - 48 * 6 + p * 6)));
    lower.push(u * half, y - (0.02 + 0.32 * lvl) * shape + wave * 0.06 * lvl * shape);
  }
  line(upper);
  line(lower);
  return sinkCount;
}
