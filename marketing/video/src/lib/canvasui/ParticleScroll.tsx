"use client";

/**
 * VENDORED from Canvas UI (https://canvasui.dev) — MIT + Commons Clause.
 * We are not selling it, so the Commons Clause doesn't bite.
 *
 * Upstream this is a scroll-driven page effect. Patched for Remotion:
 *   - `manual: true` suppresses the rAF loop and swaps the scroll-derived
 *     formation line for an explicit 0→1 `progress`.
 *   - `renderFrame({progress, time})` snaps every row to its target (no damped
 *     settle) and draws one frame, so a render is a pure function of `frame`.
 * The shaders are UNMODIFIED. The wipe runs sideways because the effect is
 * applied in a rotated frame (see ParticleScrollFrame.tsx), not because the
 * axis math was forked.
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface ParticleScrollOptions {
  /** Remotion: suppress the rAF loop; drive with renderFrame() instead. */
  manual?: boolean;
  /** Composite over what's behind instead of painting an opaque surface. */
  transparent?: boolean;
  /** Viewport fraction of the formation line. Content assembles as it scrolls up past this line and dissolves back below it. */
  point?: number;
  /** Height in CSS pixels of the transition band where particles progressively reassemble. */
  band?: number;
  /** Grain spacing in CSS pixels. Smaller values mean finer, denser sand. */
  density?: number;
  /** Size of fully scattered dust grains in CSS pixels. Grains grow to cover their cell as they land. */
  size?: number;
  /** Maximum distance in CSS pixels particles scatter from their home position. */
  spread?: number;
  /** Downward bias of the scattered cloud (-1 to 1), like sand settling. Negative values lift it. */
  gravity?: number;
  /** Idle float speed of scattered particles (0 to 1). 0 freezes the cloud. */
  drift?: number;
  /** Sideways arc in CSS pixels particles take while flying home. */
  swirl?: number;
  /** Per-particle randomness of reassembly timing (0 to 1). */
  stagger?: number;
  /** Opacity of fully scattered particles (0 to 1). */
  fade?: number;
  /** Seconds a row of dust takes to condense into the page once the reveal reaches it. */
  settle?: number;
  /** Seconds the damped scroll takes to catch up with the real scroll. Higher feels more fluid. */
  smoothing?: number;
}

export interface ParticleScrollElements {
  /** Canvas with layoutsubtree that hosts the HTML content. */
  source: HTMLCanvasElement;
  /** The scrollable element inside the source canvas that gets captured. */
  content: HTMLElement;
  /** Canvas the WebGL effect renders to. */
  output: HTMLCanvasElement;
}

export interface ParticleScrollInstance {
  /** Remotion: recapture the HTML and draw exactly one frame.
   *  `progress` 0 = every grain scattered, 1 = fully assembled. */
  renderFrame: (state: { progress: number; time: number }) => void;
  /** Update effect options live. */
  setOptions: (options: ParticleScrollOptions) => void;
  /** Re-read canvas size. Call when the element is resized. */
  resize: () => void;
  /** Stop the loop and release all GPU resources. */
  destroy: () => void;
}

const DEFAULTS: Required<ParticleScrollOptions> = {
  manual: false,
  transparent: false,
  point: 0.68,
  band: 420,
  density: 2,
  size: 1.25,
  spread: 220,
  gravity: 0.35,
  drift: 0.7,
  swirl: 60,
  stagger: 0.7,
  fade: 0.85,
  settle: 1.2,
  smoothing: 0.6,
};

type UniformName =
  | 'uBg' | 'uContent' | 'uCover' | 'uDensity' | 'uDpr' | 'uDrift' | 'uFade'
  | 'uGravity' | 'uGrid' | 'uLag' | 'uMaxX' | 'uRes' | 'uRowCount' | 'uRowTex'
  | 'uScroll' | 'uSize' | 'uSpread' | 'uStagger' | 'uSwirl' | 'uTime' | 'uTransparent'
  | 'uWinStart';

