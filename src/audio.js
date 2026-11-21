// Audio sources. Both expose the same interface for the visualizer:
//   sampleRate, visualSample (index of the sample being heard right now),
//   read(start, n, L, R) -> copies n samples starting at `start` (zero outside the track).

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.offset = 0; // seconds into the track when playback (re)started
    this.startedAt = 0; // ctx.currentTime at that moment
    this.volume = 0.8;
    this.onEnded = null;
  }

  get sampleRate() { return this.buffer ? this.buffer.sampleRate : 48000; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }

  get time() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + this.ctx.currentTime - this.startedAt);
  }

  // Compensate output latency so the picture matches what is being heard.
  get visualSample() {
    const latency = this.playing ? (this.ctx.outputLatency || 0) : 0;
    return Math.floor((this.time - latency) * this.sampleRate);
  }

  async load(arrayBuffer) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.pause();
    this.buffer = buffer;
    this.L = buffer.getChannelData(0);
    this.R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : this.L;
    this.offset = 0;
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.ctx.resume();
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.onended = () => {
      if (this.source !== source) return; // stopped manually
      this.source = null;
      this.playing = false;
      this.offset = this.duration;
      if (this.onEnded) this.onEnded();
    };
    this.startedAt = this.ctx.currentTime;
    source.start(0, this.offset);
    this.source = source;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    const source = this.source;
    this.source = null;
    this.playing = false;
    try { source.stop(); } catch { /* already stopped */ }
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(seconds) {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this.pause();
    this.offset = Math.max(0, Math.min(this.duration, seconds));
    if (wasPlaying) this.play();
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  read(start, n, L, R) {
    const len = this.L.length;
    const from = Math.max(0, start);
    const to = Math.min(len, start + n);
    if (to <= from) { L.fill(0, 0, n); R.fill(0, 0, n); return; }
    const head = from - start;
    const tail = head + (to - from);
    if (head > 0) { L.fill(0, 0, head); R.fill(0, 0, head); }
    L.set(this.L.subarray(from, to), head);
    R.set(this.R.subarray(from, to), head);
    if (tail < n) { L.fill(0, tail, n); R.fill(0, tail, n); }
  }
}

// Silent synthetic signal shown before a track is loaded: slowly morphing Lissajous figures.
export class DemoSource {
  constructor() { this.sampleRate = 48000; }

  get visualSample() { return Math.floor(performance.now() / 1000 * this.sampleRate); }

  read(start, n, L, R) {
    const TAU = Math.PI * 2;
    const ratios = [1.5, 2, 1.25, 3, 4 / 3, 2.5];
    for (let i = 0; i < n; i++) {
      const t = (start + i) / this.sampleRate;
      const ratio = ratios[Math.floor(t / 9) % ratios.length];
      const f = 90;
      const wobble = 0.12 * Math.sin(t * 0.7);
      L[i] = 0.62 * Math.sin(TAU * f * t) + wobble * Math.sin(TAU * f * 5 * t + t);
      R[i] = 0.62 * Math.sin(TAU * f * ratio * t + t * 0.6) + wobble * Math.cos(TAU * f * 3 * t);
    }
  }
}
