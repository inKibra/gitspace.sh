import React from 'react';
import { AbsoluteFill } from 'remotion';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { T, MONO } from '../../lib/theme';

loadMono();
const inter = loadInter();

/**
 * OG image for the blog post (1200×630, single frame).
 * Render: bunx remotion still src/index.ts ep02-evidence-og og.png
 */

const REQS: Array<{ n: string; title: string; kind: string; judge: string }> = [
  { n: '1', title: 'Checkout suite passes', kind: 'test-output', judge: 'command · exit 0' },
  { n: '2', title: 'Checkout flow works', kind: 'video', judge: 'human · total renders' },
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
        prove it · nº 02
      </span>
    </div>

    {/* title */}
    <div style={{ marginTop: 70 }}>
      <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 0.98, color: '#fff' }}>
        Agents <span style={{ color: T.accent }}>lie</span> about what they shipped.
      </div>
      <div style={{ fontSize: 32, color: '#9c9c9c', marginTop: 22 }}>
        The agent doesn’t get to say it’s done. It has to prove it.
      </div>
    </div>

    {/* the rubric: two requirements, each with a judge aimed at what matters */}
    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {REQS.map((r) => (
        <div
          key={r.n}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            border: `1px solid ${T.border}`,
            background: '#050505',
            padding: '14px 20px',
            fontFamily: MONO,
          }}
        >
          <span style={{ width: 12, height: 12, background: T.accent, boxShadow: `0 0 10px ${T.accent}66`, flex: 'none' }} />
          <span style={{ fontSize: 22, color: T.text }}>{r.title}</span>
          <span style={{ marginLeft: 'auto', fontSize: 16, color: '#9c9c9c' }}>
            {r.kind} · <span style={{ color: T.accent }}>{r.judge}</span>
          </span>
        </div>
      ))}
    </div>
  </AbsoluteFill>
);
