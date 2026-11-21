// WebGL2 beam renderer. Simulates a CRT oscilloscope:
//  - each segment deposits a fixed amount of light, spread along its length with a
//    gaussian beam profile (so a fast-moving beam draws dimmer, like real phosphor)
//  - light accumulates in a float buffer that decays exponentially (persistence)
//  - a blurred copy is added as glow, then everything is tone-mapped to the screen

import { MAX_SEGS, SEG_FLOATS } from './modes.js';

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FILL_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(1.0); }`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aSeg;
layout(location = 1) in float aEnergy;
uniform mat2 uXform;
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uRes;
uniform float uSigma;
out vec2 vLocal;
flat out float vLen;
flat out float vEnergy;
void main() {
  vec2 a = uCenter + (uXform * aSeg.xy) * uScale;
  vec2 b = uCenter + (uXform * aSeg.zw) * uScale;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float pad = uSigma * 3.5;
  float cx = float(gl_VertexID & 1);
  float cy = float((gl_VertexID >> 1) & 1);
  vec2 local = vec2(cx * (len + 2.0 * pad) - pad, (cy * 2.0 - 1.0) * pad);
  vec2 p = a + dir * local.x + nrm * local.y;
  vLocal = local;
  vLen = len;
  vEnergy = aEnergy;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vLen;
flat in float vEnergy;
uniform float uSigma;
uniform vec3 uColor;
out vec4 o;
float erf(float x) {
  float s = sign(x), a = abs(x);
  float t = 1.0 + (0.278393 + (0.230389 + 0.078108 * a * a) * a) * a;
  t *= t;
  return s - s / (t * t);
}
void main() {
  float s = uSigma;
  float norm = 1.0 / (2.50662827 * s);
  float gy = exp(-vLocal.y * vLocal.y / (2.0 * s * s)) * norm;
  float gx;
  if (vLen < 0.05) {
    gx = exp(-vLocal.x * vLocal.x / (2.0 * s * s)) * norm;
  } else {
    float k = 1.0 / (1.41421356 * s);
    gx = (erf(vLocal.x * k) - erf((vLocal.x - vLen) * k)) / (2.0 * vLen);
  }
  o = vec4(uColor * (vEnergy * gx * gy), 1.0);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  o = vec4(c * 0.25, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270;
  c += (texture(uTex, vUv + uStep * 1.3846154).rgb + texture(uTex, vUv - uStep * 1.3846154).rgb) * 0.3162162;
  c += (texture(uTex, vUv + uStep * 3.2307692).rgb + texture(uTex, vUv - uStep * 3.2307692).rgb) * 0.0702703;
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAccum;
uniform sampler2D uBloom;
uniform float uGlow;
uniform vec3 uBg;
out vec4 o;
void main() {
  vec3 c = texture(uAccum, vUv).rgb + uGlow * texture(uBloom, vUv).rgb;
  vec3 m = 1.0 - exp(-c);
  o = vec4(uBg * (1.0 - m) + m, 1.0);
}`;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 no está disponible en este equipo');
    this.gl = gl;
    this.canvas = canvas;
    // Float render targets let the trail fade smoothly to true black.
    this.float = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));

    this.fill = this.program(FULLSCREEN_VS, FILL_FS);
    this.line = this.program(LINE_VS, LINE_FS);
    this.down = this.program(FULLSCREEN_VS, DOWN_FS);
    this.blur = this.program(FULLSCREEN_VS, BLUR_FS);
    this.composite = this.program(FULLSCREEN_VS, COMPOSITE_FS);

    this.emptyVao = gl.createVertexArray();
    this.lineVao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_SEGS * SEG_FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = SEG_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.width = 0;
    this.height = 0;
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      uniforms[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, u: uniforms };
  }

  target(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }

  freeTarget(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    [this.accum, this.bloomA, this.bloomB].forEach((t) => this.freeTarget(t));
    this.accum = this.target(w, h);
    const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
    this.bloomA = this.target(bw, bh);
    this.bloomB = this.target(bw, bh);
    return true;
  }

  pass(prog, target, tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.useProgram(prog.prog);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
  }

  // A frame is begin() -> draw() once per layer -> end().

  // Fades what is already on the phosphor. decay: fraction of light kept (0 = clear).
  begin(decay) {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    this.pass(this.fill, this.accum);
    if (decay <= 0) {
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.enable(gl.BLEND);
      gl.blendColor(decay, decay, decay, 1);
      gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // Adds beam segments. p: { segs, count, copies:[{mat, color}], sigma, scale }
  draw(p) {
    const gl = this.gl;
    if (p.count > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.line.prog);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.segs, 0, p.count * SEG_FLOATS);
      const u = this.line.u;
      gl.uniform2f(u.uCenter, this.width / 2, this.height / 2);
      gl.uniform2f(u.uRes, this.width, this.height);
      gl.uniform1f(u.uScale, p.scale);
      gl.uniform1f(u.uSigma, p.sigma);
      for (const copy of p.copies) {
        gl.uniformMatrix2fv(u.uXform, false, copy.mat);
        gl.uniform3fv(u.uColor, copy.color);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, p.count);
      }
    }
  }

  // Blurs a copy for the glow and tone-maps everything to the screen.
  // p: { glow, glowSize, glowScale, bg } — glowScale is device pixels per CSS pixel, so the
  // glow keeps its apparent size at any resolution.
  end(p) {
    const gl = this.gl;
    const { accum, bloomA, bloomB } = this;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    if (p.glow > 0) {
      this.pass(this.down, bloomA, accum.tex);
      gl.uniform2f(this.down.u.uTexel, 1 / accum.w, 1 / accum.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Passes with growing radius; enough of them to reach the blur width we need.
      const k = Math.max(1, p.glowScale || 1);
      let passes = 2, sum = 5;
      while (sum < 5 * k * k && passes < 6) { passes++; sum += passes * passes; }
      const unit = p.glowSize * Math.sqrt(5 * k * k / sum);
      for (let i = 0; i < passes; i++) {
        const r = unit * (i + 1);
        this.pass(this.blur, bloomB, bloomA.tex);
        gl.uniform2f(this.blur.u.uStep, r / bloomA.w, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.pass(this.blur, bloomA, bloomB.tex);
        gl.uniform2f(this.blur.u.uStep, 0, r / bloomA.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    this.pass(this.composite, null, accum.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(this.composite.u.uAccum, 0);
    gl.uniform1i(this.composite.u.uBloom, 1);
    gl.uniform1f(this.composite.u.uGlow, p.glow);
    gl.uniform3fv(this.composite.u.uBg, p.bg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
