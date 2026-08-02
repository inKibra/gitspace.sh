"use client";

/**
 * VENDORED from Canvas UI (https://canvasui.dev) — MIT + Commons Clause.
 * We are not selling it, so the Commons Clause doesn't bite.
 *
 * Upstream this is a scroll-driven page effect. Patched for Remotion:
 *   - `manual: true` suppresses the rAF loop entirely.
 *   - `renderFrame(state)` sets the fold/tumble/tilt state directly and draws
 *     one frame, so a render is a pure function of `frame`.
 * The shader is UNMODIFIED. The horizontal fold comes from applying the effect
 * in a rotated frame (see BendFrame.tsx), not from forking the axis math.
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface BendOptions {
  /** Remotion: suppress the rAF loop; drive with renderFrame() instead. */
  manual?: boolean;
  /** Composite over what's behind instead of painting an opaque surface. */
  transparent?: boolean;
  /** Height of the folded region at each edge in CSS pixels. */
  zone?: number;
  /** Maximum fold angle in degrees, reached away from the scroll ends. 90 is a cube edge. */
  angle?: number;
  /** Radius in CSS pixels of the circular arc that rounds each fold crease. 0 keeps a sharp cube edge. Clamped to the zone height. */
  rounding?: number;
  /** Perspective focal length in CSS pixels. Smaller values pinch the folded edges harder. */
  perspective?: number;
  /** "out" folds the edges away from the viewer like the outside of a cube, "in" tilts them toward the viewer. */
  direction?: "out" | "in";
  /** Scroll distance in CSS pixels over which an edge flattens near its scroll end. */
  ease?: number;
  /** Seconds the bend takes to settle after a scroll. 0 snaps instantly. */
  smoothing?: number;
  /** Bend the top edge. */
  top?: boolean;
  /** Bend the bottom edge. */
  bottom?: boolean;
  /** Overscroll tip strength (0 to 1). Rubber-banding past a scroll end tips the whole face over that edge. 0 disables. */
  tumble?: number;
  /** Pointer tilt strength (0 to 1). The face leans subtly toward the cursor. 0 disables. */
  tilt?: number;
}

export interface BendElements {
  /** Canvas with layoutsubtree that hosts the HTML content. */
  source: HTMLCanvasElement;
  /** The scrollable element inside the source canvas that gets captured. */
  content: HTMLElement;
  /** Canvas the WebGL effect renders to. */
  output: HTMLCanvasElement;
}

/** Remotion: the fold state for one frame, in place of the damped scroll. */
export interface BendFrameState {
  /**
   * Fold amounts at the leading/trailing edges, 0–1. Omit BOTH to let the
   * upstream ramp derive them from the content's current scrollTop — that is
   * the faithful behaviour for one continuous sheet, where an edge flattens
   * as you reach that end of the scroll.
   */
  top?: number;
  bottom?: number;
  /** Tumble (over-scroll roll), roughly -0.4 to 0.4. */
  phi?: number;
  tiltX?: number;
  tiltY?: number;
  /**
   * Where to draw the captured element, in canvas pixels. Lets the caller pan
   * a tall STATIC subtree past a viewport-sized capture instead of moving the
   * content itself — the content's layout never changes, so the capture can
   * never lag a frame behind it.
   */
  offsetX?: number;
  offsetY?: number;
}

export interface BendInstance {
  /** Remotion: recapture the HTML and draw exactly one frame. */
  renderFrame: (state: BendFrameState) => void;
  /** Update effect options live. */
  setOptions: (options: BendOptions) => void;
  /** Re-read canvas size. Call when the element is resized. */
  resize: () => void;
  /** Stop the loop and release all GPU resources. */
  destroy: () => void;
}

const DEFAULTS: Required<BendOptions> = {
  manual: false,
  transparent: false,
  zone: 240,
  angle: 80,
  rounding: 150,
  perspective: 700,
  direction: "in",
  ease: 240,
  smoothing: 0.1,
  top: true,
  bottom: true,
  tumble: 0.5,
  tilt: 0.5,
};

type UniformName =
  | 'uAngle' | 'uBg' | 'uBotAmt' | 'uContent' | 'uCover' | 'uDir' | 'uMaxX'
  | 'uPersp' | 'uPhi' | 'uPxX' | 'uPxY' | 'uRound' | 'uTiltX' | 'uTiltY'
  | 'uTopAmt' | 'uZone' | 'uTransparent';

