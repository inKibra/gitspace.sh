import React from 'react';
import { AbsoluteFill } from 'remotion';
import { T, MONO } from '../lib/theme';
import { FaultyTerminalFrame } from '../lib/FaultyTerminalFrame';

/**
 * SPIKE — the site's hero shader as a film background.
 *
 * Left half at the site's own hero opacity (0.12), right half pushed to 0.30
 * so the texture is legible on a large screen. Some UI sits on top so the
 * contrast against real content can be judged, not just the field alone.
 */
export const HeroShaderSpike: React.FC = () => (
  <AbsoluteFill style={{ background: T.bg, fontFamily: MONO }}>
    <FaultyTerminalFrame width={1920} height={1080} opacity={0.12} />
    <div style={{ position: 'absolute', inset: '0 0 0 960px', overflow: 'hidden' }}>
      <FaultyTerminalFrame width={1920} height={1080} opacity={0.3} style={{ left: -960 }} />
    </div>

    <div style={{ position: 'absolute', top: 96, left: 150, fontSize: 28, fontWeight: 600, color: T.text }}>
      checkout-refactor <span style={{ color: '#7a7a7a', fontSize: 20 }}>· agent · turn 20</span>
    </div>
    <div style={{ position: 'absolute', top: 470, left: 150, width: 520, padding: '34px', border: '1px solid #1e1e1e', background: '#0a0a0a' }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: T.text, marginBottom: 14 }}>Reviewer</div>
      <div style={{ fontSize: 23, color: '#7a7a7a' }}>only reviews · hunts the lie</div>
    </div>
    <div style={{ position: 'absolute', top: 470, left: 1180, width: 520, padding: '34px', border: '1px solid #1e1e1e', background: '#0a0a0a' }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: T.text, marginBottom: 14 }}>Reviewer</div>
      <div style={{ fontSize: 23, color: '#7a7a7a' }}>only reviews · hunts the lie</div>
    </div>
    <div style={{ position: 'absolute', bottom: 60, left: 0, width: 1920, textAlign: 'center', fontSize: 22, color: '#7a7a7a' }}>
      opacity 0.12 (site default) &nbsp;·&nbsp; | &nbsp;·&nbsp; opacity 0.30
    </div>
  </AbsoluteFill>
);
