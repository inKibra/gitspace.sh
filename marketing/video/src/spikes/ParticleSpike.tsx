import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { T, MONO } from '../lib/theme';
import { ParticleRevealFrame } from '../lib/ParticleRevealFrame';

/**
 * ISOLATED SPIKE — proves Canvas UI's ParticleReveal renders deterministically
 * under Remotion (html-in-canvas capture + WebGL shader, driven by frame).
 * Touches nothing in the episode compositions.
 *
 * A deck card dissolves from grayscale dust into crisp UI and back.
 */

const CARD_W = 760;
const CARD_H = 428;

const BAR = (w: number, c: string, h = 10): React.CSSProperties => ({
  width: w,
  height: h,
  background: c,
  flex: 'none',
});

const CardFace: React.FC = () => (
  <div style={{ width: CARD_W, height: CARD_H, background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 24px', borderBottom: `1px solid ${T.border}` }}>
      <span style={{ width: 11, height: 11, borderRadius: '50%', background: T.running }} />
      <span style={{ fontSize: 22, color: T.text }}>checkout-refactor</span>
      <span style={{ marginLeft: 'auto', fontSize: 16, color: T.textDim }}>agent · turn 20</span>
    </div>
    <div style={{ padding: '26px 28px' }}>
      {[T.running, T.waiting, T.needsInput, T.running, T.textGhost].map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 20 }}>
          <div style={BAR(34, c, 14)} />
          <div style={BAR(360 - (i % 3) * 60, T.textGhost, 9)} />
        </div>
      ))}
    </div>
    <div style={{ position: 'absolute', left: 24, bottom: 16, fontSize: 15, letterSpacing: '0.18em', color: T.textDim }}>
      EVIDENCE
    </div>
  </div>
);

export const ParticleSpike: React.FC = () => {
  const frame = useCurrentFrame();
  // dust → crisp → dust, so both directions are visible in one clip
  const progress = interpolate(frame, [0, 45, 75, 120], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ background: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <ParticleRevealFrame
        progress={progress}
        width={CARD_W}
        height={CARD_H}
        options={{ radius: 620, softness: 0.8, scatter: 30, drift: 1.2, aberration: 45, bend: 55, background: '#000000' }}
      >
        <CardFace />
      </ParticleRevealFrame>
      <div style={{ position: 'absolute', bottom: 60, fontFamily: MONO, fontSize: 20, color: T.textDim }}>
        progress {progress.toFixed(2)}
      </div>
    </AbsoluteFill>
  );
};
