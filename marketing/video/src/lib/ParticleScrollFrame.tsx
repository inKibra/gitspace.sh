import React, { useEffect, useRef, useState } from 'react';
import { useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import {
  createParticleScroll,
  supportsHtmlInCanvas,
  type ParticleScrollInstance,
  type ParticleScrollOptions,
} from './canvasui/ParticleScroll';

/**
 * Remotion wrapper for Canvas UI's ParticleScroll, turned on its side.
 *
 * Upstream, content assembles out of drifting sand as it scrolls up past a
 * horizontal formation line. Our transitions are horizontal, so the effect runs
 * in a ROTATED frame (the same trick as BendFrame): the scene is laid out
 * sideways in the capture canvas and the stage is rotated back for display, so
 * the formation line sweeps LEFT→RIGHT across the screen and the sand's
 * gravity bias blows sideways with it.
 *
 * `progress` 0 = every grain scattered, 1 = fully assembled.
 */

const W = 1920;
const H = 1080;

export const ParticleScrollFrame: React.FC<{
  progress: number;
  options?: ParticleScrollOptions;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ progress, options, style, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<ParticleScrollInstance | null>(null);
  const [handle] = useState(() => delayRender('particle-scroll:init'));
  const [ready, setReady] = useState(false);
  // a missing flag must degrade to "no effect", never to "no surface"
  const [supported] = useState(() => supportsHtmlInCanvas());
  const [failed, setFailed] = useState(false);
  const native = supported && !failed;

  useEffect(() => {
    const source = sourceRef.current;
    const content = contentRef.current;
    const output = outputRef.current;
    if (!source || !content || !output) return;
    // buffers are sized in CAPTURE space (the sideways stage)
    source.width = H;
    source.height = W;
    output.width = H;
    output.height = W;
    if (!native) {
      continueRender(handle);
      return;
    }
    instanceRef.current = createParticleScroll(
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
    inst.setOptions({ ...options, manual: true });
    inst.renderFrame({ progress, time: frame / fps });
  }, [frame, progress, ready, fps, options]);

  if (!native) {
    // transparent layers are decorative; if the effect can't run, show nothing
    // rather than dropping an un-dissolved copy of the content on top
    if (options?.transparent) return null;
    return <div style={{ position: 'relative', width: W, height: H, ...style }}>{children}</div>;
  }

  return (
    <div style={{ position: 'relative', width: W, height: H, overflow: 'hidden', ...style }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: H,
          height: W,
          transformOrigin: '0 0',
          transform: `translateY(${H}px) rotate(-90deg)`,
        }}
      >
        <canvas
          ref={sourceRef}
          // @ts-expect-error experimental html-in-canvas attribute
          layoutsubtree="true"
          suppressHydrationWarning
          style={{ position: 'absolute', inset: 0, width: H, height: W }}
        >
          <div ref={contentRef} style={{ position: 'relative', width: H, height: W, overflow: 'hidden' }}>
            <div style={{ width: W, height: H, transformOrigin: '0 0', transform: `translateX(${H}px) rotate(90deg)` }}>
              {children}
            </div>
          </div>
        </canvas>
        <canvas
          ref={outputRef}
          aria-hidden
          style={{ position: 'absolute', inset: 0, width: H, height: W, pointerEvents: 'none' }}
        />
      </div>
    </div>
  );
};