type PaintableCanvas = HTMLCanvasElement & {
  onpaint?: (() => void) | null;
  requestPaint?: () => void;
};

type ElementImageContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: Element, x: number, y: number) => void;
};

const HASH = `
float hash (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}`;

const QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BASE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform sampler2D uRowTex;
uniform vec2 uRes;
uniform float uDensity;
uniform float uRowCount;
uniform float uStagger;
uniform float uMaxX;
uniform float uCover;
uniform float uTransparent;
uniform float uScroll;
uniform float uWinStart;
uniform vec3 uBg;
${HASH}
void main () {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec2 cell = floor(vec2(px.x, px.y + uScroll) / uDensity);
  float h1 = hash(cell);
  float d = h1 * uStagger;
  int row = int(clamp(cell.y - uWinStart, 0.0, uRowCount - 1.0));
  float p = texelFetch(uRowTex, ivec2(row, 0), 0).r;
  float t = clamp((p - d) / max(1.0 - d, 1e-3), 0.0, 1.0);
  float vis = step(0.9995, t) * step(px.x, uMaxX * uRes.x);
  vec4 tex = texture(uContent, vec2(vUv.x, 1.0 - vUv.y));
  // VENDOR PATCH: upstream always paints an OPAQUE surface, so two instances
  // can never be layered — the top one simply hides everything under it. In
  // transparent mode the assembled content keeps its own alpha instead, which
  // lets a dust layer composite over other effects.
  outColor = uTransparent > 0.5
    ? vec4(tex.rgb, vis * tex.a)
    : vec4(mix(uBg, tex.rgb, vis * tex.a), uCover);
}`;

const POINT_VERT = `#version 300 es
precision highp float;
uniform sampler2D uRowTex;
uniform vec2 uRes;
uniform vec2 uGrid;
uniform float uDensity;
uniform float uStagger;
uniform float uSpread;
uniform float uGravity;
uniform float uDrift;
uniform float uSwirl;
uniform float uTime;
uniform float uFade;
uniform float uSize;
uniform float uDpr;
uniform float uMaxX;
uniform float uLag;
uniform float uScroll;
uniform float uWinStart;
out vec2 vCenter;
out float vSize;
out float vAlpha;
out float vLod;
out float vMerge;
${HASH}
void main () {
  float fid = float(gl_VertexID);
  vec2 local = vec2(mod(fid, uGrid.x), floor(fid / uGrid.x));
  vec2 cell = vec2(local.x, local.y + uWinStart);
  float h1 = hash(cell);
  float h2 = hash(cell + vec2(1.7, 9.1));
  float h3 = hash(cell + vec2(5.5, 2.9));
  float h4 = hash(cell + vec2(8.4, 4.2));
  float d = h1 * uStagger;
  vec2 home = vec2(
    (cell.x + 0.5) * uDensity,
    (cell.y + 0.5) * uDensity - uScroll
  );
  int row = int(clamp(local.y, 0.0, uGrid.y - 1.0));
  float p = texelFetch(uRowTex, ivec2(row, 0), 0).r;
  float t = clamp((p - d) / max(1.0 - d, 1e-3), 0.0, 1.0);
  float e = 1.0 - pow(1.0 - t, 3.0);
  float vis = (1.0 - step(0.9995, t))
    * step(home.x, uMaxX * uRes.x)
    * step(home.y, uRes.y)
    * step(-uDensity, home.y);
  if (vis < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCenter = vec2(0.0);
    vSize = 0.0;
    vAlpha = 0.0;
    vLod = 0.0;
    vMerge = 0.0;
    return;
  }
  vec2 dir = normalize(vec2(h2 - 0.5, h3 - 0.5) + vec2(1e-4, 0.0));
  float reach = 0.08 + 0.92 * pow(h4, 2.4);
  vec2 off = dir * uSpread * reach;
  off.y += uGravity * uSpread * (0.25 + 0.75 * h4);
  vec2 scat = home + off;
  vec2 pos = mix(scat, home, e);
  vec2 perp = vec2(-dir.y, dir.x);
  pos += perp * (h2 - 0.5) * 2.0 * uSwirl * sin(e * 3.14159);
  float tt = uTime * uDrift;
  float amp = (1.0 - e) * (uSpread * 0.05 + 2.5);
  pos += vec2(
    sin(tt * (4.0 + 5.0 * h2) + h3 * 40.0),
    cos(tt * (3.5 + 5.5 * h3) + h2 * 40.0)
  ) * amp;
  pos.y += uLag * (1.0 - e) * (0.5 + 0.5 * h4);
  pos += vec2(h4 - 0.5, h1 - 0.5) * uDensity * 3.0
    * (1.0 - smoothstep(0.5, 0.85, t));
  float grow = smoothstep(0.55, 1.0, e);
  float sizeCss = mix(uSize, uDensity * 1.3, grow);
  vCenter = home;
  vSize = sizeCss;
  vAlpha = mix(uFade, 1.0, e);
  vLod = (1.0 - e) * 1.5;
  vMerge = smoothstep(0.75, 0.97, t);
  gl_Position = vec4(
    pos.x / uRes.x * 2.0 - 1.0,
    1.0 - pos.y / uRes.y * 2.0,
    0.0,
    1.0
  );
  gl_PointSize = max(sizeCss * uDpr, 1.0);
}`;

const POINT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uContent;
uniform vec2 uRes;
in vec2 vCenter;
in float vSize;
in float vAlpha;
in float vLod;
in float vMerge;
out vec4 outColor;
void main () {
  vec2 o = gl_PointCoord - 0.5;
  vec2 uv = clamp((vCenter + o * vSize) / uRes, 0.0, 1.0);
  vec4 tex = textureLod(uContent, uv, vLod);
  float circle = 1.0 - smoothstep(0.25, 0.5, length(o));
  float mask = mix(circle, 1.0, vMerge);
  float a = vAlpha * mask * tex.a;
  if (a < 0.01) discard;
  outColor = vec4(tex.rgb, a);
}`;

