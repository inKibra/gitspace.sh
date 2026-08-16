import React, { useEffect, useRef, useState } from 'react';
import { useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import { FAULTY_VERT, FAULTY_FRAG } from './faulty-terminal.glsl';

/**
 * The site's hero background, in the film.
 *
 * `FaultyTerminal` on the marketing site is an `ogl` component with its own rAF
 * loop and a `Math.random()` time offset. Here the same shader runs on plain
 * WebGL with `iTime` derived from `useCurrentFrame()`, so the background is
 * deterministic and the video and the blog post look like the same product.
 *
 * Defaults match the props every episode hero uses:
 *   scale 2 · gridMul [2,1] · digitSize 1.2 · timeScale 0.4 · scanline 0.3
 *   glitch 1 · flicker 1 · noiseAmp 1 · dither 1 · tint #22c55e · brightness 0.4
 * The site then wraps it at opacity 0.12; `opacity` here does the same job.
 */

export interface FaultyTerminalOptions {
  scale?: number;
  gridMul?: [number, number];
  digitSize?: number;
  timeScale?: number;
  scanlineIntensity?: number;
  glitchAmount?: number;
  flickerAmount?: number;
  noiseAmp?: number;
  chromaticAberration?: number;
  dither?: number;
  curvature?: number;
  tint?: string;
  brightness?: number;
  /** Fixed stand-in for the site's random time offset, so renders repeat. */
  seed?: number;
}

const DEFAULTS: Required<FaultyTerminalOptions> = {
  scale: 2,
  gridMul: [2, 1],
  digitSize: 1.2,
  timeScale: 0.4,
  scanlineIntensity: 0.3,
  glitchAmount: 1,
  flickerAmount: 1,
  noiseAmp: 1,
  chromaticAberration: 0,
  dither: 1,
  curvature: 0,
  tint: '#22c55e',
  brightness: 0.4,
  seed: 41.7,
};

const hexToRgb = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const compile = (gl: WebGLRenderingContext, type: number, src: string): WebGLShader => {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('FaultyTerminal shader error:', gl.getShaderInfoLog(sh));
  }
  return sh;
};

export const FaultyTerminalFrame: React.FC<{
  width: number;
  height: number;
  /** Matches the site's `opacity-[0.12]` hero wrapper. */
  opacity?: number;
  options?: FaultyTerminalOptions;
  style?: React.CSSProperties;
}> = ({ width, height, opacity = 0.12, options, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cfg = { ...DEFAULTS, ...options };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const uniformsRef = useRef<Record<string, WebGLUniformLocation | null>>({});
  const [handle] = useState(() => delayRender('faulty-terminal:init'));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) {
      continueRender(handle);
      return;
    }
    glRef.current = gl;

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, FAULTY_VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FAULTY_FRAG));
    gl.linkProgram(program);
    gl.useProgram(program);

    // a full-screen triangle, the same geometry ogl's Triangle provides
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const uv = gl.getAttribLocation(program, 'uv');
    if (uv >= 0) {
      const uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, 2]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(uv);
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 0, 0);
    }

    const names = [
      'iTime', 'iResolution', 'uScale', 'uGridMul', 'uDigitSize', 'uScanlineIntensity',
      'uGlitchAmount', 'uFlickerAmount', 'uNoiseAmp', 'uChromaticAberration', 'uDither',
      'uCurvature', 'uTint', 'uMouse', 'uMouseStrength', 'uUseMouse',
      'uPageLoadProgress', 'uUsePageLoadAnimation', 'uBrightness',
    ];
    for (const n of names) uniformsRef.current[n] = gl.getUniformLocation(program, n);

    setReady(true);
    continueRender(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // one deterministic draw per frame
  useEffect(() => {
    const gl = glRef.current;
    const u = uniformsRef.current;
    if (!gl || !ready) return;
    const tint = hexToRgb(cfg.tint);
    gl.viewport(0, 0, width, height);
    gl.uniform1f(u.iTime ?? null, (frame / fps + cfg.seed) * cfg.timeScale);
    gl.uniform3f(u.iResolution ?? null, width, height, width / height);
    gl.uniform1f(u.uScale ?? null, cfg.scale);
    gl.uniform2f(u.uGridMul ?? null, cfg.gridMul[0], cfg.gridMul[1]);
    gl.uniform1f(u.uDigitSize ?? null, cfg.digitSize);
    gl.uniform1f(u.uScanlineIntensity ?? null, cfg.scanlineIntensity);
    gl.uniform1f(u.uGlitchAmount ?? null, cfg.glitchAmount);
    gl.uniform1f(u.uFlickerAmount ?? null, cfg.flickerAmount);
    gl.uniform1f(u.uNoiseAmp ?? null, cfg.noiseAmp);
    gl.uniform1f(u.uChromaticAberration ?? null, cfg.chromaticAberration);
    gl.uniform1f(u.uDither ?? null, cfg.dither);
    gl.uniform1f(u.uCurvature ?? null, cfg.curvature);
    gl.uniform3f(u.uTint ?? null, tint[0], tint[1], tint[2]);
    // the site disables both of these on every episode hero
    gl.uniform2f(u.uMouse ?? null, 0.5, 0.5);
    gl.uniform1f(u.uMouseStrength ?? null, 0);
    gl.uniform1f(u.uUseMouse ?? null, 0);
    gl.uniform1f(u.uPageLoadProgress ?? null, 1);
    gl.uniform1f(u.uUsePageLoadAnimation ?? null, 0);
    gl.uniform1f(u.uBrightness ?? null, cfg.brightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, ready, width, height, fps, options]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'absolute', inset: 0, width, height, opacity, pointerEvents: 'none', ...style }}
    />
  );
};
