import React from 'react';
import { AbsoluteFill } from 'remotion';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { T, MONO } from '../../lib/theme';

loadMono();
const inter = loadInter();

/**
 * OG image for the blog post (1200×630, single frame).
 * Render: bunx remotion still src/index.ts ep01-og og.png
 */

// no phase labels: unreadable at social-preview size, and they overflow the cells
const CHIPS: Array<{ name: string; c: string }> = [
  { name: 'api-hardening', c: T.running },
  { name: 'checkout-flags', c: T.needsInput },
  { name: 'retry-backoff', c: T.running },
  { name: 'docs-refresh', c: T.waiting },
  { name: 'relay-metrics', c: T.running },
];

export const Og: React.FC = () => (
  <AbsoluteFill style={{ background: '#000', padding: '54px 64px', fontFamily: inter.fontFamily }}>
    {/* top row: brand + series tag */}
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <div style={{ width: 15, height: 26, background: T.accent, marginRight: 13 }} />
      <span style={{ fontFamily: MONO, fontSize: 27, color: T.text }}>gitspace</span>
      <span
        style={{
          marginLeft: 'auto',
          fontFamily: MONO,
          fontSize: 17,
          letterSpacing: '0.18em',
          color: T.textDim,
          textTransform: 'uppercase',
        }}
      >
        the agent fleet · nº 01
      </span>
    </div>

    {/* title */}
    <div style={{ marginTop: 88 }}>
      <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 0.98, color: '#fff' }}>
        Babysitting agents <span style={{ color: T.needsInput }}>sucks</span>.
      </div>
      <div style={{ fontSize: 34, color: '#9c9c9c', marginTop: 22 }}>It doesn’t have to.</div>
    </div>

    {/* the strip: the product idea in one row */}
    <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'stretch', border: `1px solid ${T.border}`, background: '#050505' }}>
      {CHIPS.map((chip) => (
        <div
          key={chip.name}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: '18px 0',
            borderLeft: `1px solid ${T.border}`,
            fontFamily: MONO,
            fontSize: 16,
            color: '#9c9c9c',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span style={{ width: 11, height: 11, flex: 'none', background: chip.c, boxShadow: `0 0 10px ${chip.c}66` }} />
          <span>{chip.name}</span>
        </div>
      ))}
    </div>
  </AbsoluteFill>
);