export function supportsHtmlInCanvas(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("canvas") as PaintableCanvas;
  const ctx = probe.getContext("2d") as ElementImageContext | null;
  return Boolean(
    ctx &&
    typeof ctx.drawElementImage === "function" &&
    typeof probe.requestPaint === "function",
  );
}

export function createParticleScroll(
  elements: ParticleScrollElements,
  options: ParticleScrollOptions = {},
): ParticleScrollInstance | null {
  const config = { ...DEFAULTS, ...options };
  const { source, content, output } = elements;

  const gl = output.getContext("webgl2", {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!gl || gl.isContextLost()) return null;

  const sourceCtx = source.getContext("2d") as ElementImageContext | null;
  const paintable = source as PaintableCanvas;
  const htmlInCanvas = Boolean(
    sourceCtx &&
    typeof sourceCtx.drawElementImage === "function" &&
    typeof paintable.requestPaint === "function",
  );

  let contentDirty = false;
  let wake = () => {};

  if (htmlInCanvas) {
    paintable.onpaint = () => {
      try {
        sourceCtx!.reset();
        sourceCtx!.drawElementImage!(content, 0, 0);
        contentDirty = true;
        wake();
      } catch {}
    };
  }

  function compile(type: number, text: string): WebGLShader {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, text);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      console.error(
        "ParticleScroll shader error:",
        gl!.getShaderInfoLog(shader),
      );
    }
    return shader;
  }

  function link(vertText: string, fragText: string) {
    const vert = compile(gl!.VERTEX_SHADER, vertText);
    const frag = compile(gl!.FRAGMENT_SHADER, fragText);
    const program = gl!.createProgram()!;
    gl!.attachShader(program, vert);
    gl!.attachShader(program, frag);
    gl!.linkProgram(program);
    // NOTE (vendor patch): a Record over a FINITE union, so
    // `noUncheckedIndexedAccess` doesn't widen every lookup to `| undefined`.
    const uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
    const count = gl!.getProgramParameter(program, gl!.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl!.getActiveUniform(program, i)!;
      uniforms[info.name as UniformName] = gl!.getUniformLocation(program, info.name);
    }
    return { program, vert, frag, uniforms };
  }

  const base = link(QUAD_VERT, BASE_FRAG);
  const points = link(POINT_VERT, POINT_FRAG);

  const quadVao = gl.createVertexArray()!;
  gl.bindVertexArray(quadVao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const pointVao = gl.createVertexArray()!;

  const contentTexture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, contentTexture);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
  gl.generateMipmap(gl.TEXTURE_2D);

  let contentMaxX = 1;

  const rowTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, rowTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let rowProgress = new Float32Array(0);
  let rowWindow = new Float32Array(0);
  let rowsAnimating = false;
  let rowsAssembled = false;

  let bg: [number, number, number] = [0, 0, 0];
  const bgProbe = document.createElement("canvas");
  bgProbe.width = bgProbe.height = 1;
  const bgCtx = bgProbe.getContext("2d", { willReadFrequently: true });

  function syncBgColor() {
    if (!bgCtx) return;
    let el: Element | null = content;
    while (el) {
      const css = getComputedStyle(el).backgroundColor;
      if (css && css !== "transparent") {
        bgCtx.clearRect(0, 0, 1, 1);
        bgCtx.fillStyle = css;
        bgCtx.fillRect(0, 0, 1, 1);
        const px = bgCtx.getImageData(0, 0, 1, 1).data;
        const [r, g, b, a] = [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0];
        if (a > 0) {
          bg = [r / 255, g / 255, b / 255];
          return;
        }
      }
      el = el.parentElement;
    }
    bg = [0, 0, 0];
  }

  function syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(output.clientWidth * dpr));
    const height = Math.max(1, Math.round(output.clientHeight * dpr));
    if (output.width !== width || output.height !== height) {
      output.width = width;
      output.height = height;
    }
    contentMaxX = Math.min(
      1,
      Math.max(0.05, content.clientWidth / Math.max(output.clientWidth, 1)),
    );
    if (htmlInCanvas) {
      const cssWidth = Math.max(1, Math.round(source.clientWidth));
      const cssHeight = Math.max(1, Math.round(source.clientHeight));
      if (source.width !== cssWidth || source.height !== cssHeight) {
        source.width = cssWidth;
        source.height = cssHeight;
      }
      paintable.requestPaint!();
    }
  }

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  let time = 0;
  let introDone = false;
  /** Remotion: stands in for the damped scroll position. */
  let manualProgress = 0;
  let introWait = 0;
  let introReady = false;
  let scrollSmooth = content.scrollTop;
  syncCanvasSize();
  syncBgColor();

  function uploadContent() {
    if (!htmlInCanvas || !contentDirty) return;
    contentDirty = false;
    introReady = true;
    syncBgColor();
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);
    gl!.texImage2D(
      gl!.TEXTURE_2D,
      0,
      gl!.RGBA,
      gl!.RGBA,
      gl!.UNSIGNED_BYTE,
      source,
    );
    gl!.generateMipmap(gl!.TEXTURE_2D);
  }

  function rowTargetFor(docRowY: number) {
    const h = Math.max(output.clientHeight, 1);
    const band = Math.max(config.band, 1);
    if (config.manual) {
      // The line sweeps the full surface: at progress 0 it sits a full band
      // BEFORE the first row (everything scattered), at 1 it has passed the
      // last row (everything home). `band` is the width of the travelling
      // gradient edge, so grains condense in its wake rather than all at once.
      const line = -band + manualProgress * (h + band);
      return Math.min(Math.max((line + band - docRowY) / band, 0), 1);
    }
    if (reducedMotion || !introDone) return 1;
    const max = content.scrollHeight - content.clientHeight;
    let line = Math.min(Math.max(config.point, 0), 1) * h;
    if (max <= 1) {
      line = h + band;
    } else {
      const endP = Math.min(
        Math.max((scrollSmooth - (max - h * 0.5)) / (h * 0.5), 0),
        1,
      );
      line += (h + band - line) * endP * endP;
    }
    const vy = docRowY - scrollSmooth;
    return Math.min(Math.max((line + band - vy) / band, 0), 1);
  }

  function updateRows(
    dt: number,
    density: number,
    winStart: number,
    winLen: number,
  ) {
    const docRows = Math.max(1, Math.ceil(content.scrollHeight / density));
    if (rowProgress.length !== docRows) {
      const next = new Float32Array(docRows);
      for (let i = 0; i < docRows; i++) {
        next[i] = rowTargetFor((i + 0.5) * density);
      }
      rowProgress = next;
    }
    if (rowWindow.length !== winLen) rowWindow = new Float32Array(winLen);
    rowsAnimating = false;
    let minP = 1;
    const settle = Math.max(config.settle, 0.05);
    for (let i = 0; i < docRows; i++) {
      const target = rowTargetFor((i + 0.5) * density);
      let p = rowProgress[i] ?? 0;
      const inWin = i >= winStart - 4 && i < winStart + winLen + 4;
      if (p !== target) {
        if (config.manual || reducedMotion || !inWin) {
          p = target;
        } else {
          if (p < target) p = Math.min(p + dt / settle, target);
          else p = Math.max(p - dt / (settle * 0.6), target);
          if (p !== target) rowsAnimating = true;
        }
        rowProgress[i] = p;
      }
      if (inWin && p < minP) minP = p;
    }
    rowsAssembled = minP >= 0.9995;
    rowWindow.fill(1);
    const from = Math.min(Math.max(winStart, 0), docRows);
    const to = Math.min(winStart + winLen, docRows);
    if (to > from)
      rowWindow.set(rowProgress.subarray(from, to), from - winStart);
    gl!.bindTexture(gl!.TEXTURE_2D, rowTex);
    gl!.texImage2D(
      gl!.TEXTURE_2D,
      0,
      gl!.R32F,
      winLen,
      1,
      0,
      gl!.RED,
      gl!.FLOAT,
      rowWindow,
    );
  }

  function render(dt: number) {
    uploadContent();
    const w = Math.max(output.clientWidth, 1);
    const h = Math.max(output.clientHeight, 1);
    const dpr = output.width / w;
    const density = Math.max(
      Math.max(config.density, 1),
      Math.sqrt((w * h) / 800000),
    );
    const scrollTop = content.scrollTop;
    const gridX = Math.ceil(w / density);
    const winStart = Math.floor(scrollTop / density);
    const winLen = Math.ceil(h / density) + 2;
    const stagger = Math.min(Math.max(config.stagger, 0), 0.95);
    updateRows(dt, density, winStart, winLen);

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, output.width, output.height);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, rowTex);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);

    gl!.disable(gl!.BLEND);
    gl!.useProgram(base.program);
    gl!.bindVertexArray(quadVao);
    gl!.uniform1i(base.uniforms.uContent, 0);
    gl!.uniform1i(base.uniforms.uRowTex, 1);
    gl!.uniform2f(base.uniforms.uRes, w, h);
    gl!.uniform1f(base.uniforms.uDensity, density);
    gl!.uniform1f(base.uniforms.uRowCount, winLen);
    gl!.uniform1f(base.uniforms.uStagger, stagger);
    gl!.uniform1f(base.uniforms.uMaxX, contentMaxX);
    gl!.uniform1f(base.uniforms.uCover, htmlInCanvas ? 1 : 0);
    gl!.uniform1f(base.uniforms.uTransparent, config.transparent ? 1 : 0);
    gl!.uniform1f(base.uniforms.uScroll, scrollTop);
    gl!.uniform1f(base.uniforms.uWinStart, winStart);
    gl!.uniform3f(base.uniforms.uBg, bg[0], bg[1], bg[2]);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);

    if (!htmlInCanvas || rowsAssembled) return;
    gl!.enable(gl!.BLEND);
    // Upstream keeps destination alpha (ZERO, ONE) because the base pass is
    // opaque. With a transparent base that pins alpha at 0 and the dust draws
    // into a fully see-through canvas, so alpha has to ACCUMULATE instead.
    gl!.blendFuncSeparate(
      gl!.SRC_ALPHA,
      gl!.ONE_MINUS_SRC_ALPHA,
      config.transparent ? gl!.ONE : gl!.ZERO,
      config.transparent ? gl!.ONE_MINUS_SRC_ALPHA : gl!.ONE,
    );
    gl!.useProgram(points.program);
    gl!.bindVertexArray(pointVao);
    gl!.uniform1i(points.uniforms.uRowTex, 1);
    gl!.uniform2f(points.uniforms.uRes, w, h);
    gl!.uniform2f(points.uniforms.uGrid, gridX, winLen);
    gl!.uniform1f(points.uniforms.uDensity, density);
    gl!.uniform1f(points.uniforms.uStagger, stagger);
    gl!.uniform1f(points.uniforms.uSpread, Math.max(config.spread, 0));
    gl!.uniform1f(
      points.uniforms.uGravity,
      Math.min(Math.max(config.gravity, -1), 1),
    );
    gl!.uniform1f(points.uniforms.uDrift, Math.max(config.drift, 0));
    gl!.uniform1f(points.uniforms.uSwirl, Math.max(config.swirl, 0));
    gl!.uniform1f(points.uniforms.uTime, time);
    gl!.uniform1f(points.uniforms.uFade, Math.min(Math.max(config.fade, 0), 1));
    gl!.uniform1f(points.uniforms.uSize, Math.max(config.size, 0.5));
    gl!.uniform1f(points.uniforms.uDpr, dpr);
    gl!.uniform1f(points.uniforms.uMaxX, contentMaxX);
    gl!.uniform1i(points.uniforms.uContent, 0);
    gl!.uniform1f(points.uniforms.uLag, lag);
    gl!.uniform1f(points.uniforms.uScroll, scrollTop);
    gl!.uniform1f(points.uniforms.uWinStart, winStart);
    gl!.drawArrays(gl!.POINTS, 0, gridX * winLen);
    gl!.bindVertexArray(quadVao);
    gl!.disable(gl!.BLEND);
  }

  let raf = 0;
  let lastTime = performance.now();
  let destroyed = false;
  let running = false;
  let visible = true;
  let lag = 0;
  let lastScrollTop = content.scrollTop;

  function frame(now: number) {
    if (destroyed) return;
    if (!visible) {
      running = false;
      return;
    }
    const delta = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    time += delta;
    const scrollTop = content.scrollTop;
    lag += scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    lag *= Math.exp(-delta / 0.22);
    lag = Math.min(Math.max(lag, -400), 400);
    if (reducedMotion || Math.abs(lag) < 0.1) lag = 0;
    if (!introDone) {
      if (reducedMotion || !htmlInCanvas) introDone = true;
      else if (introReady) {
        introWait += delta;
        if (introWait >= 1) introDone = true;
      }
    }
    const tau = config.smoothing;
    const k =
      reducedMotion || tau <= 0
        ? 1
        : 1 - Math.exp(-delta / Math.max(tau, 1e-4));
    scrollSmooth += (scrollTop - scrollSmooth) * k;
    if (Math.abs(scrollTop - scrollSmooth) < 0.5) scrollSmooth = scrollTop;
    render(delta);
    if (
      !contentDirty &&
      scrollSmooth === scrollTop &&
      !rowsAnimating &&
      rowsAssembled &&
      introDone &&
      lag === 0
    ) {
      running = false;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (config.manual) return; // Remotion drives frames explicitly
    if (destroyed || running || !visible) return;
    running = true;
    lastTime = performance.now();
    raf = requestAnimationFrame(frame);
  }

  wake = start;
  start();

  function onScroll() {
    if (htmlInCanvas) paintable.requestPaint!();
    start();
  }
  content.addEventListener("scroll", onScroll, { passive: true });

  function onMotionChange() {
    reducedMotion = motionQuery.matches;
    start();
  }
  motionQuery.addEventListener("change", onMotionChange);

  const observer = new ResizeObserver(() => {
    syncCanvasSize();
    start();
  });
  observer.observe(output);
  observer.observe(content);

  const intersection = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting ?? true;
    if (visible) start();
  });
  intersection.observe(output);

  return {
    renderFrame(state) {
      if (htmlInCanvas) {
        try {
          sourceCtx!.reset();
          sourceCtx!.drawElementImage!(content, 0, 0);
          contentDirty = true;
        } catch {}
      }
      manualProgress = Math.min(Math.max(state.progress, 0), 1);
      time = state.time;
      introDone = true;
      render(0);
      // The source canvas holds the crisp capture and sits UNDER the output
      // canvas. While the output was opaque that never mattered; a transparent
      // output would let the un-dissolved capture show straight through it.
      // render() has already uploaded the texture, so the bitmap can go.
      if (config.transparent && htmlInCanvas) {
        try { sourceCtx!.reset(); } catch {}
      }
    },
    setOptions(next) {
      Object.assign(config, next);
      start();
    },
    resize() {
      syncCanvasSize();
      start();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      content.removeEventListener("scroll", onScroll);
      observer.disconnect();
      intersection.disconnect();
      motionQuery.removeEventListener("change", onMotionChange);
      gl!.deleteTexture(contentTexture);
      gl!.deleteTexture(rowTex);
      gl!.deleteProgram(base.program);
      gl!.deleteProgram(points.program);
      gl!.deleteShader(base.vert);
      gl!.deleteShader(base.frag);
      gl!.deleteShader(points.vert);
      gl!.deleteShader(points.frag);
      gl!.deleteBuffer(quad);
      gl!.deleteVertexArray(quadVao);
      gl!.deleteVertexArray(pointVao);
      if (htmlInCanvas) paintable.onpaint = null;
    },
  };
}

