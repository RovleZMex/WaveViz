// Offline video export: renders every frame at a fixed timestep (so the result is
// frame-perfect no matter how fast the machine is), encodes video and audio with
// WebCodecs and muxes them into an MP4 file.

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

async function firstSupported(Encoder, candidates) {
  for (const c of candidates) {
    try {
      const res = await Encoder.isConfigSupported(c.config);
      if (res.supported) return c;
    } catch { /* try the next one */ }
  }
  return null;
}

// Yields to the event loop without the throttling that timers get in background windows.
const channel = new MessageChannel();
function breathe() {
  return new Promise((resolve) => {
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(0);
  });
}

function drained(encoder) {
  if (encoder.encodeQueueSize <= 4) return null;
  return new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
}

// opts: { L, R, sampleRate, width, height, fps, drawFrame(samplePos) -> canvas,
//         onProgress(fraction), isCancelled() }
// Resolves to { blob, video, audio } or null if cancelled.
export async function exportVideo(opts) {
  const { L, R, sampleRate, width, height, fps } = opts;
  if (!('VideoEncoder' in window) || !('AudioEncoder' in window)) {
    throw new Error('Este sistema no tiene codificadores de video disponibles');
  }

  const bitrate = Math.round(width * height * fps * 0.1);
  const big = width * height > 1920 * 1080;
  const video = await firstSupported(VideoEncoder, [
    { mux: 'avc', config: { codec: big ? 'avc1.640034' : 'avc1.64002a', width, height, bitrate, framerate: fps } },
    { mux: 'avc', config: { codec: big ? 'avc1.420034' : 'avc1.42002a', width, height, bitrate, framerate: fps } },
    { mux: 'vp9', config: { codec: 'vp09.00.51.08', width, height, bitrate, framerate: fps } },
  ]);
  const audio = await firstSupported(AudioEncoder, [
    { mux: 'aac', config: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 192000 } },
    { mux: 'opus', config: { codec: 'opus', sampleRate, numberOfChannels: 2, bitrate: 192000 } },
  ]);
  if (!video) throw new Error('Ningún codificador de video admite esa resolución');
  if (!audio) throw new Error('No hay codificador de audio compatible');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: video.mux, width, height, frameRate: fps },
    audio: { codec: audio.mux, numberOfChannels: 2, sampleRate },
    fastStart: 'in-memory',
  });

  let failure = null;
  const fail = (e) => { failure = failure || e; };
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
  venc.configure(video.config);
  aenc.configure(audio.config);

  const close = () => {
    for (const enc of [venc, aenc]) if (enc.state !== 'closed') enc.close();
  };

  const totalSamples = L.length;
  const totalFrames = Math.max(1, Math.ceil(totalSamples / sampleRate * fps));
  let audioPos = 0;
  const encodeAudioUntil = (end) => {
    while (audioPos < end) {
      const n = Math.min(sampleRate, totalSamples - audioPos);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(audioPos, audioPos + n), 0);
      data.set(R.subarray(audioPos, audioPos + n), n);
      const chunk = new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round(audioPos / sampleRate * 1e6), data,
      });
      aenc.encode(chunk);
      chunk.close();
      audioPos += n;
    }
  };

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (opts.isCancelled()) { close(); return null; }
      if (failure) throw failure;

      const pos = Math.round(f / fps * sampleRate);
      // Keep audio about a second ahead of video so the file stays interleaved.
      encodeAudioUntil(Math.min(totalSamples, pos + sampleRate));

      const canvas = opts.drawFrame(pos);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(f * 1e6 / fps),
        duration: Math.round(1e6 / fps),
      });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();

      const wait = drained(venc);
      if (wait) await wait;
      if (f % 6 === 0) {
        opts.onProgress(f / totalFrames);
        await breathe();
      }
    }
    encodeAudioUntil(totalSamples);
    await venc.flush();
    await aenc.flush();
    if (failure) throw failure;
    muxer.finalize();
  } catch (err) {
    close();
    throw err;
  }
  close();
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), video: video.mux, audio: audio.mux };
}