type PaintableCanvas = HTMLCanvasElement & {
  onpaint?: (() => void) | null;
  requestPaint?: () => void;
};

type ElementImageContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: Element, x: number, y: number) => void;
};

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform float uZone;
uniform float uAngle;
uniform float uPersp;
uniform float uDir;
uniform float uTopAmt;
uniform float uBotAmt;
uniform float uMaxX;
uniform float uPxY;
uniform float uPxX;
uniform float uCover;
uniform float uTransparent;
uniform vec3 uBg;
uniform float uTiltX;
uniform float uTiltY;
uniform float uPhi;
uniform float uRound;

vec3 foldEdge (float sy, float amt) {
  float yf = 1.0 - uZone;
  if (amt < 1e-4) return vec3(sy, 0.0, 1.0);
  float theta = uAngle * amt;
  if (uRound < 1e-4) {
    float s = sin(theta) * uDir;
    float c = cos(theta);
    float denom = max(c * uPersp + s * (0.5 - sy), 1e-5);
    float tRaw = uPersp * (sy - yf) / denom;
    float t = clamp(tRaw, 0.0, uZone);
    float z = max(t * s, -0.85 * uPersp);
    float alpha = 1.0 - smoothstep(uZone, uZone + 2.0 * uPxY, tRaw);
    return vec3(yf + t, z, alpha);
  }
  if (sy <= yf) return vec3(sy, 0.0, 1.0);
  float R = min(uRound, uZone);
  float r = R / theta;
  float ca = cos(theta);
  float sa = sin(theta);
  float yA = r * sa;
  float zA = r * (1.0 - ca);
  float prevSy = yf;
  float prevZ = 0.0;
  float prevU = 0.0;
  float bestU = -1.0;
  float bestZ = 0.0;
  float maxSy = yf;
  float du = uZone / 40.0;
  for (int i = 1; i <= 40; i++) {
    float u = du * float(i);
    float Y;
    float Zm;
    if (u <= R) {
      float a = u / r;
      Y = r * sin(a);
      Zm = r * (1.0 - cos(a));
    } else {
      Y = yA + (u - R) * ca;
      Zm = zA + (u - R) * sa;
    }
    Y += yf;
    float Z = max(Zm * uDir, -0.85 * uPersp);
    float scr = 0.5 + (Y - 0.5) * uPersp / (uPersp + Z);
    if ((prevSy - sy) * (scr - sy) <= 0.0 && abs(scr - prevSy) > 1e-7) {
      float f = clamp((sy - prevSy) / (scr - prevSy), 0.0, 1.0);
      bestU = mix(prevU, u, f);
      bestZ = mix(prevZ, Z, f);
      if (uDir > 0.0) break;
    }
    maxSy = max(maxSy, scr);
    prevSy = scr;
    prevZ = Z;
    prevU = u;
  }
  if (bestU < 0.0) {
    float alpha = 1.0 - smoothstep(maxSy - uPxY, maxSy + uPxY, sy);
    return vec3(1.0, prevZ, alpha);
  }
  return vec3(yf + bestU, bestZ, 1.0);
}

vec2 tipPlane (float sy, float phi) {
  float s = sin(phi);
  float c = cos(phi);
  float denom = max(c * uPersp + s * (sy - 0.5), 1e-4);
  float t = uPersp * (1.0 - sy) / denom;
  return vec2(1.0 - t, t * s);
}