export interface ParticleScrollProps extends ParticleScrollOptions {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const emptySubscribe = () => () => {};

export function ParticleScroll({
  children,
  className,
  style,
  ...options
}: ParticleScrollProps) {
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<ParticleScrollInstance | null>(null);
  const [initialOptions] = useState(options);
  const [failed, setFailed] = useState(false);

  const supported = useSyncExternalStore(
    emptySubscribe,
    supportsHtmlInCanvas,
    () => false,
  );
  const native = supported && !failed;

  useEffect(() => {
    const source = sourceRef.current;
    const content = contentRef.current;
    const output = outputRef.current;
    if (!source || !content || !output) return;
    instanceRef.current = createParticleScroll(
      { source, content, output },
      initialOptions,
    );
    if (native && !instanceRef.current) setFailed(true);
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, [initialOptions, native]);

  useEffect(() => {
    instanceRef.current?.setOptions(options);
  });

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <canvas
        ref={sourceRef}
        // @ts-expect-error experimental html-in-canvas attribute
        layoutsubtree="true"
        suppressHydrationWarning
        style={
          native
            ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
            : { display: "none" }
        }
      >
        {native ? (
          <div
            ref={contentRef}
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              overflow: "auto",
            }}
          >
            {children}
          </div>
        ) : null}
      </canvas>
      {!native ? (
        <div
          ref={contentRef}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "auto",
          }}
        >
          {children}
        </div>
      ) : null}
      <canvas
        ref={outputRef}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}


export default ParticleScroll;
