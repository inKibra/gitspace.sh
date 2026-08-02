import React, { useEffect, useRef, useState } from 'react';
import { delayRender, continueRender } from 'remotion';
import {
  createBend,
  supportsHtmlInCanvas,
  type BendInstance,
  type BendOptions,
} from './canvasui/Bend';

/**
 * Remotion wrapper for Canvas UI's Bend, turned on its side.
 *
 * ONE CONTINUOUS SHEET. The screens are laid end to end on a single scrollable
 * surface and we travel along it, so a transition is not two cards swapping —
 * it is the sheet itself curving over the screen edges as the next panel comes
 * round. That is Bend's native model (an edge flattens as you reach that end of
 * the scroll), so the fold amounts are derived from the scroll position rather
 * than driven by hand.
 *
 * Our travel is horizontal, so the effect runs in a ROTATED frame:
 *
 *   capture space           display space
 *   ┌────────┐              ┌──────────────────┐
 *   │ screen0│   ── −90° →  │ ⟵ left           │  the sheet's scroll axis
 *   ├────────┤              │                  │  becomes the screen's
 *   │ screen1│              │          right ⟶ │  horizontal axis
 *   └────────┘              └──────────────────┘
 *
 * `drawElementImage` reads an element's own layout, so the ancestor rotation
 * never touches the capture. The shader is UNMODIFIED.
 */

const W = 1920;
const H = 1080;

/**
 * Upstream's edge ramp: an edge lies flat at its own end of the sheet and
 * curls up over `ease` pixels of travel away from it.
 *
 * We reproduce it here rather than letting Bend read `content.scrollTop`,
 * because `drawElementImage` captures an element from its content-box origin
 * and IGNORES scroll — the folds would respond while the sheet never moved.
 * So the sheet is translated instead, and the folds are derived from the same
 * travel distance.
 */
const ramp = (v: number, ease: number): number => {
  const x = Math.min(Math.max(v / Math.max(ease, 1), 0), 1);
  return x * x * (3 - 2 * x);
};

export const BendFrame: React.FC<{
  /**
   * Position along the sheet, in screens. 0 sits on the first child, 1 on the
   * second, 0.5 is mid-travel with both edges curled.
   */
  position: number;
  /** roll, as if the sheet were dragged past its stop (-0.4 … 0.4) */
  tumble?: number;
  options?: BendOptions;
  style?: React.CSSProperties;
  /** One element per screen, laid end to end along the sheet. */
  children: React.ReactNode;
}> = ({ position, tumble = 0, options, style, children }) => {
  const screens = React.Children.toArray(children);
  const max = Math.max(0, screens.length - 1) * W;
  const travel = Math.min(Math.max(position, 0), Math.max(0, screens.length - 1)) * W;
  const ease = options?.ease ?? 240;

  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<BendInstance | null>(null);
  const [handle] = useState(() => delayRender('bend:init'));
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
    // buffers are sized in CAPTURE space (the sideways viewport onto the sheet)
    source.width = H;
    source.height = W;
    output.width = H;
    output.height = W;
    if (!native) {
      continueRender(handle);
      return;
    }
    instanceRef.current = createBend({ source, content, output }, { ...options, manual: true });
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
    // Upstream ramps each edge independently, so an edge stays curled once you
    // are away from its end of the scroll. That is right for an endless page
    // and wrong for a transition, which has to SETTLE: both edges lie flat on
    // a screen and curl only while the sheet is in motion between them.
    const curl = ramp(travel, ease) * ramp(max - travel, ease);
    // Pan the CAPTURE, not the content: whole pixels, so the rasterised text
    // never lands on a half pixel and shimmers.
    inst.renderFrame({ top: curl, bottom: curl, phi: tumble, offsetY: -Math.round(travel) });
  }, [travel, max, ease, tumble, ready, options]);

  if (!native) {
    const i = Math.round(Math.min(Math.max(position, 0), Math.max(0, screens.length - 1)));
    return <div style={{ position: 'relative', width: W, height: H, ...style }}>{screens[i]}</div>;
  }

  return (
    <div style={{ position: 'relative', width: W, height: H, overflow: 'hidden', ...style }}>
      {/* the sheet runs sideways, then rotates back for display */}
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
          {/* The sheet: every screen end to end, and completely STATIC. The
              travel happens by panning the capture (renderFrame's offsetY), so
              nothing inside this subtree ever relayouts mid-transition. */}
          <div
            ref={contentRef}
            style={{ position: 'relative', width: H, height: W * Math.max(screens.length, 1) }}
          >
            {screens.map((screen, i) => (
              <div key={i} style={{ position: 'absolute', left: 0, top: i * W, width: H, height: W }}>
                {/* `position: relative` is load-bearing: panels are AbsoluteFill
                    scenes, and without a positioned ancestor HERE they resolve
                    against the whole sheet and every panel fills all of it. */}
                <div
                  style={{
                    position: 'relative',
                    width: W,
                    height: H,
                    overflow: 'hidden',
                    transformOrigin: '0 0',
                    transform: `translateX(${H}px) rotate(90deg)`,
                  }}
                >
                  {screen}
                </div>
              </div>
            ))}
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