void main () {
  vec2 uv = vUv;
  float cx = uMaxX * 0.5;
  float zSum = 0.0;

  if (abs(uPhi) > 1e-4) {
    if (uPhi > 0.0) {
      vec2 r = tipPlane(uv.y, uPhi);
      uv.y = r.x;
      zSum += r.y;
    } else {
      vec2 r = tipPlane(1.0 - uv.y, -uPhi);
      uv.y = 1.0 - r.x;
      zSum += r.y;
    }
  }

  float zG = uTiltX * (uv.x - cx) + uTiltY * (uv.y - 0.5);
  zSum += zG;
  uv.y = 0.5 + (uv.y - 0.5) * (uPersp + zG) / uPersp;

  float inTop = step(1.0 - uZone, uv.y);
  float inBot = step(uv.y, uZone);

  vec3 top = foldEdge(uv.y, uTopAmt);
  vec3 bot = foldEdge(1.0 - uv.y, uBotAmt);

  float srcY = uv.y;
  srcY = mix(srcY, top.x, inTop);
  srcY = mix(srcY, 1.0 - bot.x, inBot);

  zSum += inTop * top.y + inBot * bot.y;
  float alpha = mix(1.0, top.z, inTop) * mix(1.0, bot.z, inBot);

  float srcX = cx + (uv.x - cx) * (uPersp + zSum) / uPersp;

  alpha *= smoothstep(-2.0 * uPxX, 0.0, srcX);
  alpha *= 1.0 - smoothstep(uMaxX, uMaxX + 2.0 * uPxX, srcX);
  alpha *= smoothstep(-2.0 * uPxY, 0.0, srcY);
  alpha *= 1.0 - smoothstep(1.0, 1.0 + 2.0 * uPxY, srcY);

  vec2 p = vec2(
    clamp(srcX, 0.0005, uMaxX - 0.0005),
    clamp(srcY, 0.0005, 0.9995)
  );
  vec4 base = texture(uContent, vec2(p.x, 1.0 - p.y));

  // VENDOR PATCH: upstream always paints an opaque surface. In transparent
  // mode the sheet keeps its own alpha, so whatever is BEHIND the bend (here:
  // the background shader field) stays visible and continuous while the
  // surface folds over it. A live WebGL canvas cannot be captured by
  // drawElementImage, so the field has to live behind the bend, not inside it.
  outColor = uTransparent > 0.5
    ? vec4(base.rgb, alpha * base.a)
    : vec4(mix(uBg, base.rgb, alpha * base.a), uCover);
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

const HOVER_ATTR = "data-canvasui-hover";
const CONTENT_ATTR = "data-canvasui-content";
const HOVER_REWRITE = `:is([${HOVER_ATTR}], :hover:where(:not([${CONTENT_ATTR}], [${CONTENT_ATTR}] *)))`;

function patchHoverRules() {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset.canvasuiHoverRules === "") return;
  document.documentElement.dataset.canvasuiHoverRules = "";
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(":hover")) {
          try {
            rule.selectorText = rule.selectorText.replace(
              /:hover\b/g,
              HOVER_REWRITE,
            );
          } catch {}
        }
        if (rule.cssRules.length) walk(rule.cssRules);
      } else if ("cssRules" in rule) {
        try {
          walk((rule as CSSGroupingRule).cssRules);
        } catch {}
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {}
  }
  const style = document.createElement("style");
  style.textContent = `[${CONTENT_ATTR}], [${CONTENT_ATTR}] * { cursor: var(--canvasui-cursor, auto) !important; }`;
  document.head.appendChild(style);
}

