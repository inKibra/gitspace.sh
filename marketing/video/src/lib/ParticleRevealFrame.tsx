import React, { useEffect, useRef, useState } from 'react';
import { useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import {
  createParticleReveal,
  supportsHtmlInCanvas,
  type ParticleRevealInstance,
  type ParticleRevealOptions,
} from './canvasui/ParticleReveal';

/**
 * Remotion wrapper for Canvas UI's ParticleReveal.
 *
 * Upstream the effect is cursor-driven and self-animating (rAF). Here the reveal
 * centre, radius-gate and shader time are all pure functions of `useCurrentFrame()`,
 * so a render is reproducible frame for frame.
 *
 * `progress` (0→1) drives the dissolve: at 0 the content is fine grayscale dust,
 * at 1 it has merged back into crisp UI. The reveal is driven by pushing the
 * "pointer" to the centre and opening `active`, so the whole surface resolves
 * rather than only a spot under a cursor.
 */
export const ParticleRevealFrame: React.FC<{
  /** 0 = full dust, 1 = fully crisp. */
  progress: number;
  width: number;
  height: number;
  options?: ParticleRevealOptions;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ progress, width, height, options, style, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<ParticleRevealInstance | null>(null);
  const [handle] = useState(() => delayRender('particle-reveal:init'));
  const [ready, setReady] = useState(false);
  // If html-in-canvas is unavailable (or GL init fails) the content lives inside
  // a canvas that never paints — i.e. the card would silently VANISH. Fall back
  // to plain DOM instead, so a missing browser flag degrades to "no effect"
  // rather than "no card".
  const [supported] = useState(() => supportsHtmlInCanvas());
  const [failed, setFailed] = useState(false);
  const native = supported && !failed;

  useEffect(() => {
    const source = sourceRef.current;
    const content = contentRef.current;
    const output = outputRef.current;
    if (!source || !content || !output) return;
    // size the capture + output buffers up front (no ResizeObserver timing)
    source.width = width;
    source.height = height;
    output.width = width;
    output.height = height;
    if (!native) {
      continueRender(handle);
      return;
    }
    instanceRef.current = createParticleReveal(
      { source, content, output },
      { ...options, manual: true },
    );
    if (!instanceRef.current) setFailed(true);
    setReady(true);
    continueRender(handle);
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // one deterministic draw per frame
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst || !ready) return;
    const p = Math.max(0, Math.min(1, progress));
    // `active` (with a FIXED radius) is what actually drives the reveal: it opens
    // the crisp window outward from the centre. Do NOT widen the radius to cover
    // the surface — that makes the mask win on every frame and the dust never
    // appears at all.
    //
    // Their aberration/scatter still tint things slightly even once revealed, so
    // those ease out over the last stretch only. That keeps the whole dissolve
    // intact and still lands genuinely crisp.
    const polish = 1 - Math.max(0, Math.min(1, (p - 0.82) / 0.18));
    inst.setOptions({
      ...options,
      scatter: (options?.scatter ?? 25) * polish,
      aberration: (options?.aberration ?? 40) * polish,
      bend: (options?.bend ?? 50) * polish,
      manual: true,
    });
    inst.renderFrame({
      x: width / 2,
      y: height / 2,
      active: p,
      // shader time still animates the dust, but off the frame clock
      time: frame / fps,
    });
  }, [frame, progress, ready, width, height, fps, options]);

  if (!native) {
    return <div style={{ position: 'relative', width, height, ...style }}>{children}</div>;
  }

  return (
    <div style={{ position: 'relative', width, height, ...style }}>
      <canvas
        ref={sourceRef}
        // @ts-expect-error experimental html-in-canvas attribute
        layoutsubtree="true"
        suppressHydrationWarning
        style={{ position: 'absolute', inset: 0, width, height }}
      >
        <div ref={contentRef} style={{ position: 'relative', width, height, overflow: 'hidden' }}>
          {children}
        </div>
      </canvas>
      <canvas
        ref={outputRef}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width, height, pointerEvents: 'none' }}
      />
    </div>
  );
};
