import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { MONO } from '../lib/theme';
import { BendFrame } from '../lib/BendFrame';

/**
 * DIAGNOSTIC — isolate BendFrame's PAN from everything else.
 *
 * Two slabs, each a plain sized div (no AbsoluteFill, no scenes, no shader),
 * ruled every 240px and labelled. The fold is switched OFF, so whatever comes
 * out is the pan and nothing but the pan.
 *
 * Read the output like a ruler: at position p the screen should show slab A
 * from x=p·1920 rightward, then slab B from its left edge. If both slabs'
 * x=0 markers are visible at once, the panels are compositing instead of
 * panning — which is the bug seen in the episode.
 */

const TICKS = [0, 240, 480, 720, 960, 1200, 1440, 1680];

/** `abs` renders the slab exactly the way the episode's scenes do: an
 *  AbsoluteFill rather than a plain sized div. That is the ONE structural
 *  difference between this passing test and the failing integration. */
const Slab: React.FC<{ label: string; bg: string; ink: string; abs?: boolean }> = ({ label, bg, ink, abs }) => {
  const Body = (
    <>
    {TICKS.map((x) => (
      <React.Fragment key={x}>
        <div style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 3, background: ink, opacity: 0.55 }} />
        <div style={{ position: 'absolute', left: x + 12, top: 24, fontSize: 34, color: ink }}>
          {label}
          {x}
        </div>
      </React.Fragment>
    ))}
    <div style={{ position: 'absolute', left: 0, right: 0, top: 430, textAlign: 'center', fontSize: 200, fontWeight: 700, color: ink }}>
      {label}
    </div>
    {/* unambiguous edge flags */}
    <div style={{ position: 'absolute', left: 0, bottom: 40, fontSize: 44, color: ink }}>◀ {label}-LEFT-EDGE</div>
    <div style={{ position: 'absolute', right: 0, bottom: 40, fontSize: 44, color: ink }}>{label}-RIGHT-EDGE ▶</div>
    </>
  );
  return abs ? (
    <AbsoluteFill style={{ background: bg, fontFamily: MONO }}>{Body}</AbsoluteFill>
  ) : (
    <div style={{ width: 1920, height: 1080, background: bg, position: 'relative', fontFamily: MONO }}>{Body}</div>
  );
};

/** fold disabled: this test is only about where the pixels land */
const NO_FOLD = { zone: 8, angle: 0, rounding: 0, smoothing: 0, tumble: 0, tilt: 0, top: false, bottom: false } as const;

export const BendPanTest: React.FC<{ abs?: boolean; transparent?: boolean }> = ({ abs, transparent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const position = frame / (durationInFrames - 1);

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <BendFrame position={position} options={{ ...NO_FOLD, transparent }}>
        <Slab label="A" bg="#5a1414" ink="#ffd7d7" abs={abs} />
        <Slab label="B" bg="#12305c" ink="#d7e6ff" abs={abs} />
      </BendFrame>
      <div style={{ position: 'absolute', left: 24, top: 20, fontFamily: MONO, fontSize: 30, color: '#fff' }}>
        position {position.toFixed(3)} · expected travel {Math.round(position * 1920)}px · {abs ? 'AbsoluteFill' : 'plain div'} · {transparent ? 'TRANSPARENT' : 'opaque'}
      </div>
    </AbsoluteFill>
  );
};