export function createBend(
  elements: BendElements,
  options: BendOptions = {},
): BendInstance | null {
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
      // In manual mode Chrome's own paint callback is a SECOND, asynchronous
      // capture that always draws at (0,0). It would race the deterministic one
      // in renderFrame and stomp its pan offset, so it stays off entirely.
      if (config.manual) return;
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
      console.error("Bend shader error:", gl!.getShaderInfoLog(shader));
    }
    return shader;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  // NOTE (vendor patch): a Record over a FINITE union, so
  // `noUncheckedIndexedAccess` doesn't widen every lookup to `| undefined`.
  // WebGL tolerates a null location, so null is the only extra case.
  const uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)!;
    uniforms[info.name as UniformName] = gl.getUniformLocation(program, info.name);
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

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

  let topTarget = 0;
  let bottomTarget = 0;
  let topCurrent = 0;
  let bottomCurrent = 0;
  let over = 0;
  let phiCurrent = 0;
  let tiltXTarget = 0;
  let tiltYTarget = 0;
  let tiltXCurrent = 0;
  let tiltYCurrent = 0;

  function syncScroll() {
    const max = content.scrollHeight - content.clientHeight;
    const t = content.scrollTop;
    const e = Math.max(config.ease, 1);
    const ramp = (v: number) => {
      const x = Math.min(Math.max(v / e, 0), 1);
      return x * x * (3 - 2 * x);
    };
    topTarget = max > 1 && config.top ? ramp(t) : 0;
    bottomTarget = max > 1 && config.bottom ? ramp(max - t) : 0;
  }

  syncCanvasSize();
  syncScroll();
  syncBgColor();

  function uploadContent() {
    if (!htmlInCanvas || !contentDirty) return;
    contentDirty = false;
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

  function render() {
    uploadContent();
    const h = Math.max(output.clientHeight, 1);
    const w = Math.max(output.clientWidth, 1);
    const zoneFrac = Math.min(Math.max(config.zone, 8) / h, 0.49);
    gl!.useProgram(program);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);
    gl!.uniform1i(uniforms.uContent, 0);
    gl!.uniform1f(uniforms.uZone, zoneFrac);
    gl!.uniform1f(
      uniforms.uAngle,
      Math.min(Math.max(config.angle, 1), 160) * (Math.PI / 180),
    );
    gl!.uniform1f(uniforms.uPersp, Math.max(config.perspective, 50) / h);
    gl!.uniform1f(uniforms.uDir, config.direction === "in" ? -1 : 1);
    gl!.uniform1f(uniforms.uTopAmt, topCurrent);
    gl!.uniform1f(uniforms.uBotAmt, bottomCurrent);
    gl!.uniform1f(uniforms.uMaxX, contentMaxX);
    gl!.uniform1f(uniforms.uPxY, 1.5 / h);
    gl!.uniform1f(uniforms.uPxX, 1.5 / w);
    gl!.uniform1f(uniforms.uCover, htmlInCanvas ? 1 : 0);
    gl!.uniform1f(uniforms.uTransparent, config.transparent ? 1 : 0);
    gl!.uniform3f(uniforms.uBg, bg[0], bg[1], bg[2]);
    gl!.uniform1f(uniforms.uTiltX, tiltXCurrent);
    gl!.uniform1f(uniforms.uTiltY, tiltYCurrent);
    gl!.uniform1f(uniforms.uPhi, phiCurrent);
    gl!.uniform1f(
      uniforms.uRound,
      Math.min(Math.max(config.rounding, 0) / h, zoneFrac),
    );
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, output.width, output.height);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  let raf = 0;
  let lastTime = performance.now();
  let destroyed = false;
  let running = false;
  let visible = true;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  function frame(now: number) {
    if (destroyed) return;
    if (!visible) {
      running = false;
      return;
    }
    const delta = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    const tau = config.smoothing;
    const k =
      reducedMotion || tau <= 0
        ? 1
        : 1 - Math.exp(-delta / Math.max(tau, 1e-4));
    topCurrent += (topTarget - topCurrent) * k;
    bottomCurrent += (bottomTarget - bottomCurrent) * k;
    if (Math.abs(topTarget - topCurrent) < 0.001) topCurrent = topTarget;
    if (Math.abs(bottomTarget - bottomCurrent) < 0.001)
      bottomCurrent = bottomTarget;

    over *= Math.exp(-delta / 0.22);
    if (Math.abs(over) < 0.5) over = 0;
    const phiTarget =
      reducedMotion || config.tumble <= 0
        ? 0
        : Math.tanh(over / 500) * 0.4 * Math.min(config.tumble, 1);
    phiCurrent += (phiTarget - phiCurrent) * Math.min(delta / 0.09, 1);
    if (phiTarget === 0 && Math.abs(phiCurrent) < 1e-4) phiCurrent = 0;

    if (reducedMotion || config.tilt <= 0) {
      tiltXTarget = 0;
      tiltYTarget = 0;
    }
    const kT = Math.min(delta / 0.15, 1);
    tiltXCurrent += (tiltXTarget - tiltXCurrent) * kT;
    tiltYCurrent += (tiltYTarget - tiltYCurrent) * kT;
    if (Math.abs(tiltXTarget - tiltXCurrent) < 1e-4) tiltXCurrent = tiltXTarget;
    if (Math.abs(tiltYTarget - tiltYCurrent) < 1e-4) tiltYCurrent = tiltYTarget;

    render();
    if (
      !contentDirty &&
      topCurrent === topTarget &&
      bottomCurrent === bottomTarget &&
      over === 0 &&
      phiCurrent === 0 &&
      tiltXCurrent === tiltXTarget &&
      tiltYCurrent === tiltYTarget
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
    syncScroll();
    if (htmlInCanvas) paintable.requestPaint!();
    if (hoverOn) updateHover(hoverClientX, hoverClientY);
    start();
  }
  content.addEventListener("scroll", onScroll, { passive: true });

  function onWheel(event: WheelEvent) {
    if (config.tumble <= 0 || reducedMotion) return;
    const max = content.scrollHeight - content.clientHeight;
    if (max <= 1) return;
    const st = content.scrollTop;
    if (event.deltaY > 0 && st >= max - 1) {
      over = Math.min(over + event.deltaY, 900);
    } else if (event.deltaY < 0 && st <= 1) {
      over = Math.max(over + event.deltaY, -900);
    } else {
      return;
    }
    start();
  }
  content.addEventListener("wheel", onWheel, { passive: true });

  function onPointerMove(event: PointerEvent) {
    if (!event.isPrimary) return;
    hoverClientX = event.clientX;
    hoverClientY = event.clientY;
    hoverOn = true;
    updateHover(event.clientX, event.clientY);
    if (config.tilt > 0 && !reducedMotion) {
      const rect = output.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const nx = (event.clientX - rect.left) / rect.width - 0.5;
        const ny = 0.5 - (event.clientY - rect.top) / rect.height;
        const amp = Math.min(config.tilt, 1) * 0.14;
        tiltXTarget = -nx * amp;
        tiltYTarget = -ny * amp;
        start();
      }
    }
  }
  content.addEventListener("pointermove", onPointerMove, { passive: true });

  function onPointerLeave() {
    hoverOn = false;
    setHoverTarget(null);
    tiltXTarget = 0;
    tiltYTarget = 0;
    start();
  }
  content.addEventListener("pointerleave", onPointerLeave);

  function mapPoint(px: number, py: number) {
    const w = Math.max(output.clientWidth, 1);
    const h = Math.max(output.clientHeight, 1);
    const persp = Math.max(config.perspective, 50) / h;
    const zone = Math.min(Math.max(config.zone, 8) / h, 0.49);
    const round = Math.min(Math.max(config.rounding, 0) / h, zone);
    const angle = Math.min(Math.max(config.angle, 1), 160) * (Math.PI / 180);
    const dirSign = config.direction === "in" ? -1 : 1;
    const cx = contentMaxX * 0.5;
    const x = px / w;
    let y = 1 - py / h;
    let zSum = 0;

    if (Math.abs(phiCurrent) > 1e-4) {
      const tip = (sy: number, phi: number): [number, number] => {
        const s = Math.sin(phi);
        const c = Math.cos(phi);
        const denom = Math.max(c * persp + s * (sy - 0.5), 1e-4);
        const t = (persp * (1 - sy)) / denom;
        return [1 - t, t * s];
      };
      if (phiCurrent > 0) {
        const tipped = tip(y, phiCurrent);
        y = tipped[0];
        zSum += tipped[1];
      } else {
        const tipped = tip(1 - y, -phiCurrent);
        y = 1 - tipped[0];
        zSum += tipped[1];
      }
    }

    const zG = tiltXCurrent * (x - cx) + tiltYCurrent * (y - 0.5);
    zSum += zG;
    y = 0.5 + (y - 0.5) * ((persp + zG) / persp);

    const fold = (sy: number, amt: number): [number, number, number] => {
      const yf = 1 - zone;
      if (amt < 1e-4) return [sy, 0, 1];
      const theta = angle * amt;
      if (round < 1e-4) {
        const s = Math.sin(theta) * dirSign;
        const c = Math.cos(theta);
        const denom = Math.max(c * persp + s * (0.5 - sy), 1e-5);
        const tRaw = (persp * (sy - yf)) / denom;
        const t = Math.min(Math.max(tRaw, 0), zone);
        const z = Math.max(t * s, -0.85 * persp);
        return [yf + t, z, tRaw > zone ? 0 : 1];
      }
      if (sy <= yf) return [sy, 0, 1];
      const R = Math.min(round, zone);
      const r = R / theta;
      const ca = Math.cos(theta);
      const sa = Math.sin(theta);
      const yA = r * sa;
      const zA = r * (1 - ca);
      let prevSy = yf;
      let prevZ = 0;
      let prevU = 0;
      let bestU = -1;
      let bestZ = 0;
      const du = zone / 40;
      for (let i = 1; i <= 40; i++) {
        const u = du * i;
        let py2: number;
        let zm: number;
        if (u <= R) {
          const a = u / r;
          py2 = r * Math.sin(a);
          zm = r * (1 - Math.cos(a));
        } else {
          py2 = yA + (u - R) * ca;
          zm = zA + (u - R) * sa;
        }
        const worldY = yf + py2;
        const worldZ = Math.max(zm * dirSign, -0.85 * persp);
        const scr = 0.5 + ((worldY - 0.5) * persp) / (persp + worldZ);
        if ((prevSy - sy) * (scr - sy) <= 0 && Math.abs(scr - prevSy) > 1e-7) {
          const f = Math.min(Math.max((sy - prevSy) / (scr - prevSy), 0), 1);
          bestU = prevU + (u - prevU) * f;
          bestZ = prevZ + (worldZ - prevZ) * f;
          if (dirSign > 0) break;
        }
        prevSy = scr;
        prevZ = worldZ;
        prevU = u;
      }
      if (bestU < 0) return [1, prevZ, 0];
      return [yf + bestU, bestZ, 1];
    };

    let srcY = y;
    let alpha = 1;
    if (y >= 1 - zone) {
      const folded = fold(y, topCurrent);
      srcY = folded[0];
      zSum += folded[1];
      alpha *= folded[2];
    } else if (y <= zone) {
      const folded = fold(1 - y, bottomCurrent);
      srcY = 1 - folded[0];
      zSum += folded[1];
      alpha *= folded[2];
    }
    const srcX = cx + (x - cx) * ((persp + zSum) / persp);
    if (srcX < 0 || srcX > contentMaxX || srcY < 0 || srcY > 1) alpha = 0;
    return { x: srcX * w, y: (1 - srcY) * h, alpha };
  }

  let forwarding = false;

  let hoverChain: Element[] = [];
  let hoverTarget: Element | null = null;
  let hoverClientX = 0;
  let hoverClientY = 0;
  let hoverOn = false;

  if (htmlInCanvas) {
    patchHoverRules();
    content.setAttribute(CONTENT_ATTR, "");
  }

  function setHoverTarget(target: Element | null) {
    if (target === hoverTarget) return;
    hoverTarget = target;
    const next = new Set<Element>();
    for (let el: Element | null = target; el; el = el.parentElement) {
      next.add(el);
      if (el === content) break;
    }
    for (const el of hoverChain) {
      if (!next.has(el)) el.removeAttribute(HOVER_ATTR);
    }
    for (const el of next) el.setAttribute(HOVER_ATTR, "");
    hoverChain = Array.from(next);
    if (target) {
      content.style.setProperty(
        "--canvasui-cursor",
        getComputedStyle(target).cursor,
      );
    } else {
      content.style.removeProperty("--canvasui-cursor");
    }
  }

  function updateHover(clientX: number, clientY: number) {
    if (!htmlInCanvas) return;
    const rect = output.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const mapped = mapPoint(clientX - rect.left, clientY - rect.top);
    if (mapped.alpha < 0.5) {
      setHoverTarget(null);
      return;
    }
    const target = document.elementFromPoint(
      rect.left + mapped.x,
      rect.top + mapped.y,
    );
    setHoverTarget(target && content.contains(target) ? target : null);
  }

  function onClick(event: MouseEvent) {
    if (forwarding || !htmlInCanvas || event.button !== 0) return;
    const rect = output.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const mapped = mapPoint(localX, localY);
    if (mapped.alpha < 0.5) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (Math.hypot(mapped.x - localX, mapped.y - localY) < 1.5) return;
    event.preventDefault();
    event.stopPropagation();
    const target = document.elementFromPoint(
      rect.left + mapped.x,
      rect.top + mapped.y,
    );
    if (!target) return;
    forwarding = true;
    try {
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: event.detail,
          clientX: rect.left + mapped.x,
          clientY: rect.top + mapped.y,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          button: event.button,
        }),
      );
      if (
        target instanceof HTMLElement &&
        target.matches("input, textarea, select, [contenteditable]")
      ) {
        target.focus();
      }
    } finally {
      forwarding = false;
    }
  }
  content.addEventListener("click", onClick, true);

  function caretAt(
    x: number,
    y: number,
  ): { node: Node; offset: number } | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (typeof doc.caretPositionFromPoint === "function") {
      const c = doc.caretPositionFromPoint(x, y);
      return c ? { node: c.offsetNode, offset: c.offset } : null;
    }
    const r = doc.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  function remapped(event: MouseEvent): { x: number; y: number } | null {
    const rect = output.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const mapped = mapPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (mapped.alpha < 0.5) return null;
    const tx = rect.left + mapped.x;
    const ty = rect.top + mapped.y;
    if (Math.hypot(tx - event.clientX, ty - event.clientY) < 1.5) return null;
    return { x: tx, y: ty };
  }

  let selecting = false;

  function onMouseDown(event: MouseEvent) {
    if (forwarding || !htmlInCanvas || event.button !== 0) return;
    const m = remapped(event);
    if (!m) return;
    event.preventDefault();
    const caret = caretAt(m.x, m.y);
    if (!caret || !content.contains(caret.node)) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.collapse(caret.node, caret.offset);
    selecting = true;
  }

  function onSelMove(event: MouseEvent) {
    if (!selecting) return;
    if (!(event.buttons & 1)) {
      selecting = false;
      return;
    }
    const m = remapped(event);
    const caret = m ? caretAt(m.x, m.y) : null;
    const sel = window.getSelection();
    if (caret && sel && sel.anchorNode && content.contains(caret.node)) {
      sel.extend(caret.node, caret.offset);
    }
  }

  function onSelEnd() {
    selecting = false;
  }

  content.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onSelMove, true);
  window.addEventListener("mouseup", onSelEnd, true);

  function onMotionChange() {
    reducedMotion = motionQuery.matches;
    start();
  }
  motionQuery.addEventListener("change", onMotionChange);

  const observer = new ResizeObserver(() => {
    syncCanvasSize();
    syncScroll();
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
          sourceCtx!.drawElementImage!(content, state.offsetX ?? 0, state.offsetY ?? 0);
          contentDirty = true;
        } catch {}
      }
      if (state.top === undefined && state.bottom === undefined) {
        // derive the folds from where we are in the sheet, as upstream does
        syncScroll();
        topCurrent = topTarget;
        bottomCurrent = bottomTarget;
      } else {
        topCurrent = state.top ?? 0;
        bottomCurrent = state.bottom ?? 0;
      }
      phiCurrent = state.phi ?? 0;
      tiltXCurrent = state.tiltX ?? 0;
      tiltYCurrent = state.tiltY ?? 0;
      render();
      // the source canvas holds the crisp capture and sits UNDER the output; a
      // transparent output would let it show straight through. render() has
      // already uploaded the texture, so the bitmap can go.
      if (config.transparent && htmlInCanvas) {
        try { sourceCtx!.reset(); } catch {}
      }
    },
    setOptions(next) {
      Object.assign(config, next);
      syncScroll();
      start();
    },
    resize() {
      syncCanvasSize();
      syncScroll();
      start();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      setHoverTarget(null);
      content.removeAttribute(CONTENT_ATTR);
      content.removeEventListener("scroll", onScroll);
      content.removeEventListener("wheel", onWheel);
      content.removeEventListener("pointermove", onPointerMove);
      content.removeEventListener("pointerleave", onPointerLeave);
      content.removeEventListener("click", onClick, true);
      content.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onSelMove, true);
      window.removeEventListener("mouseup", onSelEnd, true);
      observer.disconnect();
      intersection.disconnect();
      motionQuery.removeEventListener("change", onMotionChange);
      gl!.deleteTexture(contentTexture);
      gl!.deleteProgram(program);
      gl!.deleteShader(vertexShader);
      gl!.deleteShader(fragmentShader);
      gl!.deleteBuffer(quad);
      if (htmlInCanvas) paintable.onpaint = null;
    },
  };
}

export interface BendProps extends BendOptions {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const emptySubscribe = () => () => {};

export function Bend({ children, className, style, ...options }: BendProps) {
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<BendInstance | null>(null);
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
    instanceRef.current = createBend(
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


export default Bend;
